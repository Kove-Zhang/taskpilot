use base64::{engine::general_purpose::STANDARD, Engine as _};
use imap::Client;
use mailparse::{parse_mail, DispositionType, ParsedMail};
use native_tls::{TlsConnector, TlsStream};
use serde::{Deserialize, Serialize};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

const IMAP_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IMAP_IO_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_EMAILS_PER_SCAN: usize = 50;
const MAX_INLINE_IMAGES: usize = 10;
const MAX_INLINE_IMAGE_BYTES: usize = 500 * 1024;
const MAX_RAW_EMAIL_BYTES: u32 = 5 * 1024 * 1024;

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
    } = request;

    tauri::async_runtime::spawn_blocking(move || {
        validate_ssl(ssl)?;
        let mut session = login_session(&host, port, &user, &pass)?;
        let mailbox = session
            .select(&folder)
            .map_err(|error| format!("Select Error: {error}"))?;
        let uid_validity = mailbox.uid_validity;

        let query = if let Some(days) = since_days {
            let since_date = (chrono::Local::now() - chrono::Duration::days(days as i64))
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

        let mut emails = Vec::new();
        for uid in uids.into_iter().take(MAX_EMAILS_PER_SCAN) {
            let metadata = session
                .uid_fetch(uid.to_string(), "RFC822.SIZE")
                .map_err(|error| format!("Metadata fetch error for UID {uid}: {error}"))?;
            if metadata
                .iter()
                .next()
                .and_then(|message| message.size)
                .is_some_and(|size| size > MAX_RAW_EMAIL_BYTES)
            {
                emails.push(Email {
                    uid,
                    uid_validity,
                    sender: String::new(),
                    subject: "(邮件过大，已跳过正文下载)".to_string(),
                    date: String::new(),
                    body_text: String::new(),
                    html_body: None,
                    inline_images: Vec::new(),
                    parse_error: Some(format!(
                        "Email size exceeds {} MB limit",
                        MAX_RAW_EMAIL_BYTES / 1024 / 1024
                    )),
                });
                continue;
            }

            let messages = session
                .uid_fetch(uid.to_string(), "BODY.PEEK[]")
                .map_err(|error| format!("Fetch Error for UID {uid}: {error}"))?;

            let Some(message) = messages.iter().next() else {
                emails.push(Email {
                    uid,
                    uid_validity,
                    sender: String::new(),
                    subject: "(无法读取邮件)".to_string(),
                    date: String::new(),
                    body_text: String::new(),
                    html_body: None,
                    inline_images: Vec::new(),
                    parse_error: Some("IMAP fetch returned no message body".to_string()),
                });
                continue;
            };

            let Some(body) = message.body() else {
                emails.push(Email {
                    uid,
                    uid_validity,
                    sender: String::new(),
                    subject: "(无法读取邮件)".to_string(),
                    date: String::new(),
                    body_text: String::new(),
                    html_body: None,
                    inline_images: Vec::new(),
                    parse_error: Some("IMAP message has no body".to_string()),
                });
                continue;
            };

            match parse_mail(body) {
                Ok(parsed) => {
                    let subject = parsed
                        .headers
                        .iter()
                        .find(|header| header.get_key_ref().eq_ignore_ascii_case("subject"))
                        .map(|header| header.get_value())
                        .unwrap_or_default();
                    let sender = parsed
                        .headers
                        .iter()
                        .find(|header| header.get_key_ref().eq_ignore_ascii_case("from"))
                        .map(|header| header.get_value())
                        .unwrap_or_default();
                    let date = parsed
                        .headers
                        .iter()
                        .find(|header| header.get_key_ref().eq_ignore_ascii_case("date"))
                        .map(|header| header.get_value())
                        .unwrap_or_default();
                    let (body_text, html_body, inline_images) = extract_mail_content(&parsed);
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
                Err(error) => emails.push(Email {
                    uid,
                    uid_validity,
                    sender: String::new(),
                    subject: "(邮件 MIME 解析失败)".to_string(),
                    date: String::new(),
                    body_text: String::new(),
                    html_body: None,
                    inline_images: Vec::new(),
                    parse_error: Some(format!("MIME parse error: {error}")),
                }),
            }
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
}
