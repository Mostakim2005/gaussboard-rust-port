use std::path::{Component, Path, PathBuf};
use tauri::{
    http::{header, Request, Response, StatusCode},
    AppHandle, Manager, Runtime, UriSchemeContext,
};

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

    // Prevent path traversal
    let candidate = Path::new(decoded.as_ref());
    if candidate.components().any(|c| matches!(c, Component::ParentDir | Component::RootDir | Component::Prefix(_))) {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(b"Forbidden path".to_vec())
            .unwrap();
    }

    let base_dir = resolve_src_dir(ctx.app_handle());
    let full_path = base_dir.join(candidate);

    match std::fs::read(&full_path) {
        Ok(bytes) => {
            let mime = match full_path.extension().and_then(|e| e.to_str()) {
                Some("js" | "mjs") => "text/javascript; charset=utf-8".to_string(),
                Some("html") => "text/html; charset=utf-8".to_string(),
                Some("css") => "text/css; charset=utf-8".to_string(),
                Some("json") => "application/json; charset=utf-8".to_string(),
                Some("svg") => "image/svg+xml".to_string(),
                Some("wasm") => "application/wasm".to_string(),
                _ => mime_guess::from_path(&full_path)
                    .first_or_octet_stream()
                    .to_string(),
            };

            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .header(header::CACHE_CONTROL, "no-cache")
                .body(bytes)
                .unwrap()
        }
        Err(_) => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(b"Not Found".to_vec())
            .unwrap(),
    }
}

fn resolve_src_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src")
    } else {
        app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."))
    }
}
