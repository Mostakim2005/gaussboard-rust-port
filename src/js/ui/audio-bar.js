// Floating draggable AudioBar HUD.
// Houses playback controls, elapsed/total clock, speed selector, density scrubber, and bookmarks.

import { h } from './popover.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';
import { DensityCanvas } from './density-canvas.js';
import { replayDisplayMode } from '../core/replay-clock.js';
import { boardAssetUrl } from '../core/util.js';

export function formatTime(ms) {
  if (!(ms > 0)) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function cloneAudioTracks(tracks) {
  return (tracks || []).map((item) => ({
    ...item,
    bookmarks: Array.isArray(item.bookmarks) ? item.bookmarks.map((bm) => ({ ...bm })) : []
  }));
}

export function trackMenuPosition(anchor, menu, viewport) {
  const margin = 10;
  const below = viewport.height - anchor.bottom - margin;
  const above = anchor.top - margin;
  const placeBelow = below >= Math.min(menu.height, 180) || below >= above;
  const maxHeight = Math.max(80, Math.min(menu.height, placeBelow ? below : above));
  const top = placeBelow
    ? Math.min(viewport.height - maxHeight - margin, anchor.bottom + 4)
    : Math.max(margin, anchor.top - maxHeight - 4);
  const left = Math.max(margin, Math.min(viewport.width - menu.width - margin, anchor.right - menu.width));
  return { left, top, maxHeight };
}

export function sessionMenuPosition(anchor, menu, viewport) {
  const margin = 12;
  const vw = viewport?.width || 1024;
  const vh = viewport?.height || 768;
  const mw = menu?.width || 300;
  const mh = menu?.height || 420;

  const spaceBelow = vh - anchor.bottom - margin;
  const spaceAbove = anchor.top - margin;

  // Decide whether to place below or above based on available free space
  let placeBelow = true;
  if (spaceBelow < 180 && spaceAbove > spaceBelow) {
    placeBelow = false;
  } else if (spaceBelow >= 180) {
    placeBelow = true;
  } else {
    placeBelow = spaceBelow >= spaceAbove;
  }

  const availableHeight = placeBelow ? spaceBelow : spaceAbove;
  const maxHeight = Math.max(100, Math.min(mh, Math.max(availableHeight, 160), vh - margin * 2));

  let top = placeBelow ? anchor.bottom + 6 : anchor.top - maxHeight - 6;
  top = Math.max(margin, Math.min(vh - maxHeight - margin, top));

  let left = anchor.left;
  if (left + mw > vw - margin) {
    left = Math.max(margin, anchor.right - mw);
  }
  left = Math.max(margin, Math.min(vw - mw - margin, left));

  return { left, top, maxHeight };
}

export class AudioBar {
  /**
   * @param {object} app Main application instance
   * @param {HTMLElement} [host] Host container to float over (defaults to #stage or body)
   */
  constructor(app, host = null) {
    this.app = app;
    this.host = host || (typeof document !== 'undefined' ? document.getElementById('stage') || document.body : null);
    this.track = null;
    this.el = null;
    this.box = { x: 24, y: 72 };
    this.speeds = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
    this.speedIdx = 2; // 1.0x
    this.skipIntervals = [5, 10, 15, 30];
    this.skipIdx = 1; // 10s default
    this._interval = null;
    this._lastPlayActive = null;
    this._sessionMenuEl = null;
    this._sessionMenuDismiss = null;
    this.replayModeSelect = null;

    this.density = new DensityCanvas({
      width: 220,
      height: 24,
      onSeek: (ms) => this.seek(ms),
      onBookmarkRenamed: (bm, prevName = '') => {
        if (this.app?.store) {
          const after = cloneAudioTracks(this.app.store.doc?.audioTracks);
          const before = cloneAudioTracks(this.app.store.doc?.audioTracks).map((tr) => ({
            ...tr,
            bookmarks: (tr.bookmarks || []).map((b) => (b.id === bm?.id ? { ...b, name: prevName } : b))
          }));
          this.app.store.commit?.('rename bookmark', [{ t: 'doc', before: { audioTracks: before }, after: { audioTracks: after } }]);
        }
      }
    });
  }

  get visible() {
    return !!(this.el && this.el.style.display !== 'none');
  }

  open(track) {
    if (!track) return;
    this.track = track;
    if (!this.el) this.build();
    if (this.host && this.el.parentNode !== this.host) {
      this.host.appendChild(this.el);
    }
    this.el.style.display = 'flex';
    this.place();

    if (this.app?.replayEngine) {
      this.app.replayEngine.loadTrack(track);
    }

    this.startClock();
    this.syncUI();
    this.app?.updateHudLayout?.('audioBar');
  }

  setWaveformBuffer(buf) {
    if (this.density) {
      this.density.setAudioBuffer(buf);
    }
  }

  close() {
    if (this.app?.replayEngine?.active) {
      this.app.replayEngine.pause();
    }
    this.stopClock();
    this.closeSessionMenu();
    if (this.el) {
      this.el.style.display = 'none';
    }
    if (this.app?.surface) {
      this.app.surface._ink = null;
      this.app.surface.invalidate();
    }
    this.app?.updateHudLayout?.();
  }

  toggle(track) {
    if (this.visible && this.track?.id === track?.id) {
      this.close();
    } else {
      this.open(track);
    }
  }

  seek(ms) {
    if (this.app?.replayEngine) {
      this.app.replayEngine.seek(ms);
    }
    this.syncUI();
  }

  async togglePlay() {
    const replay = this.app?.replayEngine;
    if (!replay) return;
    try {
      if (replay.active) {
        replay.pause();
      } else {
        await replay.play();
      }
    } catch (e) {
      console.warn('Playback error:', e);
      this.app?.toast?.(t('Could not play this recording.'));
    }
    this.syncUI();
  }

  get skipSeconds() {
    return this.skipIntervals[this.skipIdx];
  }

  cycleSkip() {
    this.skipIdx = (this.skipIdx + 1) % this.skipIntervals.length;
    this.syncUI();
  }

  cycleSpeed() {
    this.speedIdx = (this.speedIdx + 1) % this.speeds.length;
    const spd = this.speeds[this.speedIdx];
    if (this.app?.replayEngine) {
      this.app.replayEngine.setSpeed(spd);
    }
    this.syncUI();
  }

  toggleGhostMode() {
    const replay = this.app?.replayEngine;
    if (!replay) return;
    const next = replay.ghostMode === 'translucent' ? 'hidden' : 'translucent';
    replay.setGhostMode(next);
    this.syncUI();
  }

  setAudioInkSync(enabled) {
    this.app.settings.audioInkSync = !!enabled;
    this.app.saveSettings();
    if (this.app.surface) { this.app.surface._ink = null; this.app.surface.invalidate(); }
    this.syncUI();
  }

  setCameraFollow(enabled) {
    this.app.settings.replayCameraFollow = !!enabled;
    this.app.replayEngine?.setCameraFollow?.(enabled);
    this.app.saveSettings();
    this.syncUI();
  }

  updateReplayStyle(key, value) {
    this.app.settings[key] = value;
    this.app.saveSettings();
    if (this.app.surface) { this.app.surface._ink = null; this.app.surface.invalidate(); }
  }

  addBookmark() {
    const replay = this.app?.replayEngine;
    if (!replay || !this.track) return;
    const tMs = Math.round(replay.currentTimeMs);
    const before = cloneAudioTracks(this.app?.store?.doc?.audioTracks);
    if (!Array.isArray(this.track.bookmarks)) {
      this.track.bookmarks = [];
    }
    this.track.bookmarks.push({
      id: 'bm_' + Date.now(),
      t: tMs,
      name: ''
    });
    // Persist bookmark in store document
    if (this.app?.store) {
      const after = cloneAudioTracks(this.app.store.doc?.audioTracks);
      this.app.store.commit?.('add bookmark', [{ t: 'doc', before: { audioTracks: before }, after: { audioTracks: after } }]);
    }
    this.syncUI();
  }

  startClock() {
    this.stopClock();
    this._interval = setInterval(() => this.syncUI(), 100);
  }

  stopClock() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  closeSessionMenu() {
    if (this._sessionMenuDismiss && typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', this._sessionMenuDismiss);
      this._sessionMenuDismiss = null;
    }
    if (this._sessionMenuEl) {
      this._sessionMenuEl.remove();
      this._sessionMenuEl = null;
    }
    this.replayModeSelect = null;
  }

  openSkipMenu() {
    const existing = document.getElementById('abSkipMenu');
    if (existing) { existing.remove(); return; }
    const menu = h('div', {
      id: 'abSkipMenu',
      style: 'position:absolute;bottom:calc(100% + 8px);left:60px;z-index:1020;background:var(--surface,#1f2328);color:var(--text,#ffffff);border:1px solid var(--line,rgba(255,255,255,0.15));border-radius:12px;padding:6px;display:flex;gap:6px;box-shadow:0 6px 20px rgba(0,0,0,0.35);user-select:none;'
    });
    for (let i = 0; i < this.skipIntervals.length; i++) {
      const sec = this.skipIntervals[i];
      const isCur = i === this.skipIdx;
      const b = h('button', {
        style: `padding:4px 8px;border-radius:8px;border:none;cursor:pointer;font-size:11.5px;font-weight:700;background:${isCur ? 'var(--accent,#0078d4)' : 'rgba(128,128,128,0.15)'};color:${isCur ? '#ffffff' : 'inherit'};`,
        onclick: (ev) => {
          ev.stopPropagation();
          this.skipIdx = i;
          this.syncUI();
          menu.remove();
        }
      }, `${sec}s`);
      menu.appendChild(b);
    }
    const dismiss = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        window.removeEventListener('pointerdown', dismiss);
      }
    };
    window.addEventListener('pointerdown', dismiss);
    this.el?.appendChild(menu);
  }

  insertTrackIntoNote(tr) {
    if (!tr) return;
    const cam = this.app?.surface?.cam;
    const view = cam ? cam.viewport(this.app.surface.width, this.app.surface.height) : { x: 0, y: 0, w: 800, h: 600 };
    const audioObj = {
      id: 'aud_' + Date.now(),
      type: 'audio',
      trackId: tr.id,
      assetId: tr.assetId,
      name: tr.name || 'Audio Recording',
      durationMs: tr.durationMs || 0,
      x: Math.round(view.x + view.w / 2 - 130),
      y: Math.round(view.y + view.h / 2 - 36),
      w: 260,
      h: 72,
      rotation: 0
    };
    if (this.app?.store) {
      this.app.store.addMany([audioObj], 'insert audio card');
      this.app.setSelection([audioObj.id]);
      this.app.toast(t('Recording inserted onto board'));
    }
    this.closeSessionMenu();
  }

  async exportTrackAudio(tr) {
    if (!tr) return;
    let objectUrl = null;
    try {
      const url = boardAssetUrl(tr.assetId);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Audio download failed (${resp.status})`);
      const blob = await resp.blob();
      const a = document.createElement('a');
      objectUrl = URL.createObjectURL(blob);
      a.href = objectUrl;
      a.download = `${tr.name || 'recording'}.webm`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Give the browser time to start the download before releasing its URL.
      setTimeout(() => { if (objectUrl) URL.revokeObjectURL(objectUrl); }, 1000);
      objectUrl = null;
      this.app.toast(t('Exported audio recording'));
    } catch (e) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      this.app.toast(t('Export audio error: ') + e.message);
    }
    this.closeSessionMenu();
  }

  async renameTrack(tr) {
    if (!tr) return;
    const store = this.app?.store;
    const tracks = store?.doc?.audioTracks || [];
    const current = tracks.find((item) => item.id === tr.id) || tr;
    const newName = await this.app?.askText?.(t('Rename recording'), '', {
      value: current.name || '', placeholder: current.name || '', ok: t('Save')
    });
    if (newName && newName.trim() && newName.trim() !== (current.name || '')) {
      const before = store?.doc?.audioTracks || [];
      const after = before.map((item) => ({ ...item, bookmarks: item.bookmarks?.map((bookmark) => ({ ...bookmark })) }))
        .map((item) => item.id === tr.id ? { ...item, name: newName.trim() } : item);
      if (store) store.commit('rename recording', [{ t: 'doc', before: { audioTracks: before }, after: { audioTracks: after } }]);
      this.track = after.find((item) => item.id === tr.id) || this.track;
      if (this.app?.replayEngine?.track?.id === tr.id) this.app.replayEngine.track = this.track;
      this.syncUI();
      this.closeSessionMenu();
      this.toggleSessionMenu();
      return;
    }
    this.closeSessionMenu();
  }

  async deleteTrack(tr) {
    if (!tr) return;
    const msg = t('Delete recording "{name}"?', { name: tr.name || t('Recording') });
    const confirmed = this.app?.confirm
      ? await this.app.confirm(t('Delete recording?'), msg, t('Delete'))
      : (typeof confirm === 'function' ? confirm(msg) : true);
    if (confirmed) {
      const list = this.app?.store?.doc?.audioTracks || [];
      const idx = list.findIndex((item) => item.id === tr.id);
      if (idx >= 0) {
        const before = cloneAudioTracks(list);
        list.splice(idx, 1);
        const after = cloneAudioTracks(list);
        if (this.track?.id === tr.id) {
          this.close();
          if (list.length > 0) this.open(list[0]);
        }
        if (this.app?.store) {
          this.app.store.commit('delete recording', [{ t: 'doc', before: { audioTracks: before }, after: { audioTracks: after } }]);
        }
        this.syncUI();
        this.closeSessionMenu();
      }
    }
  }

  showTrackContextMenu(tr, anchorEl) {
    const existing = document.getElementById('abTrackMenu');
    if (existing) existing.remove();

    const menu = h('div', {
      id: 'abTrackMenu',
      style: 'position:fixed;z-index:var(--z-popover, 45);background:var(--surface,#1f2328);color:var(--text,#ffffff);border:1px solid var(--line,rgba(255,255,255,0.18));border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.38);padding:6px;min-width:210px;max-width:min(280px,calc(100vw - 20px));overflow-y:auto;display:flex;flex-direction:column;gap:4px;user-select:none;'
    });

    let dismiss = null;
    const item = (label, iconStr, action, danger = false) => {
      const row = h('div', {
        style: `display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;cursor:pointer;font-size:12.5px;font-weight:500;color:${danger ? '#ff5252' : 'inherit'};`,
        html: `<span>${iconStr}</span><span>${label}</span>`
      });
      row.addEventListener('mouseenter', () => { row.style.background = danger ? 'rgba(255,82,82,0.15)' : 'rgba(128,128,128,0.15)'; });
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
      row.addEventListener('click', (ev) => {
        ev.stopPropagation();
        menu.remove();
        window.removeEventListener('pointerdown', dismiss);
        action();
      });
      return row;
    };

    menu.appendChild(item(t('Insert the recording into the note'), '🎙️➕', () => this.insertTrackIntoNote(tr)));
    menu.appendChild(item(t('Export audio'), '🎧', () => this.exportTrackAudio(tr)));
    menu.appendChild(item(t('Rename'), '✏️', () => this.renameTrack(tr)));
    menu.appendChild(item(t('Delete'), '❌', () => this.deleteTrack(tr), true));

    document.body.appendChild(menu);
    const rect = anchorEl.getBoundingClientRect();
    const fitted = trackMenuPosition(rect, { width: menu.offsetWidth || 220, height: menu.offsetHeight || 190 }, {
      width: window.innerWidth, height: window.innerHeight
    });
    menu.style.left = `${fitted.left}px`;
    menu.style.top = `${fitted.top}px`;
    menu.style.maxHeight = `${fitted.maxHeight}px`;

    dismiss = (ev) => {
      if (!menu.contains(ev.target) && !anchorEl.contains?.(ev.target) && ev.target !== anchorEl) {
        menu.remove();
        window.removeEventListener('pointerdown', dismiss);
      }
    };
    window.addEventListener('pointerdown', dismiss);
  }

  toggleSessionMenu() {
    if (this._sessionMenuEl) {
      this.closeSessionMenu();
      return;
    }
    const tracks = this.app?.store?.doc?.audioTracks || [];
    if (!tracks.length) return;

    const panel = h('div', {
      class: 'ab-session-dropdown',
      style: 'position:fixed;z-index:1020;background:var(--surface,#1f2328);color:var(--text,#ffffff);border:1px solid var(--line,rgba(255,255,255,0.15));border-radius:16px;box-shadow:0 10px 28px rgba(0,0,0,0.38);padding:14px;min-width:min(270px,calc(100vw - 20px));max-width:calc(100vw - 20px);max-height:calc(100vh - 20px);overflow-y:auto;display:flex;flex-direction:column;gap:10px;user-select:none;'
    });

    // Header matching Image 5
    const headRow = h('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line,rgba(255,255,255,0.1));padding-bottom:8px;'
    },
      h('span', { style: 'font-weight:700;font-size:14px;' }, t('Recording')),
      h('button', {
        style: 'background:none;border:none;color:inherit;opacity:0.7;cursor:pointer;padding:2px 6px;font-size:14px;font-weight:600;',
        onclick: (e) => { e.stopPropagation(); this.closeSessionMenu(); }
      }, '✕')
    );
    panel.appendChild(headRow);

    // Audio-Ink Sync toggle
    const syncSw = h('input', { type: 'checkbox', checked: this.app?.settings?.audioInkSync !== false });
    syncSw.addEventListener('change', () => {
      if (this.app?.settings) {
        this.setAudioInkSync(syncSw.checked);
      }
    });
    const syncRow = h('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;padding:4px 0;'
    },
      h('span', { style: 'font-size:12px;font-weight:600;display:flex;align-items:center;gap:4px;' },
        t('Audio-Ink Sync'),
        h('span', { title: t('Sync handwritten strokes with audio playback timestamps'), style: 'opacity:0.6;cursor:help;font-size:11px;' }, 'ⓘ')
      ),
      h('label', { class: 'toggle', style: 'margin:0;' }, syncSw)
    );
    panel.appendChild(syncRow);

    // Skip dead air (silence) toggle
    const skipSilenceSw = h('input', { type: 'checkbox', checked: !!this.app?.settings?.replaySkipSilence });
    skipSilenceSw.addEventListener('change', () => {
      if (this.app?.settings) {
        this.app.settings.replaySkipSilence = skipSilenceSw.checked;
        this.app.saveSettings();
      }
    });
    const skipSilenceRow = h('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;padding:4px 0;'
    },
      h('span', { style: 'font-size:12px;font-weight:600;' }, t('Skip dead air (silence)')),
      h('label', { class: 'toggle', style: 'margin:0;' }, skipSilenceSw)
    );
    panel.appendChild(skipSilenceRow);

    // Tap stroke to seek audio toggle
    const tapSeekSw = h('input', { type: 'checkbox', checked: this.app?.settings?.tapStrokeToSeek !== false });
    tapSeekSw.addEventListener('change', () => {
      if (this.app?.settings) {
        this.app.settings.tapStrokeToSeek = tapSeekSw.checked;
        this.app.saveSettings();
      }
    });
    const tapSeekRow = h('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;padding:4px 0;'
    },
      h('span', { style: 'font-size:12px;font-weight:600;' }, t('Tap stroke to seek audio')),
      h('label', { class: 'toggle', style: 'margin:0;' }, tapSeekSw)
    );
    panel.appendChild(tapSeekRow);

    // Keep playback presentation separate from Reading/Writing input mode:
    // this controls how timestamped ink is displayed, not whether the board edits.
    const replayModeSelect = h('select', {
      class: 'ab-replay-display-mode',
      'aria-label': t('Replay display mode'),
      title: t('Replay display mode'),
      style: 'flex:1;min-width:110px;padding:5px 7px;border:1px solid var(--line,rgba(128,128,128,.25));border-radius:8px;background:var(--surface,#fff);color:inherit;font:inherit;font-size:12px;'
    },
      h('option', { value: 'reveal' }, t('Live reveal')),
      h('option', { value: 'spotlight' }, t('Spotlight')),
      h('option', { value: 'static' }, t('Static'))
    );
    replayModeSelect.value = replayDisplayMode(this.app?.settings);
    replayModeSelect.addEventListener('change', () => {
      const mode = replayDisplayMode(null, replayModeSelect.value);
      this.app.settings.replayDisplayMode = mode;
      this.app.saveSettings();
      if (this.app.surface) {
        this.app.surface._ink = null;
        this.app.surface.invalidate();
      }
      this.syncUI();
    });
    this.replayModeSelect = replayModeSelect;
    const replayModeRow = h('div', {
      style: 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 0;'
    }, h('span', { style: 'font-size:12px;font-weight:600;' }, t('Replay display mode')), replayModeSelect);
    panel.appendChild(replayModeRow);

    // List of recordings
    const listWrap = h('div', {
      style: 'display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto;'
    });

    for (const [idx, tr] of tracks.entries()) {
      const isCur = tr.id === this.track?.id;
      const durStr = formatTime(tr.durationMs || 0);
      const dateStr = tr.created ? new Date(tr.created).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

      const dotBtn = h('button', {
        class: 'ab-row-menu-btn',
        title: t('Recording options'),
        style: 'background:none;border:none;cursor:pointer;padding:4px 6px;border-radius:6px;color:inherit;opacity:0.75;font-weight:700;font-size:13px;',
        html: '•••'
      });
      dotBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showTrackContextMenu(tr, dotBtn);
      });

      const row = h('div', {
        class: `ab-session-row ${isCur ? 'active' : ''}`,
        style: `display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:10px;cursor:pointer;background:${isCur ? 'rgba(0,229,255,0.12)' : 'rgba(128,128,128,0.06)'};border:1px solid ${isCur ? 'rgba(0,229,255,0.4)' : 'transparent'};`
      });

      const infoCol = h('div', {
        style: 'display:flex;flex-direction:column;gap:2px;flex:1;'
      },
        h('span', { style: `font-size:12.5px;font-weight:${isCur ? '700' : '600'};color:${isCur ? '#00e5ff' : 'inherit'};` }, tr.name || `Recording ${idx + 1}`),
        h('span', { style: 'font-size:11px;opacity:0.6;font-variant-numeric:tabular-nums;' }, `${durStr}${dateStr ? '  ' + dateStr : ''}`)
      );
      infoCol.addEventListener('click', (e) => {
        e.stopPropagation();
        this.open(tr);
        this.closeSessionMenu();
      });

      row.appendChild(infoCol);
      row.appendChild(dotBtn);
      listWrap.appendChild(row);
    }
    panel.appendChild(listWrap);

    const onDismiss = (e) => {
      const trackMenu = document.getElementById('abTrackMenu');
      if (trackMenu && trackMenu.contains(e.target)) return;
      if (!panel.contains(e.target) && e.target !== this.btnSession && !this.btnSession?.contains(e.target)) {
        this.closeSessionMenu();
        window.removeEventListener('pointerdown', onDismiss);
      }
    };
    this._sessionMenuDismiss = onDismiss;
    setTimeout(() => {
      if (this._sessionMenuEl === panel && this._sessionMenuDismiss === onDismiss) {
        window.addEventListener('pointerdown', onDismiss);
      }
    }, 0);

    document.body.appendChild(panel);
    const anchor = this.btnSession?.getBoundingClientRect?.() || this.el.getBoundingClientRect();
    const fitted = sessionMenuPosition(anchor,
      { width: panel.offsetWidth || 300, height: panel.offsetHeight || 420 },
      { width: window.innerWidth || 1024, height: window.innerHeight || 768 });
    panel.style.left = `${fitted.left}px`;
    panel.style.top = `${fitted.top}px`;
    panel.style.maxHeight = `${fitted.maxHeight}px`;
    this._sessionMenuEl = panel;
  }

  build() {
    if (typeof document === 'undefined') return;

    this.btnRewind10 = h('button', {
      class: 'ab-btn ab-rw',
      title: `Rewind ${this.skipSeconds}s`,
      style: 'background:none;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:4px;border-radius:50%;color:inherit;pointer-events:auto;',
      html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;"><path d="M11 17l-5-5 5-5M18 17l-5-5 5-5"/></svg>'
    });
    this.btnRewind10.addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = this.app?.replayEngine?.currentTimeMs || 0;
      this.seek(cur - this.skipSeconds * 1000);
    });

    this.btnSkipStep = h('button', {
      class: 'ab-btn ab-skip-step',
      title: t('Click to cycle skip duration (5s, 10s, 15s, 30s) — Right-click for options'),
      style: 'background:rgba(128,128,128,0.12);border:none;cursor:pointer;padding:2px 6px;border-radius:10px;font-size:11px;font-weight:700;color:inherit;margin:0 2px;pointer-events:auto;'
    }, `${this.skipSeconds}s`);
    this.btnSkipStep.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cycleSkip();
    });
    this.btnSkipStep.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openSkipMenu();
    });

    this.btnPlay = h('button', {
      class: 'ab-btn ab-play',
      title: t('Play / Pause'),
      style: 'background:none;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:4px;border-radius:50%;color:inherit;pointer-events:auto;'
    });
    this.btnPlay.addEventListener('click', (e) => {
      e.stopPropagation();
      this.togglePlay();
    });

    this.btnForward10 = h('button', {
      class: 'ab-btn ab-ff',
      title: `Forward ${this.skipSeconds}s`,
      style: 'background:none;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:4px;border-radius:50%;color:inherit;pointer-events:auto;',
      html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;"><path d="M13 17l5-5-5-5M6 17l5-5-5-5"/></svg>'
    });
    this.btnForward10.addEventListener('click', (e) => {
      e.stopPropagation();
      const cur = this.app?.replayEngine?.currentTimeMs || 0;
      this.seek(cur + this.skipSeconds * 1000);
    });

    this.lblTime = h('span', {
      class: 'ab-time',
      style: 'font-variant-numeric:tabular-nums;font-size:12px;font-weight:600;min-width:88px;text-align:center;'
    }, '00:00 / 00:00');

    this.btnSpeed = h('button', {
      class: 'ab-btn ab-speed',
      title: t('Speed'),
      style: 'background:rgba(128,128,128,0.12);border:none;cursor:pointer;padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600;color:inherit;pointer-events:auto;'
    }, '1.0×');
    this.btnSpeed.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cycleSpeed();
    });

    this.btnBookmark = h('button', {
      class: 'ab-btn ab-bm',
      title: t('Bookmark'),
      style: 'background:none;border:none;cursor:pointer;display:flex;align-items:center;padding:4px;color:inherit;pointer-events:auto;',
      html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>'
    });
    this.btnBookmark.addEventListener('click', (e) => {
      e.stopPropagation();
      this.addBookmark();
    });

    this.btnGhost = h('button', {
      class: 'ab-btn ab-ghost',
      title: t('Ghost / Hidden Preview'),
      style: 'background:none;border:none;cursor:pointer;display:flex;align-items:center;padding:4px;color:inherit;pointer-events:auto;',
      html: icon('eye', 18)
    });
    this.btnGhost.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleGhostMode();
    });

    this.btnSync = h('button', {
      class: 'ab-btn ab-sync', type: 'button',
      title: t('Audio-Ink Sync'),
      style: 'background:rgba(128,128,128,0.12);border:none;cursor:pointer;padding:3px 7px;border-radius:10px;font-size:11px;font-weight:700;color:inherit;'
    }, t('Audio-Ink Sync'));
    this.btnSync.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setAudioInkSync(this.app.settings.audioInkSync === false);
    });

    this.btnFollow = h('button', {
      class: 'ab-btn ab-follow', type: 'button',
      title: t('Camera follow'),
      style: 'background:rgba(128,128,128,0.12);border:none;cursor:pointer;padding:3px 7px;border-radius:10px;font-size:11px;font-weight:700;color:inherit;'
    }, t('Camera follow'));
    this.btnFollow.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setCameraFollow(this.app.settings.replayCameraFollow === false);
    });

    this.cameraMode = h('select', {
      class: 'ab-camera-mode', title: t('Camera follow framing'),
      'aria-label': t('Camera follow framing'),
      style: 'max-width:104px;padding:3px 4px;border:1px solid var(--line,rgba(128,128,128,.25));border-radius:9px;background:var(--surface,#fff);color:inherit;font:inherit;font-size:10px;'
    },
      h('option', { value: 'viewport' }, t('Viewport')),
      h('option', { value: 'center' }, t('Center point')),
      h('option', { value: 'dead-zone' }, t('Center zone'))
    );
    this.cameraMode.value = this.app.settings.replayCameraMode || 'viewport';
    this.cameraMode.addEventListener('change', () => {
      this.app.settings.replayCameraMode = this.cameraMode.value;
      this.app.saveSettings();
      this.app.replayEngine?.setCameraMode?.(this.cameraMode.value);
    });

    this.outlineEffect = h('select', {
      class: 'ab-outline-effect', title: t('Replay outline effect'),
      'aria-label': t('Replay outline effect'),
      style: 'max-width:82px;padding:3px 4px;border:1px solid var(--line,rgba(128,128,128,.25));border-radius:9px;background:var(--surface,#fff);color:inherit;font:inherit;font-size:10px;'
    },
      h('option', { value: 'neon' }, t('Neon')),
      h('option', { value: 'outline' }, t('Outline')),
      h('option', { value: 'none' }, t('No outline'))
    );
    this.outlineEffect.value = this.app.settings.replayOutlineEffect || 'neon';
    this.outlineEffect.addEventListener('change', () => this.updateReplayStyle('replayOutlineEffect', this.outlineEffect.value));

    this.outlineColor = h('input', {
      class: 'ab-outline-color', type: 'color', title: t('Replay outline color'),
      'aria-label': t('Replay outline color'), value: this.app.settings.replayOutlineColor || '#00e5ff',
      style: 'width:24px;height:24px;padding:1px;border:0;background:transparent;cursor:pointer;'
    });
    this.outlineColor.addEventListener('input', () => this.updateReplayStyle('replayOutlineColor', this.outlineColor.value));

    this.btnClose = h('button', {
      class: 'ab-btn ab-close',
      title: t('Close'),
      style: 'background:none;border:none;cursor:pointer;display:flex;align-items:center;padding:4px;color:inherit;pointer-events:auto;',
      html: icon('close', 18)
    });
    this.btnClose.addEventListener('click', (e) => {
      e.stopPropagation();
      this.close();
    });

    const dragHandle = h('span', {
      class: 'ab-drag',
      title: t('Drag AudioBar'),
      style: 'cursor:grab;display:flex;align-items:center;padding:0 2px;color:rgba(128,128,128,0.7);',
      html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>'
    });

    const scrubberWrap = h('div', {
      class: 'ab-scrubber',
      style: 'display:flex;align-items:center;position:relative;'
    }, this.density.canvas || '');

    this.btnSession = h('button', {
      class: 'ab-session-btn',
      title: t('Switch Recording Session'),
      style: 'background:rgba(128,128,128,0.12);border:none;cursor:pointer;padding:3px 8px;border-radius:12px;font-size:11.5px;font-weight:600;color:inherit;outline:none;display:none;align-items:center;gap:4px;max-width:140px;pointer-events:auto;',
      html: `<span>🎙️</span><span class="ab-session-label">${t('Session')}</span><span style="font-size:9px;opacity:0.6;">▼</span>`
    });
    this.btnSession.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleSessionMenu();
    });

    this.el = h('div', {
      id: 'audioBar',
      class: 'audio-bar-hud',
      style: 'position:absolute;z-index:var(--z-hud-top, 24);display:flex;align-items:center;gap:8px;padding:6px 14px;background:var(--surface,#ffffff);color:var(--text,#111111);border:1px solid var(--line,rgba(0,0,0,0.15));border-radius:24px;box-shadow:0 4px 16px rgba(0,0,0,0.18);user-select:none;font-size:13px;font-family:inherit;'
    }, dragHandle, this.btnSession, this.btnRewind10, this.btnSkipStep, this.btnPlay, this.btnForward10, this.lblTime, scrubberWrap, this.btnSpeed, this.btnBookmark, this.btnGhost, this.btnSync, this.btnFollow, this.cameraMode, this.outlineEffect, this.outlineColor, this.btnClose);

    this.wireDragging(dragHandle);
  }

  wireDragging(handle) {
    if (!handle) return;
    let startX = 0, startY = 0, initialX = 0, initialY = 0;
    let dragging = false;
    let movedPastThreshold = false;

    const onPointerMove = (e) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!movedPastThreshold) {
        if (Math.hypot(dx, dy) < 6) return;
        movedPastThreshold = true;
        dragging = true;
      }
      this.box.x = initialX + dx;
      this.box.y = initialY + dy;
      this.place();
    };

    const onPointerUp = (e) => {
      try {
        if (handle.hasPointerCapture?.(e.pointerId)) {
          handle.releasePointerCapture(e.pointerId);
        }
      } catch {}
      dragging = false;
      movedPastThreshold = false;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      try { handle.setPointerCapture(e.pointerId); } catch {}
      dragging = false;
      movedPastThreshold = false;
      startX = e.clientX;
      startY = e.clientY;
      initialX = this.box.x;
      initialY = this.box.y;
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('pointercancel', onPointerUp);
    });
  }

  place() {
    if (!this.el) return;
    const hw = this.host?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 800);
    const hh = this.host?.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 600);
    const ew = this.el.offsetWidth || 440;
    const eh = this.el.offsetHeight || 40;

    let minLeft = 10;
    let maxRightOffset = 10;
    if (typeof document !== 'undefined' && document.body) {
      if (document.body.classList.contains('left-drawer-open')) {
        minLeft = document.getElementById('pagestrip')?.classList?.contains('show') ? 168 : 368;
      }
      if (document.body.classList.contains('right-drawer-open')) {
        maxRightOffset = 376;
      }
    }
    const maxLeft = Math.max(minLeft, hw - ew - maxRightOffset);
    this.box.x = Math.max(minLeft, Math.min(maxLeft, this.box.x));
    this.box.y = Math.max(10, Math.min(hh - eh - 10, this.box.y));

    this.el.style.left = `${this.box.x}px`;
    this.el.style.top = `${this.box.y}px`;
  }

  syncUI() {
    if (!this.el || !this.visible) return;
    const replay = this.app?.replayEngine;
    const tracks = this.app?.store?.doc?.audioTracks || [];
    const currentTrack = tracks.find((item) => item.id === this.track?.id);
    if (currentTrack && currentTrack !== this.track) {
      this.track = currentTrack;
      if (replay?.track?.id === currentTrack.id) replay.track = currentTrack;
    }
    const cur = replay?.currentTimeMs || 0;
    const dur = this.track?.durationMs || 0;

    const timeText = `${formatTime(cur)} / ${formatTime(dur)}`;
    if (this.lblTime.textContent !== timeText) {
      this.lblTime.textContent = timeText;
    }

    const isPlaying = !!replay?.active;
    if (this._lastPlayActive !== isPlaying) {
      this._lastPlayActive = isPlaying;
      this.btnPlay.innerHTML = icon(isPlaying ? 'pause' : 'play', 18);
      const svg = this.btnPlay.querySelector('svg');
      if (svg) svg.style.pointerEvents = 'none';
    }

    const speedText = `${this.speeds[this.speedIdx]}×`;
    if (this.btnSpeed.textContent !== speedText) {
      this.btnSpeed.textContent = speedText;
    }

    const skipText = `${this.skipSeconds}s`;
    if (this.btnSkipStep && this.btnSkipStep.textContent !== skipText) {
      this.btnSkipStep.textContent = skipText;
      if (this.btnRewind10) this.btnRewind10.title = `Rewind ${this.skipSeconds}s`;
      if (this.btnForward10) this.btnForward10.title = `Forward ${this.skipSeconds}s`;
    }

    if (this.btnSession) {
      if (tracks.length > 0) {
        this.btnSession.style.display = 'inline-flex';
        const curIdx = tracks.findIndex((t) => t.id === this.track?.id);
        const name = this.track?.name || `Session ${curIdx >= 0 ? curIdx + 1 : 1}`;
        const lbl = this.btnSession.querySelector('.ab-session-label');
        if (lbl && lbl.textContent !== name) {
          lbl.textContent = name;
        }
      } else {
        this.btnSession.style.display = 'none';
      }
    }

    if (replay) {
      this.btnGhost.style.opacity = replay.ghostMode === 'translucent' ? '1.0' : '0.4';
    }
    const syncEnabled = this.app?.settings?.audioInkSync !== false;
    if (this.btnSync) {
      this.btnSync.style.opacity = syncEnabled ? '1' : '0.5';
      this.btnSync.setAttribute('aria-pressed', String(syncEnabled));
      this.btnSync.title = syncEnabled ? t('Audio-Ink Sync enabled') : t('Audio-Ink Sync disabled');
    }
    const followEnabled = this.app?.settings?.replayCameraFollow !== false;
    if (this.btnFollow) {
      this.btnFollow.style.opacity = followEnabled ? '1' : '0.5';
      this.btnFollow.setAttribute('aria-pressed', String(followEnabled));
      this.btnFollow.title = followEnabled ? t('Camera follow enabled') : t('Camera follow disabled');
    }
    if (this.cameraMode && this.cameraMode.value !== (this.app?.settings?.replayCameraMode || 'viewport')) {
      this.cameraMode.value = this.app?.settings?.replayCameraMode || 'viewport';
    }
    const displayMode = replayDisplayMode(this.app?.settings);
    if (this.replayModeSelect && this.replayModeSelect.value !== displayMode) {
      this.replayModeSelect.value = displayMode;
    }
    if (this.outlineEffect && this.outlineEffect.value !== (this.app.settings.replayOutlineEffect || 'neon')) {
      this.outlineEffect.value = this.app.settings.replayOutlineEffect || 'neon';
    }
    if (this.outlineColor && this.outlineColor.value !== (this.app.settings.replayOutlineColor || '#00e5ff')) {
      this.outlineColor.value = this.app.settings.replayOutlineColor || '#00e5ff';
    }

    this.density.update({
      track: this.track,
      objects: this.app?.store?.doc?.objects,
      currentTimeMs: cur,
      audioBuffer: replay?.audioBuffer
    });
  }
}

