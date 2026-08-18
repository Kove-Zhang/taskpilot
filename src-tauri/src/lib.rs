use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::future::Future;
use std::io::Write;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(target_os = "windows")]
use std::{ptr, slice};
use tauri::{Emitter, State};

use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
};

mod imap_cmds;
use imap_cmds::{fetch_emails, get_email_folders, mark_email_read};

struct AppState {
    is_recording: AtomicBool,
}

#[derive(Default)]
struct CustomLlmState {
    cancellations: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl CustomLlmState {
    fn register(&self, request_id: Option<&str>) -> Result<Option<Arc<AtomicBool>>, String> {
        let Some(request_id) = request_id.filter(|value| !value.is_empty()) else {
            return Ok(None);
        };
        validate_custom_correlation_id(request_id, "requestId")?;
        let mut cancellations = self
            .cancellations
            .lock()
            .map_err(|_| "自定义供应商取消注册表不可用".to_string())?;
        if cancellations.contains_key(request_id) {
            return Err("自定义供应商 requestId 已在使用".to_string());
        }
        if cancellations.len() >= MAX_ACTIVE_CUSTOM_LLM_REQUESTS {
            return Err("自定义供应商并发请求过多，请稍后重试".to_string());
        }
        let token = Arc::new(AtomicBool::new(false));
        cancellations.insert(request_id.to_string(), token.clone());
        Ok(Some(token))
    }

    fn cancel(&self, request_id: &str) -> Result<bool, String> {
        let cancellations = self
            .cancellations
            .lock()
            .map_err(|_| "自定义供应商取消注册表不可用".to_string())?;
        if let Some(token) = cancellations.get(request_id) {
            token.store(true, Ordering::SeqCst);
            return Ok(true);
        }
        Ok(false)
    }

    fn remove(&self, request_id: Option<&str>) {
        if let Some(request_id) = request_id.filter(|value| !value.is_empty()) {
            if let Ok(mut cancellations) = self.cancellations.lock() {
                cancellations.remove(request_id);
            }
        }
    }
}

async fn await_with_custom_cancellation<F, T>(
    future: F,
    cancellation: Option<&Arc<AtomicBool>>,
) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    let Some(cancellation) = cancellation else {
        return future.await;
    };
    tokio::pin!(future);
    loop {
        if cancellation.load(Ordering::SeqCst) {
            return Err("自定义供应商请求已取消".to_string());
        }
        tokio::select! {
            result = &mut future => return result,
            _ = tokio::time::sleep(std::time::Duration::from_millis(25)) => {}
        }
    }
}

fn app_data_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法获取应用数据目录: {error}"))?;
    fs::create_dir_all(&path).map_err(|error| format!("无法创建应用数据目录: {error}"))?;
    Ok(path)
}

fn get_storage_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut path = app_data_dir(app_handle)?;
    path.push("history.enc");
    Ok(path)
}

fn get_key_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut path = app_data_dir(app_handle)?;
    path.push("secret.key");
    Ok(path)
}

fn get_secret_recovery_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut path = app_data_dir(app_handle)?;
    path.push("secrets-key.dpapi");
    Ok(path)
}

#[cfg(target_os = "windows")]
fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.is_empty() || data.len() > u32::MAX as usize {
        return Err("无效的 DPAPI 加密数据长度".to_string());
    }

    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let success = unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 || output.pbData.is_null() {
        return Err("Windows DPAPI 无法保护应用密钥".to_string());
    }

    let protected =
        unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(protected)
}

#[cfg(target_os = "windows")]
fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    if data.is_empty() || data.len() > u32::MAX as usize {
        return Err("无效的 DPAPI 恢复数据长度".to_string());
    }

    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let success = unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if success == 0 || output.pbData.is_null() {
        return Err("Windows DPAPI 无法恢复应用密钥".to_string());
    }

    let plaintext =
        unsafe { slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(plaintext)
}

#[cfg(not(target_os = "windows"))]
fn dpapi_protect(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err("当前系统不支持 Windows DPAPI 密钥恢复".to_string())
}

#[cfg(not(target_os = "windows"))]
fn dpapi_unprotect(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err("当前系统不支持 Windows DPAPI 密钥恢复".to_string())
}

fn read_secret_recovery_key(app_handle: &tauri::AppHandle) -> Result<Option<Vec<u8>>, String> {
    let path = get_secret_recovery_path(app_handle)?;
    if !path.exists() {
        return Ok(None);
    }

    let protected =
        fs::read(&path).map_err(|error| format!("无法读取应用密钥恢复副本: {error}"))?;
    let key = dpapi_unprotect(&protected)?;
    if key.len() != 32 {
        return Err("应用密钥恢复副本格式无效".to_string());
    }
    Ok(Some(key))
}

