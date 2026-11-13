// Right-click menu and the floating selection toolbar.

import { h, openPopover, closePopover } from './popover.js';
import { icon } from './icons.js';
import { t } from '../i18n.js';
import { PEN_COLORS, NOTE_COLORS, TEXT_COLORS, SHAPE_STROKES, SHAPE_FILLS } from './palettes.js';
import { inkPaint } from '../core/render.js';
import { boundsOf } from '../core/store.js';
import { EXCERPT_MIME } from '../core/excerpts.js';

// kinds whose default ink the board draws light on a dark theme (notes and tables keep their own dark ink)
const FOLLOWS_BOARD = new Set(['stroke', 'shape', 'text', 'math', 'connector']);

function item(label, iconName, onClick, opts = {}) {
  const b = h('button', { class: 'menu-item' + (opts.danger ? ' danger' : '') },
    h('span', { html: icon(iconName, 17), style: 'display:flex' }),
    h('span', {}, label),
    opts.key ? h('span', { class: 'k' }, opts.key) : null);
  if (opts.disabled) b.setAttribute('disabled', '');
  b.addEventListener('click', () => { closePopover(); onClick(); });
  return b;
}

export function showContextMenu(app, e, fromSelectionBar = false) {
  const ctxbar = document.getElementById('ctxbar');
  const sel = app.surface.selection;
  const wp = app.surface.toWorld(e);

  // right-clicking an unselected object selects it first
  const hit = fromSelectionBar ? null : app.pickAt(wp);
  if (hit && !sel.has(hit.id)) app.setSelection([hit.id]);

  // Keep selection bar visible if selection exists
  if (app.surface.selection.size > 0 && !app.textEditor?.active) {
    updateSelectionBar(app);
  }

  const has = app.surface.selection.size > 0;
  const one = app.surface.selection.size === 1 ? app.store.get([...app.surface.selection][0]) : null;
  const editable = one && ['note', 'text', 'shape', 'table'].includes(one.type);

  const popOpts = {
    key: 'ctx',
    onClose: () => {
      if (app.surface.selection.size > 0 && !app.textEditor?.active) {
        updateSelectionBar(app);
      }
    }
  };

  // Determine side-by-side coordinates to prevent overlapping ctxbar
  let posX = e.clientX;
  let posY = e.clientY;
  if (ctxbar && ctxbar.classList.contains('show')) {
    const cr = ctxbar.getBoundingClientRect();
    const menuWidth = 220;
    if (cr.right + 8 + menuWidth <= window.innerWidth) {
      posX = cr.right + 8;
      posY = Math.max(10, Math.min(cr.top, window.innerHeight - 380));
    } else if (cr.left - 8 - menuWidth >= 0) {
      posX = cr.left - 8 - menuWidth;
      posY = Math.max(10, Math.min(cr.top, window.innerHeight - 380));
    }
  }

  const menu = h('div', { class: 'menu' });
  const allLocked = has && app.selected.every((o) => o.locked);
  // Lifting a cover is the one thing a cover is for, so it leads - locked or not.
  if (has && app.selected.some((o) => o.type === 'curtain' && !o.revealed)) {
    menu.appendChild(item(t('Reveal'), 'eye', () => app.command('curtain.reveal')));
    menu.appendChild(h('div', { class: 'menu-sep' }));
  }

  if (allLocked) {
    menu.appendChild(item(t('Unlock'), 'unlock', () => app.command('edit.lock')));
    menu.appendChild(h('div', { class: 'menu-sep' }));
    menu.appendChild(item(t('Copy'), 'copy', () => app.command('edit.copy'), { key: 'Ctrl+C' }));
    menu.appendChild(item(t('Copy as picture'), 'image', () => app.command('edit.copyPicture')));
    appendExcerptItem(menu, app);
    menu.appendChild(item(t('Export selection as PNG…'), 'image', () => app.command('export.pngSelection')));
    openPopover({ x: posX, y: posY }, menu, popOpts);
    return;
  }

  if (has) {
    if (editable) menu.appendChild(item(t('Edit text'), 'text', () => app.beginTextEdit(one), { key: 'F2' }));
    menu.appendChild(item(t('Cut'), 'copy', () => app.command('edit.cut'), { key: 'Ctrl+X' }));
    menu.appendChild(item(t('Copy'), 'copy', () => app.command('edit.copy'), { key: 'Ctrl+C' }));
    menu.appendChild(item(t('Copy as picture'), 'image', () => app.command('edit.copyPicture')));
    appendExcerptItem(menu, app);
    if (app.selected.some((o) => ['text', 'note', 'shape', 'table'].includes(o.type) && (o.text || (o.cells && Object.keys(o.cells).length))))
      menu.appendChild(item(t('Copy text'), 'text', () => app.command('edit.copyText')));
    menu.appendChild(item(t('Duplicate'), 'duplicate', () => app.command('edit.duplicate'), { key: 'Ctrl+D' }));
    menu.appendChild(h('div', { class: 'menu-sep' }));
    const grouped = app.selectedGroups().size > 0;
    if (app.surface.selection.size > 1 && !grouped) {
      menu.appendChild(item(t('Group'), 'group', () => app.command('edit.group'), { key: 'Ctrl+G' }));
    }
    if (grouped) {
      if (app.selectedGroups().size === 1) {
        const named = app.selected.find((o) => o.groupName)?.groupName;
        menu.appendChild(item(named ? t('Rename group ({name})', { name: named }) : t('Name this group…'), 'text',
          () => app.command('edit.nameGroup')));
      }
      menu.appendChild(item(t('Ungroup'), 'ungroup', () => app.command('edit.ungroup'), { key: 'Ctrl+Shift+G' }));
      if (app.surface.selection.size > 1) {
        menu.appendChild(item(t('Group again'), 'group', () => app.command('edit.group'), { key: 'Ctrl+G' }));
      }
    }
    if (grouped || app.surface.selection.size > 1) menu.appendChild(h('div', { class: 'menu-sep' }));
    menu.appendChild(item(t('Bring to front'), 'front', () => app.command('order.front'), { key: 'Ctrl+Shift+]' }));
    menu.appendChild(item(t('Send to back'), 'front', () => app.command('order.back'), { key: 'Ctrl+Shift+[' }));
    menu.appendChild(h('div', { class: 'menu-sep' }));
    const locked = [...app.surface.selection].every((id) => app.store.get(id)?.locked);
    menu.appendChild(item(locked ? t('Unlock') : t('Lock'), locked ? 'unlock' : 'lock', () => app.command('edit.lock')));
    menu.appendChild(item(t('Hide'), 'eyeOff', () => app.command('edit.hide'), { key: 'Ctrl+H' }));
    if (app.selected.some((o) => o.type === 'stroke' && o.points?.length >= 3)) {
      menu.appendChild(item(t('Smooth stroke curve'), 'pen', () => app.command('edit.smoothStrokes')));
    }
    if (app.selected.some((o) => ['stroke', 'text', 'note', 'shape'].includes(o.type))) {
      menu.appendChild(item(t('Optimize contrast for paper'), 'palette', () => app.command('edit.invertContrast')));
    }
    menu.appendChild(item(t('Export selection as PNG…'), 'image', () => app.command('export.pngSelection')));
    menu.appendChild(h('div', { class: 'menu-sep' }));
    menu.appendChild(item(t('Delete'), 'trash', () => app.command('edit.delete'), { key: 'Del', danger: true }));
  } else {
    menu.appendChild(item(t('Paste'), 'copy', () => app.pasteAt(wp), { key: 'Ctrl+V' }));
    menu.appendChild(item(t('Select all'), 'select', () => app.command('edit.selectAll'), { key: 'Ctrl+A' }));
    if (app.store.objects.some((o) => o && o.hidden && o.hiddenManual)) {
      menu.appendChild(item(t('Restore hidden elements'), 'eye', () => app.command('edit.unhideAll')));
    }
    menu.appendChild(h('div', { class: 'menu-sep' }));
    menu.appendChild(item(t('Sticky note here'), 'note', () => app.addNoteAt(wp)));
    menu.appendChild(item(t('Text here'), 'text', () => app.addTextAt(wp)));
    menu.appendChild(item(t('Insert Markdown'), 'text', () => (app.insertMarkdownCardAt ? app.insertMarkdownCardAt(wp) : app.addTextAt(wp))));
    menu.appendChild(item(t('Insert image…'), 'image', () => app.command('insert.image')));
    menu.appendChild(item(t('Insert maths'), 'maths', () => app.command('insert.math')));
    menu.appendChild(item(t('Insert document…'), 'doc', () => app.command('insert.document')));
    menu.appendChild(item(t('Insert diagram…'), 'shapes', () => app.openVisualizationStudio?.()));
    menu.appendChild(item(t('Insert video / YouTube…'), 'video', () => app.openVideoInsertDialog?.()));
    menu.appendChild(item(t('Engineering Ribbon'), 'shapes', () => app.toggleSidebarRibbon?.(), { key: 'Ctrl+B' }));
    menu.appendChild(item(t('Circuit Workbench…'), 'shapes', () => app.openCircuitWorkbench?.(), { key: 'Ctrl+Shift+E' }));
    menu.appendChild(item(t('Function Grapher…'), 'maths', () => app.openFunctionGrapher?.(), { key: 'Ctrl+Shift+G' }));
    menu.appendChild(item(t('Knowledge Graph…'), 'shapes', () => app.openGraphView?.(), { key: 'Alt+G' }));
    menu.appendChild(item(t('Document Navigator & TOC…'), 'doc', () => app.togglePdfSidebar?.(), { key: 'Alt+T' }));
    menu.appendChild(h('div', { class: 'menu-sep' }));
    menu.appendChild(item(t('Templates…'), 'template', () => app.panels.templates()));
    menu.appendChild(item(t('Canvas…'), 'palette', () => app.panels.background()));
    menu.appendChild(item(t('Page margins…'), 'palette', () => app.openPageMarginDialog?.()));
    if (app.pages?.length > 1) {
      const clickedPageIdx = pageIndexAt(app.pages, wp.x, wp.y);
      const targetIdx = clickedPageIdx >= 0 ? clickedPageIdx : (typeof app.currentPageIndex === 'function' ? app.currentPageIndex() : 0);
      menu.appendChild(item(t('Delete page {n}', { n: targetIdx + 1 }), 'trash', () => app.deletePage(targetIdx), { danger: true }));
    }
    menu.appendChild(item(t('Capture excerpt snippet'), 'crop', () => app.startSnippingExcerpt?.()));
    menu.appendChild(item(t('Clear canvas'), 'trash', () => app.command('edit.clear'), { danger: true }));
  }

  if (one?.kind === 'page' && app.pages?.length > 1) {
    const pIdx = one.docPage ? one.docPage - 1 : (typeof app.currentPageIndex === 'function' ? app.currentPageIndex() : 0);
    menu.appendChild(item(t('Delete this page'), 'trash', () => app.deletePage(pIdx), { danger: true }));
  }

  if (one?.type === 'image' && one.excerptSource?.boardId) {
    menu.appendChild(item(t('Open source excerpt'), 'link', () => app.openExcerptSource(one)));
  }
  const backlinks = Array.isArray(app.store?.doc?.excerptBacklinks) ? app.store.doc.excerptBacklinks : [];
  if (backlinks.length && !(one?.type === 'image' && one.excerptSource?.boardId)) {
    const near = backlinks.filter((bl) => {
      const b = bl?.sourceBounds;
      if (!b) return false;
      return wp.x >= b.x - 24 && wp.x <= b.x + b.w + 24 && wp.y >= b.y - 24 && wp.y <= b.y + b.h + 24;
    });
    const list = (near.length ? near : backlinks).slice(0, 5);
    for (const bl of list) {
      menu.appendChild(item(
        t('Go to excerpt copy: {name}', { name: bl.targetBoardName || t('Untitled board') }),
        'link',
        () => app.openExcerptCopy?.(bl)
      ));
    }
  }
  if (one?.type === 'diagram') {
    menu.appendChild(item(t('Edit diagram…'), 'shapes', () => app.openVisualizationStudio?.(one)));
  }
  openPopover({ x: posX, y: posY }, menu, popOpts);
}

