// In-App Video & YouTube Player Suite
// Supports YouTube embedding, direct video files/URLs, full-resolution frame screenshot extraction,
// instant timestamp bookmarking, timing tags, and clickable canvas bookmark cards.

import { h } from './popover.js';
import { t } from '../i18n.js';
import { centerOf, boundsOf } from '../core/store.js';

/**
 * Parse any video URL into a type, ID, and embed/thumbnail sources.
 * @param {string} rawUrl
 * @returns {{ type: 'youtube'|'direct'|'unknown', id?: string, embedUrl?: string, thumbUrl?: string, url: string }}
 */
export function parseVideoUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return { type: 'unknown', url: '' };
  const str = rawUrl.trim();

  // Block dangerous schemes strictly (XSS / protocol injection safeguard)
  if (/^(?:javascript|data:(?!video\/)|vbscript):/i.test(str)) {
    return { type: 'unknown', url: '' };
  }

  // YouTube matchers (standard watch?v=, watch?...&v=, embed/, v/, shorts/, live/, youtu.be/, m.youtube.com, music.youtube.com)
  const ytMatch = str.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/|shorts\/|live\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
  if (ytMatch) {
    const id = ytMatch[1];
    let startTime = 0;
    const timeMatch = str.match(/[?&](?:t|start)=([0-9mh]+s?|[0-9]+)/i);
    if (timeMatch) {
      const rawTime = timeMatch[1];
      if (/^\d+$/.test(rawTime)) {
        startTime = parseInt(rawTime, 10);
      } else {
        const mMatch = rawTime.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
        if (mMatch) {
          const h = parseInt(mMatch[1] || '0', 10);
          const m = parseInt(mMatch[2] || '0', 10);
          const s = parseInt(mMatch[3] || '0', 10);
          startTime = h * 3600 + m * 60 + s;
        }
      }
    }
    const startParam = startTime > 0 ? `&start=${startTime}` : '';
    return {
      type: 'youtube',
      id,
      url: str,
      startTime,
      embedUrl: `https://www.youtube-nocookie.com/embed/${id}?enablejsapi=1&autoplay=1&playsinline=1&rel=0${startParam}`,
      thumbUrl: `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
      maxThumbUrl: `https://img.youtube.com/vi/${id}/maxresdefault.jpg`
    };
  }

  // Direct video files or blob/file streams
  if (/\.(mp4|webm|ogv|mov|mkv)(\?.*)?$/i.test(str) || /^blob:|^file:|^data:video\//i.test(str)) {
    return {
      type: 'direct',
      url: str,
      thumbUrl: null
    };
  }

  // General web URL fallback - only if it is a valid HTTP/HTTPS URL
  if (/^https?:\/\/[a-zA-Z0-9-._~:/?#[\]@!$&'()*+,;=]+$/i.test(str)) {
    return {
      type: 'direct',
      url: str,
      thumbUrl: null
    };
  }

  return { type: 'unknown', url: str };
}

/** Format seconds into mm:ss or hh:mm:ss string */
export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/** Parse mm:ss or hh:mm:ss or raw seconds into integer seconds */
export function parseTimeString(str) {
  if (typeof str === 'number') return Math.max(0, str);
  if (!str || typeof str !== 'string') return 0;
  const parts = str.trim().split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return 0;
}

/**
 * Open the Insert Video / YouTube Dialog.
 * @param {object} app
 */
