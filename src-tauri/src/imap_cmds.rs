use base64::{engine::general_purpose::STANDARD, Engine as _};
use imap::Client;
use imap_proto::types::{Address, BodyStructure, ContentEncoding, SectionPath};
use mailparse::{parse_header, parse_mail};
#[cfg(test)]
use mailparse::{DispositionType, ParsedMail};
use native_tls::{TlsConnector, TlsStream};
use serde::{Deserialize, Serialize};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

const IMAP_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IMAP_IO_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_MAX_EMAILS_PER_SCAN: usize = 50;
const MAX_EMAILS_PER_SCAN_HARD_LIMIT: usize = 500;
const MAX_INLINE_IMAGES: usize = 10;
const MAX_INLINE_IMAGE_BYTES: usize = 500 * 1024;

#[derive(Debug, Serialize, Deserialize)]
pub struct Email {
    pub uid: u32,
    pub uid_validity: Option<u32>,
    pub sender: String,
    pub subject: String,
    pub date: String,
    pub body_text: String,
    pub html_body: Option<String>,
    pub inline_images: Vec<String>,
    pub parse_error: Option<String>,
}

fn validate_ssl(ssl: bool) -> Result<(), String> {
    if ssl {
        Ok(())
    } else {
        Err("Only SSL is supported".to_string())
    }
}

fn connect_client(host: &str, port: u16) -> Result<Client<TlsStream<TcpStream>>, String> {
    if host.trim().is_empty() {
        return Err("IMAP host cannot be empty".to_string());
    }

    let tls = TlsConnector::new().map_err(|error| format!("TLS Error: {error}"))?;
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("Resolve Error: {error}"))?;

    let mut connection_errors = Vec::new();
    for addr in addrs {
        match TcpStream::connect_timeout(&addr, IMAP_CONNECT_TIMEOUT) {
            Ok(tcp_stream) => {
                tcp_stream
                    .set_read_timeout(Some(IMAP_IO_TIMEOUT))
                    .map_err(|error| format!("Read timeout setup error: {error}"))?;
                tcp_stream
                    .set_write_timeout(Some(IMAP_IO_TIMEOUT))
                    .map_err(|error| format!("Write timeout setup error: {error}"))?;

                match tls.connect(host, tcp_stream) {
                    Ok(tls_stream) => {
                        let mut client = Client::new(tls_stream);
                        client
                            .read_greeting()
                            .map_err(|error| format!("Server greeting error: {error}"))?;
                        return Ok(client);
                    }
                    Err(error) => {
                        connection_errors.push(format!("{addr}: TLS handshake error: {error}"))
                    }
                }
            }
            Err(error) => connection_errors.push(format!("{addr}: connection error: {error}")),
        }
    }

    Err(format!(
        "Connection Error: all resolved addresses failed within {} seconds ({})",
        IMAP_CONNECT_TIMEOUT.as_secs(),
        connection_errors.join("; ")
    ))
}

fn login_session(
    host: &str,
    port: u16,
    user: &str,
    pass: &str,
) -> Result<imap::Session<TlsStream<TcpStream>>, String> {
    let client = connect_client(host, port)?;
    client
        .login(user, pass)
        .map_err(|(error, _)| format!("Login Error: {error}"))
}

#[tauri::command]
pub async fn get_email_folders(
    host: String,
    port: u16,
    user: String,
    pass: String,
    ssl: bool,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_ssl(ssl)?;
        let mut session = login_session(&host, port, &user, &pass)?;
        let mailboxes = session
            .list(None, Some("*"))
            .map_err(|error| format!("List Error: {error}"))?;
        let folders = mailboxes
            .iter()
            .map(|mailbox| mailbox.name().to_string())
            .collect();
        session
            .logout()
            .map_err(|error| format!("Logout Error: {error}"))?;
        Ok(folders)
    })
    .await
    .map_err(|error| format!("IMAP folder task failed: {error}"))?
}

const MAX_SELECTIVE_MAIL_PARTS: usize = 12;
const MAX_INLINE_IMAGE_TRANSFER_BYTES: u32 = 700 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MailPartKind {
    PlainText,
    Html,
    InlineImage,
}

