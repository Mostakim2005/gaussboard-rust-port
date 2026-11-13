import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function makeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    toggle: (name, force) => {
      if (typeof force === 'boolean') {
        if (force) set.add(name);
        else set.delete(name);
        return force;
      }
      if (set.has(name)) {
        set.delete(name);
        return false;
      }
      set.add(name);
      return true;
    },
    contains: (name) => set.has(name),
    values: () => [...set]
  };
}

function makeMockDom() {
  const byId = new Map();
  const storage = new Map();
  const created = [];

  function makeEl(tag = 'div', attrs = {}) {
    const listeners = new Map();
    const cl = makeClassList();
    const el = {
      tagName: String(tag).toUpperCase(),
      id: attrs.id || '',
      style: {},
      dataset: {},
      attributes: {},
      classList: cl,
      children: [],
      hidden: false,
      checked: false,
      disabled: false,
      _text: '',
      _html: '',
      parentNode: null,
      set className(val) {
        for (const old of cl.values()) cl.remove(old);
        for (const cls of String(val || '').split(/\s+/).filter(Boolean)) cl.add(cls);
      },
      get className() {
        return cl.values().join(' ');
      },
      set textContent(v) { this._text = String(v ?? ''); },
      get textContent() { return this._text || this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join(''); },
      set innerHTML(v) { this._html = String(v ?? ''); if (v === '') this.children = []; },
      get innerHTML() { return this._html; },
      appendChild(child) {
        if (typeof child === 'string') {
          this.children.push(child);
        } else if (child) {
          child.parentNode = this;
          this.children.push(child);
          if (child.id) byId.set(child.id, child);
        }
        return child;
      },
      setAttribute(k, v) {
        this.attributes[k] = String(v);
        if (k === 'id') {
          this.id = String(v);
          byId.set(this.id, this);
        } else if (k === 'class') {
          this.className = v;
        } else if (k === 'checked') {
          this.checked = true;
        }
      },
      getAttribute(k) { return this.attributes[k] ?? null; },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatch(type, ev = {}) {
        for (const fn of listeners.get(type) || []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...ev });
      },
      click() {
        if (this.tagName === 'INPUT' && this.attributes.type === 'checkbox') this.checked = !this.checked;
        this.dispatch('click');
        if (this.tagName === 'INPUT' && this.attributes.type === 'checkbox') this.dispatch('change');
      },
      querySelectorAll(sel) {
        const res = [];
        const cls = sel.startsWith('.') ? sel.slice(1) : null;
        const walk = (node) => {
          if (!node || typeof node === 'string') return;
          if ((cls && node.classList?.contains(cls)) || (!cls && node.tagName === sel.toUpperCase())) res.push(node);
          for (const ch of node.children || []) walk(ch);
        };
        walk(this);
        return res;
      },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      getBoundingClientRect() { return { left: 0, top: 0, width: 360, height: 600, right: 360, bottom: 600 }; }
    };
    created.push(el);
    return el;
  }

  const stage = makeEl('div', { id: 'stage' });
  byId.set('stage', stage);
  const rootEl = makeEl('html');
  const bodyEl = makeEl('body');

  globalThis.localStorage = {
    getItem: (k) => (storage.has(String(k)) ? storage.get(String(k)) : null),
    setItem: (k, v) => storage.set(String(k), String(v)),
    removeItem: (k) => storage.delete(String(k)),
    clear: () => storage.clear()
  };

  globalThis.document = {
    documentElement: rootEl,
    body: bodyEl,
    createElement: (tag) => makeEl(tag),
    createTextNode: (txt) => String(txt),
    getElementById: (id) => byId.get(id) || null,
    querySelectorAll: (sel) => stage.querySelectorAll(sel),
    querySelector: (sel) => stage.querySelector(sel),
    addEventListener() {},
    removeEventListener() {}
  };

  globalThis.window = {
    ...(globalThis.window || {}),
    innerWidth: 1280,
    innerHeight: 800,
    matchMedia: () => ({ matches: false, addEventListener() {} })
  };

  return { byId, stage, rootEl, bodyEl, makeEl };
}

