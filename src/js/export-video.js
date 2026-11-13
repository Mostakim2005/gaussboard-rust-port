// Animated Video Export Engine.
// Multiplexes canvas reanimation and audio track into standalone .webm video files.

import { Surface } from './core/surface.js';
import { t } from './i18n.js';
import { isDarkBoard } from './core/render.js';
import { boundsOf } from './core/store.js';
import { boardAssetUrl } from './core/util.js';
import { stripBounds } from './core/pages.js';
import { replayDisplayMode, replayGhostMode, replaySceneFilter, replayStrokesForTrack } from './core/replay-clock.js';
import { h } from './ui/popover.js';
import { Muxer, ArrayBufferTarget } from '../vendor/mp4-muxer.mjs';

export const VIDEO_EXPORT_PRESETS = Object.freeze({
  '720p30': Object.freeze({ width: 1280, height: 720, fps: 30 }),
  '1080p30': Object.freeze({ width: 1920, height: 1080, fps: 30 }),
  '1080p60': Object.freeze({ width: 1920, height: 1080, fps: 60 })
});

export const VIDEO_CAMERA_MODES = Object.freeze({ FIXED: 'fixed', FOLLOW: 'follow' });
export const VIDEO_FIXED_FRAMES = Object.freeze({ RECORDING: 'recording', BOARD: 'board' });

export function uniqueExportSuffix(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function videoExportFilename(boardName, suffix = uniqueExportSuffix(), trackName = '', format = 'webm') {
  const safe = (value, fallback) => String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim() || fallback;
  const board = safe(boardName, 'Board');
  const track = trackName ? `-${safe(trackName, 'Recording')}` : '';
  const ext = format === 'mp4' ? 'mp4' : 'webm';
  const tail = `-replay-${suffix}.${ext}`;
  // Two long names together can exceed the 255-character filename limit on
  // NTFS (and the save dialog then refuses the suggested path). Keep the
  // unique timestamp suffix and shorten only the descriptive part.
  const room = Math.max(24, 200 - tail.length);
  const base = `${board}${track}`.slice(0, room).replace(/[. ]+$/g, '') || 'Board';
  return `${base}${tail}`;
}

export function boundsForObjects(objects, pages = []) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const object of Object.values(objects || {})) {
    if (!object) continue;
    const box = object.bbox || boundsOf(object);
    if (!box || ![box.x, box.y, box.w, box.h].every(Number.isFinite)) continue;
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.w);
    maxY = Math.max(maxY, box.y + box.h);
  }
  const pagesBox = stripBounds(pages);
  if (pagesBox) {
    minX = Math.min(minX, pagesBox.x);
    minY = Math.min(minY, pagesBox.y);
    maxX = Math.max(maxX, pagesBox.x + pagesBox.w);
    maxY = Math.max(maxY, pagesBox.y + pagesBox.h);
  }
  return minX < maxX && minY < maxY ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
}

export function boundsForTrack(objects, trackId) {
  return boundsForObjects(Object.fromEntries(Object.entries(objects || {}).filter(([, object]) => object?.audioId === trackId)));
}

export function targetCameraForBox(box, width, height, padding = 96, maxZoom = 2, minZoom = 0.05) {
  if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y) || !(width > padding * 2) || !(height > padding * 2)) return null;
  const boxWidth = Math.max(10, box.w || 0), boxHeight = Math.max(10, box.h || 0);
  const centerX = box.x + (box.w || 0) / 2, centerY = box.y + (box.h || 0) / 2;
  const zoom = Math.max(minZoom, Math.min(Math.min((width - padding * 2) / boxWidth, (height - padding * 2) / boxHeight), maxZoom));
  return {
    z: zoom,
    x: width / 2 - centerX * zoom,
    y: height / 2 - centerY * zoom
  };
}

function frameCamera(surface, box, width, height, padding = 96) {
  const target = targetCameraForBox(box, width, height, padding);
  if (!target) return false;
  surface.cam.x = target.x;
  surface.cam.y = target.y;
  surface.cam.z = target.z;
  return true;
}

export function strokeAtOrAfter(objects, trackId, timeMs) {
  const ordered = Object.values(objects || {}).filter((o) => o?.audioId === trackId && Number.isFinite(o.t0));
  return strokeAtOrAfterInList(ordered, timeMs);
}