#[derive(Debug, Clone)]
struct MailPartSelection {
    section: Vec<u32>,
    kind: MailPartKind,
    mime_type: String,
    charset: Option<String>,
    transfer_encoding: String,
}

fn decode_header_value(name: &str, value: Option<&[u8]>) -> String {
    let Some(value) = value else {
        return String::new();
    };

    let mut raw = Vec::with_capacity(name.len() + value.len() + 4);
    raw.extend_from_slice(name.as_bytes());
    raw.extend_from_slice(b": ");
    raw.extend_from_slice(value);
    parse_header(&raw)
        .map(|(header, _)| header.get_value())
        .unwrap_or_else(|_| String::from_utf8_lossy(value).trim().to_string())
}

fn format_envelope_addresses(addresses: Option<&Vec<Address<'_>>>) -> String {
    addresses
        .map(|items| {
            items
                .iter()
                .filter_map(|address| {
                    let name = decode_header_value("From", address.name);
                    let mailbox = address
                        .mailbox
                        .map(|value| String::from_utf8_lossy(value).trim().to_string())
                        .unwrap_or_default();
                    let host = address
                        .host
                        .map(|value| String::from_utf8_lossy(value).trim().to_string())
                        .unwrap_or_default();
                    let email = if mailbox.is_empty() || host.is_empty() {
                        String::new()
                    } else {
                        format!("{mailbox}@{host}")
                    };

                    match (name.is_empty(), email.is_empty()) {
                        (false, false) => Some(format!("{name} <{email}>")),
                        (false, true) => Some(name),
                        (true, false) => Some(email),
                        (true, true) => None,
                    }
                })
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

fn has_attachment_disposition(structure: &BodyStructure<'_>) -> bool {
    let disposition = match structure {
        BodyStructure::Basic { common, .. }
        | BodyStructure::Text { common, .. }
        | BodyStructure::Message { common, .. }
        | BodyStructure::Multipart { common, .. } => common.disposition.as_ref(),
    };
    disposition.is_some_and(|value| value.ty.eq_ignore_ascii_case("attachment"))
}

fn charset_from_params(params: Option<&Vec<(&str, &str)>>) -> Option<String> {
    params.and_then(|items| {
        items
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("charset"))
            .map(|(_, value)| (*value).to_string())
    })
}

fn transfer_encoding_name(encoding: &ContentEncoding<'_>) -> String {
    match encoding {
        ContentEncoding::SevenBit => "7bit".to_string(),
        ContentEncoding::EightBit => "8bit".to_string(),
        ContentEncoding::Binary => "binary".to_string(),
        ContentEncoding::Base64 => "base64".to_string(),
        ContentEncoding::QuotedPrintable => "quoted-printable".to_string(),
        ContentEncoding::Other(value) => (*value).to_string(),
    }
}

fn make_part_selection(
    section: &[u32],
    kind: MailPartKind,
    mime_type: String,
    charset: Option<String>,
    transfer_encoding: &ContentEncoding<'_>,
) -> MailPartSelection {
    MailPartSelection {
        section: section.to_vec(),
        kind,
        mime_type,
        charset,
        transfer_encoding: transfer_encoding_name(transfer_encoding),
    }
}

fn collect_selective_mail_parts(
    structure: &BodyStructure<'_>,
    section: &mut Vec<u32>,
    selections: &mut Vec<MailPartSelection>,
) {
    if selections.len() >= MAX_SELECTIVE_MAIL_PARTS || has_attachment_disposition(structure) {
        return;
    }

    match structure {
        BodyStructure::Multipart { bodies, .. } => {
            for (index, body) in bodies.iter().enumerate() {
                if selections.len() >= MAX_SELECTIVE_MAIL_PARTS {
                    break;
                }
                section.push((index + 1) as u32);
                collect_selective_mail_parts(body, section, selections);
                section.pop();
            }
        }
        BodyStructure::Text { common, other, .. } => {
            let kind = if common.ty.subtype.eq_ignore_ascii_case("plain") {
                Some(MailPartKind::PlainText)
            } else if common.ty.subtype.eq_ignore_ascii_case("html") {
                Some(MailPartKind::Html)
            } else {
                None
            };
            if let Some(kind) = kind {
                selections.push(make_part_selection(
                    section,
                    kind,
                    format!("{}/{}", common.ty.ty, common.ty.subtype),
                    charset_from_params(common.ty.params.as_ref()),
                    &other.transfer_encoding,
                ));
            }
        }
        BodyStructure::Basic { common, other, .. }
            if common.ty.ty.eq_ignore_ascii_case("image")
                && other.octets <= MAX_INLINE_IMAGE_TRANSFER_BYTES
                && selections
                    .iter()
                    .filter(|part| part.kind == MailPartKind::InlineImage)
                    .count()
                    < MAX_INLINE_IMAGES =>
        {
            selections.push(make_part_selection(
                section,
                MailPartKind::InlineImage,
                format!("{}/{}", common.ty.ty, common.ty.subtype),
                None,
                &other.transfer_encoding,
            ));
        }
        // Embedded message bodies and ordinary attachments are deliberately skipped.
        // They can contain another complete MIME tree or large binary payloads and are
        // not required for the primary message task-extraction workflow.
        BodyStructure::Basic { .. } | BodyStructure::Message { .. } => {}
    }
}

fn select_mail_parts(structure: &BodyStructure<'_>) -> Vec<MailPartSelection> {
    let mut selections = Vec::new();
    collect_selective_mail_parts(structure, &mut Vec::new(), &mut selections);
    selections
}

fn fallback_text_part() -> MailPartSelection {
    MailPartSelection {
        section: Vec::new(),
        kind: MailPartKind::PlainText,
        mime_type: "text/plain".to_string(),
        charset: Some("utf-8".to_string()),
        transfer_encoding: "8bit".to_string(),
    }
}

fn part_fetch_query(part: &MailPartSelection) -> String {
    if part.section.is_empty() {
        "BODY.PEEK[TEXT]".to_string()
    } else {
        let section = part
            .section
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(".");
        format!("BODY.PEEK[{section}]")
    }
}

fn part_bytes<'a>(message: &'a imap::types::Fetch, part: &MailPartSelection) -> Option<&'a [u8]> {
    if part.section.is_empty() {
        message.text()
    } else {
        let path = SectionPath::Part(part.section.clone(), None);
        message.section(&path)
    }
}

