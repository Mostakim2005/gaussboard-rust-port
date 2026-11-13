// Bottom tool pill + its option popovers, plus the top bar wiring.

import { icon } from './icons.js';
import { openPopover, closePopover, h, isOpen } from './popover.js';
import {
  PEN_COLORS, PEN_EFFECTS, HIGHLIGHTER_COLORS, NOTE_COLORS, TEXT_COLORS,
  SHAPE_STROKES, SHAPE_FILLS, SHAPES, SHAPE_LABELS, shapeIcon,
  PENS, penList, penById, rememberPen, heldPenId, penIcon, FONTS, PENCIL_GRAPHITE
} from './palettes.js';
import { EMOJI_GROUPS, searchEmoji } from '../core/emoji.js';
import { inkPaint, isDarkBoard, isDarkColor } from '../core/render.js';
import { t } from '../i18n.js';

const TOOL_ICON = {
  select: 'select', lasso: 'lasso', pen: 'pen', highlighter: 'highlighter',
  brush: 'brush', fountain: 'fountain', calligraphy: 'calligraphy',
  eraser: 'eraser', note: 'note', text: 'text', shape: 'shapes', emoji: 'emoji'
};
const CMD_ICON = { undo: 'undo', redo: 'redo', insert: 'insert', ruler: 'ruler', more: 'more' };

/**
 * The toolbar is built here rather than in the HTML, because the pen tray is
 * data-driven: each pen is its own button carrying its own colour, the way
 * Whiteboard lays them out, and the one in your hand lifts out of the bar.
 */
/**
 * Is this a phone-shaped screen being poked with a finger?
 *
 * Both halves matter. A coarse pointer alone catches a 12" tablet, which has
 * room for the whole tray; a narrow window alone catches a half-width desktop
 * window, where the mouse is still the pointer and the keys still work. The
 * compact bar is for the case where neither the width nor the pointer is
 * generous - and it is read once, at start-up, because rebuilding a toolbar
 * under somebody's thumb while they rotate the phone is worse than a bar that
 * is slightly too small until the next launch.
 */
export function isPhoneLayout() {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia('(pointer: coarse)').matches
    && (matchMedia('(max-width: 760px)').matches || matchMedia('(max-height: 460px)').matches);
}

/**
 * Wires the Markdown toggle badge (`M↓`) and Wikilink button (`[[]]`) into
 * `#textFormatBar` if present in the DOM.
 */
export function wireTextFormatBarMarkdown(app) {
  const fmtBar = document.getElementById('textFormatBar');
  if (!fmtBar) return;

  let mdBtn = fmtBar.querySelector('[data-cmd="markdownToggle"]');
  if (!mdBtn) {
    mdBtn = h('button', {
      class: 'tool tool-sm md-toggle-btn',
      title: t('Markdown'),
      style: 'font-weight:700;font-size:12px;padding:0 6px;'
    }, 'M↓');
    mdBtn.dataset.cmd = 'markdownToggle';
    mdBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = app.textEditor?.target
        || (app.surface?.selection?.size === 1 ? app.store.get([...app.surface.selection][0]) : null);
      if (app.textEditor?.active && (!target || target.markdown !== false)) {
        app.textEditor.toggleLivePreview();
        mdBtn.classList.toggle('active', app.textEditor.previewMode);
        return;
      }
      if (target && (target.type === 'text' || target.type === 'note')) {
        const next = target.markdown === false;
        app.store.update(target.id, { markdown: next }, 'markdown mode');
        mdBtn.classList.toggle('active', next);
        app.surface?.invalidate();
      }
    });
    fmtBar.appendChild(mdBtn);
  }

  let wlBtn = fmtBar.querySelector('[data-cmd="insertWikilink"]');
  if (!wlBtn) {
    wlBtn = h('button', {
      class: 'tool tool-sm',
      title: t('Insert Wikilink'),
      style: 'font-weight:600;font-size:11.5px;padding:0 5px;'
    }, '[[]]');
    wlBtn.dataset.cmd = 'insertWikilink';
    wlBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (app.textEditor?.active) {
        app.textEditor.insertWikilinkSyntax();
      } else {
        app.command?.('insert.boardlink');
      }
    });
    fmtBar.appendChild(wlBtn);
  }

  const activeTarget = app.textEditor?.target
    || (app.surface?.selection?.size === 1 ? app.store.get([...app.surface.selection][0]) : null);
  if (activeTarget && (activeTarget.type === 'text' || activeTarget.type === 'note')) {
    mdBtn.classList.toggle('active', activeTarget.markdown !== false);
  }
}

export function initToolbar(app) {
  const bar = document.getElementById('toolbar');
  bar.innerHTML = '';
  wireTextFormatBarMarkdown(app);
  if (isPhoneLayout()) { initPhoneToolbar(app, bar); wireTopBar(app); return; }

  const sep = (dataSep) => {
    const s = h('div', { class: 'sep' });
    if (dataSep) s.dataset.sep = dataSep;
    bar.appendChild(s);
    return s;
  };

  const iconTool = (opts) => {
    const b = h('button', { class: 'tool', title: opts.title });
    if (opts.tool) b.dataset.tool = opts.tool;
    if (opts.cmd) b.dataset.cmd = opts.cmd;
    if (opts.pop) b.dataset.pop = opts.pop;
    if (opts.ribbonId) {
      b.dataset.ribbonId = opts.ribbonId;
    }
    b.innerHTML = icon(opts.icon, 20);
    if (opts.dot) b.appendChild(h('span', { class: 'dot' }));
    // The shortcut letter lives on the button. Nobody memorises a shortcut
    // sheet mid-lesson; seeing "P" under the pen is what makes them get used.
    if (opts.key) b.appendChild(h('span', { class: 'kbd' }, opts.key));
    b.addEventListener('click', (e) => opts.onClick(e, b));
    bar.appendChild(b);
    return b;
  };
  const toggleTool = (tool) => (e, b) => {
    const was = app.tool === tool;
    app.setTool(tool);
    app.syncUI();
    if (was) openToolPopover(app, b, tool); else closePopover();
  };

  iconTool({ ribbonId: 'select', tool: 'select', icon: 'select', key: 'V', title: t('Select (V)'), onClick: () => app.setTool('select') });
  iconTool({ ribbonId: 'lasso', tool: 'lasso', icon: 'lasso', key: 'L', title: t('Lasso select (L)'), onClick: () => app.setTool('lasso') });
  iconTool({ ribbonId: 'pan', tool: 'pan', icon: 'hand', key: 'G', title: t('Pan the canvas (G) \u2014 drag to move around. Space, the middle mouse button and the scroll wheel do this too'),
    onClick: () => app.setTool('pan') });
  iconTool({ ribbonId: 'laser', tool: 'laser', icon: 'laser', key: 'X', title: t('Laser pointer (X) \u2014 click again for duration options'),
    onClick: toggleTool('laser') });
  sep('1');

  /* ---- the pen tray ---- */
  for (const pen of PENS) {
    const penIndex = PENS.indexOf(pen) + 1;
    const penRibbonId = 'pen:' + pen.id;
    const b = h('button', { class: 'pen', title: t('{pen} ({n}) \u2014 click again for thickness', { pen: pen.label, n: penIndex }) });
    b.dataset.pen = pen.id;
    b.dataset.ribbonId = penRibbonId;
    if (pen.id === 'black') b.dataset.tool = 'pen';       // the canonical pen button
    // every pen wears its own number: 1-6 reach them directly, which is the
    // whole point of putting the keys on the buttons
    const now = penById(app.settings, pen.id) || pen;
    // the barrel is a preview of the ink, so it follows it onto a dark board
    b.innerHTML = penIcon(inkPaint(now.color), now.effect) + '<span class="size-dot"></span>'
      + `<span class="kbd">${penIndex}</span>`;
    b.dataset.paint = now.color + '|' + now.effect;
    b.addEventListener('click', () => choosePen(app, pen.id, b));
    bar.appendChild(b);
  }

  const hl = h('button', { class: 'pen', title: t('Highlighter (H) \u2014 click again for options') });
  hl.dataset.tool = 'highlighter';
  hl.dataset.ribbonId = 'highlighter';
  hl.innerHTML = penIcon(app.settings.highlighterColor, 'none', 'highlighter') + '<span class="kbd">H</span>';
  hl.addEventListener('click', (e) => toggleTool('highlighter')(e, hl));
  bar.appendChild(hl);

  const brushBtn = h('button', { class: 'pen', title: t('Brush Pen (B) \u2014 click again for options') });
  brushBtn.dataset.tool = 'brush';
  brushBtn.dataset.ribbonId = 'brush';
  brushBtn.innerHTML = penIcon(app.settings.brushColor || app.settings.penColor || '#201f1e', 'none', 'brush') + '<span class="kbd">B</span>';
  brushBtn.addEventListener('click', (e) => toggleTool('brush')(e, brushBtn));
  bar.appendChild(brushBtn);

  const ftnBtn = h('button', { class: 'pen', title: t('Fountain Pen (F) \u2014 click again for options') });
  ftnBtn.dataset.tool = 'fountain';
  ftnBtn.dataset.ribbonId = 'fountain';
  ftnBtn.innerHTML = penIcon(app.settings.fountainColor || app.settings.penColor || '#002050', 'none', 'fountain') + '<span class="kbd">F</span>';
  ftnBtn.addEventListener('click', (e) => toggleTool('fountain')(e, ftnBtn));
  bar.appendChild(ftnBtn);

  const calBtn = h('button', { class: 'pen', title: t('Calligraphy Pen (C) \u2014 click again for options') });
  calBtn.dataset.tool = 'calligraphy';
  calBtn.dataset.ribbonId = 'calligraphy';
  calBtn.innerHTML = penIcon(app.settings.calligraphyColor || app.settings.penColor || '#1a1a1a', 'none', 'calligraphy') + '<span class="kbd">C</span>';
  calBtn.addEventListener('click', (e) => toggleTool('calligraphy')(e, calBtn));
  bar.appendChild(calBtn);
  const tapeBtn = h('button', { class: 'pen', title: t('Study Tape — click again for options') });
  tapeBtn.dataset.tool = 'tape';
  tapeBtn.dataset.ribbonId = 'tape';
  tapeBtn.innerHTML = penIcon(app.settings.tapeColor || '#a855f7', 'none', 'tape') + '<span class="kbd">T</span>';
  tapeBtn.addEventListener('click', (e) => toggleTool('tape')(e, tapeBtn));
  bar.appendChild(tapeBtn);

  const er = h('button', { class: 'pen', title: t('Eraser (E) \u2014 click again for options') });
  er.dataset.tool = 'eraser';
  er.dataset.ribbonId = 'eraser';
  er.innerHTML = penIcon('#f7a8c4', 'none', 'eraser') + '<span class="kbd">E</span>';
  er.addEventListener('click', (e) => toggleTool('eraser')(e, er));
  bar.appendChild(er);
  sep('2');

  iconTool({ ribbonId: 'ruler', cmd: 'ruler', icon: 'ruler', title: t('Ruler (Ctrl+R)'), onClick: () => app.command('ruler') });
  iconTool({ ribbonId: 'holdMode', cmd: 'toggleHoldMode', icon: 'radial', title: t('Hold gesture mode'), onClick: () => app.command('toggleHoldMode') });
  iconTool({ ribbonId: 'text', tool: 'text', icon: 'text', dot: true, key: 'T',
    title: t('Text Box (T) \u2014 click canvas to write notes or markdown; click again for font & size'),
    onClick: toggleTool('text') });
  iconTool({ ribbonId: 'note', tool: 'note', icon: 'note', dot: true, key: 'N',
    title: t('Sticky Note (N) \u2014 click canvas to place a note card; click again for colours'),
    onClick: toggleTool('note') });
  iconTool({ ribbonId: 'shape', tool: 'shape', icon: 'shapes', dot: true, key: 'S', title: t('Shapes (S)'),
    onClick: (e, b) => { app.setTool('shape'); app.syncUI(); openToolPopover(app, b, 'shape'); } });
  iconTool({ ribbonId: 'emoji', tool: 'emoji', icon: 'emoji', title: t('Emoji \u2014 pick one to stamp on the board'),
    onClick: (e, b) => { app.setTool('emoji'); app.syncUI(); openToolPopover(app, b, 'emoji'); } });

  const pinnedSlot = h('div', { id: 'pinnedToolsSlot', style: 'display:contents' });
  bar.appendChild(pinnedSlot);
  renderPinnedTools(app, pinnedSlot);

  iconTool({ cmd: 'insert', icon: 'insert', pop: 'insert', title: t('Insert document, table or template'),
    onClick: (e, b) => openInsertPopover(app, b) });
  sep('3');

  iconTool({ cmd: 'undo', icon: 'undo', title: t('Undo (Ctrl+Z)'), onClick: () => app.command('undo') });
  iconTool({ cmd: 'redo', icon: 'redo', title: t('Redo (Ctrl+Y)'), onClick: () => app.command('redo') });
  iconTool({ cmd: 'more', icon: 'more', pop: 'more', title: t('More'), onClick: (e, b) => openMorePopover(app, b) });

  wireTopBar(app);
  syncRibbonTools(app);
}

