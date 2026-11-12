// src-tauri/src/assets.rs
use crate::{state::AppState, storage::atomic_write_bytes};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::State;

const KNOWN_EXTS: &[&str] = &[
    "png", "webp", "jpg", "jpeg", "svg", "gif", "webm", "ogg", "mp3", "wav", "mp4", "pdf", "bin",
];

fn mime_to_ext(mime: &str) -> &'static str {
    match mime.trim().to_ascii_lowercase().as_str() {
        "image/png" => "png",
        "image/webp" => "webp",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/svg+xml" => "svg",
        "image/gif" => "gif",
        "audio/webm" | "video/webm" | "audio/webm;codecs=opus" => "webm",
        "audio/ogg" => "ogg",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "application/pdf" => "pdf",
        _ => "bin",
    }
}

fn ext_to_mime(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "gif" => "image/gif",
        "webm" => "audio/webm",
        "ogg" => "audio/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

pub fn ext_from_mime(mime: &str) -> &'static str {
    mime_to_ext(mime)
}

pub fn mime_from_ext(ext: &str) -> &'static str {
    ext_to_mime(ext)
}

pub fn decode_data_url(data_url: &str) -> Result<(String, Vec<u8>), String> {
    let (header, b64_body) = data_url
        .split_once(',')
        .ok_or_else(|| "Invalid data URL format".to_string())?;
    let mime = header
        .strip_prefix("data:")
        .and_then(|s| s.split(';').next())
        .unwrap_or("application/octet-stream")
        .to_string();
    let bytes = BASE64
        .decode(b64_body.trim())
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    Ok((mime, bytes))
}

pub fn sanitize_asset_id(id: &str) -> Result<String, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return Err("Invalid asset ID length".into());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return Err("Unsafe asset ID".into());
    }
    Ok(trimmed.to_string())
}

