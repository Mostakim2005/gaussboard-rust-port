// src-tauri/src/bundle.rs
use crate::state::AppState;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Cursor, Read, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

fn is_safe_asset_id(id: &str) -> bool {
    let trimmed = id.trim();
    !trimmed.is_empty()
        && !trimmed.contains("..")
        && !trimmed.contains('/')
        && !trimmed.contains('\\')
}

pub fn is_already_compressed_ext(name: &str) -> bool {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "pdf" | "png" | "jpg" | "jpeg" | "webp" | "webm" | "ogg" | "mp3" | "m4a"
    )
}

pub fn collect_external_asset_ids(board_json: &Value) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();

    if let Some(tracks) = board_json.get("audioTracks").and_then(|v| v.as_array()) {
        for track in tracks {
            if let Some(asset_id) = track.get("assetId").and_then(|v| v.as_str()) {
                let trimmed = asset_id.trim();
                if is_safe_asset_id(trimmed) {
                    ids.insert(trimmed.to_string());
                }
            }
        }
    }

    if let Some(objects) = board_json.get("objects").and_then(|v| v.as_array()) {
        for obj in objects {
            let is_pdf_page = obj.get("type").and_then(|v| v.as_str()) == Some("pdf-page");
            if is_pdf_page || obj.get("assetId").is_some() {
                if let Some(asset_id) = obj.get("assetId").and_then(|v| v.as_str()) {
                    let trimmed = asset_id.trim();
                    if is_safe_asset_id(trimmed) {
                        ids.insert(trimmed.to_string());
                    }
                }
            }
        }
    }

    ids
}