fn build_part_message(part: &MailPartSelection, bytes: &[u8]) -> Vec<u8> {
    let mut headers = format!("Content-Type: {}", part.mime_type);
    if let Some(charset) = &part.charset {
        headers.push_str("; charset=");
        headers.push_str(charset);
    }
    headers.push_str("\r\nContent-Transfer-Encoding: ");
    headers.push_str(&part.transfer_encoding);
    headers.push_str("\r\n\r\n");

    let mut raw = headers.into_bytes();
    raw.extend_from_slice(bytes);
    raw
}

fn decode_part_as_text(part: &MailPartSelection, bytes: &[u8]) -> Option<String> {
    parse_mail(&build_part_message(part, bytes))
        .ok()
        .and_then(|mail| mail.get_body().ok())
}

fn decode_part_as_binary(part: &MailPartSelection, bytes: &[u8]) -> Option<Vec<u8>> {
    parse_mail(&build_part_message(part, bytes))
        .ok()
        .and_then(|mail| mail.get_body_raw().ok())
}

fn extract_selected_mail_content(
    message: &imap::types::Fetch,
    selections: &[MailPartSelection],
) -> (String, Option<String>, Vec<String>) {
    let mut plain_texts = Vec::new();
    let mut html_texts = Vec::new();
    let mut images = Vec::new();

    for part in selections {
        let Some(bytes) = part_bytes(message, part) else {
            continue;
        };

        match part.kind {
            MailPartKind::PlainText => {
                if let Some(text) = decode_part_as_text(part, bytes) {
                    plain_texts.push(text);
                }
            }
            MailPartKind::Html => {
                if let Some(html) = decode_part_as_text(part, bytes) {
                    html_texts.push(html);
                }
            }
            MailPartKind::InlineImage => {
                if images.len() >= MAX_INLINE_IMAGES {
                    continue;
                }
                if let Some(raw) = decode_part_as_binary(part, bytes) {
                    if raw.len() <= MAX_INLINE_IMAGE_BYTES {
                        images.push(format!(
                            "data:{};base64,{}",
                            part.mime_type,
                            STANDARD.encode(raw)
                        ));
                    }
                }
            }
        }
    }

    let body_text = if !plain_texts.is_empty() {
        plain_texts.join("\n")
    } else if !html_texts.is_empty() {
        html_texts
            .iter()
            .map(|html| html.replace("<br>", "\n").replace("<br/>", "\n"))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        String::new()
    };
    let html_body = (!html_texts.is_empty()).then(|| html_texts.join("<hr>"));
    (body_text, html_body, images)
}

