import { boxesIntersect } from './util.js';
import { boundsOf } from './store.js';
import { replayStrokesForTrack } from './replay-clock.js';

export const REPLAY_CENTER_FOLLOW_TAU_MS = 360;
export const REPLAY_CENTER_FOLLOW_MAX_DELTA_MS = 50;

export class ReplayEngine {
  constructor(app = null) {
    this.app = app;
    this.surface = app?.surface || null;
    this.audio = typeof Audio !== 'undefined' ? new Audio() : null;
    this.track = null;
    this.active = false;
    this.rafToken = null;
    this.currentTimeMs = 0;
    this.playbackRate = 1.0;
    this.ghostMode = 'translucent'; // 'translucent' | 'hidden'
    this.autoFollow = this.app?.settings?.replayCameraFollow !== false;
    this.followMode = ['viewport', 'center', 'dead-zone'].includes(this.app?.settings?.replayCameraMode)
      ? this.app.settings.replayCameraMode : 'viewport';
    this.pendingSeekMs = null;
    this.loadGeneration = 0;
    this.playGeneration = 0;
    this.lastError = null;
    this._centerFollowAt = null;
    this._skipSilenceAt = -Infinity;
    if (this.audio) {
      this.audio.addEventListener('timeupdate', () => this.syncClock());
      this.audio.addEventListener('ended', () => this.onEnded());
      this.audio.addEventListener('loadedmetadata', () => this.applyPendingSeek());
      this.audio.addEventListener('canplay', () => this.applyPendingSeek());
      this.audio.addEventListener('seeked', () => {
        if (!this.audio) return;
        if (this.pendingSeekMs != null) {
          const targetSeconds = this.pendingSeekMs / 1000;
          if (Math.abs(this.audio.currentTime - targetSeconds) < 0.05) this.pendingSeekMs = null;
          else { this.applyPendingSeek(); return; }
        }
        this.currentTimeMs = this.audio.currentTime * 1000;
        this.playStartPerfMs = performance.now();
        this.playStartTimeMs = this.currentTimeMs;
        this.surface?.invalidate();
      });
      this.audio.addEventListener('error', () => {
        this.lastError = new Error('The selected audio could not be loaded.');
        this.pause();
      });
    }
  }

  loadTrack(track) {
    const generation = ++this.loadGeneration;
    this.pause();
    this._centerFollowAt = null;
    this.track = track;
    this.audioBuffer = null;
    this.lastError = null;
    this.pendingSeekMs = 0;
    if (this.audio) {
      this.audio.removeAttribute?.('src');
      if (track?.assetId) {
      this.audio.src = `app://board/asset/${track.assetId}`;
      this.audio.load();
      }
    }
    if (track?.assetId && typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) {
      try {
        fetch(`app://board/asset/${track.assetId}`)
          .then((r) => r.arrayBuffer())
          .then((buf) => {
            if (generation !== this.loadGeneration) return null;
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            // The context is closed on BOTH paths: a decode that rejects used
            // to leak it, and Chromium only allows a handful per window.
            return ctx.decodeAudioData(buf).then((decoded) => {
              if (generation === this.loadGeneration) {
                if (this.track && (!this.track.durationMs || this.track.durationMs <= 0)) {
                  this.track.durationMs = Math.round(decoded.duration * 1000);
                }
                if (this.app?.audioBar?.setWaveformBuffer) {
                  this.app.audioBar.setWaveformBuffer(decoded);
                }
                if (this.app?.audioBar?.syncUI) {
                  this.app.audioBar.syncUI();
                }
              }
              // Only the peaks are wanted. A decoded lecture is hundreds of
              // megabytes of PCM; keeping it pinned for the session's life is
              // how a long recording took the whole renderer down.
              this.audioBuffer = null;
            }).finally(() => { try { ctx.close(); } catch {} });
          })
          .catch(() => {});
      } catch {}
    }
    this.seek(0);
  }

