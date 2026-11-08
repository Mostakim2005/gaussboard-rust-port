// src-tauri/src/storage.rs
use crate::state::{AppState, BoardIndexEntry, BoardMeta, LastBoardConfig, StorageLocationConfig};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Runtime, State};
#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;
use tempfile::Builder as TempFileBuilder;

pub fn safe_board_id(raw_id: &str) -> Result<String, String> {
    let trimmed = raw_id
        .trim()
        .strip_suffix(".json")
        .or_else(|| raw_id.trim().strip_suffix(".gaussboard"))
        .or_else(|| raw_id.trim().strip_suffix(".gazboard"))
        .unwrap_or(raw_id.trim());

    if trimmed.is_empty() || trimmed.len() > 160 {
        return Err("Invalid board ID length".into());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("Invalid board ID".into());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(format!("Unsafe characters in board ID: {}", trimmed));
    }
    Ok(trimmed.to_string())
}

pub fn atomic_write_bytes(target_path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = target_path
        .parent()
        .ok_or_else(|| "Target path has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let mut tmp = TempFileBuilder::new()
        .prefix(".gb-tmp-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|e| format!("Failed creating temp file: {}", e))?;

    tmp.write_all(bytes)
        .map_err(|e| format!("Failed writing temp file: {}", e))?;
    tmp.as_file()
        .sync_all()
        .map_err(|e| format!("Failed syncing temp file: {}", e))?;

    // Retry persist up to 5 times for Windows Defender / OneDrive transient locks
    let mut current_tmp = tmp;
    for attempt in 0..5 {
        match current_tmp.persist(target_path) {
            Ok(_) => return Ok(()),
            Err(persist_err) => {
                current_tmp = persist_err.file;
                if attempt < 4 {
                    std::thread::sleep(Duration::from_millis(15 * (1 << attempt)));
                }
            }
        }
    }

    // Final fallback if cloud sync holds a directory rename lock
    fs::write(target_path, bytes).map_err(|e| format!("Fallback write failed: {}", e))
}

fn file_mtime_ms_and_size(meta: &fs::Metadata) -> (u64, u64) {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    (mtime, meta.len())
}

fn extract_board_meta(file_stem: &str, raw: &Value, mtime_ms: u64) -> BoardMeta {
    let id = raw
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(file_stem)
        .to_string();

    let name = raw
        .get("name")
        .or_else(|| raw.get("title"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Untitled board")
        .to_string();

    let objects = raw
        .get("objects")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);

    let thumb = raw
        .get("thumb")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let origin = raw
        .get("origin")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let properties = raw.get("properties").cloned().filter(|v| !v.is_null());

    let parse_str_array = |val: Option<&Value>| -> Option<Vec<String>> {
        val.and_then(|v| v.as_array()).map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                .collect()
        })
    };

    let tags = parse_str_array(raw.get("tags"))
        .or_else(|| parse_str_array(raw.pointer("/properties/tags")));

    let aliases = parse_str_array(raw.get("aliases"))
        .or_else(|| parse_str_array(raw.pointer("/properties/aliases")));

    BoardMeta {
        id,
        name,
        objects,
        thumb,
        origin,
        properties,
        tags,
        aliases,
        modified: mtime_ms,
    }
}

#[tauri::command]
pub async fn boards_list(state: State<'_, Arc<AppState>>) -> Result<Vec<BoardMeta>, String> {
    let boards_dir = state.boards_dir();
    let dir_key = boards_dir.to_string_lossy().to_string();
    let _ = fs::create_dir_all(&boards_dir);

    let entries = fs::read_dir(&boards_dir).map_err(|e| e.to_string())?;
    let mut seen_files = HashSet::new();
    let mut results = Vec::new();
    let mut index_dirty = false;

    let mut index_guard = state.board_index.lock();
    let dir_cache = index_guard.dirs.entry(dir_key).or_default();

    for entry in entries.flatten() {
        let path = entry.path();
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) if n.ends_with(".json") && !n.starts_with('.') && n != "catalogue.json" => {
                n.to_string()
            }
            _ => continue,
        };

        let meta = match entry.metadata() {
            Ok(m) if m.is_file() => m,
            _ => continue,
        };

        let (mtime, size) = file_mtime_ms_and_size(&meta);
        seen_files.insert(file_name.clone());

        if let Some(cached) = dir_cache.get(&file_name) {
            if cached.mtime == mtime && cached.size == size {
                let mut bm = cached.meta.clone();
                bm.modified = mtime;
                results.push(bm);
                continue;
            }
        }

        // Cache miss or modified file: parse JSON
        let file_stem = file_name.trim_end_matches(".json");
        if let Ok(content) = fs::read_to_string(&path) {
            if let Ok(raw_json) = serde_json::from_str::<Value>(&content) {
                let bm = extract_board_meta(file_stem, &raw_json, mtime);
                dir_cache.insert(
                    file_name,
                    BoardIndexEntry {
                        mtime,
                        size,
                        meta: bm.clone(),
                    },
                );
                index_dirty = true;
                results.push(bm);
            }
        }
    }

    // Prune deleted files from index cache
    let before_len = dir_cache.len();
    dir_cache.retain(|k, _| seen_files.contains(k));
    if dir_cache.len() != before_len {
        index_dirty = true;
    }

    if index_dirty {
        state.persist_index(&index_guard);
    }
    drop(index_guard);

    // Sort descending by modified epoch ms
    results.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(results)
}