export function strokeAtOrAfterInList(ordered, timeMs) {
  return (ordered || []).find((o) => Number.isFinite(o.t0) && Number.isFinite(o.t1) && o.t0 <= timeMs && timeMs < o.t1)
    || (ordered || []).find((o) => Number.isFinite(o.t0) && o.t0 >= timeMs)
    || null;
}

export function followExportCamera(surface, stroke, width, height, frameInterval) {
  if (!stroke) return;
  const box = stroke.bbox || boundsOf(stroke);
  const target = targetCameraForBox(box, width, height, 110, 1.6, 0.3);
  if (!target) return;
  const amount = 1 - Math.exp(-Math.max(1, frameInterval) / 320);
  surface.cam.x += (target.x - surface.cam.x) * amount;
  surface.cam.y += (target.y - surface.cam.y) * amount;
  surface.cam.z += (target.z - surface.cam.z) * amount;
}

function initializeExportCamera(surface, app, track, width, height, cameraMode, fixedFrame) {
  const objects = app?.store?.doc?.objects || {};
  let framed = false;
  if (cameraMode === VIDEO_CAMERA_MODES.FOLLOW) {
    const first = strokeAtOrAfter(objects, track.id, 0);
    framed = frameCamera(surface, first?.bbox || (first ? boundsOf(first) : null), width, height, 110);
    if (!framed) framed = frameCamera(surface, boundsForTrack(objects, track.id), width, height);
  } else {
    const box = fixedFrame === VIDEO_FIXED_FRAMES.BOARD
      ? boundsForObjects(objects, app?.store?.doc?.pages)
      : boundsForTrack(objects, track.id);
    framed = frameCamera(surface, box, width, height);
  }
  if (!framed && app?.surface?.cam) {
    surface.cam.x = app.surface.cam.x;
    surface.cam.y = app.surface.cam.y;
    surface.cam.z = app.surface.cam.z;
  }
}

function waitForAudioReady(audio, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      audio.removeEventListener('canplaythrough', ready);
      audio.removeEventListener('error', failed);
    };
    const ready = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(audio.error || new Error('Audio could not be loaded')); };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Audio load timeout'));
    }, timeoutMs);
    audio.addEventListener('canplaythrough', ready, { once: true });
    audio.addEventListener('error', failed, { once: true });
    audio.load();
  });
}

function durationForTrack(track, audio) {
  if (Number.isFinite(track.durationMs) && track.durationMs > 0) return track.durationMs;
  if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration * 1000;
  return 0;
}

export class VideoExporter {
  constructor(app) {
    this.app = app;
    this.cancelled = false;
    this.recorder = null;
  }