  async play() {
    if (!this.track) return false;
    const request = ++this.playGeneration;
    const dur = this.track?.durationMs || (this.audioBuffer?.duration ? this.audioBuffer.duration * 1000 : 0);
    if ((dur > 0 && this.currentTimeMs >= dur - 150) || (this.audio && this.audio.ended)) {
      this.seek(0);
    }
    if (this.pendingSeekMs != null && this.audio) {
      const seekReady = await this.waitForPendingSeek(request);
      if (!seekReady || request !== this.playGeneration) return false;
    }
    if (this.surface) {
      this.surface._ink = null;
      this.surface.invalidate();
    }
    this.lastError = null;
    if (this.audio) {
      this.audio.playbackRate = this.playbackRate;
      this.audio.preservesPitch = true;
      try {
        // Wait for Chromium to accept the play request before reporting an
        // active replay. Previously the rejected promise was swallowed while
        // the UI kept showing Pause and the animation clock kept moving.
        await this.audio.play();
        if (request !== this.playGeneration || this.audio.paused) return false;
      } catch (error) {
        this.lastError = error;
        this.active = false;
        if (this.surface) this.surface.invalidate();
        throw error;
      }
    }
    this.app?.setReadingMode?.(true, { silent: true });
    this.playStartPerfMs = performance.now();
    this.playStartTimeMs = this.currentTimeMs;
    this.active = true;
    this.loop();
    return true;
  }

  waitForPendingSeek(request) {
    const audio = this.audio;
    const target = this.pendingSeekMs;
    if (!audio || target == null) return Promise.resolve(true);
    if (typeof audio.addEventListener !== 'function' || typeof audio.removeEventListener !== 'function') {
      return Promise.resolve(true);
    }
    const atTarget = () => this.pendingSeekMs == null && !audio.seeking
      && Math.abs((audio.currentTime || 0) * 1000 - target) < 50;
    if (atTarget()) return Promise.resolve(true);

    return new Promise((resolve) => {
      let timer = null;
      const events = ['loadedmetadata', 'canplay', 'seeked', 'error'];
      const finish = (ok) => {
        if (timer != null) clearTimeout(timer);
        for (const event of events) audio.removeEventListener(event, check);
        resolve(ok);
      };
      const check = (event) => {
        if (request !== this.playGeneration || audio !== this.audio) return finish(false);
        if (event?.type === 'error') return finish(false);
        if (this.pendingSeekMs != null) this.applyPendingSeek();
        if (atTarget()) finish(true);
      };
      for (const event of events) audio.addEventListener(event, check);
      timer = setTimeout(() => finish(atTarget()), 3000);
      check();
    });
  }

  pause() {
    this.playGeneration++;
    // Do not let time spent paused/backgrounded turn the next center-follow
    // frame into a near-instant camera snap.
    this._centerFollowAt = null;
    if (this.audio) {
      try { this.audio.pause(); } catch {}
    }
    this.active = false;
    if (this.rafToken) cancelAnimationFrame(this.rafToken);
    this.rafToken = null;
    if (this.surface) {
      this.surface._ink = null;
      this.surface.invalidate();
    }
  }

  seek(timeMs) {
    const mediaDuration = Number.isFinite(this.audio?.duration) ? this.audio.duration * 1000 : 0;
    const max = this.track?.durationMs || (this.audioBuffer?.duration ? this.audioBuffer.duration * 1000 : 0) || mediaDuration;
    const clamped = Math.min(Math.max(0, Number(timeMs) || 0), max || Infinity);
    this.currentTimeMs = clamped;
    this.playStartPerfMs = performance.now();
    this.playStartTimeMs = clamped;
    if (this.audio) {
      // Keep the requested clock authoritative until Chromium confirms the
      // seek. Otherwise the next animation frame can replace a failed/pending
      // seek with the media element's old currentTime.
      this.pendingSeekMs = clamped;
      if (this.audio.readyState >= 1) this.applyPendingSeek(clamped);
    }
    if (this.surface) {
      this.surface._ink = null;
      this.surface.invalidate();
    }
    if (this.autoFollow) this.followActiveStroke();
  }