export function getPinMetadata(app) {
  return {
    'insert.markdown': { icon: 'text', title: t('Insert Markdown note'), onClick: () => app.insertMarkdownCard?.() },
    'insert.diagram': { icon: 'shapes', title: t('Diagram & Chart Studio'), onClick: () => app.openVisualizationStudio?.() },
    'insert.video': { icon: 'video', title: t('Video / YouTube'), onClick: () => app.openVideoInsertDialog?.() },
    'view.graph': { icon: 'shapes', title: t('Knowledge Graph View'), onClick: () => app.openGraphView?.() },
    'view.pdfSidebar': { icon: 'doc', title: t('Document Navigator & TOC'), onClick: () => app.togglePdfSidebar?.() },
    'insert.jsoncanvas': { icon: 'shapes', title: t('Obsidian Canvas (.canvas)'), onClick: () => app.command('insert.jsoncanvas') },
    'page.margin': { icon: 'palette', title: t('Page margins'), onClick: () => app.openPageMarginDialog?.() },
    'insert.image': { icon: 'image', title: t('Insert image'), onClick: () => app.command('insert.image') },
    'insert.audio': { icon: 'audio', title: t('Insert audio or recording'), onClick: () => app.command('insert.audio') },
    'insert.document': { icon: 'doc', title: t('Insert document'), onClick: () => app.command('insert.document') },
    'insert.table': { icon: 'table', title: t('Insert table'), onClick: () => app.command('insert.table') },
    'insert.math': { icon: 'maths', title: t('Insert maths formula'), onClick: () => app.command('insert.math') },
    'insert.curtain': { icon: 'curtain', title: t('Answer cover'), onClick: () => app.command('insert.curtain') },
    'insert.boardlink': { icon: 'link', title: t('Link to a board'), onClick: () => app.command('insert.boardlink') },
    'timer.open': { icon: 'timer', title: t('Class timer'), onClick: () => app.command('timer.open') },
    'view.present': { icon: 'present', title: t('Present'), onClick: () => app.command('view.present') },
    'panels.templates': { icon: 'template', title: t('Templates'), onClick: () => app.panels.templates() },
    'workbench.circuit': { icon: 'shapes', title: t('Circuit Simulation Workbench'), onClick: () => app.openCircuitWorkbench?.() },
    'math.grapher': { icon: 'maths', title: t('2D Function Grapher & Calculus'), onClick: () => app.openFunctionGrapher?.() },
    'science.molecule': { icon: 'shapes', title: t('3D Molecular Structure Viewer'), onClick: () => app.openMoleculeViewer?.() },
    'science.sketcher': { icon: 'shapes', title: t('2D Chemical Sketcher & SMILES'), onClick: () => app.openChemicalSketcher?.() },
    'science.periodic': { icon: 'table', title: t('Interactive Periodic Table'), onClick: () => app.openPeriodicTable?.() },
    'science.phet': { icon: 'shapes', title: t('PhET Simulation Lab'), onClick: () => app.openPhetRunner?.() },
    'esl.dictionary': { icon: 'doc', title: t('Academic Dictionary & Thesaurus'), onClick: () => app.openAcademicDictionary?.() },
    'study.session': { icon: 'curtain', title: t('Study Session & FSRS Review'), onClick: () => app.startStudySession?.() },
    'insert.kanban': { icon: 'table', title: t('Insert Kanban Board'), onClick: () => app.command('insert.kanban') },
    'insert.dataview': { icon: 'table', title: t('Run Dataview Query Table'), onClick: () => app.command('insert.dataview') }
  };
}

export function renderPinnedTools(app, slot = document.getElementById('pinnedToolsSlot')) {
  if (!slot) return;
  slot.innerHTML = '';
  if (!Array.isArray(app.settings.pinnedTools)) {
    app.settings.pinnedTools = ['insert.image'];
  }
  const metaMap = getPinMetadata(app);
  for (const pid of app.settings.pinnedTools) {
    const meta = metaMap[pid];
    if (!meta) continue;
    const b = h('button', {
      class: 'tool',
      title: `${meta.title} — ${t('Right-click to unpin')}`
    });
    b.dataset.cmd = pid;
    b.innerHTML = icon(meta.icon, 20);
    b.addEventListener('click', (e) => meta.onClick(e, b));
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      app.settings.pinnedTools = app.settings.pinnedTools.filter((id) => id !== pid);
      app.saveSettings();
      renderPinnedTools(app, slot);
      app.toast(t('Unpinned from ribbon'));
    });
    slot.appendChild(b);
  }
}

export function syncRibbonTools(app) {
  const bar = document.getElementById('toolbar');
  if (!bar) return;
  const hidden = new Set(app.settings.hiddenRibbonTools || []);

  bar.querySelectorAll('[data-ribbon-id]').forEach((el) => {
    const id = el.dataset.ribbonId;
    const isPen = id.startsWith('pen:');
    const isHidden = hidden.has(id) || (isPen && hidden.has('pen'));
    el.style.display = isHidden ? 'none' : '';
  });

  const slot = document.getElementById('pinnedToolsSlot');
  if (slot) {
    renderPinnedTools(app, slot);
  }

  const group1 = ['select', 'lasso', 'pan', 'laser'].some((id) => !hidden.has(id));
  const sep1 = bar.querySelector('[data-sep="1"]');
  if (sep1) sep1.style.display = group1 ? '' : 'none';

  const hasVisiblePen = PENS.some((p) => !hidden.has('pen:' + p.id) && !hidden.has('pen'));
  const group2 = hasVisiblePen || ['highlighter', 'brush', 'fountain', 'calligraphy', 'tape', 'eraser'].some((id) => !hidden.has(id));
  const sep2 = bar.querySelector('[data-sep="2"]');
  if (sep2) sep2.style.display = group2 ? '' : 'none';
}

export function moveRibbonToolToPlus(app, ribbonId) {
  if (!Array.isArray(app.settings.hiddenRibbonTools)) {
    app.settings.hiddenRibbonTools = [];
  }
  if (!app.settings.hiddenRibbonTools.includes(ribbonId)) {
    app.settings.hiddenRibbonTools.push(ribbonId);
    app.saveSettings();
  }
  syncRibbonTools(app);
  app.toast(t('Moved to + menu'));
}

export function restoreRibbonToolFromPlus(app, ribbonId) {
  if (Array.isArray(app.settings.hiddenRibbonTools)) {
    app.settings.hiddenRibbonTools = app.settings.hiddenRibbonTools.filter((id) => id !== ribbonId);
    app.saveSettings();
  }
  syncRibbonTools(app);
  app.toast(t('Pinned to ribbon'));
}

/* ==================================================================
 *  The phone bar.
 *
 *  The desktop tray is seventeen buttons wide. On a phone that becomes a
 *  horizontal scroller: the thing you reach for most - a pen - is as much work
 *  to find as the thing you reach for once a month, and both of them are a
 *  swipe away from where your thumb already is.
 *
 *  So this is a different bar, not the same bar squeezed. What survives on it
 *  is what a person writing on a board actually touches: three pens, the
 *  rubber, undo. Everything else earns its place behind one of two menus, and
 *  the pointing tools - select, lasso, hand, laser - go to the back, because
 *  none of them puts a mark on the board.
 *
 *  The desktop bar above is untouched. This is chosen once at start-up by
 *  isPhoneLayout(), so a laptop, a tablet and a half-width window all keep the
 *  tray they have always had.
 * ================================================================== */

/** The three pens that live on the bar; the rest are one tap deeper. */
const PHONE_PENS = ['black', 'red', 'blue'];

function initPhoneToolbar(app, bar) {
  bar.classList.add('phone');

  const btn = (cls, title, html) => {
    const b = h('button', { class: cls, title });
    b.innerHTML = html;
    bar.appendChild(b);
    return b;
  };
  const sep = () => bar.appendChild(h('div', { class: 'sep' }));

  const pickPen = (pen, b) => choosePen(app, pen.id, b);

  /* ---- the three everyday pens ---- */
  for (const id of PHONE_PENS) {
    const pen = PENS.find((p) => p.id === id);
    if (!pen) continue;
    const now = penById(app.settings, pen.id) || pen;
    const b = btn('pen', t('{pen} — tap again for thickness', { pen: pen.label }),
      penIcon(inkPaint(now.color), now.effect) + '<span class="size-dot"></span>');
    b.dataset.pen = pen.id;
    b.dataset.paint = now.color + '|' + now.effect;
    if (pen.id === 'black') b.dataset.tool = 'pen';
    b.addEventListener('click', () => pickPen(pen, b));
  }

  /* ---- everything else that makes a mark, one tap deeper ---- */
  const rest = btn('tool tool-sm', t('More pens and the highlighter'), icon('chevronUp', 18));
  rest.dataset.pop = 'pens';
  rest.addEventListener('click', () => {
    const body = h('div', { class: 'menu' });
    for (const pen of PENS) {
      if (PHONE_PENS.includes(pen.id)) continue;
      const now = penById(app.settings, pen.id) || pen;
      const row = h('button', { class: 'menu-item' },
        h('span', { html: penIcon(inkPaint(now.color), now.effect), style: 'display:flex;width:17px' }),
        h('span', {}, pen.label));
      row.addEventListener('click', () => { closePopover(); pickPen(pen, null); });
      body.appendChild(row);
    }
    body.appendChild(h('div', { class: 'menu-sep' }));
    body.appendChild(menuItem(t('Highlighter'), 'highlighter', () => { app.setTool('highlighter'); app.syncUI(); }));
    body.appendChild(menuItem(t('Study Tape'), 'curtain', () => { app.setTool('tape'); app.syncUI(); }));
    openPopover(rest, body, { key: 'pens' });
  });

  /* ---- the rubber, beside the pens where it belongs ---- */
  const er = btn('pen', t('Eraser — tap again for options'),
    penIcon('#f7a8c4', 'none', 'eraser'));
  er.dataset.tool = 'eraser';
  er.addEventListener('click', () => {
    const was = app.tool === 'eraser';
    app.setTool('eraser');
    app.syncUI();
    if (was) openToolPopover(app, er, 'eraser'); else closePopover();
  });
  sep();

  /*
   * Finger draws / finger moves the board.
   *
   * Only shown once a pen has actually touched this screen. On a phone with no
   * stylus the finger is the only thing there is, it draws, and a button
   * offering to take that away would be a trap rather than a choice.
   */
  const fingerBtn = btn('tool tool-sm', t('Finger draws or moves the board'), icon('hand', 18));
  fingerBtn.dataset.cmd = 'fingerInk';
  fingerBtn.addEventListener('click', () => { app.toggleFingerInk(); syncToolbar(app); });

  /* ---- undo and redo, the other thing a hand reaches for constantly ---- */
  const un = btn('tool tool-sm', t('Undo'), icon('undo', 18));
  un.dataset.cmd = 'undo';
  un.addEventListener('click', () => app.command('undo'));
  const re = btn('tool tool-sm', t('Redo'), icon('redo', 18));
  re.dataset.cmd = 'redo';
  re.addEventListener('click', () => app.command('redo'));
  sep();

  /* ---- things you add to the board ---- */
  const add = btn('tool tool-sm', t('Add a note, text, shape, ruler or picture'), icon('plus', 18));
  add.dataset.pop = 'add';
  add.addEventListener('click', () => {
    const pickTool = (t) => () => { app.setTool(t); app.syncUI(); };
    openPopover(add, h('div', { class: 'menu' },
      menuItem(t('Sticky note'), 'note', pickTool('note')),
      menuItem(t('Text'), 'text', pickTool('text')),
      menuItem(t('Study Tape'), 'curtain', pickTool('tape')),
      menuItem(t('Maths'), 'maths', () => app.command('insert.math')),
      menuItem(t('Emoji'), 'emoji', () => { app.setTool('emoji'); app.syncUI(); openToolPopover(app, add, 'emoji'); }),
      // Shapes are a family, not one square. The chooser lives in the tool
      // popover, and on a phone there is no shape button to open it from - so
      // picking Shape here opens it, anchored where the finger already is.
      menuItem(t('Shape'), 'shapes', () => { app.setTool('shape'); app.syncUI(); openToolPopover(app, add, 'shape'); }),
      // A phone has no Ctrl+V. Holding a finger on bare board opens the same
      // menu with a Paste that lands where you pressed; this is the one for
      // when you would rather not hunt for a clear patch of canvas.
      menuItem(t('Paste'), 'copy', () => app.pasteAt(null)),
      menuItem(app.ruler.visible ? t('Hide ruler') : t('Ruler'), 'ruler', () => app.command('ruler')),
      h('div', { class: 'menu-sep' }),
      menuItem(t('Markdown note…'), 'text', () => app.insertMarkdownCard?.()),
      menuItem(t('Picture…'), 'image', () => app.command('insert.image')),
      menuItem(t('Video / YouTube…'), 'video', () => app.openVideoInsertDialog?.()),
      menuItem(t('Document (Word, PowerPoint, PDF)…'), 'doc', () => app.command('insert.document')),
      menuItem(t('Table'), 'table', () => app.command('insert.table')),
      menuItem(t('Answer cover'), 'curtain', () => app.command('insert.curtain')),
      menuItem(t('Link to a board…'), 'link', () => app.command('insert.boardlink')),
      menuItem(t('Page margins…'), 'palette', () => app.openPageMarginDialog?.())
    ), { key: 'add' });
  });

  /* ---- and the rest: pointing tools first, then the old More menu ---- */
  const more = btn('tool tool-sm', t('More'), icon('more', 18));
  more.dataset.pop = 'more';
  more.addEventListener('click', () => {
    const pickTool = (t) => () => { app.setTool(t); app.syncUI(); };
    openPopover(more, h('div', { class: 'menu' },
      menuItem(t('Select'), 'select', pickTool('select')),
      menuItem(t('Lasso select'), 'lasso', pickTool('lasso')),
      menuItem(t('Move the board'), 'hand', pickTool('pan')),
      menuItem(t('Laser pointer'), 'laser', pickTool('laser')),
      h('div', { class: 'menu-sep' }),
      ...teachingItems(app),
      h('div', { class: 'menu-sep' }),
      menuItem(t('Boards…'), 'board', () => app.panels.boards()),
      menuItem(t('Templates…'), 'template', () => app.panels.templates()),
      menuItem(t('Canvas…'), 'palette', () => app.panels.background()),
      menuItem(t('Select all'), 'select', () => app.command('edit.selectAll')),
      h('div', { class: 'menu-sep' }),
      menuItem(t('Export as PNG…'), 'export', () => app.command('export.png')),
      menuItem(t('Export as PDF…'), 'doc', () => app.command('export.pdf')),
      menuItem(t('Save a copy…'), 'doc', () => app.command('board.save')),
      menuItem(t('Open board…'), 'board', () => app.command('board.open')),
      h('div', { class: 'menu-sep' }),
      menuItem(t('Share on this network…'), 'share', () => app.panels.sharing()),
      menuItem(t('Settings'), 'settings', () => app.panels.settings()),
      menuItem(t('About GaussBoard'), 'board', () => app.showAbout()),
      menuItem(t('Clear canvas'), 'trash', () => app.command('edit.clear'), { danger: true })
    ), { key: 'more' });
  });
}

