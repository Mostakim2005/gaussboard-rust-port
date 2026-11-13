// src-tauri/src/vault.rs
// Obsidian Vault Bridge: bidirectional, sandboxed .md listing, reading and atomic writing.

use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Runtime};
#[cfg(desktop)]
use tauri_plugin_dialog::DialogExt;
use walkdir::WalkDir;

use crate::storage::atomic_write_bytes;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultNoteEntry {
    pub rel_path: String,
    pub name: String,
    pub modified_ms: u64,
    pub size: u64,
}

fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn canonical_vault_root(vault_root: &str) -> Result<PathBuf, String> {
    let trimmed = vault_root.trim();
    if trimmed.is_empty() {
        return Err("No Obsidian vault folder configured".to_string());
    }
    let root = fs::canonicalize(trimmed)
        .map_err(|e| format!("Vault folder unavailable: {}", e))?;
    if !root.is_dir() {
        return Err("Vault path is not a folder".to_string());
    }
    Ok(root)
}

fn resolve_note_path(vault_root: &str, rel_path: &str) -> Result<(PathBuf, String), String> {
    let canon_root = canonical_vault_root(vault_root)?;
    let normalized_input = rel_path.trim().replace('\\', "/");
    let clean_rel = normalized_input.trim_start_matches('/');
    if clean_rel.is_empty() {
        return Err("Note path cannot be empty".to_string());
    }

    let mut clean_parts = Vec::new();
    for comp in Path::new(clean_rel).components() {
        match comp {
            Component::Normal(seg) => {
                let s = seg.to_string_lossy();
                if s.starts_with('.') {
                    return Err("Hidden vault paths are not accessible".to_string());
                }
                clean_parts.push(seg.to_os_string());
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("Invalid vault relative path".to_string());
            }
        }
    }

    if clean_parts.is_empty() {
        return Err("Invalid vault note path".to_string());
    }

    let mut target = canon_root.clone();
    let mut rel_norm = Vec::with_capacity(clean_parts.len());
    for part in &clean_parts {
        target.push(part);
        rel_norm.push(part.to_string_lossy().to_string());
    }

    let ext_ok = target
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false);
    if !ext_ok {
        return Err("Only .md Markdown notes can be accessed in the vault".to_string());
    }

    if target.exists() {
        let canon_target = fs::canonicalize(&target)
            .map_err(|e| format!("Could not resolve vault note: {}", e))?;
        if !canon_target.starts_with(&canon_root) {
            return Err("Vault note escapes root folder".to_string());
        }
        Ok((canon_target, rel_norm.join("/")))
    } else {
        // Walk ancestors up to existing directory to reject symlinks escaping the vault root
        let mut check = target.parent();
        while let Some(dir) = check {
            if dir.exists() {
                let canon_dir = fs::canonicalize(dir)
                    .map_err(|e| format!("Could not verify vault folder: {}", e))?;
                if !canon_dir.starts_with(&canon_root) {
                    return Err("Vault folder escapes root".to_string());
                }
                break;
            }
            check = dir.parent();
        }
        Ok((target, rel_norm.join("/")))
    }
}

#[tauri::command]
pub async fn vault_choose_folder<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    #[cfg(mobile)]
    {
        let _ = app;
        return Ok(json!({ "ok": false, "canceled": true, "unsupported": true }));
    }

    #[cfg(desktop)]
    {
        let picked = app.dialog().file().blocking_pick_folder();
        match picked {
            Some(folder_path) => {
                let path_buf = folder_path
                    .into_path()
                    .map_err(|e| format!("Invalid vault folder path: {}", e))?;
                let name = path_buf
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("Obsidian Vault")
                    .to_string();
                Ok(json!({
                    "ok": true,
                    "canceled": false,
                    "path": path_buf.to_string_lossy(),
                    "name": name
                }))
            }
            None => Ok(json!({ "ok": false, "canceled": true })),
        }
    }
}

#[tauri::command]
pub async fn vault_list_notes(vault_root: String) -> Result<Vec<VaultNoteEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let canon_root = canonical_vault_root(&vault_root)?;
        let mut notes = Vec::new();

        let walker = WalkDir::new(&canon_root)
            .follow_links(false)
            .max_depth(8)
            .into_iter()
            .filter_entry(|entry| {
                if entry.depth() == 0 {
                    return true;
                }
                !entry
                    .file_name()
                    .to_str()
                    .map(|s| s.starts_with('.'))
                    .unwrap_or(false)
            });

        for entry in walker.flatten() {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let is_md = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("md"))
                .unwrap_or(false);
            if !is_md {
                continue;
            }
            let Ok(rel) = path.strip_prefix(&canon_root) else {
                continue;
            };
            let rel_path = rel.to_string_lossy().replace('\\', "/");
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Untitled")
                .to_string();
            let (modified_ms, size) = entry
                .metadata()
                .map(|m| (modified_ms(&m), m.len()))
                .unwrap_or((0, 0));
            notes.push(VaultNoteEntry {
                rel_path,
                name,
                modified_ms,
                size,
            });
            if notes.len() >= 4000 {
                break;
            }
        }

        notes.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
        Ok(notes)
    })
    .await
    .map_err(|e| format!("Failed listing vault notes: {}", e))?
}

#[tauri::command]
pub async fn vault_read_note(vault_root: String, rel_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (path, rel) = resolve_note_path(&vault_root, &rel_path)?;
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed reading note '{}': {}", rel, e))?;
        let modified = fs::metadata(&path).map(|m| modified_ms(&m)).unwrap_or(0);
        Ok(json!({
            "ok": true,
            "relPath": rel,
            "content": content,
            "modifiedMs": modified
        }))
    })
    .await
    .map_err(|e| format!("Failed reading vault note: {}", e))?
}

#[tauri::command]
pub async fn vault_write_note(
    vault_root: String,
    rel_path: String,
    content: String,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (path, rel) = resolve_note_path(&vault_root, &rel_path)?;
        atomic_write_bytes(&path, content.as_bytes())?;
        let modified = fs::metadata(&path).map(|m| modified_ms(&m)).unwrap_or(0);
        Ok(json!({
            "ok": true,
            "relPath": rel,
            "modifiedMs": modified
        }))
    })
    .await
    .map_err(|e| format!("Failed writing vault note: {}", e))?
}
