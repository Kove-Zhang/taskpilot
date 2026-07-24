use serde::{Deserialize, Serialize};
use imap;
use native_tls::TlsConnector;
use mailparse::*;

#[derive(Debug, Serialize, Deserialize)]
pub struct Email {
    pub uid: u32,
    pub sender: String,
    pub subject: String,
    pub date: String,
    pub body_text: String,
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

fn extract_text_from_parsed_mail(parsed: &ParsedMail) -> String {
    let mut text = String::new();
    
    if parsed.ctype.mimetype == "text/plain" {
        if let Ok(body) = parsed.get_body() {
            text.push_str(&body);
        }
    } else if parsed.ctype.mimetype == "text/html" {
        if let Ok(body) = parsed.get_body() {
            let stripped = body.replace("<br>", "\n").replace("<br/>", "\n");
            text.push_str(&stripped);
        }
    } else if parsed.subparts.len() > 0 {
        let mut found_plain = false;
        for sub in &parsed.subparts {
            if sub.ctype.mimetype == "text/plain" {
                text.push_str(&extract_text_from_parsed_mail(sub));
                found_plain = true;
                break;
            }
        }
        if !found_plain {
            for sub in &parsed.subparts {
                if sub.ctype.mimetype == "text/html" {
                    text.push_str(&extract_text_from_parsed_mail(sub));
                    break;
                }
            }
        }
    }
    text
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
    
    let query = if unread_only { "UNSEEN" } else { "ALL" };
    let uids = session.uid_search(query).map_err(|e| format!("Search Error: {}", e))?;
    
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
                        
                    let body_text = extract_text_from_parsed_mail(&parsed);
                    
                    emails.push(Email {
                        uid: *uid,
                        sender,
                        subject,
                        date,
                        body_text,
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
        let text = extract_text_from_parsed_mail(&parsed);
        assert_eq!(text.trim(), "This is a simple plain text email.");
    }

    #[test]
    fn test_extract_text_html() {
        let raw_email = b"Content-Type: text/html; charset=utf-8\r\n\r\n<html><body>Hello<br>World</body></html>";
        let parsed = parse_mail(raw_email).unwrap();
        let text = extract_text_from_parsed_mail(&parsed);
        assert_eq!(text.trim(), "<html><body>Hello\nWorld</body></html>");
    }

    #[test]
    fn test_extract_text_multipart() {
        let raw_email = b"Content-Type: multipart/alternative; boundary=\"boundary\"\r\n\r\n--boundary\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlain text part.\r\n--boundary\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html>HTML part.</html>\r\n--boundary--";
        let parsed = parse_mail(raw_email).unwrap();
        let text = extract_text_from_parsed_mail(&parsed);
        assert_eq!(text.trim(), "Plain text part.");
    }
}