fn write_secret_recovery_key(app_handle: &tauri::AppHandle, key: &[u8]) -> Result<(), String> {
    if key.len() != 32 {
        return Err("应用密钥长度无效".to_string());
    }

    let path = get_secret_recovery_path(app_handle)?;
    if path.exists() {
        let existing = read_secret_recovery_key(app_handle)?;
        if existing.as_deref() == Some(key) {
            return Ok(());
        }
        return Err(
            "系统凭据库密钥与 DPAPI 恢复副本不一致；为避免覆盖既有加密设置，已停止操作。"
                .to_string(),
        );
    }

    let protected = dpapi_protect(key)?;
    fs::write(&path, protected).map_err(|error| format!("无法写入应用密钥恢复副本: {error}"))
}

fn get_or_migrate_history_key(app_handle: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    let entry = Entry::new("task-pilot", "history-key").map_err(|error| error.to_string())?;
    let key_path = get_key_path(app_handle)?;

    match entry.get_password() {
        Ok(password) => {
            let key = STANDARD.decode(&password).map_err(|_| {
                "系统凭据库中的历史密钥格式无效。请先备份历史文件后重新配置。".to_string()
            })?;
            if key.len() != 32 {
                return Err(
                    "系统凭据库中的历史密钥长度无效。请先备份历史文件后重新配置。".to_string(),
                );
            }
            Ok(key)
        }
        Err(keyring::Error::NoEntry) => {
            if key_path.exists() {
                let key =
                    fs::read(&key_path).map_err(|error| format!("无法读取旧历史密钥: {error}"))?;
                if key.len() != 32 {
                    return Err("旧历史密钥格式无效。请先备份历史文件后重新配置。".to_string());
                }

                entry
                    .set_password(&STANDARD.encode(&key))
                    .map_err(|error| format!("无法将历史密钥迁移至系统凭据库: {error}"))?;
                // Keep the legacy file for a user-controlled backup/cleanup step.
                return Ok(key);
            }

            let key = Aes256Gcm::generate_key(OsRng).to_vec();
            entry
                .set_password(&STANDARD.encode(&key))
                .map_err(|error| format!("无法在系统凭据库中创建历史密钥: {error}"))?;
            Ok(key)
        }
        Err(error) => Err(format!("无法访问系统凭据库以读取历史密钥: {error}")),
    }
}

