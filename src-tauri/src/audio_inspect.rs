// src-tauri/src/audio_inspect.rs
use std::fs::File;
use std::path::Path;
use symphonia::core::codecs::CODEC_TYPE_NULL;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct AudioMetadataResult {
    pub duration_ms: Option<u64>,
    pub sample_rate: u32,
    pub channels: u32,
    pub codec: String,
    pub is_finite: bool,
}

#[tauri::command]
pub async fn audio_inspect(file_path: String) -> Result<AudioMetadataResult, String> {
    tokio::task::spawn_blocking(move || {
        let path = Path::new(&file_path);
        if !path.exists() {
            return Err(format!("Audio file does not exist: {}", file_path));
        }

        let file = File::open(path).map_err(|e| format!("Cannot open audio file: {e}"))?;
        let mss = MediaSourceStream::new(Box::new(file), Default::default());

        let mut hint = Hint::new();
        if let Some(ext) = path.extension().and_then(|s| s.to_str()) {
            hint.with_extension(ext);
        }

        let probed = symphonia::default::get_probe()
            .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
            .map_err(|e| format!("Audio format probe failed: {e}"))?;

        let format = probed.format;
        let track = format
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or_else(|| "No supported audio track found in file".to_string())?;

        let params = &track.codec_params;
        let sample_rate = params.sample_rate.unwrap_or(44100);
        let channels = params.channels.map(|c| c.count() as u32).unwrap_or(2);

        let (duration_ms, is_finite) = if let Some(n_frames) = params.n_frames {
            let ms = (n_frames as f64 / sample_rate as f64 * 1000.0).round() as u64;
            (Some(ms), true)
        } else {
            (None, false) // VBR or streaming container without header frame counts (TRAP 3 safe)
        };

        Ok(AudioMetadataResult {
            duration_ms,
            sample_rate,
            channels,
            codec: format!("{:?}", params.codec),
            is_finite,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
