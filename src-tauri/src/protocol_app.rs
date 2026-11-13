// src-tauri/src/protocol_app.rs
// Zero-failure custom protocol handler for app://board/
// Embeds all frontend assets directly into the binary at compile time via `include_dir`,
// guaranteeing 100% standalone execution for portable single-EXE and installer releases.

use include_dir::{include_dir, Dir};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use tauri::{
    http::{header, Method, Request, Response, StatusCode},
    Manager, Runtime, UriSchemeContext,
};

static EMBEDDED_SRC: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../src");

const MAX_RANGE_CHUNK: u64 = 4 * 1024 * 1024; // 4 MB max per 206 range slice

fn asset_mime_from_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "webm" => "audio/webm",
        "ogg" => "audio/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        _ => "application/octet-stream",
    }
}

pub fn handle_asset_stream(
    state: &crate::state::AppState,
    raw_id: &str,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if *request.method() == Method::OPTIONS {
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range")
            .header(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                "Accept-Ranges, Content-Range, Content-Length",
            )
            .body(Vec::new())
            .unwrap();
    }

    let decoded = percent_encoding::percent_decode_str(raw_id).decode_utf8_lossy();
    let clean_id = decoded.trim();
    if clean_id.is_empty()
        || clean_id.contains("..")
        || clean_id.contains('/')
        || clean_id.contains('\\')
    {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(b"Invalid asset ID".to_vec())
            .unwrap();
    }

    let assets_dir = state.assets_dir();
    let direct_path = assets_dir.join(clean_id);
    let file_path = if direct_path.is_file() {
        direct_path
    } else if let Some(resolved) = crate::assets::resolve_asset_path(&assets_dir, clean_id) {
        resolved
    } else {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(b"Asset Not Found".to_vec())
            .unwrap();
    };

    let mut file = match std::fs::File::open(&file_path) {
        Ok(f) => f,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(b"Asset Not Found".to_vec())
                .unwrap();
        }
    };

    let total_len = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => {
            return Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(b"Metadata error".to_vec())
                .unwrap();
        }
    };

    let mime = asset_mime_from_path(&file_path);

    if *request.method() == Method::HEAD {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_LENGTH, total_len.to_string())
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(
                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                "Accept-Ranges, Content-Range, Content-Length",
            )
            .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
            .body(Vec::new())
            .unwrap();
    }

    if let Some(range_val) = request.headers().get(header::RANGE) {
        if let Ok(range_str) = range_val.to_str() {
            if let Some(spec) = range_str.trim().strip_prefix("bytes=") {
                let first_range = spec.split(',').next().unwrap_or("").trim();
                let parsed_bounds: Option<(u64, u64)> =
                    if let Some((start_s, end_s)) = first_range.split_once('-') {
                        let start_s = start_s.trim();
                        let end_s = end_s.trim();
                        if start_s.is_empty() {
                            // Suffix range: bytes=-N
                            if let Ok(suffix_len) = end_s.parse::<u64>() {
                                if suffix_len > 0 && total_len > 0 {
                                    let s = total_len.saturating_sub(suffix_len);
                                    Some((s, total_len - 1))
                                } else {
                                    None
                                }
                            } else {
                                None
                            }
                        } else if let Ok(s) = start_s.parse::<u64>() {
                            if end_s.is_empty() {
                                if s < total_len {
                                    let e = (s + MAX_RANGE_CHUNK - 1).min(total_len - 1);
                                    Some((s, e))
                                } else {
                                    Some((s, total_len.saturating_sub(1)))
                                }
                            } else if let Ok(e) = end_s.parse::<u64>() {
                                Some((s, e.min(total_len.saturating_sub(1))))
                            } else {
                                None
                            }
                        } else {
                            None
                        }
                    } else {
                        None
                    };

                match parsed_bounds {
                    Some((start, raw_end))
                        if total_len > 0 && start < total_len && start <= raw_end =>
                    {
                        let end = raw_end
                            .min(start + MAX_RANGE_CHUNK - 1)
                            .min(total_len - 1);
                        let chunk_len = (end - start + 1) as usize;
                        if file.seek(SeekFrom::Start(start)).is_err() {
                            return Response::builder()
                                .status(StatusCode::INTERNAL_SERVER_ERROR)
                                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                                .body(b"Seek error".to_vec())
                                .unwrap();
                        }
                        let mut buf = vec![0u8; chunk_len];
                        if file.read_exact(&mut buf).is_err() {
                            return Response::builder()
                                .status(StatusCode::INTERNAL_SERVER_ERROR)
                                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                                .body(b"Read error".to_vec())
                                .unwrap();
                        }
                        return Response::builder()
                            .status(StatusCode::PARTIAL_CONTENT)
                            .header(header::CONTENT_TYPE, mime)
                            .header(header::ACCEPT_RANGES, "bytes")
                            .header(
                                header::CONTENT_RANGE,
                                format!("bytes {}-{}/{}", start, end, total_len),
                            )
                            .header(header::CONTENT_LENGTH, chunk_len.to_string())
                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                            .header(
                                header::ACCESS_CONTROL_EXPOSE_HEADERS,
                                "Accept-Ranges, Content-Range, Content-Length",
                            )
                            .header(
                                header::CACHE_CONTROL,
                                "public, max-age=31536000, immutable",
                            )
                            .body(buf)
                            .unwrap();
                    }
                    _ => {
                        return Response::builder()
                            .status(StatusCode::RANGE_NOT_SATISFIABLE)
                            .header(header::CONTENT_RANGE, format!("bytes */{}", total_len))
                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                            .body(Vec::new())
                            .unwrap();
                    }
                }
            }
        }
    }

    let mut bytes = Vec::with_capacity(total_len as usize);
    if file.read_to_end(&mut bytes).is_err() {
        return Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(b"Read error".to_vec())
            .unwrap();
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "Accept-Ranges, Content-Range, Content-Length",
        )
        .header(header::CACHE_CONTROL, "public, max-age=31536000, immutable")
        .body(bytes)
        .unwrap()
}