test('CSS & drawers enforce unified --z-* layering tokens without outlier z-index values', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/css/app.css'), 'utf8');
  for (const token of ['--z-canvas', '--z-hud', '--z-topbar', '--z-pill', '--z-drawer', '--z-popover', '--z-dropdown', '--z-modal', '--z-fullscreen-modal', '--z-omnibar']) {
    assert.ok(css.includes(token), `Missing ${token} in :root`);
  }
  const highHardcoded = [...css.matchAll(/z-index\s*:\s*(\d+)\s*;/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n >= 900);
  assert.deepEqual(highHardcoded, [], `Unexpected hardcoded high z-index in app.css: ${highHardcoded}`);

  for (const rel of [
    'src/js/ui/audio-bar.js',
    'src/js/ui/pdf-sidebar.js',
    'src/js/ui/note-overview.js',
    'src/js/ui/search-dialog.js',
    'src/js/ui/properties-dialog.js'
  ]) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const drawerOutliers = [...src.matchAll(/z-index\s*:\s*(\d+)/g)]
      .map((m) => Number(m[1]))
      .filter((n) => n >= 9000);
    // Properties modal & omnibar & drawers migrated to var(--z-*)
    if (rel === 'src/js/ui/search-dialog.js' || rel === 'src/js/ui/properties-dialog.js' || rel === 'src/js/ui/pdf-sidebar.js') {
      assert.deepEqual(drawerOutliers, [], `${rel} still contains raw >=9000 z-index`);
    }
  }
});

test('CSS contains zero-overlap clearance rules for left latch/pagetab, center pills, right drawers, and Zen/HUD hides', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/css/app.css'), 'utf8');
  const toolsSrc = fs.readFileSync(path.join(ROOT, 'src/js/core/tools.js'), 'utf8');

  assert.ok(css.includes('body.ribbon-left #pagetab'), '#pagetab clears left ribbon latch');
  assert.ok(css.includes('body.left-drawer-open #pagetab'), '#pagetab hides when left drawer open');
  assert.ok(css.includes('body.replay-bar-open #backPill'), '#backPill stacks cleanly below replayBar');
  assert.ok(css.includes('body.studio-open #zoombar'), 'zoombar shifts left when Workflow Studio opens');
  assert.ok(css.includes('body.zen-mode #topbar'), 'Zen mode hides topbar');
  assert.ok(css.includes('body.hud-hide-toolbar #toolbar'), 'Per-HUD toggle hides toolbar');
  assert.ok(css.includes('html[data-ui-style="material"]'), 'Material 3 visual rules present');
  assert.ok(css.includes('html[data-ui-style="glassmorphism"]'), 'Glassmorphism visual rules present');

  for (const hole of ['workflowStudioSheet', 'zenPill', 'hiddenPill', 'replayBar', 'audioBar', 'backPill', 'viewPill']) {
    assert.ok(toolsSrc.includes(`'${hole}'`), `Interaction.visibleArea() missing UI exclusion hole: ${hole}`);
  }
});