/* ---- top bar and zoom controls ---- */
function wireTopBar(app) {
  const top = [
    ['btnBoards', 'board', () => app.panels.boards()],
    ['btnTemplates', 'template', () => app.panels.templates()],
    ['btnBackground', 'palette', () => app.panels.background()],
    ['btnExport', 'export', (e) => openExportPopover(app, e.currentTarget)],
    ['btnPresent', 'present', () => app.command('view.present')],
    ['btnShare', 'share', () => app.panels.sharing()],
    ['btnSettings', 'settings', () => app.panels.settings()],
    ['btnHelp', 'help', () => app.showShortcuts()]
  ];
  const labels = { btnBoards: t('Boards'), btnTemplates: t('Templates'), btnBackground: t('Canvas'), btnExport: t('Export'), btnPresent: t('Present') };
  for (const [id, ic, fn] of top) {
    const el = document.getElementById(id);
    // A build without sharing has no such button in the page, and asking for
    // one that is not there used to take the whole toolbar down with it.
    if (!el) continue;
    el.innerHTML = icon(ic, 18) + (labels[id] ? `<span>${labels[id]}</span>` : '');
    el.addEventListener('click', fn);
  }

  // Properties Button (Obsidian-style tags & aliases)
  const btnProps = document.getElementById('btnProperties');
  if (btnProps) {
    btnProps.addEventListener('click', () => {
      if (!app.propertiesDialog) {
        import('./properties-dialog.js').then((m) => {
          app.propertiesDialog = new m.PropertiesDialog(app);
          app.propertiesDialog.toggle();
        });
      } else {
        app.propertiesDialog.toggle();
      }
    });
  }

  // Omni Search Button
  const btnOmni = document.getElementById('btnOmniSearch');
  if (btnOmni) {
    btnOmni.addEventListener('click', () => {
      if (typeof app.toggleSearchDialog === 'function') {
        app.toggleSearchDialog();
      }
    });
  }

  // Sidebar Ribbon (Workbench) Button
  const btnRibbon = document.getElementById('btnSidebarRibbon');
  if (btnRibbon) {
    btnRibbon.addEventListener('click', () => {
      app.toggleSidebarRibbon?.();
    });
  }

  // Workflow Studio Button
  const btnStudio = document.getElementById('btnWorkflowStudio');
  if (btnStudio) {
    btnStudio.title = t('Workflow Studio, UI Style & Hide Controls (Ctrl+Shift+O)');
    const studioLbl = btnStudio.querySelector('span');
    if (studioLbl) studioLbl.textContent = t('Studio');
    btnStudio.addEventListener('click', () => {
      app.toggleWorkflowStudio?.();
    });
  }

  // Top Bar Embedded Audio Record Button
  const btnTopRec = document.getElementById('btnTopRecord');
  const lblTopTime = document.getElementById('topRecTime');
  if (btnTopRec) {
    let recTimer = null;
    let recStartTime = 0;

    const updateRecState = (isRecording) => {
      if (isRecording) {
        btnTopRec.style.boxShadow = '0 0 10px #ff3344, inset 0 0 4px #ff3344';
        btnTopRec.style.borderColor = '#ff3344';
        btnTopRec.style.color = '#ff3344';
        if (!recTimer) {
          recStartTime = Date.now();
          recTimer = setInterval(() => {
            const elapsed = Math.floor((Date.now() - recStartTime) / 1000);
            const m = Math.floor(elapsed / 60);
            const s = String(elapsed % 60).padStart(2, '0');
            if (lblTopTime) lblTopTime.textContent = `${m}:${s}`;
          }, 500);
        }
      } else {
        btnTopRec.style.boxShadow = 'none';
        btnTopRec.style.borderColor = 'var(--line,rgba(0,0,0,0.15))';
        btnTopRec.style.color = 'inherit';
        if (recTimer) {
          clearInterval(recTimer);
          recTimer = null;
        }
        if (lblTopTime) lblTopTime.textContent = t('Record');
      }
    };

    btnTopRec.addEventListener('click', async () => {
      if (!app.audioRecorder) {
        const { AudioRecorder } = await import('../core/audio-recorder.js');
        app.audioRecorder = new AudioRecorder(app);
      }
      if (app.audioRecorder.state === 'recording') {
        let res = null;
        try {
          res = await app.audioRecorder.stop();
        } catch {
          res = null;
        }
        if (res && res.assetId) {
          const track = {
            id: res.id,
            assetId: res.assetId,
            name: `Recording ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
            durationMs: res.durationMs,
            created: Date.now(),
            bookmarks: []
          };
          if (!Array.isArray(app.store.doc.audioTracks)) app.store.doc.audioTracks = [];
          const before = app.store.doc.audioTracks.map((item) => ({ ...item, bookmarks: (item.bookmarks || []).map((b) => ({ ...b })) }));
          app.store.doc.audioTracks.push(track);
          const after = app.store.doc.audioTracks.map((item) => ({ ...item, bookmarks: (item.bookmarks || []).map((b) => ({ ...b })) }));
          app.store.commit('record audio', [{ t: 'doc', before: { audioTracks: before }, after: { audioTracks: after } }]);
          app.audioBar?.open(track);
          if (typeof app.persist === 'function') await app.persist();
          if (app.replayBar?.syncAudioState) app.replayBar.syncAudioState();
          if (app.audioBar?.syncUI) app.audioBar.syncUI();
          app.toast?.(t('Recording stopped and saved to board'));
        } else {
          // The recorder failed to finalize: saying "saved" here would be a lie.
          app.toast?.(t('The recording could not be saved'));
        }
        updateRecState(false);
      } else {
        try {
          await app.audioRecorder.start();
          if (app.audioRecorder.state === 'recording') {
            updateRecState(true);
            app.toast?.(t('Recording started... Speak while you write!'));
          }
        } catch (err) {
          // A blocked microphone used to reject silently (no toast, button
          // still looking idle).
          app.toast?.(t('Microphone access denied: ') + (err?.message || ''));
          updateRecState(false);
        }
      }
    });
  }

  // Live top-bar chips for board tags & aliases (Image 3)
  app.updateTopProperties = () => {
    const container = document.getElementById('topPropertiesChips');
    if (!container) return;
    container.innerHTML = '';
    const doc = app.store?.doc;
    if (!doc) return;
    const tags = Array.isArray(doc.properties?.tags) ? doc.properties.tags : (Array.isArray(doc.tags) ? doc.tags : []);
    const aliases = Array.isArray(doc.properties?.aliases) ? doc.properties.aliases : (Array.isArray(doc.aliases) ? doc.aliases : []);

    if (aliases.length > 0) {
      for (const al of aliases.slice(0, 3)) {
        const chip = h('span', {
          class: 'prop-chip top-alias-chip',
          title: t('Board alias (Click to edit)'),
          style: 'cursor:pointer;font-size:11.5px;padding:2px 8px;border-radius:10px;background:rgba(168,85,247,0.14);color:#9333ea;font-weight:600;display:inline-flex;align-items:center;gap:3px;flex-shrink:0;'
        }, h('span', { style: 'font-size:10px;opacity:0.85;' }, '🏷️'), al);
        chip.addEventListener('click', () => {
          if (!app.propertiesDialog) {
            import('./properties-dialog.js').then((m) => {
              app.propertiesDialog = new m.PropertiesDialog(app);
              app.propertiesDialog.open();
            });
          } else {
            app.propertiesDialog.open();
          }
        });
        container.appendChild(chip);
      }
      if (aliases.length > 3) {
        container.appendChild(h('span', { style: 'font-size:10.5px;color:var(--text-2);' }, `+${aliases.length - 3}`));
      }
    }

    if (tags.length > 0) {
      for (const tg of tags.slice(0, 3)) {
        const chip = h('span', {
          class: 'prop-chip top-tag-chip',
          title: t('Board tag (Click to edit)'),
          style: 'cursor:pointer;font-size:11.5px;padding:2px 8px;border-radius:10px;background:rgba(0,120,212,0.12);color:var(--accent-2,#0078d4);font-weight:600;display:inline-flex;align-items:center;gap:3px;flex-shrink:0;'
        }, `#${String(tg).replace(/^#+/, '')}`);
        chip.addEventListener('click', () => {
          if (!app.propertiesDialog) {
            import('./properties-dialog.js').then((m) => {
              app.propertiesDialog = new m.PropertiesDialog(app);
              app.propertiesDialog.open();
            });
          } else {
            app.propertiesDialog.open();
          }
        });
        container.appendChild(chip);
      }
      if (tags.length > 3) {
        container.appendChild(h('span', { style: 'font-size:10.5px;color:var(--text-2);' }, `+${tags.length - 3}`));
      }
    }

    if (app.splitWorkspace?.enabled) {
      app.splitWorkspace.syncSplitTopbars?.();
    }
  };
  setTimeout(() => app.updateTopProperties?.(), 100);

  document.getElementById('panelClose').innerHTML = icon('close', 18);

  for (const [sel, name] of [['[data-cmd="zoomOut"]', 'zoomOut'], ['[data-cmd="zoomIn"]', 'zoomIn'], ['[data-cmd="fit"]', 'fit']]) {
    const el = document.querySelector('#zoombar ' + sel);
    el.innerHTML = icon(name, 18);
    el.addEventListener('click', () => app.command(name));
  }
  const zoomLabel = document.getElementById('zoomLabel');
  let zoomHoverTimer = null;
  const showZoomMenu = () => openZoomPresetPopover(app, zoomLabel);
  zoomLabel.addEventListener('mouseenter', () => {
    zoomHoverTimer = setTimeout(showZoomMenu, 240);
  });
  zoomLabel.addEventListener('mouseleave', () => clearTimeout(zoomHoverTimer));
  zoomLabel.addEventListener('click', () => {
    clearTimeout(zoomHoverTimer);
    showZoomMenu();
  });

  initPagebar(app);
}

const ZOOM_PRESETS = [900, 400, 200, 100, 50, 25];
function loadStarredZooms() {
  try {
    return JSON.parse(localStorage.getItem('gazboard:starred_zooms') || '[100, 200, 50]');
  } catch { return [100, 200, 50]; }
}
function saveStarredZooms(list) {
  localStorage.setItem('gazboard:starred_zooms', JSON.stringify(list));
}

function openZoomPresetPopover(app, anchor) {
  const currentPct = Math.round((app.surface?.cam?.z || 1) * 100);
  let starred = loadStarredZooms();
  const wrap = h('div', { class: 'menu zoom-presets-menu' });

  const list = h('div', { class: 'zoom-preset-list' });
  for (const pct of ZOOM_PRESETS) {
    const isStarred = starred.includes(pct);
    const isCurrent = Math.abs(currentPct - pct) < 3;
    const item = h('div', { class: `zoom-preset-item${isStarred ? ' starred' : ''}${isCurrent ? ' active' : ''}` });

    const starBtn = h('button', {
      class: 'zoom-star-btn',
      title: isStarred ? t('Remove from favorites') : t('Add to favorites')
    }, isStarred ? '★' : '☆');

    starBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      starred = isStarred ? starred.filter((p) => p !== pct) : [...starred, pct];
      saveStarredZooms(starred);
      openZoomPresetPopover(app, anchor);
    });

    const labelBtn = h('button', { class: 'zoom-val-btn' }, `${pct}%`);
    labelBtn.addEventListener('click', () => {
      app.zoomTo(pct / 100);
      closePopover();
    });

    item.appendChild(starBtn);
    item.appendChild(labelBtn);
    list.appendChild(item);
  }
  wrap.appendChild(list);
  wrap.appendChild(h('div', { class: 'menu-sep' }));

  wrap.appendChild(menuItem(t('Fit width'), 'fitWidth', () => { app.fitWidth(); closePopover(); }));
  wrap.appendChild(menuItem(t('Fit height'), 'fitHeight', () => { app.fitHeight(); closePopover(); }));
  wrap.appendChild(menuItem(t('Fit to page'), 'fitPage', () => { app.command('view.fitPage'); closePopover(); }));
  wrap.appendChild(menuItem(t('Fit to board'), 'fit', () => { app.command('fit'); closePopover(); }));

  openPopover(anchor, wrap, { align: 'above-center' });
}

/* ------------------------------------------------------------------ *
 *  The page navigator
 *
 *  Only ever shown on a pad. On an infinite board there are no pages to
 *  step through, and a control that is permanently disabled is just clutter.
 * ------------------------------------------------------------------ */
function initPagebar(app) {
  const bar = document.getElementById('pagebar');
  if (!bar) return;
  const btn = (k) => bar.querySelector(`[data-page="${k}"]`);
  btn('prev').innerHTML = icon('back', 18);
  btn('next').innerHTML = `<span style="display:flex;transform:rotate(180deg)">${icon('back', 18)}</span>`;
  btn('add').innerHTML = icon('insert', 18);
  btn('more').innerHTML = icon('more', 18);

  btn('prev').addEventListener('click', () => app.command('page.prev'));
  btn('next').addEventListener('click', () => app.command('page.next'));
  btn('add').addEventListener('click', () => app.command('page.add'));
  document.getElementById('pageLabel').addEventListener('click', () => app.command('view.fitPage'));

  btn('more').addEventListener('click', (e) => {
    const last = app.pageCount <= 1;
    openPopover(e.currentTarget, h('div', { class: 'menu' },
      menuItem(app.pageStrip?.open ? t('Hide page pictures') : t('Show page pictures'), 'grid', () => app.pageStrip?.toggle()),
      h('div', { class: 'menu-sep' }),
      menuItem(t('Add a page after this one'), 'insert', () => app.command('page.add')),
      menuItem(t('Duplicate this page'), 'duplicate', () => app.command('page.duplicate')),
      menuItem(t('Fit the whole pad in the window'), 'fit', () => app.command('view.fitAllPages')),
      menuItem(t('Fit everything onto the paper'), 'shapes', () => app.command('page.fitContent')),
      h('div', { class: 'menu-sep' }),
      menuItem(t('Delete this page'), 'trash', () => app.command('page.delete'), { danger: true, disabled: last })
    ), { align: 'end' });
  });
}

/** Reflect the current page in the navigator. Called from syncToolbar. */
function syncPagebar(app) { app.syncPageLabel(); }

/* ------------------------------------------------------------------ */
/** Move the `active` marker to `el` immediately - the popover stays open, so
 *  waiting for the next render would show the previous choice. */
function markActive(wrap, el, cls = 'active') {
  for (const sib of wrap.children) sib.classList.remove(cls);
  el.classList.add(cls);
}

function swatchRow(colors, current, onPick, extra = []) {
  const wrap = h('div', { class: 'swatches' });
  for (const c of colors) {
    const b = h('button', { class: 'sw' + (c === current ? ' active' : ''), title: c, 'aria-label': c });
    /*
     * A swatch has to show what the pen will actually put on the board. On a
     * dark board the default ink paints light, so a black circle here is a
     * promise the pen does not keep.
     *
     * Painting it light creates a second problem, though: #ffffff is already in
     * this palette, and two swatches that look identical but behave differently
     * - one follows the theme, one is always white - is a worse lie than the
     * first. So the adaptive one is marked. The ring says "this one changes
     * with the board"; the plain white one next to it does not.
     */
    const shown = inkPaint(c);
    b.style.background = shown;
    // dark ink in the dark theme's dark menu (a light page keeps black ink black): a light edge keeps it findable
    if (isDarkBoard() && isDarkColor(shown, 0.2)) b.classList.add('ink-edge');
    if (shown !== c) {
      b.classList.add('sw-adaptive');
      b.title = t('{c} — follows the board: light on dark, black on white and in exports', { c });
    }
    b.addEventListener('click', () => { markActive(wrap, b); onPick(c); });
    wrap.appendChild(b);
  }
  for (const e of extra) wrap.appendChild(e);
  return wrap;
}

function sizeRow(sizes, current, onPick, color = '#201f1e') {
  const wrap = h('div', { class: 'sizes' });
  // the dots are a preview of the ink, so they follow it onto a dark board
  const dotColor = inkPaint(color);
  for (const s of sizes) {
    const b = h('button', { class: 'size' + (s === current ? ' active' : ''), title: t('{s} px', { s }) });
    const dotSize = Math.max(4, Math.min(22, s));
    b.innerHTML = `<i style="width:${dotSize}px;height:${dotSize}px;background:${dotColor}"${isDarkBoard() && isDarkColor(dotColor, 0.2) ? ' class="ink-edge"' : ''}></i>`;
    b.addEventListener('click', () => { markActive(wrap, b); onPick(s); });
    wrap.appendChild(b);
  }
  return wrap;
}

function tapeWidthRow(sizes, current, onPick, color = '#a855f7') {
  const wrap = h('div', { class: 'sizes tape-sizes' });
  const barColor = inkPaint(color);
  const minS = Math.min(...sizes);
  const maxS = Math.max(...sizes);
  for (const s of sizes) {
    const ratio = maxS > minS ? (s - minS) / (maxS - minS) : 0.5;
    const barH = Math.round(3 + ratio * 11);
    const barW = Math.round(14 + ratio * 8);
    const b = h('button', { class: 'size tape-size' + (s === current ? ' active' : ''), title: t('{s} px', { s }) });
    b.innerHTML = `<i style="width:${barW}px;height:${barH}px;background:${barColor}"${isDarkBoard() && isDarkColor(barColor, 0.2) ? ' class="ink-edge"' : ''}></i>`;
    b.addEventListener('click', () => { markActive(wrap, b); onPick(s); });
    wrap.appendChild(b);
  }
  return wrap;
}

/** Each face previewed in itself, so 'Handwriting' looks like handwriting. */
function fontRow(fonts, current, onPick) {
  const wrap = h('div', { class: 'font-row' });
  for (const f of fonts) {
    const b = h('button', { class: 'font-opt' + (f.id === current ? ' active' : ''), title: f.label });
    b.innerHTML = `<span style="font-family:${f.stack}">Aa</span><small>${f.label}</small>`;
    b.addEventListener('click', () => { markActive(wrap, b); onPick(f.id); });
    wrap.appendChild(b);
  }
  return wrap;
}

function toggle(label, checked, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'toggle' }, input, h('span', {}, label));
}