  applyPendingSeek(timeMs = this.pendingSeekMs) {
    if (timeMs == null || !this.audio || this.audio.readyState < 1) return false;
    try {
      const durationMs = Number.isFinite(this.audio.duration) ? this.audio.duration * 1000 : (this.track?.durationMs || 0);
      const target = Math.min(Math.max(0, timeMs), durationMs || Infinity);
      const targetSeconds = target / 1000;
      if (Math.abs((this.audio.currentTime || 0) - targetSeconds) < 0.025 && !this.audio.seeking) {
        this.pendingSeekMs = null;
        return true;
      }
      this.pendingSeekMs = target;
      this.audio.currentTime = targetSeconds;
      // Some media backends do not dispatch `seeked` for a no-op seek. Keep a
      // small tolerance check for that case without losing asynchronous seeks.
      if (!this.audio.seeking && Math.abs(this.audio.currentTime - targetSeconds) < 0.025) {
        this.pendingSeekMs = null;
        return true;
      }
      queueMicrotask(() => {
        if (this.audio && !this.audio.seeking && Math.abs(this.audio.currentTime - targetSeconds) < 0.025
          && this.pendingSeekMs === target) this.pendingSeekMs = null;
      });
      return true;
    } catch {
      // Keep the requested position until metadata/seekable ranges are ready.
      this.pendingSeekMs = timeMs;
      return false;
    }
  }

  setSpeed(speed) {
    this.playbackRate = speed;
    this.playStartPerfMs = performance.now();
    this.playStartTimeMs = this.currentTimeMs;
    if (this.audio) {
      this.audio.playbackRate = speed;
      this.audio.preservesPitch = true;
    }
  }

  setGhostMode(mode) {
    if (mode !== 'translucent' && mode !== 'hidden') return;
    this.ghostMode = mode;
    if (this.surface) this.surface.invalidate();
  }

  setCameraFollow(enabled) {
    this.autoFollow = !!enabled;
    if (!this.autoFollow) {
      this._replayFollowTarget = null;
      this.surface?.cam?.cancelGlide?.();
    }
    else this.followActiveStroke();
    this.surface?.invalidate();
  }

  setCameraMode(mode) {
    if (!['viewport', 'center', 'dead-zone'].includes(mode)) return;
    this.followMode = mode;
    this._centerFollowAt = null;
    this._replayFollowTarget = null;
    this.surface?.cam?.cancelGlide?.();
    if (this.autoFollow) this.followActiveStroke();
    this.surface?.invalidate();
  }

  syncClock() {
    if (this.audio && !this.audio.paused && Number.isFinite(this.audio.currentTime)) {
      this.currentTimeMs = this.audio.currentTime * 1000;
      this.playStartPerfMs = performance.now();
      this.playStartTimeMs = this.currentTimeMs;
    }
    if (this.surface) this.surface.invalidate();
  }

  onEnded() {
    this.pause();
    this.currentTimeMs = this.track?.durationMs || this.currentTimeMs;
    if (this.surface) this.surface.invalidate();
  }

  loop() {
    if (!this.active) return;
    const dur = this.track?.durationMs || (this.audioBuffer?.duration ? this.audioBuffer.duration * 1000 : 0);
    if (this.pendingSeekMs != null) {
      this.currentTimeMs = this.pendingSeekMs;
    } else if (this.audio && !this.audio.paused && Number.isFinite(this.audio.currentTime)) {
      this.currentTimeMs = this.audio.currentTime * 1000;
      this.playStartPerfMs = performance.now();
      this.playStartTimeMs = this.currentTimeMs;
    } else {
      const elapsed = (performance.now() - (this.playStartPerfMs || performance.now())) * this.playbackRate;
      this.currentTimeMs = (this.playStartTimeMs || 0) + elapsed;
    }

    if (dur > 0 && this.currentTimeMs >= dur) {
      this.currentTimeMs = dur;
      this.onEnded();
      return;
    }

    this.checkSkipSilence();

    if (this.surface) this.surface.invalidate();
    if (this.autoFollow) this.followActiveStroke();
    this.rafToken = requestAnimationFrame(() => this.loop());
  }

