// Document model + operation log.

import { uid, unionBox } from './util.js';
import { pagesFrom, pageRects, cleanPage, DATE_RE } from './pages.js';
import { countTags } from './markdown.js';
import { t } from '../i18n.js';

export const CLIENT_ID = uid('c');

export const CARD_STYLES = ['canvas', 'window', 'minimal', 'transparent'];

export const TABLE_MAX = 40;
export function tableDim(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return 3;
  return Math.min(TABLE_MAX, Math.max(1, Math.round(n)));
}
/** Mend a table's size in place. True when it needed mending. */
export function repairTable(o) {
  if (!o || o.type !== 'table') return false;
  const rows = tableDim(o.rows), cols = tableDim(o.cols);
  if (rows === o.rows && cols === o.cols) return false;
  o.rows = rows; o.cols = cols;
  return true;
}


let _defaultCardStyle = 'canvas';

export function setDefaultCardStyle(s) {
  if (CARD_STYLES.includes(s)) _defaultCardStyle = s;
}

export function getDefaultCardStyle() {
  return _defaultCardStyle;
}

/**
 * Every text and note object defaults to `markdown: true`.
 * Text objects also default to `cardStyle: 'canvas'` (Obsidian Canvas card look).
 */
function normalizeTextObject(o) {
  if (!o || typeof o !== 'object') return o;
  if (o.type === 'text' || o.type === 'note') {
    if (o.markdown === undefined) o.markdown = true;
    if (o.type === 'text' && !o.cardStyle) o.cardStyle = _defaultCardStyle;
  }
  return o;
}

export function emptyDoc(name = t('Untitled board')) {
  return {
    id: uid('b'), name, schema: 2,
    created: Date.now(), modified: Date.now(),
    background: { color: '#ffffff', pattern: 'none', patternColor: '#c8c6c4' },
    pages: [],                     // [] = infinite canvas; [{w,h},…] = a strip of sheets
    pageClip: false,               // false = freeform unclipped canvas around pages; true = strict sheet clipping
    camera: { x: 0, y: 0, z: 1 },
    objects: {},   // id -> object
    order: [],      // z-order, back to front
    audioTracks: [],
    properties: { tags: [], aliases: [], tagCounts: {} }
  };
}

export class Store {
  constructor() {
    this.doc = emptyDoc();
    this.undoStack = [];
    this.redoStack = [];
    this.log = [];                 // append-only op log (for future sync)
    this._subs = new Set();
    this._opSubs = new Set();
    this._muted = 0;
    this.rev = 0;
    this.maxUndo = 200;
    this.maxLog = 5000;
    this.frozen = false;
    this.onFrozen = null;
  }

  /* ---------------- subscriptions ---------------- */
  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  onOp(fn) { this._opSubs.add(fn); return () => this._opSubs.delete(fn); }
  emit(reason = 'change') { if (this._muted) return; for (const f of this._subs) f(reason, this.doc); }

  /* ---------------- reading ---------------- */
  get objects() { return this.doc.order.map((id) => this.doc.objects[id]).filter(Boolean); }
  get(id) { return this.doc.objects[id]; }
  has(id) { return !!this.doc.objects[id]; }
  indexOf(id) { return this.doc.order.indexOf(id); }
  get count() { return this.doc.order.length; }

  contentBounds() {
    let b = null;
    for (const o of this.objects) b = unionBox(b, boundsOf(o));
    return b;
  }