export function openVideoInsertDialog(app) {
  const existing = document.getElementById('videoInsertModal');
  if (existing) existing.remove();

  const backdrop = h('div', {
    id: 'videoInsertModal',
    class: 'modal-backdrop',
    style: 'position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,0.5);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;'
  });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });

  const card = h('div', {
    class: 'video-insert-card',
    style: 'background:var(--surface,#ffffff);color:var(--text,#111111);border-radius:16px;box-shadow:0 12px 32px rgba(0,0,0,0.3);border:1px solid var(--line,rgba(0,0,0,0.12));width:92%;max-width:480px;padding:20px;display:flex;flex-direction:column;gap:14px;font-family:inherit;'
  });

  const titleRow = h('div', { style: 'display:flex;align-items:center;justify-content:space-between;' },
    h('h3', { style: 'margin:0;font-size:16px;font-weight:700;' }, t('Insert Video / YouTube')),
    h('button', {
      style: 'background:none;border:none;font-size:18px;cursor:pointer;color:var(--text-2,rgba(128,128,128,0.8));',
      onclick: () => backdrop.remove()
    }, '✕')
  );

  const urlInput = h('input', {
    type: 'text',
    placeholder: t('Paste YouTube link or direct video URL (e.g. https://youtu.be/...)'),
    style: 'width:100%;box-sizing:border-box;padding:8px 12px;border-radius:8px;border:1px solid var(--line,rgba(0,0,0,0.2));background:var(--surface-2,rgba(128,128,128,0.06));color:inherit;font-size:13px;outline:none;'
  });

  const titleInput = h('input', {
    type: 'text',
    placeholder: t('Video title (optional)'),
    style: 'width:100%;box-sizing:border-box;padding:8px 12px;border-radius:8px;border:1px solid var(--line,rgba(0,0,0,0.2));background:var(--surface-2,rgba(128,128,128,0.06));color:inherit;font-size:13px;outline:none;'
  });

  const previewBox = h('div', {
    style: 'height:160px;background:var(--surface-2,rgba(128,128,128,0.08));border-radius:10px;border:1px dashed var(--line,rgba(0,0,0,0.15));display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;'
  }, h('span', { style: 'color:var(--text-2,rgba(128,128,128,0.7));font-size:12.5px;' }, t('Preview will appear here')));

  let currentParsed = null;

  const updatePreview = () => {
    const parsed = parseVideoUrl(urlInput.value);
    currentParsed = parsed;
    const oldVid = previewBox.querySelector('video');
    if (oldVid) { try { oldVid.pause(); oldVid.removeAttribute('src'); oldVid.load(); } catch (_) {} }
    previewBox.innerHTML = '';
    if (parsed.type === 'youtube') {
      const img = h('img', {
        src: parsed.thumbUrl,
        style: 'width:100%;height:100%;object-fit:cover;'
      });
      const badge = h('div', {
        style: 'position:absolute;top:8px;left:8px;background:#ff0000;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;'
      }, 'YouTube');
      previewBox.appendChild(img);
      previewBox.appendChild(badge);
    } else if (parsed.type === 'direct') {
      const vid = h('video', {
        src: parsed.url,
        style: 'width:100%;height:100%;object-fit:contain;',
        muted: true
      });
      previewBox.appendChild(vid);
    } else {
      previewBox.appendChild(h('span', { style: 'color:var(--text-2,rgba(128,128,128,0.7));font-size:12.5px;' }, t('Enter a valid YouTube or video link')));
    }
  };

  urlInput.addEventListener('input', updatePreview);

  const btnCancel = h('button', {
    class: 'btn',
    style: 'padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;',
    onclick: () => backdrop.remove()
  }, t('Cancel'));

  const btnInsert = h('button', {
    class: 'btn primary',
    style: 'padding:6px 16px;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;background:var(--accent,#0078d4);color:#ffffff;border:none;',
    onclick: () => {
      const parsed = currentParsed || parseVideoUrl(urlInput.value);
      if (!parsed || parsed.type === 'unknown' || !urlInput.value.trim()) {
        app.toast?.(t('Enter a valid YouTube or video link'));
        urlInput.focus();
        return;
      }

      const title = titleInput.value.trim() || (parsed.type === 'youtube' ? t('YouTube Video') : t('Video'));
      const center = app.surface?.cam ? app.surface.cam.toWorld(window.innerWidth / 2, window.innerHeight / 2) : { x: 0, y: 0 };
      const w = 440, h = 270;
      const x = Math.round(center.x - w / 2);
      const y = Math.round(center.y - h / 2);

      const videoObj = {
        id: 'v_' + Math.random().toString(36).slice(2, 10),
        type: 'video',
        x, y, w, h,
        url: urlInput.value.trim(),
        videoType: parsed.type,
        videoId: parsed.id || null,
        title,
        currentTime: parsed.startTime || 0,
        bookmarks: [],
        thumb: parsed.thumbUrl || null
      };

      app.store.add(videoObj, 'insert video');
      app.surface?.invalidate?.();
      backdrop.remove();
      app.toast(t('Video added to board'));
    }
  }, t('Insert on Board'));

  const actions = h('div', { style: 'display:flex;justify-content:flex-end;gap:8px;margin-top:6px;' },
    btnCancel, btnInsert
  );

  card.appendChild(titleRow);
  card.appendChild(urlInput);
  card.appendChild(titleInput);
  card.appendChild(previewBox);
  card.appendChild(actions);
  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
  setTimeout(() => urlInput.focus(), 50);
}

/** Sort video bookmarks chronologically ascending by time in seconds. */
export function sortBookmarks(bookmarks) {
  if (!Array.isArray(bookmarks)) return [];
  bookmarks.sort((a, b) => (Number(a?.time) || 0) - (Number(b?.time) || 0));
  return bookmarks;
}

/**
 * Interactive Video Player Dialog with Full-Res Screenshot & Timestamp Bookmarking
 */
export class VideoPlayerDialog {
  constructor(app, videoObj) {
    this.app = app;
    this.videoObj = videoObj;
    this.el = null;
    this.videoEl = null;
    this.parsed = parseVideoUrl(videoObj.url);
    this.currentTime = this.parsed.startTime || 0;
    this.duration = 0;
    this.isPlaying = true;
    this._ytInfoReceived = false;
    this._ytListenTimer = null;
    this._tickTimer = null;
    this._editingIdx = -1;
    this._seeking = false;
  }