fn encrypt_history(data: &str, key_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(key_bytes).map_err(|e| e.to_string())?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 96-bits

    let ciphertext = cipher
        .encrypt(&nonce, data.as_bytes().as_ref())
        .map_err(|e| e.to_string())?;

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

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| e.to_string())?;
    String::from_utf8(plaintext).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_history(app_handle: tauri::AppHandle, data: String) -> Result<(), String> {
    let key_bytes = get_or_migrate_history_key(&app_handle)?;
    let final_data = encrypt_history(&data, &key_bytes)?;

    let path = get_storage_path(&app_handle)?;
    let mut tmp_path = path.clone();
    tmp_path.set_extension("enc.tmp");

    // Atomic write
    {
        let mut file = fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
        file.write_all(&final_data).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }

    fs::rename(&tmp_path, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_history(app_handle: tauri::AppHandle) -> Result<String, String> {
    let path = get_storage_path(&app_handle)?;
    if !path.exists() {
        return Ok("[]".to_string());
    }

    let key_bytes = get_or_migrate_history_key(&app_handle)?;
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
    fn test_custom_provider_url_validation() {
        assert!(
            validate_custom_provider_url("https://provider.example/v1/chat/completions").is_ok()
        );
        assert!(
            validate_custom_provider_url("http://provider.example/v1/chat/completions").is_err()
        );
        assert!(validate_custom_provider_url("https://127.0.0.1/v1/chat/completions").is_err());
        assert!(validate_custom_provider_url("https://user:pass@provider.example/v1").is_err());
    }

    #[test]
    fn test_invalid_decryption_too_short() {
        let key = Aes256Gcm::generate_key(OsRng);
        let invalid_data = vec![0u8; 10]; // Too short (needs at least 12 bytes nonce)
        let result = decrypt_history(&invalid_data, key.as_slice());
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "Invalid data format");
    }

    #[test]
    fn custom_llm_transport_limits_and_timeout_validation_are_enforced() {
        assert!(validate_custom_llm_request_size(MAX_CUSTOM_LLM_REQUEST_BYTES).is_ok());
        assert!(validate_custom_llm_request_size(MAX_CUSTOM_LLM_REQUEST_BYTES + 1).is_err());
        assert!(validate_custom_llm_response_size(MAX_CUSTOM_LLM_RESPONSE_BYTES).is_ok());
        assert!(validate_custom_llm_response_size(MAX_CUSTOM_LLM_RESPONSE_BYTES + 1).is_err());
        assert!(resolve_custom_timeout_ms(Some(99), 15_000, "连接超时").is_err());
        assert!(
            resolve_custom_timeout_ms(Some(CUSTOM_LLM_MAX_TIMEOUT_MS + 1), 15_000, "总超时")
                .is_err()
        );
        assert_eq!(
            resolve_custom_timeout_ms(None, 15_000, "连接超时").unwrap(),
            15_000
        );
    }

    #[test]
    fn custom_llm_cancellation_registry_rejects_duplicates_and_cleans_up() {
        let state = CustomLlmState::default();
        let request_id = "request-1";
        let token = state
            .register(Some(request_id))
            .unwrap()
            .expect("token should be registered");
        assert!(!token.load(Ordering::SeqCst));
        assert_eq!(state.cancel(request_id).unwrap(), true);
        assert!(token.load(Ordering::SeqCst));
        assert_eq!(
            state.register(Some(request_id)).unwrap_err(),
            "自定义供应商 requestId 已在使用"
        );

        state.remove(Some(request_id));
        assert_eq!(state.cancel(request_id).unwrap(), false);
        assert!(state.register(Some(request_id)).is_ok());
    }

    #[test]
    fn custom_llm_cancellation_registry_accepts_missing_id_and_rejects_long_id() {
        let state = CustomLlmState::default();
        assert!(state.register(None).unwrap().is_none());
        assert_eq!(state.cancel("unknown-request").unwrap(), false);
        let too_long = "x".repeat(121);
        assert_eq!(
            state.register(Some(&too_long)).unwrap_err(),
            "自定义供应商 requestId 过长"
        );
    }
    fn spawn_delayed_custom_llm_server(
        delay: std::time::Duration,
    ) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("mock server should bind");
        let address = listener.local_addr().expect("mock server address");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener
                .accept()
                .expect("mock server should accept request");
            let mut buffer = [0_u8; 4096];
            let _ = std::io::Read::read(&mut stream, &mut buffer);

            std::io::Write::write_all(
                &mut stream,
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n",
            )
            .expect("mock server should write headers");
            std::thread::sleep(delay);
            let _ = std::io::Write::write_all(&mut stream, b"{}");
        });
        (format!("http://{address}/v1/chat/completions"), server)
    }

    fn mock_custom_llm_request(
        url: String,
        request_id: &str,
        first_byte_timeout_ms: u64,
    ) -> CustomLlmRequest {
        CustomLlmRequest {
            url,
            api_key: "test-key".to_string(),
            payload: serde_json::json!({"model":"test","messages":[]}),
            timeout_policy: Some(CustomLlmTimeoutPolicy {
                connect_timeout_ms: Some(1_000),
                first_byte_timeout_ms: Some(first_byte_timeout_ms),
                total_timeout_ms: Some(2_000),
            }),
            request_id: Some(request_id.to_string()),
            trace_id: Some("trace-test".to_string()),
        }
    }

    #[test]
    fn custom_llm_first_byte_timeout_is_enforced_against_mock_server() {
        tauri::async_runtime::block_on(async {
            let (url, server) =
                spawn_delayed_custom_llm_server(std::time::Duration::from_millis(300));
            let result = request_custom_llm_inner(
                mock_custom_llm_request(url, "first-byte-test", 100),
                None,
            )
            .await;
            assert!(result.unwrap_err().contains("阶段：first_byte"));
            server.join().expect("mock server should finish");
        });
    }

    #[test]
    fn custom_llm_cancellation_stops_waiting_for_a_mock_response_body() {
        tauri::async_runtime::block_on(async {
            let (url, server) =
                spawn_delayed_custom_llm_server(std::time::Duration::from_millis(300));
            let token = Arc::new(AtomicBool::new(false));
            let token_for_task = token.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                token_for_task.store(true, Ordering::SeqCst);
            });
            let result = request_custom_llm_inner(
                mock_custom_llm_request(url, "cancel-test", 1_000),
                Some(&token),
            )
            .await;
            assert_eq!(result.unwrap_err(), "自定义供应商请求已取消");
            server.join().expect("mock server should finish");
        });
    }

    #[test]
    fn custom_llm_total_timeout_is_enforced_after_response_headers() {
        tauri::async_runtime::block_on(async {
            let (url, server) =
                spawn_delayed_custom_llm_server(std::time::Duration::from_millis(300));
            let mut request = mock_custom_llm_request(url, "total-timeout-test", 1_000);
            request.timeout_policy.as_mut().unwrap().total_timeout_ms = Some(100);
            let result = request_custom_llm_inner(request, None).await;
            assert!(result.unwrap_err().contains("阶段：total"));
            server.join().expect("mock server should finish");
        });
    }
    #[test]
    fn custom_llm_response_serializes_non_secret_correlation_ids() {
        let response = CustomLlmResponse {
            status: 200,
            body: "{}".to_string(),
            headers: HashMap::new(),
            request_id: Some("request-1".to_string()),
            trace_id: Some("trace-1".to_string()),
        };
        let json = serde_json::to_value(response).expect("response should serialize");
        assert_eq!(json["requestId"], "request-1");
        assert_eq!(json["traceId"], "trace-1");
        assert!(json.get("apiKey").is_none());
    }

    #[test]
    fn custom_llm_registry_enforces_capacity_and_safe_request_ids() {
        let state = CustomLlmState::default();
        for index in 0..MAX_ACTIVE_CUSTOM_LLM_REQUESTS {
            state.register(Some(&format!("request-{index}"))).unwrap();
        }
        assert_eq!(
            state.register(Some("request-overflow")).unwrap_err(),
            "自定义供应商并发请求过多，请稍后重试"
        );
        assert_eq!(
            state.register(Some("bad\nrequest")).unwrap_err(),
            "自定义供应商 requestId 包含非法字符"
        );
        assert_eq!(
            validate_custom_correlation_id("bad\ntrace", "traceId").unwrap_err(),
            "自定义供应商 traceId 包含非法字符"
        );
        assert_eq!(
            annotate_custom_llm_error(Some("bad\nrequest"), Some("trace-1"), "boom".to_string()),
            "boom"
        );
        assert_eq!(
            annotate_custom_llm_error(Some("request-1"), Some("trace-1"), "boom".to_string()),
            "[custom-llm requestId=request-1 traceId=trace-1] boom"
        );
    }
}