function appendExcerptItem(menu, app) {
  const button = item(t('Copy excerpt'), 'image', () => app.copyAsExcerpt());
  button.draggable = true;
  button.title = t('Copy this screenshot, or drag it onto another board');
  button.addEventListener('dragstart', (event) => {
    const payload = app.buildExcerptPayload?.();
    if (!payload || !event.dataTransfer) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = 'copy';
    try { event.dataTransfer.setData(EXCERPT_MIME, JSON.stringify(payload)); }
    catch { event.preventDefault(); }
  });
  menu.appendChild(button);
}

/* ------------------------------------------------------------------ *
 *  Floating toolbar above the current selection
 * ------------------------------------------------------------------ */
export function updateSelectionBar(app, targetObj = null) {
  const bar = document.getElementById('ctxbar');
  if (!bar) return;

  if (!bar._hoverBound) {
    bar._hoverBound = true;
    bar.addEventListener('mouseenter', () => {
      clearTimeout(app._hoverBarTimer);
    });
    bar.addEventListener('mouseleave', () => {
      if (!app.surface?.selection?.size) {
        clearTimeout(app._hoverBarTimer);
        app._hoverBarTimer = setTimeout(() => {
          if (!bar.matches(':hover') && !app.surface?.selection?.size) {
            bar.classList.remove('show');
          }
        }, 250);
      }
    });
  }

  if (app.textEditor?.active) { formatBar(app, bar); return; }
  if (bar.dataset.mode === 'format') { bar.dataset.mode = ''; bar.onmousedown = null; bar.innerHTML = ''; }
  const sel = targetObj ? [targetObj] : [...app.surface.selection].map((id) => app.store.get(id)).filter(Boolean);
  if (!sel.length) { bar.classList.remove('show'); return; }

  let box = null;
  if (targetObj) {
    const obox = boundsOf(targetObj) || targetObj;
    box = app.surface.screenBoxFor(obox, 10);
  } else {
    box = app.surface.selectionScreenBox(10);
  }
  if (!box) { bar.classList.remove('show'); return; }

  bar.innerHTML = '';
  const types = new Set(sel.map((o) => o.type));
  const allLocked = sel.every((o) => o.locked);
  const covers = sel.filter((o) => o.type === 'curtain' && !o.revealed);
  const revealBtn = () => {
    const b = h('button', { title: t('Reveal what is underneath'), class: 'reveal-btn', html: icon('eye', 17) });
    b.insertAdjacentHTML('beforeend', t('<span>Reveal</span>'));
    b.addEventListener('click', () => app.command('curtain.reveal'));
    return b;
  };

  if (allLocked) {
    const label = h('span', { style: 'display:flex;align-items:center;gap:6px;padding:0 8px;font-size:12.5px;color:var(--text-2)' },
      h('span', { html: icon('lock', 15), style: 'display:flex' }),
      h('span', {}, sel.length > 1 ? t('{n} locked', { n: sel.length }) : t('Locked')));
    bar.appendChild(label);
    const unlock = h('button', { title: t('Unlock'), html: icon('unlock', 17) });
    unlock.addEventListener('click', () => app.command('edit.lock'));
    unlock.style.cssText += 'width:auto;padding:0 10px;gap:6px;color:var(--accent-2)';
    unlock.insertAdjacentHTML('beforeend', t('<span style="font-size:12.5px">Unlock</span>'));
    unlock.style.display = 'flex';
    unlock.style.alignItems = 'center';
    bar.appendChild(unlock);
    if (covers.length) bar.appendChild(revealBtn());
    appendMoreActions(app, bar);
    placeBar(bar, box, false, app);
    return;
  }

  const mk = (title, iconName, fn) => {
    const b = h('button', { title, html: icon(iconName, 17) });
    b.addEventListener('click', fn);
    return b;
  };

  // colour control, only for the things that actually have a colour
  const COLOURABLE = new Set(['stroke', 'shape', 'note', 'text', 'table', 'math', 'connector']);
  if (types.size === 1 && COLOURABLE.has([...types][0])) {
    const type = [...types][0];
    const swatch = h('button', { class: 'colour-btn', title: t('Colour') });
    const dot = h('span', {});
    const currentColor = type === 'shape' || type === 'connector' ? sel[0].stroke : sel[0].color;
    const shownColor = FOLLOWS_BOARD.has(type) ? inkPaint(currentColor) : (currentColor || '#201f1e');
    dot.style.cssText = `width:17px;height:17px;border-radius:50%;background:${shownColor};box-shadow:inset 0 0 0 1px rgba(128,128,128,.45)`;
    dot.dataset.colour = shownColor;
    swatch.appendChild(dot);
    swatch.addEventListener('click', () => openColorPopover(app, swatch, type, sel));
    bar.appendChild(swatch);
  }

  if (covers.length) bar.appendChild(revealBtn());

  // arrows & lines: straight, elbow or curved, heads (none, end, both), thickness, and arrowhead size
  const isLinearShape = (o) => o.type === 'shape' && ['line', 'arrow', 'doubleArrow'].includes(o.kind);
  const isConnector = (o) => o.type === 'connector';
  const allLinear = sel.length > 0 && sel.every((o) => isConnector(o) || isLinearShape(o));

  if (allLinear) {
    if (sel.every(isConnector)) {
      const now = sel.every((o) => o.route === sel[0].route) ? (sel[0].route || 'straight') : null;
      for (const [route, label, ic] of [['straight', t('Straight arrow'), 'arrowStraight'], ['elbow', t('Elbow arrow'), 'arrowElbow'], ['curved', t('Curved arrow'), 'arrowCurved']]) {
        const b = mk(label, ic, () => { app.command('arrow.' + route); updateSelectionBar(app); });
        b.dataset.route = route;
        if (now === route) b.classList.add('on');
        bar.appendChild(b);
      }
      bar.appendChild(h('span', { class: 'bar-sep' }));
    }

    const currentHeads = sel[0].heads || (sel[0].kind === 'line' ? 'none' : sel[0].kind === 'doubleArrow' ? 'both' : 'end');
    const headsList = [
      ['none', t('Plain line'), 'line'],
      ['end', t('Single arrow'), 'arrowRight'],
      ['both', t('Both ways arrow'), 'arrowBoth']
    ];
    for (const [hVal, label, ic] of headsList) {
      const b = mk(label, ic, () => {
        app.setArrowHeads(hVal);
        updateSelectionBar(app);
      });
      if (currentHeads === hVal) b.classList.add('on');
      bar.appendChild(b);
    }
    bar.appendChild(h('span', { class: 'bar-sep' }));

    const currentHeadStyle = sel.every((o) => (o.headStyle || 'filled') === (sel[0].headStyle || 'filled')) ? (sel[0].headStyle || 'filled') : null;
    for (const [style, label] of [['filled', t('Filled')], ['open', t('Open')], ['stealth', t('Stealth')], ['diamond', t('Diamond')]]) {
      const b = mk(t('Arrowhead: {style}', { style: label }), 'arrowSize', () => {
        app.setArrowHeadStyle(style);
        updateSelectionBar(app);
      });
      if (currentHeadStyle === style) b.classList.add('on');
      bar.appendChild(b);
    }
    bar.appendChild(h('span', { class: 'bar-sep' }));

    bar.appendChild(mk(t('Decrease thickness'), 'minus', () => {
      app.stepLineWidth(-1.5);
      updateSelectionBar(app);
    }));
    bar.appendChild(mk(t('Increase thickness'), 'plus', () => {
      app.stepLineWidth(1.5);
      updateSelectionBar(app);
    }));

    bar.appendChild(mk(t('Arrowhead size'), 'arrowSize', () => {
      app.cycleArrowScale();
      updateSelectionBar(app);
    }));
    bar.appendChild(h('span', { class: 'bar-sep' }));
  }

  if ([...types].every((t) => ['note', 'text', 'shape', 'table'].includes(t)) && sel.length === 1) {
    bar.appendChild(mk(t('Edit text (F2)'), 'text', () => app.beginTextEdit(sel[0])));
    if (sel[0].type === 'text' || sel[0].type === 'note') {
      const mdBtn = h('button', {
        title: t('Markdown'),
        class: sel[0].markdown !== false ? 'on' : '',
        style: 'font-weight:700;font-size:12px;width:auto;padding:0 8px;'
      }, 'M↓');
      mdBtn.addEventListener('click', () => {
        const next = sel[0].markdown === false;
        app.store.update(sel[0].id, { markdown: next }, 'markdown mode');
        app.surface.invalidate();
        updateSelectionBar(app);
      });
      bar.appendChild(mdBtn);
      if (sel[0].type === 'text' && sel[0].markdown !== false) {
        const curStyle = sel[0].cardStyle || 'canvas';
        const styleBtn = h('button', {
          title: t('Card model: {style} (Click to cycle Canvas, Window, Minimal, Transparent)', { style: curStyle }),
          style: 'font-weight:600;font-size:11px;width:auto;padding:0 7px;text-transform:capitalize;',
          class: 'fmt-btn'
        }, curStyle);
        styleBtn.addEventListener('click', () => {
          const styles = ['canvas', 'window', 'minimal', 'transparent'];
          const idx = styles.indexOf(sel[0].cardStyle || 'canvas');
          const next = styles[(idx + 1) % styles.length];
          app.store.update(sel[0].id, { cardStyle: next }, 'card style');
          app.surface.invalidate();
          updateSelectionBar(app);
        });
        bar.appendChild(styleBtn);
      }
      if (window.board?.vault) {
        const linked = sel[0].obsidianPath;
        if (linked) {
          bar.appendChild(h('button', {
            class: 'fmt-btn gb-obsidian-bar-btn',
            title: t('Sync from Obsidian: {path}', { path: linked }),
            style: 'width:auto;padding:0 6px;font-size:11px;'
          }, t('Sync ↓')));
          bar.lastChild.addEventListener('click', () => app.syncObjectFromObsidian(sel[0]));
          bar.appendChild(h('button', {
            class: 'fmt-btn gb-obsidian-bar-btn',
            title: t('Push to Obsidian: {path}', { path: linked }),
            style: 'width:auto;padding:0 6px;font-size:11px;'
          }, t('Push ↑')));
          bar.lastChild.addEventListener('click', () => app.pushObjectToObsidian(sel[0]));
        }
        const mdLinkBtn = h('button', {
          class: 'fmt-btn' + (linked ? ' on' : ''),
          title: linked ? t('Linked Obsidian note: {path}', { path: linked }) : t('Link Obsidian .md note…'),
          style: 'width:auto;padding:0 7px;font-size:11px;font-weight:600;'
        }, linked ? linked.split('/').pop() : '.md');
        mdLinkBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openObsidianLinkPopover(app, mdLinkBtn, sel[0]);
        });
        bar.appendChild(mdLinkBtn);
      }
    }
  }
  if (sel.length === 1 && sel[0].type === 'math')
    bar.appendChild(mk(t('Edit maths (F2)'), 'maths', () => app.beginMathEdit(sel[0])));
  if (sel.length === 1 && sel[0].type === 'diagram') {
    const diag = sel[0];
    bar.appendChild(mk(t('Edit diagram…'), 'shapes', () => app.openVisualizationStudio?.(diag)));
    bar.appendChild(mk(diag.cardStyle === 'transparent' ? t('Card background') : t('Transparent background'), 'palette', () => {
      const next = diag.cardStyle === 'transparent' ? 'white' : 'transparent';
      app.store.update(diag.id, { cardStyle: next }, 'toggle diagram background');
      app.surface.invalidate();
    }));
  }
  if (sel.length === 1 && sel[0].type === 'boardlink') {
    const card = sel[0];
    bar.appendChild(mk(t('Open the board'), 'board', () => app.openBoardRef(card.board)));
    bar.appendChild(mk(t('Link to a different board'), 'link', () => app.relinkBoardCard(card.id)));
    bar.appendChild(mk(card.showThumb !== false ? t('Hide thumbnail') : t('Show thumbnail'), 'image', () => {
      app.store.update(card.id, { showThumb: !(card.showThumb !== false) }, 'toggle thumbnail');
      app.surface.invalidate();
    }));
  }

  if (sel.length === 1 && sel[0].type === 'video') {
    const vid = sel[0];
    bar.appendChild(mk(t('Play video'), 'video', () => app.openVideoPlayer?.(vid)));
    bar.appendChild(mk(t('Bookmark timestamp…'), 'audio', () => app.openVideoPlayer?.(vid)));
  }

  if (sel.length === 1 && sel[0].type === 'image') {
    const imgObj = sel[0];
    if (imgObj.excerptSource?.boardId) {
      bar.appendChild(mk(t('Open source excerpt'), 'link', () => app.openExcerptSource(imgObj)));
    }
    bar.appendChild(mk(t('Resize image'), 'arrowSize', () => openImageResizePopover(app, imgObj, bar)));
    bar.appendChild(mk(t('Crop image'), 'crop', () => startImageCrop(app, imgObj)));
    bar.appendChild(mk(t('Annotate image'), 'pen', () => startImageAnnotate(app, imgObj)));
    bar.appendChild(mk(t('Compress image…'), 'compress', () => app.openImageCompressDialog?.(imgObj)));
  }

  // a table gets its own row and column controls
  if (sel.length === 1 && sel[0].type === 'table') {
    const tbl = sel[0];
    bar.appendChild(h('span', { class: 'bar-sep' }));
    bar.appendChild(mk(t('Add row'), 'rowAdd', () => app.command('table.addRow')));
    const lessRow = mk(t('Remove row'), 'rowDel', () => app.command('table.removeRow'));
    if ((tbl.rows | 0) <= 1) lessRow.disabled = true;
    bar.appendChild(lessRow);
    bar.appendChild(mk(t('Add column'), 'colAdd', () => app.command('table.addCol')));
    const lessCol = mk(t('Remove column'), 'colDel', () => app.command('table.removeCol'));
    if ((tbl.cols | 0) <= 1) lessCol.disabled = true;
    bar.appendChild(lessCol);
    bar.appendChild(h('span', { class: 'bar-sep' }));
  }

  if (matchMedia('(pointer: coarse)').matches) {
    const more = mk(app.multiSelect ? t('Done adding') : t('Add more to the selection'),
      app.multiSelect ? 'check' : 'select', () => app.setMultiSelect(!app.multiSelect));
    if (app.multiSelect) more.classList.add('on');
    bar.appendChild(more);
  }

  const grouped = app.selectedGroups().size > 0;
  if (grouped && app.selectedGroups().size === 1) {
    bar.appendChild(mk(t('Name this group'), 'text', () => app.command('edit.nameGroup')));
  }
  if (grouped) bar.appendChild(mk(t('Ungroup (Ctrl+Shift+G)'), 'ungroup', () => app.command('edit.ungroup')));
  else if (sel.length > 1) bar.appendChild(mk(t('Group (Ctrl+G)'), 'group', () => app.command('edit.group')));
  bar.appendChild(mk(t('Duplicate (Ctrl+D)'), 'duplicate', () => app.command('edit.duplicate')));
  bar.appendChild(mk(t('Bring to front'), 'front', () => app.command('order.front')));
  bar.appendChild(mk(sel.every((o) => o.locked) ? t('Unlock') : t('Lock'), sel.every((o) => o.locked) ? 'unlock' : 'lock', () => app.command('edit.lock')));
  bar.appendChild(mk(t('Hide (Ctrl+H)'), 'eyeOff', () => app.command('edit.hide')));
  bar.appendChild(mk(t('Delete (Del)'), 'trash', () => app.command('edit.delete')));

  appendMoreActions(app, bar);

  placeBar(bar, box, !!app.interaction?.selectionHasDots?.(), app);
}

