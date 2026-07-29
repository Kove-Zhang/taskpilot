use serde::{Deserialize, Serialize};
use imap;
use native_tls::TlsConnector;
use mailparse::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};

#[derive(Debug, Serialize, Deserialize)]
pub struct Email {
    pub uid: u32,
    pub sender: String,
    pub subject: String,
    pub date: String,
    pub body_text: String,
    pub html_body: Option<String>,
    pub inline_images: Vec<String>,
}

#[tauri::command]
pub async fn get_email_folders(
    host: String,
    port: u16,
    user: String,
    pass: String,
    ssl: bool,
) -> Result<Vec<String>, String> {
    if !ssl {
        return Err("Only SSL is supported".to_string());
    }
    
    let tls = TlsConnector::new().map_err(|e| format!("TLS Error: {}", e))?;
    let client = imap::connect((host.as_str(), port), host.as_str(), &tls)
        .map_err(|e| format!("Connection Error: {}", e))?;
        
    let mut session = client.login(&user, &pass)
        .map_err(|(e, _)| format!("Login Error: {}", e))?;
        
    let mailboxes = session.list(None, Some("*"))
        .map_err(|e| format!("List Error: {}", e))?;
        
    let mut folders = Vec::new();
    for mailbox in mailboxes.iter() {
        folders.push(mailbox.name().to_string());
    }
    
    session.logout().map_err(|e| format!("Logout Error: {}", e))?;
    
    Ok(folders)
}

fn extract_mail_content(parsed: &ParsedMail) -> (String, Option<String>, Vec<String>) {
    let mut plain_texts = Vec::new();
    let mut html_texts = Vec::new();
    let mut images = Vec::new();

    fn traverse(sub: &ParsedMail, plain: &mut Vec<String>, html: &mut Vec<String>, imgs: &mut Vec<String>) {
        let mime = sub.ctype.mimetype.to_lowercase();
        if mime == "text/plain" {
            if let Ok(body) = sub.get_body() {
                plain.push(body);
            }
        } else if mime == "text/html" {
            if let Ok(body) = sub.get_body() {
                html.push(body);
            }
        } else if mime.starts_with("image/") {
            if imgs.len() < 10 {
                if let Ok(raw) = sub.get_body_raw() {
                    // Prevent OOM: skip inline images larger than 500KB
                    if raw.len() < 500 * 1024 {
                        let b64 = STANDARD.encode(&raw);
                        imgs.push(format!("data:{};base64,{}", mime, b64));
                    }
                }
            }
        }

        for child in &sub.subparts {
            traverse(child, plain, html, imgs);
        }
    }

    traverse(parsed, &mut plain_texts, &mut html_texts, &mut images);

    let body_text = if !plain_texts.is_empty() {
        plain_texts.join("\n")
    } else if !html_texts.is_empty() {
        html_texts.iter()
            .map(|h| h.replace("<br>", "\n").replace("<br/>", "\n"))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        String::new()
    };

    let html_body = if !html_texts.is_empty() {
        Some(html_texts.join("<hr>"))
    } else {
        None
    };

    (body_text, html_body, images)
}