/**
 * The emoji picker: a search box, the ones you used lately, then the groups.
 *
 * Choosing one does two things at once, and which one matters depends on what
 * is selected. With an emoji selected it swaps that emoji's character, so a
 * tick placed by mistake becomes a cross without deleting anything. With
 * nothing selected it simply becomes the one the next tap will stamp. Both
 * cases remember it, so the picker opens on what you were last using rather
 * than scrolling back to the top every time.
 */
function emojiPicker(app) {
  const s = app.settings;
  const results = h('div', { class: 'emoji-grid' });
  const sections = h('div', { class: 'emoji-sections' });

  const choose = (ch) => {
    app.rememberEmoji(ch);
    const swapped = app.applyToSelection({ ch }, 'emoji');
    if (!swapped) app.setTool('emoji');
    app.syncUI();
    closePopover();
  };

  const cell = (e) => {
    const b = h('button', { class: 'emoji-cell' + (e.ch === s.emojiChar ? ' active' : ''), title: e.name });
    b.textContent = e.ch;
    b.addEventListener('click', () => choose(e.ch));
    return b;
  };

  const search = h('input', {
    class: 'emoji-search', type: 'search', placeholder: t('Search \u2014 tick, arrow, idea\u2026'),
    // a phone keyboard that autocorrects a search term is nobody's friend
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'none', spellcheck: 'false'
  });

  const render = () => {
    const q = search.value.trim();
    results.replaceChildren();
    if (!q) {
      results.style.display = 'none';
      sections.style.display = '';
      return;
    }
    sections.style.display = 'none';
    results.style.display = '';
    const found = searchEmoji(q);
    if (!found.length) {
      results.appendChild(h('div', { class: 'emoji-empty' }, t('Nothing matches \u201c{q}\u201d', { q })));
      return;
    }
    for (const e of found) results.appendChild(cell(e));
  };

  search.addEventListener('input', render);
  // Escape while typing in the search box puts the picker away. Without this
  // the press goes to the board, where the app ignores it because the focus is
  // in a text field - so it appeared to do nothing at all.
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closePopover(); }
  });
  // Enter takes the first match, so a search can be finished without aiming.
  search.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    const first = searchEmoji(search.value.trim(), 1)[0];
    if (first) { ev.preventDefault(); choose(first.ch); }
  });

  const recent = (s.emojiRecent || []).filter(Boolean);
  if (recent.length) {
    const row = h('div', { class: 'emoji-grid' });
    for (const ch of recent) row.appendChild(cell({ ch, name: t('Recently used') }));
    sections.appendChild(h('h4', {}, t('Recent')));
    sections.appendChild(row);
  }
  for (const g of EMOJI_GROUPS) {
    const row = h('div', { class: 'emoji-grid' });
    for (const e of g.items) row.appendChild(cell(e));
    sections.appendChild(h('h4', {}, g.label));
    sections.appendChild(row);
  }

  const body = h('div', { class: 'emoji-pop' }, search, results, sections);
  render();
  // The board is the thing being used; grabbing focus here would raise the
  // on-screen keyboard on a phone every time the picker opened. Only a real
  // pointer gets the cursor put in the box for it.
  if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => search.focus(), 0);
  return body;
}

/**
 * Give the pen in your hand a new ink - what picking a colour in the pen's
 * popover does.
 *
 * The colour is written to that pen, not just to "the current ink": picking
 * up another pen and coming back must find it still there. This is the ONLY
 * way a pen changes colour. Recolouring a stroke already on the board used to
 * do it too, which meant fixing the colour of one old line quietly swapped the
 * ink of the pen you were about to write with.
 */
export function pickPenInk(app, c) {
  const s = app.settings;
  // a pencil given a new colour is a coloured pencil, still a pencil
  const effect = s.penEffect === 'pencil' ? 'pencil' : 'none';
  s.penColor = c; s.penEffect = effect;
  const held = heldPenId(s);
  if (held) rememberPen(s, held, { color: c, effect });
  app.saveSettings(); app.syncUI();
}

/**
 * Modern interactive stepped slider for laser trail duration.
 * Provides a draggable thumb with smooth snap points matching user intervals:
 * 0 (Instant), 300ms, 500ms, 1.0s, 1.5s, 5.0s, 10s.
 */
export function createLaserDurationSlider(app, initialValue = 500, onChange = null) {
  const steps = [
    { val: 0, label: t('Instant'), tick: '0' },
    { val: 300, label: '300ms', tick: '0.3' },
    { val: 500, label: '500ms', tick: '0.5' },
    { val: 1000, label: '1.0s', tick: '1' },
    { val: 1500, label: '1.5s', tick: '1.5' },
    { val: 5000, label: '5.0s', tick: '5' },
    { val: 10000, label: '10s', tick: '10' }
  ];

  let currentVal = Number(initialValue ?? 500);
  let currentIndex = steps.findIndex(s => s.val === currentVal);
  if (currentIndex < 0) {
    let minDiff = Infinity;
    currentIndex = 2; // 500ms default
    steps.forEach((s, idx) => {
      const diff = Math.abs(s.val - currentVal);
      if (diff < minDiff) { minDiff = diff; currentIndex = idx; }
    });
  }

  const container = h('div', {
    class: 'laser-slider-widget',
    style: 'display:flex;flex-direction:column;gap:8px;padding:8px 4px;user-select:none;touch-action:none;min-width:260px;'
  });

  // Top row: Label & Current Value pill
  const valBadge = h('span', {
    class: 'laser-slider-val-badge',
    style: 'font-size:12px;font-weight:700;color:var(--accent,#0078d4);background:rgba(0,120,212,0.12);padding:2px 8px;border-radius:10px;font-variant-numeric:tabular-nums;'
  }, steps[currentIndex].label);

  const topRow = h('div', {
    style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;'
  },
    h('span', { style: 'font-size:12px;font-weight:600;color:var(--text-2,inherit);' }, t('Trail Duration')),
    valBadge
  );

  // Track area
  const trackWrapper = h('div', {
    class: 'laser-slider-track-wrap',
    style: 'position:relative;height:28px;display:flex;align-items:center;cursor:pointer;margin:0 10px;'
  });

  const trackBg = h('div', {
    style: 'position:absolute;left:0;right:0;height:6px;border-radius:3px;background:var(--line,rgba(128,128,128,0.25));'
  });

  const trackFill = h('div', {
    style: 'position:absolute;left:0;height:6px;border-radius:3px;background:var(--accent,#0078d4);transition:width 0.08s ease;'
  });

  // Step dots
  const dotElements = [];
  const dotsContainer = h('div', {
    style: 'position:absolute;left:0;right:0;height:100%;display:flex;align-items:center;pointer-events:none;'
  });

  steps.forEach((s, idx) => {
    const pct = (idx / (steps.length - 1)) * 100;
    const dot = h('div', {
      style: `position:absolute;left:${pct}%;top:50%;width:8px;height:8px;border-radius:50%;background:${idx <= currentIndex ? 'var(--accent,#0078d4)' : 'var(--desk,#b0b0b0)'};transform:translate(-50%,-50%);transition:background 0.1s ease;`
    });
    dotElements.push(dot);
    dotsContainer.appendChild(dot);
  });

  // Thumb
  const thumb = h('div', {
    class: 'laser-slider-thumb',
    style: 'position:absolute;top:50%;width:18px;height:18px;border-radius:50%;background:#ffffff;border:3px solid var(--accent,#0078d4);box-shadow:0 2px 6px rgba(0,0,0,0.3);transform:translate(-50%,-50%);cursor:grab;z-index:2;transition:left 0.08s ease;'
  });

  trackWrapper.appendChild(trackBg);
  trackWrapper.appendChild(trackFill);
  trackWrapper.appendChild(dotsContainer);
  trackWrapper.appendChild(thumb);

  // Bottom row: Tick labels
  const ticksRow = h('div', {
    style: 'position:relative;height:16px;margin:0 10px;font-size:11px;color:var(--text-2,rgba(128,128,128,0.8));font-weight:600;'
  });

  steps.forEach((s, idx) => {
    const pct = (idx / (steps.length - 1)) * 100;
    const tick = h('span', {
      style: `position:absolute;left:${pct}%;transform:translateX(-50%);cursor:pointer;white-space:nowrap;`
    }, s.tick);
    tick.addEventListener('click', (e) => {
      e.stopPropagation();
      setIndex(idx);
    });
    ticksRow.appendChild(tick);
  });

  const setIndex = (idx) => {
    currentIndex = Math.max(0, Math.min(steps.length - 1, idx));
    const step = steps[currentIndex];
    currentVal = step.val;
    const pct = (currentIndex / (steps.length - 1)) * 100;
    trackFill.style.width = `${pct}%`;
    thumb.style.left = `${pct}%`;
    valBadge.textContent = step.label;

    dotElements.forEach((d, i) => {
      d.style.background = i <= currentIndex ? 'var(--accent,#0078d4)' : 'var(--desk,#b0b0b0)';
    });

    if (onChange) onChange(currentVal);
    else if (app) {
      if (!app.settings) app.settings = {};
      app.settings.laserTrailDuration = currentVal;
      app.saveSettings?.();
      if (app.surface) app.surface.dirty = true;
    }
  };

  // Drag interaction
  let isDragging = false;
  const updateFromPointer = (e) => {
    const rect = trackWrapper.getBoundingClientRect();
    if (rect.width <= 0) return;
    const clientX = e.clientX ?? (e.touches ? e.touches[0].clientX : 0);
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const stepIdx = Math.round(ratio * (steps.length - 1));
    setIndex(stepIdx);
  };

  const onPointerMove = (e) => {
    if (!isDragging) return;
    updateFromPointer(e);
  };

  const onPointerUp = (e) => {
    if (!isDragging) return;
    isDragging = false;
    thumb.style.cursor = 'grab';
    try { trackWrapper.releasePointerCapture(e.pointerId); } catch {}
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  };

  trackWrapper.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    isDragging = true;
    thumb.style.cursor = 'grabbing';
    try { trackWrapper.setPointerCapture(e.pointerId); } catch {}
    updateFromPointer(e);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  });

  // Initialize positions
  const initPct = (currentIndex / (steps.length - 1)) * 100;
  trackFill.style.width = `${initPct}%`;
  thumb.style.left = `${initPct}%`;

  container.appendChild(topRow);
  container.appendChild(trackWrapper);
  container.appendChild(ticksRow);

  return container;
}