function appendMoreActions(app, bar) {
  if (document.documentElement?.dataset.platform !== 'android'
      && !(typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches)) return;
  const button = h('button', { title: t('More actions'), html: icon('more', 17) });
  button.addEventListener('click', () => {
    const r = bar.getBoundingClientRect();
    showContextMenu(app, { clientX: r.left + r.width - 12, clientY: r.bottom + 4 }, true);
  });
  bar.appendChild(button);
}

function placeBar(bar, box, dots = false, app = null) {
  bar.classList.add('show');
  const stage = document.getElementById('stage').getBoundingClientRect();
  // `box` is in the owning canvas's coordinates. In a split workspace the
  // canvas is not at the stage's origin, so carry the difference.
  const cr = app?.surface?.canvas?.getBoundingClientRect?.();
  const ox = cr ? cr.left - stage.left : 0;
  const oy = cr ? cr.top - stage.top : 0;
  const w = bar.offsetWidth || 200;
  let left = box.x + box.w / 2 - w / 2 + ox;
  left = Math.max(8, Math.min(left, stage.width - w - 8));
  let top = box.y - bar.offsetHeight - (dots ? 66 : 44) + oy;
  if (top < 8) top = Math.min(box.y + box.h + (dots ? 34 : 12) + oy, stage.height - bar.offsetHeight - 80);
  top = Math.max(8, Math.min(top, stage.height - bar.offsetHeight - 8));
  bar.style.left = left + 'px';
  bar.style.top = top + 'px';
}