  checkSkipSilence() {
    if (!this.app?.settings?.replaySkipSilence || !this.active || this.pendingSeekMs != null) return false;
    // Once every 60 Hz frame is far more often than silence can start: the
    // test walks every stroke on the board (and every bookmark), so it is
    // limited to four times a second. -Infinity so the first check after the
    // setting is switched on always runs (performance.now() can itself be
    // near zero in a fresh process).
    const perfNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (perfNow - this._skipSilenceAt < 250) return false;
    this._skipSilenceAt = perfNow;
    const strokes = this.getTrackStrokes();
    if (!strokes.length) return false;
    const nowMs = this.currentTimeMs;
    let nextEventMs = Infinity;
    for (const s of strokes) {
      if (s?.t0 == null) continue;
      const t1 = s.t1 != null ? s.t1 : s.t0 + 200;
      if (s.t0 <= nowMs + 250 && nowMs <= t1 + 400) return false;
      if (s.t0 > nowMs && s.t0 < nextEventMs) nextEventMs = s.t0;
    }
    if (Array.isArray(this.track?.bookmarks)) {
      for (const bm of this.track.bookmarks) {
        if (bm?.t != null && bm.t <= nowMs + 250 && nowMs <= bm.t + 400) return false;
        if (bm?.t != null && bm.t > nowMs && bm.t < nextEventMs) nextEventMs = bm.t;
      }
    }
    if (Number.isFinite(nextEventMs) && nextEventMs - nowMs > 2000) {
      this.seek(Math.max(nowMs, nextEventMs - 250));
      return true;
    }
    return false;
  }

  getActiveStroke() {
    if (!this.track?.id) return null;
    for (const stroke of this.getTrackStrokes()) {
      if (stroke.t0 <= this.currentTimeMs && this.currentTimeMs < stroke.t1) return stroke;
    }
    return null;
  }

  getTrackStrokes() {
    return replayStrokesForTrack(this.app?.store, this.track?.id);
  }

  getActivePoint(stroke = this.getActiveStroke()) {
    const points = stroke?.points;
    if (!Array.isArray(points) || !points.length) return null;
    let point = points[0];
    for (const candidate of points) {
      if (candidate.t == null || candidate.t <= this.currentTimeMs) point = candidate;
      else break;
    }
    return Number.isFinite(point?.x) && Number.isFinite(point?.y) ? point : null;
  }

  followActiveStroke() {
    const stroke = this.getActiveStroke();
    const box = stroke?.bbox || (stroke ? boundsOf(stroke) : null);
    if (box && this.surface?.cam && this.followMode === 'viewport') {
      const cam = this.surface.cam;
      if (this._replayFollowTarget === stroke.id && cam._anim) return;
      const vp = cam.viewport(this.surface.width, this.surface.height);
      if (boxesIntersect(vp, box)) { this._replayFollowTarget = null; return; }
      this._replayFollowTarget = stroke.id;
      cam.glideTo(box, this.surface.width, this.surface.height, {
        duration: 300,
        onStep: () => this.surface?.invalidate(),
        onDone: () => { this._replayFollowTarget = null; }
      });
      return;
    }
    const point = this.getActivePoint(stroke);
    const cam = this.surface?.cam;
    if (!point || !cam) return;
    cam.cancelGlide?.();
    this._replayFollowTarget = stroke?.id || null;
    const screen = cam.toScreen(point.x, point.y);
    const width = this.surface.width, height = this.surface.height;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const elapsed = this._centerFollowAt == null
      ? 16
      : Math.min(REPLAY_CENTER_FOLLOW_MAX_DELTA_MS, Math.max(1, now - this._centerFollowAt));
    this._centerFollowAt = now;
    let dx = 0, dy = 0;
    if (this.followMode === 'center') {
      dx = width / 2 - screen.x;
      dy = height / 2 - screen.y;
    } else {
      // A 40% x 40% central dead zone mirrors the user's sketched frame:
      // leave the camera still until the animated point reaches its edge.
      const left = width * 0.3, right = width * 0.7;
      const top = height * 0.3, bottom = height * 0.7;
      if (screen.x < left) dx = left - screen.x;
      else if (screen.x > right) dx = right - screen.x;
      if (screen.y < top) dy = top - screen.y;
      else if (screen.y > bottom) dy = bottom - screen.y;
    }
    if (dx || dy) {
      if (this.followMode === 'center') {
        // Smooth center-follow across playback frames so sampled point jitter
        // does not translate directly into a shaky camera.
        const blend = 1 - Math.exp(-elapsed / REPLAY_CENTER_FOLLOW_TAU_MS);
        const moveX = Math.abs(dx) < 0.75 ? 0 : dx * blend;
        const moveY = Math.abs(dy) < 0.75 ? 0 : dy * blend;
        if (moveX || moveY) cam.panBy(moveX, moveY);
      } else {
        cam.panBy(dx, dy);
      }
      this.surface.invalidate();
    }
  }
}