  cancel() {
    this.cancelled = true;
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch {}
    }
  }

  /**
   * Export an audio track and canvas replay session to a video Blob.
   * @param {object} opts
   * @param {object} opts.track
   * @param {number} [opts.width]   Video width in pixels (default: 1920)
   * @param {number} [opts.height]  Video height in pixels (default: 1080)
   * @param {number} [opts.fps]     Target framerate (default: 30)
   * @param {(pct: number) => void} [opts.onProgress] Callback with 0.0 - 1.0 progress
   * @returns {Promise<{ blob: Blob, durationMs: number }>}
   */
  async exportReplayVideo({ track, width = 1920, height = 1080, fps = 30, onProgress = null, cameraMode = VIDEO_CAMERA_MODES.FIXED, fixedFrame = VIDEO_FIXED_FRAMES.RECORDING } = {}) {
    if (!track) throw new Error('No audio track specified for video export');
    this.cancelled = false;

    // Create offscreen render canvas
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    // Dedicated offscreen surface instance
    const sf = new Surface(canvas, this.app.store, { app: this.app, ephemeral: true });
    sf.resize(width, height);
    const displayMode = replayDisplayMode(this.app?.settings);
    const replayClock = {
      track, currentTimeMs: 0,
      ghostMode: replayGhostMode(this.app?.settings, this.app?.replayEngine?.ghostMode, displayMode),
      displayMode
    };
    const trackStrokes = replayStrokesForTrack(this.app?.store, track.id);

    initializeExportCamera(sf, this.app, track, width, height, cameraMode, fixedFrame);

    // Audio element
    const audio = new Audio();
    audio.src = boardAssetUrl(track.assetId);
    audio.crossOrigin = 'anonymous';
    let audioCtx = null;
    let source = null;
    let videoStream = null;
    let rec = null;
    try {
    await waitForAudioReady(audio);
    const rawDur = durationForTrack(track, audio);
    const durationMs = Number.isFinite(rawDur) && rawDur > 0 ? rawDur : 1;
    if (!rawDur) throw new Error('Could not determine audio duration');

    // Setup Web Audio routing to capture audio stream without microphone bleed
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();
    source = audioCtx.createMediaElementSource(audio);
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(dest);

    // Capture canvas video stream
    videoStream = canvas.captureStream ? canvas.captureStream(fps) : null;
    if (!videoStream) {
      throw new Error('Canvas captureStream not supported in this environment');
    }

    const combinedTracks = [
      ...videoStream.getVideoTracks(),
      ...dest.stream.getAudioTracks()
    ];
    const combinedStream = new MediaStream(combinedTracks);

    // Choose preferred video container
    let mimeType = 'video/webm;codecs=vp9,opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = 'video/webm';
    }

    const chunks = [];
    rec = new MediaRecorder(combinedStream, {
      mimeType,
      videoBitsPerSecond: 4000000 // 4 Mbps high-definition target
    });
    this.recorder = rec;

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const completionPromise = new Promise((resolve, reject) => {
      rec.onstop = () => {
        audioCtx.close().catch(() => {});
        if (this.cancelled) {
          reject(new Error('Export cancelled by user'));
        } else {
          resolve(new Blob(chunks, { type: mimeType }));
        }
      };
      rec.onerror = (err) => {
        audioCtx.close().catch(() => {});
        reject(err);
      };
    });

    rec.start(250); // 250ms chunk slicing for reliable video data
    await audio.play();

    // Replay render loop driven by audio playback clock
    const frameInterval = 1000 / fps;
    const ctx = canvas.getContext('2d');
    const videoTrack = videoStream.getVideoTracks()[0];

    const renderLoop = async () => {
      if (this.cancelled || audio.ended || (audio.currentTime * 1000 >= durationMs)) {
        audio.pause();
        try { rec.requestData(); } catch {}
        // Give recorder brief moment to finalize final chunk
        setTimeout(() => {
          if (rec.state !== 'inactive') rec.stop();
        }, 150);
        return;
      }

      // Synchronize clock and redraw offscreen canvas
      const curMs = audio.currentTime * 1000;
      replayClock.currentTimeMs = curMs;
      if (cameraMode === VIDEO_CAMERA_MODES.FOLLOW) {
        followExportCamera(sf, strokeAtOrAfterInList(trackStrokes, curMs), width, height, frameInterval);
      }

      // Deterministically render solid background, base scene, and synchronized replay session
      ctx.save();
      ctx.fillStyle = isDarkBoard() ? '#1f1e1d' : '#f5f4f2';
      ctx.fillRect(0, 0, width, height);
      sf.drawScene(ctx, width, height, () => {}, null,
        replaySceneFilter(track.id, this.app?.settings, replayClock.displayMode));
      sf.drawReplaySession(ctx, replayClock);
      ctx.restore();

      if (videoTrack?.requestFrame) {
        try { videoTrack.requestFrame(); } catch {}
      }

      if (onProgress) {
        onProgress(durationMs > 0 ? Math.min(1.0, Math.max(0, curMs / durationMs)) : 0);
      }

      setTimeout(renderLoop, frameInterval);
    };

    renderLoop();

    const blob = await completionPromise;
    return { blob, durationMs };
    } finally {
      if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch {} }
      try { source?.disconnect(); } catch {}
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      videoStream?.getTracks().forEach((streamTrack) => streamTrack.stop());
      sf.destroy();
      audioCtx?.close().catch(() => {});
    }
  }

  /**
   * Sequentially stitches multiple recordings and stroke sessions into a standalone MP4 or WebM video.
   */
  async exportStitchedReplayVideo({ tracks, width = 1920, height = 1080, fps = 30, onProgress = null, cameraMode = VIDEO_CAMERA_MODES.FIXED, fixedFrame = VIDEO_FIXED_FRAMES.RECORDING, format = 'mp4' } = {}) {
    if (!tracks || !tracks.length) throw new Error('No audio tracks specified for video export');
    // A track without an asset cannot be played or captured; fail with a clear
    // message instead of waiting 15 s for a media error on app://.../undefined.
    const noAsset = tracks.find((tr) => !tr || !tr.assetId);
    if (noAsset) throw new Error(`Recording "${noAsset.name || noAsset.id || '?'}" has no audio file to export`);
    if (tracks.length === 1 && (format !== 'mp4' || typeof VideoEncoder === 'undefined')) {
      return this.exportReplayVideo({
        track: tracks[0],
        width,
        height,
        fps,
        onProgress,
        cameraMode,
        fixedFrame
      });
    }

    this.cancelled = false;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const sf = new Surface(canvas, this.app.store, { app: this.app, ephemeral: true });
    sf.resize(width, height);
    let videoStream = null;
    let audioCtx = null;
    let rec = null;
    let activeAudio = null;
    let activeSource = null;
    let mp4Muxer = null;
    let mp4Target = null;
    let videoEncoder = null;
    let frameCount = 0;

    const displayMode = replayDisplayMode(this.app?.settings);
    const replayClock = {
      track: null, currentTimeMs: 0,
      ghostMode: replayGhostMode(this.app?.settings, this.app?.replayEngine?.ghostMode, displayMode),
      displayMode
    };

    if (format === 'mp4' && typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined') {
      try {
        mp4Target = new ArrayBufferTarget();
        mp4Muxer = new Muxer({
          target: mp4Target,
          video: {
            codec: 'avc',
            width,
            height
          },
          fastStart: 'in-memory'
        });

        videoEncoder = new VideoEncoder({
          output: (chunk, meta) => {
            if (mp4Muxer) mp4Muxer.addVideoChunk(chunk, meta);
          },
          error: (err) => {
            console.warn('VideoEncoder runtime error, fallback to WebM:', err);
            videoEncoder = null;
          }
        });

        videoEncoder.configure({
          codec: 'avc1.4d002a',
          width,
          height,
          bitrate: 4_000_000,
          framerate: fps
        });
      } catch (err) {
        console.warn('Could not initialize WebCodecs MP4 encoder, falling back to MediaRecorder WebM:', err);
        videoEncoder = null;
        mp4Muxer = null;
      }
    }

    try {
    videoStream = canvas.captureStream ? canvas.captureStream(fps) : null;
    if (!videoStream) throw new Error('Canvas captureStream not supported in this environment');

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextClass();
    const dest = audioCtx.createMediaStreamDestination();

    const combinedTracks = [
      ...videoStream.getVideoTracks(),
      ...dest.stream.getAudioTracks()
    ];
    const combinedStream = new MediaStream(combinedTracks);

    let mimeType = 'video/webm;codecs=vp9,opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm';

    const chunks = [];
    rec = new MediaRecorder(combinedStream, {
      mimeType,
      videoBitsPerSecond: 4000000
    });
    this.recorder = rec;

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const completionPromise = new Promise((resolve, reject) => {
      rec.onstop = () => {
        audioCtx.close().catch(() => {});
        if (this.cancelled) reject(new Error('Export cancelled by user'));
        else resolve(new Blob(chunks, { type: mimeType }));
      };
      rec.onerror = (err) => {
        audioCtx.close().catch(() => {});
        reject(err);
      };
    });

    rec.start(250);

    const rawTotalDuration = tracks.reduce((sum, tr) => sum + (Number.isFinite(tr.durationMs) && tr.durationMs > 0 ? tr.durationMs : 0), 0);
    const totalDurationMs = Number.isFinite(rawTotalDuration) && rawTotalDuration > 0 ? rawTotalDuration : 1;
    let cumulativeElapsedMs = 0;
    const frameInterval = 1000 / fps;
    const ctx = canvas.getContext('2d');
    const videoTrack = videoStream.getVideoTracks()[0];

    for (let i = 0; i < tracks.length; i++) {
      if (this.cancelled) break;
      const track = tracks[i];
      const trackStrokes = replayStrokesForTrack(this.app?.store, track.id);
      replayClock.track = track;
      replayClock.currentTimeMs = 0;
      initializeExportCamera(sf, this.app, track, width, height, cameraMode, fixedFrame);

      const audio = new Audio();
      activeAudio = audio;
      audio.src = boardAssetUrl(track.assetId);
      audio.crossOrigin = 'anonymous';

      await waitForAudioReady(audio);

      const trackDur = durationForTrack(track, audio);
      if (!trackDur) throw new Error('Could not determine audio duration');

      const source = audioCtx.createMediaElementSource(audio);
      activeSource = source;
      source.connect(dest);
      await audio.play();

      await new Promise((done) => {
        const checkDone = () => {
          if (this.cancelled || audio.ended || (audio.currentTime * 1000 >= trackDur)) {
            audio.pause();
            try { source.disconnect(); } catch {}
            cumulativeElapsedMs += trackDur;
            audio.removeAttribute('src');
            audio.load();
            activeAudio = null;
            activeSource = null;
            done();
            return;
          }

          const curMs = audio.currentTime * 1000;
          replayClock.currentTimeMs = curMs;
          if (cameraMode === VIDEO_CAMERA_MODES.FOLLOW) {
            followExportCamera(sf, strokeAtOrAfterInList(trackStrokes, curMs), width, height, frameInterval);
          }

          ctx.save();
          ctx.fillStyle = isDarkBoard() ? '#1f1e1d' : '#f5f4f2';
          ctx.fillRect(0, 0, width, height);
          sf.drawScene(ctx, width, height, () => {}, null,
            replaySceneFilter(track.id, this.app?.settings, replayClock.displayMode));
          sf.drawReplaySession(ctx, replayClock);
          ctx.restore();

          if (videoEncoder && videoEncoder.state === 'configured') {
            try {
              const frame = new VideoFrame(canvas, { timestamp: Math.round((cumulativeElapsedMs + curMs) * 1000) });
              videoEncoder.encode(frame, { keyFrame: frameCount % (fps * 2) === 0 });
              frame.close();
              frameCount++;
            } catch {}
          }

          if (videoTrack?.requestFrame) {
            try { videoTrack.requestFrame(); } catch {}
          }

          if (onProgress) {
            // A progress callback that throws must not stop the frame pump:
            // the recorder would then never be stopped and the export would
            // hang with no way out but Cancel.
            try {
              onProgress(totalDurationMs > 0 ? Math.min(1.0, (cumulativeElapsedMs + curMs) / totalDurationMs) : 0);
            } catch { /* progress is advisory */ }
          }

          setTimeout(checkDone, frameInterval);
        };
        checkDone();
      });
    }

    try { rec.requestData(); } catch {}
    setTimeout(() => {
      if (rec.state !== 'inactive') rec.stop();
    }, 200);

    if (videoEncoder && mp4Muxer) {
      try {
        await videoEncoder.flush();
        videoEncoder.close();
        mp4Muxer.finalize();
        const buf = mp4Target.buffer;
        return { blob: new Blob([buf], { type: 'video/mp4' }), durationMs: cumulativeElapsedMs };
      } catch (err) {
        console.warn('MP4 finalization failed, falling back to WebM blob:', err);
      }
    }

    const blob = await completionPromise;
    return { blob, durationMs: cumulativeElapsedMs };
    } finally {
      if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch {} }
      try { activeSource?.disconnect(); } catch {}
      if (activeAudio) {
        activeAudio.pause();
        activeAudio.removeAttribute('src');
        activeAudio.load();
      }
      videoStream?.getTracks().forEach((streamTrack) => streamTrack.stop());
      sf.destroy();
      audioCtx?.close().catch(() => {});
    }
  }
}