  /**
   * Scans all text/note/table objects in the document for `#hashtag` tokens,
   * updates `doc.properties.tagCounts` with frequency counts, and merges any
   * discovered inline tags into `doc.properties.tags` (keeping `tags` as an Array
   * so existing UI chips and dialogs remain 100% compatible).
   */
  syncDocumentTags() {
    const d = this.doc;
    if (!d.properties) d.properties = { tags: [], aliases: [], tagCounts: {} };
    const counts = {};

    // Preserve manually added board-level tags with at least count 1
    const existingList = Array.isArray(d.properties.tags) ? d.properties.tags : [];
    for (const tg of existingList) {
      if (typeof tg === 'string' && tg.trim()) counts[tg.trim()] = counts[tg.trim()] || 0;
    }

    for (const id of d.order) {
      const o = d.objects[id];
      if (!o) continue;
      if (typeof o.text === 'string') {
        const c = countTags(o.text);
        for (const [k, v] of Object.entries(c)) counts[k] = (counts[k] || 0) + v;
      }
      if (o.cells && typeof o.cells === 'object') {
        for (const cellText of Object.values(o.cells)) {
          const c = countTags(cellText);
          for (const [k, v] of Object.entries(c)) counts[k] = (counts[k] || 0) + v;
        }
      }
    }

    d.properties.tagCounts = counts;
    const mergedTags = Object.keys(counts).sort((a, b) => (counts[b] || 0) - (counts[a] || 0));
    d.properties.tags = mergedTags;
    return counts;
  }