#[tauri::command]
pub async fn fetch_emails(
    host: String,
    port: u16,
    user: String,
    pass: String,
    ssl: bool,
    folder: String,
    unread_only: bool,
    since_days: Option<u32>,
) -> Result<Vec<Email>, String> {
    if !ssl {
        return Err("Only SSL is supported".to_string());
    }
    
    let tls = TlsConnector::new().map_err(|e| format!("TLS Error: {}", e))?;
    let client = imap::connect((host.as_str(), port), host.as_str(), &tls)
        .map_err(|e| format!("Connection Error: {}", e))?;
        
    let mut session = client.login(&user, &pass)
        .map_err(|(e, _)| format!("Login Error: {}", e))?;
        
    session.select(&folder).map_err(|e| format!("Select Error: {}", e))?;
    
    let query = if let Some(days) = since_days {
        let since_date = (chrono::Local::now() - chrono::Duration::days(days as i64)).format("%d-%b-%Y").to_string();
        if unread_only {
            format!("UNSEEN SINCE {}", since_date)
        } else {
            format!("SINCE {}", since_date)
        }
    } else {
        if unread_only { "UNSEEN".to_string() } else { "ALL".to_string() }
    };
    
    let uids = session.uid_search(&query).map_err(|e| format!("Search Error: {}", e))?;
    
    let mut emails = Vec::new();
    
    for uid in uids.iter().take(50) {
        let messages = session.uid_fetch(uid.to_string(), "BODY.PEEK[]")
            .map_err(|e| format!("Fetch Error: {}", e))?;
            
        if let Some(msg) = messages.iter().next() {
            if let Some(body) = msg.body() {
                if let Ok(parsed) = parse_mail(body) {
                    let subject = parsed.headers.iter().find(|h| h.get_key().to_lowercase() == "subject")
                        .map(|h| h.get_value())
                        .unwrap_or_default();
                        
                    let sender = parsed.headers.iter().find(|h| h.get_key().to_lowercase() == "from")
                        .map(|h| h.get_value())
                        .unwrap_or_default();
                        
                    let date = parsed.headers.iter().find(|h| h.get_key().to_lowercase() == "date")
                        .map(|h| h.get_value())
                        .unwrap_or_default();
                        
                    let (body_text, html_body, inline_images) = extract_mail_content(&parsed);
                    
                    emails.push(Email {
                        uid: *uid,
                        sender,
                        subject,
                        date,
                        body_text,
                        html_body,
                        inline_images,
                    });
                }
            }
        }
    }
    
    session.logout().map_err(|e| format!("Logout Error: {}", e))?;
    
    Ok(emails)
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
    if !ssl {
        return Err("Only SSL is supported".to_string());
    }
    
    let tls = TlsConnector::new().map_err(|e| format!("TLS Error: {}", e))?;
    let client = imap::connect((host.as_str(), port), host.as_str(), &tls)
        .map_err(|e| format!("Connection Error: {}", e))?;
        
    let mut session = client.login(&user, &pass)
        .map_err(|(e, _)| format!("Login Error: {}", e))?;
        
    session.select(&folder).map_err(|e| format!("Select Error: {}", e))?;
    
    session.uid_store(uid.to_string(), "+FLAGS (\\Seen)")
        .map_err(|e| format!("Store Error: {}", e))?;
        
    session.logout().map_err(|e| format!("Logout Error: {}", e))?;
    
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_text_plain() {
        let raw_email = b"Content-Type: text/plain; charset=utf-8\r\n\r\nThis is a simple plain text email.";
        let parsed = parse_mail(raw_email).unwrap();
        let (text, _, _) = extract_mail_content(&parsed);
        assert_eq!(text.trim(), "This is a simple plain text email.");
    }

    #[test]
    fn test_extract_text_html() {
        let raw_email = b"Content-Type: text/html; charset=utf-8\r\n\r\n<html><body>Hello<br>World</body></html>";
        let parsed = parse_mail(raw_email).unwrap();
        let (text, _, _) = extract_mail_content(&parsed);
        assert_eq!(text.trim(), "<html><body>Hello\nWorld</body></html>");
    }

    #[test]
    fn test_extract_text_multipart() {
        let raw_email = b"Content-Type: multipart/alternative; boundary=\"boundary\"\r\n\r\n--boundary\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlain text part.\r\n--boundary\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html>HTML part.</html>\r\n--boundary--";
        let parsed = parse_mail(raw_email).unwrap();
        let (text, _, _) = extract_mail_content(&parsed);
        assert_eq!(text.trim(), "Plain text part.");
    }

    #[test]
    fn test_extract_content_with_image() {
        let raw_email = b"Content-Type: multipart/mixed; boundary=\"imgbound\"\r\n\r\n--imgbound\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHere is an image:\r\n--imgbound\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: binary\r\n\r\nfakeimagebytes\r\n--imgbound--";
        let parsed = parse_mail(raw_email).unwrap();
        let (text, html, imgs) = extract_mail_content(&parsed);
        assert_eq!(text.trim(), "Here is an image:");
        assert_eq!(html, None);
        assert_eq!(imgs.len(), 1);
        assert!(imgs[0].starts_with("data:image/png;base64,"));
    }
}
