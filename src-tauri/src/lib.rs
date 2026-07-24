use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use aes_gcm::{aead::{Aead, AeadCore, KeyInit, OsRng}, Aes256Gcm, Nonce};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
use sha2::{Sha256, Digest};
use base64::{Engine as _, engine::general_purpose::STANDARD};

mod imap_cmds;
use imap_cmds::{get_email_folders, fetch_emails, mark_email_read};

struct AppState {
    is_recording: AtomicBool,
}

fn get_storage_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let mut path = app_handle.path().app_data_dir().unwrap();
    fs::create_dir_all(&path).unwrap();
    path.push("history.enc");
    path
}

fn get_key_path(app_handle: &tauri::AppHandle) -> PathBuf {
    let mut path = app_handle.path().app_data_dir().unwrap();
    fs::create_dir_all(&path).unwrap();
    path.push("secret.key");
    path
}

fn encrypt_history(data: &str, key_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key_bytes).map_err(|e| e.to_string())?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 96-bits
    
    let ciphertext = cipher.encrypt(&nonce, data.as_bytes().as_ref()).map_err(|e| e.to_string())?;
    
    let mut final_data = nonce.to_vec();
    final_data.extend_from_slice(&ciphertext);
    Ok(final_data)
}

fn decrypt_history(encrypted_data: &[u8], key_bytes: &[u8]) -> Result<String, String> {
    if encrypted_data.len() < 12 {
        return Err("Invalid data format".to_string());
    }

    let (nonce_bytes, ciphertext) = encrypted_data.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    let cipher = Aes256Gcm::new_from_slice(key_bytes).map_err(|e| e.to_string())?;
    
    let plaintext = cipher.decrypt(nonce, ciphertext).map_err(|e| e.to_string())?;
    String::from_utf8(plaintext).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_history(app_handle: tauri::AppHandle, data: String) -> Result<(), String> {
    let key_path = get_key_path(&app_handle);
    let key_bytes = if key_path.exists() {
        fs::read(&key_path).map_err(|e| e.to_string())?
    } else {
        let key = Aes256Gcm::generate_key(OsRng);
        fs::write(&key_path, key.as_slice()).map_err(|e| e.to_string())?;
        key.to_vec()
    };

    let final_data = encrypt_history(&data, &key_bytes)?;
    fs::write(get_storage_path(&app_handle), final_data).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_history(app_handle: tauri::AppHandle) -> Result<String, String> {
    let path = get_storage_path(&app_handle);
    if !path.exists() {
        return Ok("[]".to_string());
    }

    let key_path = get_key_path(&app_handle);
    if !key_path.exists() {
        return Ok("[]".to_string());
    }

    let key_bytes = fs::read(&key_path).map_err(|e| e.to_string())?;
    let encrypted_data = fs::read(&path).map_err(|e| e.to_string())?;
    
    decrypt_history(&encrypted_data, &key_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_encryption_decryption() {
        let key = Aes256Gcm::generate_key(OsRng);
        let data = "test history data";
        
        let encrypted = encrypt_history(data, key.as_slice()).unwrap();
        assert_ne!(encrypted, data.as_bytes()); // Ensure it is changed
        
        let decrypted = decrypt_history(&encrypted, key.as_slice()).unwrap();
        assert_eq!(decrypted, data);
    }
    
    #[test]
    fn test_invalid_decryption_too_short() {
        let key = Aes256Gcm::generate_key(OsRng);
        let invalid_data = vec![0u8; 10]; // Too short (needs at least 12 bytes nonce)
        let result = decrypt_history(&invalid_data, key.as_slice());
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Invalid data format");
    }
}

#[tauri::command]
fn trigger_screenshot() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start ms-screenclip:"])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Screenshot shortcut only supported on Windows currently".to_string())
    }
}

#[tauri::command]
fn write_log(app_handle: tauri::AppHandle, message: String) -> Result<(), String> {
    use std::io::Write;
    let mut log_path = app_handle.path().app_data_dir().unwrap();
    fs::create_dir_all(&log_path).unwrap();
    log_path.push("task-pilot.log");
    
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| e.to_string())?;
        
    writeln!(file, "{}", message).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn open_log_file(app_handle: tauri::AppHandle) -> Result<(), String> {
    let mut log_path = app_handle.path().app_data_dir().unwrap();
    log_path.push("task-pilot.log");
    
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("notepad")
            .arg(&log_path)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Not supported on this OS".to_string())
    }
}