const MAX_ACTIVE_CUSTOM_LLM_REQUESTS: usize = 64;
const MAX_CUSTOM_LLM_REQUEST_BYTES: usize = 5 * 1024 * 1024;
const MAX_CUSTOM_LLM_RESPONSE_BYTES: usize = 10 * 1024 * 1024;
const CUSTOM_LLM_REQUEST_TIMEOUT_SECS: u64 = 180;
const CUSTOM_LLM_MAX_TIMEOUT_MS: u64 = 10 * 60 * 1_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomLlmTimeoutPolicy {
    connect_timeout_ms: Option<u64>,
    first_byte_timeout_ms: Option<u64>,
    total_timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct CustomLlmRequest {
    url: String,
    #[serde(rename = "apiKey")]
    api_key: String,
    payload: serde_json::Value,
    #[serde(rename = "timeoutPolicy")]
    timeout_policy: Option<CustomLlmTimeoutPolicy>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    #[serde(rename = "traceId")]
    trace_id: Option<String>,
}

fn validate_custom_llm_request_size(size: usize) -> Result<(), String> {
    if size > MAX_CUSTOM_LLM_REQUEST_BYTES {
        return Err("自定义供应商请求体超过 5 MB 限制".to_string());
    }
    Ok(())
}

fn validate_custom_llm_response_size(size: usize) -> Result<(), String> {
    if size > MAX_CUSTOM_LLM_RESPONSE_BYTES {
        return Err("自定义供应商响应超过 10 MB 限制".to_string());
    }
    Ok(())
}

fn is_safe_custom_correlation_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        })
}

fn validate_custom_correlation_id(value: &str, field_name: &str) -> Result<(), String> {
    if value.len() > 120 {
        return Err(format!("自定义供应商 {field_name} 过长"));
    }
    if !is_safe_custom_correlation_id(value) {
        return Err(format!("自定义供应商 {field_name} 包含非法字符"));
    }
    Ok(())
}

fn annotate_custom_llm_error(
    request_id: Option<&str>,
    trace_id: Option<&str>,
    error: String,
) -> String {
    match request_id.filter(|value| is_safe_custom_correlation_id(value)) {
        Some(request_id) => match trace_id.filter(|value| is_safe_custom_correlation_id(value)) {
            Some(trace_id) => {
                format!("[custom-llm requestId={request_id} traceId={trace_id}] {error}")
            }
            None => format!("[custom-llm requestId={request_id}] {error}"),
        },
        None => error,
    }
}

fn resolve_custom_timeout_ms(
    value: Option<u64>,
    default_ms: u64,
    field_name: &str,
) -> Result<u64, String> {
    let timeout_ms = value.unwrap_or(default_ms);
    if !(100..=CUSTOM_LLM_MAX_TIMEOUT_MS).contains(&timeout_ms) {
        return Err(format!(
            "自定义供应商 {field_name} 必须在 100~{} 毫秒范围内",
            CUSTOM_LLM_MAX_TIMEOUT_MS
        ));
    }
    Ok(timeout_ms)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CustomLlmResponse {
    status: u16,
    body: String,
    headers: HashMap<String, String>,
    request_id: Option<String>,
    trace_id: Option<String>,
}

fn is_non_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(address) => {
            let octets = address.octets();
            let first = octets[0];
            let second = octets[1];
            address.is_loopback()
                || address.is_unspecified()
                || address.is_link_local()
                || first == 10
                || (first == 100 && (64..=127).contains(&second))
                || (first == 172 && (16..=31).contains(&second))
                || (first == 192 && second == 168)
                || (first == 192 && second == 0)
                || (first == 192 && second == 2)
                || (first == 198 && (second == 18 || second == 19))
                || (first == 198 && second == 51 && octets[2] == 100)
                || (first == 203 && second == 0 && octets[2] == 113)
                || first >= 224
        }
        IpAddr::V6(address) => {
            let segments = address.segments();
            let first = segments[0];
            address.is_loopback()
                || address.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || (first & 0xff00) == 0xff00
                || address
                    .to_ipv4_mapped()
                    .is_some_and(|mapped| is_non_public_ip(IpAddr::V4(mapped)))
        }
    }
}

