// src-tauri/src/clipboard.rs
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Cursor;
use std::sync::Arc;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::state::AppState;

trait IntoBufSize {
    fn into_buf_size(self) -> Option<usize>;
}

impl IntoBufSize for usize {
    fn into_buf_size(self) -> Option<usize> {
        Some(self)
    }
}

impl IntoBufSize for Option<usize> {
    fn into_buf_size(self) -> Option<usize> {
        self
    }
}

fn compute_text_sig(text: &str) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    let digest = Sha256::digest(text.as_bytes());
    Some(hex::encode(&digest[..12]))
}

fn compute_image_sig(width: u32, height: u32, rgba: &[u8]) -> Option<String> {
    if width == 0 || height == 0 || rgba.is_empty() {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(width.to_le_bytes());
    hasher.update(height.to_le_bytes());
    hasher.update(rgba);
    let digest = hasher.finalize();
    Some(format!(
        "img:{}x{}:{}",
        width,
        height,
        hex::encode(&digest[..12])
    ))
}

fn decode_png_data_url_to_rgba(data_url: &str) -> Result<(u32, u32, Vec<u8>), String> {
    let b64 = if let Some(rest) = data_url.strip_prefix("data:") {
        rest.split_once(";base64,")
            .map(|(_, data)| data)
            .ok_or_else(|| "Unsupported clipboard image data URL encoding".to_string())?
    } else {
        data_url
    };
    let png_bytes = BASE64
        .decode(b64.trim())
        .map_err(|e| format!("Invalid clipboard image base64: {}", e))?;
    let mut decoder = png::Decoder::new(Cursor::new(&png_bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|e| format!("PNG header decode error: {}", e))?;
    let buf_size = IntoBufSize::into_buf_size(reader.output_buffer_size())
        .ok_or_else(|| "PNG frame size overflow".to_string())?;
    if buf_size > 128 * 1024 * 1024 {
        return Err("Clipboard PNG image exceeds 128 MB decoded limit".to_string());
    }
    let mut buf = vec![0u8; buf_size];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| format!("PNG frame decode error: {}", e))?;
    let raw = &buf[..info.buffer_size()];
    let w = info.width;
    let h = info.height;
    let px_count = (w as usize)
        .checked_mul(h as usize)
        .ok_or_else(|| "Clipboard image dimensions overflow".to_string())?;
    let mut rgba = Vec::with_capacity(px_count.saturating_mul(4));
    match info.color_type {
        png::ColorType::Rgba => {
            rgba.extend_from_slice(&raw[..px_count.saturating_mul(4).min(raw.len())]);
        }
        png::ColorType::Rgb => {
            for chunk in raw.chunks_exact(3).take(px_count) {
                rgba.extend_from_slice(&[chunk[0], chunk[1], chunk[2], 255]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            for chunk in raw.chunks_exact(2).take(px_count) {
                rgba.extend_from_slice(&[chunk[0], chunk[0], chunk[0], chunk[1]]);
            }
        }
        png::ColorType::Grayscale => {
            for &g in raw.iter().take(px_count) {
                rgba.extend_from_slice(&[g, g, g, 255]);
            }
        }
        other => {
            return Err(format!("Unsupported decoded PNG color type: {:?}", other));
        }
    }
    Ok((w, h, rgba))
}

fn encode_rgba_to_png_data_url(width: u32, height: u32, rgba: &[u8]) -> Result<String, String> {
    if width == 0 || height == 0 || rgba.is_empty() {
        return Err("Empty clipboard image".to_string());
    }
    let expected = (width as usize)
        .saturating_mul(height as usize)
        .saturating_mul(4);
    if rgba.len() < expected {
        return Err("Incomplete RGBA clipboard image buffer".to_string());
    }
    let mut png_bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|e| format!("PNG header encode error: {}", e))?;
        writer
            .write_image_data(&rgba[..expected])
            .map_err(|e| format!("PNG frame encode error: {}", e))?;
    }
    Ok(format!("data:image/png;base64,{}", BASE64.encode(&png_bytes)))
}

#[tauri::command]
pub async fn clipboard_read<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    let text = app.clipboard().read_text().ok().unwrap_or_default();
    let mut image_url: Option<String> = None;
    let mut sig = compute_text_sig(&text);

    if let Ok(img) = app.clipboard().read_image() {
        let w = img.width();
        let h = img.height();
        let rgba = img.rgba();
        if w > 0 && h > 0 && !rgba.is_empty() {
            if let Ok(data_url) = encode_rgba_to_png_data_url(w, h, rgba) {
                image_url = Some(data_url);
                if sig.is_none() {
                    sig = compute_image_sig(w, h, rgba);
                }
            }
        }
    }

    if sig.is_some() {
        *state.last_clipboard_sig.write() = sig.clone();
    }

    Ok(json!({
        "text": text,
        "html": null,
        "image": image_url,
        "signature": sig
    }))
}

#[tauri::command]
pub async fn clipboard_write<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<AppState>>,
    payload: Value,
) -> Result<Value, String> {
    let image_str = payload
        .get("image")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let text_str = payload.get("text").and_then(|v| v.as_str());

    let mut sig: Option<String> = None;

    if let Some(img_data) = image_str {
        let (w, h, rgba) = decode_png_data_url_to_rgba(img_data)?;
        sig = compute_image_sig(w, h, &rgba);
        let img = tauri::image::Image::new(&rgba, w, h);
        app.clipboard()
            .write_image(&img)
            .map_err(|e| format!("Clipboard write_image failed: {}", e))?;
    } else if let Some(text) = text_str {
        sig = compute_text_sig(text);
        app.clipboard()
            .write_text(text.to_string())
            .map_err(|e| format!("Clipboard write_text failed: {}", e))?;
    } else {
        let _ = app.clipboard().write_text(String::new());
    }

    *state.last_clipboard_sig.write() = sig.clone();
    Ok(json!({ "ok": true, "signature": sig }))
}

#[tauri::command]
pub async fn clipboard_signature<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, Arc<AppState>>,
) -> Result<Option<String>, String> {
    if let Ok(text) = app.clipboard().read_text() {
        if !text.is_empty() {
            let sig = compute_text_sig(&text);
            *state.last_clipboard_sig.write() = sig.clone();
            return Ok(sig);
        }
    }
    if let Ok(img) = app.clipboard().read_image() {
        let w = img.width();
        let h = img.height();
        let rgba = img.rgba();
        if w > 0 && h > 0 && !rgba.is_empty() {
            let sig = compute_image_sig(w, h, rgba);
            *state.last_clipboard_sig.write() = sig.clone();
            return Ok(sig);
        }
    }
    Ok(state.last_clipboard_sig.read().clone())
}