#[cfg(test)]
fn extract_mail_content(parsed: &ParsedMail) -> (String, Option<String>, Vec<String>) {
    let mut plain_texts = Vec::new();
    let mut html_texts = Vec::new();
    let mut images = Vec::new();

    fn traverse(
        sub: &ParsedMail,
        plain: &mut Vec<String>,
        html: &mut Vec<String>,
        images: &mut Vec<String>,
    ) {
        let mime = sub.ctype.mimetype.to_lowercase();
        if mime == "text/plain" {
            if let Ok(body) = sub.get_body() {
                plain.push(body);
            }
        } else if mime == "text/html" {
            if let Ok(body) = sub.get_body() {
                html.push(body);
            }
        } else if mime.starts_with("image/")
            && images.len() < MAX_INLINE_IMAGES
            && sub.get_content_disposition().disposition != DispositionType::Attachment
        {
            if let Ok(raw) = sub.get_body_raw() {
                if raw.len() <= MAX_INLINE_IMAGE_BYTES {
                    let encoded = STANDARD.encode(raw);
                    images.push(format!("data:{mime};base64,{encoded}"));
                }
            }
        }

        for child in &sub.subparts {
            traverse(child, plain, html, images);
        }
    }

    traverse(parsed, &mut plain_texts, &mut html_texts, &mut images);

    let body_text = if !plain_texts.is_empty() {
        plain_texts.join("\n")
    } else if !html_texts.is_empty() {
        html_texts
            .iter()
            .map(|html| html.replace("<br>", "\n").replace("<br/>", "\n"))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        String::new()
    };

    let html_body = (!html_texts.is_empty()).then(|| html_texts.join("<hr>"));
    (body_text, html_body, images)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchEmailsRequest {
    host: String,
    port: u16,
    user: String,
    pass: String,
    ssl: bool,
    folder: String,
    unread_only: bool,
    since_days: Option<u32>,
    max_emails: Option<usize>,
}

#[tauri::command]
pub async fn fetch_emails(request: FetchEmailsRequest) -> Result<Vec<Email>, String> {
    let FetchEmailsRequest {
        host,
        port,
        user,
        pass,
        ssl,
        folder,
        unread_only,
        since_days,
        max_emails,
    } = request;

    tauri::async_runtime::spawn_blocking(move || {
        validate_ssl(ssl)?;
        let mut session = login_session(&host, port, &user, &pass)?;
        let mailbox = session
            .select(&folder)
            .map_err(|error| format!("Select Error: {error}"))?;
        let uid_validity = mailbox.uid_validity;

        let query = if let Some(days) = since_days {
            // IMAP SINCE is date-granular and server internal dates may differ by timezone.
            // Include one extra day; processed UID fingerprints keep the result idempotent.
            let since_date = (chrono::Local::now()
                - chrono::Duration::days(days.saturating_add(1) as i64))
            .format("%d-%b-%Y")
            .to_string();
            if unread_only {
                format!("UNSEEN SINCE {since_date}")
            } else {
                format!("SINCE {since_date}")
            }
        } else if unread_only {
            "UNSEEN".to_string()
        } else {
            "ALL".to_string()
        };

        let mut uids: Vec<u32> = session
            .uid_search(&query)
            .map_err(|error| format!("Search Error: {error}"))?
            .into_iter()
            .collect();
        uids.sort_unstable_by(|left, right| right.cmp(left));

        let max_emails = max_emails
            .unwrap_or(DEFAULT_MAX_EMAILS_PER_SCAN)
            .clamp(1, MAX_EMAILS_PER_SCAN_HARD_LIMIT);
        let mut emails = Vec::new();
        for uid in uids.into_iter().take(max_emails) {
            let metadata = session
                .uid_fetch(uid.to_string(), "ENVELOPE BODYSTRUCTURE")
                .map_err(|error| format!("Metadata fetch error for UID {uid}: {error}"))?;
            let Some(metadata) = metadata.iter().next() else {
                emails.push(Email {
                    uid,
                    uid_validity,
                    sender: String::new(),
                    subject: "(无法读取邮件元数据)".to_string(),
                    date: String::new(),
                    body_text: String::new(),
                    html_body: None,
                    inline_images: Vec::new(),
                    parse_error: Some("IMAP fetch returned no message metadata".to_string()),
                });
                continue;
            };

            let (sender, subject, date, selections) = {
                let envelope = metadata.envelope();
                let sender = envelope
                    .map(|value| format_envelope_addresses(value.from.as_ref()))
                    .unwrap_or_default();
                let subject = envelope
                    .map(|value| decode_header_value("Subject", value.subject))
                    .unwrap_or_default();
                let date = envelope
                    .map(|value| decode_header_value("Date", value.date))
                    .unwrap_or_default();
                let selections = metadata
                    .bodystructure()
                    .map(select_mail_parts)
                    // Non-conformant servers occasionally omit BODYSTRUCTURE. In that
                    // case, fetch only BODY[TEXT] rather than the full MIME message.
                    .unwrap_or_else(|| vec![fallback_text_part()]);
                (sender, subject, date, selections)
            };

            let (body_text, html_body, inline_images) = if selections.is_empty() {
                (String::new(), None, Vec::new())
            } else {
                let query = selections
                    .iter()
                    .map(part_fetch_query)
                    .collect::<Vec<_>>()
                    .join(" ");
                let messages = session
                    .uid_fetch(uid.to_string(), &query)
                    .map_err(|error| format!("Fetch Error for UID {uid}: {error}"))?;
                let Some(message) = messages.iter().next() else {
                    emails.push(Email {
                        uid,
                        uid_validity,
                        sender,
                        subject,
                        date,
                        body_text: String::new(),
                        html_body: None,
                        inline_images: Vec::new(),
                        parse_error: Some("IMAP fetch returned no selected MIME parts".to_string()),
                    });
                    continue;
                };
                extract_selected_mail_content(message, &selections)
            };

            emails.push(Email {
                uid,
                uid_validity,
                sender,
                subject,
                date,
                body_text,
                html_body,
                inline_images,
                parse_error: None,
            });
        }

        session
            .logout()
            .map_err(|error| format!("Logout Error: {error}"))?;
        Ok(emails)
    })
    .await
    .map_err(|error| format!("IMAP fetch task failed: {error}"))?
}

#[tauri::command]
pub async fn mark_email_read(
    host: String,
    port: u16,
    user: String,
    pass: String,
    ssl: bool,
    folder: String,
    uid: u32,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_ssl(ssl)?;
        let mut session = login_session(&host, port, &user, &pass)?;
        session
            .select(&folder)
            .map_err(|error| format!("Select Error: {error}"))?;
        session
            .uid_store(uid.to_string(), "+FLAGS (\\Seen)")
            .map_err(|error| format!("Store Error: {error}"))?;
        session
            .logout()
            .map_err(|error| format!("Logout Error: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("IMAP mark-read task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use imap_proto::types::{
        BodyContentCommon, BodyContentSinglePart, ContentDisposition, ContentType,
    };

    fn common(
        ty: &'static str,
        subtype: &'static str,
        disposition: Option<&'static str>,
    ) -> BodyContentCommon<'static> {
        BodyContentCommon {
            ty: ContentType {
                ty,
                subtype,
                params: None,
            },
            disposition: disposition.map(|ty| ContentDisposition { ty, params: None }),
            language: None,
            location: None,
        }
    }

    fn single_part(
        transfer_encoding: ContentEncoding<'static>,
        octets: u32,
    ) -> BodyContentSinglePart<'static> {
        BodyContentSinglePart {
            id: None,
            md5: None,
            description: None,
            transfer_encoding,
            octets,
        }
    }

    fn text_part(
        subtype: &'static str,
        disposition: Option<&'static str>,
    ) -> BodyStructure<'static> {
        BodyStructure::Text {
            common: common("text", subtype, disposition),
            other: single_part(ContentEncoding::EightBit, 128),
            lines: 1,
            extension: None,
        }
    }

    fn image_part(disposition: Option<&'static str>) -> BodyStructure<'static> {
        BodyStructure::Basic {
            common: common("image", "png", disposition),
            other: single_part(ContentEncoding::Base64, 128),
            extension: None,
        }
    }

    #[test]
    fn extracts_plain_text() {
        let raw_email =
            b"Content-Type: text/plain; charset=utf-8\r\n\r\nThis is a simple plain text email.";
        let parsed = parse_mail(raw_email).unwrap();
        let (text, _, _) = extract_mail_content(&parsed);
        assert_eq!(text.trim(), "This is a simple plain text email.");
    }

    #[test]
    fn extracts_html_as_fallback_text() {
        let raw_email = b"Content-Type: text/html; charset=utf-8\r\n\r\n<html><body>Hello<br>World</body></html>";
        let parsed = parse_mail(raw_email).unwrap();
        let (text, _, _) = extract_mail_content(&parsed);
        assert_eq!(text.trim(), "<html><body>Hello\nWorld</body></html>");
    }

    #[test]
    fn prefers_plain_text_from_multipart_message() {
        let raw_email = b"Content-Type: multipart/alternative; boundary=\"boundary\"\r\n\r\n--boundary\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlain text part.\r\n--boundary\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html>HTML part.</html>\r\n--boundary--";
        let parsed = parse_mail(raw_email).unwrap();
        let (text, _, _) = extract_mail_content(&parsed);
        assert_eq!(text.trim(), "Plain text part.");
    }

    #[test]
    fn includes_inline_image_but_excludes_attachment_image() {
        let raw_email = b"Content-Type: multipart/mixed; boundary=\"imgbound\"\r\n\r\n--imgbound\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHere is an image:\r\n--imgbound\r\nContent-Type: image/png\r\nContent-Disposition: inline\r\nContent-Transfer-Encoding: binary\r\n\r\nfakeinline\r\n--imgbound\r\nContent-Type: image/png\r\nContent-Disposition: attachment; filename=\"attachment.png\"\r\nContent-Transfer-Encoding: binary\r\n\r\nfakeattachment\r\n--imgbound--";
        let parsed = parse_mail(raw_email).unwrap();
        let (text, html, images) = extract_mail_content(&parsed);
        assert_eq!(text.trim(), "Here is an image:");
        assert_eq!(html, None);
        assert_eq!(images.len(), 1);
        assert!(images[0].starts_with("data:image/png;base64,"));
    }

    #[test]
    fn selects_only_readable_text_html_and_inline_images() {
        let structure = BodyStructure::Multipart {
            common: common("multipart", "mixed", None),
            bodies: vec![
                text_part("plain", None),
                text_part("html", None),
                image_part(Some("inline")),
                image_part(Some("attachment")),
                text_part("plain", Some("attachment")),
            ],
            extension: None,
        };

        let selections = select_mail_parts(&structure);
        assert_eq!(selections.len(), 3);
        assert_eq!(selections[0].section, vec![1]);
        assert_eq!(selections[0].kind, MailPartKind::PlainText);
        assert_eq!(selections[1].section, vec![2]);
        assert_eq!(selections[1].kind, MailPartKind::Html);
        assert_eq!(selections[2].section, vec![3]);
        assert_eq!(selections[2].kind, MailPartKind::InlineImage);
        assert_eq!(part_fetch_query(&selections[0]), "BODY.PEEK[1]");
    }

    #[test]
    fn decodes_text_larger_than_the_previous_five_megabyte_raw_message_limit() {
        let part = MailPartSelection {
            section: vec![1],
            kind: MailPartKind::PlainText,
            mime_type: "text/plain".to_string(),
            charset: Some("utf-8".to_string()),
            transfer_encoding: "8bit".to_string(),
        };
        let body = "a".repeat(5 * 1024 * 1024 + 1);

        let decoded =
            decode_part_as_text(&part, body.as_bytes()).expect("large text should decode");
        assert_eq!(decoded.len(), body.len());
    }
}
