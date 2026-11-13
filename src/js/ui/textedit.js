// In-place text editing: a positioned editable box layered over the canvas.
//
// It was a <textarea>, which can only hold plain text. It is now an editable
// <div>, so a word can be bold or red while the rest is not (see richtext.js).
// The div still answers to .value, .selectionStart, .selectionEnd and
// setSelectionRange() exactly as the textarea did, in plain-text character
// offsets, so everything that used to talk to the textarea still can.

import { boundsOf } from '../core/store.js';
import { fitFontSize, readableText, wrapText, clamp } from '../core/util.js';
import { faceOf, noteTypeRange, inkPaint } from '../core/render.js';
import { objectRuns, normalizeRuns, layoutRich, fitRichSize, htmlToRuns, needsRich } from '../core/richtext.js';
import { refSpans, refToken, refLabel, refMissing, wikilinksToRefs, handleWikilinkDoubleClick } from '../core/boardrefs.js';
import { isMarkdown, renderMarkdownToHtml, toggleTaskAtLine, parseFrontmatter, splitMarkdownBlocksWithLines, extractFootnotes, stripObsidianComments } from '../core/markdown.js';
import { openBoardPicker } from './boardpicker.js';
import { updateSelectionBar } from './contextmenu.js';
import { t } from '../i18n.js';

/* ---------- the editable box <-> plain offsets and runs ---------- */

const BLOCK = new Set(['DIV', 'P', 'LI']);

/*
 * The box's contents as a flat list: each text node, each line break, and the
 * line break implied by a new block (the browser sometimes makes one). A line
 * break that is the very last thing in the box is the browser's placeholder
 * for an empty last line, not a character, so it is left out.
 */
function flatten(root, keepTail = false) {
  const items = [];
  let pos = 0;
  const walk = (node) => {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) {
        if (ch.data) { items.push({ kind: 'text', node: ch, from: pos, to: pos + ch.data.length }); pos += ch.data.length; }
      } else if (ch.nodeType === 1) {
        // a link to a board is one piece, whatever its label says: its text is the link itself
        const ref = ch.getAttribute && ch.getAttribute('data-ref');
        if (ref) { items.push({ kind: 'ref', node: ch, token: ref, from: pos, to: pos + ref.length }); pos += ref.length; }
        else if (ch.tagName === 'BR') { items.push({ kind: 'br', node: ch, from: pos, to: pos + 1 }); pos += 1; }
        else {
          if (BLOCK.has(ch.tagName) && pos > 0 && items.length && items[items.length - 1].kind !== 'br') {
            items.push({ kind: 'block', node: ch, from: pos, to: pos + 1 }); pos += 1;
          }
          walk(ch);
        }
      }
    }
  };
  walk(root);
  const last = items[items.length - 1];
  if (!keepTail && last && last.kind === 'br') items.pop();
  return items;
}

function plainOf(root) {
  let s = '';
  for (const it of flatten(root)) s += it.kind === 'text' ? it.node.data : it.kind === 'ref' ? it.token : '\n';
  return s;
}

/** Plain-text offset of a DOM point inside the box. */
function offsetOf(root, container, offset) {
  const total = plainOf(root).length;
  if (!root.contains(container)) return total;
  const r = document.createRange();
  r.setStart(root, 0);
  try { r.setEnd(container, offset); } catch { return total; }
  const holder = document.createElement('div');
  holder.appendChild(r.cloneContents());
  let n = 0;
  for (const it of flatten(holder, true)) n = it.to;
  return Math.min(n, total);
}

/** The DOM point for a plain-text offset. */
function pointAt(root, n) {
  const items = flatten(root);
  for (const it of items) {
    if (it.kind === 'text' && n >= it.from && n <= it.to) return [it.node, n - it.from];
    if (it.kind !== 'text' && n === it.from) {
      const parent = it.node.parentNode;
      return [parent, Array.prototype.indexOf.call(parent.childNodes, it.node)];
    }
  }
  const tail = root.lastChild;
  if (tail && tail.nodeType === 1 && tail.tagName === 'BR' && !items.some((it) => it.node === tail)) {
    return [root, root.childNodes.length - 1];
  }
  return [root, root.childNodes.length];
}

const hex2 = (v) => Number(v).toString(16).padStart(2, '0');
function toHex(rgb) {
  const m = String(rgb).match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  return m ? '#' + hex2(m[1]) + hex2(m[2]) + hex2(m[3]) : null;
}

function looksOf(el, root) {
  const cs = getComputedStyle(el);
  const w = parseInt(cs.fontWeight, 10) || (cs.fontWeight === 'bold' ? 700 : 400);
  let under = false;
  for (let n = el; n; n = n.parentElement) {
    if (n.tagName === 'U' || getComputedStyle(n).textDecorationLine.includes('underline')) { under = true; break; }
    if (n === root) break;
  }
  return { bold: w >= 600, italic: /italic|oblique/.test(cs.fontStyle), under, color: toHex(cs.color) };
}

function runsOf(root, paint = (c) => c) {
  const base = looksOf(root, root);
  const shown = String(paint('#201f1e'));
  const autoShown = (/^#[0-9a-f]{6}$/i.test(shown) ? shown.toLowerCase() : toHex(shown)) || '#201f1e';
  const runs = [];
  for (const it of flatten(root)) {
    if (it.kind !== 'text' && it.kind !== 'ref') { runs.push({ t: '\n' }); continue; }
    const l = looksOf(it.kind === 'ref' ? (it.node.parentElement || root) : it.node.parentElement, root);
    const r = { t: it.kind === 'ref' ? it.token : it.node.data };
    if (l.bold !== base.bold) r.b = l.bold ? 1 : 0;
    if (l.italic !== base.italic) r.i = l.italic ? 1 : 0;
    if (l.under !== base.under) r.u = l.under ? 1 : 0;
    if (l.color && l.color !== base.color) r.c = l.color === autoShown ? '#201f1e' : l.color;
    runs.push(r);
  }
  return normalizeRuns(runs);
}

/** Fill the box with runs (or plain text), the way it will be drawn. */
function fill(root, runs, text, paint = (c) => c) {
  root.textContent = '';
  const list = runs || [{ t: String(text ?? '') }];
  for (const r of list) {
    let into = root;
    if (r.b !== undefined || r.i !== undefined || r.u !== undefined || r.c) {
      into = document.createElement('span');
      if (r.b !== undefined) into.style.fontWeight = r.b ? '600' : '400';
      if (r.i !== undefined) into.style.fontStyle = r.i ? 'italic' : 'normal';
      if (r.u !== undefined) into.style.textDecorationLine = r.u ? 'underline' : 'none';
      if (r.c) into.style.color = paint(r.c);
      root.appendChild(into);
    }
    String(r.t).split('\n').forEach((piece, i) => {
      if (i) into.appendChild(document.createElement('br'));
      if (piece) appendWithLinks(into, piece);
    });
  }
  if (/\n$/.test(runsTextOf(list))) root.appendChild(document.createElement('br'));
}
const runsTextOf = (list) => list.map((r) => r.t).join('');

/** A link to a board as it sits among the words being typed: its name, as one piece. */
export function linkChip(ref) {
  const el = document.createElement('span');
  el.className = 'rt-ref' + (refMissing(ref) ? ' missing' : '');
  el.contentEditable = 'false';
  el.setAttribute('data-ref', refToken(ref));
  el.textContent = refLabel(ref);
  return el;
}

/** Words into the box, with each link in them made into one piece. */
function appendWithLinks(into, text) {
  let at = 0;
  for (const sp of refSpans(text)) {
    if (sp.start > at) into.appendChild(document.createTextNode(text.slice(at, sp.start)));
    into.appendChild(linkChip(sp));
    at = sp.end;
  }
  if (at < text.length) into.appendChild(document.createTextNode(text.slice(at)));
}

/** Make an editable div answer the questions a textarea used to. */
function textareaFace(el) {
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: () => plainOf(el),
    set: (v) => { fill(el, null, v); el.dispatchEvent(new Event('input')); }
  });
  const sel = () => {
    const s = document.getSelection();
    if (!s || !s.rangeCount || !el.contains(s.getRangeAt(0).startContainer)) return null;
    return s.getRangeAt(0);
  };
  Object.defineProperty(el, 'selectionStart', {
    configurable: true,
    get: () => { const r = sel(); return r ? offsetOf(el, r.startContainer, r.startOffset) : plainOf(el).length; }
  });
  Object.defineProperty(el, 'selectionEnd', {
    configurable: true,
    get: () => { const r = sel(); return r ? offsetOf(el, r.endContainer, r.endOffset) : plainOf(el).length; }
  });
  el.setSelectionRange = (a, b = a) => {
    const len = plainOf(el).length;
    const r = document.createRange();
    const [sn, so] = pointAt(el, clamp(a, 0, len));
    const [en, eo] = pointAt(el, clamp(b, 0, len));
    r.setStart(sn, so); r.setEnd(en, eo);
    const s = document.getSelection();
    s.removeAllRanges(); s.addRange(r);
  };
  el.select = () => el.setSelectionRange(0, plainOf(el).length);
}

