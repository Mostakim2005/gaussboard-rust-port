// Collapsible right-docked Workflow Studio drawer unifying Material 3 / Glassmorphism UI,
// the 4 configurable workflows (Obsidian & Markdown, Page Bounds, Video Bookmarks, Audio Sync),
// HUD panel hiding / Zen mode, manually hidden canvas element restoration, and protocol switches.

import { h } from './popover.js';
import { t } from '../i18n.js';

const HUD_TOGGLES = [
  { key: 'hudHideTopbar', getLabel: () => t('Top Bar') },
  { key: 'hudHideToolbar', getLabel: () => t('Tools Dock') },
  { key: 'hudHideZoombar', getLabel: () => t('Zoom Controls') },
  { key: 'hudHidePagebar', getLabel: () => t('Page Controls') },
  { key: 'hudHideTabBar', getLabel: () => t('Board Tabs') },
  { key: 'hudHidePagestrip', getLabel: () => t('Page Strip') },
  { key: 'hudHideReplayBar', getLabel: () => t('Replay HUD') },
  { key: 'hudHideSidebarRibbon', getLabel: () => t('Workbench Ribbon') }
];

const PROTOCOL_TOGGLES = [
  { key: 'enableObsidianProtocol', getLabel: () => t('Obsidian & Backlinks Bridge') },
  { key: 'enableLanSyncProtocol', getLabel: () => t('Offline LAN Sync (TCP/UDP)') },
  { key: 'enableAudioSyncProtocol', getLabel: () => t('Audio-to-Ink Sync & Index') },
  { key: 'enableStudySrsProtocol', getLabel: () => t('FSRS Spaced Repetition') }
];

function summarizeObject(o) {
  if (!o) return t('Item');
  const snippet = String(o.text || o.note || o.title || o.name || '').trim().split(/\r?\n/)[0];
  if (snippet) return snippet.slice(0, 34);
  const typeMap = {
    stroke: t('Stroke'),
    text: t('Text card'),
    note: t('Sticky note'),
    shape: t('Shape'),
    image: t('Image'),
    'pdf-page': t('PDF page'),
    table: t('Table'),
    math: t('Math'),
    connector: t('Connector'),
    curtain: o.subtype === 'tape' ? t('Study Tape') : t('Answer cover')
  };
  return typeMap[o.type] || o.type || t('Item');
}

export class WorkflowStudio {
  constructor(app) {
    this.app = app;
    this.el = null;
    this.body = null;
    this.contrastBadge = null;
    this.openState = false;
  }

  get isOpen() {
    return !!(this.openState && this.el && this.el.classList.contains('open'));
  }

  toggle(force) {
    const next = typeof force === 'boolean' ? force : !this.isOpen;
    if (next) this.open();
    else this.close();
  }

  open() {
    this.ensureDom();
    if (!this.el) return;
    this.openState = true;
    this.el.classList.add('open');
    this.el.setAttribute('aria-hidden', 'false');
    this.render();
    this.app?.updateHudLayout?.('workflowStudio');
    this.app?.syncUI?.();
  }

  close() {
    this.openState = false;
    if (this.el) {
      this.el.classList.remove('open');
      this.el.setAttribute('aria-hidden', 'true');
    }
    this.app?.updateHudLayout?.();
    this.app?.syncUI?.();
  }

  ensureDom() {
    if (this.el || typeof document === 'undefined') return;
    const host = document.getElementById('stage') || document.body;
    const closeBtn = h('button', {
      type: 'button',
      class: 'icon-btn',
      title: t('Close'),
      'aria-label': t('Close')
    }, '✕');
    closeBtn.addEventListener('click', () => this.close());

    const header = h('div', { class: 'ws-header' },
      h('div', { class: 'ws-title-group' },
        h('span', { class: 'ws-title' }, t('Workflow Studio')),
        h('span', { class: 'ws-subtitle' }, t('Appearance, Bounds, Media, Hide & Protocols'))
      ),
      closeBtn
    );

    this.body = h('div', { class: 'ws-body' });
    this.el = h('aside', {
      id: 'workflowStudioSheet',
      class: 'workflow-studio-sheet',
      role: 'dialog',
      'aria-label': t('Workflow Studio'),
      'aria-hidden': 'true'
    }, header, this.body);
    host.appendChild(this.el);
  }

