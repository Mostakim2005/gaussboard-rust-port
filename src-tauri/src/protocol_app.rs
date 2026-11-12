// src-tauri/src/protocol_app.rs
// Zero-failure custom protocol handler for app://board/
// Embeds all frontend assets directly into the binary at compile time via `include_dir`,
// guaranteeing 100% standalone execution for portable single-EXE and installer releases.

use include_dir::{include_dir, Dir};
use std::path::{Component, Path, PathBuf};
use tauri::{
    http::{header, Request, Response, StatusCode},
    AppHandle, Manager, Runtime, UriSchemeContext,
};

static EMBEDDED_SRC: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../src");

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

    // 1. Dynamic User Assets (e.g. app://board/asset/<asset_id>)
    if norm_path.starts_with("asset/") {
        let asset_id = norm_path.trim_start_matches("asset/");
        if let Some(state) = ctx.app_handle().try_state::<std::sync::Arc<crate::state::AppState>>() {
            let assets_dir = state.assets_dir();
            if let Some(path) = crate::assets::resolve_asset_path(&assets_dir, asset_id) {
                if let Ok(bytes) = std::fs::read(&path) {
                    let mime = mime_guess::from_path(&path)
                        .first_or_octet_stream()
                        .to_string();
                    return Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, mime)
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                        .header(header::CACHE_CONTROL, "public, max-age=31536000")
                        .body(bytes)
                        .unwrap();
                }
            }
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