export async function pickRecordingsForVideoExport(app, trackOverride = null) {
  const tracks = (trackOverride || app.store?.doc?.audioTracks || []).map((t, idx) => ({ ...t, originalIndex: idx }));
  if (!tracks.length) {
    app.toast(t('No audio track to export'));
    return null;
  }

  return new Promise((resolve) => {
    let items = [...tracks];
    const selectedIds = new Set(tracks.map((t) => t.id));
    let stitchTogether = tracks.length > 1;

    const overlay = h('div', {
      id: 'videoExportModal',
      style: 'position:fixed;inset:0;background:rgba(0,0,0,0.45);backdrop-filter:blur(4px);z-index:99999;display:flex;align-items:center;justify-content:center;'
    });

    const card = h('div', {
      style: 'background:var(--surface);border:1px solid var(--stroke);border-radius:14px;padding:20px;width:min(480px,90vw);box-shadow:var(--shadow-3);display:flex;flex-direction:column;gap:14px;'
    });

    const titleRow = h('div', { style: 'display:flex;align-items:center;justify-content:space-between;' },
      h('h3', { style: 'margin:0;font-size:16px;font-weight:700;' }, t('Export Video (Select Recordings)')),
      h('button', {
        style: 'background:none;border:none;cursor:pointer;font-size:16px;color:var(--text-2);',
        onclick: () => { overlay.remove(); resolve(null); }
      }, '✕')
    );

    const desc = h('p', { style: 'margin:0;font-size:12.5px;color:var(--text-2);' },
      t('Choose which recordings to export. Use ▲ and ▼ to set the playback order.')
    );

    const preset = h('select', { 'aria-label': t('Video quality'), style: 'padding:7px 9px;border-radius:7px;background:var(--surface-2);color:var(--text);border:1px solid var(--stroke)' },
      h('option', { value: '720p30' }, '720p · 30 fps'),
      h('option', { value: '1080p30' }, '1080p · 30 fps'),
      h('option', { value: '1080p60' }, '1080p · 60 fps'));
    preset.value = '1080p30';

    const formatSelect = h('select', { 'aria-label': t('Video format'), style: 'padding:7px 9px;border-radius:7px;background:var(--surface-2);color:var(--text);border:1px solid var(--stroke)' },
      h('option', { value: 'mp4' }, 'MP4 Video (.mp4)'),
      h('option', { value: 'webm' }, 'WebM Video (.webm)'));
    // WebM is the path that muxes the recording's audio. The WebCodecs MP4
    // backend currently writes video only, so a silent MP4 must not be what a
    // plain "Export video" gives by default.
    formatSelect.value = 'webm';

    const formatHint = h('p', {
      style: 'margin:0;font-size:11.5px;color:var(--text-2);display:none;'
    }, t('MP4 is exported without sound. Choose WebM to keep the recording audio.'));
    const syncFormatHint = () => { formatHint.style.display = formatSelect.value === 'mp4' ? 'block' : 'none'; };
    formatSelect.addEventListener('change', syncFormatHint);
    syncFormatHint();

    const cameraMode = h('select', { 'aria-label': t('Video framing'), style: 'padding:7px 9px;border-radius:7px;background:var(--surface-2);color:var(--text);border:1px solid var(--stroke)' },
      h('option', { value: VIDEO_CAMERA_MODES.FIXED }, t('Fixed view')),
      h('option', { value: VIDEO_CAMERA_MODES.FOLLOW }, t('Follow strokes')));
    cameraMode.value = VIDEO_CAMERA_MODES.FIXED;
    const fixedFrame = h('select', { 'aria-label': t('Fixed view area'), style: 'padding:7px 9px;border-radius:7px;background:var(--surface-2);color:var(--text);border:1px solid var(--stroke)' },
      h('option', { value: VIDEO_FIXED_FRAMES.RECORDING }, t('Recording area')),
      h('option', { value: VIDEO_FIXED_FRAMES.BOARD }, t('Whole board')));
    fixedFrame.value = VIDEO_FIXED_FRAMES.RECORDING;
    cameraMode.addEventListener('change', () => { fixedFrame.disabled = cameraMode.value !== VIDEO_CAMERA_MODES.FIXED; });

    const listContainer = h('div', {
      style: 'display:flex;flex-direction:column;gap:6px;max-height:240px;overflow-y:auto;border:1px solid var(--stroke);border-radius:8px;padding:8px;'
    });

    const renderList = () => {
      listContainer.innerHTML = '';
      items.forEach((item, idx) => {
        const isChecked = selectedIds.has(item.id);
        const formatTime = (ms) => {
          const s = Math.round((ms || 0) / 1000);
          const m = Math.floor(s / 60);
          return `${m}:${String(s % 60).padStart(2, '0')}`;
        };

        const chk = h('input', { type: 'checkbox', style: 'cursor:pointer;' });
        chk.checked = isChecked;
        chk.onchange = () => {
          if (chk.checked) selectedIds.add(item.id);
          else selectedIds.delete(item.id);
          renderList();
        };

        const nameLabel = h('span', { style: 'flex:1;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' },
          item.name || t('Recording {n}', { n: idx + 1 })
        );
        const durLabel = h('span', { style: 'font-size:12px;color:var(--text-2);margin-right:8px;' },
          formatTime(item.durationMs)
        );

        const btnUp = h('button', {
          class: 'btn', style: 'padding:2px 6px;font-size:10px;',
          disabled: idx === 0,
          onclick: () => {
            const temp = items[idx];
            items[idx] = items[idx - 1];
            items[idx - 1] = temp;
            renderList();
          }
        }, '▲');

        const btnDown = h('button', {
          class: 'btn', style: 'padding:2px 6px;font-size:10px;',
          disabled: idx === items.length - 1,
          onclick: () => {
            const temp = items[idx];
            items[idx] = items[idx + 1];
            items[idx + 1] = temp;
            renderList();
          }
        }, '▼');

        const row = h('div', {
          style: 'display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;background:var(--surface-2);'
        }, chk, nameLabel, durLabel, btnUp, btnDown);

        listContainer.appendChild(row);
      });
    };

    renderList();

    const stitchRow = h('label', { style: 'display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin-top:2px;' });
    const stitchChk = h('input', { type: 'checkbox' });
    stitchChk.checked = stitchTogether;
    stitchChk.onchange = () => { stitchTogether = stitchChk.checked; };
    stitchRow.appendChild(stitchChk);
    stitchRow.appendChild(h('span', {}, t('Stitch selected recordings into one combined video')));

    const actionRow = h('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:8px;' });
    const btnCancel = h('button', { class: 'btn', onclick: () => { overlay.remove(); resolve(null); } }, t('Cancel'));
    const btnExport = h('button', { class: 'btn primary' }, t('Export Video'));
    btnExport.onclick = () => {
      const chosen = items.filter((it) => selectedIds.has(it.id));
      if (!chosen.length) {
        app.toast(t('Select at least one recording'));
        return;
      }
      overlay.remove();
      resolve({
        tracks: chosen,
        stitch: stitchTogether,
        format: formatSelect.value,
        video: { ...VIDEO_EXPORT_PRESETS[preset.value], cameraMode: cameraMode.value, fixedFrame: fixedFrame.value }
      });
    };

    actionRow.appendChild(btnCancel);
    actionRow.appendChild(btnExport);

    card.appendChild(titleRow);
    card.appendChild(desc);
    card.appendChild(h('label', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px' },
      t('Video format'), formatSelect));
    card.appendChild(formatHint);
    card.appendChild(h('label', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px' },
      t('Video quality'), preset));
    card.appendChild(h('label', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px' },
      t('Video framing'), cameraMode));
    card.appendChild(h('label', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:13px' },
      t('Fixed view area'), fixedFrame));
    card.appendChild(listContainer);
    if (tracks.length > 1) card.appendChild(stitchRow);
    card.appendChild(actionRow);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
  });
}