  sync() {
    if (this.isOpen) this.render();
  }

  _segGroup(options, current, onPick) {
    const wrap = h('div', { class: 'ws-seg' });
    for (const [val, label] of options) {
      const btn = h('button', {
        type: 'button',
        class: `ws-seg-btn${current === val ? ' active' : ''}`,
        'aria-pressed': String(current === val)
      }, label);
      btn.addEventListener('click', () => {
        onPick(val);
        this.render();
      });
      wrap.appendChild(btn);
    }
    return wrap;
  }

  _toggleRow(label, checked, onChange, meta = '') {
    const inp = h('input', { type: 'checkbox', checked });
    inp.addEventListener('change', () => {
      onChange(inp.checked);
      this.render();
    });
    return h('label', { class: 'ws-toggle-row' },
      h('span', { class: 'ws-toggle-meta' },
        h('span', { class: 'ws-toggle-label' }, label),
        meta ? h('small', { class: 'ws-toggle-sub' }, meta) : ''
      ),
      inp
    );
  }

  _section(title, ...children) {
    return h('details', { class: 'ws-section', open: true },
      h('summary', { class: 'ws-section-head' }, title),
      h('div', { class: 'ws-section-body' }, ...children)
    );
  }

  render() {
    if (!this.body) return;
    const app = this.app;
    const s = app.settings || {};
    this.body.innerHTML = '';

    // 1. Visual Theme System: Material 3 vs Glassmorphism + WCAG live check
    const uiStyle = s.sidebarRibbonStyle === 'material' ? 'material' : 'glassmorphism';
    this.contrastBadge = h('span', { class: 'ws-contrast-badge' }, t('Checking WCAG contrast…'));
    this.body.appendChild(
      this._section(t('Visual System (Material 3 / Glassmorphism)'),
        h('div', { class: 'ws-row-label' }, t('HUD Surface Style')),
        this._segGroup([
          ['glassmorphism', t('Glassmorphism')],
          ['material', t('Material 3')]
        ], uiStyle, (v) => {
          s.sidebarRibbonStyle = v;
          if (app.sidebarRibbon) {
            app.sidebarRibbon.styleMode = v;
            app.sidebarRibbon.syncState?.();
          }
          app.saveSettings?.();
          app.applyTheme?.();
        }),
        this.contrastBadge
      )
    );
    this._refreshContrastBadge();

    // 2A. Obsidian & Markdown Bridge
    const obsidianEnabled = s.enableObsidianProtocol !== false;
    const mdMode = s.markdownEditMode || 'live';
    const cardStyle = s.defaultCardStyle || 'canvas';
    const vaultLabel = s.obsidianVaultName ? `${s.obsidianVaultName}` : t('Not connected');
    const btnVaultConnect = h('button', {
      type: 'button',
      class: 'btn primary',
      disabled: !obsidianEnabled
    }, s.obsidianVaultPath ? t('Change Vault…') : t('Connect Vault…'));
    btnVaultConnect.addEventListener('click', () => app.chooseObsidianVault?.().then(() => this.render()));

    const btnVaultDisconnect = s.obsidianVaultPath
      ? h('button', { type: 'button', class: 'btn' }, t('Disconnect'))
      : null;
    if (btnVaultDisconnect) {
      btnVaultDisconnect.addEventListener('click', () => {
        app.disconnectObsidianVault?.();
        this.render();
      });
    }

    this.body.appendChild(
      this._section(t('Obsidian & Markdown'),
        h('div', { class: 'ws-row-label' }, t('Markdown Editor Mode')),
        this._segGroup([
          ['live', t('Live preview')],
          ['source', t('Source')],
          ['reading', t('Reading')]
        ], mdMode, (v) => {
          s.markdownEditMode = v;
          app.saveSettings?.();
          app.surface?.invalidate?.();
        }),
        h('div', { class: 'ws-row-label' }, t('Default Text Card Look')),
        this._segGroup([
          ['canvas', t('Canvas')],
          ['window', t('Window')],
          ['minimal', t('Minimal')],
          ['transparent', t('Clear')]
        ], cardStyle, (v) => {
          s.defaultCardStyle = v;
          app.saveSettings?.();
        }),
        h('div', { class: 'ws-vault-row' },
          h('span', { class: 'ws-vault-name', title: s.obsidianVaultPath || '' }, `${t('Vault')}: ${vaultLabel}`),
          h('div', { class: 'ws-btn-row' }, btnVaultConnect, btnVaultDisconnect)
        )
      )
    );

    // 2B. Page Bounds
    const pageClip = app.store?.doc?.pageClip === true;
    const btnMargin = h('button', { type: 'button', class: 'btn' }, t('Margins & Paper…'));
    btnMargin.addEventListener('click', () => app.openPageMarginDialog?.());

    this.body.appendChild(
      this._section(t('Page Bounds'),
        this._segGroup([
          ['freeform', t('Freeform Unclipped')],
          ['clipped', t('Clipped Sheets')]
        ], pageClip ? 'clipped' : 'freeform', (v) => {
          app.store?.setPageClip?.(v === 'clipped', 'toggle page clip');
          app.surface?.invalidate?.();
          app.syncUI?.();
        }),
        h('div', { class: 'ws-btn-row', style: 'margin-top:8px;' }, btnMargin)
      )
    );

    // 2C. Video Bookmarks
    const quickBookmark = s.videoQuickBookmark !== false;
    this.body.appendChild(
      this._section(t('Video Bookmarks'),
        this._segGroup([
          ['quick', t('One-Click Stamp')],
          ['custom', t('Custom Label Drawer')]
        ], quickBookmark ? 'quick' : 'custom', (v) => {
          s.videoQuickBookmark = v === 'quick';
          app.saveSettings?.();
        })
      )
    );

    // 2D. Audio & Replay Sync
    const audioEnabled = s.enableAudioSyncProtocol !== false;
    const camMode = s.replayCameraMode === 'closeup' ? 'closeup' : 'viewport';
    const tracks = app.store?.doc?.audioTracks || [];
    const btnAudioBar = h('button', {
      type: 'button',
      class: 'btn',
      disabled: !audioEnabled || !tracks.length
    }, tracks.length ? t('Open Audio Player') : t('No audio track on board'));
    btnAudioBar.addEventListener('click', () => {
      if (tracks.length) app.audioBar?.open?.(tracks[tracks.length - 1]);
    });

    this.body.appendChild(
      this._section(t('Audio & Replay Sync'),
        this._toggleRow(t('Ink <-> Audio Tap Seek'), s.audioInkSync !== false, (v) => {
          s.audioInkSync = v;
          app.saveSettings?.();
          app.audioBar?.syncUI?.();
        }),
        this._toggleRow(t('Follow Replay Camera'), s.replayCameraFollow !== false, (v) => {
          s.replayCameraFollow = v;
          app.saveSettings?.();
        }),
        this._toggleRow(t('Skip Dead Air (Silence)'), !!s.replaySkipSilence, (v) => {
          s.replaySkipSilence = v;
          app.saveSettings?.();
        }),
        h('div', { class: 'ws-row-label' }, t('Replay Camera Framing')),
        this._segGroup([
          ['viewport', t('Viewport')],
          ['closeup', t('Closeup')]
        ], camMode, (v) => {
          s.replayCameraMode = v;
          app.saveSettings?.();
        }),
        h('div', { class: 'ws-btn-row', style: 'margin-top:8px;' }, btnAudioBar)
      )
    );

    // 3. Hide HUD Panels & Manually Hidden Elements
    const hiddenObjs = (app.store?.objects || []).filter((o) => o && o.hidden && o.hiddenManual);
    const hasSel = !!(app.surface?.selection?.size);

    const btnHideSel = h('button', {
      type: 'button',
      class: 'btn',
      disabled: !hasSel
    }, t('Hide Selected (Ctrl+H)'));
    btnHideSel.addEventListener('click', () => {
      app.hideSelectedObjects?.();
      this.render();
    });

    const btnUnhideAll = h('button', {
      type: 'button',
      class: 'btn',
      disabled: !hiddenObjs.length
    }, `${t('Restore All')} (${hiddenObjs.length})`);
    btnUnhideAll.addEventListener('click', () => {
      app.unhideAllObjects?.();
      this.render();
    });

    const hiddenList = h('div', { class: 'ws-hidden-list' });
    if (!hiddenObjs.length) {
      hiddenList.appendChild(h('div', { class: 'ws-empty-note' }, t('No hidden board elements')));
    } else {
      for (const obj of hiddenObjs.slice(0, 40)) {
        const showBtn = h('button', { type: 'button', class: 'ws-mini-btn' }, t('Show'));
        showBtn.addEventListener('click', () => {
          app.unhideObject?.(obj.id);
          this.render();
        });
        hiddenList.appendChild(h('div', { class: 'ws-hidden-item' },
          h('span', { class: 'ws-hidden-label' }, summarizeObject(obj)),
          showBtn
        ));
      }
    }

    const hudGrid = h('div', { class: 'ws-hud-grid' });
    for (const item of HUD_TOGGLES) {
      const hidden = !!s[item.key];
      const lbl = item.getLabel();
      const chip = h('button', {
        type: 'button',
        class: `ws-chip${hidden ? ' off' : ' on'}`,
        'aria-pressed': String(!hidden)
      }, hidden ? `${t('Hidden')}: ${lbl}` : lbl);
      chip.addEventListener('click', () => {
        s[item.key] = !s[item.key];
        app.saveSettings?.();
        app.applyHudPreferences?.();
        this.render();
      });
      hudGrid.appendChild(chip);
    }

    this.body.appendChild(
      this._section(t('Hide Elements & Interface'),
        this._toggleRow(t('Zen Mode (Hide Chrome · Alt+Z)'), !!s.zenMode, (v) => {
          app.setZenMode?.(v);
        }),
        h('div', { class: 'ws-row-label' }, t('HUD Panels')),
        hudGrid,
        h('div', { class: 'ws-row-label', style: 'margin-top:10px;' }, `${t('Hidden Elements')} (${hiddenObjs.length})`),
        h('div', { class: 'ws-btn-row' }, btnHideSel, btnUnhideAll),
        hiddenList
      )
    );

    // 4. Subsystem Protocols
    const protoNodes = PROTOCOL_TOGGLES.map((p) =>
      this._toggleRow(p.getLabel(), s[p.key] !== false, (v) => {
        s[p.key] = v;
        app.saveSettings?.();
        app.applyProtocolPreferences?.(p.key, v);
      })
    );
    this.body.appendChild(this._section(t('Protocols'), ...protoNodes));
  }

  async _refreshContrastBadge() {
    if (!this.contrastBadge) return;
    try {
      const dark = !!this.app?.darkMode;
      const fg = dark ? '#f3f2f1' : '#201f1e';
      const bg = dark ? '#252423' : '#ffffff';
      const res = await window.board?.colorimetry?.wcagContrast?.(fg, bg);
      if (res && typeof res.ratio === 'number' && this.contrastBadge) {
        const tier = res.wcag_aaa_normal ? 'AAA' : (res.wcag_aa_normal ? 'AA' : 'Low');
        this.contrastBadge.textContent = `WCAG ${tier} · ${res.ratio.toFixed(1)}:1`;
        this.contrastBadge.dataset.ok = String(!!res.wcag_aa_normal);
      }
    } catch {}
  }
}
