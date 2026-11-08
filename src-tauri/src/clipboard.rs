// src-tauri/src/clipboard.rs
use crate::state::AppState;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

fn compute_text_sig(text: &str) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    let digest = Sha256::digest(text.as_bytes());
    Some(hex::encode(&digest[..12]))
}

#[tauri::command]
pub async fn clipboard_read<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    let text = app.clipboard().read_text().ok().unwrap_or_default();
    Ok(json!({
        "text": text,
        "html": null,
        "image": null
    }))
}

#[tauri::command]
pub async fn clipboard_write<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<AppState>>,
    payload: Value,
) -> Result<Value, String> {
    let text = payload
        .get("text")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if !text.is_empty() {
        let _ = app.clipboard().write_text(text.to_string());
    }

    let sig = compute_text_sig(text);
    *state.last_clipboard_sig.write() = sig.clone();

    Ok(json!({
        "ok": true,
        "signature": sig
    }))
}

#[tauri::command]
pub async fn clipboard_signature<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<AppState>>,
) -> Result<Option<String>, String> {
    if let Ok(text) = app.clipboard().read_text() {
        let sig = compute_text_sig(&text);
        *state.last_clipboard_sig.write() = sig.clone();
        return Ok(sig);
    }
    Ok(state.last_clipboard_sig.read().clone())
}