function openColorPopover(app, anchor, type, sel) {
  const colors = type === 'note' ? NOTE_COLORS : (type === 'text' || type === 'math') ? TEXT_COLORS : (type === 'shape' || type === 'connector') ? SHAPE_STROKES : PEN_COLORS;
  const grid = h('div', { class: 'swatches' });
  for (const c of colors) {
    const b = h('button', { class: 'sw', title: c });
    const shown = FOLLOWS_BOARD.has(type) ? inkPaint(c) : c;
    b.style.background = shown;
    if (shown !== c) {
      b.classList.add('sw-adaptive');
      b.title = t('{c} — follows the board: light on dark, black on white and in exports', { c });
    }
    b.addEventListener('click', () => {
      const key = type === 'shape' || type === 'connector' ? 'stroke' : 'color';
      app.store.updateMany(sel.map((o) => o.id), { [key]: c }, 'recolour');
      closePopover();
      app.surface.invalidate();
      updateSelectionBar(app);
    });
    grid.appendChild(b);
  }
  const body = h('div', {}, h('h4', {}, type === 'shape' ? t('Outline') : t('Colour')), grid);

  if (type === 'shape') {
    const fills = h('div', { class: 'swatches' });
    for (const c of SHAPE_FILLS) {
      const b = h('button', { class: 'sw', title: c === 'none' ? t('No fill') : c });
      b.style.background = c === 'none' ? 'repeating-linear-gradient(45deg,#fff,#fff 4px,#ddd 4px,#ddd 8px)' : c;
      b.addEventListener('click', () => {
        app.store.updateMany(sel.map((o) => o.id), { fill: c }, 'fill');
        closePopover(); app.surface.invalidate();
      });
      fills.appendChild(b);
    }
    body.appendChild(h('h4', { style: 'margin-top:12px' }, t('Fill')));
    body.appendChild(fills);
  }
  openPopover(anchor, body, { key: 'selcolor' });
}

/* ------------------------------------------------------------------ *
 *  The same bar, while typing: bold, italic, underline and colour
 * ------------------------------------------------------------------ */