fn validate_custom_provider_url(raw_url: &str) -> Result<url::Url, String> {
    let url =
        url::Url::parse(raw_url).map_err(|error| format!("自定义供应商 URL 无效: {error}"))?;
    let host = url
        .host_str()
        .ok_or_else(|| "自定义供应商 URL 缺少主机名".to_string())?;
    let normalized_host = host.to_ascii_lowercase();
    // Local HTTP is accepted only by code compiled for unit tests so the Rust
    // transport can exercise actual TTFB/cancellation behavior without
    // weakening the production HTTPS/SSRF policy.
    let test_loopback = cfg!(test)
        && url.scheme() == "http"
        && matches!(normalized_host.as_str(), "127.0.0.1" | "::1");
    if url.scheme() != "https" && !test_loopback {
        return Err("自定义供应商只允许使用 HTTPS URL".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("自定义供应商 URL 不允许包含用户名或密码".to_string());
    }

    if (normalized_host == "localhost" || normalized_host.ends_with(".localhost")) && !test_loopback
    {
        return Err("自定义供应商不允许访问 localhost".to_string());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_non_public_ip(ip) && !test_loopback {
            return Err("自定义供应商不允许访问本地或内网 IP 地址".to_string());
        }
    }

    Ok(url)
}

fn resolve_public_socket(host: &str, port: u16) -> Result<SocketAddr, String> {
    let mut addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| format!("无法解析自定义供应商域名: {error}"))?;
    addresses
        .find(|address| cfg!(test) || !is_non_public_ip(address.ip()))
        .ok_or_else(|| "自定义供应商域名解析到了本地或内网地址，已阻止请求".to_string())
}

fn allowed_response_headers(response: &reqwest::Response) -> HashMap<String, String> {
    ["retry-after", "content-type", "x-request-id"]
        .into_iter()
        .filter_map(|name| {
            response
                .headers()
                .get(name)
                .and_then(|value| value.to_str().ok())
                .map(|value| (name.to_string(), value.to_string()))
        })
        .collect()
}