#[tauri::command]
fn clear_log(app_handle: tauri::AppHandle) -> Result<(), String> {
    let mut log_path = app_handle.path().app_data_dir().unwrap();
    log_path.push("task-pilot.log");
    if log_path.exists() {
        fs::write(&log_path, "").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn update_shortcut(app_handle: tauri::AppHandle, shortcut: String) -> Result<(), String> {
    use std::str::FromStr;
    app_handle.global_shortcut().unregister_all().map_err(|e| e.to_string())?;
    let new_shortcut = Shortcut::from_str(&shortcut).map_err(|e| e.to_string())?;
    app_handle.global_shortcut().register(new_shortcut).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_recording_mode(app_handle: tauri::AppHandle, is_recording: bool) {
    let state = app_handle.state::<AppState>();
    state.is_recording.store(is_recording, Ordering::SeqCst);
}

fn get_machine_key() -> Result<[u8; 32], String> {
    let uid = machine_uid::get().unwrap_or_else(|_| "fallback-uid-task-pilot".to_string());
    let mut hasher = Sha256::new();
    hasher.update(uid.as_bytes());
    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result);
    Ok(key)
}

#[tauri::command]
fn encrypt_secret(value: String) -> Result<String, String> {
    if value.is_empty() {
        return Ok("".to_string());
    }
    let key = get_machine_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 96-bits
    
    let ciphertext = cipher.encrypt(&nonce, value.as_bytes().as_ref()).map_err(|e| e.to_string())?;
    let mut final_data = nonce.to_vec();
    final_data.extend_from_slice(&ciphertext);
    Ok(STANDARD.encode(final_data))
}

#[tauri::command]
fn decrypt_secret(cipher_text: String) -> Result<String, String> {
    if cipher_text.is_empty() {
        return Ok("".to_string());
    }
    // If it's not base64 or valid, just return the original value (backward compatibility for unencrypted keys)
    let encrypted_data = match STANDARD.decode(&cipher_text) {
        Ok(data) => data,
        Err(_) => return Ok(cipher_text),
    };
    
    if encrypted_data.len() < 12 {
        return Ok(cipher_text); // Probably plain text that happens to be valid base64
    }
    
    let key = get_machine_key()?;
    let (nonce_bytes, ciphertext) = encrypted_data.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    let cipher = match Aes256Gcm::new_from_slice(&key) {
        Ok(c) => c,
        Err(_) => return Ok(cipher_text),
    };
    
    match cipher.decrypt(nonce, ciphertext) {
        Ok(plaintext) => Ok(String::from_utf8(plaintext).unwrap_or(cipher_text)),
        Err(_) => Ok(cipher_text), // If decryption fails, it might be plaintext
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .invoke_handler(tauri::generate_handler![save_history, load_history, trigger_screenshot, write_log, open_log_file, clear_log, update_shortcut, set_recording_mode, encrypt_secret, decrypt_secret, get_email_folders, fetch_emails, mark_email_read])
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let state = app.state::<AppState>();
                        if state.is_recording.load(Ordering::SeqCst) {
                            let _ = app.emit("global-shortcut-triggered", ());
                            return;
                        }

                        // Since we dynamically register the shortcut, any triggered shortcut for this app toggles the main window
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                window.hide().unwrap();
                            } else {
                                window.show().unwrap();
                                window.set_focus().unwrap();
                            }
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            app.manage(AppState {
                is_recording: AtomicBool::new(false),
            });

            let alt_space = Shortcut::new(Some(Modifiers::ALT), Code::Space);
            let _ = app.global_shortcut().register(alt_space);

            let quit_i = tauri::menu::MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&quit_i])?;

            tauri::tray::TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        app.exit(0);
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                window.hide().unwrap();
                            } else {
                                window.show().unwrap();
                                window.set_focus().unwrap();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
