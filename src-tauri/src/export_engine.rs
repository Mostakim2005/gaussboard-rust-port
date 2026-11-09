// src-tauri/src/export_engine.rs
// High-DPI 16K PNG Tiled Export Engine using tiny-skia and streaming png encoder.
// Solves memory crashes by using horizontal strip tiling (constant ~32 MB RAM).

use png::{ColorType, Encoder};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufWriter, Write};
use tiny_skia::{Color, Paint, PathBuilder, Pixmap, Stroke, Transform};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ExportStroke {
    pub min_y: f32,
    pub max_y: f32,
    pub points: Vec<(f32, f32)>,
    pub rgba: [u8; 4],
    pub width: f32,
}

pub fn export_16k_png_streamed(
    output_path: &str,
    full_width: u32,
    full_height: u32,
    scale: f32,
    strokes: &[ExportStroke],
) -> Result<(), String> {
    let strip_height: u32 = 512;
    let file = File::create(output_path).map_err(|e| format!("Failed creating file: {}", e))?;
    let w = BufWriter::new(file);

    let mut encoder = Encoder::new(w, full_width, full_height);
    encoder.set_color(ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| format!("PNG header error: {}", e))?;
    let mut stream = writer.stream_writer().map_err(|e| format!("PNG stream error: {}", e))?;

    // Single reusable 32 MB buffer for 16384 x 512 strip
    let mut strip_pixmap = Pixmap::new(full_width, strip_height)
        .ok_or_else(|| "Failed to allocate 32MB strip pixmap buffer".to_string())?;

    let mut y_offset: u32 = 0;
    while y_offset < full_height {
        let current_h = (full_height - y_offset).min(strip_height);
        strip_pixmap.fill(Color::WHITE);

        let world_y_min = (y_offset as f32) / scale;
        let world_y_max = ((y_offset + current_h) as f32) / scale;

        // Shift global coordinates up by y_offset so only the current strip lands in [0, 512]
        let transform = Transform::from_scale(scale, scale)
            .post_translate(0.0, -(y_offset as f32));

        for s in strokes {
            // Fast Y-axis AABB culling: skip strokes outside this horizontal strip
            if s.max_y < world_y_min || s.min_y > world_y_max || s.points.len() < 2 {
                continue;
            }
            let mut pb = PathBuilder::new();
            pb.move_to(s.points[0].0, s.points[0].1);
            for &(x, y) in &s.points[1..] {
                pb.line_to(x, y);
            }
            if let Some(path) = pb.finish() {
                let mut paint = Paint::default();
                paint.set_color_rgba8(s.rgba[0], s.rgba[1], s.rgba[2], s.rgba[3]);
                paint.anti_alias = true;
                let stroke_style = Stroke {
                    width: s.width,
                    ..Default::default()
                };
                strip_pixmap.stroke_path(&path, &paint, &stroke_style, transform, None);
            }
        }

        // Write only the valid scanlines for the current strip (handles bottom remainder strip)
        let bytes_to_write = (full_width * current_h * 4) as usize;
        stream
            .write_all(&strip_pixmap.data()[..bytes_to_write])
            .map_err(|e| format!("PNG write scanlines failed: {}", e))?;

        y_offset += current_h;
    }

    stream.finish().map_err(|e| format!("PNG finish failed: {}", e))
}

#[tauri::command]
pub async fn export_board_high_res_png(
    output_path: String,
    full_width: u32,
    full_height: u32,
    scale: f32,
    strokes: Vec<ExportStroke>,
) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        export_16k_png_streamed(&output_path, full_width, full_height, scale, &strokes)
            .map(|_| true)
    })
    .await
    .map_err(|e| format!("Export task execution failed: {}", e))?
}