pub fn resolve_asset_path(assets_dir: &Path, raw_id: &str) -> Option<PathBuf> {
    let clean = sanitize_asset_id(raw_id).ok()?;
    let direct = assets_dir.join(&clean);
    if direct.is_file() {
        return Some(direct);
    }
    // Probe known extensions if raw_id is a bare SHA-256 hash
    for ext in KNOWN_EXTS {
        let candidate = assets_dir.join(format!("{}.{}", clean, ext));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[tauri::command]
pub async fn assets_put(
    state: State<'_, Arc<AppState>>,
    #[allow(non_snake_case)] dataUrl: String,
) -> Result<Value, String> {
    let (header, b64_body) = dataUrl
        .split_once(',')
        .ok_or_else(|| "Invalid data URL format".to_string())?;

    let mime = header
        .strip_prefix("data:")
        .and_then(|s| s.split(';').next())
        .unwrap_or("application/octet-stream");

    let bytes = BASE64
        .decode(b64_body.trim())
        .map_err(|e| format!("Base64 decode error: {}", e))?;

    let hash_hex = hex::encode(Sha256::digest(&bytes));
    let ext = mime_to_ext(mime);
    let file_name = format!("{}.{}", hash_hex, ext);
    let target_path = state.assets_dir().join(&file_name);

    if !target_path.exists() {
        atomic_write_bytes(&target_path, &bytes)?;
    }

    Ok(json!({ "id": file_name, "hash": hash_hex }))
}

#[tauri::command]
pub async fn assets_get(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<Option<String>, String> {
    let assets_dir = state.assets_dir();
    let Some(path) = resolve_asset_path(&assets_dir, &id) else {
        return Ok(None);
    };

    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("bin");
    let mime = ext_to_mime(ext);
    let b64 = BASE64.encode(&bytes);

    Ok(Some(format!("data:{};base64,{}", mime, b64)))
}

#[tauri::command]
pub async fn assets_have(
    state: State<'_, Arc<AppState>>,
    ids: Vec<String>,
) -> Result<HashMap<String, bool>, String> {
    let assets_dir = state.assets_dir();
    let mut map = HashMap::with_capacity(ids.len());
    for id in ids {
        let exists = resolve_asset_path(&assets_dir, &id).is_some();
        map.insert(id, exists);
    }
    Ok(map)
}

#[tauri::command]
pub async fn assets_put_binary_direct(
    state: State<'_, Arc<AppState>>,
    #[allow(non_snake_case)] assetId: String,
    buffer: Vec<u8>,
) -> Result<bool, String> {
    let clean_id = sanitize_asset_id(&assetId)?;
    let file_name = if clean_id.contains('.') {
        clean_id
    } else {
        format!("{}.bin", clean_id)
    };
    let target_path = state.assets_dir().join(file_name);
    if !target_path.exists() {
        atomic_write_bytes(&target_path, &buffer)?;
    }
    Ok(true)
}

#[tauri::command]
pub async fn assets_put_binary(
    state: State<'_, Arc<AppState>>,
    id: String,
    #[allow(non_snake_case)] dataB64: String,
) -> Result<Value, String> {
    let clean_id = sanitize_asset_id(&id)?;
    let file_name = if clean_id.contains('.') {
        clean_id
    } else {
        format!("{}.bin", clean_id)
    };
    let bytes = BASE64
        .decode(dataB64.trim())
        .map_err(|e| format!("Base64 decode error: {}", e))?;
    let target_path = state.assets_dir().join(&file_name);
    if !target_path.exists() {
        atomic_write_bytes(&target_path, &bytes)?;
    }
    Ok(json!({ "ok": true, "id": file_name }))
}

#[tauri::command]
pub async fn assets_delete(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<bool, String> {
    let assets_dir = state.assets_dir();
    if let Some(path) = resolve_asset_path(&assets_dir, &id) {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

fn ingest_pdf_slice(assets_dir: &Path, bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() < 5 || &bytes[0..5] != b"%PDF-" {
        return Err("Invalid PDF file: missing %PDF- magic header".into());
    }
    let hash = hex::encode(Sha256::digest(bytes));
    let asset_id = format!("{}.pdf", hash);
    fs::create_dir_all(assets_dir).map_err(|e| e.to_string())?;
    let target_path = assets_dir.join(&asset_id);
    if !target_path.exists() {
        let tmp_path = assets_dir.join(format!("{}.tmp.{}", asset_id, std::process::id()));
        if fs::write(&tmp_path, bytes).is_ok() {
            if fs::rename(&tmp_path, &target_path).is_err() {
                let _ = fs::remove_file(&tmp_path);
                atomic_write_bytes(&target_path, bytes)?;
            }
        } else {
            atomic_write_bytes(&target_path, bytes)?;
        }
    }
    Ok(json!({
        "ok": true,
        "assetId": asset_id,
        "byteLength": bytes.len(),
        "uri": format!("app://board/__asset/{}", asset_id)
    }))
}

#[tauri::command]
pub async fn pdf_ingest_path(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<Value, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Failed reading PDF at {}: {}", path, e))?;
    ingest_pdf_slice(&state.assets_dir(), &bytes)
}

#[tauri::command]
pub async fn pdf_ingest_bytes(
    state: State<'_, Arc<AppState>>,
    bytes: Vec<u8>,
) -> Result<Value, String> {
    ingest_pdf_slice(&state.assets_dir(), &bytes)
}

#[tauri::command]
pub async fn assets_read_raw(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<Vec<u8>, String> {
    let trimmed = id.trim();
    if trimmed.is_empty()
        || trimmed.contains("..")
        || trimmed.contains('/')
        || trimmed.contains('\\')
    {
        return Err("Unsafe asset ID".into());
    }
    let clean_id = sanitize_asset_id(trimmed)?;
    let assets_dir = state.assets_dir();
    let target = assets_dir.join(&clean_id);
    if target.is_file() {
        return fs::read(&target).map_err(|e| e.to_string());
    }
    if let Some(resolved) = resolve_asset_path(&assets_dir, &clean_id) {
        return fs::read(&resolved).map_err(|e| e.to_string());
    }
    Err(format!("Asset not found: {}", clean_id))
}