test('WorkflowStudio switches Material 3 / Glassmorphism, all 4 workflows, HUD hides, hidden elements, and protocol flags', async () => {
  const { bodyEl, rootEl } = makeMockDom();
  const { Store } = await import('../src/js/core/store.js');
  const { attachNativeFallbacks } = await import('../src/js/platform/native-fallbacks.js');
  const { WorkflowStudio } = await import('../src/js/ui/workflow-studio.js');
  const { StudyRunner } = await import('../src/js/ui/study-runner.js');

  globalThis.window.board = attachNativeFallbacks({});
  const store = new Store();
  store.add({ id: 'cov1', type: 'curtain', x: 0, y: 0, w: 120, h: 60, revealed: false }, 'cover');
  store.add({ id: 'hid1', type: 'note', attachedTo: 'cov1', x: 10, y: 10, w: 80, h: 40, text: 'Secret note', hidden: true, hiddenManual: true }, 'note');
  store.add({ id: 'att1', type: 'text', attachedTo: 'cov1', x: 20, y: 20, text: 'Answer text', hidden: false }, 'text');

  let themeApplied = 0;
  let hudApplied = 0;
  let lastProtocol = null;
  let syncCalls = 0;
  const app = {
    store,
    darkMode: false,
    surface: { selection: new Set(['att1']), invalidate() {} },
    sidebarRibbon: {
      styleMode: 'glassmorphism',
      syncStateCalls: 0,
      syncState() { this.syncStateCalls++; }
    },
    settings: {
      sidebarRibbonStyle: 'glassmorphism',
      markdownEditMode: 'live',
      defaultCardStyle: 'canvas',
      videoQuickBookmark: true,
      audioInkSync: true,
      replayCameraFollow: true,
      replaySkipSilence: false,
      replayCameraMode: 'viewport',
      zenMode: false,
      hudHideTopbar: false,
      enableObsidianProtocol: true,
      enableLanSyncProtocol: true,
      enableAudioSyncProtocol: true,
      enableStudySrsProtocol: true
    },
    saveSettings() {},
    applyTheme() {
      themeApplied++;
      rootEl.dataset.uiStyle = this.settings.sidebarRibbonStyle;
    },
    applyHudPreferences() {
      hudApplied++;
      bodyEl.classList.toggle('zen-mode', !!this.settings.zenMode);
      bodyEl.classList.toggle('hud-hide-topbar', !!this.settings.hudHideTopbar);
    },
    setZenMode(v) {
      this.settings.zenMode = !!v;
      this.applyHudPreferences();
    },
    applyProtocolPreferences(k, v) { lastProtocol = [k, v]; },
    updateHudLayout() {},
    syncUI() { syncCalls++; },
    unhideObject(id) {
      this.store.update(id, { hiddenManual: false, hidden: false }, 'restore');
    }
  };

  const ws = new WorkflowStudio(app);
  ws.open();
  assert.equal(ws.isOpen, true);
  await ws._refreshContrastBadge();
  assert.match(ws.contrastBadge.textContent, /^WCAG AA/);

  // 1. Toggle Glassmorphism -> Material 3
  const segButtons = ws.body.querySelectorAll('.ws-seg-btn');
  const matBtn = segButtons.find((b) => b.textContent === 'Material 3');
  assert.ok(matBtn, 'Material 3 toggle rendered');
  matBtn.click();
  assert.equal(app.settings.sidebarRibbonStyle, 'material');
  assert.equal(app.sidebarRibbon.styleMode, 'material');
  assert.ok(app.sidebarRibbon.syncStateCalls >= 1);
  assert.ok(themeApplied >= 1);
  assert.equal(rootEl.dataset.uiStyle, 'material');

  // 2. Toggle Page Bounds -> Clipped Sheets
  const clippedBtn = ws.body.querySelectorAll('.ws-seg-btn').find((b) => b.textContent === 'Clipped Sheets');
  assert.ok(clippedBtn, 'Clipped Sheets button rendered');
  clippedBtn.click();
  assert.equal(store.doc.pageClip, true);

  // 3. StudyRunner cover reveal/conceal NEVER unhides hiddenManual object
  const runner = new StudyRunner({
    ...app,
    onCovers: (ids) => store.objects.filter((o) => ids.includes(o.attachedTo))
  });
  runner.setReviewState({ object: store.get('cov1') }, true);
  assert.equal(store.get('att1').hidden, true);
  assert.equal(store.get('hid1').hidden, true);
  runner.setReviewState({ object: store.get('cov1') }, false);
  assert.equal(store.get('att1').hidden, false);
  assert.equal(store.get('hid1').hidden, true, 'Manually hidden element stayed hidden after cover concealed');
  assert.equal(store.get('hid1').hiddenManual, true);

  // 4. Restore hidden element from WorkflowStudio list
  const showBtn = ws.body.querySelectorAll('.ws-mini-btn').find((b) => b.textContent === 'Show');
  assert.ok(showBtn, 'Show button for hidden element rendered');
  showBtn.click();
  assert.equal(store.get('hid1').hidden, false);
  assert.equal(store.get('hid1').hiddenManual, false);

  // 5. Toggle HUD Panel chip & Zen mode & Protocol switch
  const chips = ws.body.querySelectorAll('.ws-chip');
  assert.ok(chips.length >= 8, '8 HUD panel chips rendered');
  chips[0].click();
  assert.equal(app.settings.hudHideTopbar, true);
  assert.ok(hudApplied >= 1);
  assert.equal(bodyEl.classList.contains('hud-hide-topbar'), true);

  const checkboxes = ws.body.querySelectorAll('input');
  const protoBox = checkboxes[checkboxes.length - 1];
  protoBox.click();
  assert.equal(app.settings.enableStudySrsProtocol, false);
  assert.deepEqual(lastProtocol, ['enableStudySrsProtocol', false]);

  ws.close();
  assert.equal(ws.isOpen, false);
  assert.ok(syncCalls >= 2);
});