/**
 * Stepped 10% increment slider for Study Tape opacity (0% to 100%).
 */
export function createTapeOpacitySlider(app, initialValue = 1.0, onChange = null) {
  const steps = [
    { val: 0, label: '0%', tick: '0%' },
    { val: 0.1, label: '10%', tick: '·' },
    { val: 0.2, label: '20%', tick: '·' },
    { val: 0.3, label: '30%', tick: '·' },
    { val: 0.4, label: '40%', tick: '·' },
    { val: 0.5, label: '50%', tick: '50%' },
    { val: 0.6, label: '60%', tick: '·' },
    { val: 0.7, label: '70%', tick: '·' },
    { val: 0.8, label: '80%', tick: '·' },
    { val: 0.9, label: '90%', tick: '·' },
    { val: 1.0, label: '100%', tick: '100%' }
  ];

  let currentVal = Number(initialValue ?? 1.0);
  let currentIndex = steps.findIndex(s => Math.abs(s.val - currentVal) < 0.05);
  if (currentIndex < 0) currentIndex = 10; // 100% default

  const container = h('div', {
    class: 'tape-slider-widget',
    style: 'display:flex;flex-direction:column;gap:8px;padding:8px 4px;user-select:none;touch-action:none;min-width:260px;'
  });

  const valBadge = h('span', {
    class: 'laser-slider-val-badge',
    style: 'font-size:12px;font-weight:700;color:var(--accent,#a855f7);background:rgba(168,85,247,0.12);padding:2px 8px;border-radius:10px;font-variant-numeric:tabular-nums;'
  }, steps[currentIndex].label);

  const topRow = h('div', {
    style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;'
  },
    h('span', { style: 'font-size:12px;font-weight:600;color:var(--text-2,inherit);' }, t('Tape Opacity')),
    valBadge
  );

  const trackWrapper = h('div', {
    class: 'laser-slider-track-wrap',
    style: 'position:relative;height:28px;display:flex;align-items:center;cursor:pointer;margin:0 10px;'
  });

  const trackBg = h('div', {
    style: 'position:absolute;left:0;right:0;height:6px;border-radius:3px;background:var(--line,rgba(128,128,128,0.25));'
  });

  const trackFill = h('div', {
    style: 'position:absolute;left:0;height:6px;border-radius:3px;background:var(--accent,#a855f7);transition:width 0.08s ease;'
  });

  const dotElements = [];
  const dotsContainer = h('div', {
    style: 'position:absolute;left:0;right:0;height:100%;display:flex;align-items:center;pointer-events:none;'
  });

  steps.forEach((s, idx) => {
    const pct = (idx / (steps.length - 1)) * 100;
    const dot = h('div', {
      style: `position:absolute;left:${pct}%;top:50%;width:6px;height:6px;border-radius:50%;background:${idx <= currentIndex ? 'var(--accent,#a855f7)' : 'var(--desk,#b0b0b0)'};transform:translate(-50%,-50%);transition:background 0.1s ease;`
    });
    dotElements.push(dot);
    dotsContainer.appendChild(dot);
  });

  const thumb = h('div', {
    class: 'laser-slider-thumb',
    style: 'position:absolute;top:50%;width:18px;height:18px;border-radius:50%;background:#ffffff;border:3px solid var(--accent,#a855f7);box-shadow:0 2px 6px rgba(0,0,0,0.3);transform:translate(-50%,-50%);cursor:grab;z-index:2;transition:left 0.08s ease;'
  });

  trackWrapper.appendChild(trackBg);
  trackWrapper.appendChild(trackFill);
  trackWrapper.appendChild(dotsContainer);
  trackWrapper.appendChild(thumb);

  const ticksRow = h('div', {
    style: 'display:flex;justify-content:space-between;padding:0 2px;margin-top:-2px;'
  });

  steps.forEach((s, idx) => {
    const isMajor = s.tick !== '·';
    const tickEl = h('span', {
      style: `font-size:${isMajor ? '10px' : '14px'};font-weight:${isMajor ? '600' : 'bold'};color:${idx === currentIndex ? 'var(--accent,#a855f7)' : 'var(--text-2,rgba(128,128,128,0.7))'};cursor:pointer;line-height:1;user-select:none;`
    }, s.tick);
    tickEl.addEventListener('click', (e) => {
      e.stopPropagation();
      setIndex(idx);
    });
    ticksRow.appendChild(tickEl);
  });

  const setIndex = (idx) => {
    idx = Math.max(0, Math.min(steps.length - 1, idx));
    currentIndex = idx;
    const chosen = steps[idx];
    currentVal = chosen.val;

    const pct = (idx / (steps.length - 1)) * 100;
    trackFill.style.width = `${pct}%`;
    thumb.style.left = `${pct}%`;
    valBadge.textContent = chosen.label;

    dotElements.forEach((dot, i) => {
      dot.style.background = i <= idx ? 'var(--accent,#a855f7)' : 'var(--desk,#b0b0b0)';
    });

    Array.from(ticksRow.children).forEach((tEl, i) => {
      tEl.style.color = i === idx ? 'var(--accent,#a855f7)' : 'var(--text-2,rgba(128,128,128,0.7))';
    });

    onChange?.(chosen.val);
  };

  let isDragging = false;
  const updateFromPointer = (e) => {
    const rect = trackWrapper.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const frac = rect.width > 0 ? x / rect.width : 0;
    const nearestIndex = Math.round(frac * (steps.length - 1));
    setIndex(nearestIndex);
  };

  const onPointerMove = (e) => {
    if (!isDragging) return;
    updateFromPointer(e);
  };

  const onPointerUp = (e) => {
    if (!isDragging) return;
    isDragging = false;
    thumb.style.cursor = 'grab';
    try { trackWrapper.releasePointerCapture(e.pointerId); } catch {}
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  };

  trackWrapper.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    isDragging = true;
    thumb.style.cursor = 'grabbing';
    try { trackWrapper.setPointerCapture(e.pointerId); } catch {}
    updateFromPointer(e);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  });

  const initPct = (currentIndex / (steps.length - 1)) * 100;
  trackFill.style.width = `${initPct}%`;
  thumb.style.left = `${initPct}%`;

  container.appendChild(topRow);
  container.appendChild(trackWrapper);
  container.appendChild(ticksRow);

  return container;
}

