// src-tauri/src/colorimetry.rs
use palette::{
    color_difference::Wcag21RelativeContrast,
    FromColor, Mix, Oklch, Srgb,
};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct ContrastReport {
    pub ratio: f32,
    pub wcag_aa_normal: bool,
    pub wcag_aa_large: bool,
    pub wcag_aaa_normal: bool,
    pub wcag_aaa_large: bool,
    pub wcag_graphics: bool,
}

fn parse_hex_color(hex: &str) -> Result<Srgb<f32>, String> {
    let clean = hex.trim().trim_start_matches('#');
    let val = u32::from_str_radix(clean, 16).map_err(|e| format!("Invalid hex color '{}': {}", hex, e))?;
    let (r, g, b) = match clean.len() {
        6 => ((val >> 16) as u8, ((val >> 8) & 0xff) as u8, (val & 0xff) as u8),
        3 => (
            (((val >> 8) & 0xf) * 17) as u8,
            (((val >> 4) & 0xf) * 17) as u8,
            ((val & 0xf) * 17) as u8,
        ),
        _ => return Err(format!("Expected 3 or 6 hex digits, got '{}'", hex)),
    };
    Ok(Srgb::new(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0))
}

fn srgb_to_hex(srgb: Srgb<f32>) -> String {
    let clamped = srgb.clamp();
    let r = (clamped.red * 255.0).round() as u8;
    let g = (clamped.green * 255.0).round() as u8;
    let b = (clamped.blue * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", r, g, b)
}

#[tauri::command]
pub fn color_wcag_contrast(foreground_hex: String, background_hex: String) -> Result<ContrastReport, String> {
    let fg = parse_hex_color(&foreground_hex)?;
    let bg = parse_hex_color(&background_hex)?;

    Ok(ContrastReport {
        ratio: fg.relative_contrast(bg),
        wcag_aa_normal: fg.has_min_contrast_text(bg),
        wcag_aa_large: fg.has_min_contrast_large_text(bg),
        wcag_aaa_normal: fg.has_enhanced_contrast_text(bg),
        wcag_aaa_large: fg.has_enhanced_contrast_large_text(bg),
        wcag_graphics: fg.has_min_contrast_graphics(bg),
    })
}

#[tauri::command]
pub fn color_oklch_mix(color_a_hex: String, color_b_hex: String, factor: f32) -> Result<String, String> {
    let a_srgb = parse_hex_color(&color_a_hex)?;
    let b_srgb = parse_hex_color(&color_b_hex)?;

    let a_oklch = Oklch::from_color(a_srgb);
    let b_oklch = Oklch::from_color(b_srgb);

    let mixed_oklch = a_oklch.mix(b_oklch, factor.clamp(0.0, 1.0));
    let result_srgb: Srgb<f32> = Srgb::from_color(mixed_oklch);

    Ok(srgb_to_hex(result_srgb))
}

#[tauri::command]
pub fn color_invert_theme_ink(color_hex: String, target_bg_hex: String, is_dark_target: bool) -> Result<String, String> {
    let ink_srgb = parse_hex_color(&color_hex)?;
    let bg_srgb = parse_hex_color(&target_bg_hex)?;

    // If the color already satisfies WCAG AA (>= 4.5:1), preserve it untouched
    if ink_srgb.has_min_contrast_text(bg_srgb) {
        return Ok(srgb_to_hex(ink_srgb));
    }

    let mut oklch = Oklch::from_color(ink_srgb);

    if is_dark_target {
        // Target canvas is dark: lift lightness while keeping identical Hue & Chroma
        oklch.l = (1.0 - (oklch.l * 0.65)).clamp(0.68, 0.94);
    } else {
        // Target canvas is light: darken lightness while keeping identical Hue & Chroma
        oklch.l = (oklch.l * 0.45).clamp(0.12, 0.38);
    }

    let inverted_srgb: Srgb<f32> = Srgb::from_color(oklch);
    Ok(srgb_to_hex(inverted_srgb))
}