/**
 * Smooth partial Bézier evaluation for TRAP 1 & TRAP 2.
 * Evaluates a cubic segment parameterized by audio time using De Casteljau subdivision.
 */
export function drawTimedBezierAtClock(ctx, seg, currentAudioMs) {
  if (currentAudioMs < seg.t_start) return;

  if (currentAudioMs >= seg.t_end) {
    ctx.bezierCurveTo(seg.p1[0], seg.p1[1], seg.p2[0], seg.p2[1], seg.p3[0], seg.p3[1]);
    return;
  }

  // Normalize playback clock into curve parameter u in (0.0, 1.0)
  const u = (currentAudioMs - seg.t_start) / Math.max(1, seg.t_end - seg.t_start);
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

  // De Casteljau subdivision for left sub-curve [0, u]
  const q0 = lerp(seg.p0, seg.p1, u);
  const q1 = lerp(seg.p1, seg.p2, u);
  const q2 = lerp(seg.p2, seg.p3, u);
  const r0 = lerp(q0, q1, u);
  const r1 = lerp(q1, q2, u);
  const s0 = lerp(r0, r1, u);

  ctx.bezierCurveTo(q0[0], q0[1], r0[0], r0[1], s0[0], s0[1]);
}

/**
 * Connects speech search hit to canvas camera and audio scrubber.
 */
export function jumpToAudioInkHit(surface, replayEngine, hit) {
  if (!hit) return;
  // 1. Seek audio player to exact spoken word timestamp
  if (replayEngine?.seekToMs && hit.session_id && hit.audio_seek_ms != null) {
    replayEngine.seekToMs(hit.session_id, hit.audio_seek_ms);
  }

  // 2. Smoothly pan & zoom Canvas 2D camera to frame the matched stroke
  if (surface && hit.camera_center_x != null && hit.camera_center_y != null) {
    const w = surface.width || 800;
    const h = surface.height || 600;
    const targetZoom = Math.min(
      2.5,
      Math.max(0.5, Math.min(w / Math.max(10, hit.bbox_width * 3), h / Math.max(10, hit.bbox_height * 3)))
    );
    if (typeof surface.animateCameraTo === 'function') {
      surface.animateCameraTo(hit.camera_center_x, hit.camera_center_y, targetZoom, 420);
    } else if (surface.camera?.panTo) {
      surface.camera.panTo(hit.camera_center_x, hit.camera_center_y);
    }
  }

  // 3. Pulse highlight halo around the target stroke
  if (surface?.flashStrokeHighlight && hit.stroke_id) {
    surface.flashStrokeHighlight(hit.stroke_id, 1500);
  }
}

/**
 * Tap a stroke while holding Alt to immediately seek audio to when the stroke was inked.
 */
export function onStrokeAltClickSeekAudio(stroke, replayEngine) {
  if (!stroke?.audioId && !stroke?.sessionId) return;
  const sid = stroke.sessionId || stroke.audioId;
  const firstTimestampMs = stroke.points?.[0]?.t ?? stroke.t0;
  if (typeof firstTimestampMs === 'number' && replayEngine?.seekToMs) {
    replayEngine.seekToMs(sid, firstTimestampMs);
  }
}