  _sendYtCommand(func, args = []) {
    if (!this.iframe?.contentWindow) return false;
    try {
      this.iframe.contentWindow.postMessage(JSON.stringify({
        event: 'command',
        func,
        args
      }), '*');
      return true;
    } catch (_) {
      return false;
    }
  }

  _sendYtListening() {
    if (!this.iframe?.contentWindow) return;
    try {
      this.iframe.contentWindow.postMessage(JSON.stringify({
        event: 'listening',
        id: 1,
        channel: 'widget'
      }), '*');
      this.iframe.contentWindow.postMessage(JSON.stringify({
        event: 'command',
        func: 'addEventListener',
        args: ['onStateChange']
      }), '*');
    } catch (_) {}
  }

  _updateTransportUI() {
    if (this.timeDisplay) {
      const durText = this.duration > 0 ? ` / ${formatTime(this.duration)}` : '';
      this.timeDisplay.textContent = formatTime(this.currentTime) + durText;
    }
    if (this.scrubberEl && !this._seeking) {
      const maxDur = Math.max(this.duration || 0, Math.ceil(this.currentTime) + 10, 60);
      this.scrubberEl.max = String(maxDur);
      this.scrubberEl.value = String(Math.max(0, Math.min(maxDur, this.currentTime)));
    }
    if (this.btnPlayPause) {
      this.btnPlayPause.textContent = this.isPlaying ? '⏸' : '▶';
      this.btnPlayPause.title = this.isPlaying ? t('Pause') : t('Play');
    }
  }