function formatBar(app, bar) {
  const te = app.textEditor;
  const el = te.el;
  if (!el) { bar.classList.remove('show', 'obsidian-toolbar'); return; }

  bar.classList.add('obsidian-toolbar');

  if (bar.dataset.mode !== 'format' || bar._for !== el) {
    bar.dataset.mode = 'format';
    bar._for = el;
    bar.innerHTML = '';
    bar.onmousedown = (e) => e.preventDefault();
    if (!bar._fmtHooked) {
      bar._fmtHooked = true;
      bar.addEventListener('pointerdown', (e) => { if (bar.dataset.mode === 'format') e.preventDefault(); });
    }

    const mkBtn = (title, iconContent, fn, opts = {}) => {
      const b = h('button', {
        title,
        class: 'fmt-btn' + (opts.class ? ' ' + opts.class : ''),
        style: opts.style || ''
      });
      if (typeof iconContent === 'string' && iconContent.startsWith('<svg')) {
        b.innerHTML = iconContent;
      } else if (typeof iconContent === 'string') {
        b.appendChild(h('span', { style: opts.labelStyle || '' }, iconContent));
      } else if (iconContent) {
        b.appendChild(iconContent);
      }
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn(e, b);
        syncFormat(app, bar);
      });
      return b;
    };

    const sep = () => h('span', { class: 'bar-sep' });

    // Group 1: Undo, Redo, Clear, Eraser
    bar.appendChild(mkBtn(t('Undo (Ctrl+Z)'), icon('undo', 15), () => document.execCommand('undo')));
    bar.appendChild(mkBtn(t('Redo (Ctrl+Y)'), icon('redo', 15), () => document.execCommand('redo')));
    bar.appendChild(mkBtn(t('Clear formatting'), icon('trash', 15), () => te.runToolbarAction(() => te.clearFormatting())));
    bar.appendChild(mkBtn(t('Delete line or selection'), icon('eraser', 15), () => te.runToolbarAction(() => te.deleteCurrentLineOrSelection())));

    bar.appendChild(sep());

    // Group 2: Headings H2, H3, Hn dropdown
    bar.appendChild(mkBtn(t('Heading 2 (##)'), 'H₂', () => te.runToolbarAction(() => te.toggleLinePrefix('## ', /^#{1,6}\s*/)), {
      style: 'font-weight:700;font-size:12.5px;padding:0 5px;width:auto;'
    }));
    bar.appendChild(mkBtn(t('Heading 3 (###)'), 'H₃', () => te.runToolbarAction(() => te.toggleLinePrefix('### ', /^#{1,6}\s*/)), {
      style: 'font-weight:700;font-size:12.5px;padding:0 5px;width:auto;'
    }));

    const hnBtn = mkBtn(t('Headings dropdown'), 'H▾', (e, anchor) => {
      openHeadingsPopover(app, anchor, te);
    }, { style: 'font-weight:700;font-size:12px;padding:0 5px;width:auto;' });
    bar.appendChild(hnBtn);

    bar.appendChild(sep());

    // Group 3: Bold, Italic, Strikethrough, Underline
    bar.appendChild(mkBtn(t('Bold (Ctrl+B)'), 'B', () => {
      if (te.target?.markdown !== false) te.wrapMarkdownSelection('**');
      else te.format('bold');
    }, { style: 'font-weight:700;font-size:14px;' }));

    bar.appendChild(mkBtn(t('Italic (Ctrl+I)'), 'I', () => {
      if (te.target?.markdown !== false) te.wrapMarkdownSelection('*');
      else te.format('italic');
    }, { style: 'font-style:italic;font-family:Georgia,serif;font-size:14px;' }));

    bar.appendChild(mkBtn(t('Strikethrough'), 'S', () => {
      te.wrapMarkdownSelection('~~');
    }, { style: 'text-decoration:line-through;font-size:13.5px;' }));

    bar.appendChild(mkBtn(t('Underline (Ctrl+U)'), 'U', () => {
      if (te.target?.markdown !== false) te.wrapMarkdownSelection('<u>', '</u>');
      else te.format('underline');
    }, { style: 'text-decoration:underline;font-size:13.5px;' }));

    bar.appendChild(sep());

    // Group 4: Callouts, Code / 3D, Mode Switcher (Live | Source | Read), Link
    const calloutBtn = mkBtn(t('Insert Callout'), '📝▾', (e, anchor) => {
      openCalloutsPopover(app, anchor, te);
    }, { style: 'width:auto;padding:0 5px;font-size:12px;' });
    bar.appendChild(calloutBtn);

    const codeBtn = mkBtn(t('Insert Code or Diagram'), '📦▾', (e, anchor) => {
      openCodePopover(app, anchor, te);
    }, { style: 'width:auto;padding:0 5px;font-size:12px;' });
    bar.appendChild(codeBtn);

    const modeGroup = h('div', { class: 'gb-md-mode-group', role: 'group', 'aria-label': t('Markdown editor mode') });
    for (const [modeId, label, titleText] of [
      ['live', t('Live'), t('Obsidian Live Preview (cursor-line raw syntax)')],
      ['source', t('Source'), t('Source view (raw Markdown)')],
      ['reading', t('Read'), t('Reading view (F2)')]
    ]) {
      const mb = h('button', {
        type: 'button',
        class: 'fmt-btn gb-md-mode-btn',
        'data-md-mode': modeId,
        title: titleText
      }, label);
      mb.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        te.setMarkdownMode(modeId);
        syncFormat(app, bar);
      });
      modeGroup.appendChild(mb);
    }
    bar.appendChild(modeGroup);

    if (window.board?.vault) {
      const obsBtn = h('button', {
        type: 'button',
        class: 'fmt-btn gb-obsidian-bar-btn',
        'data-obsidian-trigger': '1',
        title: t('Obsidian Vault .md sync'),
        style: 'width:auto;padding:0 6px;font-size:11.5px;font-weight:600;'
      }, '.md');
      obsBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openObsidianLinkPopover(app, obsBtn, te.target, { te });
      });
      bar.appendChild(obsBtn);
    }

    const wlBtn = mkBtn(t('Insert Wikilink [[...]] (Ctrl+K)'), icon('link', 15), () => {
      te.runToolbarAction(() => te.insertWikilinkSyntax());
    });
    bar.appendChild(wlBtn);

    bar.appendChild(sep());

    // Group 5: Table, Task list, Quote, Typography, Lists
    bar.appendChild(mkBtn(t('Insert Markdown Table'), icon('table', 15), () => {
      te.runToolbarAction(() => te.insertMarkdownTable(3, 3));
    }));

    bar.appendChild(mkBtn(t('Task list (- [ ])'), '☑', () => {
      te.runToolbarAction(() => te.toggleLinePrefix('- [ ] ', /^[-*+]\s+\[[ xX]\]\s+|^[-*+]\s+/));
    }, { style: 'font-size:14px;' }));

    bar.appendChild(mkBtn(t('Blockquote (> )'), '💬', () => {
      te.runToolbarAction(() => te.toggleLinePrefix('> ', /^>\s*/));
    }, { style: 'font-size:13px;' }));

    const typoBtn = mkBtn(t('Paragraph & Typography'), 'T...▾', (e, anchor) => {
      openTypographyPopover(app, anchor, te);
    }, { style: 'width:auto;padding:0 5px;font-size:12px;font-weight:600;' });
    bar.appendChild(typoBtn);

    bar.appendChild(mkBtn(t('Bulleted list (- )'), '≡·', () => {
      te.runToolbarAction(() => te.toggleLinePrefix('- ', /^[-*+]\s+/));
    }, { style: 'font-weight:700;font-size:13px;' }));

    bar.appendChild(mkBtn(t('Numbered list (1. )'), '1.≡', () => {
      te.runToolbarAction(() => te.toggleLinePrefix('1. ', /^\d+\.\s+/));
    }, { style: 'font-weight:700;font-size:12px;' }));

    bar.appendChild(sep());

    // Group 6: Font Color and Highlighter & Background
    const fontColorBtn = h('button', {
      class: 'fmt-btn fmt-color-trigger',
      title: t('Text colour')
    });
    const fontA = h('span', { style: 'font-weight:700;font-size:13px;line-height:1;' }, 'A');
    const colorBar = h('span', { class: 'fmt-color-bar', style: 'width:12px;height:2.5px;background:var(--text);border-radius:1px;margin-top:1px;' });
    fontColorBtn.append(fontA, colorBar);
    fontColorBtn.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2px;';
    fontColorBtn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      openTextColorPopover(app, fontColorBtn, te);
    });
    bar.appendChild(fontColorBtn);

    const bgBtn = h('button', {
      class: 'fmt-btn fmt-bg-trigger',
      title: t('Highlight & Note background')
    });
    const hlIcon = h('span', { style: 'display:flex;', html: icon('highlighter', 15) });
    const bgBar = h('span', { class: 'fmt-bg-bar', style: 'width:12px;height:2.5px;background:var(--accent-2, #0078d4);border-radius:1px;margin-top:1px;' });
    bgBtn.append(hlIcon, bgBar);
    bgBtn.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;padding:2px;';
    bgBtn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      openNoteBgPopover(app, bgBtn, te);
    });
    bar.appendChild(bgBtn);

    bar.appendChild(sep());

    // Group 7: Preset Size & Expand
    const sizePresetBtn = mkBtn(t('Preset size: Half-page (640x520) / Full / Compact'), '⛶', () => {
      const o = te.target;
      if (!o) return;
      if (o.w >= 900) te.setCardSizePreset('compact');
      else if (o.w <= 400) te.setCardSizePreset('halfPage');
      else te.setCardSizePreset('wide');
    }, { style: 'font-size:14px;' });
    bar.appendChild(sizePresetBtn);

    const expandBtn = mkBtn(t('Expand / Collapse toolbar'), '⤢', () => {
      bar.classList.toggle('expanded');
    }, { style: 'font-size:13px;' });
    bar.appendChild(expandBtn);
  }

  syncFormat(app, bar);

  const stage = document.getElementById('stage').getBoundingClientRect();
  const activeDom = (te.previewMode && te.previewEl) ? te.previewEl : el;
  const r = activeDom.getBoundingClientRect();
  let left = r.left - stage.left;
  let top = r.top - stage.top - 46;
  if (top < 10) top = r.bottom - stage.top + 8;
  left = Math.max(8, Math.min(left, stage.width - (bar.offsetWidth || 500) - 8));
  bar.style.left = left + 'px';
  bar.style.top = top + 'px';
}

function syncFormat(app, bar) {
  const te = app.textEditor;
  if (!te) return;
  const elig = te.isMarkdownEligible?.();
  const modeGroup = bar.querySelector('.gb-md-mode-group');
  if (modeGroup) modeGroup.style.display = elig ? '' : 'none';
  for (const btn of bar.querySelectorAll('[data-md-mode]')) {
    btn.classList.toggle('on', btn.dataset.mdMode === (te.mdMode || 'source'));
  }
  const obsBtn = bar.querySelector('[data-obsidian-trigger]');
  if (obsBtn) {
    const linked = te.target?.obsidianPath;
    obsBtn.classList.toggle('on', !!linked);
    obsBtn.textContent = linked ? linked.split('/').pop() : '.md';
    obsBtn.title = linked ? t('Linked Obsidian note: {path}', { path: linked }) : t('Obsidian Vault .md sync');
  }
}