#[tauri::command]
pub async fn boards_load(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<Option<Value>, String> {
    let clean_id = safe_board_id(&id)?;
    let path = state.boards_dir().join(format!("{}.json", clean_id));
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let doc: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    Ok(Some(doc))
}

#[derive(Deserialize)]
pub struct SaveBoardPayload {
    pub id: String,
    pub json: Value,
    #[serde(rename = "setLast", default)]
    pub set_last: Option<bool>,
}

#[tauri::command]
pub async fn boards_save<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<AppState>>,
    payload: SaveBoardPayload,
) -> Result<bool, String> {
    let clean_id = safe_board_id(&payload.id)?;
    let boards_dir = state.boards_dir();
    let file_name = format!("{}.json", clean_id);
    let file_path = boards_dir.join(&file_name);

    let serialized = if let Some(s) = payload.json.as_str() {
        s.as_bytes().to_vec()
    } else {
        serde_json::to_vec(&payload.json).map_err(|e| e.to_string())?
    };

    atomic_write_bytes(&file_path, &serialized)?;

    // Update index entry immediately
    if let Ok(meta) = fs::metadata(&file_path) {
        let (mtime, size) = file_mtime_ms_and_size(&meta);
        let parsed_val: Value = if let Some(s) = payload.json.as_str() {
            serde_json::from_str(s).unwrap_or(Value::Null)
        } else {
            payload.json.clone()
        };
        if !parsed_val.is_null() {
            let bm = extract_board_meta(&clean_id, &parsed_val, mtime);
            let dir_key = boards_dir.to_string_lossy().to_string();
            let mut idx = state.board_index.lock();
            idx.dirs.entry(dir_key).or_default().insert(
                file_name,
                BoardIndexEntry {
                    mtime,
                    size,
                    meta: bm,
                },
            );
            state.persist_index(&idx);
        }
    }

    if payload.set_last.unwrap_or(true) {
        let _ = write_last_board(&state, &clean_id);
    }

    // Notify secondary windows of external update
    let _ = app.emit("board:externalUpdate", json!({ "id": clean_id }));
    Ok(true)
}

#[tauri::command]
pub async fn boards_delete(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<bool, String> {
    let clean_id = safe_board_id(&id)?;
    let boards_dir = state.boards_dir();
    let file_name = format!("{}.json", clean_id);
    let path = boards_dir.join(&file_name);

    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }

    let dir_key = boards_dir.to_string_lossy().to_string();
    let mut idx = state.board_index.lock();
    if let Some(dir_map) = idx.dirs.get_mut(&dir_key) {
        if dir_map.remove(&file_name).is_some() {
            state.persist_index(&idx);
        }
    }
    Ok(true)
}