/* ------------------------------------------------------------------ */
export function openToolPopover(app, anchor, tool) {
  const s = app.settings;
  let body;

  const penTypeSwitcher = (cur) => {
    const types = [
      { id: 'pen', label: t('Ballpoint'), icon: 'pen' },
      { id: 'brush', label: t('Brush'), icon: 'brush' },
      { id: 'fountain', label: t('Fountain'), icon: 'fountain' },
      { id: 'calligraphy', label: t('Calligraphy'), icon: 'calligraphy' }
    ];
    return h('div', { class: 'row', style: 'display:flex;gap:4px;margin-bottom:12px;background:var(--desk,#f0f0f0);padding:3px;border-radius:8px;' },
      ...types.map((pt) => {
        const active = cur === pt.id;
        const b = h('button', {
          class: 'btn' + (active ? ' primary' : ''),
          style: `flex:1;padding:5px 6px;font-size:11.5px;display:flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:6px;${active ? 'font-weight:600;' : 'background:none;'}`
        }, h('span', { html: icon(pt.icon, 13) }), pt.label);
        b.addEventListener('click', () => {
          // Preserve current active ink color when switching pen types
          const curColor = cur === 'brush' ? s.brushColor : cur === 'fountain' ? s.fountainColor : cur === 'calligraphy' ? s.calligraphyColor : s.penColor;
          if (curColor) {
            if (pt.id === 'brush') s.brushColor = curColor;
            else if (pt.id === 'fountain') s.fountainColor = curColor;
            else if (pt.id === 'calligraphy') s.calligraphyColor = curColor;
            else if (pt.id === 'pen') s.penColor = curColor;
            app.saveSettings();
          }
          app.setTool(pt.id);
          app.syncUI();
          openToolPopover(app, anchor, pt.id);
        });
        return b;
      })
    );
  };

  if (tool === 'pen') {
    const effects = h('div', { class: 'row' },
      ...PEN_EFFECTS.map((e) => {
        const b = h('button', { class: 'btn' + (s.penEffect === e.id ? ' primary' : '') }, e.label);
        b.style.padding = '4px 10px';
        b.style.fontSize = '12.5px';
        b.addEventListener('click', () => {
          markActive(effects, b, 'primary');
          const crossing = (s.penEffect === 'pencil') !== (e.id === 'pencil');
          s.penEffect = e.id;
          const held = heldPenId(s);
          if (held) rememberPen(s, held, { color: s.penColor, effect: e.id });
          app.saveSettings();
          app.syncUI();
          // becoming a pencil (or stopping being one) changes what the menu offers: graphite, the
          // pencil sound, erase pencil marks. Built again, so it shows them now, not next time.
          if (crossing && anchor) { closePopover(); openToolPopover(app, anchor, 'pen'); }
        });
        return b;
      })
    );
    /*
     * Any colour, including one the theme will never touch.
     *
     * The swatch above marked with a ring is the DEFAULT ink, and it follows
     * the board by design. Somebody who actually wants black on a dark board -
     * or white on a white one, which is just as much their business - needs a
     * way to say so, and a colour they picked themselves is exactly that: it is
     * a deliberate choice, so it is painted as chosen, in both themes and in
     * every export.
     */
    const pickInk = (c) => pickPenInk(app, c);
    const customInk = h('label', { class: 'sw sw-custom', title: t('Any colour — used exactly as picked, whatever the theme') });
    const customInput = h('input', { type: 'color' });
    customInput.value = s.penColor || '#201f1e';
    // a colour wheel with the ink in hand at its middle: it reads as "pick any colour", not as one
    // more swatch that happens to match the first (graphite twice in the pencil's menu, black twice in a pen's)
    // The two inks the theme repaints (default black, pencil graphite) are kept for the swatches. A colour
    // picked here is "exactly as picked", so landing on one of them by hand moves it by one shade the eye
    // cannot see, and it stays that colour in a dark theme too.
    const asPicked = (c) => {
      const lc = String(c).toLowerCase();
      return lc === '#201f1e' ? '#201f1f' : lc === PENCIL_GRAPHITE ? '#4b4a49' : c;
    };
    customInput.addEventListener('input', () => {
      const c = asPicked(customInput.value);
      customInk.style.setProperty('--ink', inkPaint(c));
      pickInk(c);
    });
    customInk.style.setProperty('--ink', inkPaint(s.penColor || '#201f1e'));
    customInk.appendChild(customInput);

    body = h('div', {},
      penTypeSwitcher('pen'),
      h('h4', {}, t('Ink colour')),
      // a pencil offers its own graphite first, so a coloured pencil can always go back to plain lead
      swatchRow(s.penEffect === 'pencil' ? [PENCIL_GRAPHITE, ...PEN_COLORS] : PEN_COLORS, s.penEffect === 'none' || s.penEffect === 'pencil' ? s.penColor : null, (c) => {
        pickInk(c); closePopover();
      }, [customInk]),
      h('div', { class: 'row', style: 'margin-top:12px' }, h('label', {}, t('Effect'))),
      effects,
      h('h4', { style: 'margin-top:6px' }, t('Thickness')),
      sizeRow([2, 4, 7, 12, 20], s.penWidth, (v) => { s.penWidth = v; app.saveSettings(); app.syncUI(); }, s.penColor),
      h('div', { class: 'row', style: 'margin-top:12px' },
        toggle(t('Straighten shapes I draw'), s.inkToShape, (v) => {
          s.inkToShape = v;
          app.saveSettings();
          app.toast(v ? t('Hand-drawn shapes will be straightened') : t('Ink is left exactly as drawn'), 'pen');
        })),
      h('div', { class: 'row' },
        toggle(t('Hold at end of stroke to snap shape'), s.holdToShape !== false, (v) => {
          s.holdToShape = v;
          app.saveSettings();
          app.toast(v ? t('Hold pen still at end of stroke to snap shape') : t('Hold-to-shape disabled'), 'pen');
        })),
      h('div', { class: 'row' },
        toggle(t('Ruler snapping'), app.ruler.snap, (v) => { app.ruler.snap = v; })),
      ...(s.penEffect === 'pencil' ? [
        h('div', { class: 'row' },
          toggle(t('Pencil sound'), s.pencilSound !== false, (v) => { s.pencilSound = v; app.saveSettings(); })),
        h('div', { class: 'row', style: 'margin-top:6px' }, (() => {
          const b = h('button', { class: 'btn', 'data-erase-pencil': '' }, t('Erase pencil marks'));
          b.title = t('Removes every pencil line on this board and keeps the ink');
          b.addEventListener('click', () => { closePopover(); app.command('edit.erasePencil'); });
          return b;
        })())
      ] : [])
    );
  } else if (tool === 'brush') {
    const curColor = s.brushColor || s.penColor || '#201f1e';
    const pickInk = (c) => {
      s.brushColor = c;
      app.saveSettings();
      app.syncUI();
    };
    const customInk = h('label', { class: 'sw sw-custom', title: t('Any colour') });
    const customInput = h('input', { type: 'color', value: curColor });
    customInput.addEventListener('input', () => { customInk.style.background = customInput.value; pickInk(customInput.value); });
    customInk.style.background = curColor;
    customInk.appendChild(customInput);

    const curOpacity = Math.round((s.brushOpacity ?? 0.9) * 100);
    const opacityVal = h('span', { style: 'font-size:12px;font-weight:600;min-width:36px;text-align:right;' }, `${curOpacity}%`);
    const opacitySlider = h('input', {
      type: 'range', min: '10', max: '100', step: '5', value: String(curOpacity),
      style: 'flex:1;cursor:pointer;accent-color:var(--accent,#0078d4);'
    });
    opacitySlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      s.brushOpacity = val / 100;
      opacityVal.textContent = `${val}%`;
      app.saveSettings();
    });

    const softnessRow = h('div', { class: 'row', style: 'display:flex;gap:4px;margin-top:6px;' },
      ...['light', 'medium', 'strong'].map((mode) => {
        const labels = { light: t('Light'), medium: t('Medium'), strong: t('Strong') };
        const b = h('button', {
          class: 'btn' + ((s.brushSoftness || 'medium') === mode ? ' primary' : ''),
          style: 'padding:4px 10px;font-size:12px;text-transform:capitalize;'
        }, labels[mode]);
        b.addEventListener('click', () => {
          markActive(softnessRow, b, 'primary');
          s.brushSoftness = mode;
          app.saveSettings();
        });
        return b;
      })
    );

    body = h('div', { style: 'min-width:250px;' },
      penTypeSwitcher('brush'),
      h('h4', { style: 'margin:8px 0 4px 0;' }, t('Ink colour')),
      swatchRow(PEN_COLORS, curColor, (c) => { pickInk(c); closePopover(); }, [customInk]),
      h('h4', { style: 'margin-top:12px' }, t('Thickness')),
      sizeRow([3, 6, 8, 14, 22], s.brushWidth || 8, (v) => { s.brushWidth = v; app.saveSettings(); app.syncUI(); }, curColor),
      h('h4', { style: 'margin-top:12px' }, t('Opacity')),
      h('div', { style: 'display:flex;align-items:center;gap:10px;margin-top:4px;' }, opacitySlider, opacityVal),
      h('h4', { style: 'margin-top:12px' }, t('Bristle softness')),
      softnessRow,
      h('div', { class: 'row', style: 'margin-top:12px;' },
        toggle(t('Velocity thinning (flick taper)'), s.brushVelocityThinning !== false, (v) => {
          s.brushVelocityThinning = v;
          app.saveSettings();
        }))
    );
  } else if (tool === 'fountain') {
    const curColor = s.fountainColor || s.penColor || '#002050';
    const pickInk = (c) => {
      s.fountainColor = c;
      app.saveSettings();
      app.syncUI();
    };
    const customInk = h('label', { class: 'sw sw-custom', title: t('Any colour') });
    const customInput = h('input', { type: 'color', value: curColor });
    customInput.addEventListener('input', () => { customInk.style.background = customInput.value; pickInk(customInput.value); });
    customInk.style.background = curColor;
    customInk.appendChild(customInput);

    const slantRow = h('div', { class: 'row', style: 'display:flex;gap:4px;margin-top:6px;' },
      ...[15, 30, 45, 60].map((deg) => {
        const b = h('button', {
          class: 'btn' + ((s.fountainSlant ?? 45) === deg ? ' primary' : ''),
          style: 'padding:4px 10px;font-size:12px;'
        }, `${deg}°`);
        b.addEventListener('click', () => {
          markActive(slantRow, b, 'primary');
          s.fountainSlant = deg;
          app.saveSettings();
        });
        return b;
      })
    );

    const flexRow = h('div', { class: 'row', style: 'display:flex;gap:4px;margin-top:6px;' },
      ...['subtle', 'normal', 'expressive'].map((mode) => {
        const labels = { subtle: t('Subtle'), normal: t('Normal'), expressive: t('Expressive') };
        const b = h('button', {
          class: 'btn' + ((s.fountainFlex || 'normal') === mode ? ' primary' : ''),
          style: 'padding:4px 10px;font-size:12px;text-transform:capitalize;'
        }, labels[mode]);
        b.addEventListener('click', () => {
          markActive(flexRow, b, 'primary');
          s.fountainFlex = mode;
          app.saveSettings();
        });
        return b;
      })
    );

    body = h('div', { style: 'min-width:250px;' },
      penTypeSwitcher('fountain'),
      h('h4', { style: 'margin:8px 0 4px 0;' }, t('Ink colour')),
      swatchRow(PEN_COLORS, curColor, (c) => { pickInk(c); closePopover(); }, [customInk]),
      h('h4', { style: 'margin-top:12px' }, t('Nib size')),
      sizeRow([2, 3, 5, 8, 12], s.fountainWidth || 4, (v) => { s.fountainWidth = v; app.saveSettings(); app.syncUI(); }, curColor),
      h('h4', { style: 'margin-top:12px' }, t('Nib slant angle')),
      slantRow,
      h('h4', { style: 'margin-top:12px' }, t('Tine flex')),
      flexRow
    );
  } else if (tool === 'calligraphy') {
    const curColor = s.calligraphyColor || s.penColor || '#1a1a1a';
    const pickInk = (c) => {
      s.calligraphyColor = c;
      app.saveSettings();
      app.syncUI();
    };
    const customInk = h('label', { class: 'sw sw-custom', title: t('Any colour') });
    const customInput = h('input', { type: 'color', value: curColor });
    customInput.addEventListener('input', () => { customInk.style.background = customInput.value; pickInk(customInput.value); });
    customInk.style.background = curColor;
    customInk.appendChild(customInput);

    const angleRow = h('div', { class: 'row', style: 'display:flex;gap:4px;margin-top:6px;' },
      ...[0, 30, 35, 45, 60].map((deg) => {
        const b = h('button', {
          class: 'btn' + ((s.calligraphyAngle ?? 35) === deg ? ' primary' : ''),
          style: 'padding:4px 10px;font-size:12px;'
        }, `${deg}°`);
        b.addEventListener('click', () => {
          markActive(angleRow, b, 'primary');
          s.calligraphyAngle = deg;
          app.saveSettings();
        });
        return b;
      })
    );

    const flatnessRow = h('div', { class: 'row', style: 'display:flex;gap:4px;margin-top:6px;' },
      ...[
        { id: 2, label: 'Oval (2:1)' },
        { id: 4, label: 'Chisel (4:1)' },
        { id: 8, label: 'Razor (8:1)' }
      ].map((f) => {
        const b = h('button', {
          class: 'btn' + ((s.calligraphyFlatness ?? 4) === f.id ? ' primary' : ''),
          style: 'padding:4px 8px;font-size:12px;'
        }, f.label);
        b.addEventListener('click', () => {
          markActive(flatnessRow, b, 'primary');
          s.calligraphyFlatness = f.id;
          app.saveSettings();
        });
        return b;
      })
    );

    body = h('div', { style: 'min-width:250px;' },
      penTypeSwitcher('calligraphy'),
      h('h4', { style: 'margin:8px 0 4px 0;' }, t('Ink colour')),
      swatchRow(PEN_COLORS, curColor, (c) => { pickInk(c); closePopover(); }, [customInk]),
      h('h4', { style: 'margin-top:12px' }, t('Chisel width')),
      sizeRow([4, 8, 12, 18, 26], s.calligraphyWidth || 12, (v) => { s.calligraphyWidth = v; app.saveSettings(); app.syncUI(); }, curColor),
      h('h4', { style: 'margin-top:12px' }, t('Chisel angle')),
      angleRow,
      h('h4', { style: 'margin-top:12px' }, t('Flatness (edge ratio)')),
      flatnessRow
    );
  } else if (tool === 'highlighter') {
    const curOpacity = Math.round(((s.highlighterOpacity ?? 0.5)) * 100);
    const opacityVal = h('span', { style: 'font-size:12px;font-weight:600;min-width:36px;text-align:right;' }, `${curOpacity}%`);
    const opacitySlider = h('input', {
      type: 'range', min: '10', max: '100', step: '5', value: String(curOpacity),
      style: 'flex:1;cursor:pointer;accent-color:var(--accent,#0078d4);'
    });
    opacitySlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      s.highlighterOpacity = val / 100;
      opacityVal.textContent = `${val}%`;
      app.saveSettings();
      app.syncUI();
    });

    const popToggle = toggle(t('Text color-popping'), s.highlighterColorPop !== false, (v) => {
      s.highlighterColorPop = v;
      app.saveSettings();
    });

    body = h('div', { style: 'min-width:240px' },
      h('h4', {}, t('Highlighter')),
      swatchRow(HIGHLIGHTER_COLORS, s.highlighterColor, (c) => { s.highlighterColor = c; app.saveSettings(); app.syncUI(); closePopover(); }),
      h('h4', { style: 'margin-top:12px' }, t('Thickness')),
      sizeRow([12, 20, 30, 44], s.highlighterWidth, (v) => { s.highlighterWidth = v; app.saveSettings(); app.syncUI(); }, s.highlighterColor),
      h('h4', { style: 'margin-top:12px' }, t('Opacity')),
      h('div', { style: 'display:flex;align-items:center;gap:10px;margin-top:4px;' }, opacitySlider, opacityVal),
      h('div', { style: 'margin-top:12px;' }, popToggle)
    );
  } else if (tool === 'eraser') {
    const modeButtons = new Map();
    const updateModeUI = (activeId) => {
      for (const [mid, btn] of modeButtons.entries()) {
        const check = btn.querySelector('.k');
        if (mid === activeId) {
          btn.classList.add('active-mode');
          if (!check) btn.appendChild(h('span', { class: 'k', html: '&#10003;' }));
        } else {
          btn.classList.remove('active-mode');
          if (check) check.remove();
        }
      }
    };

    const mkMode = (id, label, hint) => {
      const b = h('button', { class: 'menu-item' + (s.eraserMode === id ? ' active-mode' : '') },
        h('span', { style: 'display:flex;flex-direction:column;gap:2px;text-align:left' },
          h('span', {}, label),
          h('small', { style: 'color:var(--text-2);font-size:11.5px' }, hint)),
        s.eraserMode === id ? h('span', { class: 'k', html: '&#10003;' }) : null);
      b.style.alignItems = 'flex-start';
      b.addEventListener('click', () => {
        if (id === 'all') { app.command('edit.clear'); closePopover(); return; }
        s.eraserMode = id;
        app.saveSettings();
        updateModeUI(id);
      }, { once: false });
      modeButtons.set(id, b);
      return b;
    };
    body = h('div', { style: 'min-width:270px' },
      h('h4', {}, t('Eraser size')),
      sizeRow([10, 16, 30, 60], s.eraserSize, (v) => { s.eraserSize = v; app.saveSettings(); app.syncUI(); }),
      h('h4', { style: 'margin-top:14px' }, t('Mode')),
      h('div', { class: 'menu', style: 'padding:0' },
        mkMode('partial', t('Erase parts of ink'), t('Rubs strokes out where you drag')),
        mkMode('object', t('Erase whole strokes'), t('Removes a whole stroke in one touch')),
        mkMode('all', t('Erase everything'), t('Clears the canvas')),
        (() => {
          const b = h('button', { class: 'menu-item', 'data-erase-pencil': '' },
            h('span', { style: 'display:flex;flex-direction:column;gap:2px;text-align:left' },
              h('span', {}, t('Erase pencil marks')),
              h('small', { style: 'color:var(--text-2);font-size:11.5px' }, t('Removes every pencil line on this board and keeps the ink'))));
          b.style.alignItems = 'flex-start';
          b.addEventListener('click', () => {
            app.command('edit.erasePencil');
          });
          return b;
        })()),
      h('h4', { style: 'margin-top:14px' }, t('Gesture scratch-out')),
      h('div', { style: 'display:flex;align-items:center;justify-content:space-between;padding:4px 0;' },
        h('span', { style: 'font-size:12.5px;' }, t('Scribble over ink to erase')),
        (() => {
          let active = s.scratchOut !== false;
          const toggleBtn = h('button', {
            class: 'btn' + (active ? ' primary' : ''),
            style: 'padding:3px 10px;font-size:11.5px;font-weight:600;min-width:44px;'
          }, active ? t('ON') : t('OFF'));
          toggleBtn.addEventListener('click', () => {
            active = !active;
            s.scratchOut = active;
            app.saveSettings();
            toggleBtn.className = 'btn' + (active ? ' primary' : '');
            toggleBtn.textContent = active ? t('ON') : t('OFF');
            if (app.replayBar?.updateScratchUI) app.replayBar.updateScratchUI();
          });
          return toggleBtn;
        })()
      )
    );
  } else if (tool === 'note') {
    body = h('div', {},
      h('h4', {}, t('Note colour')),
      swatchRow(NOTE_COLORS, s.noteColor, (c) => { s.noteColor = c; app.saveSettings(); app.syncUI(); app.applyToSelection({ color: c }, 'note'); closePopover(); }),
      h('h4', { style: 'margin-top:12px' }, t('Size')),
      h('div', { class: 'row' }, ...[[t('Small'), 140], [t('Medium'), 200], [t('Large'), 280]].map(([l, v]) => {
        const b = h('button', { class: 'btn' + (s.noteSize === v ? ' primary' : '') }, l);
        b.style.fontSize = '12.5px';
        b.addEventListener('click', () => { markActive(b.parentNode, b, 'primary'); s.noteSize = v; app.saveSettings(); });
        return b;
      })),
      h('h4', { style: 'margin-top:12px' }, t('Font')),
      fontRow(FONTS, s.noteFont, (id) => {
        s.noteFont = id; app.saveSettings(); app.applyToSelection({ font: id }, 'note');
      }),
      h('div', { class: 'row', style: 'margin-top:12px' },
        toggle(t('Markdown'), s.noteMarkdown !== false, (v) => {
          s.noteMarkdown = v;
          app.saveSettings();
          app.applyToSelection({ markdown: v }, 'note');
          app.surface?.invalidate();
        })
      )
    );
  } else if (tool === 'text') {
    body = h('div', {},
      h('h4', {}, t('Text colour')),
      swatchRow(TEXT_COLORS, s.textColor, (c) => { s.textColor = c; app.saveSettings(); app.syncUI(); app.applyToSelection({ color: c }, 'text'); closePopover(); }),
      h('h4', { style: 'margin-top:12px' }, t('Size')),
      sizeRow([16, 24, 32, 48, 72], s.textSize, (v) => { s.textSize = v; app.saveSettings(); app.applyToSelection({ fontSize: v }, 'text'); }),
      h('h4', { style: 'margin-top:12px' }, t('Font')),
      fontRow(FONTS, s.textFont, (id) => {
        s.textFont = id; app.saveSettings(); app.applyToSelection({ font: id }, 'text');
      }),
      h('div', { class: 'row', style: 'margin-top:12px' },
        toggle(t('Markdown'), s.textMarkdown !== false, (v) => {
          s.textMarkdown = v;
          app.saveSettings();
          app.applyToSelection({ markdown: v }, 'text');
          app.surface?.invalidate();
        })
      )
    );
  } else if (tool === 'emoji') {
    body = emojiPicker(app);
  } else if (tool === 'shape') {
    const grid = h('div', { class: 'shape-grid' });
    for (const k of SHAPES) {
      const b = h('button', { class: 'shape-btn' + (s.shapeKind === k ? ' active' : ''), title: SHAPE_LABELS[k] });
      b.innerHTML = shapeIcon(k, 22);
      b.addEventListener('click', () => { markActive(grid, b); s.shapeKind = k; app.saveSettings(); app.setTool('shape'); app.syncUI(); });
      grid.appendChild(b);
    }
    const fills = h('div', { class: 'swatches' });
    for (const c of SHAPE_FILLS) {
      const b = h('button', { class: 'sw' + (c === s.shapeFill ? ' active' : ''), title: c === 'none' ? t('No fill') : c });
      b.style.background = c === 'none' ? 'repeating-linear-gradient(45deg,#fff,#fff 4px,#ddd 4px,#ddd 8px)' : c;
      b.addEventListener('click', () => { markActive(fills, b); s.shapeFill = c; app.saveSettings(); app.applyToSelection({ fill: c }, 'shape'); });
      fills.appendChild(b);
    }
    body = h('div', {},
      h('h4', {}, t('Shape')), grid,
      h('h4', { style: 'margin-top:12px' }, t('Outline')),
      swatchRow(SHAPE_STROKES, s.shapeStroke, (c) => { s.shapeStroke = c; app.saveSettings(); app.applyToSelection({ stroke: c }, 'shape'); }),
      h('h4', { style: 'margin-top:12px' }, t('Fill')), fills,
      h('h4', { style: 'margin-top:12px' }, t('Line width')),
      sizeRow([1, 2, 3, 5, 8], s.shapeLineWidth, (v) => { s.shapeLineWidth = v; app.saveSettings(); app.applyToSelection({ lineWidth: v }, 'shape'); }, s.shapeStroke)
    );
  } else if (tool === 'laser') {
    const curDur = Number(s.laserTrailDuration ?? 500);
    const slider = createLaserDurationSlider(app, curDur, (val) => {
      s.laserTrailDuration = val;
      app.saveSettings();
      if (app.surface) app.surface.dirty = true;
    });
    body = h('div', { style: 'min-width:270px;padding:2px 4px;' },
      h('h4', { style: 'margin-bottom:6px;' }, t('Laser trail duration')),
      slider,
      h('div', { style: 'font-size:11px;color:var(--text-2,rgba(128,128,128,0.8));margin-top:6px;' },
        t('Fades smoothly after drawing. Nothing is saved to board.')
      )
    );
  } else if (tool === 'tape') {
    const tapeColors = [
      '#a855f7', // Purple
      '#eab308', // Yellow
      '#10b981', // Mint Green
      '#f43f5e', // Coral Pink
      '#d4b886', // Masking Beige
      '#06b6d4', // Cyan
      '#334155'  // Slate Dark
    ];
    const tapeTextures = [
      { id: 'stripes', label: t('Stripes') },
      { id: 'plain', label: t('Plain') },
      { id: 'dots', label: t('Washi Dots') }
    ];

    const curWidth = s.tapeWidth || 34;
    const curColor = s.tapeColor || '#a855f7';
    const curOpacity = s.tapeOpacity != null ? s.tapeOpacity : 1.0;
    const curTexture = s.tapeTexture || 'stripes';

    const opacitySlider = createTapeOpacitySlider(app, curOpacity, (val) => {
      s.tapeOpacity = val;
      app.saveSettings();
      if (app.surface) app.surface.dirty = true;
    });

    const textureRow = h('div', { class: 'row', style: 'gap:6px;' },
      ...tapeTextures.map((tx) => {
        const b = h('button', {
          class: 'btn' + (curTexture === tx.id ? ' primary' : ''),
          style: 'flex:1;font-size:11.5px;padding:4px 6px;'
        }, tx.label);
        b.onclick = () => {
          markActive(b.parentNode, b, 'primary');
          s.tapeTexture = tx.id;
          app.saveSettings();
          if (app.surface) app.surface.dirty = true;
        };
        return b;
      })
    );

    const assessToggle = toggle(t('Ask assessment on reveal (Active Recall)'), s.tapeAssessOnReveal !== false, (v) => {
      s.tapeAssessOnReveal = v;
      app.saveSettings();
    });

    const totalTapes = (app.store?.objects || []).filter((o) => o.type === 'curtain' && o.subtype === 'tape').length;
    const totalReviews = (app.store?.objects || []).filter((o) => o.type === 'curtain' && o.subtype === 'tape')
      .reduce((sum, o) => sum + (o.reviewCount || 0), 0);

    body = h('div', { style: 'min-width:280px;padding:2px 4px;' },
      h('h4', {}, t('Tape width')),
      tapeWidthRow([16, 24, 34, 48, 64], curWidth, (v) => {
        s.tapeWidth = v; app.saveSettings();
      }, curColor),
      h('h4', { style: 'margin-top:12px' }, t('Tape skin & colour')),
      swatchRow(tapeColors, curColor, (c) => {
        s.tapeColor = c;
        app.saveSettings();
        app.syncUI();
      }),
      h('h4', { style: 'margin-top:12px' }, t('Tape texture')),
      textureRow,
      h('h4', { style: 'margin-top:12px' }, t('Opacity (10% increments)')),
      opacitySlider,
      h('div', { style: 'margin-top:14px' }, assessToggle),
      h('div', { style: 'font-size:11px;color:var(--text-2);margin-top:8px;padding-top:6px;border-top:1px solid var(--stroke);display:flex;justify-content:space-between;' },
        h('span', {}, t('Tapes on board: {n}', { n: totalTapes })),
        h('span', {}, t('Reviews logged: {n}', { n: totalReviews }))
      )
    );
  }

  openPopover(anchor, body, { key: 'tool:' + tool });
}