pub fn export_gaussboard_to_bytes(
    state: &AppState,
    board_json: &Value,
    extra_assets: &[String],
) -> Result<Vec<u8>, String> {
    let mut asset_ids = collect_external_asset_ids(board_json);
    for extra in extra_assets {
        let trimmed = extra.trim();
        if is_safe_asset_id(trimmed) {
            asset_ids.insert(trimmed.to_string());
        }
    }

    let cursor = Cursor::new(Vec::new());
    let mut zip = ZipWriter::new(cursor);

    let deflated_opts = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let stored_opts = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .unix_permissions(0o644);

    let board_bytes = serde_json::to_vec(board_json)
        .map_err(|e| format!("Failed to serialize board.json: {}", e))?;
    zip.start_file("board.json", deflated_opts)
        .map_err(|e| format!("Failed starting board.json entry: {}", e))?;
    zip.write_all(&board_bytes)
        .map_err(|e| format!("Failed writing board.json entry: {}", e))?;

    let assets_dir = state.assets_dir();
    let mut copy_buf = [0u8; 64 * 1024];

    for raw_id in asset_ids {
        if !is_safe_asset_id(&raw_id) {
            continue;
        }
        let direct = assets_dir.join(&raw_id);
        let resolved_path = if direct.is_file() {
            Some(direct)
        } else {
            crate::assets::resolve_asset_path(&assets_dir, &raw_id)
        };

        let Some(file_path) = resolved_path else {
            continue;
        };

        let safe_name = raw_id.trim();
        let entry_name = format!("assets/{}", safe_name);
        let opts = if is_already_compressed_ext(safe_name) {
            stored_opts
        } else {
            deflated_opts
        };

        let mut f = match File::open(&file_path) {
            Ok(f) => f,
            Err(_) => continue,
        };

        zip.start_file(&entry_name, opts)
            .map_err(|e| format!("Failed starting asset entry {}: {}", entry_name, e))?;
        loop {
            let n = f
                .read(&mut copy_buf)
                .map_err(|e| format!("Failed reading asset {}: {}", safe_name, e))?;
            if n == 0 {
                break;
            }
            zip.write_all(&copy_buf[..n])
                .map_err(|e| format!("Failed writing asset {}: {}", safe_name, e))?;
        }
    }

    let cursor = zip
        .finish()
        .map_err(|e| format!("Failed finalizing .gaussboard archive: {}", e))?;
    Ok(cursor.into_inner())
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct BundleExportResult {
    pub archive_path: String,
    pub total_bytes: u64,
    pub sha256: String,
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct BundleImportResult {
    pub extracted_dir: String,
    pub files_count: usize,
    pub sha256: String,
}

#[tauri::command]
pub async fn bundle_export(
    source_dir: String,
    dest_zip_path: String,
    use_zstd: Option<bool>,
) -> Result<BundleExportResult, String> {
    tokio::task::spawn_blocking(move || {
        let src_path = Path::new(&source_dir);
        if !src_path.exists() {
            return Err(format!("Source directory does not exist: {}", source_dir));
        }

        let out_file = File::create(&dest_zip_path)
            .map_err(|e| format!("Failed to create destination file: {}", e))?;
        let buf_writer = BufWriter::with_capacity(128 * 1024, out_file);

        let compression = if use_zstd.unwrap_or(false) {
            CompressionMethod::Zstd
        } else {
            CompressionMethod::Deflated
        };

        let file_options = SimpleFileOptions::default()
            .compression_method(compression)
            .unix_permissions(0o644);
        let stored_options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .unix_permissions(0o644);

        let mut zip = ZipWriter::new(buf_writer);

        for entry in walkdir::WalkDir::new(src_path).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path();
            let relative = path
                .strip_prefix(src_path)
                .map_err(|e| format!("Failed to compute relative path: {}", e))?;
            let name = relative.to_string_lossy().replace('\\', "/");

            if name.is_empty() {
                continue;
            }

            if path.is_file() {
                let entry_opts = if is_already_compressed_ext(&name) {
                    stored_options
                } else {
                    file_options
                };
                zip.start_file(&name, entry_opts)
                    .map_err(|e| format!("Failed to start zip file entry {}: {}", name, e))?;
                let mut f = File::open(path)
                    .map_err(|e| format!("Failed to open file {}: {}", path.display(), e))?;
                let mut buf = [0u8; 64 * 1024];
                loop {
                    let n = f
                        .read(&mut buf)
                        .map_err(|e| format!("Failed to read chunk from {}: {}", path.display(), e))?;
                    if n == 0 {
                        break;
                    }
                    zip.write_all(&buf[..n])
                        .map_err(|e| format!("Failed to write chunk to zip: {}", e))?;
                }
            } else if path.is_dir() {
                zip.add_directory(&name, file_options)
                    .map_err(|e| format!("Failed to add directory entry {}: {}", name, e))?;
            }
        }

        let mut finished_writer = zip
            .finish()
            .map_err(|e| format!("Failed to finalize zip archive: {}", e))?;
        finished_writer
            .flush()
            .map_err(|e| format!("Failed to flush zip archive: {}", e))?;
        drop(finished_writer);

        // Calculate cryptographic SHA-256 and total bytes of the verified archive
        let mut check_file = File::open(&dest_zip_path)
            .map_err(|e| format!("Failed to open generated archive for verification: {}", e))?;
        let total_bytes = check_file
            .metadata()
            .map(|m| m.len())
            .unwrap_or(0);
        let mut hasher = Sha256::new();
        let mut check_buf = [0u8; 64 * 1024];
        loop {
            let n = check_file
                .read(&mut check_buf)
                .map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            hasher.update(&check_buf[..n]);
        }
        let hash = hex::encode(hasher.finalize());

        Ok(BundleExportResult {
            archive_path: dest_zip_path,
            total_bytes,
            sha256: hash,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn bundle_import(archive_path: String, target_dir: String) -> Result<BundleImportResult, String> {
    tokio::task::spawn_blocking(move || {
        let file = File::open(&archive_path)
            .map_err(|e| format!("Failed to open archive {}: {}", archive_path, e))?;
        
        let mut hasher = Sha256::new();
        let mut f_read = File::open(&archive_path)
            .map_err(|e| format!("Failed to open archive for hashing: {}", e))?;
        let mut hash_buf = [0u8; 64 * 1024];
        loop {
            let n = f_read.read(&mut hash_buf).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            hasher.update(&hash_buf[..n]);
        }
        let sha256_hash = hex::encode(hasher.finalize());

        let mut archive = ZipArchive::new(BufReader::new(file))
            .map_err(|e| format!("Failed to read zip archive: {}", e))?;
        let out_base = PathBuf::from(&target_dir);
        let mut files_count = 0;

        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| format!("Failed to read entry #{}: {}", i, e))?;

            // ZipSlip prevention: ensure the target path is strictly within out_base
            let sanitized_path = match file.enclosed_name() {
                Some(p) => out_base.join(p),
                None => {
                    return Err(format!(
                        "Security error: malicious ZipSlip path detected in archive: {}",
                        file.name()
                    ))
                }
            };

            if file.is_dir() {
                std::fs::create_dir_all(&sanitized_path)
                    .map_err(|e| format!("Failed to create directory {}: {}", sanitized_path.display(), e))?;
            } else {
                if let Some(parent) = sanitized_path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create parent dir: {}", e))?;
                }
                let mut outfile = File::create(&sanitized_path)
                    .map_err(|e| format!("Failed to create target file {}: {}", sanitized_path.display(), e))?;
                io::copy(&mut file, &mut outfile)
                    .map_err(|e| format!("Failed to extract file contents: {}", e))?;
                files_count += 1;
            }
        }

        Ok(BundleImportResult {
            extracted_dir: target_dir,
            files_count,
            sha256: sha256_hash,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
