// Unified In-Note Command & Search Dialog.
// Allows searching both Boards (by name, alias, tag) and Settings (with inline toggles) in real-time.

import { h } from './popover.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';

export class SearchDialog {
  constructor(app) {
    this.app = app;
    this.el = null;
    this.input = null;
    this.boardsContainer = null;
    this.toolsContainer = null;
    this.settingsContainer = null;
    this.nativeSearchContainer = null;
    this.secBoards = null;
    this.secNative = null;
    this.secTools = null;
    this.secSettings = null;
    this.secDivider = null;
    this.secNativeDivider = null;
    this.secToolsDivider = null;
    this.emptyNotice = null;
    this.visible = false;
    this.boardsList = [];
    this._nativeSeq = 0;
  }

  async loadBoards() {
    try {
      if (window.board?.boards?.list) {
        this.boardsList = await window.board.boards.list();
      }
    } catch {
      this.boardsList = [];
    }
  }

  build() {
    if (this.el) return;

    this.input = h('input', {
      type: 'text',
      class: 'omni-search-input',
      placeholder: t('Search boards, settings, pressure, tags, aliases...'),
      style: 'width:100%;box-sizing:border-box;padding:12px 16px 12px 42px;border:none;background:var(--desk,#f5f5f7);border-radius:12px;font-size:15px;color:var(--text,inherit);outline:none;'
    });

    const searchIcon = h('span', {
      style: 'position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--text-2,rgba(128,128,128,0.7));display:flex;pointer-events:none;',
      html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'
    });

    const closeBtn = h('button', {
      class: 'btn-close-search',
      title: t('Close'),
      style: 'background:none;border:none;cursor:pointer;padding:6px;border-radius:50%;color:var(--text-2,rgba(128,128,128,0.8));display:flex;',
      html: icon('close', 18)
    });
    closeBtn.addEventListener('click', () => this.close());

    const header = h('div', {
      style: 'position:relative;display:flex;align-items:center;gap:8px;padding-bottom:14px;border-bottom:1px solid var(--line,rgba(0,0,0,0.08));'
    }, h('div', { style: 'position:relative;flex:1;' }, searchIcon, this.input), closeBtn);

    // Section 1: Boards
    this.boardsContainer = h('div', { class: 'search-section-boards' });
    this.secBoards = h('div', { style: 'margin-top:14px;' },
      h('div', { style: 'font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-2,rgba(128,128,128,0.85));margin-bottom:8px;' }, t('Board Name')),
      this.boardsContainer
    );

    // Light-colored subtle separator between sections
    this.secDivider = h('div', {
      class: 'search-section-divider',
      style: 'height:1px;background:var(--line,rgba(0,0,0,0.08));margin:16px 0;'
    });

    // Section 2: Tools & Commands
    this.toolsContainer = h('div', { class: 'search-section-tools' });
    this.secTools = h('div', { style: 'margin-top:4px;' },
      h('div', { style: 'font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-2,rgba(128,128,128,0.85));margin-bottom:8px;' }, t('Tools & Commands')),
      this.toolsContainer
    );

    this.secToolsDivider = h('div', {
      class: 'search-section-divider',
      style: 'height:1px;background:var(--line,rgba(0,0,0,0.08));margin:16px 0;'
    });

    // Section 3: Settings
    this.settingsContainer = h('div', { class: 'search-section-settings' });
    this.secSettings = h('div', { style: 'margin-top:4px;' },
      h('div', { style: 'font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-2,rgba(128,128,128,0.85));margin-bottom:8px;' }, t('Setting Name')),
      this.settingsContainer
    );

    // Section 1b: Full-Text Content, PDFs & Audio-to-Ink (Native FTS / Fallback Index)
    this.nativeSearchContainer = h('div', { class: 'search-section-native' });
    this.secNative = h('div', { style: 'margin-top:4px;display:none;' },
      h('div', { style: 'font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-2,rgba(128,128,128,0.85));margin-bottom:8px;' }, t('Indexed Content, PDF & Audio Ink')),
      this.nativeSearchContainer
    );
    this.secNativeDivider = h('div', {
      class: 'search-section-divider',
      style: 'height:1px;background:var(--line,rgba(0,0,0,0.08));margin:16px 0;display:none;'
    });

    // Empty state notice
    this.emptyNotice = h('div', {
      style: 'display:none;padding:32px 16px;text-align:center;font-size:13.5px;color:var(--text-2,rgba(128,128,128,0.8));font-style:italic;'
    }, t('No matching boards, tools, or settings found'));

    const scrollArea = h('div', {
      class: 'omni-search-scroll',
      style: 'overflow-y:auto;flex:1;padding-right:4px;margin-top:4px;display:flex;flex-direction:column;'
    }, this.secBoards, this.secDivider, this.secNative, this.secNativeDivider, this.secTools, this.secToolsDivider, this.secSettings, this.emptyNotice);

    const card = h('div', {
      class: 'omni-search-card',
      style: 'position:relative;width:580px;max-width:92vw;max-height:80vh;background:var(--surface,#ffffff);border-radius:20px;box-shadow:0 16px 40px rgba(0,0,0,0.22);border:1px solid var(--line,rgba(0,0,0,0.12));padding:18px 20px;display:flex;flex-direction:column;overflow:hidden;'
    }, header, scrollArea);

    this.el = h('div', {
      id: 'omniSearchModal',
      class: 'omni-search-backdrop',
      style: 'position:fixed;inset:0;z-index:var(--z-omnibar, 80);background:rgba(0,0,0,0.45);backdrop-filter:blur(6px);display:none;align-items:flex-start;justify-content:center;padding-top:10vh;'
    }, card);

    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });

    this.input.addEventListener('input', () => this.filter());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });

    document.body.appendChild(this.el);
  }

  async open(initialQuery = '') {
    this.build();
    await this.loadBoards();
    this.visible = true;
    this.el.style.display = 'flex';
    this.input.value = initialQuery;
    this.filter();
    setTimeout(() => this.input.focus(), 50);
  }

  close() {
    if (!this.visible) return;
    this.visible = false;
    if (this.el) this.el.style.display = 'none';
  }

  toggle(initialQuery = '') {
    if (this.visible) this.close();
    else this.open(initialQuery);
  }

  filter() {
    const q = (this.input.value || '').trim().toLowerCase();
    const boardCount = this.renderBoards(q);
    const toolCount = this.renderTools(q);
    const settingCount = this.renderSettings(q);

    const total = boardCount + toolCount + settingCount;
    if (total === 0 && q.length < 2) {
      if (this.secBoards) this.secBoards.style.display = 'none';
      if (this.secDivider) this.secDivider.style.display = 'none';
      if (this.secNative) this.secNative.style.display = 'none';
      if (this.secNativeDivider) this.secNativeDivider.style.display = 'none';
      if (this.secTools) this.secTools.style.display = 'none';
      if (this.secToolsDivider) this.secToolsDivider.style.display = 'none';
      if (this.secSettings) this.secSettings.style.display = 'none';
      if (this.emptyNotice) this.emptyNotice.style.display = 'block';
    } else {
      if (this.emptyNotice) this.emptyNotice.style.display = total === 0 ? 'block' : 'none';
      if (this.secBoards) this.secBoards.style.display = boardCount > 0 ? 'block' : 'none';
      if (this.secDivider) this.secDivider.style.display = (boardCount > 0 && (toolCount > 0 || settingCount > 0)) ? 'block' : 'none';
      if (this.secTools) this.secTools.style.display = toolCount > 0 ? 'block' : 'none';
      if (this.secToolsDivider) this.secToolsDivider.style.display = (toolCount > 0 && settingCount > 0) ? 'block' : 'none';
      if (this.secSettings) this.secSettings.style.display = settingCount > 0 ? 'block' : 'none';
    }
    this.renderNativeResults(q, total);
  }

  async renderNativeResults(q, syncTotal = 0) {
    if (!this.nativeSearchContainer || !this.secNative) return;
    const seq = ++this._nativeSeq;
    this.nativeSearchContainer.innerHTML = '';
    if (!q || q.length < 2 || !window.board?.search) {
      this.secNative.style.display = 'none';
      if (this.secNativeDivider) this.secNativeDivider.style.display = 'none';
      return;
    }

    let textHits = [];
    let audioHits = [];
    try {
      const [fts, aud] = await Promise.all([
        window.board.search.query?.(q, 8).catch(() => []) || [],
        window.board.search.searchAudioToInk?.(q, 6).catch(() => []) || []
      ]);
      if (Array.isArray(fts)) textHits = fts;
      if (Array.isArray(aud)) audioHits = aud;
    } catch {}
    if (seq !== this._nativeSeq) return;

    const count = textHits.length + audioHits.length;
    if (!count) {
      this.secNative.style.display = 'none';
      if (this.secNativeDivider) this.secNativeDivider.style.display = 'none';
      if (this.emptyNotice) this.emptyNotice.style.display = syncTotal === 0 ? 'block' : 'none';
      return;
    }

    if (this.emptyNotice) this.emptyNotice.style.display = 'none';
    this.secNative.style.display = 'block';
    if (this.secNativeDivider) this.secNativeDivider.style.display = 'block';

    for (const hit of textHits) {
      const cleanSnippet = String(hit.snippet || '').replace(/<\/?b>/g, '');
      const row = h('div', {
        class: 'search-tool-row',
        style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-radius:10px;cursor:pointer;margin-bottom:4px;gap:10px;'
      },
        h('div', { style: 'display:flex;flex-direction:column;gap:2px;min-width:0;' },
          h('span', { style: 'font-weight:600;font-size:13px;' }, hit.title || hit.board_id),
          cleanSnippet ? h('span', { style: 'font-size:11.5px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' }, cleanSnippet) : ''
        ),
        h('span', { class: 'badge' }, String(hit.board_id || '').includes('#page=') ? t('PDF') : t('Board'))
      );
      row.addEventListener('click', () => {
        this.close();
        const rawId = String(hit.board_id || '');
        const [targetBoardId, frag] = rawId.split('#');
        const openIt = async () => {
          if (targetBoardId && targetBoardId !== this.app.store?.doc?.id) {
            await this.app.openBoardById?.(targetBoardId);
          }
          if (frag && frag.startsWith('page=')) {
            const p = Math.max(0, parseInt(frag.slice(5), 10) - 1);
            if (!Number.isNaN(p)) this.app.goToPage?.(p);
          }
        };
        openIt();
      });
      this.nativeSearchContainer.appendChild(row);
    }

    for (const ah of audioHits) {
      const sec = Math.max(0, Math.round((Number(ah.audio_seek_ms) || 0) / 1000));
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      const row = h('div', {
        class: 'search-tool-row',
        style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-radius:10px;cursor:pointer;margin-bottom:4px;gap:10px;'
      },
        h('div', { style: 'display:flex;flex-direction:column;gap:2px;min-width:0;' },
          h('span', { style: 'font-weight:600;font-size:13px;' }, `${t('Audio-to-Ink')}: "${ah.matched_word}"`),
          h('span', { style: 'font-size:11.5px;color:var(--text-2);' }, `${mm}:${ss}`)
        ),
        h('span', { class: 'badge' }, t('Jump'))
      );
      row.addEventListener('click', async () => {
        this.close();
        if (ah.board_id && ah.board_id !== this.app.store?.doc?.id) {
          await this.app.openBoardById?.(ah.board_id);
        }
        if (this.app.replayEngine && ah.audio_seek_ms != null) {
          this.app.replayEngine.seekTo?.(Number(ah.audio_seek_ms) || 0);
        }
      });
      this.nativeSearchContainer.appendChild(row);
    }
  }

  renderTools(q) {
    if (!this.toolsContainer) return 0;
    this.toolsContainer.innerHTML = '';
    const app = this.app;
    const tokens = q ? q.toLowerCase().split(/\s+/).filter(Boolean) : [];

    const tools = [
      { id: 'workbench.circuit', title: t('Circuit Simulation Workbench'), desc: t('2.5D schematic editor, DOL starter, oscilloscope and multimeter'), shortcut: 'Ctrl+Shift+E', action: () => app.openCircuitWorkbench?.() },
      { id: 'math.grapher', title: t('2D Function Grapher & Calculus'), desc: t('Symbolic derivatives, roots, tangent slopes, and integral visualizer'), shortcut: 'Ctrl+Shift+G', action: () => app.openFunctionGrapher?.() },
      { id: 'science.molecule', title: t('3D Molecular Structure Viewer'), desc: t('Interactive 3D Mol* molecular renderer and PDB visualizer'), shortcut: 'Ctrl+Shift+M', action: () => app.openMoleculeViewer?.() },
      { id: 'science.sketcher', title: t('2D Chemical Sketcher & SMILES'), desc: t('Draw chemical structures and export SMILES formulas'), shortcut: 'Ctrl+Shift+K', action: () => app.openChemicalSketcher?.() },
      { id: 'science.periodic', title: t('Interactive Periodic Table'), desc: t('Element trends, atomic mass, electronegativity and orbital configurations'), shortcut: '', action: () => app.openPeriodicTable?.() },
      { id: 'science.phet', title: t('PhET Simulation Lab'), desc: t('Interactive HTML5 simulations for physics, chemistry, and biology'), shortcut: '', action: () => app.openPhetRunner?.() },
      { id: 'esl.dictionary', title: t('Academic Dictionary & Thesaurus'), desc: t('Offline technical lexicon, collocations, pronunciations, and grammar rules'), shortcut: 'Ctrl+Shift+D', action: () => app.openAcademicDictionary?.() },
      { id: 'study.session', title: t('Active Study Session & FSRS Review'), desc: t('Spaced repetition revision, image occlusion, and Anki sync'), shortcut: 'Ctrl+Shift+R', action: () => app.startStudySession?.() },
      { id: 'view.graph', title: t('Knowledge Graph View'), desc: t('Interactive force-directed map of board links and tags'), shortcut: 'Alt+G', action: () => app.openGraphView?.() },
      { id: 'view.pdfSidebar', title: t('Document Navigator & TOC'), desc: t('PDF hierarchical outline tree, bookmarks, and search filter'), shortcut: 'Alt+T', action: () => app.togglePdfSidebar?.() },
      { id: 'tool.ribbon', title: t('Toggle Engineering Ribbon'), desc: t('Open or close the dual-layered STEM & Engineering workbench'), shortcut: 'Ctrl+B', action: () => app.toggleSidebarRibbon?.() },
      { id: 'insert.kanban', title: t('Insert Kanban Board'), desc: t('Stamp an interactive 3-column task board onto the canvas'), shortcut: '', action: () => app.command?.('insert.kanban') },
      { id: 'insert.dataview', title: t('Run Dataview Query Table'), desc: t('Query canvas objects and stamp an interactive table card'), shortcut: '', action: () => app.command?.('insert.dataview') },
      { id: 'export.video', title: t('Export Video / Audio Replay'), desc: t('Export recorded board drawing session as MP4 or WebM video'), shortcut: '', action: () => app.command?.('export.video') },
      { id: 'help.libraries', title: t('Inspect Runtime Libraries'), desc: t('View all 15 vendored offline libraries, versions, and paths'), shortcut: '', action: () => app.command?.('help.libraries') }
    ];

    const matched = tools.filter((tool) => {
      if (!tokens.length) return true;
      const haystack = `${tool.title} ${tool.desc} ${tool.shortcut}`.toLowerCase();
      return tokens.every((tok) => haystack.includes(tok));
    }).slice(0, 8);

    if (matched.length === 0) return 0;

    for (const tool of matched) {
      const row = h('div', {
        class: 'search-tool-row',
        style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-radius:10px;cursor:pointer;margin-bottom:4px;transition:background 0.12s;'
      },
        h('div', { style: 'display:flex;flex-direction:column;gap:2px;' },
          h('div', { style: 'display:flex;align-items:center;gap:6px;' },
            h('span', { style: 'font-weight:600;font-size:13.5px;' }, tool.title),
            tool.shortcut ? h('kbd', { style: 'font-size:10.5px;padding:1px 5px;background:var(--desk,rgba(128,128,128,0.15));color:var(--text-2,inherit);border-radius:4px;border:1px solid var(--line,rgba(128,128,128,0.2));' }, tool.shortcut) : ''
          ),
          h('span', { style: 'font-size:11.5px;color:var(--text-2,rgba(128,128,128,0.85));' }, tool.desc)
        ),
        h('button', {
          class: 'btn-run-tool',
          style: 'padding:4px 10px;border-radius:8px;border:none;background:var(--accent,#0078d4);color:#ffffff;font-size:12px;font-weight:600;cursor:pointer;'
        }, t('Launch'))
      );

      row.addEventListener('click', () => {
        this.close();
        tool.action();
      });
      row.addEventListener('mouseenter', () => { row.style.background = 'var(--surface-2, rgba(128,128,128,0.15))'; });
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
      this.toolsContainer.appendChild(row);
    }
    return matched.length;
  }

  renderBoards(q) {
    if (!this.boardsContainer) return 0;
    this.boardsContainer.innerHTML = '';

    const currentDoc = this.app?.store?.doc;
    const currentId = currentDoc?.id;
    const tokens = q ? q.toLowerCase().split(/\s+/).filter(Boolean) : [];

    const matched = this.boardsList.filter((b) => {
      if (!tokens.length) return true;
      const titleStr = (b.name || b.title || '').toLowerCase();
      const aliasStr = Array.isArray(b.aliases) ? b.aliases.join(' ').toLowerCase() : '';
      const tagStr = Array.isArray(b.tags) ? b.tags.join(' ').toLowerCase() : '';
      const haystack = `${titleStr} ${aliasStr} ${tagStr}`;
      return tokens.every((tok) => haystack.includes(tok));
    }).slice(0, 10);

    if (matched.length === 0) return 0;

    for (const b of matched) {
      const isCurrent = b.id === currentId;
      const title = b.name || b.title || t('Untitled');
      const ts = b.modified || b.updated;
      const dateStr = ts ? new Date(ts).toLocaleDateString() : '';

      const tagPills = [];
      if (Array.isArray(b.tags)) {
        for (const tg of b.tags) {
          tagPills.push(h('span', {
            style: 'background:rgba(0,120,212,0.1);color:#0078d4;font-size:10px;font-weight:600;padding:1px 6px;border-radius:8px;margin-right:4px;'
          }, tg));
        }
      }
      if (Array.isArray(b.aliases)) {
        for (const al of b.aliases) {
          tagPills.push(h('span', {
            style: 'background:rgba(168,85,247,0.12);color:#9333ea;font-size:10px;font-weight:600;padding:1px 6px;border-radius:8px;margin-right:4px;'
          }, al));
        }
      }

      const row = h('div', {
        class: 'search-board-row',
        style: `display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-radius:10px;cursor:pointer;margin-bottom:4px;background:${isCurrent ? 'rgba(0,120,212,0.08)' : 'transparent'};transition:background 0.12s;`
      },
        h('div', { style: 'display:flex;flex-direction:column;gap:2px;' },
          h('div', { style: 'display:flex;align-items:center;gap:6px;' },
            h('span', { style: 'font-weight:600;font-size:13.5px;' }, title),
            isCurrent ? h('span', { style: 'font-size:10.5px;padding:1px 5px;background:#0078d4;color:#fff;border-radius:6px;' }, t('Current')) : ''
          ),
          h('div', { style: 'display:flex;align-items:center;' }, ...tagPills)
        ),
        h('span', { style: 'font-size:11.5px;color:var(--text-2,rgba(128,128,128,0.8));' }, dateStr)
      );

      row.addEventListener('mouseenter', () => { row.style.background = 'var(--surface-2, rgba(128,128,128,0.15))'; });
      row.addEventListener('mouseleave', () => { row.style.background = isCurrent ? 'rgba(0,120,212,0.08)' : 'transparent'; });
      row.addEventListener('click', () => {
        this.close();
        if (!isCurrent) {
          if (typeof this.app?.openBoardRef === 'function') {
            this.app.openBoardRef({ id: b.id, name: b.name || b.title });
          } else if (typeof this.app?.openBoard === 'function') {
            this.app.openBoard(b.id);
          }
        }
      });

      this.boardsContainer.appendChild(row);
    }

    return matched.length;
  }

  renderSettings(q) {
    if (!this.settingsContainer) return 0;
    this.settingsContainer.innerHTML = '';

    const app = this.app;
    const s = app?.settings || {};

    const settings = [
      {
        id: 'pressure',
        title: t('Pressure sensitivity'),
        desc: t('Vary ink width with how hard you press - within a stroke, not just between strokes'),
        type: 'toggle',
        get: () => s.pressure !== false,
        set: (v) => { s.pressure = v; app.saveSettings(); }
      },
      {
        id: 'scratchOut',
        title: t('Gesture Scratch-Out Eraser'),
        desc: t('Scribble back and forth over ink to erase it'),
        type: 'toggle',
        get: () => s.scratchOut !== false,
        set: (v) => {
          s.scratchOut = v;
          app.saveSettings();
          if (app.replayBar?.updateScratchUI) app.replayBar.updateScratchUI();
        }
      },
      {
        id: 'smoothCamera',
        title: t('Smooth Camera Easing'),
        desc: t('Animates pan and zoom transitions smoothly'),
        type: 'toggle',
        get: () => s.smoothCamera !== false && app?.surface?.cam?.glide !== false,
        set: (v) => {
          s.smoothCamera = v;
          if (app?.surface?.cam) app.surface.cam.glide = v;
          app.saveSettings();
        }
      },
      {
        id: 'inkToShape',
        title: t('Straighten shapes I draw'),
        desc: t('Hand-drawn circle, box or arrow snaps to a clean shape when you lift pen'),
        type: 'toggle',
        get: () => !!s.inkToShape,
        set: (v) => { s.inkToShape = v; app.saveSettings(); }
      },
      {
        id: 'penButtonErases',
        title: t('Pen side button rubs out'),
        desc: t('Hold stylus side button while drawing to erase'),
        type: 'toggle',
        get: () => s.penButtonErases !== false,
        set: (v) => { s.penButtonErases = v; app.saveSettings(); }
      },
      {
        id: 'inkWithMouse',
        title: t('Draw with the mouse'),
        desc: t('Choose whether mouse inks or pans canvas (Auto / Always / Never)'),
        type: 'choice',
        options: [['auto', t('Auto')], ['yes', t('Always')], ['no', t('Never')]],
        get: () => s.inkWithMouse || 'auto',
        set: (v) => { s.inkWithMouse = v; app.saveSettings(); }
      },
      {
        id: 'inkWithFinger',
        title: t('Draw with a finger'),
        desc: t('Choose whether finger inks or moves canvas (Auto / Always / Never)'),
        type: 'choice',
        options: [['auto', t('Auto')], ['yes', t('Always')], ['no', t('Never')]],
        get: () => s.inkWithFinger || 'auto',
        set: (v) => { s.inkWithFinger = v; app.saveSettings(); }
      },
      {
        id: 'inkPointer',
        title: t('Pointer while inking'),
        desc: t('Pen nib, Arrow or Crosshair pointer style'),
        type: 'choice',
        options: [['nib', t('Pen nib')], ['arrow', t('Arrow')], ['crosshair', t('Crosshair')]],
        get: () => s.inkPointer || 'nib',
        set: (v) => { s.inkPointer = v; app.saveSettings(); app.surface?.invalidate(); }
      },
      {
        id: 'rulerSnap',
        title: t('Ruler snapping'),
        desc: t('Snap drawn strokes and lines to the active ruler'),
        type: 'toggle',
        get: () => !!app?.ruler?.snap,
        set: (v) => { if (app?.ruler) app.ruler.snap = v; }
      },
      {
        id: 'theme',
        title: t('Theme'),
        desc: t('Application visual appearance (System / Light / Dark)'),
        type: 'choice',
        options: [['system', t('System')], ['light', t('Light')], ['dark', t('Dark')]],
        get: () => s.theme || 'system',
        set: (v) => { s.theme = v; app.saveSettings(); }
      },
      {
        id: 'mouseWheelMode',
        title: t('Mouse wheel action'),
        desc: t('Intelligent dual mode: wheel scrolls or zooms, while holding Ctrl switches to the other action.'),
        type: 'choice',
        options: [['scroll', t('Page scroll / Pan (Ctrl to zoom)')], ['zoom', t('Zoom in/out (Ctrl to scroll)')]],
        get: () => s.mouseWheelMode || (s.wheelZoom ? 'zoom' : 'scroll'),
        set: (v) => { s.mouseWheelMode = v; s.wheelZoom = (v === 'zoom'); app.saveSettings(); }
      },
      {
        id: 'enableHoverToolbar',
        title: t('Show quick actions on hover'),
        desc: t('Hovering over items shows the floating action menu (crop, duplicate, lock, delete) with Windows-style persistent focus.'),
        type: 'toggle',
        get: () => s.enableHoverToolbar !== false,
        set: (v) => { s.enableHoverToolbar = v; app.saveSettings(); }
      },
      {
        id: 'edgePan',
        title: t('Auto-pan at the edges'),
        desc: t('Scrolls canvas when pointer runs into window edge'),
        type: 'toggle',
        get: () => !!s.edgePan,
        set: (v) => { s.edgePan = v; app.saveSettings(); }
      },
      {
        id: 'returnToSelect',
        title: t('Return to select after drawing'),
        desc: t('Switches back to select tool immediately after lifting pen'),
        type: 'toggle',
        get: () => !!s.returnToSelect,
        set: (v) => { s.returnToSelect = v; app.saveSettings(); }
      },
      {
        id: 'showGroupOutlines',
        title: t('Outline grouped objects'),
        desc: t('Faint dashed ring around tied objects'),
        type: 'toggle',
        get: () => s.showGroupOutlines !== false,
        set: (v) => { s.showGroupOutlines = v; app.saveSettings(); app.surface?.invalidate(); }
      },
      {
        id: 'rightDragPans',
        title: t('Right-drag pans the canvas'),
        desc: t('Hold right mouse button and drag to pan canvas'),
        type: 'toggle',
        get: () => s.rightDragPans !== false,
        set: (v) => { s.rightDragPans = v; app.saveSettings(); }
      },
      {
        id: 'showToolKeys',
        title: t('Shortcut letters on toolbar'),
        desc: t('Shows key in corner of tool button (V, P, H, E)'),
        type: 'toggle',
        get: () => s.showToolKeys !== false,
        set: (v) => { s.showToolKeys = v; app.saveSettings(); }
      },
      {
        id: 'lowLatencyInk',
        title: t('Low-latency inking'),
        desc: t('Shaves lag off pen by skipping canvas buffering step'),
        type: 'toggle',
        get: () => !!s.lowLatencyInk,
        set: (v) => { s.lowLatencyInk = v; app.saveSettings(); app.toast(t('Takes effect next time GazBoard opens')); }
      },
      {
        id: 'inkTrail',
        title: t('Windows Ink trail (experimental)'),
        desc: t('Direct Windows Ink trail for low stylus latency'),
        type: 'toggle',
        get: () => !!s.inkTrail,
        set: (v) => { s.inkTrail = v; app.saveSettings(); app.inkTrail?.setEnabled(v); }
      },
      {
        id: 'boardsPage',
        title: t('My boards as a full page'),
        desc: t('Full page gallery with folder tiles vs simple list'),
        type: 'toggle',
        get: () => s.boardsPage !== false,
        set: (v) => { s.boardsPage = v; app.saveSettings(); }
      },
      {
        id: 'autosave',
        title: t('Autosave'),
        desc: t('Automatically save boards locally on this computer'),
        type: 'toggle',
        get: () => s.autosave !== false,
        set: (v) => { s.autosave = v; app.saveSettings(); }
      },
      {
        id: 'splitWorkspace',
        title: t('Split Study Workspace'),
        desc: t('Dual side-by-side view for PDF and active notes'),
        type: 'toggle',
        get: () => !!app?.splitWorkspace?.active,
        set: () => { app?.splitWorkspace?.toggle(); }
      },
      {
        id: 'replayBarDock',
        title: t('Replay Bar Dock Position'),
        desc: t('Dock floating toolbar to Top, Right, Bottom, or Left'),
        type: 'action',
        actionLabel: t('Rotate Dock'),
        run: () => {
          if (!app?.replayBar) return;
          const order = ['top', 'right', 'bottom', 'left'];
          const next = order[(order.indexOf(app.replayBar.dock) + 1) % order.length];
          app.replayBar.setDock(next);
          app.toast(t('Docked to {dock}', { dock: next }));
        }
      },
      {
        id: 'exportVideo',
        title: t('Export Replay Video (WebM)'),
        desc: t('Export animated canvas notes & audio track to video'),
        type: 'action',
        actionLabel: t('Export'),
        run: () => {
          this.close();
          import('../export-video.js').then((m) => m.exportVideoFile(app));
        }
      },
      {
        id: 'laserTrailDuration',
        title: t('Laser trail duration'),
        desc: t('How long the laser pointer trail lingers on screen (Instant, 300ms, 500ms, 1.0s, 1.5s, 5.0s, 10s)'),
        type: 'choice',
        options: [
          [0, t('Instant')],
          [300, '300ms'],
          [500, '500ms'],
          [1000, '1.0s'],
          [1500, '1.5s'],
          [5000, '5.0s'],
          [10000, '10s']
        ],
        get: () => Number(s.laserTrailDuration ?? 500),
        set: (v) => { s.laserTrailDuration = Number(v); app.saveSettings(); if (app.surface) app.surface.dirty = true; }
      },
      {
        id: 'penOpacity',
        title: t('Pen opacity'),
        desc: t('Allow drawing translucent pen strokes for layering effects'),
        type: 'toggle',
        get: () => s.penOpacityEnabled === true,
        set: (v) => { s.penOpacityEnabled = v; app.saveSettings(); }
      },
      {
        id: 'boardLinkThumb',
        title: t('Board link thumbnails'),
        desc: t('Show thumbnail picture previews on board link cards by default'),
        type: 'toggle',
        get: () => s.boardLinkThumb !== false,
        set: (v) => { s.boardLinkThumb = v; app.saveSettings(); app.surface?.invalidate(); }
      },
      {
        id: 'holdToShape',
        title: t('Hold at end of stroke to snap shape'),
        desc: t('Pause stylus briefly at the end of a stroke to convert it to a clean geometric shape or line'),
        type: 'toggle',
        get: () => s.holdToShape !== false,
        set: (v) => { s.holdToShape = v; app.saveSettings(); }
      },
      {
        id: 'autoDimBarsWhileInking',
        title: t('Auto-dim bars while writing'),
        desc: t('Fade floating toolbars to low opacity while actively drawing on the canvas'),
        type: 'toggle',
        get: () => s.autoDimBarsWhileInking !== false,
        set: (v) => { s.autoDimBarsWhileInking = v; app.saveSettings(); }
      },
      {
        id: 'replaySkipSilence',
        title: t('Skip dead air (silence)'),
        desc: t('Automatically fast-forward across long silent gaps (>2s) during audio replay'),
        type: 'toggle',
        get: () => !!s.replaySkipSilence,
        set: (v) => { s.replaySkipSilence = v; app.saveSettings(); }
      },
      {
        id: 'tapStrokeToSeek',
        title: t('Tap stroke to seek audio'),
        desc: t('Tap any synced stroke in Reading Mode (or Alt+Click in Select) to jump audio playback to that moment'),
        type: 'toggle',
        get: () => s.tapStrokeToSeek !== false,
        set: (v) => { s.tapStrokeToSeek = v; app.saveSettings(); }
      },
      {
        id: 'splitSyncScroll',
        title: t('Sync dual-pane scroll & zoom'),
        desc: t('Synchronize pan and zoom between the left study board and main board in Split Workspace'),
        type: 'toggle',
        get: () => !!s.splitSyncScroll,
        set: (v) => {
          s.splitSyncScroll = v;
          app.saveSettings();
          if (app?.splitWorkspace?.btnSyncScroll) {
            app.splitWorkspace.btnSyncScroll.style.background = v ? 'var(--accent,#0078d4)' : 'rgba(128,128,128,0.12)';
            app.splitWorkspace.btnSyncScroll.style.color = v ? '#ffffff' : 'inherit';
          }
        }
      }
    ];

    const tokens = q ? q.toLowerCase().split(/\s+/).filter(Boolean) : [];
    const matched = settings.filter((item) => {
      if (!tokens.length) return true;
      const haystack = `${item.id} ${item.title} ${item.desc}`.toLowerCase();
      return tokens.every((tok) => haystack.includes(tok));
    });

    if (matched.length === 0) return 0;

    for (const item of matched) {
      let control = null;
      if (item.type === 'toggle') {
        const checked = item.get();
        const toggleBtn = h('button', {
          style: `padding:4px 12px;border-radius:14px;border:none;cursor:pointer;font-size:11.5px;font-weight:600;background:${checked ? '#0078d4' : 'rgba(128,128,128,0.2)'};color:${checked ? '#ffffff' : 'inherit'};transition:background 0.15s;`
        }, checked ? t('ON') : t('OFF'));
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const next = !item.get();
          item.set(next);
          this.renderSettings(q);
        });
        control = toggleBtn;
      } else if (item.type === 'choice') {
        const curVal = item.get();
        const select = h('select', {
          style: 'padding:3px 8px;border-radius:10px;border:1px solid var(--line,rgba(128,128,128,0.2));background:var(--desk,#f0f0f4);font-size:11.5px;font-weight:500;color:inherit;outline:none;'
        });
        for (const [val, label] of item.options) {
          const opt = document.createElement('option');
          opt.value = String(val);
          opt.textContent = label;
          if (String(val) === String(curVal)) opt.selected = true;
          select.appendChild(opt);
        }
        select.addEventListener('change', (e) => {
          e.stopPropagation();
          const matched = item.options.find(([v]) => String(v) === select.value);
          const finalVal = (matched && typeof matched[0] === 'number') ? Number(select.value) : (matched ? matched[0] : select.value);
          item.set(finalVal);
        });
        control = select;
      } else if (item.type === 'action') {
        const actBtn = h('button', {
          style: 'padding:4px 10px;border-radius:14px;border:1px solid var(--line,rgba(0,0,0,0.15));background:none;cursor:pointer;font-size:11.5px;font-weight:600;color:inherit;'
        }, item.actionLabel);
        actBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          item.run();
        });
        control = actBtn;
      }

      const row = h('div', {
        class: 'search-setting-row',
        style: 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-radius:10px;margin-bottom:4px;transition:background 0.12s;'
      },
        h('div', { style: 'display:flex;flex-direction:column;gap:2px;' },
          h('span', { style: 'font-weight:600;font-size:13px;' }, item.title),
          h('span', { style: 'font-size:11px;color:var(--text-2,rgba(128,128,128,0.8));' }, item.desc)
        ),
        control
      );

      row.addEventListener('mouseenter', () => { row.style.background = 'var(--surface-2, rgba(128,128,128,0.15))'; });
      row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });

      this.settingsContainer.appendChild(row);
    }

    return matched.length;
  }
}
