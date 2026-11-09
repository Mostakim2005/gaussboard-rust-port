import { HardwareAudioClock } from './audio-clock.js';

export class AudioRecorder {
  constructor({ onTimeUpdate = null, onLevelUpdate = null, onStateChange = null } = {}) {
    this.onTimeUpdate = onTimeUpdate;
    this.onLevelUpdate = onLevelUpdate;
    this.onStateChange = onStateChange;
    this.state = 'idle'; // 'idle' | 'recording' | 'paused'
    this.stream = null;
    this.recorder = null;
    this.audioCtx = null;
    this.clock = null;
    this.analyser = null;
    this.meterAnim = null;
    this.sessionId = null;
    this.activeTrackId = null;
    this.elapsedOffsetMs = 0;
    this.segmentStartMs = 0;
    this.chunkQueue = Promise.resolve();
    this.chunkError = null;
  }

  get recording() {
    return this.state === 'recording';
  }

  async start() {
    // A second Start while the microphone prompt is still open used to open a
    // second capture stream and overwrite the first one, leaving a live
    // microphone with no recorder attached to it.
    if (this.state !== 'idle' || this._starting) return;
    this._starting = true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });

      this.sessionId = 'rec_' + Date.now();
      this.activeTrackId = 'aud_' + Date.now();
      if (window.board?.recording?.start) {
        await window.board.recording.start(this.sessionId);
      }

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        this.audioCtx = new AudioContextClass();
        this.clock = new HardwareAudioClock(this.audioCtx);
        const source = this.audioCtx.createMediaStreamSource(this.stream);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 64;
        source.connect(this.analyser);
        this.startMeter();
      } else {
        this.clock = new HardwareAudioClock(null);
      }

      // Not every build accepts the explicit WebM/Opus type; asking for the
      // default recorder beats throwing away a recording that would have worked.
      const options = { audioBitsPerSecond: 64000 };
      const preferred = 'audio/webm;codecs=opus';
      if (typeof MediaRecorder.isTypeSupported !== 'function'
          || MediaRecorder.isTypeSupported(preferred)) options.mimeType = preferred;
      this.recorder = new MediaRecorder(this.stream, options);

      this.chunkQueue = Promise.resolve();
      this.chunkError = null;
      this.recorder.ondataavailable = (e) => {
        if (!e.data || e.data.size <= 0 || !window.board?.recording?.appendChunk) return;
        const sessionId = this.sessionId;
        this.chunkQueue = this.chunkQueue.then(async () => {
          const buf = await e.data.arrayBuffer();
          await window.board.recording.appendChunk(sessionId, new Uint8Array(buf));
        }).catch((error) => { this.chunkError ||= error; });
      };

      this.elapsedOffsetMs = 0;
      this.segmentStartMs = performance.now();
      this.recorder.start(3000); // 3-second slices
      this.state = 'recording';
      if (this.onStateChange) this.onStateChange(this.state);
    } catch (error) {
      // Never leave the microphone open, the meter running or a half-written
      // session file behind when capture cannot start.
      await this.releaseCapture();
      this.state = 'idle';
      throw error;
    } finally {
      this._starting = false;
    }
  }

  /** Stop the capture stream, meter and session file; safe to call twice. */
  async releaseCapture() {
    this.stopMeter();
    this.clock = null;
    if (this.analyser) { try { this.analyser.disconnect?.(); } catch {} this.analyser = null; }
    if (this.stream) {
      try { this.stream.getTracks().forEach((t) => t.stop()); } catch {}
      this.stream = null;
    }
    if (this.audioCtx) {
      const ctx = this.audioCtx;
      this.audioCtx = null;
      try { await ctx.close(); } catch {}
    }
    // Close the temp file the main process opened, or it stays open for the
    // life of the app.
    if (this.sessionId && window.board?.recording?.finish) {
      try { await window.board.recording.finish(this.sessionId, 0); } catch {}
    }
    this.sessionId = null;
  }

  pause() {
    if (this.state !== 'recording') return;
    this.recorder.pause();
    this.clock?.pause();
    this.elapsedOffsetMs += (performance.now() - this.segmentStartMs);
    this.state = 'paused';
    if (this.onStateChange) this.onStateChange(this.state);
  }

  resume() {
    if (this.state !== 'paused') return;
    this.segmentStartMs = performance.now();
    this.clock?.resume();
    this.recorder.resume();
    this.state = 'recording';
    if (this.onStateChange) this.onStateChange(this.state);
  }

  async stop() {
    if (this.state === 'idle') return null;
    if (this.state === 'recording') {
      this.elapsedOffsetMs += (performance.now() - this.segmentStartMs);
    }
    this.state = 'idle';
    this.stopMeter();

    const finalDurationMs = Math.round(this.elapsedOffsetMs);
    const recorder = this.recorder;

    return new Promise((resolve) => {
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        this.sessionId = null;
        resolve(result);
      };
      const fail = async (error) => {
        this.stopMeter();
        if (this.stream) { try { this.stream.getTracks().forEach((t) => t.stop()); } catch {} this.stream = null; }
        if (this.audioCtx) { const ctx = this.audioCtx; this.audioCtx = null; try { await ctx.close(); } catch {} }
        // Close the temp session file too, or it stays open until the app quits.
        if (this.sessionId && window.board?.recording?.finish) {
          try { await window.board.recording.finish(this.sessionId, finalDurationMs); } catch {}
        }
        if (this.onStateChange) this.onStateChange(this.state);
        settle({ id: this.activeTrackId, durationMs: finalDurationMs, error });
      };
      recorder.onstop = async () => {
        try {
          // MediaRecorder dispatches its final dataavailable before onstop, but
          // arrayBuffer() and the IPC write are asynchronous. Serialize every
          // chunk and await the queue before closing/finalizing the asset.
          await this.chunkQueue;
          if (this.chunkError) throw this.chunkError;
          if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
          if (this.audioCtx) { const ctx = this.audioCtx; this.audioCtx = null; await ctx.close(); }
          let result = {};
          if (window.board?.recording?.finish) {
            result = await window.board.recording.finish(this.sessionId, finalDurationMs);
          }
          if (this.onStateChange) this.onStateChange(this.state);
          settle({ ...result, id: this.activeTrackId, durationMs: finalDurationMs });
        } catch (error) {
          await fail(error);
        }
      };
      // A recorder that errors out never fires `onstop`; without this the UI
      // waited on a promise that could not settle.
      recorder.onerror = (event) => { fail(recorder.error || event?.error || new Error('Recording failed')); };
      try {
        recorder.stop();
      } catch (error) {
        fail(error);
      }
    });
  }

  currentOffsetMs() {
    if (this.clock) return this.clock.nowMs();
    if (this.state === 'idle') return 0;
    if (this.state === 'paused') return Math.round(this.elapsedOffsetMs);
    return Math.round(this.elapsedOffsetMs + (performance.now() - this.segmentStartMs));
  }

  startMeter() {
    if (!this.analyser) return;
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    const update = () => {
      if (!this.analyser || this.state !== 'recording') return;
      this.analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / Math.max(1, dataArray.length);
      const level = Math.min(1, avg / 128); // 0.0 to 1.0 RMS level
      if (this.onLevelUpdate) this.onLevelUpdate(level);
      if (this.onTimeUpdate) this.onTimeUpdate(this.currentOffsetMs());
      this.meterAnim = requestAnimationFrame(update);
    };
    this.meterAnim = requestAnimationFrame(update);
  }

  stopMeter() {
    if (this.meterAnim) {
      cancelAnimationFrame(this.meterAnim);
      this.meterAnim = null;
    }
    if (this.onLevelUpdate) this.onLevelUpdate(0);
  }
}