/* ------------------------------------------------------------------ */
function menuItem(label, iconName, onClick, opts = {}) {
  const actionBtn = h('button', {
    type: 'button',
    class: 'menu-item menu-action-zone' + (opts.pinKey ? '' : ' standalone') + (opts.danger ? ' danger' : ''),
    title: label
  },
    h('span', { html: icon(iconName, 17), style: 'display:flex;align-items:center;' }),
    h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, label),
    opts.key ? h('span', { class: 'k' }, opts.key) : null
  );
  if (opts.disabled) actionBtn.setAttribute('disabled', '');
  actionBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closePopover();
    onClick();
  });

  if (!opts.pinKey) {
    const card = h('div', { class: 'menu-card-row' }, actionBtn);
    card.addEventListener('click', (e) => {
      if (e.target !== actionBtn && !actionBtn.contains(e.target)) actionBtn.click();
    });
    return card;
  }

  const pinBtn = h('button', {
    type: 'button',
    class: 'menu-pin-zone' + (opts.isPinned ? ' pinned' : ''),
    title: opts.isPinned ? t('Unpin from ribbon') : t('Pin to ribbon'),
  }, opts.isPinned ? '📌' : '📍');

  pinBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    opts.onTogglePin?.(pinBtn);
  });

  const card = h('div', { class: 'menu-card-row' },
    actionBtn,
    h('div', { class: 'menu-card-sep' }),
    pinBtn
  );
  card.addEventListener('click', (e) => {
    if (e.target === pinBtn || pinBtn.contains(e.target)) return;
    if (e.target !== actionBtn && !actionBtn.contains(e.target)) actionBtn.click();
  });
  return card;
}

/** The teaching kit, the same three wherever a menu offers them. */
function teachingItems(app) {
  const lifted = app.store.objects.some((o) => o.type === 'curtain' && o.revealed);
  return [
    menuItem(app.presenting ? t('Stop presenting') : t('Present'), 'present', () => app.command('view.present'), { key: app.presenting ? 'Esc' : 'F5' }),
    menuItem(app.viewMode ? t('Leave View mode') : t('View mode'), 'eye', () => app.command('view.viewMode'), { key: isPhoneLayout() ? '' : 'Ctrl+Alt+V' }),
    menuItem(app.timer?.visible ? t('Close the class timer') : t('Class timer'), 'timer', () => app.command('timer.open')),
    menuItem(t('Cover answers again'), 'curtain', () => app.command('curtain.coverAll'), { disabled: !lifted })
  ];
}

export function openInsertPopover(app, anchor) {
  if (!Array.isArray(app.settings.pinnedTools)) {
    app.settings.pinnedTools = ['insert.image'];
  }
  if (!Array.isArray(app.settings.hiddenRibbonTools)) {
    app.settings.hiddenRibbonTools = [];
  }
  const pinnedSet = new Set(app.settings.pinnedTools);
  const hiddenRibbonSet = new Set(app.settings.hiddenRibbonTools);

  const toggleInsertPin = (id, pinBtn) => {
    let isPinned;
    if (pinnedSet.has(id)) {
      pinnedSet.delete(id);
      isPinned = false;
    } else {
      pinnedSet.add(id);
      isPinned = true;
    }
    app.settings.pinnedTools = [...pinnedSet];
    app.saveSettings();

    pinBtn.textContent = isPinned ? '📌' : '📍';
    pinBtn.style.opacity = isPinned ? '1' : '0.35';
    pinBtn.classList.toggle('pinned', isPinned);
    pinBtn.title = isPinned ? t('Unpin from ribbon') : t('Pin to ribbon');

    renderPinnedTools(app);
    app.toast(isPinned ? t('Pinned to ribbon') : t('Unpinned from ribbon'));
  };

  const toggleRibbonToolPin = (id, pinBtn) => {
    let isPinned;
    if (hiddenRibbonSet.has(id)) {
      hiddenRibbonSet.delete(id);
      isPinned = true;
    } else {
      hiddenRibbonSet.add(id);
      isPinned = false;
    }
    app.settings.hiddenRibbonTools = [...hiddenRibbonSet];
    app.saveSettings();

    pinBtn.textContent = isPinned ? '📌' : '📍';
    pinBtn.style.opacity = isPinned ? '1' : '0.35';
    pinBtn.classList.toggle('pinned', isPinned);
    pinBtn.title = isPinned ? t('Unpin from ribbon') : t('Pin to ribbon');

    syncRibbonTools(app);
    app.toast(isPinned ? t('Pinned to ribbon') : t('Moved to + menu'));
  };

  const insertItem = (label, iconName, onClick, id, key = null) => {
    const isPinned = pinnedSet.has(id);
    return menuItem(label, iconName, onClick, {
      key,
      pinKey: id,
      isPinned,
      onTogglePin: (btn) => toggleInsertPin(id, btn)
    });
  };

  const ribbonToolItem = (label, iconName, onClick, id, key = null) => {
    const isPinned = !hiddenRibbonSet.has(id);
    return menuItem(label, iconName, onClick, {
      key,
      pinKey: id,
      isPinned,
      onTogglePin: (btn) => toggleRibbonToolPin(id, btn)
    });
  };

  const body = h('div', { class: 'menu menu-glass', style: 'max-height:82vh;overflow-y:auto;min-width:280px;' },
    h('div', { class: 'menu-title', style: 'padding:4px 8px;font-size:11px;font-weight:700;color:var(--text-3,rgba(128,128,128,0.7));text-transform:uppercase;letter-spacing:0.5px;' }, t('Insert objects')),
    insertItem(t('Markdown note…'), 'text', () => app.insertMarkdownCard?.(), 'insert.markdown'),
    insertItem(t('Diagram & Chart Studio…'), 'shapes', () => app.openVisualizationStudio?.(), 'insert.diagram'),
    insertItem(t('Video / YouTube…'), 'video', () => app.openVideoInsertDialog?.(), 'insert.video'),
    insertItem(t('Knowledge Graph View…'), 'shapes', () => app.openGraphView?.(), 'view.graph', 'Alt+G'),
    insertItem(t('Document Navigator & TOC…'), 'doc', () => app.togglePdfSidebar?.(), 'view.pdfSidebar', 'Alt+T'),
    insertItem(t('Obsidian Canvas (.canvas)…'), 'shapes', () => app.command('insert.jsoncanvas'), 'insert.jsoncanvas'),
    insertItem(t('Page margins…'), 'palette', () => app.openPageMarginDialog?.(), 'page.margin'),
    insertItem(t('Image…'), 'image', () => app.command('insert.image'), 'insert.image'),
    insertItem(t('Audio / Recording…'), 'audio', () => app.command('insert.audio'), 'insert.audio'),
    insertItem(t('Document (Word, PowerPoint, PDF)…'), 'doc', () => app.command('insert.document'), 'insert.document'),
    insertItem(t('Table'), 'table', () => app.command('insert.table'), 'insert.table'),
    insertItem(t('Maths'), 'maths', () => app.command('insert.math'), 'insert.math'),
    insertItem(t('Answer cover'), 'curtain', () => app.command('insert.curtain'), 'insert.curtain'),
    insertItem(t('Link to a board…'), 'link', () => app.command('insert.boardlink'), 'insert.boardlink', '@'),
    insertItem(t('Class timer'), 'timer', () => app.command('timer.open'), 'timer.open'),
    insertItem(t('Present'), 'present', () => app.command('view.present'), 'view.present', 'F5'),
    insertItem(t('Templates…'), 'template', () => app.panels.templates(), 'panels.templates'),
    h('div', { class: 'menu-sep' }),
    h('div', { class: 'menu-title', style: 'padding:4px 8px;font-size:11px;font-weight:700;color:var(--text-3,rgba(128,128,128,0.7));text-transform:uppercase;letter-spacing:0.5px;' }, t('STEM & Advanced Tools')),
    insertItem(t('Circuit Simulation Workbench…'), 'shapes', () => app.openCircuitWorkbench?.(), 'workbench.circuit', 'Ctrl+Shift+E'),
    insertItem(t('2D Function Grapher & Calculus…'), 'maths', () => app.openFunctionGrapher?.(), 'math.grapher', 'Ctrl+Shift+G'),
    insertItem(t('3D Molecular Structure Viewer…'), 'shapes', () => app.openMoleculeViewer?.(), 'science.molecule', 'Ctrl+Shift+M'),
    insertItem(t('2D Chemical Sketcher & SMILES…'), 'shapes', () => app.openChemicalSketcher?.(), 'science.sketcher', 'Ctrl+Shift+K'),
    insertItem(t('Interactive Periodic Table…'), 'table', () => app.openPeriodicTable?.(), 'science.periodic'),
    insertItem(t('PhET Simulation Lab…'), 'shapes', () => app.openPhetRunner?.(), 'science.phet'),
    insertItem(t('Academic Dictionary & Thesaurus…'), 'doc', () => app.openAcademicDictionary?.(), 'esl.dictionary', 'Ctrl+Shift+D'),
    insertItem(t('Study Session & FSRS Review…'), 'curtain', () => app.startStudySession?.(), 'study.session', 'Ctrl+Shift+R'),
    insertItem(t('Insert Kanban Board'), 'table', () => app.command('insert.kanban'), 'insert.kanban'),
    insertItem(t('Run Dataview Query Table'), 'table', () => app.command('insert.dataview'), 'insert.dataview'),
    h('div', { class: 'menu-sep' }),
    menuItem(t('Paste from clipboard'), 'copy', () => app.command('edit.paste'), { key: 'Ctrl+V' }),
    h('div', { class: 'menu-sep' }),
    h('div', { class: 'menu-title', style: 'padding:4px 8px;font-size:11px;font-weight:700;color:var(--text-3,rgba(128,128,128,0.7));text-transform:uppercase;letter-spacing:0.5px;' }, t('Ribbon tools')),
    ribbonToolItem(t('Select'), 'select', () => app.setTool('select'), 'select', 'V'),
    ribbonToolItem(t('Lasso select'), 'lasso', () => app.setTool('lasso'), 'lasso', 'L'),
    ribbonToolItem(t('Pan canvas'), 'hand', () => app.setTool('pan'), 'pan', 'G'),
    ribbonToolItem(t('Laser pointer'), 'laser', () => app.setTool('laser'), 'laser', 'X'),
    ...PENS.map((pen, idx) => {
      const penId = 'pen:' + pen.id;
      return ribbonToolItem(
        t('Pen {n} ({color})', { n: idx + 1, color: pen.label }),
        'pen',
        () => choosePen(app, pen.id),
        penId,
        String(idx + 1)
      );
    }),
    ribbonToolItem(t('Highlighter'), 'highlighter', () => { app.setTool('highlighter'); app.syncUI(); }, 'highlighter', 'H'),
    ribbonToolItem(t('Brush Pen'), 'brush', () => { app.setTool('brush'); app.syncUI(); }, 'brush', 'B'),
    ribbonToolItem(t('Fountain Pen'), 'fountain', () => { app.setTool('fountain'); app.syncUI(); }, 'fountain', 'F'),
    ribbonToolItem(t('Calligraphy Pen'), 'calligraphy', () => { app.setTool('calligraphy'); app.syncUI(); }, 'calligraphy', 'C'),
    ribbonToolItem(t('Study Tape'), 'curtain', () => { app.setTool('tape'); app.syncUI(); }, 'tape'),
    ribbonToolItem(t('Eraser'), 'eraser', () => { app.setTool('eraser'); app.syncUI(); }, 'eraser', 'E'),
    ribbonToolItem(t('Ruler'), 'ruler', () => app.command('ruler'), 'ruler', 'Ctrl+R'),
    ribbonToolItem(t('Hold gesture mode'), 'radial', () => app.command('toggleHoldMode'), 'holdMode'),
    ribbonToolItem(t('Text Box'), 'text', () => { app.setTool('text'); app.syncUI(); }, 'text', 'T'),
    ribbonToolItem(t('Sticky Note'), 'note', () => { app.setTool('note'); app.syncUI(); }, 'note', 'N'),
    ribbonToolItem(t('Shapes'), 'shapes', () => { app.setTool('shape'); app.syncUI(); openToolPopover(app, anchor, 'shape'); }, 'shape', 'S'),
    ribbonToolItem(t('Emoji'), 'emoji', () => { app.setTool('emoji'); app.syncUI(); openToolPopover(app, anchor, 'emoji'); }, 'emoji')
  );
  openPopover(anchor, body, { key: 'insert' });
}