/**
 * High-level helper to trigger export dialog and save video file.
 */
export async function exportVideoFile(app, track = null) {
  let selectedTracks = [];
  let shouldStitch = true;
  let video = VIDEO_EXPORT_PRESETS['1080p30'];

  const picked = await pickRecordingsForVideoExport(app, track ? [track] : null);
  if (!picked) return null;
  selectedTracks = picked.tracks;
  shouldStitch = track ? false : picked.stitch;
  video = picked.video || video;
  const format = picked.format || 'webm';
  const filterName = format === 'mp4' ? 'MP4 Video' : 'WebM Video';
  const filterExt = format === 'mp4' ? 'mp4' : 'webm';

function showBackgroundExportProgress(app, initialText, onCancel) {
  if (typeof document === 'undefined') return null;
  let banner = document.getElementById('videoExportBanner');
  if (banner) banner.remove();

  banner = document.createElement('div');
  banner.id = 'videoExportBanner';
  banner.className = 'video-export-banner';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');

  const pulse = document.createElement('div');
  pulse.className = 'veb-pulse';

  const label = document.createElement('span');
  label.className = 'veb-label';
  label.textContent = initialText || t('Exporting video…');

  const bar = document.createElement('div');
  bar.className = 'veb-bar';
  const fill = document.createElement('div');
  fill.className = 'veb-fill';
  fill.style.width = '0%';
  bar.appendChild(fill);

  const pctEl = document.createElement('span');
  pctEl.className = 'veb-pct';
  pctEl.textContent = '0%';

  const btnCancel = document.createElement('button');
  btnCancel.type = 'button';
  btnCancel.className = 'veb-cancel';
  btnCancel.title = t('Cancel export');
  btnCancel.setAttribute('aria-label', t('Cancel export'));
  btnCancel.innerHTML = '&times;';
  btnCancel.onclick = (e) => {
    e.stopPropagation();
    onCancel?.();
    banner.remove();
  };

  banner.appendChild(pulse);
  banner.appendChild(label);
  banner.appendChild(bar);
  banner.appendChild(pctEl);
  banner.appendChild(btnCancel);

  const topbar = document.getElementById('topbar');
  if (topbar) {
    topbar.appendChild(banner);
  } else {
    document.body.appendChild(banner);
  }

  return {
    update: (frac, text) => {
      const rounded = Math.round((frac || 0) * 100);
      fill.style.width = `${rounded}%`;
      pctEl.textContent = `${rounded}%`;
      if (text) label.textContent = text;
    },
    close: () => {
      banner.remove();
    }
  };
}

  if (!selectedTracks.length) return null;

  if (shouldStitch || selectedTracks.length === 1) {
    const filePath = await window.board.saveDialog({
      title: t('Save a copy'),
      defaultPath: videoExportFilename(app.store.doc.name, uniqueExportSuffix(), '', format),
      filters: [{ name: filterName, extensions: [filterExt] }]
    });
    if (!filePath) return null;

    const exporter = new VideoExporter(app);
    const wasReading = !!app.readingMode;
    // Enter reading mode so inking/editing gestures do not interfere with video capture
    app.setReadingMode(true, { silent: true });

    const exportTitle = t('Video export ({pct}%)', { pct: 0 });
    const progress = showBackgroundExportProgress(app, exportTitle, () => exporter.cancel());

    try {
      const { blob } = await exporter.exportStitchedReplayVideo({
        tracks: selectedTracks,
        ...video,
        format,
        onProgress: (pct) => {
          const rounded = Math.round(pct * 100);
          progress?.update(pct, t('Video export ({pct}%)', { pct: rounded }));
        }
      });

      if (exporter.cancelled) return null;

      const buf = await blob.arrayBuffer();
      await window.board.writeFile(filePath, new Uint8Array(buf));
      progress?.close();
      app.toast(t('Saved {name}', { name: filePath.split(/[\\/]/).pop() }));
      return filePath;
    } catch (err) {
      progress?.close();
      if (!exporter.cancelled) {
        app.toast(err.message || 'Export failed');
      }
      return null;
    } finally {
      progress?.close();
      // Restore previous mode (reading or writing)
      app.setReadingMode(wasReading, { silent: true });
    }
  } else {
    // Export each track separately
    const wasReading = !!app.readingMode;
    app.setReadingMode(true, { silent: true });
    let exporter = null;
    let progress = null;

    try {
      for (let i = 0; i < selectedTracks.length; i++) {
        const tr = selectedTracks[i];
        const safeName = (tr.name || `Recording-${i + 1}`).replace(/[^a-zA-Z0-9_\-]/g, '_');
        const filePath = await window.board.saveDialog({
          title: t('Save {name}', { name: tr.name || 'Recording' }),
          defaultPath: videoExportFilename(app.store.doc.name, uniqueExportSuffix(), safeName, format),
          filters: [{ name: filterName, extensions: [filterExt] }]
        });
        if (!filePath) continue;

        exporter = new VideoExporter(app);
        const titleStr = t('Exporting {name} ({pct}%)', { name: tr.name || '', pct: 0 });
        progress = showBackgroundExportProgress(app, titleStr, () => exporter.cancel());

        try {
          const { blob } = await exporter.exportStitchedReplayVideo({
            tracks: [tr],
            ...video,
            format,
            onProgress: (pct) => {
              const rounded = Math.round(pct * 100);
              progress?.update(pct, t('Exporting {name} ({pct}%)', { name: tr.name || '', pct: rounded }));
            }
          });
          if (!exporter.cancelled) {
            const buf = await blob.arrayBuffer();
            await window.board.writeFile(filePath, new Uint8Array(buf));
            progress?.close();
            app.toast(t('Saved {name}', { name: filePath.split(/[\\/]/).pop() }));
          }
        } catch (err) {
          progress?.close();
          if (!exporter.cancelled) app.toast(err.message || 'Export failed');
        }
      }
    } finally {
      progress?.close();
      app.setReadingMode(wasReading, { silent: true });
    }
    return true;
  }
}