test('Rust <-> JS bridge and fallbacks maintain parameter alignment, TRAP 2 stroke timestamps, SRS, search, markdown, and bundle parity', async () => {
  makeMockDom();
  const tauriSrc = fs.readFileSync(path.join(ROOT, 'src/js/platform/tauri-board.js'), 'utf8');
  assert.match(tauriSrc, /tags:\s*Array\.isArray\(tags\)\s*\?\s*tags\.join\(',\'\)/, 'tauri-board search indexes serialize tags string matching search.rs');
  assert.match(tauriSrc, /recordLinks:\s*\(boardId,\s*boardTitle,\s*links\)\s*=>\s*\n?\s*invoke\('graph_record_links',\s*\{\s*boardId,\s*boardTitle,\s*targets:/, 'graph_record_links uses targets param matching search.rs');

  const { attachNativeFallbacks, fallbackFitStroke } = await import('../src/js/platform/native-fallbacks.js');
  const { renderMarkdownToHtmlNative } = await import('../src/js/core/markdown.js');
  const fb = attachNativeFallbacks({});
  globalThis.window.board = fb;

  // Colorimetry WCAG & invertThemeInk
  const wcag = await fb.colorimetry.wcagContrast('#000000', '#ffffff');
  assert.ok(wcag.wcag_aaa_normal && wcag.ratio > 20);
  const adapted = await fb.colorimetry.invertThemeInk('#111111', '#1a1a1a', true);
  assert.notEqual(adapted, '#111111');

  // Stroke fitStroke preserves p.t (TRAP 2)
  const fit = fallbackFitStroke([
    { x: 0, y: 0, t: 100 },
    { x: 50, y: 40, t: 250 },
    { x: 100, y: 20, t: 500 }
  ], 1.0);
  assert.ok(fit.segments.length >= 1);
  assert.equal(fit.segments[0].t_start, 100);
  assert.equal(fit.segments[fit.segments.length - 1].t_end, 500);

  // Markdown native fallback & custom bridge delegation
  const htmlFb = await renderMarkdownToHtmlNative('# Heading\n\nBody text');
  assert.match(htmlFb, /Heading/);
  let calledNativeMd = false;
  globalThis.window.board = {
    ...fb,
    markdown: {
      renderToHtml: async () => { calledNativeMd = true; return '<h1>Rust</h1>'; }
    }
  };
  const htmlRust = await renderMarkdownToHtmlNative('# Heading');
  assert.equal(calledNativeMd, true);
  assert.equal(htmlRust, '<h1>Rust</h1>');

  // Search FTS5 + Backlinks + FSRS SRS + Audio-to-Ink Temporal Indexing fallbacks
  await fb.search.indexBoard('b1', 'Physics Lecture', 'Maxwell equations #optics', ['optics']);
  await fb.search.indexPdf('b1', 'Optics Notes', 'C:/docs/optics.pdf', ['physics']);
  await fb.search.recordLinks('b2', 'Notes', ['b1']);
  await fb.search.scheduleSrsCard('card1', 'b1', 'Recall Maxwell', 0, 2.5, 5.0);
  await fb.search.recordStrokeTiming('b1', 'sess1', [{ stroke_id: 's1', t_start_ms: 1200, t_end_ms: 2400, center_x: 100, center_y: 200, bbox_width: 40, bbox_height: 10 }]);
  await fb.search.indexAudioTranscript('b1', 'sess1', [{ word: 'Faraday', start_ms: 1500, end_ms: 2100 }]);

  const qHits = await fb.search.query('Maxwell', 10);
  assert.equal(qHits[0].board_id, 'b1');
  const backlinks = await fb.search.getBacklinks('b1');
  assert.equal(backlinks[0].source_board_id, 'b2');
  const due = await fb.search.getSrsDueCards();
  assert.ok(due.some((c) => c.card_id === 'card1'));
  const audioHits = await fb.search.searchAudioToInk('Faraday', 10);
  assert.equal(audioHits[0].stroke_id, 's1');
});