  open() {
    this.close();
    const parsed = this.parsed;
    this.currentTime = parsed.startTime || 0;
    this.duration = 0;
    this.isPlaying = parsed.type !== 'unknown';
    this._ytInfoReceived = false;
    this._editingIdx = -1;

    const backdrop = h('div', {
      id: 'videoPlayerModal',
      class: 'modal-backdrop',
      style: 'position:fixed;inset:0;z-index:9600;background:rgba(0,0,0,0.65);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;padding:12px;'
    });
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) this.close();
    });

    const card = h('div', {
      class: 'video-player-card',
      style: 'background:var(--surface,#1e2227);color:var(--text,#f0f6fc);border-radius:18px;box-shadow:0 16px 48px rgba(0,0,0,0.5);border:1px solid var(--line,rgba(255,255,255,0.12));width:92%;max-width:860px;max-height:92vh;overflow-y:auto;display:flex;flex-direction:column;font-family:inherit;'
    });

    // 1. Header Bar
    const titleEl = h('b', { style: 'font-size:14.5px;max-width:640px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' },
      this.videoObj.title || t('Video Player')
    );
    const btnClose = h('button', {
      style: 'background:none;border:none;color:inherit;font-size:20px;cursor:pointer;padding:2px 8px;',
      onclick: () => this.close()
    }, '✕');
    const headBar = h('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;padding:10px 18px;border-bottom:1px solid var(--line,rgba(255,255,255,0.08));background:rgba(0,0,0,0.15);flex-shrink:0;'
    }, titleEl, btnClose);
    card.appendChild(headBar);

    // 2. Video Player Frame Container
    const playerContainer = h('div', {
      style: 'position:relative;width:100%;height:420px;min-height:240px;background:#000000;display:flex;align-items:center;justify-content:center;flex-shrink:0;'
    });

    if (parsed.type === 'youtube') {
      const iframe = h('iframe', {
        src: parsed.embedUrl,
        style: 'width:100%;height:100%;border:none;',
        allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
        allowfullscreen: 'true',
        sandbox: 'allow-scripts allow-same-origin allow-presentation allow-forms allow-popups',
        referrerpolicy: 'no-referrer-when-downgrade'
      });
      playerContainer.appendChild(iframe);
      this.iframe = iframe;

      iframe.addEventListener('load', () => {
        this._sendYtListening();
        let tries = 0;
        clearInterval(this._ytListenTimer);
        this._ytListenTimer = setInterval(() => {
          if (this._ytInfoReceived || ++tries > 12) {
            clearInterval(this._ytListenTimer);
            this._ytListenTimer = null;
            return;
          }
          this._sendYtListening();
        }, 500);
      });

      this._onWindowMessage = (e) => {
        try {
          const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
          if (!data || typeof data !== 'object') return;
          if (data.event === 'onReady') {
            this._ytInfoReceived = true;
            this._sendYtListening();
          } else if (data.event === 'infoDelivery' && data.info) {
            this._ytInfoReceived = true;
            if (typeof data.info.currentTime === 'number' && Number.isFinite(data.info.currentTime)) {
              this.currentTime = data.info.currentTime;
            }
            if (typeof data.info.duration === 'number' && Number.isFinite(data.info.duration) && data.info.duration > 0) {
              this.duration = data.info.duration;
            }
            if (typeof data.info.playerState === 'number') {
              this.isPlaying = data.info.playerState === 1;
            }
            this._updateTransportUI();
          }
        } catch (_) {}
      };
      window.addEventListener('message', this._onWindowMessage);
    } else if (parsed.type === 'direct') {
      const vid = h('video', {
        src: parsed.url,
        controls: true,
        autoplay: true,
        crossOrigin: 'anonymous',
        style: 'width:100%;height:100%;object-fit:contain;'
      });
      vid.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(vid.duration)) this.duration = vid.duration;
        this._updateTransportUI();
      });
      vid.addEventListener('timeupdate', () => {
        this.currentTime = vid.currentTime || 0;
        if (Number.isFinite(vid.duration) && vid.duration > 0) this.duration = vid.duration;
        this._updateTransportUI();
      });
      vid.addEventListener('play', () => { this.isPlaying = true; this._updateTransportUI(); });
      vid.addEventListener('pause', () => { this.isPlaying = false; this._updateTransportUI(); });
      vid.addEventListener('error', () => {
        playerContainer.innerHTML = '';
        playerContainer.appendChild(h('div', {
          style: 'color:#ff6b6b;font-size:13px;display:flex;align-items:center;gap:8px;'
        }, '⚠️ ' + t('Enter a valid YouTube or video link')));
      });
      playerContainer.appendChild(vid);
      this.videoEl = vid;
    } else {
      playerContainer.appendChild(h('div', {
        style: 'color:var(--text-2,rgba(255,255,255,0.7));font-size:13px;display:flex;flex-direction:column;align-items:center;gap:8px;'
      },
        h('span', { style: 'font-size:24px;' }, '⚠️'),
        h('span', {}, t('Enter a valid YouTube or video link')),
        h('span', { style: 'font-size:11.5px;opacity:0.6;' }, this.videoObj.url || '')
      ));
    }
    card.appendChild(playerContainer);

    // 2.5 Transport & Skip Control Bar (works on YouTube, Shorts, and direct video)
    const timeDisplay = h('span', {
      style: 'font-size:12.5px;font-variant-numeric:tabular-nums;color:var(--accent,#00e5ff);font-weight:600;min-width:90px;'
    }, formatTime(this.currentTime));
    this.timeDisplay = timeDisplay;

    const navBtnStyle = 'padding:4px 9px;border-radius:7px;border:1px solid var(--line,rgba(255,255,255,0.16));background:rgba(255,255,255,0.06);color:inherit;cursor:pointer;font-size:12px;font-weight:600;';
    const btnBack10 = h('button', { type: 'button', style: navBtnStyle, title: t('Back 10 seconds'), onclick: () => this.seekRelative(-10) }, '−10s');
    const btnBack5 = h('button', { type: 'button', style: navBtnStyle, title: t('Back 5 seconds'), onclick: () => this.seekRelative(-5) }, '−5s');
    const btnPlayPause = h('button', { type: 'button', style: navBtnStyle + ';min-width:34px;', title: t('Play / Pause'), onclick: () => this.togglePlay() }, this.isPlaying ? '⏸' : '▶');
    this.btnPlayPause = btnPlayPause;
    const btnFwd5 = h('button', { type: 'button', style: navBtnStyle, title: t('Forward 5 seconds'), onclick: () => this.seekRelative(5) }, '+5s');
    const btnFwd10 = h('button', { type: 'button', style: navBtnStyle, title: t('Forward 10 seconds'), onclick: () => this.seekRelative(10) }, '+10s');

    const scrubberEl = h('input', {
      type: 'range',
      min: '0',
      max: String(Math.max(60, Math.ceil(this.currentTime) + 10)),
      value: String(this.currentTime),
      step: '1',
      style: 'flex:1;min-width:120px;accent-color:var(--accent,#00e5ff);cursor:pointer;',
      'aria-label': t('Seek video')
    });
    scrubberEl.addEventListener('pointerdown', () => { this._seeking = true; });
    scrubberEl.addEventListener('input', () => {
      const v = Number(scrubberEl.value) || 0;
      timeDisplay.textContent = formatTime(v) + (this.duration > 0 ? ` / ${formatTime(this.duration)}` : '');
    });
    scrubberEl.addEventListener('change', () => {
      this._seeking = false;
      this.seekTo(Number(scrubberEl.value) || 0);
    });
    this.scrubberEl = scrubberEl;

    const transportBar = h('div', {
      style: 'display:flex;align-items:center;gap:6px;padding:8px 18px;background:rgba(0,0,0,0.28);border-bottom:1px solid var(--line,rgba(255,255,255,0.08));flex-wrap:wrap;flex-shrink:0;'
    }, btnBack10, btnBack5, btnPlayPause, btnFwd5, btnFwd10, scrubberEl, timeDisplay);
    card.appendChild(transportBar);

    // 3. Action Toolbar: Quick/Custom Bookmark, Screenshot, Markdown Link, Explicit Pin
    const actionToolbar = h('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;padding:10px 18px;background:rgba(0,0,0,0.16);border-bottom:1px solid var(--line,rgba(255,255,255,0.08));flex-wrap:wrap;gap:8px;flex-shrink:0;'
    });

    const isQuick = () => this.app.settings?.videoQuickBookmark !== false;

    const btnScreenshot = h('button', {
      class: 'btn',
      title: t('Extract full-resolution native frame screenshot onto whiteboard'),
      style: 'display:flex;align-items:center;gap:6px;padding:6px 11px;border-radius:8px;border:1px solid var(--line,rgba(255,255,255,0.18));background:rgba(255,255,255,0.06);color:inherit;cursor:pointer;font-size:12.5px;font-weight:600;',
      onclick: () => this.extractScreenshot()
    }, '📷 ' + t('Full-Res Screenshot'));

    const btnBookmark = h('button', {
      class: 'btn',
      title: t('Bookmark current video timestamp'),
      style: 'display:flex;align-items:center;gap:6px;padding:6px 11px;border-radius:8px;border:1px solid var(--line,rgba(255,255,255,0.18));background:rgba(0,229,255,0.14);color:inherit;cursor:pointer;font-size:12.5px;font-weight:600;',
      onclick: () => this.addTimestampBookmark()
    }, '🔖 ' + t('Bookmark Timestamp'));

    const quickChk = h('input', { type: 'checkbox', style: 'cursor:pointer;margin:0;' });
    quickChk.checked = isQuick();
    quickChk.addEventListener('change', () => {
      this.app.settings.videoQuickBookmark = quickChk.checked;
      this.app.saveSettings();
      if (!quickChk.checked) customForm.style.display = 'flex';
      else customForm.style.display = 'none';
    });
    const quickToggleLabel = h('label', {
      style: 'display:inline-flex;align-items:center;gap:5px;font-size:12px;opacity:0.88;cursor:pointer;user-select:none;padding:4px 8px;border-radius:7px;border:1px solid var(--line,rgba(255,255,255,0.12));background:rgba(255,255,255,0.04);',
      title: t('Quick mode captures the current time immediately; turn off to type a custom time and title first')
    }, quickChk, h('span', {}, t('Quick 1-click')));

    const btnCopyMarkdown = h('button', {
      class: 'btn',
      title: t('Copy Markdown timestamp link to clipboard'),
      style: 'display:flex;align-items:center;gap:6px;padding:6px 11px;border-radius:8px;border:1px solid var(--line,rgba(255,255,255,0.18));background:rgba(255,255,255,0.06);color:inherit;cursor:pointer;font-size:12.5px;font-weight:600;',
      onclick: () => this.copyMarkdownTimestamp()
    }, '📋 ' + t('Copy Markdown Link'));

    const btnStampCard = h('button', {
      class: 'btn',
      title: t('Place clickable timestamp card onto the board'),
      style: 'display:flex;align-items:center;gap:6px;padding:6px 11px;border-radius:8px;border:1px solid var(--line,rgba(255,255,255,0.18));background:rgba(255,255,255,0.06);color:inherit;cursor:pointer;font-size:12.5px;font-weight:600;',
      onclick: () => this.stampBookmarkCard()
    }, '📌 ' + t('Pin card'));

    actionToolbar.appendChild(h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;' }, btnBookmark, quickToggleLabel, btnScreenshot));
    actionToolbar.appendChild(h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;' }, btnCopyMarkdown, btnStampCard));
    card.appendChild(actionToolbar);

    // Inline Custom Bookmark Row (no window.prompt)
    const inputStyle = 'padding:5px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:rgba(0,0,0,0.3);color:inherit;font-size:12.5px;';
    const customTimeInput = h('input', { type: 'text', placeholder: '00:00', style: inputStyle + ';width:78px;' });
    const customLabelInput = h('input', { type: 'text', placeholder: t('Bookmark title…'), style: inputStyle + ';flex:1;min-width:150px;' });
    const btnCustomSave = h('button', {
      type: 'button',
      class: 'btn primary',
      style: 'padding:5px 12px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;',
      onclick: () => {
        const sec = Math.max(0, parseTimeString(customTimeInput.value));
        const label = customLabelInput.value.trim() || t('Moment at {time}', { time: formatTime(sec) });
        this._saveBookmark(sec, label);
        customLabelInput.value = '';
        customTimeInput.value = formatTime(this.currentTime);
      }
    }, t('Add Bookmark'));
    const customForm = h('div', {
      style: `display:${isQuick() ? 'none' : 'flex'};align-items:center;gap:8px;padding:8px 18px;background:rgba(255,255,255,0.03);border-bottom:1px solid var(--line,rgba(255,255,255,0.08));flex-wrap:wrap;flex-shrink:0;`
    },
      h('span', { style: 'font-size:12px;opacity:0.75;' }, t('Time:')),
      customTimeInput,
      customLabelInput,
      btnCustomSave
    );
    this.customFormEl = customForm;
    this.customTimeInput = customTimeInput;
    this.customLabelInput = customLabelInput;
    customLabelInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); btnCustomSave.click(); }
    });
    card.appendChild(customForm);

    // 4. Bookmarks & Timing Tags Drawer (scrollable & auto-sorted)
    const bookmarkSection = h('div', {
      style: 'padding:12px 18px;display:flex;flex-direction:column;gap:8px;flex-shrink:0;'
    });
    this.bookmarkListEl = h('div', {
      style: 'display:flex;flex-direction:column;gap:6px;max-height:190px;overflow-y:auto;padding-right:4px;'
    });
    bookmarkSection.appendChild(h('span', { style: 'font-size:12px;font-weight:600;color:var(--text-2,rgba(255,255,255,0.6));' }, t('Timestamp Bookmarks (Click to seek · Chronological):')));
    bookmarkSection.appendChild(this.bookmarkListEl);
    card.appendChild(bookmarkSection);

    this.renderBookmarks();
    this._updateTransportUI();

    backdrop.appendChild(card);
    document.body.appendChild(backdrop);
    this.el = backdrop;

    this._onKeyDown = (e) => {
      if (e.key === 'Escape') this.close();
    };
    window.addEventListener('keydown', this._onKeyDown);
  }

  close() {
    if (this._onKeyDown) {
      window.removeEventListener('keydown', this._onKeyDown);
      this._onKeyDown = null;
    }
    if (this._ytListenTimer) {
      clearInterval(this._ytListenTimer);
      this._ytListenTimer = null;
    }
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    if (this._onWindowMessage) {
      window.removeEventListener('message', this._onWindowMessage);
      this._onWindowMessage = null;
    }
    if (this.videoEl) {
      try {
        this.videoEl.pause();
        this.videoEl.removeAttribute('src');
        this.videoEl.load();
      } catch (_) {}
      this.videoEl = null;
    }
    if (this.iframe) {
      try {
        this.iframe.src = 'about:blank';
        this.iframe.remove();
      } catch (_) {}
      this.iframe = null;
    }
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }

  renderBookmarks() {
    if (!this.bookmarkListEl) return;
    this.bookmarkListEl.innerHTML = '';
    const bookmarks = sortBookmarks(Array.isArray(this.videoObj.bookmarks) ? this.videoObj.bookmarks : []);
    if (!bookmarks.length) {
      this.bookmarkListEl.appendChild(h('small', { style: 'color:var(--text-2,rgba(255,255,255,0.45));font-style:italic;' }, t('No bookmarks added yet. Press "Bookmark Timestamp" while playing.')));
      return;
    }

    for (let i = 0; i < bookmarks.length; i++) {
      const bm = bookmarks[i];
      const pill = h('div', {
        style: 'display:flex;align-items:center;gap:8px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.13);border-radius:10px;padding:6px 10px;font-size:12.5px;'
      });
      const tag = h('button', {
        type: 'button',
        style: 'background:rgba(0,229,255,0.14);border:1px solid rgba(0,229,255,0.3);border-radius:6px;padding:2px 7px;font-weight:700;color:var(--accent,#00e5ff);cursor:pointer;font-size:12px;font-variant-numeric:tabular-nums;flex-shrink:0;',
        title: t('Seek to {time}', { time: formatTime(bm.time) }),
        onclick: () => this.seekTo(bm.time)
      }, formatTime(bm.time));

      if (this._editingIdx === i) {
        const titleInput = h('input', {
          type: 'text',
          value: bm.label || '',
          style: 'flex:1;min-width:120px;padding:3px 7px;border-radius:6px;border:1px solid rgba(0,229,255,0.5);background:rgba(0,0,0,0.35);color:inherit;font-size:12.5px;'
        });
        const commitRename = () => {
          const val = titleInput.value.trim();
          if (val) {
            this.videoObj.bookmarks[i].label = val;
            this.app.store.update(this.videoObj.id, { bookmarks: this.videoObj.bookmarks.map((x) => ({ ...x })) }, 'rename bookmark');
            this.app.surface?.invalidate?.();
          }
          this._editingIdx = -1;
          this.renderBookmarks();
        };
        titleInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this._editingIdx = -1; this.renderBookmarks(); }
        });
        const btnSave = h('button', {
          type: 'button',
          style: 'background:rgba(0,229,255,0.2);border:1px solid rgba(0,229,255,0.4);color:inherit;border-radius:6px;padding:2px 8px;cursor:pointer;font-size:12px;',
          onclick: commitRename
        }, '✓');
        pill.appendChild(tag);
        pill.appendChild(titleInput);
        pill.appendChild(btnSave);
        setTimeout(() => { titleInput.focus(); titleInput.select(); }, 20);
      } else {
        const label = h('span', {
          style: 'flex:1;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
          title: t('Click to seek · double-click to edit'),
          onclick: () => this.seekTo(bm.time),
          ondblclick: () => { this._editingIdx = i; this.renderBookmarks(); }
        }, bm.label || t('Moment at {time}', { time: formatTime(bm.time) }));
        const btnEdit = h('button', {
          type: 'button',
          style: 'background:none;border:none;color:rgba(255,255,255,0.6);font-size:12px;cursor:pointer;padding:2px 4px;',
          title: t('Edit bookmark title'),
          onclick: (e) => { e.stopPropagation(); this._editingIdx = i; this.renderBookmarks(); }
        }, '✎');
        const btnPin = h('button', {
          type: 'button',
          style: 'background:none;border:none;color:rgba(255,255,255,0.6);font-size:12px;cursor:pointer;padding:2px 4px;',
          title: t('Pin timestamp card on board'),
          onclick: (e) => { e.stopPropagation(); this.stampBookmarkCard(bm.time, bm.label); }
        }, '📌');
        const btnDel = h('button', {
          type: 'button',
          style: 'background:none;border:none;color:rgba(255,255,255,0.5);font-size:12px;cursor:pointer;padding:2px 4px;',
          title: t('Delete bookmark'),
          onclick: (e) => {
            e.stopPropagation();
            this.removeBookmark(i);
          }
        }, '✕');

        pill.appendChild(tag);
        pill.appendChild(label);
        pill.appendChild(btnEdit);
        pill.appendChild(btnPin);
        pill.appendChild(btnDel);
      }
      this.bookmarkListEl.appendChild(pill);
    }
  }

  togglePlay() {
    if (this.videoEl) {
      if (this.videoEl.paused) { this.videoEl.play?.(); this.isPlaying = true; }
      else { this.videoEl.pause?.(); this.isPlaying = false; }
      this._updateTransportUI();
      return;
    }
    if (this.iframe) {
      const nextPlay = !this.isPlaying;
      this._sendYtCommand(nextPlay ? 'playVideo' : 'pauseVideo', []);
      this.isPlaying = nextPlay;
      this._updateTransportUI();
    }
  }

  seekRelative(delta) {
    const base = Number.isFinite(this.currentTime) ? this.currentTime : 0;
    const maxCap = this.duration > 0 ? this.duration : base + Math.max(0, delta);
    const target = Math.max(0, Math.min(maxCap, Math.floor(base + delta)));
    this.seekTo(target);
  }

  seekTo(seconds) {
    const target = Math.max(0, Number(seconds) || 0);
    if (this.videoEl) {
      this.videoEl.currentTime = target;
      this.videoEl.play?.();
    } else if (this.iframe && this.parsed.id) {
      const posted = this._sendYtCommand('seekTo', [target, true]);
      if (posted) {
        this._sendYtCommand('playVideo', []);
      } else {
        this.iframe.src = `https://www.youtube-nocookie.com/embed/${this.parsed.id}?enablejsapi=1&autoplay=1&playsinline=1&rel=0&start=${Math.floor(target)}`;
      }
    }
    this.currentTime = target;
    this._updateTransportUI();
  }

  _saveBookmark(tSec, label) {
    if (!Array.isArray(this.videoObj.bookmarks)) this.videoObj.bookmarks = [];
    const sec = Math.max(0, Math.floor(Number(tSec) || 0));
    this.videoObj.bookmarks.push({ time: sec, label: String(label || '').trim() || t('Moment at {time}', { time: formatTime(sec) }) });
    sortBookmarks(this.videoObj.bookmarks);

    this.app.store.update(this.videoObj.id, { bookmarks: this.videoObj.bookmarks.map((x) => ({ ...x })) }, 'add bookmark');
    this.renderBookmarks();
    this.app.toast(t('Bookmark added: [{time}]', { time: formatTime(sec) }));
    this.app.surface?.invalidate?.();
  }

  addTimestampBookmark() {
    const tSec = Math.max(0, Math.floor(this.currentTime || 0));
    if (this.app.settings?.videoQuickBookmark === false) {
      if (this.customFormEl) this.customFormEl.style.display = 'flex';
      if (this.customTimeInput) this.customTimeInput.value = formatTime(tSec);
      this.customLabelInput?.focus();
      return;
    }
    this._saveBookmark(tSec, t('Moment at {time}', { time: formatTime(tSec) }));
  }

  removeBookmark(idx) {
    if (!Array.isArray(this.videoObj.bookmarks)) return;
    this.videoObj.bookmarks.splice(idx, 1);
    this.app.store.update(this.videoObj.id, { bookmarks: this.videoObj.bookmarks.map((x) => ({ ...x })) }, 'remove bookmark');
    this.renderBookmarks();
    this.app.surface?.invalidate?.();
  }

  copyMarkdownTimestamp() {
    const tSec = Math.floor(this.currentTime);
    const timeStr = formatTime(tSec);
    let mdLink = '';
    if (this.parsed.type === 'youtube') {
      mdLink = `[${timeStr} - ${this.videoObj.title || 'Video'}](https://youtu.be/${this.parsed.id}?t=${tSec})`;
    } else {
      mdLink = `[${timeStr} - ${this.videoObj.title || 'Video'}](video://${this.videoObj.id}?t=${tSec})`;
    }
    navigator.clipboard?.writeText?.(mdLink);
    this.app.toast(t('Markdown link copied: {link}', { link: mdLink }));
  }

  stampBookmarkCard(customTime = null, customLabel = null) {
    const tSec = Math.max(0, Math.floor(customTime != null ? customTime : (this.currentTime || 0)));
    const timeStr = formatTime(tSec);
    const b = boundsOf(this.videoObj) || this.videoObj;
    const bmCount = (this.videoObj.bookmarks || []).length;
    const cardX = b.x + b.w + 24;
    const cardY = b.y + bmCount * 46;
    const heading = customLabel ? `${customLabel} (${this.videoObj.title || t('Video')})` : (this.videoObj.title || t('Video'));

    const noteObj = {
      id: 'n_' + Math.random().toString(36).slice(2, 10),
      type: 'note',
      x: cardX,
      y: cardY,
      w: 220,
      h: 80,
      color: '#fff3b0',
      text: `📌 **[${timeStr}]** ${heading}\n[Jump to time](video://${this.videoObj.id}?t=${tSec})`
    };

    this.app.store.add(noteObj, 'stamp bookmark card');
    this.app.surface?.invalidate?.();
    this.app.toast(t('Bookmark card dropped onto board at [{time}]', { time: timeStr }));
  }

  async extractScreenshot() {
    if (!this.el) return;
    if (this.videoEl && this.videoEl.videoWidth > 0) {
      // Direct HTML5 video element: capture native uncompressed frame resolution!
      try {
        const offCanvas = document.createElement('canvas');
        offCanvas.width = this.videoEl.videoWidth;
        offCanvas.height = this.videoEl.videoHeight;
        const ctx = offCanvas.getContext('2d');
        ctx.drawImage(this.videoEl, 0, 0, offCanvas.width, offCanvas.height);
        const dataUrl = offCanvas.toDataURL('image/jpeg', 0.95);

        this.insertScreenshotOnBoard(dataUrl, offCanvas.width, offCanvas.height);
        return;
      } catch (err) {
        console.warn('Direct canvas draw error:', err);
      }
    }

    // YouTube or fallback: fetch high-res thumbnail frame
    if (this.parsed.type === 'youtube' && this.parsed.id) {
      const maxUrl = `https://img.youtube.com/vi/${this.parsed.id}/maxresdefault.jpg`;
      const hqUrl = `https://img.youtube.com/vi/${this.parsed.id}/hqdefault.jpg`;

      // Try fetching maxres image
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        if (!this.el) return;
        const offCanvas = document.createElement('canvas');
        offCanvas.width = img.naturalWidth || 1280;
        offCanvas.height = img.naturalHeight || 720;
        const ctx = offCanvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const dataUrl = offCanvas.toDataURL('image/jpeg', 0.92);
        this.insertScreenshotOnBoard(dataUrl, offCanvas.width, offCanvas.height);
      };
      img.onerror = () => {
        if (!this.el) return;
        // Fallback to hqUrl
        const img2 = new Image();
        img2.crossOrigin = 'anonymous';
        img2.onload = () => {
          if (!this.el) return;
          const offCanvas = document.createElement('canvas');
          offCanvas.width = img2.naturalWidth || 480;
          offCanvas.height = img2.naturalHeight || 360;
          const ctx = offCanvas.getContext('2d');
          ctx.drawImage(img2, 0, 0);
          this.insertScreenshotOnBoard(offCanvas.toDataURL('image/jpeg', 0.92), offCanvas.width, offCanvas.height);
        };
        img2.src = hqUrl;
      };
      img.src = maxUrl;
      return;
    }

    this.app.toast(t('Could not capture frame at this time'));
  }

  insertScreenshotOnBoard(dataUrl, nativeW, nativeH) {
    const b = boundsOf(this.videoObj) || this.videoObj;
    const targetW = 380;
    const targetH = Math.round(targetW * (nativeH / nativeW));
    const targetX = b.x + b.w + 20;
    const targetY = b.y;

    const imgObj = {
      id: 'img_' + Math.random().toString(36).slice(2, 10),
      type: 'image',
      x: targetX,
      y: targetY,
      w: targetW,
      h: targetH,
      src: dataUrl,
      name: `${this.videoObj.title || 'Video'} - [${formatTime(this.currentTime)}]`
    };

    this.app.store.add(imgObj, 'video screenshot');
    this.app.surface?.invalidate?.();
    this.app.toast(t('Full-res screenshot ({width}×{height}) placed on board', { width: nativeW, height: nativeH }));
  }
}
