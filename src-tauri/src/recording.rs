// src-tauri/src/recording.rs
use crate::{
    assets::sanitize_asset_id,
    state::{ActiveRecording, AppState},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufWriter, Write},
    sync::Arc,
};
use tauri::State;

#[tauri::command]
pub async fn recording_start(
    state: State<'_, Arc<AppState>>,
    #[allow(non_snake_case)] sessionId: String,
) -> Result<bool, String> {
    let clean_session = sanitize_asset_id(&sessionId)?;
    let temp_path = state
        .assets_dir()
        .join(format!(".rec-{}.tmp", clean_session));

    let file = File::create(&temp_path).map_err(|e| format!("Failed creating recording file: {}", e))?;
    let active = ActiveRecording {
        temp_path,
        writer: BufWriter::new(file),
        hasher: Sha256::new(),
        bytes_written: 0,
    };

    state.recordings.lock().insert(clean_session, active);
    Ok(true)
}

#[tauri::command]
pub async fn recording_append_chunk(
    state: State<'_, Arc<AppState>>,
    #[allow(non_snake_case)] sessionId: String,
    chunk: Vec<u8>,
) -> Result<bool, String> {
    let clean_session = sanitize_asset_id(&sessionId)?;
    let mut guard = state.recordings.lock();
    let rec = guard
        .get_mut(&clean_session)
        .ok_or_else(|| format!("Recording session not found: {}", clean_session))?;

    rec.writer
        .write_all(&chunk)
        .map_err(|e| format!("Failed appending audio chunk: {}", e))?;
    rec.hasher.update(&chunk);
    rec.bytes_written += chunk.len() as u64;
    Ok(true)
}

#[tauri::command]
pub async fn recording_finish(
    state: State<'_, Arc<AppState>>,
    #[allow(non_snake_case)] sessionId: String,
    #[allow(non_snake_case)] durationMs: u64,
) -> Result<Value, String> {
    let clean_session = sanitize_asset_id(&sessionId)?;
    let mut rec = state
        .recordings
        .lock()
        .remove(&clean_session)
        .ok_or_else(|| format!("Recording session not found: {}", clean_session))?;

    rec.writer.flush().map_err(|e| e.to_string())?;
    if let Ok(inner_file) = rec.writer.into_inner() {
        let _ = inner_file.sync_all();
    }

    let hash_hex = hex::encode(rec.hasher.finalize());
    let asset_id = format!("{}.webm", hash_hex);
    let final_path = state.assets_dir().join(&asset_id);

    if final_path.exists() {
        let _ = fs::remove_file(&rec.temp_path);
    } else {
        fs::rename(&rec.temp_path, &final_path).or_else(|_| {
            fs::copy(&rec.temp_path, &final_path)?;
            fs::remove_file(&rec.temp_path)
        }).map_err(|e| format!("Failed finalizing recording asset: {}", e))?;
    }

    Ok(json!({
        "assetId": asset_id,
        "durationMs": durationMs
    }))
}