pub fn handle_app_protocol<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    req: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let uri = req.uri();
    let host = uri.host().unwrap_or("");
    let raw_path = uri.path();

    // Support both app://board/foo.js and app://localhost/board/foo.js
    let rel_path = if host.eq_ignore_ascii_case("board") {
        raw_path.trim_start_matches('/')
    } else {
        raw_path.trim_start_matches('/').trim_start_matches("board/")
    };

    let rel_path = if rel_path.is_empty() { "index.html" } else { rel_path };
    let decoded = percent_encoding::percent_decode_str(rel_path).decode_utf8_lossy();
    let norm_path = decoded.trim_start_matches('/').replace('\\', "/");

    // Prevent path traversal
    let candidate = Path::new(&norm_path);
    if candidate.components().any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_))) {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(b"Forbidden path".to_vec())
            .unwrap();
    }

    // 1. Dynamic User Assets (e.g. app://board/__asset/<asset_id> or app://board/asset/<asset_id>)
    if let Some(raw_id) = norm_path
        .strip_prefix("__asset/")
        .or_else(|| norm_path.strip_prefix("asset/"))
    {
        if let Some(state) = ctx
            .app_handle()
            .try_state::<std::sync::Arc<crate::state::AppState>>()
        {
            return handle_asset_stream(&state, raw_id, &req);
        }
    }

    // 2. Debug Hot-Reload (if running in dev and file exists on disk)
    #[cfg(debug_assertions)]
    {
        let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src").join(candidate);
        if dev_path.is_file() {
            if let Ok(bytes) = std::fs::read(&dev_path) {
                let mime = guess_mime(&norm_path);
                return Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, mime)
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .header(header::CACHE_CONTROL, "no-cache")
                    .body(bytes)
                    .unwrap();
            }
        }
    }

    // 3. Embedded Static Assets (Compiled directly into the binary - guaranteed offline)
    if let Some(file) = EMBEDDED_SRC.get_file(&norm_path) {
        let bytes = file.contents();
        let mime = guess_mime(&norm_path);
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(bytes.to_vec())
            .unwrap();
    }

    // 4. Installed Resources Directory Fallback (NSIS / MSI installations)
    if let Ok(res_dir) = ctx.app_handle().path().resource_dir() {
        let res_path = res_dir.join(candidate);
        if res_path.is_file() {
            if let Ok(bytes) = std::fs::read(&res_path) {
                let mime = guess_mime(&norm_path);
                return Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, mime)
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .header(header::CACHE_CONTROL, "no-cache")
                    .body(bytes)
                    .unwrap();
            }
        }
    }

    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .body(b"Not Found".to_vec())
        .unwrap()
}

fn guess_mime(path_str: &str) -> String {
    let p = Path::new(path_str);
    match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "js" | "mjs" => "text/javascript; charset=utf-8".to_string(),
        "html" => "text/html; charset=utf-8".to_string(),
        "css" => "text/css; charset=utf-8".to_string(),
        "json" => "application/json; charset=utf-8".to_string(),
        "svg" => "image/svg+xml".to_string(),
        "png" => "image/png".to_string(),
        "jpg" | "jpeg" => "image/jpeg".to_string(),
        "ico" => "image/x-icon".to_string(),
        "webp" => "image/webp".to_string(),
        "wasm" => "application/wasm".to_string(),
        "woff" => "font/woff".to_string(),
        "woff2" => "font/woff2".to_string(),
        "ttf" => "font/ttf".to_string(),
        "webmanifest" => "application/manifest+json".to_string(),
        _ => mime_guess::from_path(p)
            .first_or_octet_stream()
            .to_string(),
    }
}