fn read_last_board_config(state: &AppState) -> LastBoardConfig {
    let path = state.user_data_dir.join("last-board.json");
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<LastBoardConfig>(&s).ok())
        .unwrap_or_default()
}

fn write_last_board(state: &AppState, id: &str) -> Result<(), String> {
    let path = state.user_data_dir.join("last-board.json");
    let mut cfg = read_last_board_config(state);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let dir_key = state.boards_dir().to_string_lossy().to_string();

    cfg.id = Some(id.to_string());
    cfg.at = Some(now_ms);
    cfg.by_folder.insert(dir_key, id.to_string());

    let bytes = serde_json::to_vec(&cfg).map_err(|e| e.to_string())?;
    atomic_write_bytes(&path, &bytes)
}

#[tauri::command]
pub async fn boards_get_last(state: State<'_, Arc<AppState>>) -> Result<Option<String>, String> {
    let cfg = read_last_board_config(&state);
    let dir_key = state.boards_dir().to_string_lossy().to_string();
    Ok(cfg.by_folder.get(&dir_key).cloned().or(cfg.id))
}

#[tauri::command]
pub async fn boards_set_last(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    let clean_id = safe_board_id(&id)?;
    write_last_board(&state, &clean_id)
}

#[tauri::command]
pub async fn boards_resume(
    state: State<'_, Arc<AppState>>,
    _opts: Option<Value>,
) -> Result<Value, String> {
    let last_id = boards_get_last(state.clone()).await?;
    if let Some(ref id) = last_id {
        if let Ok(Some(doc)) = boards_load(state, id.clone()).await {
            return Ok(json!({ "id": id, "board": doc }));
        }
    }
    Ok(json!({ "id": null, "board": null }))
}

#[tauri::command]
pub async fn boards_migrate() -> Result<(), String> {
    Ok(())
}

// --- Storage Location Management & Catalogue ---

#[tauri::command]
pub async fn storage_get(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    let current = state.boards_dir();
    let default_dir = &state.default_boards_dir;
    Ok(json!({
        "boardsDir": current.to_string_lossy(),
        "defaultDir": default_dir.to_string_lossy(),
        "isCustom": &current != default_dir
    }))
}

#[tauri::command]
pub async fn storage_choose<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    #[cfg(mobile)]
    {
        let _ = (app, state);
        return Err("Custom storage directory selection is not supported on mobile platforms".into());
    }

    #[cfg(desktop)]
    {
        let picked = app.dialog().file().blocking_pick_folder();
        match picked {
            Some(folder_path) => {
                let path_buf = folder_path
                    .into_path()
                    .map_err(|e| format!("Invalid folder path: {}", e))?;
                let existing_json_count = fs::read_dir(&path_buf)
                    .ok()
                    .map(|it| {
                        it.flatten()
                            .filter(|e| {
                                e.path()
                                    .extension()
                                    .and_then(|ext| ext.to_str())
                                    == Some("json")
                            })
                            .count()
                    })
                    .unwrap_or(0);
                Ok(json!({
                    "canceled": false,
                    "path": path_buf.to_string_lossy(),
                    "existingCount": existing_json_count,
                    "currentDir": state.boards_dir().to_string_lossy()
                }))
            }
            None => Ok(json!({ "canceled": true })),
        }
    }
}

async fn request_renderer_flush<R: Runtime>(app: &AppHandle<R>, state: &AppState) -> bool {
    let ticket = format!(
        "flush-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    );
    let (tx, rx) = tokio::sync::oneshot::channel();
    state.flush_waiters.lock().insert(ticket.clone(), tx);

    let _ = app.emit("storage:flush", json!({ "ticket": ticket }));

    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(ok)) => ok,
        _ => {
            state.flush_waiters.lock().remove(&ticket);
            true // Proceed after timeout so UI never hangs
        }
    }
}