export async function openObsidianLinkPopover(app, anchor, obj, opts = {}) {
  const wrap = h('div', { class: 'menu gb-obsidian-popover', style: 'min-width:260px;max-width:340px;padding:8px;display:flex;flex-direction:column;gap:6px;' });
  const closeAndRefocus = () => {
    closePopover();
    if (opts.te?.activeInput) opts.te.activeInput.focus({ preventScroll: true });
  };

  if (!app.settings?.obsidianVaultPath) {
    wrap.appendChild(h('div', { style: 'font-size:12px;color:var(--text-2);padding:4px 2px;' }, t('Connect an Obsidian vault folder to link, sync, or insert .md notes.')));
    const chooseBtn = h('button', { class: 'menu-item', style: 'font-weight:600;justify-content:center;' }, t('Choose Obsidian vault folder…'));
    chooseBtn.addEventListener('click', async () => {
      const picked = await app.chooseObsidianVault();
      closePopover();
      if (picked?.path) openObsidianLinkPopover(app, anchor, obj, opts);
    });
    wrap.appendChild(chooseBtn);
    openPopover(anchor, wrap, { key: 'obsidian-link' });
    return;
  }

  const head = h('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:6px;padding:0 2px;' },
    h('span', { style: 'font-size:11.5px;font-weight:700;color:var(--text-2);' }, app.settings.obsidianVaultName || t('Obsidian vault')),
    h('button', { class: 'tool-sm', style: 'font-size:11px;padding:2px 6px;' }, t('Change…'))
  );
  head.lastChild.addEventListener('click', async () => {
    const picked = await app.chooseObsidianVault();
    closePopover();
    if (picked?.path) openObsidianLinkPopover(app, anchor, obj, opts);
  });
  wrap.appendChild(head);

  if (obj?.obsidianPath) {
    wrap.appendChild(h('div', { style: 'font-size:11px;color:var(--text-2);word-break:break-all;padding:2px 4px;background:var(--surface-2);border-radius:4px;' }, obj.obsidianPath));
    const actRow = h('div', { style: 'display:flex;gap:6px;' });
    const pullB = h('button', { class: 'menu-item', style: 'flex:1;justify-content:center;font-size:12px;' }, t('Sync ↓'));
    pullB.addEventListener('click', async () => { closePopover(); await app.syncObjectFromObsidian(obj); });
    const pushB = h('button', { class: 'menu-item', style: 'flex:1;justify-content:center;font-size:12px;' }, t('Push ↑'));
    pushB.addEventListener('click', async () => { closePopover(); await app.pushObjectToObsidian(obj); });
    const unlinkB = h('button', { class: 'menu-item', style: 'flex:1;justify-content:center;font-size:12px;' }, t('Unlink'));
    unlinkB.addEventListener('click', () => { app.unlinkObjectObsidianNote(obj); closeAndRefocus(); });
    actRow.append(pullB, pushB, unlinkB);
    wrap.appendChild(actRow);
    wrap.appendChild(h('div', { class: 'menu-sep' }));
  }

  const search = h('input', {
    type: 'search',
    placeholder: t('Filter .md notes…'),
    style: 'width:100%;padding:5px 8px;border:1px solid var(--stroke);border-radius:6px;background:var(--surface-2);color:var(--text);font-size:12px;'
  });
  wrap.appendChild(search);

  const list = h('div', { style: 'max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;' },
    h('div', { style: 'font-size:11.5px;color:var(--text-2);padding:6px;' }, t('Loading…'))
  );
  wrap.appendChild(list);
  openPopover(anchor, wrap, { key: 'obsidian-link' });

  const notes = await app.listObsidianVaultNotes();
  const renderNotes = () => {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = '';
    const filtered = q ? notes.filter((n) => n.relPath.toLowerCase().includes(q)) : notes;
    if (!filtered.length) {
      list.appendChild(h('div', { style: 'font-size:11.5px;color:var(--text-2);padding:6px;' }, t('No matching .md notes in vault.')));
      return;
    }
    for (const note of filtered.slice(0, 100)) {
      const item = h('button', {
        class: 'menu-item' + (obj?.obsidianPath === note.relPath ? ' on' : ''),
        style: 'justify-content:space-between;font-size:12px;padding:5px 8px;text-align:left;'
      },
        h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' }, note.relPath)
      );
      item.addEventListener('click', async () => {
        closePopover();
        if (opts.insertMode || !obj) {
          await app.insertObsidianVaultNote(note.relPath);
        } else {
          app.linkObjectToObsidianNote(obj, note.relPath);
          const curText = (opts.te?.active && opts.te.target?.id === obj.id) ? opts.te.el?.value : obj.text;
          if (!String(curText || '').trim()) {
            await app.syncObjectFromObsidian(app.store.get(obj.id) || obj);
          }
        }
      });
      list.appendChild(item);
    }
  };
  search.addEventListener('input', renderNotes);
  renderNotes();
}

