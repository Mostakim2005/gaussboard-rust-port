// src-tauri/src/audio_dsp.rs
// Pure-Rust Audio DSP Pipeline: Neural noise suppression via nnnoiseless (safe RNNoise port)
// and 3:1 decimation (48 kHz -> 16 kHz) for offline speech recognition.

use nnnoiseless::DenoiseState;

pub struct LectureAudioPipeline {
    denoiser: Box<DenoiseState<'static>>,
    input_ring: Vec<f32>,
    in_frame_48k: [f32; DenoiseState::FRAME_SIZE],  // Strictly 480 samples
    out_frame_48k: [f32; DenoiseState::FRAME_SIZE], // Strictly 480 samples
    stt_buffer_16k: Vec<f32>,
}

impl Default for LectureAudioPipeline {
    fn default() -> Self {
        Self::new()
    }
}

impl LectureAudioPipeline {
    pub fn new() -> Self {
        Self {
            denoiser: DenoiseState::new(),
            input_ring: Vec::with_capacity(4800),
            in_frame_48k: [0.0; DenoiseState::FRAME_SIZE],
            out_frame_48k: [0.0; DenoiseState::FRAME_SIZE],
            stt_buffer_16k: Vec::with_capacity(16000 * 5),
        }
    }

    /// Accepts normalized [-1.0, 1.0] 48kHz PCM, returns denoised 48kHz PCM for disk/playback
    /// and appends 16kHz PCM for background speech transcription.
    pub fn process_chunk(&mut self, raw_48k_normalized: &[f32]) -> Vec<f32> {
        self.input_ring.extend_from_slice(raw_48k_normalized);
        let mut clean_48k_out = Vec::with_capacity(raw_48k_normalized.len());

        while self.input_ring.len() >= DenoiseState::FRAME_SIZE {
            // 1. Scale [-1.0, 1.0] -> [-32768.0, 32767.0] required by neural RNNoise weights
            for (i, &sample) in self.input_ring[..DenoiseState::FRAME_SIZE].iter().enumerate() {
                self.in_frame_48k[i] = (sample * 32767.0).clamp(-32768.0, 32767.0);
            }
            self.input_ring.drain(..DenoiseState::FRAME_SIZE);

            // 2. Run neural noise suppression (removes HVAC hum and pen-on-glass clicks)
            let _vad_prob = self.denoiser.process_frame(&mut self.out_frame_48k, &self.in_frame_48k);

            // 3. Scale back to [-1.0, 1.0] and decimate 3:1 (48kHz -> 16kHz) with 3-tap box filter
            for chunk in self.out_frame_48k.chunks_exact(3) {
                let s0 = chunk[0] / 32768.0;
                let s1 = chunk[1] / 32768.0;
                let s2 = chunk[2] / 32768.0;
                clean_48k_out.extend_from_slice(&[s0, s1, s2]);
                self.stt_buffer_16k.push((s0 + s1 + s2) * (1.0 / 3.0));
            }
        }

        clean_48k_out
    }

    /// Drains the accumulated 16kHz mono PCM buffer for speech-to-text processing.
    pub fn drain_16k_samples(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.stt_buffer_16k)
    }

    /// Resets the internal state and ring buffers.
    pub fn reset(&mut self) {
        self.input_ring.clear();
        self.stt_buffer_16k.clear();
        self.in_frame_48k.fill(0.0);
        self.out_frame_48k.fill(0.0);
    }
}