export function openMorePopover(app, anchor) {
  const body = h('div', { class: 'menu menu-glass' },
    menuItem(t('Templates…'), 'template', () => app.panels.templates()),
    menuItem(t('Canvas…'), 'palette', () => app.panels.background()),
    menuItem(app.ruler.visible ? t('Hide ruler') : t('Show ruler'), 'ruler', () => app.command('ruler'), { key: 'Ctrl+R' }),
    h('div', { class: 'menu-sep' }),
    ...teachingItems(app),
    h('div', { class: 'menu-sep' }),
    menuItem(t('Select all'), 'select', () => app.command('edit.selectAll'), { key: 'Ctrl+A' }),
    menuItem(t('Export as PNG…'), 'export', () => app.command('export.png')),
    menuItem(t('Export as PDF…'), 'doc', () => app.command('export.pdf')),
    menuItem(t('Save a copy…'), 'doc', () => app.command('board.save'), { key: 'Ctrl+S' }),
    menuItem(t('Open board…'), 'board', () => app.command('board.open'), { key: 'Ctrl+O' }),
    h('div', { class: 'menu-sep' }),
    menuItem(t('Share on this network…'), 'share', () => app.panels.sharing()),
    menuItem(t('Settings'), 'settings', () => app.panels.settings()),
    menuItem(t('Runtime Libraries & Dependencies…'), 'shapes', () => app.command('help.libraries')),
    menuItem(t('Keyboard shortcuts'), 'help', () => app.showShortcuts()),
    menuItem(t('Check for updates…'), 'update', () => app.checkForUpdates({ force: true })),
    menuItem(t('About GaussBoard'), 'board', () => app.showAbout()),
    menuItem(t('Clear canvas'), 'trash', () => app.command('edit.clear'), { danger: true })
  );
  openPopover(anchor, body, { key: 'more' });
}

export function openExportPopover(app, anchor) {
  const body = h('div', { class: 'menu menu-glass' },
    menuItem(t('Export board as PNG…'), 'image', () => app.command('export.png')),
    menuItem(t('Export selection as PNG…'), 'image', () => app.command('export.pngSelection'), { disabled: !app.surface.selection.size }),
    menuItem(t('Export as PDF…'), 'doc', () => app.command('export.pdf')),
    menuItem(t('Export High-Res PNG (16K)…'), 'image', () => app.command('export.highResPng')),
    menuItem(t('Export as SVG…'), 'export', () => app.command('export.svg')),
    menuItem(t('Export Video / Audio Replay (.mp4, .webm)…'), 'video', () => app.command('export.video')),
    menuItem(t('Export Obsidian Canvas (.canvas)…'), 'shapes', () => app.command('export.jsoncanvas')),
    menuItem(t('Export Markdown note (.md)…'), 'text', () => app.command('export.markdownSidecar')),
    menuItem(t('Fit everything onto the paper'), 'shapes', () => app.command('page.fitContent'), { disabled: !app.store.pageCount }),
    h('div', { class: 'menu-sep' }),
    menuItem(t('Export Workspace Archive (.zip)…'), 'export', () => app.command('export.bundle')),
    menuItem(t('Import Workspace Archive (.zip)…'), 'board', () => app.command('import.bundle')),
    h('div', { class: 'menu-sep' }),
    menuItem(t('Save a copy (.gaussboard)…'), 'doc', () => app.command('board.save'), { key: 'Ctrl+S' }),
    menuItem(t('Open a board file…'), 'board', () => app.command('board.open'), { key: 'Ctrl+O' })
  );
  openPopover(anchor, body, { key: 'export', placement: 'bottom', align: 'end' });
}

/** Refresh active states, the raised pen, and the little colour dots. */
/**
 * Pick up a pen - by id, not by colour.
 *
 * The tray used to decide "is this pen already in my hand?" by comparing the
 * colour in hand against the pen's own. That answers wrongly the moment two
 * pens are set to the same colour: both light up, and clicking either one is
 * read as a second click on the one already held, which opens the thickness
 * popover instead of switching pens. The id says which pen without ambiguity.
 */
export function choosePen(app, id, anchor) {
  if (app.viewMode) { app.hintViewMode(); return; }
  const s = app.settings;
  const pen = penById(s, id);
  if (!pen) return;
  const held = app.tool === 'pen' && heldPenId(s) === id;
  s.activePen = id;
  s.penColor = pen.color;
  s.penEffect = pen.effect;
  app.saveSettings();
  app.setTool('pen');
  app.syncUI();
  if (held && anchor) openToolPopover(app, anchor, 'pen'); else closePopover();
}

export function syncToolbar(app) {
  const bar = document.getElementById('toolbar');
  const s = app.settings;

  wireTextFormatBarMarkdown(app);
  syncRibbonTools(app);
  syncPagebar(app);
  bar.classList.toggle('hide-keys', s.showToolKeys === false);

  const held = heldPenId(s);
  for (const b of bar.querySelectorAll('.pen[data-pen]')) {
    const pen = penById(s, b.dataset.pen);
    if (!pen) continue;
    b.classList.toggle('active', app.tool === 'pen' && held === pen.id);
    // a recoloured pen has to LOOK recoloured, or the tray still shows the
    // colour it shipped with while writing in the one you chose
    // the painted colour, not the stored one: switching theme changes what the
    // barrel should look like without changing the pen at all
    const paint = inkPaint(pen.color) + '|' + pen.effect;
    if (b.dataset.paint !== paint) {
      const kbd = b.querySelector('.kbd');
      const dot = b.querySelector('.size-dot');
      b.innerHTML = penIcon(inkPaint(pen.color), pen.effect);
      if (dot) b.appendChild(dot);
      if (kbd) b.appendChild(kbd);
      b.dataset.paint = paint;
    }
  }
  const hl = bar.querySelector('.pen[data-tool="highlighter"]');
  if (hl) {
    hl.classList.toggle('active', app.tool === 'highlighter');
    // the badge is part of the button, so it has to be re-added when the
    // highlighter is repainted or recolouring silently drops the "H"
    const want = penIcon(s.highlighterColor, 'none', 'highlighter') + '<span class="kbd">H</span>';
    if (hl.dataset.paint !== s.highlighterColor) { hl.innerHTML = want; hl.dataset.paint = s.highlighterColor; }
  }
  const brushBtn = bar.querySelector('.pen[data-tool="brush"]');
  if (brushBtn) {
    brushBtn.classList.toggle('active', app.tool === 'brush');
    const bColor = s.brushColor || s.penColor || '#201f1e';
    const want = penIcon(bColor, 'none', 'brush') + '<span class="kbd">B</span>';
    if (brushBtn.dataset.paint !== bColor) { brushBtn.innerHTML = want; brushBtn.dataset.paint = bColor; }
  }
  const ftnBtn = bar.querySelector('.pen[data-tool="fountain"]');
  if (ftnBtn) {
    ftnBtn.classList.toggle('active', app.tool === 'fountain');
    const fColor = s.fountainColor || s.penColor || '#002050';
    const want = penIcon(fColor, 'none', 'fountain') + '<span class="kbd">F</span>';
    if (ftnBtn.dataset.paint !== fColor) { ftnBtn.innerHTML = want; ftnBtn.dataset.paint = fColor; }
  }
  const calBtn = bar.querySelector('.pen[data-tool="calligraphy"]');
  if (calBtn) {
    calBtn.classList.toggle('active', app.tool === 'calligraphy');
    const cColor = s.calligraphyColor || s.penColor || '#1a1a1a';
    const want = penIcon(cColor, 'none', 'calligraphy') + '<span class="kbd">C</span>';
    if (calBtn.dataset.paint !== cColor) { calBtn.innerHTML = want; calBtn.dataset.paint = cColor; }
  }
  const tapeBtn = bar.querySelector('.pen[data-tool="tape"]');
  if (tapeBtn) {
    tapeBtn.classList.toggle('active', app.tool === 'tape');
    const tColor = s.tapeColor || '#a855f7';
    const want = penIcon(tColor, 'none', 'tape') + '<span class="kbd">T</span>';
    if (tapeBtn.dataset.paint !== tColor) { tapeBtn.innerHTML = want; tapeBtn.dataset.paint = tColor; }
  }
  const er = bar.querySelector('.pen[data-tool="eraser"]');
  if (er) er.classList.toggle('active', app.tool === 'eraser');

  /*
   * The finger button says which way round things are RIGHT NOW, and appears
   * only once there is a pen to be the other option. Its icon is the thing the
   * finger will do if you press it - a hand when the finger draws, a pen when
   * the finger is moving the board - which is the way a toggle reads when you
   * are looking at it rather than remembering it.
   */
  const fb = bar.querySelector('.tool[data-cmd="fingerInk"]');
  if (fb) {
    const offer = app.penSeenThisSession || s.inkWithFinger === 'no';
    fb.style.display = offer ? '' : 'none';
    const drawing = app.fingerInks;
    // Only repaint when it actually flips: syncUI runs on every tool change,
    // and rewriting a button's contents that often is work for nothing.
    const want = drawing ? 'hand' : 'pen';
    if (fb.dataset.face !== want) { fb.innerHTML = icon(want, 18); fb.dataset.face = want; }
    fb.classList.toggle('active', !drawing);
    fb.title = drawing
      ? t('Your finger draws — tap to move the board with it instead')
      : t('Your finger moves the board — tap to draw with it instead');
  }

  const addBtn = bar.querySelector('.tool[data-pop="add"]');
  if (addBtn) addBtn.classList.toggle('active', ['note', 'text', 'shape', 'emoji'].includes(app.tool) || !!app.ruler?.visible);
  const moreBtn = bar.querySelector('.tool[data-pop="more"]');
  if (moreBtn) moreBtn.classList.toggle('active', ['select', 'lasso', 'pan', 'laser'].includes(app.tool));

  for (const btn of bar.querySelectorAll('.tool')) {
    const t = btn.dataset.tool, c = btn.dataset.cmd;
    if (t) btn.classList.toggle('active', app.tool === t);
    if (c === 'ruler') btn.classList.toggle('active', app.ruler.visible);
    if (c === 'undo') btn.toggleAttribute('disabled', !app.store.canUndo);
    if (c === 'redo') btn.toggleAttribute('disabled', !app.store.canRedo);
    const dot = btn.querySelector('.dot');
    if (dot) dot.style.background = t === 'note' ? s.noteColor : t === 'text' ? s.textColor : s.shapeStroke;
  }
}