async fn request_custom_llm_inner(
    request: CustomLlmRequest,
    cancellation: Option<&Arc<AtomicBool>>,
) -> Result<CustomLlmResponse, String> {
    let request_id = request.request_id.clone();
    let trace_id = request.trace_id.clone();
    let url = validate_custom_provider_url(&request.url)?;
    let host = url
        .host_str()
        .ok_or_else(|| "自定义供应商 URL 缺少主机名".to_string())?
        .to_string();
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "自定义供应商 URL 缺少有效端口".to_string())?;
    let payload_bytes = serde_json::to_vec(&request.payload)
        .map_err(|error| format!("请求数据序列化失败: {error}"))?;
    validate_custom_llm_request_size(payload_bytes.len())?;
    let (connect_timeout_ms, first_byte_timeout_ms, total_timeout_ms) =
        match request.timeout_policy.as_ref() {
            Some(policy) => (
                resolve_custom_timeout_ms(policy.connect_timeout_ms, 60_000, "连接超时")?,
                resolve_custom_timeout_ms(policy.first_byte_timeout_ms, 60_000, "首字节超时")?,
                resolve_custom_timeout_ms(
                    policy.total_timeout_ms,
                    CUSTOM_LLM_REQUEST_TIMEOUT_SECS * 1_000,
                    "总超时",
                )?,
            ),
            None => (60_000, 60_000, CUSTOM_LLM_REQUEST_TIMEOUT_SECS * 1_000),
        };

    let socket = tauri::async_runtime::spawn_blocking({
        let host = host.clone();
        move || resolve_public_socket(&host, port)
    })
    .await
    .map_err(|error| format!("域名解析任务失败: {error}"))??;
    if cancellation.is_some_and(|token| token.load(Ordering::SeqCst)) {
        return Err("自定义供应商请求已取消".to_string());
    }

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_millis(connect_timeout_ms))
        .timeout(std::time::Duration::from_millis(total_timeout_ms))
        .redirect(reqwest::redirect::Policy::none())
        .resolve(&host, socket)
        .build()
        .map_err(|error| format!("创建自定义供应商 HTTP 客户端失败: {error}"))?;

    let response = await_with_custom_cancellation(
        async {
            client
                .post(url)
                .bearer_auth(request.api_key)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(payload_bytes)
                .send()
                .await
                .map_err(|error| {
                    if error.is_timeout() && error.is_connect() {
                        "自定义供应商请求超时（阶段：connect）".to_string()
                    } else if error.is_timeout() {
                        "自定义供应商请求超时（阶段：total）".to_string()
                    } else {
                        format!("自定义供应商网络请求失败: {error}")
                    }
                })
        },
        cancellation,
    )
    .await?;

    if response
        .content_length()
        .is_some_and(|length| length as usize > MAX_CUSTOM_LLM_RESPONSE_BYTES)
    {
        return Err("自定义供应商响应超过 10 MB 限制".to_string());
    }

    let status = response.status().as_u16();
    let headers = allowed_response_headers(&response);
    let mut response_stream = response;
    let mut body = Vec::new();
    let first_chunk = tokio::time::timeout(
        std::time::Duration::from_millis(first_byte_timeout_ms),
        await_with_custom_cancellation(
            async {
                response_stream.chunk().await.map_err(|error| {
                    if error.is_timeout() {
                        "自定义供应商请求超时（阶段：total）".to_string()
                    } else {
                        format!("读取自定义供应商首字节失败: {error}")
                    }
                })
            },
            cancellation,
        ),
    )
    .await
    .map_err(|_| "自定义供应商请求超时（阶段：first_byte）".to_string())??;

    if let Some(chunk) = first_chunk {
        if body.len().saturating_add(chunk.len()) > MAX_CUSTOM_LLM_RESPONSE_BYTES {
            return Err("自定义供应商响应超过 10 MB 限制".to_string());
        }
        body.extend_from_slice(&chunk);
    }

    while let Some(chunk) = await_with_custom_cancellation(
        async {
            response_stream.chunk().await.map_err(|error| {
                if error.is_timeout() {
                    "自定义供应商请求超时（阶段：total）".to_string()
                } else {
                    format!("读取自定义供应商响应失败: {error}")
                }
            })
        },
        cancellation,
    )
    .await?
    {
        if body.len().saturating_add(chunk.len()) > MAX_CUSTOM_LLM_RESPONSE_BYTES {
            return Err("自定义供应商响应超过 10 MB 限制".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    validate_custom_llm_response_size(body.len())?;

    let body =
        String::from_utf8(body).map_err(|_| "自定义供应商响应不是有效 UTF-8 文本".to_string())?;
    Ok(CustomLlmResponse {
        status,
        body,
        headers,
        request_id,
        trace_id,
    })
}

#[tauri::command]
async fn request_custom_llm(
    request: CustomLlmRequest,
    state: State<'_, CustomLlmState>,
) -> Result<CustomLlmResponse, String> {
    let request_id = request.request_id.clone();
    let trace_id = request.trace_id.clone();
    if let Some(trace_id) = trace_id.as_deref() {
        validate_custom_correlation_id(trace_id, "traceId")
            .map_err(|error| annotate_custom_llm_error(request_id.as_deref(), None, error))?;
    }
    let cancellation = state.register(request_id.as_deref()).map_err(|error| {
        annotate_custom_llm_error(request_id.as_deref(), trace_id.as_deref(), error)
    })?;
    let result = request_custom_llm_inner(request, cancellation.as_ref()).await;
    state.remove(request_id.as_deref());
    result.map_err(|error| {
        annotate_custom_llm_error(request_id.as_deref(), trace_id.as_deref(), error)
    })
}

#[tauri::command]
fn cancel_custom_llm(request_id: String, state: State<'_, CustomLlmState>) -> Result<bool, String> {
    state.cancel(request_id.trim())
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
    let mut log_path = app_data_dir(&app_handle)?;
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
    let mut log_path = app_data_dir(&app_handle)?;
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
    let mut log_path = app_data_dir(&app_handle)?;
    log_path.push("task-pilot.log");
    if log_path.exists() {
        fs::write(&log_path, "").map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn unregister_shortcut(app_handle: tauri::AppHandle) -> Result<(), String> {
    app_handle
        .global_shortcut()
        .unregister_all()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn update_shortcut(app_handle: tauri::AppHandle, shortcut: String) -> Result<(), String> {
    use std::str::FromStr;
    let new_shortcut = Shortcut::from_str(&shortcut).map_err(|error| error.to_string())?;
    app_handle
        .global_shortcut()
        .unregister_all()
        .map_err(|error| error.to_string())?;
    app_handle
        .global_shortcut()
        .register(new_shortcut)
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn set_recording_mode(app_handle: tauri::AppHandle, is_recording: bool) {
    let state = app_handle.state::<AppState>();
    state.is_recording.store(is_recording, Ordering::SeqCst);
}

// Only used to read settings encrypted by legacy versions. New secrets must use the OS keyring.
fn get_legacy_machine_key() -> Result<[u8; 32], String> {
    let uid = machine_uid::get().map_err(|error| format!("无法读取旧版机器标识: {error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(uid.as_bytes());
    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result);
    Ok(key)
}

#[tauri::command]
fn encrypt_secret(app_handle: tauri::AppHandle, value: String) -> Result<String, String> {
    if value.is_empty() {
        return Ok("".to_string());
    }
    let key = get_or_create_secret_key(&app_handle)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 96-bits

    let ciphertext = cipher
        .encrypt(&nonce, value.as_bytes().as_ref())
        .map_err(|e| e.to_string())?;
    let mut final_data = nonce.to_vec();
    final_data.extend_from_slice(&ciphertext);
    Ok(STANDARD.encode(final_data))
}

fn decode_keyring_secret_key(password: &str) -> Option<Vec<u8>> {
    STANDARD.decode(password).ok().filter(|key| key.len() == 32)
}

fn get_or_create_secret_key(app_handle: &tauri::AppHandle) -> Result<Vec<u8>, String> {
    let entry = Entry::new("task-pilot", "secrets-key").ok();

    if let Some(entry) = entry.as_ref() {
        if let Ok(password) = entry.get_password() {
            if let Some(key) = decode_keyring_secret_key(&password) {
                write_secret_recovery_key(app_handle, &key)?;
                return Ok(key);
            }
        }
    }

    if let Some(key) = read_secret_recovery_key(app_handle)? {
        if let Some(entry) = entry.as_ref() {
            let _ = entry.set_password(&STANDARD.encode(&key));
        }
        return Ok(key);
    }

    let key = Aes256Gcm::generate_key(OsRng).to_vec();
    // Create the DPAPI-protected recovery copy before returning the key. If this
    // cannot be written, fail the save instead of creating ciphertext that the
    // next application start cannot decrypt.
    write_secret_recovery_key(app_handle, &key)?;
    if let Some(entry) = entry.as_ref() {
        let _ = entry.set_password(&STANDARD.encode(&key));
    }
    Ok(key)
}

#[tauri::command]
fn decrypt_secret(app_handle: tauri::AppHandle, cipher_text: String) -> Result<String, String> {
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

    let (nonce_bytes, ciphertext) = encrypted_data.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);

    // Prefer the keyring key and its DPAPI-protected recovery copy.
    if let Ok(key) = get_or_create_secret_key(&app_handle) {
        if let Ok(cipher) = Aes256Gcm::new_from_slice(&key) {
            if let Ok(plaintext) = cipher.decrypt(nonce, ciphertext) {
                if let Ok(s) = String::from_utf8(plaintext) {
                    return Ok(s);
                }
            }
        }
    }

    // Fallback to legacy machine_uid key
    if let Ok(key) = get_legacy_machine_key() {
        if let Ok(cipher) = Aes256Gcm::new_from_slice(&key) {
            if let Ok(plaintext) = cipher.decrypt(nonce, ciphertext) {
                if let Ok(s) = String::from_utf8(plaintext) {
                    return Ok(s);
                }
            }
        }
    }

    // If we reach here, it IS a valid base64 string of correct length, but we CANNOT decrypt it.
    // It's highly likely it is a corrupted/orphaned encrypted string.
    // Returning the raw ciphertext causes double-encryption bugs and UI confusion.
    // We MUST return an empty string to clear the corrupted state so the user can re-enter it.
    Ok("".to_string())
}

#[cfg(test)]
mod secret_key_tests {
    use super::*;

    #[test]
    fn accepts_only_a_valid_256_bit_keyring_key() {
        let valid = STANDARD.encode([7u8; 32]);
        assert_eq!(decode_keyring_secret_key(&valid), Some(vec![7u8; 32]));
        assert_eq!(decode_keyring_secret_key("invalid"), None);
        assert_eq!(decode_keyring_secret_key(&STANDARD.encode([7u8; 31])), None);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn dpapi_recovery_material_round_trips_for_the_current_windows_user() {
        let key = [42u8; 32];
        let protected = dpapi_protect(&key).expect("DPAPI should protect the recovery key");
        assert_ne!(protected, key);
        assert_eq!(
            dpapi_unprotect(&protected).expect("DPAPI should restore the recovery key"),
            key
        );
    }
}

const MAX_DROPPED_FILE_SIZE: u64 = 15 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDroppedFile {
    name: String,
    mime_type: String,
    data_base64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFileDropEvent {
    #[serde(rename = "type")]
    event_type: &'static str,
    files: Vec<NativeDroppedFile>,
    errors: Vec<String>,
}

fn dropped_file_mime_type(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("svg") => "image/svg+xml",
        Some("pdf") => "application/pdf",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("xls") => "application/vnd.ms-excel",
        Some("csv") => "text/csv",
        Some("txt") => "text/plain",
        Some("md") => "text/markdown",
        _ => "application/octet-stream",
    }
}

fn read_dropped_file(path: &std::path::Path) -> Result<NativeDroppedFile, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取拖放文件信息: {error}"))?;
    if !metadata.is_file() {
        return Err("拖放目标不是文件。".to_string());
    }
    if metadata.len() > MAX_DROPPED_FILE_SIZE {
        return Err("文件超过 15 MB 解析上限。".to_string());
    }

    let bytes = fs::read(path).map_err(|error| format!("无法读取拖放文件: {error}"))?;
    if bytes.len() as u64 > MAX_DROPPED_FILE_SIZE {
        return Err("文件超过 15 MB 解析上限。".to_string());
    }

    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| "无法获取拖放文件名称。".to_string())?;

    Ok(NativeDroppedFile {
        name,
        mime_type: dropped_file_mime_type(path).to_string(),
        data_base64: STANDARD.encode(bytes),
    })
}

fn emit_native_file_drop_event<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    event_type: &'static str,
    paths: &[PathBuf],
) {
    let mut files = Vec::new();
    let mut errors = Vec::new();

    if event_type == "drop" {
        for path in paths.iter().take(5) {
            match read_dropped_file(path) {
                Ok(file) => files.push(file),
                Err(error) => errors.push(format!("{}：{error}", path.display())),
            }
        }
        if paths.len() > 5 {
            errors.push("单次最多解析 5 个文件。".to_string());
        }
    }

    let payload = NativeFileDropEvent {
        event_type,
        files,
        errors,
    };
    if let Err(error) = window.emit("native-file-drag-drop", payload) {
        log::error!("无法向前端发送原生拖放事件: {error}");
    }
}
fn toggle_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    // A minimized window can still be visible, so restore it before applying
    // the normal visible/hidden toggle behavior.
    match window.is_minimized() {
        Ok(true) => {
            for operation in [window.unminimize(), window.show(), window.set_focus()] {
                if let Err(error) = operation {
                    eprintln!("无法恢复主窗口: {error}");
                    break;
                }
            }
            return;
        }
        Ok(false) => {}
        Err(error) => eprintln!("无法读取主窗口最小化状态: {error}"),
    }

    match window.is_visible() {
        Ok(true) => {
            if let Err(error) = window.hide() {
                eprintln!("无法隐藏主窗口: {error}");
            }
        }
        Ok(false) => {
            for operation in [window.show(), window.set_focus()] {
                if let Err(error) = operation {
                    eprintln!("无法显示主窗口: {error}");
                    break;
                }
            }
        }
        Err(error) => eprintln!("无法读取主窗口可见状态: {error}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(drag_event) = event {
                match drag_event {
                    tauri::DragDropEvent::Enter { paths, .. } => {
                        emit_native_file_drop_event(window, "enter", paths);
                    }
                    tauri::DragDropEvent::Over { .. } => {
                        emit_native_file_drop_event(window, "over", &[]);
                    }
                    tauri::DragDropEvent::Drop { paths, .. } => {
                        emit_native_file_drop_event(window, "drop", paths);
                    }
                    tauri::DragDropEvent::Leave => {
                        emit_native_file_drop_event(window, "leave", &[]);
                    }
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            save_history,
            load_history,
            trigger_screenshot,
            write_log,
            open_log_file,
            clear_log,
            unregister_shortcut,
            update_shortcut,
            set_recording_mode,
            encrypt_secret,
            decrypt_secret,
            get_email_folders,
            fetch_emails,
            mark_email_read,
            request_custom_llm,
            cancel_custom_llm
        ])
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let state = app.state::<AppState>();
                        if state.is_recording.load(Ordering::SeqCst) {
                            let _ = app.emit("global-shortcut-triggered", ());
                            return;
                        }

                        // Since we dynamically register the shortcut, any triggered shortcut for this app toggles the main window.
                        toggle_main_window(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            app.manage(AppState {
                is_recording: AtomicBool::new(false),
            });
            app.manage(CustomLlmState::default());

            let alt_space = Shortcut::new(Some(Modifiers::ALT), Code::Space);
            let _ = app.global_shortcut().register(alt_space);

            let quit_i = tauri::menu::MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&quit_i])?;

            let default_icon = app.default_window_icon().cloned().ok_or_else(|| {
                std::io::Error::new(std::io::ErrorKind::NotFound, "默认窗口图标不可用")
            })?;

            tauri::tray::TrayIconBuilder::new()
                .icon(default_icon)
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
                    } = event
                    {
                        toggle_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