function openHeadingsPopover(app, anchor, te) {
  const items = [
    ['# ', t('Heading 1 (#)'), 'font-size:17px;font-weight:700;'],
    ['## ', t('Heading 2 (##)'), 'font-size:15px;font-weight:700;'],
    ['### ', t('Heading 3 (###)'), 'font-size:13.5px;font-weight:600;'],
    ['#### ', t('Heading 4 (####)'), 'font-size:12.5px;font-weight:600;'],
    ['##### ', t('Heading 5 (#####)'), 'font-size:12px;font-weight:600;'],
    ['###### ', t('Heading 6 (######)'), 'font-size:11.5px;font-weight:600;'],
    ['', t('Paragraph (Normal)'), 'font-size:12px;']
  ];
  const menu = h('div', { class: 'menu', style: 'min-width:180px;' });
  for (const [pfx, label, style] of items) {
    const btn = h('button', { class: 'menu-item', style: 'padding:6px 12px;' },
      h('span', { style }, label)
    );
    btn.addEventListener('click', () => {
      closePopover();
      te.runToolbarAction(() => te.toggleLinePrefix(pfx, /^#{1,6}\s*/));
    });
    menu.appendChild(btn);
  }
  openPopover(anchor, menu, { key: 'mdheadings' });
}

function openCalloutsPopover(app, anchor, te) {
  const callouts = [
    ['note', '📝', t('Note')],
    ['tip', '💡', t('Tip')],
    ['warning', '⚠️', t('Warning')],
    ['danger', '⚡', t('Danger')],
    ['info', 'ℹ️', t('Info')],
    ['success', '✅', t('Success')],
    ['question', '❓', t('Question')],
    ['bug', '🐛', t('Bug')],
    ['example', '📋', t('Example')],
    ['quote', '💬', t('Quote')]
  ];
  const menu = h('div', { class: 'menu', style: 'min-width:170px;max-height:280px;overflow-y:auto;' });
  for (const [kind, iconStr, label] of callouts) {
    const btn = h('button', { class: 'menu-item', style: 'display:flex;align-items:center;gap:8px;padding:6px 12px;' },
      h('span', { style: 'font-size:15px;' }, iconStr),
      h('span', { style: 'font-weight:500;font-size:12.5px;' }, label)
    );
    btn.addEventListener('click', () => {
      closePopover();
      te.runToolbarAction(() => te.insertCallout(kind, label, t('Recall content details here.')));
    });
    menu.appendChild(btn);
  }
  openPopover(anchor, menu, { key: 'mdcallouts' });
}

function openCodePopover(app, anchor, te) {
  const items = [
    ['javascript', t('Code Block (JavaScript)'), () => te.insertCodeBlock('javascript')],
    ['python', t('Code Block (Python)'), () => te.insertCodeBlock('python')],
    ['mermaid', t('Mermaid Diagram'), () => te.insertMermaidBlock()],
    ['math', t('LaTeX Math Block ($$)'), () => te.insertMathBlock()]
  ];
  const menu = h('div', { class: 'menu', style: 'min-width:210px;' });
  for (const [k, label, fn] of items) {
    const btn = h('button', { class: 'menu-item', style: 'padding:7px 12px;font-size:12.5px;' }, label);
    btn.addEventListener('click', () => {
      closePopover();
      te.runToolbarAction(fn);
    });
    menu.appendChild(btn);
  }
  openPopover(anchor, menu, { key: 'mdcode' });
}

function openTypographyPopover(app, anchor, te) {
  const menu = h('div', { class: 'menu', style: 'min-width:220px;padding:8px;' });

  // 1. Line numbers toggle
  const hasLineNum = te.target?.lineNumbers !== false;
  const lineNumBtn = h('button', { class: 'menu-item' + (hasLineNum ? ' on' : ''), style: 'padding:6px 8px;font-size:12.5px;' },
    h('span', {}, (hasLineNum ? '✓ ' : '  ') + t('Line numbers'))
  );
  lineNumBtn.addEventListener('click', () => {
    closePopover();
    te.toggleLineNumbers();
  });
  menu.appendChild(lineNumBtn);

  menu.appendChild(h('div', { class: 'menu-sep' }));

  // 2. Font sizes
  const sizes = [14, 16, 18, 20, 24, 28, 32];
  const sizeLabel = h('div', { style: 'font-size:11.5px;color:var(--text-2);padding:4px 8px;' }, t('Font size'));
  menu.appendChild(sizeLabel);
  const sizeRow = h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap;padding:0 8px 6px;' });
  for (const s of sizes) {
    const b = h('button', {
      class: 'tool tool-sm' + ((te.target?.fontSize || 20) === s ? ' active' : ''),
      style: 'font-size:11.5px;padding:2px 6px;min-width:32px;cursor:pointer;'
    }, String(s));
    b.addEventListener('click', () => {
      closePopover();
      te.setCardFontSize(s);
    });
    sizeRow.appendChild(b);
  }
  menu.appendChild(sizeRow);

  menu.appendChild(h('div', { class: 'menu-sep' }));

  // 3. Frontmatter Template
  const fmBtn = h('button', { class: 'menu-item', style: 'padding:6px 8px;font-size:12.5px;' },
    h('span', {}, t('Insert YAML Properties'))
  );
  fmBtn.addEventListener('click', () => {
    closePopover();
    te.runToolbarAction(() => te.insertBlockText('---\ntitle: "' + (app.currentBoardName?.() || 'Note') + '"\ntags: []\naliases: []\n---'));
  });
  menu.appendChild(fmBtn);

  openPopover(anchor, menu, { key: 'mdtypography' });
}

function openTextColorPopover(app, anchor, te) {
  const grid = h('div', { class: 'swatches', style: 'padding:8px;' });
  const auto = h('button', { class: 'sw fmt-sw', title: t('Automatic colour') });
  auto.style.background = 'linear-gradient(135deg, var(--text) 50%, var(--surface) 50%)';
  auto.addEventListener('click', () => {
    closePopover();
    te.colour(null);
  });
  grid.appendChild(auto);
  for (const c of TEXT_COLORS.slice(1)) {
    const b = h('button', { class: 'sw fmt-sw', title: c });
    b.style.background = c;
    b.addEventListener('click', () => {
      closePopover();
      te.colour(c);
    });
    grid.appendChild(b);
  }
  openPopover(anchor, grid, { key: 'mdtextcolour' });
}

function openNoteBgPopover(app, anchor, te) {
  const container = h('div', { style: 'padding:10px;min-width:220px;display:flex;flex-direction:column;gap:8px;' });

  // 1. Highlight text action
  const hlBtn = h('button', { class: 'menu-item', style: 'padding:6px 8px;font-size:12.5px;' },
    h('span', { style: 'background:rgba(255,225,82,0.6);padding:1px 4px;border-radius:2px;' }, t('Highlight selection (==text==)'))
  );
  hlBtn.addEventListener('click', () => {
    closePopover();
    te.wrapMarkdownSelection('==');
  });
  container.appendChild(hlBtn);

  container.appendChild(h('div', { class: 'menu-sep' }));

  // 2. Card background choices
  const title = h('div', { style: 'font-size:11.5px;color:var(--text-2);font-weight:600;' }, t('Note Background'));
  container.appendChild(title);

  const transpBtn = h('button', { class: 'menu-item', style: 'padding:6px 8px;font-size:12px;' },
    h('span', {}, '⊘ ' + t('Transparent background'))
  );
  transpBtn.addEventListener('click', () => {
    closePopover();
    te.setCardBackground('transparent');
  });
  container.appendChild(transpBtn);

  const solidBtn = h('button', { class: 'menu-item', style: 'padding:6px 8px;font-size:12px;' },
    h('span', {}, '🌓 ' + t('Solid Theme Surface'))
  );
  solidBtn.addEventListener('click', () => {
    closePopover();
    te.setCardBackground('none');
  });
  container.appendChild(solidBtn);

  const swatches = h('div', { class: 'swatches', style: 'margin-top:4px;' });
  const bgPalette = ['#202227', '#ffffff', '#fff9db', '#e8f4fd', '#e6fcf5', '#f3f0ff', '#1a1d21'];
  for (const c of bgPalette) {
    const b = h('button', { class: 'sw', title: c });
    b.style.background = c;
    b.style.boxShadow = 'inset 0 0 0 1px rgba(128,128,128,0.3)';
    b.addEventListener('click', () => {
      closePopover();
      te.setCardBackground(c);
    });
    swatches.appendChild(b);
  }
  container.appendChild(swatches);

  openPopover(anchor, container, { key: 'mdnotebg' });
}

function openImageResizePopover(app, imgObj, anchor) {
  closePopover();
  const snap = app.store.snapshot([imgObj.id]);
  const container = h('div', { class: 'menu', style: 'padding:12px;min-width:240px;display:flex;flex-direction:column;gap:10px;' });

  const title = h('div', { style: 'font-weight:700;font-size:13px;color:var(--text);display:flex;justify-content:space-between;align-items:center;' },
    h('span', {}, t('Resize image')),
    h('button', { style: 'background:none;border:none;cursor:pointer;color:var(--text-2);font-size:14px;', onclick: closePopover }, '✕')
  );
  container.appendChild(title);

  const origW = imgObj.w || 300;
  const origH = imgObj.h || 200;
  const aspect = origW / Math.max(1, origH);
  let lockAspect = true;

  const wInput = h('input', { type: 'number', class: 'inp', value: String(Math.round(origW)), style: 'width:75px;padding:3px 6px;font-size:12px;' });
  const hInput = h('input', { type: 'number', class: 'inp', value: String(Math.round(origH)), style: 'width:75px;padding:3px 6px;font-size:12px;' });

  const lockCheck = h('input', { type: 'checkbox', checked: true });
  lockCheck.addEventListener('change', () => { lockAspect = lockCheck.checked; });

  const applyDims = (w, h) => {
    imgObj.w = Math.max(10, Math.round(w));
    imgObj.h = Math.max(10, Math.round(h));
    wInput.value = String(imgObj.w);
    hInput.value = String(imgObj.h);
    app.surface.invalidate();
  };

  wInput.addEventListener('input', () => {
    const w = parseFloat(wInput.value) || origW;
    const h = lockAspect ? w / aspect : (parseFloat(hInput.value) || origH);
    applyDims(w, h);
  });

  hInput.addEventListener('input', () => {
    const h = parseFloat(hInput.value) || origH;
    const w = lockAspect ? h * aspect : (parseFloat(wInput.value) || origW);
    applyDims(w, h);
  });

  const rowDims = h('div', { style: 'display:flex;align-items:center;gap:6px;font-size:12px;' },
    h('span', { style: 'color:var(--text-2);' }, t('W:')), wInput,
    h('span', { style: 'color:var(--text-2);' }, t('H:')), hInput
  );
  container.appendChild(rowDims);

  const rowLock = h('label', { style: 'display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--text-2);cursor:pointer;' },
    lockCheck, h('span', {}, t('Keep aspect ratio'))
  );
  container.appendChild(rowLock);

  const presetLabel = h('div', { style: 'font-size:11px;color:var(--text-2);margin-top:2px;' }, t('Scale presets'));
  container.appendChild(presetLabel);

  const presetRow = h('div', { style: 'display:flex;gap:4px;flex-wrap:wrap;' });
  const presets = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  for (const factor of presets) {
    const pct = Math.round(factor * 100) + '%';
    const b = h('button', { class: 'btn', style: 'padding:2px 6px;font-size:11px;' }, pct);
    b.addEventListener('click', () => {
      applyDims(origW * factor, origH * factor);
    });
    presetRow.appendChild(b);
  }
  container.appendChild(presetRow);

  const actionRow = h('div', { style: 'display:flex;justify-content:flex-end;gap:6px;margin-top:4px;' });
  const cancelBtn = h('button', { class: 'btn', style: 'padding:4px 10px;font-size:12px;' }, t('Cancel'));
  cancelBtn.addEventListener('click', () => {
    app.store.restoreSnapshot(snap);
    app.surface.invalidate();
    closePopover();
  });
  const commitBtn = h('button', { class: 'btn primary', style: 'padding:4px 12px;font-size:12px;' }, t('Apply'));
  commitBtn.addEventListener('click', () => {
    app.store.commitSnapshot('resize image', snap);
    app.surface.invalidate();
    closePopover();
    app.toast(t('Image resized'));
  });
  actionRow.appendChild(cancelBtn);
  actionRow.appendChild(commitBtn);
  container.appendChild(actionRow);

  openPopover(anchor, container, { key: 'imageresize' });
}

export function startImageCrop(app, imgObj) {
  closePopover();
  document.getElementById('imageCropOverlay')?.remove();
  const snap = app.store.snapshot([imgObj.id]);
  const origX = imgObj.x, origY = imgObj.y, origW = imgObj.w, origH = imgObj.h;
  const origCrop = imgObj.crop ? { ...imgObj.crop } : null;

  const sx0 = origCrop && typeof origCrop.sx === 'number' ? origCrop.sx : 0;
  const sy0 = origCrop && typeof origCrop.sy === 'number' ? origCrop.sy : 0;
  const sw0 = origCrop && typeof origCrop.sw === 'number' && origCrop.sw > 0.001 ? origCrop.sw : 1;
  const sh0 = origCrop && typeof origCrop.sh === 'number' && origCrop.sh > 0.001 ? origCrop.sh : 1;
  const fullW = origW / sw0;
  const fullH = origH / sh0;
  const fullX = origX - sx0 * fullW;
  const fullY = origY - sy0 * fullH;

  let curCrop = origCrop ? { ...origCrop } : { sx: 0, sy: 0, sw: 1, sh: 1 };
  if (typeof curCrop.sx !== 'number') curCrop.sx = 0;
  if (typeof curCrop.sy !== 'number') curCrop.sy = 0;
  if (typeof curCrop.sw !== 'number') curCrop.sw = 1;
  if (typeof curCrop.sh !== 'number') curCrop.sh = 1;

  if (origCrop) {
    delete imgObj.crop;
    imgObj.x = fullX;
    imgObj.y = fullY;
    imgObj.w = fullW;
    imgObj.h = fullH;
    app.surface.invalidate();
  }

  const stage = document.getElementById('stage') || document.body;

  const overlay = h('div', { id: 'imageCropOverlay' });
  const maskTop = h('div', { class: 'crop-mask-strip' });
  const maskBottom = h('div', { class: 'crop-mask-strip' });
  const maskLeft = h('div', { class: 'crop-mask-strip' });
  const maskRight = h('div', { class: 'crop-mask-strip' });

  const cropBox = h('div', { class: 'crop-interactive-box', title: t('Drag to move crop window') });

  cropBox.appendChild(h('div', { class: 'crop-grid-line crop-grid-v1' }));
  cropBox.appendChild(h('div', { class: 'crop-grid-line crop-grid-v2' }));
  cropBox.appendChild(h('div', { class: 'crop-grid-line crop-grid-h1' }));
  cropBox.appendChild(h('div', { class: 'crop-grid-line crop-grid-h2' }));

  const handles = ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e'];
  for (const pos of handles) {
    cropBox.appendChild(h('div', { class: `crop-handle crop-handle-${pos}`, 'data-pos': pos }));
  }

  const actionPill = h('div', { class: 'crop-action-pill' });
  const dimTag = h('span', { style: 'font-weight:600;font-size:12px;color:var(--text);' });
  const btnReset = h('button', { class: 'btn', style: 'padding:3px 9px;font-size:12px;' }, '↶ ' + t('Reset'));
  const btnCancel = h('button', { class: 'btn', style: 'padding:3px 9px;font-size:12px;' }, '✕ ' + t('Cancel'));
  const btnApply = h('button', { class: 'btn primary', style: 'padding:3px 12px;font-size:12px;' }, '✓ ' + t('Apply'));

  actionPill.appendChild(dimTag);
  actionPill.appendChild(btnReset);
  actionPill.appendChild(btnCancel);
  actionPill.appendChild(btnApply);

  overlay.appendChild(maskTop);
  overlay.appendChild(maskBottom);
  overlay.appendChild(maskLeft);
  overlay.appendChild(maskRight);
  overlay.appendChild(cropBox);
  overlay.appendChild(actionPill);
  stage.appendChild(overlay);

  const getScreenRects = () => {
    const cam = app.surface.cam;
    const p1 = cam.toScreen(imgObj.x, imgObj.y);
    const p2 = cam.toScreen(imgObj.x + imgObj.w, imgObj.y + imgObj.h);
    const imgLeft = Math.min(p1.x, p2.x);
    const imgTop = Math.min(p1.y, p2.y);
    const imgW = Math.max(10, Math.abs(p2.x - p1.x));
    const imgH = Math.max(10, Math.abs(p2.y - p1.y));

    const boxLeft = imgLeft + curCrop.sx * imgW;
    const boxTop = imgTop + curCrop.sy * imgH;
    const boxW = Math.max(12, curCrop.sw * imgW);
    const boxH = Math.max(12, curCrop.sh * imgH);

    return { imgLeft, imgTop, imgW, imgH, boxLeft, boxTop, boxW, boxH };
  };

  const syncUI = () => {
    const { imgLeft, imgTop, imgW, imgH, boxLeft, boxTop, boxW, boxH } = getScreenRects();

    cropBox.style.left = `${boxLeft}px`;
    cropBox.style.top = `${boxTop}px`;
    cropBox.style.width = `${boxW}px`;
    cropBox.style.height = `${boxH}px`;

    maskTop.style.left = `${imgLeft}px`;
    maskTop.style.top = `${imgTop}px`;
    maskTop.style.width = `${imgW}px`;
    maskTop.style.height = `${Math.max(0, boxTop - imgTop)}px`;

    maskBottom.style.left = `${imgLeft}px`;
    maskBottom.style.top = `${boxTop + boxH}px`;
    maskBottom.style.width = `${imgW}px`;
    maskBottom.style.height = `${Math.max(0, (imgTop + imgH) - (boxTop + boxH))}px`;

    maskLeft.style.left = `${imgLeft}px`;
    maskLeft.style.top = `${boxTop}px`;
    maskLeft.style.width = `${Math.max(0, boxLeft - imgLeft)}px`;
    maskLeft.style.height = `${boxH}px`;

    maskRight.style.left = `${boxLeft + boxW}px`;
    maskRight.style.top = `${boxTop}px`;
    maskRight.style.width = `${Math.max(0, (imgLeft + imgW) - (boxLeft + boxW))}px`;
    maskRight.style.height = `${boxH}px`;

    const pctW = Math.round(curCrop.sw * 100);
    const pctH = Math.round(curCrop.sh * 100);
    dimTag.textContent = `${pctW}% × ${pctH}%`;

    imgObj.crop = { ...curCrop };
    app.surface.invalidate();
  };

  syncUI();

  let activeDrag = null;

  const onPointerDown = (e) => {
    const handle = e.target.closest('.crop-handle');
    const isBox = e.target === cropBox || (cropBox.contains(e.target) && !handle);
    if (!handle && !isBox) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const { imgW, imgH } = getScreenRects();
    activeDrag = {
      type: handle ? handle.dataset.pos : 'move',
      startX: e.clientX,
      startY: e.clientY,
      initCrop: { ...curCrop },
      imgW,
      imgH
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  const onPointerMove = (e) => {
    if (!activeDrag) return;
    const dx = e.clientX - activeDrag.startX;
    const dy = e.clientY - activeDrag.startY;
    const dsx = dx / activeDrag.imgW;
    const dsy = dy / activeDrag.imgH;
    const init = activeDrag.initCrop;

    if (activeDrag.type === 'move') {
      let nsx = Math.max(0, Math.min(1 - init.sw, init.sx + dsx));
      let nsy = Math.max(0, Math.min(1 - init.sh, init.sy + dsy));
      curCrop.sx = nsx;
      curCrop.sy = nsy;
    } else {
      const pos = activeDrag.type;
      let sx = init.sx;
      let sy = init.sy;
      let ex = init.sx + init.sw;
      let ey = init.sy + init.sh;

      if (pos.includes('w')) {
        sx = Math.max(0, Math.min(ex - 0.05, init.sx + dsx));
      }
      if (pos.includes('e')) {
        ex = Math.max(sx + 0.05, Math.min(1, init.sx + init.sw + dsx));
      }
      if (pos.includes('n')) {
        sy = Math.max(0, Math.min(ey - 0.05, init.sy + dsy));
      }
      if (pos.includes('s')) {
        ey = Math.max(sy + 0.05, Math.min(1, init.sy + init.sh + dsy));
      }

      curCrop.sx = sx;
      curCrop.sy = sy;
      curCrop.sw = ex - sx;
      curCrop.sh = ey - sy;
    }

    syncUI();
  };

  const onPointerUp = () => {
    activeDrag = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  };

  cropBox.addEventListener('pointerdown', onPointerDown);

  const cleanup = () => {
    overlay.remove();
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('keydown', onKeyDown);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      btnCancel.click();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      btnApply.click();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  btnReset.onclick = () => {
    curCrop = { sx: 0, sy: 0, sw: 1, sh: 1 };
    syncUI();
    app.toast(t('Crop reset'));
  };

  const isFullCrop = (c) => c.sx <= 0.001 && c.sy <= 0.001 && c.sw >= 0.999 && c.sh >= 0.999;

  btnCancel.onclick = () => {
    imgObj.x = origX; imgObj.y = origY; imgObj.w = origW; imgObj.h = origH;
    if (origCrop) imgObj.crop = origCrop;
    else delete imgObj.crop;
    app.surface.invalidate();
    cleanup();
  };

  btnApply.onclick = () => {
    if (isFullCrop(curCrop)) {
      delete imgObj.crop;
      imgObj.x = fullX; imgObj.y = fullY; imgObj.w = fullW; imgObj.h = fullH;
    } else {
      imgObj.crop = { ...curCrop };
      imgObj.x = fullX + curCrop.sx * fullW;
      imgObj.y = fullY + curCrop.sy * fullH;
      imgObj.w = Math.max(8, curCrop.sw * fullW);
      imgObj.h = Math.max(8, curCrop.sh * fullH);
    }
    app.store.commitSnapshot('crop image', snap);
    app.surface.invalidate();
    cleanup();
    app.toast(t('Image cropped'));
  };
}

export function startImageAnnotate(app, imgObj) {
  closePopover();
  app._annotatingImage = imgObj.id;
  app.setTool('pen');
  app.syncUI();

  document.getElementById('annotateHud')?.remove();

  const hud = h('div', {
    id: 'annotateHud',
    style: 'position:fixed;top:70px;left:50%;transform:translateX(-50%);z-index:9999;background:var(--accent,#0078d4);color:#ffffff;border-radius:20px;padding:6px 16px;box-shadow:var(--shadow-3);display:flex;align-items:center;gap:12px;font-size:13px;font-weight:600;'
  });

  hud.appendChild(h('span', {}, t('Annotating "{name}" — write directly on image', { name: imgObj.name || t('Image') })));

  const btnDone = h('button', {
    class: 'btn',
    style: 'background:#ffffff;color:var(--accent,#0078d4);border:none;border-radius:14px;padding:3px 10px;font-size:12px;font-weight:700;cursor:pointer;'
  }, t('Done Annotating'));

  btnDone.onclick = () => finishImageAnnotate(app, imgObj);
  hud.appendChild(btnDone);
  document.body.appendChild(hud);

  app.toast(t('Annotate mode active: pen ink will become part of the image'));
}

export function finishImageAnnotate(app, imgObj) {
  document.getElementById('annotateHud')?.remove();
  const hostId = app._annotatingImage || imgObj?.id;
  app._annotatingImage = null;
  if (!hostId) return;

  const target = app.store.get(hostId);
  if (!target) return;

  const annotations = app.store.objects.filter((o) => o.attachedTo === hostId);
  if (annotations.length > 0) {
    const gid = target.groupId || ('g_' + Date.now());
    const gName = target.name ? t('Annotated {name}', { name: target.name }) : t('Annotated Image');
    const allIds = [target.id, ...annotations.map((a) => a.id)];
    app.store.updateMany(allIds, { groupId: gid, groupName: gName, locked: true }, 'annotate image');
    app.surface.invalidate();
    app.toast(t('Image and {n} annotations grouped & locked together', { n: annotations.length }));
  } else {
    app.toast(t('Annotation mode finished'));
  }
}