export class TextEditor {
  /**
   * @param {object} app  the owning application (or a pane proxy: see split-workspace.js)
   * @param {HTMLElement} [layer]  positioned overlay to attach editors to;
   *   defaults to #editLayer. A second pane passes its own editor instance.
   */
  constructor(app, layer = null) {
    this.app = app;
    this.layer = layer || document.getElementById('editLayer');
    this.el = null;
    this.previewEl = null;
    this.previewMode = false;
    this.mdMode = 'source';
    this._lastEditMode = 'live';
    this.activeBlockIdx = 0;
    this.activeBlockTa = null;
    this._liveBlocks = [];
    this._internalFocusSwap = false;
    this._syncingFromBlock = false;
    this.target = null;
    this.cell = null;
    this.measure = document.createElement('canvas').getContext('2d');
  }

  get active() { return !!this.el; }

  begin(obj, cell = null) {
    this.commit();
    const app = this.app;
    this.target = obj;
    this.cell = cell;
    this.previewMode = false;
    const isMd = !cell && obj.markdown !== false && (obj.type === 'text' || obj.type === 'note');
    if (obj.cardStyle === 'window' && (!obj.w || obj.w < 480) && (!obj.h || obj.h < 280) && (!obj.text || obj.text.length < 5)) {
      obj.w = 640;
      obj.h = 520;
      obj.autoSize = false;
    }
    this.startH = obj.h;
    this.startW = obj.w;
    this.wrapW = obj.type === 'text'
      ? (obj.wrapW || Math.max(obj.w || 0, (obj.fontSize || 24) * 11.25)) : null;

    const ta = document.createElement('div');
    ta.className = isMd ? 'rt markdown-mode' : 'rt';
    ta.contentEditable = 'true';
    ta.setAttribute('role', 'textbox');
    ta.setAttribute('aria-multiline', 'true');
    ta.spellcheck = true;
    ta.setAttribute('data-gramm', 'false');
    ta.setAttribute('data-gramm_editor', 'false');
    ta.setAttribute('data-enable-grammarly', 'false');
    textareaFace(ta);
    this.paint = !cell && (obj.type === 'text' || obj.type === 'shape') ? (c) => inkPaint(c) : (c) => c;
    fill(ta, objectRuns(obj, cell), cell ? (obj.cells?.[cell] || '') : (obj.text || ''), this.paint);
    this.el = ta;
    this.layer.appendChild(ta);

    const p = app.surface.cam.toScreen(obj.x + (obj.w || 200) / 2, obj.y + (obj.h || 100) / 2);
    const vh = window.visualViewport ? window.visualViewport.height : (window.innerHeight || 768);
    const touchFirst = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (p.y > vh * 0.65 && touchFirst) {
      app.surface.cam.panBy(0, -(p.y - vh * 0.38));
      app.surface.clampCamera();
      app.surface.invalidate();
    }

    app.surface.editing = { id: obj.id, cell };
    document.body.classList.add('typing');

    this.place();

    ta.addEventListener('input', () => { this.place(); app.surface.invalidate(); this.watchMention(); });

    const insertPlain = (text) => {
      const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
      lines.forEach((line, i) => {
        if (i) document.execCommand('insertLineBreak');
        if (line) document.execCommand('insertText', false, line);
      });
    };
    const insertRich = (runs) => {
      const s = document.getSelection();
      if (!s || !s.rangeCount || !ta.contains(s.getRangeAt(0).startContainer)) return false;
      const range = s.getRangeAt(0);
      range.deleteContents();
      const holder = document.createElement('div');
      fill(holder, runs, null, this.paint);
      const nodes = [...holder.childNodes];
      if (!nodes.length) return true;
      const frag = document.createDocumentFragment();
      for (const n of nodes) frag.appendChild(n);
      range.insertNode(frag);
      const after = document.createRange();
      after.setStartAfter(nodes[nodes.length - 1]);
      after.collapse(true);
      s.removeAllRanges(); s.addRange(after);
      ta.dispatchEvent(new Event('input'));
      return true;
    };
    this._insertRich = insertRich;
    this._insertPlain = insertPlain;
    ta.addEventListener('paste', (e) => {
      e.preventDefault();
      const plain = e.clipboardData?.getData('text/plain') || '';
      const html = this._plainPaste ? '' : (e.clipboardData?.getData('text/html') || '');
      this._plainPaste = false;
      if (html) {
        const got = htmlToRuns(html);
        if (got.runs && insertRich(got.runs)) return;
        if (!plain && got.text) { insertPlain(got.text); return; }
      }
      insertPlain(plain);
    });
    ta.addEventListener('drop', (e) => {
      e.preventDefault();
      insertPlain(e.dataTransfer?.getData('text/plain'));
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (this.mention?.open && !e.isComposing && this.mention.key(e)) { e.preventDefault(); return; }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'V' || e.key === 'v')) this._plainPaste = true;
      if (e.key === 'F2') {
        e.preventDefault();
        this.toggleLivePreview();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        this.insertWikilinkSyntax();
        return;
      }
      if (isMd && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        if (e.key === 'b' || e.key === 'B') {
          if (isMarkdown(ta.value)) {
            e.preventDefault();
            this.wrapMarkdownSelection('**', '**');
            return;
          }
        }
        if (e.key === 'i' || e.key === 'I') {
          if (isMarkdown(ta.value)) {
            e.preventDefault();
            this.wrapMarkdownSelection('*', '*');
            return;
          }
        }
      }
      if (e.key === 'Escape') { e.preventDefault(); this.cancel(); app.surface.canvas.focus(); }
      else if (e.key === 'Enter' && !(e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        document.execCommand('insertLineBreak');
      }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.commit(); }
      else if (e.key === 'Tab' && cell) { e.preventDefault(); this.commit(); }
    });
    ta.addEventListener('blur', () => { if (!this._picking && !this.previewMode && !this._internalFocusSwap) this.commit(); });
    this._onSel = () => {
      if (this.el && (document.activeElement === this.el || (this.activeBlockTa && document.activeElement === this.activeBlockTa))) {
        updateSelectionBar(app, true);
      }
    };
    document.addEventListener('selectionchange', this._onSel);
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.mdMode = 'source';
    this.previewMode = false;
    this.activeBlockIdx = 0;
    this.activeBlockTa = null;
    this._liveBlocks = [];
    if (this.isMarkdownEligible()) {
      const pref = this.getPreferredMarkdownMode();
      if (pref === 'live' || pref === 'reading') {
        queueMicrotask(() => {
          if (this.el === ta && this.target === obj) {
            this.setMarkdownMode(pref, { initial: true });
          }
        });
      }
    }

    setTimeout(() => {
      ta.focus();
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
    }, 0);
    app.surface.invalidate();
  }

  /**
   * Wraps the current selection in Markdown tokens (e.g. `**` for bold, `*` for italic).
   */
  wrapMarkdownSelection(prefix, suffix = prefix) {
    if (!this.el) return;
    if (this.mdMode === 'live' && this.activeBlockTa && this.activeBlockTa.isConnected) {
      const bta = this.activeBlockTa;
      const start = bta.selectionStart ?? 0;
      const end = bta.selectionEnd ?? start;
      const val = bta.value;
      const selected = val.slice(start, end);
      bta.value = val.slice(0, start) + prefix + selected + suffix + val.slice(end);
      const caretStart = start + prefix.length;
      const caretEnd = selected ? end + prefix.length : caretStart;
      this._internalFocusSwap = true;
      bta.focus({ preventScroll: true });
      bta.setSelectionRange(caretStart, caretEnd);
      this._internalFocusSwap = false;
      this._applyActiveBlockEdit(bta.value, caretStart, caretEnd);
      return;
    }
    const start = this.el.selectionStart;
    const end = this.el.selectionEnd;
    const val = this.el.value;
    const selected = val.slice(start, end);
    this._insertPlain?.(`${prefix}${selected}${suffix}`);
    if (!selected) {
      const caret = start + prefix.length;
      this.el.setSelectionRange(caret, caret);
    }
    this.place();
    this.app.surface.invalidate();
  }

  /** Whether the current edit target supports Markdown Live Preview & modes. */
  isMarkdownEligible() {
    const o = this.target;
    if (!o || this.cell) return false;
    if (o.obsidianPath) return true;
    const s = this.app?.settings || {};
    if (o.type === 'note') {
      if (o.markdown === true) return true;
      return o.markdown !== false && s.noteMarkdown !== false && (!needsRich(o) || isMarkdown(this.el?.value || o.text || ''));
    }
    if (o.type === 'text') {
      if (o.markdown === true) return true;
      return o.markdown !== false && s.textMarkdown !== false && (!needsRich(o) || isMarkdown(this.el?.value || o.text || ''));
    }
    return false;
  }

  getPreferredMarkdownMode() {
    const m = this.app?.settings?.markdownEditMode;
    return (m === 'source' || m === 'reading' || m === 'live') ? m : 'live';
  }

  get activeInput() {
    if (this.mdMode === 'live' && this.activeBlockTa && this.activeBlockTa.isConnected) {
      return this.activeBlockTa;
    }
    return this.el;
  }

  setValue(nextText) {
    if (!this.el) return;
    this.el.value = String(nextText ?? '');
    this._syncingFromBlock = true;
    this.el.dispatchEvent(new Event('input'));
    this._syncingFromBlock = false;
    if (this.mdMode === 'reading') this.renderPreviewDom();
    else if (this.mdMode === 'live') this.renderLiveHybridDom();
    this.place();
    this.app?.surface?.invalidate?.();
  }

  _ensurePreviewEl() {
    if (this.previewEl) return this.previewEl;
    const pv = document.createElement('div');
    pv.className = 'rt gb-markdown-body gb-live-preview';
    pv.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const cb = e.target.closest('input.gb-task-checkbox');
      if (cb) {
        e.preventDefault();
        const blockEl = e.target.closest('.gb-live-block');
        const baseLine = blockEl ? Number(blockEl.dataset.lineStart || 0) : 0;
        const relLine = Number(cb.getAttribute('data-line') || 0);
        const lineIdx = this.mdMode === 'live' ? (baseLine + relLine) : relLine;
        const toggled = toggleTaskAtLine(this.el.value, lineIdx);
        if (toggled.toggled) {
          this.el.value = toggled.text;
          this._syncingFromBlock = true;
          this.el.dispatchEvent(new Event('input'));
          this._syncingFromBlock = false;
          if (this.mdMode === 'live') this.renderLiveHybridDom();
          else this.renderPreviewDom();
          this.app?.surface?.invalidate?.();
        }
        return;
      }
      const wl = e.target.closest('a.gb-wikilink, a.gb-obsidian-uri, a.gb-ext-link');
      if (wl) {
        e.preventDefault();
        const href = wl.getAttribute('data-ref') || wl.getAttribute('href');
        if (href) {
          const bmatch = /^b:([^#]+)(?:#(.+))?/.exec(href);
          const targetBoardId = bmatch ? bmatch[1] : href;
          const refObj = { id: targetBoardId, name: wl.textContent || targetBoardId };
          handleWikilinkDoubleClick(this.app, refObj, { x: e.clientX, y: e.clientY }, this.target);
        }
        return;
      }
      if (this.mdMode === 'live') {
        const blockEl = e.target.closest('.gb-live-block');
        if (blockEl) {
          const idx = Number(blockEl.dataset.blockIdx);
          if (Number.isInteger(idx) && idx !== this.activeBlockIdx) {
            e.preventDefault();
            this._activateLiveBlock(idx, { atEnd: true });
          }
          return;
        }
        if (e.target === pv && this._liveBlocks.length) {
          e.preventDefault();
          this._activateLiveBlock(this._liveBlocks.length - 1, { atEnd: true });
        }
        return;
      }
      this.setMarkdownMode(this._lastEditMode || 'live');
    });
    pv.addEventListener('focusout', () => {
      if (this.mdMode !== 'live') return;
      setTimeout(() => {
        if (!this.el || !this.target || this.mdMode !== 'live') return;
        if (this._picking || this._internalFocusSwap) return;
        const ae = document.activeElement;
        if (ae === this.el || pv.contains(ae)) return;
        if (ae?.closest?.('#ctxbar, #selectionBar, .popover, .modal, .dialog')) return;
        this.commit();
      }, 0);
    });
    this.previewEl = pv;
    this.layer.appendChild(pv);
    return pv;
  }

  /**
   * Switch Markdown editing mode between 'live' (cursor-line Live Preview),
   * 'source' (raw Markdown), and 'reading' (rendered preview).
   */
  setMarkdownMode(mode, opts = {}) {
    if (!this.el || !this.target) return;
    if (!this.isMarkdownEligible()) mode = 'source';
    if (mode !== 'live' && mode !== 'source' && mode !== 'reading') mode = 'live';

    const prevMode = this.mdMode;
    if (prevMode === 'live' || prevMode === 'source') {
      this._lastEditMode = prevMode;
    }

    // Preserve global cursor offset across Live <-> Source switches.
    let globalStart = this.el.selectionStart ?? 0;
    let globalEnd = this.el.selectionEnd ?? globalStart;
    if (prevMode === 'live' && this.activeBlockTa && this.activeBlockTa.isConnected) {
      const curBlk = this._liveBlocks[this.activeBlockIdx];
      if (curBlk) {
        globalStart = curBlk.startOffset + (this.activeBlockTa.selectionStart ?? 0);
        globalEnd = curBlk.startOffset + (this.activeBlockTa.selectionEnd ?? 0);
      }
    }

    this._internalFocusSwap = true;
    this.mdMode = mode;

    if (mode === 'source') {
      this.previewMode = false;
      this.activeBlockTa = null;
      if (this.previewEl) {
        this.previewEl.style.display = 'none';
        this.previewEl.classList.remove('gb-is-live-mode');
      }
      this.el.style.display = '';
      this.el.focus({ preventScroll: true });
      try { this.el.setSelectionRange(globalStart, globalEnd); } catch { /* ignore */ }
      this._internalFocusSwap = false;
      this.place();
      updateSelectionBar(this.app, true);
      return;
    }

    this.previewMode = true;
    const pv = this._ensurePreviewEl();
    this.el.style.display = 'none';
    pv.style.display = '';

    if (mode === 'live') {
      const blocks = splitMarkdownBlocksWithLines(this.el.value);
      this._liveBlocks = blocks;
      let idx = 0;
      if (opts.initial) {
        idx = Math.max(0, blocks.findIndex((b) => globalStart >= b.startOffset && globalStart <= b.endOffset));
      } else if (prevMode === 'source') {
        const hit = blocks.findIndex((b) => globalStart >= b.startOffset && globalStart <= b.endOffset);
        if (hit >= 0) idx = hit;
      }
      this.activeBlockIdx = Math.max(0, Math.min(idx, blocks.length - 1));
      const blk = blocks[this.activeBlockIdx];
      const relS = Math.max(0, Math.min(blk.rawText.length, globalStart - blk.startOffset));
      const relE = Math.max(relS, Math.min(blk.rawText.length, globalEnd - blk.startOffset));
      this.renderLiveHybridDom({ focusRange: [relS, relE] });
    } else {
      this.activeBlockTa = null;
      this.renderPreviewDom();
    }

    this._internalFocusSwap = false;
    this.place();
    updateSelectionBar(this.app, true);
  }

  /**
   * Toggle between edit mode ('live' or 'source') and full rendered 'reading' mode (F2).
   */
  toggleLivePreview() {
    if (!this.el || !this.target) return;
    if (this.mdMode === 'reading') {
      this.setMarkdownMode(this._lastEditMode === 'source' ? 'source' : 'live');
    } else {
      this._lastEditMode = this.mdMode === 'source' ? 'source' : 'live';
      this.setMarkdownMode('reading');
    }
  }

  cycleMarkdownMode() {
    const order = ['live', 'source', 'reading'];
    const next = order[(order.indexOf(this.mdMode) + 1) % order.length];
    this.setMarkdownMode(next);
  }

  /** Execute a formatting helper that targets this.el cleanly even during Live mode. */
  runToolbarAction(fn) {
    if (!this.el) return;
    if (this.mdMode !== 'live') { fn(); return; }
    const blk = this._liveBlocks[this.activeBlockIdx];
    const start = (this.activeBlockTa && blk)
      ? blk.startOffset + (this.activeBlockTa.selectionStart ?? 0)
      : (this.el.selectionStart ?? 0);
    const end = (this.activeBlockTa && blk)
      ? blk.startOffset + (this.activeBlockTa.selectionEnd ?? 0)
      : (this.el.selectionEnd ?? start);
    this._internalFocusSwap = true;
    this.el.style.display = '';
    if (this.previewEl) this.previewEl.style.display = 'none';
    this.el.focus({ preventScroll: true });
    try { this.el.setSelectionRange(start, end); } catch { /* ignore */ }
    try {
      fn();
    } finally {
      this.el.style.display = 'none';
      if (this.previewEl) this.previewEl.style.display = '';
      this.previewMode = true;
      this.mdMode = 'live';
      const nextPos = this.el.selectionStart ?? start;
      const nextEnd = this.el.selectionEnd ?? nextPos;
      const nextBlocks = splitMarkdownBlocksWithLines(this.el.value);
      this._liveBlocks = nextBlocks;
      let nextIdx = nextBlocks.findIndex((nb) => nextPos >= nb.startOffset && nextPos <= nb.endOffset);
      if (nextIdx < 0) nextIdx = Math.min(this.activeBlockIdx, nextBlocks.length - 1);
      this.activeBlockIdx = Math.max(0, nextIdx);
      const tb = nextBlocks[this.activeBlockIdx];
      const relS = Math.max(0, nextPos - tb.startOffset);
      const relE = Math.max(relS, nextEnd - tb.startOffset);
      this.renderLiveHybridDom({ focusRange: [relS, relE] });
      this.place();
      this._internalFocusSwap = false;
      updateSelectionBar(this.app, true);
    }
  }

  _activateLiveBlock(idx, opts = {}) {
    if (!this.el || this.mdMode !== 'live') return;
    const blocks = this._liveBlocks.length ? this._liveBlocks : splitMarkdownBlocksWithLines(this.el.value);
    const clamped = Math.max(0, Math.min(idx, blocks.length - 1));
    this.activeBlockIdx = clamped;
    const blk = blocks[clamped];
    const len = blk ? blk.rawText.length : 0;
    const pos = opts.atStart ? 0 : opts.pos != null ? Math.max(0, Math.min(len, opts.pos)) : len;
    this.renderLiveHybridDom({ focusRange: [pos, pos] });
    this.place();
    updateSelectionBar(this.app, true);
  }

  _applyActiveBlockEdit(newBlockText, selStart = newBlockText.length, selEnd = selStart) {
    if (!this.el) return;
    const blocks = this._liveBlocks;
    const blk = blocks[this.activeBlockIdx];
    if (!blk) return;
    const fullNorm = this.el.value.replace(/\r\n?/g, '\n');
    const before = fullNorm.slice(0, blk.startOffset);
    const after = fullNorm.slice(blk.endOffset);
    const nextFull = before + newBlockText + after;
    const globalStart = before.length + selStart;
    const globalEnd = before.length + selEnd;

    this.el.value = nextFull;
    try { this.el.setSelectionRange(globalStart, globalEnd); } catch { /* ignore */ }

    const nextBlocks = splitMarkdownBlocksWithLines(nextFull);
    const cur = nextBlocks[this.activeBlockIdx];
    const sameBlock = nextBlocks.length === blocks.length &&
      cur &&
      globalStart >= cur.startOffset &&
      globalStart <= cur.endOffset &&
      cur.rawText === newBlockText &&
      cur.type === blk.type;

    this._syncingFromBlock = true;
    this.el.dispatchEvent(new Event('input'));
    this._syncingFromBlock = false;

    if (sameBlock) {
      this._liveBlocks = nextBlocks;
      if (this.activeBlockTa) {
        this.activeBlockTa.style.height = 'auto';
        this.activeBlockTa.style.height = Math.max(20, this.activeBlockTa.scrollHeight) + 'px';
      }
      this.place();
      this.app?.surface?.invalidate?.();
      return;
    }

    let nextIdx = nextBlocks.findIndex((nb) => globalStart >= nb.startOffset && globalStart <= nb.endOffset);
    if (nextIdx < 0) nextIdx = Math.min(this.activeBlockIdx, nextBlocks.length - 1);
    this.activeBlockIdx = nextIdx;
    const targetBlk = nextBlocks[nextIdx];
    const relS = Math.max(0, Math.min(targetBlk.rawText.length, globalStart - targetBlk.startOffset));
    const relE = Math.max(relS, Math.min(targetBlk.rawText.length, globalEnd - targetBlk.startOffset));
    this.renderLiveHybridDom({ focusRange: [relS, relE] });
    this.place();
    this.app?.surface?.invalidate?.();
  }

  renderLiveHybridDom(opts = {}) {
    if (!this.previewEl || !this.el) return;
    const pv = this.previewEl;
    pv.classList.add('gb-is-live-mode');
    pv.classList.toggle('gb-show-line-numbers', this.target?.lineNumbers !== false);

    const text = this.el.value;
    const blocks = splitMarkdownBlocksWithLines(text);
    this._liveBlocks = blocks;
    this.activeBlockIdx = Math.max(0, Math.min(this.activeBlockIdx, blocks.length - 1));

    const { body: cleanBody } = parseFrontmatter(stripObsidianComments(text));
    const docFn = extractFootnotes(cleanBody);

    const frag = document.createDocumentFragment();
    let newActiveTa = null;

    blocks.forEach((blk, idx) => {
      const row = document.createElement('div');
      row.className = 'gb-live-block';
      row.dataset.blockIdx = String(idx);
      row.dataset.blockType = blk.type;
      row.dataset.lineStart = String(blk.startLine);

      if (idx === this.activeBlockIdx) {
        row.classList.add('is-active');
        const bta = document.createElement('textarea');
        bta.className = 'gb-live-active-ta';
        bta.value = blk.rawText;
        bta.rows = 1;
        bta.spellcheck = true;
        const autoGrow = () => {
          bta.style.height = 'auto';
          bta.style.height = Math.max(20, bta.scrollHeight) + 'px';
        };
        bta.addEventListener('pointerdown', (e) => e.stopPropagation());
        bta.addEventListener('input', () => {
          this._applyActiveBlockEdit(bta.value, bta.selectionStart ?? bta.value.length, bta.selectionEnd ?? bta.value.length);
        });
        bta.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cancel(); return; }
          if (e.key === 'F2') { e.preventDefault(); e.stopPropagation(); this.toggleLivePreview(); return; }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); this.commit(); return; }
          if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
            const s = bta.selectionStart ?? 0;
            if (s === (bta.selectionEnd ?? s) && !bta.value.slice(0, s).includes('\n') && idx > 0) {
              e.preventDefault();
              this._activateLiveBlock(idx - 1, { atEnd: true });
              return;
            }
          }
          if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
            const s = bta.selectionEnd ?? 0;
            if ((bta.selectionStart ?? 0) === s && !bta.value.slice(s).includes('\n') && idx < this._liveBlocks.length - 1) {
              e.preventDefault();
              this._activateLiveBlock(idx + 1, { atStart: true });
              return;
            }
          }
          if (e.key === 'Backspace' && (bta.selectionStart ?? 0) === 0 && (bta.selectionEnd ?? 0) === 0 && idx > 0) {
            e.preventDefault();
            const fullNorm = this.el.value.replace(/\r\n?/g, '\n');
            if (blk.startOffset > 0 && fullNorm[blk.startOffset - 1] === '\n') {
              const joinPos = blk.startOffset - 1;
              const nextFull = fullNorm.slice(0, joinPos) + fullNorm.slice(blk.startOffset);
              this.el.value = nextFull;
              this._syncingFromBlock = true;
              this.el.dispatchEvent(new Event('input'));
              this._syncingFromBlock = false;
              const nextBlocks = splitMarkdownBlocksWithLines(nextFull);
              let nextIdx = nextBlocks.findIndex((nb) => joinPos >= nb.startOffset && joinPos <= nb.endOffset);
              if (nextIdx < 0) nextIdx = Math.max(0, idx - 1);
              this.activeBlockIdx = nextIdx;
              const tb = nextBlocks[nextIdx];
              const rel = Math.max(0, joinPos - tb.startOffset);
              this.renderLiveHybridDom({ focusRange: [rel, rel] });
              this.place();
              this.app?.surface?.invalidate?.();
            }
            return;
          }
        });
        row.appendChild(bta);
        newActiveTa = bta;
        row._autoGrow = autoGrow;
      } else if (blk.isEmpty) {
        row.innerHTML = '<div class="gb-live-empty-line">&#8203;</div>';
      } else if (blk.type === 'frontmatter') {
        const lines = blk.rawText.split('\n').slice(1, -1).join(' · ');
        const fm = document.createElement('div');
        fm.className = 'gb-live-frontmatter';
        fm.innerHTML = `<span class="gb-live-fm-badge">${t('Properties')}</span><span class="gb-live-fm-preview"></span>`;
        fm.querySelector('.gb-live-fm-preview').textContent = lines || 'YAML';
        row.appendChild(fm);
      } else {
        row.innerHTML = renderMarkdownToHtml(blk.rawText, {
          footnoteNumbers: docFn.numbers,
          includeFootnotes: false
        }) || '<div class="gb-live-empty-line">&#8203;</div>';
      }
      frag.appendChild(row);
    });

    this._internalFocusSwap = true;
    pv.innerHTML = '';
    pv.appendChild(frag);
    this.activeBlockTa = newActiveTa;
    if (newActiveTa) {
      const growRow = newActiveTa.parentElement;
      growRow?._autoGrow?.();
      requestAnimationFrame(() => growRow?._autoGrow?.());
      if (Array.isArray(opts.focusRange)) {
        newActiveTa.focus({ preventScroll: true });
        try { newActiveTa.setSelectionRange(opts.focusRange[0], opts.focusRange[1]); } catch { /* ignore */ }
        growRow?._autoGrow?.();
      }
    }
    this._internalFocusSwap = false;
  }

  renderPreviewDom() {
    if (!this.previewEl || !this.el) return;
    if (this._syncingFromBlock) return;
    if (this.mdMode === 'live') {
      this.renderLiveHybridDom();
      return;
    }
    this.previewEl.classList.remove('gb-is-live-mode');
    this.previewEl.innerHTML = renderMarkdownToHtml(this.el.value);
    if (this.target?.lineNumbers !== false) {
      this.previewEl.classList.add('gb-show-line-numbers');
    } else {
      this.previewEl.classList.remove('gb-show-line-numbers');
    }
  }

  /**
   * Inserts `[[board]]` or wraps current selection in `[[selection]]` on Ctrl+K.
   */
  insertWikilinkSyntax() {
    if (!this.el) return;
    if (document.activeElement !== this.el) this.el.focus();
    const a = this.el.selectionStart;
    const b = this.el.selectionEnd;
    const val = this.el.value;
    const selected = val.slice(a, b);
    if (selected) {
      this._insertPlain?.(`[[${selected}]]`);
    } else {
      this._insertPlain?.('[[');
      this.watchMention();
    }
  }

  place() {
    if (!this.el || !this.target) return;
    const app = this.app, cam = app.surface.cam, o = this.target;
    let box;
    if (this.cell) {
      const [r, c] = this.cell.split(',').map(Number);
      const cw = o.w / o.cols, ch = o.h / o.rows;
      box = { x: o.x + c * cw, y: o.y + r * ch, w: cw, h: ch };
    } else box = boundsOf(o);

    const isMd = !this.cell && (o.markdown !== false || o.cardStyle) && (o.type === 'text' || o.type === 'note');
    if (isMd || o.autoSize === false) {
      o.w = Math.max(120, o.w || 640);
      o.h = Math.max(60, o.h || 520);
      box = boundsOf(o);
    } else if (o.type === 'note' && !this.cell) {
      const base = this.startH != null ? this.startH : o.h;
      const want = Math.max(base, this.noteHeight(o, this.el.value, base, this.runs()));
      if (want !== o.h) { o.h = want; box = boundsOf(o); app.surface.touch?.(); }
    } else if (o.type === 'text' && !this.cell && o.autoSize !== false) {
      const want = this.fitBox(o, this.el.value, this.wrapW, this.runs());
      if (want.h !== o.h || want.w !== o.w) { o.h = want.h; o.w = want.w; box = boundsOf(o); app.surface.touch?.(); }
    }

    const pad = o.type === 'note' ? Math.max(10, o.w * 0.08) : o.type === 'shape' ? 10 : 0;
    const wx = box.x + pad, wy = box.y + pad, ww = box.w - pad * 2, wh = box.h - pad * 2;
    const p = cam.toScreen(wx, wy);

    let size = o.fontSize || 0;
    const face = faceOf(o.font);
    if (!size) {
      this.measure.font = `16px ${face}`;
      const range = o.type === 'note' ? noteTypeRange(o) : { max: 72, min: 10 };
      const runs = this.runs();
      size = runs
        ? fitRichSize(this.measure, runs, ww, wh, this.richBase(o, face), range.max, range.min)
        : fitFontSize(this.measure, this.el.value || ' ', ww, wh, face, '400', range.max, range.min);
    }

    const applyBoxStyle = (domEl) => {
      if (!domEl) return;
      // Editor coordinates are canvas coordinates. In a split workspace the
      // canvas is not at the overlay's origin, so carry the difference or the
      // box (and the text) appear on the other pane.
      const lr = this.layer?.getBoundingClientRect?.();
      const cr = app.surface.canvas?.getBoundingClientRect?.();
      const ox = lr && cr ? cr.left - lr.left : 0;
      const oy = lr && cr ? cr.top - lr.top : 0;
      const s = domEl.style;
      s.left = (p.x + ox) + 'px';
      s.top = (p.y + oy) + 'px';
      s.width = Math.max(24, ww * cam.z) + 'px';
      s.height = Math.max(20, wh * cam.z) + 'px';
      s.fontSize = size * cam.z + 'px';
      s.lineHeight = 1.28;
      s.fontFamily = face;
      s.fontWeight = o.bold ? '600' : '400';
      s.fontStyle = o.italic ? 'italic' : 'normal';
      s.textDecorationLine = o.underline && !this.cell ? 'underline' : 'none';
      s.textAlign = this.cell ? 'center' : (o.align || (o.type === 'text' ? 'left' : 'center'));
      const ink = o.type === 'note' ? (o.textColor || readableText(o.color || '#ffd94a'))
        : inkPaint(o.color || o.textColor);
      const isTransparent = o.cardStyle === 'transparent' || o.background === 'transparent' || o.background === 'none';
      const isDark = app.surface?.isDark?.() ?? false;
      const defaultSolidBg = isDark ? '#202227' : '#ffffff';
      s.background = isTransparent ? 'transparent'
        : (o.background && o.background !== 'none' ? o.background : (isMd ? defaultSolidBg : (o.type === 'note' ? o.color : 'transparent')));
      s.color = isMd && !isTransparent ? (isDark ? '#e2e8f0' : '#1e293b') : ink;
      s.caretColor = isMd ? (isDark ? '#38bdf8' : '#0284c7') : ink;
      s.outlineColor = o.type === 'note' ? ink : (isMd ? 'transparent' : 'rgba(0,0,0,.45)');
      s.borderRadius = isMd ? '8px' : '0px';
      s.boxShadow = isMd && !isTransparent ? '0 4px 16px rgba(0,0,0,0.12)' : 'none';
      s.border = isMd && !isTransparent ? (isDark ? '1px solid rgba(255,255,255,0.12)' : '1px solid rgba(0,0,0,0.12)') : 'none';
      s.overflowY = isMd ? 'auto' : 'visible';
      s.transform = o.rotation ? `rotate(${o.rotation}rad)` : '';
      s.transformOrigin = '0 0';
      s.padding = isMd ? '10px 14px' : '0';
      if (o.type === 'note' || o.type === 'shape' || this.cell) {
        const lines = this.el.value.split('\n').length;
        const contentH = lines * size * 1.28 * cam.z;
        s.paddingTop = Math.max(0, (wh * cam.z - contentH) / 2) + 'px';
      } else s.paddingTop = '0';
    };

    applyBoxStyle(this.el);
    applyBoxStyle(this.previewEl);

    if (document.activeElement === this.el) updateSelectionBar(app, true);
  }

  /** What is in the box right now, as runs - or null when it is all plain. */
  runs() {
    if (!this.el || !this.el.isConnected) return null;
    return runsOf(this.el, this.paint);
  }

  /** The box's own style, as the rich layout wants it. */
  richBase(o, face = faceOf(o.font), size = o.fontSize || 24) {
    return { family: face, weight: '400', bold: !!o.bold && !this.cell, italic: !!o.italic && !this.cell, underline: !!o.underline && !this.cell, color: '#000', size };
  }

  commit() {
    if (!this.el || !this.target) return;
    this.endMention();
    const rawValue = this.el.value;
    // Translate [[Target Board#Page|Alias]] wikilinks into native @[Label](b:boardId#page) tokens on commit
    const value = wikilinksToRefs(rawValue);
    const runs = value !== rawValue ? null : this.runs();
    const el = this.el;
    const pv = this.previewEl;
    this.stopWatching();
    this.el = null;
    this.previewEl = null;
    this.previewMode = false;
    const target = this.target;
    const cell = this.cell;
    this.target = null; this.cell = null;
    this.app.surface.editing = null;
    document.body.classList.remove('typing');
    el.remove();
    if (pv) pv.remove();

    const store = this.app.store;
    const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
    if (cell) {
      const cells = { ...(target.cells || {}) };
      const oldRuns = objectRuns(target, cell);
      if ((cells[cell] || '') !== value || !same(oldRuns, runs)) {
        if (value) cells[cell] = value; else delete cells[cell];
        const patch = { cells };
        if (runs || target.cellRuns) {
          const cellRuns = { ...(target.cellRuns || {}) };
          if (runs && value) cellRuns[cell] = runs; else delete cellRuns[cell];
          patch.cellRuns = Object.keys(cellRuns).length ? cellRuns : undefined;
        }
        store.update(target.id, patch, 'edit table');
      }
    } else if ((target.text || '') !== value || !same(objectRuns(target), runs)) {
      const patch = { text: value };
      if (runs || target.runs !== undefined) patch.runs = runs || undefined;
      const isMd = target.markdown !== false && (target.type === 'text' || target.type === 'note');
      if (target.type === 'text' && target.autoSize === false) {
        if (this.startH != null) target.h = this.startH;
        if (this.startW != null) target.w = this.startW;
        patch.w = target.w;
        patch.h = target.h;
        patch.wrapW = target.w;
      } else if (target.type === 'text' && target.autoSize !== false) {
        if (this.startH != null) target.h = this.startH;
        if (this.startW != null) target.w = this.startW;
        Object.assign(patch, this.fitBox(target, value, this.wrapW, runs));
        patch.wrapW = this.wrapW;
      } else if (target.type === 'text') {
        if (this.startH != null) target.h = this.startH;
        const h = this.fitBox(target, value, target.w, runs).h;
        if (h !== target.h) patch.h = h;
      }
      if (isMd && value) {
        try {
          const fm = parseFrontmatter(value);
          if (fm && fm.attributes) {
            if (fm.attributes.title) patch.title = String(fm.attributes.title);
            if (Array.isArray(fm.attributes.tags)) patch.tags = fm.attributes.tags;
            if (Array.isArray(fm.attributes.aliases)) patch.aliases = fm.attributes.aliases;
          }
        } catch {}
      }
      if (target.type === 'note') {
        if (this.startH != null) target.h = this.startH;
        const base = target.h;
        const want = Math.max(base, this.noteHeight(target, value, base, runs));
        if (want !== target.h) patch.h = want;
      }
      store.update(target.id, patch, 'edit text');
      if (!value && target.type === 'text') store.remove([target.id], 'remove empty text');
    } else if (!value && target.type === 'text' && !target.text) {
      store.remove([target.id], 'remove empty text');
    } else if (this.startH != null && (target.type === 'note' || target.type === 'text')) {
      target.h = this.startH;
      if (target.type === 'text' && this.startW != null) target.w = this.startW;
    }
    this.startH = null; this.startW = null; this.wrapW = null;

    this.app.afterTextEdit();
    this.app.surface.invalidate();
    this.app.syncUI();
  }

  fitBox(o, value, wrapW = this.wrapW, runs = null) {
    if (!runs && needsRich(value)) runs = [{ t: value }];
    const size = o.fontSize || 24;
    const family = faceOf(o.font);
    this.measure.font = `${o.bold ? '600 ' : ''}${size}px ${family}`;
    const pad = size * 0.35;
    const limit = Math.max(40, wrapW || o.w);
    let lines, widest = 0;
    if (runs) {
      const laid = layoutRich(this.measure, runs, limit, this.richBase(o, family, size));
      lines = laid;
      for (const l of laid) widest = Math.max(widest, l.w);
    } else {
      lines = wrapText(this.measure, value, limit);
      for (const line of lines) widest = Math.max(widest, this.measure.measureText(line).width);
    }
    const mdActive = o.markdown !== false && !runs && isMarkdown(value);
    const lineMult = mdActive ? 1.48 : 1.28;
    const extraPad = mdActive ? size * 0.8 : pad * 0.4;
    return {
      w: clamp(widest + pad + (mdActive ? 20 : 0), size * 1.2, limit),
      h: Math.max(size * 1.3, lines.length * size * lineMult + extraPad)
    };
  }

  noteHeight(o, value, baseH = o.h, runs = null) {
    if (!runs && needsRich(value)) runs = [{ t: value }];
    const pad = Math.max(10, o.w * 0.08);
    const innerW = Math.max(8, o.w - pad * 2);
    const face = faceOf(o.font);
    const weight = o.bold ? '600' : '400';
    let size = o.fontSize;
    if (!size) {
      this.measure.font = `${weight} 16px ${face}`;
      const range = noteTypeRange(o);
      size = runs
        ? fitRichSize(this.measure, runs, innerW, Math.max(8, baseH - pad * 2), this.richBase(o, face), range.max, range.min)
        : fitFontSize(this.measure, value || ' ', innerW, Math.max(8, baseH - pad * 2), face, weight, range.max, range.min);
    }
    this.measure.font = `${weight} ${size}px ${face}`;
    const lines = runs ? layoutRich(this.measure, runs, innerW, this.richBase(o, face, size)) : wrapText(this.measure, value || ' ', innerW);
    return Math.ceil(lines.length * size * 1.28 + pad * 2);
  }

  cancel() {
    if (!this.el) return;
    this.endMention();
    const target = this.target;
    const el = this.el;
    const pv = this.previewEl;
    this.stopWatching();
    this.el = null; this.previewEl = null; this.previewMode = false; this.target = null; this.cell = null;
    this.app.surface.editing = null;
    document.body.classList.remove('typing');
    el.remove();
    if (pv) pv.remove();
    if (target && (target.type === 'note' || target.type === 'text') && this.startH != null) {
      target.h = this.startH;
      if (target.type === 'text' && this.startW != null) target.w = this.startW;
    }
    this.startH = null; this.startW = null; this.wrapW = null;
    if (target && target.type === 'text' && !target.text) this.app.store.remove([target.id], 'remove empty text');
    this.app.afterTextEdit();
    this.app.surface.invalidate();
    this.app.syncUI();
  }

  toggleLinePrefix(prefix, regex) {
    if (!this.el) return;
    const a = this.el.selectionStart;
    const b = this.el.selectionEnd;
    const val = this.el.value;
    const lines = val.split('\n');
    let charCount = 0;
    let startLine = 0, endLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const len = lines[i].length + 1;
      if (charCount <= a && a < charCount + len) startLine = i;
      if (charCount <= b && b <= charCount + len) { endLine = i; break; }
      charCount += len;
    }
    for (let i = startLine; i <= endLine; i++) {
      if (regex && regex.test(lines[i])) {
        lines[i] = lines[i].replace(regex, '');
      } else {
        lines[i] = prefix + (regex ? lines[i].replace(regex, '') : lines[i]);
      }
    }
    const newVal = lines.join('\n');
    this.el.value = newVal;
    this.place();
    if (this.previewEl) this.renderPreviewDom();
    this.app.surface.invalidate();
    this.el.dispatchEvent(new Event('input'));
  }

  insertBlockText(template) {
    if (!this.el) return;
    const a = this.el.selectionStart;
    const b = this.el.selectionEnd;
    const val = this.el.value;
    const before = val.slice(0, a);
    const after = val.slice(b);
    const nlBefore = before && !before.endsWith('\n') ? '\n\n' : '';
    const nlAfter = after && !after.startsWith('\n') ? '\n\n' : '';
    const textToInsert = `${nlBefore}${template}${nlAfter}`;
    this._insertPlain?.(textToInsert);
    this.place();
    if (this.previewEl) this.renderPreviewDom();
    this.app.surface.invalidate();
  }

  insertMarkdownTable(rows = 3, cols = 3) {
    let header = '| ' + Array.from({ length: cols }, (_, i) => `Col ${i + 1}`).join(' | ') + ' |\n';
    let sep = '| ' + Array.from({ length: cols }, () => '---').join(' | ') + ' |\n';
    let body = '';
    for (let r = 0; r < rows; r++) {
      body += '| ' + Array.from({ length: cols }, (_, c) => `Item ${r + 1}.${c + 1}`).join(' | ') + ' |\n';
    }
    this.insertBlockText(header + sep + body.trimEnd());
  }

  insertCallout(calloutType = 'note', title = 'Note', body = 'Important recall details here.') {
    const text = `> [!${calloutType}] ${title}\n> ${body}`;
    this.insertBlockText(text);
  }

  insertCodeBlock(lang = 'javascript') {
    const text = `\`\`\`${lang}\nconsole.log("Hello, Obsidian!");\n\`\`\``;
    this.insertBlockText(text);
  }

  insertMermaidBlock() {
    const text = `\`\`\`mermaid\ngraph TD\n  A[Start Note] --> B[Connect to Board]\n  B --> C[Active Recall]\n\`\`\``;
    this.insertBlockText(text);
  }

  insertMathBlock() {
    const text = `$$\nE = mc^2\n$$`;
    this.insertBlockText(text);
  }

  deleteCurrentLineOrSelection() {
    if (!this.el) return;
    const a = this.el.selectionStart;
    const b = this.el.selectionEnd;
    if (a !== b) {
      document.execCommand('delete');
      this.place();
      if (this.previewEl) this.renderPreviewDom();
      return;
    }
    const val = this.el.value;
    const lineStart = val.lastIndexOf('\n', a - 1) + 1;
    let lineEnd = val.indexOf('\n', a);
    if (lineEnd === -1) lineEnd = val.length;
    else lineEnd += 1;
    this.el.setSelectionRange(lineStart, lineEnd);
    document.execCommand('delete');
    this.place();
    if (this.previewEl) this.renderPreviewDom();
  }

  clearFormatting() {
    if (!this.el) return;
    document.execCommand('removeFormat');
    const a = this.el.selectionStart;
    const b = this.el.selectionEnd;
    const val = this.el.value;
    const selected = val.slice(a, b);
    if (selected) {
      const stripped = selected.replace(/^#{1,6}\s+|^\s*[-*+]\s+(\[[ xX]\]\s+)?|^\s*\d+\.\s+|^>\s*/gm, '');
      this._insertPlain?.(stripped);
    }
    this.place();
    if (this.previewEl) this.renderPreviewDom();
  }

  setCardSizePreset(preset = 'halfPage') {
    if (!this.target) return;
    const o = this.target;
    let w = 640, h = 520;
    if (preset === 'wide') { w = 960; h = 680; }
    else if (preset === 'compact') { w = 360; h = 240; }
    else if (preset === 'halfPage') { w = 640; h = 520; }
    o.w = w;
    o.h = h;
    o.wrapW = w;
    o.autoSize = false;
    o.cardStyle = o.cardStyle || 'canvas';
    this.app.store.update(o.id, { w, h, wrapW: w, autoSize: false, cardStyle: o.cardStyle }, 'resize note');
    this.place();
    this.app.surface.touch?.();
    this.app.surface.invalidate();
    updateSelectionBar(this.app, true);
  }

  setCardBackground(bg) {
    if (!this.target) return;
    const o = this.target;
    o.background = bg;
    o.cardStyle = bg === 'transparent' ? 'transparent' : 'canvas';
    this.app.store.update(o.id, { background: bg, cardStyle: o.cardStyle }, 'note background');
    this.place();
    this.app.surface.touch?.();
    this.app.surface.invalidate();
    updateSelectionBar(this.app, true);
  }

  setCardFontSize(size) {
    if (!this.target) return;
    const o = this.target;
    o.fontSize = Number(size) || 20;
    this.app.store.update(o.id, { fontSize: o.fontSize }, 'font size');
    this.place();
    this.app.surface.touch?.();
    this.app.surface.invalidate();
    updateSelectionBar(this.app, true);
  }

  toggleLineNumbers() {
    if (!this.target) return;
    const o = this.target;
    o.lineNumbers = o.lineNumbers === false ? true : false;
    this.app.store.update(o.id, { lineNumbers: o.lineNumbers }, 'toggle line numbers');
    this.place();
    if (this.previewEl) this.renderPreviewDom();
    this.app.surface.invalidate();
    updateSelectionBar(this.app, true);
  }

  reposition() { if (this.el) this.place(); }

  /*
   * "@" or "[[" followed by a few words, right before the caret, is a search for a
   * board.
   */
  mentionQuery() {
    if (!this.el) return null;
    const s = document.getSelection();
    if (!s || !s.rangeCount || !s.isCollapsed) return null;
    const caret = this.el.selectionStart;
    const before = this.el.value.slice(0, caret);

    // Check Obsidian `[[` trigger first
    const wl = /\[\[([^\]\n]{0,40})$/.exec(before);
    if (wl) {
      return { at: caret - wl[1].length - 2, caret, query: wl[1], wikilink: true };
    }

    const m = /(^|[\s(\[{"'“‘])@([^@\n]{0,40})$/.exec(before);
    if (!m || /\s\s$/.test(m[2]) || /^[\s[]/.test(m[2])) return null;
    return { at: caret - m[2].length - 1, caret, query: m[2] };
  }

  watchMention() {
    const q = this.mentionQuery();
    if (!q) { this.endMention(); return; }
    this._mentionAt = q;
    if (this.mention?.open) { this.mention.setQuery(q.query); return; }
    const r = document.getSelection().getRangeAt(0).cloneRange();
    let box = r.getBoundingClientRect();
    if (!box || (!box.width && !box.height && !box.left)) box = this.el.getBoundingClientRect();
    this.app.refreshBoardDirectory?.();
    this.mention = openBoardPicker(this.app, {
      at: { x: box.left - 8, y: box.bottom + 6 },
      query: q.query,
      onPick: (ref) => this.pickMention(ref),
      onClose: () => { this.mention = null; }
    });
  }

  endMention() {
    const m = this.mention;
    this.mention = null;
    if (m?.open) m.close();
  }

  /** Swap the "@words" or "[[words" just typed for a link to the board chosen. */
  async pickMention(choice) {
    const at = this._mentionAt;
    this.mention = null;
    if (!this.el || !at) return;
    let ref = choice;
    if (choice.create) {
      this._picking = true;
      try { ref = await this.app.createLinkedBoard(choice.create); } finally { this._picking = false; }
      if (!ref || !this.el) return;
    }
    this.el.focus();
    const afterCaret = this.el.value.slice(at.caret);
    const extraClose = at.wikilink && afterCaret.startsWith(']]') ? 2 : 0;
    this.el.setSelectionRange(at.at, at.caret + extraClose);
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const chip = linkChip(ref), space = document.createTextNode(' ');
    range.insertNode(space);
    range.insertNode(chip);
    const after = document.createRange();
    after.setStart(space, 1); after.collapse(true);
    sel.removeAllRanges(); sel.addRange(after);
    this.el.dispatchEvent(new Event('input'));
  }

  stopWatching() {
    if (this._onSel) document.removeEventListener('selectionchange', this._onSel);
    this._onSel = null;
  }

  format(kind) {
    if (!this.el) return;
    if (document.activeElement !== this.el) this.el.focus();
    document.execCommand('styleWithCSS', false, true);
    document.execCommand(kind);
    this.place();
    this.app.surface.invalidate();
  }

  colour(hex) {
    if (!this.el) return;
    if (document.activeElement !== this.el) this.el.focus();
    document.execCommand('styleWithCSS', false, true);
    document.execCommand('foreColor', false, hex || getComputedStyle(this.el).color);
    this.place();
    this.app.surface.invalidate();
  }

  async pasteFromClipboard() {
    if (!this.el || !window.board?.clipboardRead) return false;
    let got = null;
    try { got = await window.board.clipboardRead(); } catch { got = null; }
    if (!this.el) return false;
    if (document.activeElement !== this.el) this.el.focus();
    const html = got && got.html ? String(got.html) : '';
    const text = got && got.text ? String(got.text) : '';
    if (html) {
      const r = htmlToRuns(html);
      if (r.runs && this._insertRich?.(r.runs)) return true;
      if (!text && r.text) { this._insertPlain?.(r.text); return true; }
    }
    if (text) { this._insertPlain?.(text); return true; }
    this.app.toast(t('There is nothing to paste'));
    return false;
  }

  state(kind) {
    try { return document.queryCommandState(kind); } catch { return false; }
  }
}