  /** Returns all known tags on this board with their frequencies: `[{ tag, count }]`. */
  allTags() {
    const counts = this.syncDocumentTags();
    return Object.entries(counts)
      .map(([tag, count]) => ({ tag, count: Math.max(1, count) }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  /* ---------------- op application ---------------- */
  _apply(op) {
    const d = this.doc;
    switch (op.t) {
      case 'add': {
        normalizeTextObject(op.obj);
        repairTable(op.obj);
        d.objects[op.obj.id] = op.obj;
        if (!d.order.includes(op.obj.id)) {
          if (op.index == null || op.index >= d.order.length) d.order.push(op.obj.id);
          else d.order.splice(op.index, 0, op.obj.id);
        }
        break;
      }
      case 'del': {
        delete d.objects[op.id];
        const i = d.order.indexOf(op.id);
        if (i >= 0) d.order.splice(i, 1);
        break;
      }
      case 'set': {
        const o = d.objects[op.id];
        if (o) { Object.assign(o, op.after); repairTable(o); }
        break;
      }
      case 'order': d.order = op.after.slice(); break;
      case 'doc': Object.assign(d, op.after); break;
    }
    d.modified = Date.now();
    this.rev++;
  }

  _invert(op) {
    switch (op.t) {
      case 'add': return { t: 'del', id: op.obj.id };
      case 'del': return { t: 'add', obj: op.obj, index: op.index };
      case 'set': return { t: 'set', id: op.id, after: op.before, before: op.after };
      case 'order': return { t: 'order', after: op.before, before: op.after };
      case 'doc': return { t: 'doc', after: op.before, before: op.after };
    }
  }

  /** Run ops as one undoable transaction. */
  commit(label, ops) {
    ops = (Array.isArray(ops) ? ops : []).filter((op) => op && typeof op === 'object' && typeof op.t === 'string');
    if (!ops.length) return;
    if (this.frozen) { this.onFrozen?.(label); return; }
    const inverse = [];
    for (const op of ops) { inverse.unshift(this._invert(op)); this._apply(op); }
    this.undoStack.push({ label, ops, inverse });
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    this.redoStack.length = 0;
    for (const op of ops) {
      this.log.push({ ...op, c: CLIENT_ID, ts: Date.now() });
      for (const f of this._opSubs) f(op);
    }
    if (this.log.length > this.maxLog) this.log.splice(0, this.log.length - this.maxLog);
    this.syncDocumentTags();
    this.emit(label);
  }

  checkpoint() {
    const snap = this.toJSON();
    this.log.length = 0;
    return snap;
  }

  rawInsert(obj, index) {
    this.rev++;
    normalizeTextObject(obj);
    this.doc.objects[obj.id] = obj;
    if (index == null || index >= this.doc.order.length) this.doc.order.push(obj.id);
    else this.doc.order.splice(index, 0, obj.id);
    return obj;
  }

  rawRemove(id) {
    this.rev++;
    delete this.doc.objects[id];
    const i = this.doc.order.indexOf(id);
    if (i >= 0) this.doc.order.splice(i, 1);
    return i;
  }

  /** Apply ops from a remote peer - no undo entry, no rebroadcast. */
  applyRemote(ops) { for (const op of ops) this._apply(op); this.syncDocumentTags(); this.emit('remote'); }

  undo() {
    if (this.frozen) { this.onFrozen?.('undo'); return false; }
    const tx = this.undoStack.pop();
    if (!tx) return false;
    for (const op of tx.inverse) this._apply(op);
    this.redoStack.push(tx);
    this.syncDocumentTags();
    this.emit('undo');
    return true;
  }

  redo() {
    if (this.frozen) { this.onFrozen?.('redo'); return false; }
    const tx = this.redoStack.pop();
    if (!tx) return false;
    for (const op of tx.ops) this._apply(op);
    this.undoStack.push(tx);
    this.syncDocumentTags();
    this.emit('redo');
    return true;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /* ---------------- convenience mutations ---------------- */
  add(obj, label = 'add') { normalizeTextObject(obj); this.commit(label, [{ t: 'add', obj }]); return obj; }
  addMany(objs, label = 'add') {
    for (const o of objs) normalizeTextObject(o);
    this.commit(label, objs.map((obj) => ({ t: 'add', obj })));
    return objs;
  }

  update(id, patch, label = 'update') {
    const o = this.get(id); if (!o) return;
    const before = {}; for (const k of Object.keys(patch)) before[k] = structuredCloneSafe(o[k]);
    this.commit(label, [{ t: 'set', id, before, after: structuredCloneSafe(patch) }]);
  }

  updateMany(ids, patchFn, label = 'update') {
    const ops = [];
    for (const id of ids) {
      const o = this.get(id); if (!o) continue;
      const patch = typeof patchFn === 'function' ? patchFn(o) : patchFn;
      if (!patch) continue;
      const before = {}; for (const k of Object.keys(patch)) before[k] = structuredCloneSafe(o[k]);
      ops.push({ t: 'set', id, before, after: structuredCloneSafe(patch) });
    }
    this.commit(label, ops);
  }

  remove(ids, label = 'delete') {
    const ops = [];
    // last first, as clear() does: undo puts them back in the opposite order, so each one returns to
    // the place it really had and the stacking (pencil under ink, say) comes back exactly as it was
    const list = [...new Set([].concat(ids))].filter((id) => this.get(id)).sort((a, b) => this.indexOf(b) - this.indexOf(a));
    for (const id of list) {
      const o = this.get(id); if (!o) continue;
      ops.push({ t: 'del', id, obj: structuredCloneSafe(o), index: this.indexOf(id) });
    }
    this.commit(label, ops);
  }

  get page() { return this.doc.pages[0] || null; }
  get pages() { return this.doc.pages; }
  get pageCount() { return this.doc.pages.length; }
  get pageRects() { return pageRects(this.doc.pages); }

  setPages(pages, label = 'page size') {
    const before = this.doc.pages.map((p) => ({ ...p }));
    const after = (pages || []).map(cleanPage);
    this.commit(label, [{ t: 'doc', before: { pages: before }, after: { pages: after } }]);
  }

  setPageClip(clip, label = 'page clip') {
    this.commit(label, [{ t: 'doc', before: { pageClip: this.doc.pageClip === true }, after: { pageClip: !!clip } }]);
  }

  pagesOp(pages) {
    return { t: 'doc', before: { pages: this.doc.pages.map((p) => ({ ...p })) },
      after: { pages: (pages || []).map(cleanPage) } };
  }

  setBackground(patch) {
    const before = { ...this.doc.background };
    this.commit('background', [{ t: 'doc', before: { background: before }, after: { background: { ...before, ...patch } } }]);
  }

  rename(name) {
    this.commit('rename', [{ t: 'doc', before: { name: this.doc.name }, after: { name } }]);
  }

  clear() {
    const ops = this.doc.order.slice().reverse().map((id) => ({ t: 'del', id, obj: structuredCloneSafe(this.doc.objects[id]), index: this.indexOf(id) }));
    this.commit('clear canvas', ops);
  }

  /* z-order */
  reorder(ids, mode) {
    const before = this.doc.order.slice();
    const set = new Set(ids);
    const moving = before.filter((id) => set.has(id));
    const rest = before.filter((id) => !set.has(id));
    let after;
    if (mode === 'front') after = [...rest, ...moving];
    else if (mode === 'back') after = [...moving, ...rest];
    else {
      after = before.slice();
      if (mode === 'forward') {
        for (let i = after.length - 2; i >= 0; i--) if (set.has(after[i]) && !set.has(after[i + 1])) { [after[i], after[i + 1]] = [after[i + 1], after[i]]; }
      } else {
        for (let i = 1; i < after.length; i++) if (set.has(after[i]) && !set.has(after[i - 1])) { [after[i], after[i - 1]] = [after[i - 1], after[i]]; }
      }
    }
    if (after.join() === before.join()) return;
    this.commit('reorder', [{ t: 'order', before, after }]);
  }

  snapshot(ids) {
    const snap = new Map();
    for (const id of ids) { const o = this.get(id); if (o) snap.set(id, structuredCloneSafe(o)); }
    return snap;
  }

  restoreSnapshot(snap) {
    if (!snap || !snap.size) return false;
    let touched = false;
    for (const [id, before] of snap) {
      const now = this.get(id);
      if (!now) continue;
      for (const k of Object.keys(now)) if (!(k in before)) delete now[k];
      Object.assign(now, structuredCloneSafe(before));
      touched = true;
    }
    if (touched) this.rev++;
    return touched;
  }

  commitSnapshot(label, snap) {
    if (this.frozen) { if (this.restoreSnapshot(snap)) this.emit('restore'); this.onFrozen?.(label); return; }
    const ops = [];
    for (const [id, before] of snap) {
      const now = this.get(id);
      if (!now) continue;
      const b = {}, a = {};
      let changed = false;
      for (const k of new Set([...Object.keys(before), ...Object.keys(now)])) {
        if (JSON.stringify(before[k]) !== JSON.stringify(now[k])) { b[k] = before[k]; a[k] = structuredCloneSafe(now[k]); changed = true; }
      }
      if (changed) {
        Object.assign(now, before);
        ops.push({ t: 'set', id, before: b, after: a });
      }
    }
    this.commit(label, ops);
  }

  /* ---------------- serialisation ---------------- */

  toJSON(extra) {
    const d = this.doc;
    return { id: d.id, name: d.name, schema: 2, created: d.created, modified: d.modified,
      origin: d.origin || undefined,
      pageDates: d.pageDates && d.pageDates.length ? d.pageDates.slice() : undefined,
      background: d.background, pages: d.pages.map((p) => ({ ...p })), page: d.pages[0] || null,
      audioTracks: Array.isArray(d.audioTracks) && d.audioTracks.length ? d.audioTracks.map((a) => ({ ...a })) : undefined,
      camera: d.camera,
      properties: d.properties ? { ...d.properties } : undefined,
      objects: d.order.map((id) => d.objects[id]).filter(Boolean), ...extra };
  }

  reset(name) {
    this.doc = emptyDoc(name);
    this.rev++;
    this.undoStack.length = 0; this.redoStack.length = 0; this.log.length = 0;
    this.emit('load');
    return this.doc;
  }

  load(data) {
    const d = emptyDoc(data.name || data.title || t('Untitled board'));
    d.id = data.id || d.id;
    d.created = data.created || Date.now();
    d.modified = data.modified || Date.now();
    if (data.origin) d.origin = data.origin;
    d.background = { ...d.background, ...(data.background || {}) };
    d.pages = pagesFrom(data);
    d.pageClip = data.pageClip === true;
    if (Array.isArray(data.pageDates)) d.pageDates = data.pageDates.map((x) => (typeof x === 'string' && DATE_RE.test(x) ? x : null));
    d.camera = data.camera || d.camera;
    if (Array.isArray(data.audioTracks)) {
      d.audioTracks = data.audioTracks.map((a) => ({ ...a }));
    }
    if (data.properties) {
      d.properties = { tags: [], aliases: [], tagCounts: {}, ...data.properties };
    }
    const list = Array.isArray(data.objects) ? data.objects
      : Array.isArray(data.objectList) ? data.objectList
        : Array.isArray(data.elements) ? data.elements
          : data.objects ? Object.values(data.objects) : [];
    let repaired = 0;
    for (const o of list) {
      normalizeTextObject(o);
      if (repairTable(o)) repaired++;
      d.objects[o.id] = o;
      d.order.push(o.id);
    }
    this.repaired = repaired;
    this.doc = d;
    this.syncDocumentTags();
    this.rev++;
    this.undoStack.length = 0; this.redoStack.length = 0; this.log.length = 0;
    this.emit('load');
  }
}

function structuredCloneSafe(v) {
  if (v === undefined || v === null || typeof v !== 'object') return v;
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
}

/* --------------------------------------------------------------- *
 * Object geometry - shared by hit-testing, rendering and export.
 * --------------------------------------------------------------- */
let connectorBox = null;
export function setConnectorBounds(fn) { connectorBox = fn; }

export const WINDOW_HEADER_H = 26;

/**
 * How wide a stroke is actually painted. A pencil on its side shades a band much wider than its
 * nib, and selecting, erasing and culling have to know that or they miss the edge you can see.
 */
export function strokeDrawWidth(o) {
  const w = (o && o.width) || 4;
  if (!o || o.effect !== 'pencil') return w;
  const tilt = Math.max(0, Math.min(1, o.tilt || 0));
  return w * (1 + tilt * 2.4);
}

export function boundsOf(o) {
  if (!o) return { x: 0, y: 0, w: 0, h: 0 };
  if (o.type === 'connector') return connectorBox ? connectorBox(o) : { x: o.x || 0, y: o.y || 0, w: o.w || 0, h: o.h || 0 };
  if (o.type === 'stroke' || (o.type === 'curtain' && Array.isArray(o.points))) {
    const b = o.bbox || { x: 0, y: 0, w: 0, h: 0 };
    const pad = strokeDrawWidth(o) / 2 + 1;
    return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  }
  if (o.type === 'text' && o.cardStyle === 'window' && o.collapsed) {
    return { x: o.x, y: o.y, w: o.w, h: WINDOW_HEADER_H };
  }
  return { x: o.x, y: o.y, w: o.w, h: o.h };
}

/** Axis-aligned bounds after rotation. */
export function worldBounds(o) {
  const b = boundsOf(o);
  const r = o.rotation || 0;
  if (!r) return b;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const w = b.w * c + b.h * s, h = b.w * s + b.h * c;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

export function centerOf(o) { const b = boundsOf(o); return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; }

export function withGroups(store, ids, exceptGroup = null) {
  const groups = new Set();
  for (const id of ids) {
    const o = store.get(id);
    if (o?.groupId && o.groupId !== exceptGroup) groups.add(o.groupId);
  }
  if (!groups.size) return [...new Set(ids)];
  const set = new Set(ids);
  for (const o of store.objects) if (o?.groupId && groups.has(o.groupId)) set.add(o.id);
  return [...set];
}

export function groupMembers(store, gid) {
  return store.objects.filter((o) => o?.groupId === gid).map((o) => o.id);
}

export function withAttached(store, ids) {
  const set = new Set(ids);
  for (const o of store.objects) if (o && o.attachedTo && set.has(o.attachedTo)) set.add(o.id);
  return [...set];
}