#[tauri::command]
pub async fn storage_flush_ack(
    state: State<'_, Arc<AppState>>,
    ticket: String,
    ok: bool,
) -> Result<(), String> {
    if let Some(tx) = state.flush_waiters.lock().remove(&ticket) {
        let _ = tx.send(ok);
    }
    Ok(())
}

fn copy_dir_contents(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        let target = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir_contents(&path, &target)?;
        } else if !target.exists() {
            let _ = fs::copy(&path, &target);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn storage_apply<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<AppState>>,
    opts: Value,
) -> Result<Value, String> {
    let new_path_str = opts
        .get("path")
        .or_else(|| opts.get("boardsDir"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing target storage path".to_string())?;

    let new_dir = PathBuf::from(new_path_str);
    fs::create_dir_all(&new_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(new_dir.join("assets")).map_err(|e| e.to_string())?;

    request_renderer_flush(&app, &state).await;

    let old_dir = state.boards_dir();
    let mode = opts.get("mode").and_then(|v| v.as_str()).unwrap_or("copy");
    if mode == "copy" || mode == "move" {
        copy_dir_contents(&old_dir, &new_dir)?;
    }

    // Persist storage-location.json
    let cfg = StorageLocationConfig {
        version: 1,
        boards_dir: new_dir.to_string_lossy().to_string(),
    };
    let cfg_bytes = serde_json::to_vec(&cfg).map_err(|e| e.to_string())?;
    atomic_write_bytes(&state.user_data_dir.join("storage-location.json"), &cfg_bytes)?;

    *state.active_boards_dir.write() = new_dir.clone();

    let delete_token = format!("old-{}", rand::random::<u64>());
    state
        .previous_boards_dirs
        .lock()
        .insert(delete_token.clone(), old_dir);

    let _ = app.emit("storage:changed", json!({ "boardsDir": new_dir.to_string_lossy() }));
    let _ = app.emit("storage:resume", json!({ "boardsDir": new_dir.to_string_lossy() }));

    Ok(json!({
        "ok": true,
        "boardsDir": new_dir.to_string_lossy(),
        "deleteToken": delete_token
    }))
}

#[tauri::command]
pub async fn storage_reset<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<AppState>>,
    opts: Option<Value>,
) -> Result<Value, String> {
    let default_path = state.default_boards_dir.to_string_lossy().to_string();
    let mut merged = opts.unwrap_or_else(|| json!({}));
    if let Some(obj) = merged.as_object_mut() {
        obj.insert("path".to_string(), Value::String(default_path));
    }
    let res = storage_apply(app, state.clone(), merged).await?;
    let _ = fs::remove_file(state.user_data_dir.join("storage-location.json"));
    Ok(res)
}

#[tauri::command]
pub async fn storage_delete_old(
    state: State<'_, Arc<AppState>>,
    token: String,
) -> Result<bool, String> {
    let old_dir = state.previous_boards_dirs.lock().remove(&token);
    if let Some(dir) = old_dir {
        if dir != state.boards_dir() && dir.exists() {
            for entry in fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten() {
                let p = entry.path();
                if p.extension().and_then(|e| e.to_str()) == Some("json") {
                    let _ = fs::remove_file(p);
                }
            }
            return Ok(true);
        }
    }
    Ok(false)
}

#[tauri::command]
pub async fn storage_catalogue_read(state: State<'_, Arc<AppState>>) -> Result<Value, String> {
    let path = state.boards_dir().join("catalogue.json");
    if !path.exists() {
        return Ok(json!({ "folders": [], "boardFolders": {} }));
    }
    let s = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn storage_catalogue_write(
    state: State<'_, Arc<AppState>>,
    json: Value,
) -> Result<bool, String> {
    let path = state.boards_dir().join("catalogue.json");
    let bytes = serde_json::to_vec(&json).map_err(|e| e.to_string())?;
    atomic_write_bytes(&path, &bytes)?;
    Ok(true)
}
