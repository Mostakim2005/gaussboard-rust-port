// Viewport-virtualized, multi-LOD PDF texture & tile cache with bounded GPU VRAM LRU eviction.

import * as pdfjsLib from '../../vendor/pdf.min.mjs';
import { boundsOf } from './store.js';
import { boxesIntersect } from './util.js';

let VENDOR_BASE = '';
try {
  VENDOR_BASE = new URL('../../vendor/', import.meta.url).toString();
  if (pdfjsLib?.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdf.worker.min.mjs', import.meta.url).toString();
  }
} catch {
  // Headless / test fallback where import.meta.url or window may be minimal
}

export const LOD_SCALES = [0.25, 0.75, 1.25, 2.0];
export const TILE_SIZE = 512;

const IS_MOBILE = typeof navigator !== 'undefined' && /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent || '');
const MAX_CONCURRENT_RENDERS = IS_MOBILE ? 2 : 3;
const DEFAULT_VRAM_BUDGET = (IS_MOBILE ? 64 : 192) * 1024 * 1024;

function decodeDataUrlToBytes(str) {
  if (typeof str !== 'string') return null;
  const comma = str.indexOf(',');
  const body = comma >= 0 ? str.slice(comma + 1) : str;
  if (typeof atob === 'function') {
    const bin = atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(body, 'base64'));
  }
  return null;
}

export class PdfTextureManager {
  constructor() {
    this.docs = new Map();        // assetId -> PDFDocumentProxy
    this.docPromises = new Map(); // assetId -> Promise<PDFDocumentProxy>
    this.rawBuffers = new Map();  // assetId -> Uint8Array (in-memory / freshly imported fallback)
    this.textures = new Map();    // key -> { bmp, width, height, scale, bytes, lastFrame, wx, wy, ww, wh }
    this.inFlight = new Map();    // key -> { job, waiters: Array<() => void> }
    this.queue = [];              // Priority + LIFO render queue
    this.activeRenders = 0;
    this.vramBytes = 0;
    this.maxVramBytes = DEFAULT_VRAM_BUDGET;
    this.frameId = 0;
  }

  beginFrame() {
    this.frameId++;
  }

  /**
   * Register a raw PDF byte buffer in memory so freshly imported or Web/PWA
   * PDFs can be opened immediately without waiting on disk/protocol roundtrips.
   */
  registerBuffer(assetId, uint8Array) {
    if (!assetId || !uint8Array) return;
    const u8 = uint8Array instanceof Uint8Array
      ? uint8Array
      : (uint8Array instanceof ArrayBuffer ? new Uint8Array(uint8Array) : new Uint8Array(uint8Array.buffer || uint8Array));
    this.rawBuffers.set(assetId, u8);
  }

  selectLodScale(camZ) {
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2.5) : 1;
    const effective = (camZ || 1) * dpr * 0.92;
    for (const s of LOD_SCALES) {
      if (s >= effective) return s;
    }
    return 2.0;
  }

  async getDocument(assetId) {
    if (!assetId) throw new Error('Missing PDF assetId');
    if (this.docs.has(assetId)) return this.docs.get(assetId);
    if (this.docPromises.has(assetId)) return this.docPromises.get(assetId);

    const commonOpts = {
      cMapUrl: VENDOR_BASE ? VENDOR_BASE + 'cmaps/' : undefined,
      cMapPacked: true,
      standardFontDataUrl: VENDOR_BASE ? VENDOR_BASE + 'standard_fonts/' : undefined,
      isEvalSupported: false
    };

    const p = (async () => {
      try {
        // 1. Check in-memory buffer first (slice so pdf.js worker transfer doesn't detach our copy)
        if (this.rawBuffers.has(assetId)) {
          const data = this.rawBuffers.get(assetId).slice(0);
          const doc = await pdfjsLib.getDocument({ ...commonOpts, data }).promise;
          this.docs.set(assetId, doc);
          this.docPromises.delete(assetId);
          return doc;
        }

        // 2. Try zero-copy streaming URL in Tauri runtime
        const isTauri = typeof window !== 'undefined' && (window.__TAURI_INTERNALS__ || window.location?.protocol === 'app:');
        if (isTauri) {
          try {
            const url = window.location?.origin && window.location.origin !== 'null'
              ? `${window.location.origin}/__asset/${encodeURIComponent(assetId)}`
              : `app://board/__asset/${encodeURIComponent(assetId)}`;
            const doc = await pdfjsLib.getDocument({
              ...commonOpts,
              url,
              rangeChunkSize: 65536,
              disableAutoFetch: true,
              disableStream: false
            }).promise;
            this.docs.set(assetId, doc);
            this.docPromises.delete(assetId);
            return doc;
          } catch {
            // Fall through to board.assets raw/get fallback
          }
        }

        // 3. Fallback to window.board.assets.readRaw or window.board.assets.get
        let u8 = null;
        if (typeof window !== 'undefined' && window.board?.assets) {
          if (typeof window.board.assets.readRaw === 'function') {
            const raw = await window.board.assets.readRaw(assetId);
            if (raw) {
              u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
            }
          }
          if (!u8 && typeof window.board.assets.get === 'function') {
            const src = await window.board.assets.get(assetId);
            if (typeof src === 'string') {
              if (src.startsWith('data:')) {
                u8 = decodeDataUrlToBytes(src);
              } else if (typeof fetch === 'function') {
                const resp = await fetch(src);
                if (resp.ok) u8 = new Uint8Array(await resp.arrayBuffer());
              }
            } else if (src instanceof Uint8Array) {
              u8 = src;
            } else if (src instanceof ArrayBuffer) {
              u8 = new Uint8Array(src);
            }
          }
        }

        if (u8 && u8.byteLength > 0) {
          this.rawBuffers.set(assetId, u8);
          const doc = await pdfjsLib.getDocument({ ...commonOpts, data: u8.slice(0) }).promise;
          this.docs.set(assetId, doc);
          this.docPromises.delete(assetId);
          return doc;
        }

        throw new Error(`Unable to load PDF asset: ${assetId}`);
      } catch (err) {
        this.docPromises.delete(assetId);
        throw err;
      }
    })();

    this.docPromises.set(assetId, p);
    return p;
  }

  /**
   * Returns the best available texture for (assetId, pageIndex) immediately,
   * while scheduling an async render for the target LOD if not yet cached.
   */
  getPageTexture(assetId, pageIndex, camZ, onload, priority = 1) {
    if (!assetId) return null;
    const idx = Number(pageIndex) || 0;
    const targetScale = this.selectLodScale(camZ);
    const exactKey = `${assetId}#${idx}@${targetScale}`;
    const exact = this.textures.get(exactKey);

    if (exact) {
      exact.lastFrame = this.frameId;
      this._touchLru(exactKey, exact);
      return exact;
    }

    this._enqueueRender({
      type: 'page',
      key: exactKey,
      assetId,
      pageIndex: idx,
      scale: targetScale,
      priority,
      onload
    });

    // Also queue a fast 0.25x micro-thumb if none exists yet so zooming/panning has an instant fallback
    const thumbKey = `${assetId}#${idx}@0.25`;
    if (targetScale !== 0.25 && !this.textures.has(thumbKey) && !this.inFlight.has(thumbKey)) {
      this._enqueueRender({
        type: 'page',
        key: thumbKey,
        assetId,
        pageIndex: idx,
        scale: 0.25,
        priority: 0,
        onload
      });
    }

    // Return best already-rendered fallback scale (prefer highest available or 0.25x thumb)
    for (const s of [2.0, 1.25, 0.75, 0.25]) {
      const fb = this.textures.get(`${assetId}#${idx}@${s}`);
      if (fb) {
        fb.lastFrame = this.frameId;
        return fb;
      }
    }
    return null;
  }

  /**
   * High-zoom (> 2.2x effective zoom) 512x512 vector tile slicer.
   * Only rasterizes the visible sub-regions intersecting `vbox`.
   */
  getVisibleTiles(o, camZ, vbox, onload) {
    if (!o || !o.assetId || !vbox || !(o.w > 0) || !(o.h > 0)) return [];
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 2.5) : 1;
    const tileScale = Math.min(4.0, Math.max(2.5, Math.ceil((camZ || 1) * dpr)));
    const idx = Number(o.pageIndex) || 0;

    const cols = Math.max(1, Math.ceil((o.w * tileScale) / TILE_SIZE));
    const rows = Math.max(1, Math.ceil((o.h * tileScale) / TILE_SIZE));
    const cellW = o.w / cols;
    const cellH = o.h / rows;

    const minCol = Math.max(0, Math.floor((vbox.x - o.x) / cellW));
    const maxCol = Math.min(cols - 1, Math.floor((vbox.x + vbox.w - o.x) / cellW));
    const minRow = Math.max(0, Math.floor((vbox.y - o.y) / cellH));
    const maxRow = Math.min(rows - 1, Math.floor((vbox.y + vbox.h - o.y) / cellH));

    const readyTiles = [];
    for (let ty = minRow; ty <= maxRow; ty++) {
      for (let tx = minCol; tx <= maxCol; tx++) {
        const u0 = tx / cols;
        const v0 = ty / rows;
        const uw = 1 / cols;
        const vh = 1 / rows;
        const wx = o.x + u0 * o.w;
        const wy = o.y + v0 * o.h;
        const ww = uw * o.w;
        const wh = vh * o.h;

        const key = `${o.assetId}#${idx}@tile:${tileScale}:${cols}x${rows}:${tx},${ty}`;
        const hit = this.textures.get(key);
        if (hit) {
          hit.lastFrame = this.frameId;
          this._touchLru(key, hit);
          readyTiles.push({
            bmp: hit.bmp,
            wx,
            wy,
            ww,
            wh
          });
        } else {
          this._enqueueRender({
            type: 'tile',
            key,
            assetId: o.assetId,
            pageIndex: idx,
            scale: tileScale,
            u0,
            v0,
            uw,
            vh,
            wx,
            wy,
            ww,
            wh,
            priority: 3,
            onload
          });
        }
      }
    }
    return readyTiles;
  }

  /**
   * Pre-warms crisp textures for all `pdf-page` objects intersecting `box`
   * so synchronous `Surface.renderTo()` exports (PNG / PDF) never paint blank pages.
   */
  async warmBoxForSyncRender(objects, box, targetScale = 2.0) {
    if (!Array.isArray(objects) || !objects.length) return;
    const scale = LOD_SCALES.includes(targetScale) ? targetScale : 2.0;
    const promises = [];

    for (const o of objects) {
      if (!o || o.type !== 'pdf-page' || o.hidden || !o.assetId) continue;
      if (box && !boxesIntersect(box, boundsOf(o))) continue;
      const idx = Number(o.pageIndex) || 0;
      const key = `${o.assetId}#${idx}@${scale}`;
      const existing = this.textures.get(key);
      if (existing) {
        existing.lastFrame = this.frameId;
        this._touchLru(key, existing);
        continue;
      }
      promises.push(new Promise((resolve) => {
        this._enqueueRender({
          type: 'page',
          key,
          assetId: o.assetId,
          pageIndex: idx,
          scale,
          priority: 10,
          onload: resolve
        });
      }));
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  _touchLru(key, entry) {
    this.textures.delete(key);
    this.textures.set(key, entry);
  }

  _enqueueRender(job) {
    const inFlight = this.inFlight.get(job.key);
    if (inFlight) {
      if (job.onload) inFlight.waiters.push(job.onload);
      return;
    }

    const existingIdx = this.queue.findIndex((q) => q.key === job.key);
    if (existingIdx >= 0) {
      const existing = this.queue[existingIdx];
      existing.frameId = this.frameId;
      existing.priority = Math.max(existing.priority, job.priority);
      if (job.onload) existing.waiters.push(job.onload);
      return;
    }

    job.frameId = this.frameId;
    job.waiters = job.onload ? [job.onload] : [];
    this.queue.push(job);
    // Higher priority first; LIFO (newest frameId) within same priority
    this.queue.sort((a, b) => (b.priority - a.priority) || (b.frameId - a.frameId));
    this._pumpQueue();
  }

  _pumpQueue() {
    while (this.activeRenders < MAX_CONCURRENT_RENDERS && this.queue.length > 0) {
      const job = this.queue.shift();
      // Drop stale non-export jobs if the camera scrolled past them more than 2 frames ago
      if (job.priority < 10 && this.frameId - job.frameId > 2) {
        for (const fn of job.waiters) {
          try { fn(); } catch {}
        }
        continue;
      }

      this.activeRenders++;
      this.inFlight.set(job.key, job);

      const task = job.type === 'tile' ? this._renderTile(job) : this._renderFullPage(job);
      task
        .then(() => {
          this.inFlight.delete(job.key);
          for (const fn of job.waiters) {
            try { fn(); } catch {}
          }
        })
        .catch((err) => {
          this.inFlight.delete(job.key);
          console.warn('PDF render job failed:', job.key, err);
          for (const fn of job.waiters) {
            try { fn(); } catch {}
          }
        })
        .finally(() => {
          this.activeRenders--;
          this._pumpQueue();
        });
    }
  }

  async _renderFullPage(job) {
    const doc = await this.getDocument(job.assetId);
    const pageNo = Math.max(1, Math.min(doc.numPages, (Number(job.pageIndex) || 0) + 1));
    const page = await doc.getPage(pageNo);
    const vp = page.getViewport({ scale: job.scale });
    const w = Math.max(1, Math.ceil(vp.width));
    const h = Math.max(1, Math.ceil(vp.height));

    const canvas = this._createCanvas(w, h);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const bmp = await this._toBitmap(canvas);
    const bytes = w * h * 4;

    this._evictIfNeeded(bytes);
    this.textures.set(job.key, {
      bmp,
      width: w,
      height: h,
      scale: job.scale,
      bytes,
      lastFrame: this.frameId
    });
    this.vramBytes += bytes;
  }

  async _renderTile(job) {
    const doc = await this.getDocument(job.assetId);
    const pageNo = Math.max(1, Math.min(doc.numPages, (Number(job.pageIndex) || 0) + 1));
    const page = await doc.getPage(pageNo);
    const vp = page.getViewport({ scale: job.scale });

    const cw = Math.max(1, Math.ceil(job.uw * vp.width));
    const ch = Math.max(1, Math.ceil(job.vh * vp.height));
    const offsetX = -job.u0 * vp.width;
    const offsetY = -job.v0 * vp.height;

    const canvas = this._createCanvas(cw, ch);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);

    const transform = [1, 0, 0, 1, offsetX, offsetY];
    await page.render({ canvasContext: ctx, viewport: vp, transform }).promise;
    const bmp = await this._toBitmap(canvas);
    const bytes = cw * ch * 4;

    this._evictIfNeeded(bytes);
    this.textures.set(job.key, {
      bmp,
      width: cw,
      height: ch,
      scale: job.scale,
      wx: job.wx,
      wy: job.wy,
      ww: job.ww,
      wh: job.wh,
      bytes,
      lastFrame: this.frameId
    });
    this.vramBytes += bytes;
  }

  _createCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') {
      return new OffscreenCanvas(w, h);
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  async _toBitmap(canvas) {
    if (typeof canvas.transferToImageBitmap === 'function') {
      return canvas.transferToImageBitmap();
    }
    if (typeof createImageBitmap === 'function') {
      return await createImageBitmap(canvas);
    }
    return canvas;
  }

  _evictIfNeeded(incomingBytes) {
    if (this.vramBytes + incomingBytes <= this.maxVramBytes) return;
    for (const [key, entry] of this.textures.entries()) {
      if (this.vramBytes + incomingBytes <= this.maxVramBytes * 0.8) break;
      // Protect current/previous frame textures
      if (entry.lastFrame >= this.frameId - 1) continue;
      // Keep tiny 0.25x thumbnails in cache unless memory pressure exceeds 95%
      if (entry.scale === 0.25 && this.vramBytes < this.maxVramBytes * 0.95) continue;

      if (entry.bmp && typeof entry.bmp.close === 'function') {
        try { entry.bmp.close(); } catch {}
      }
      this.vramBytes = Math.max(0, this.vramBytes - (entry.bytes || 0));
      this.textures.delete(key);
    }
  }

  evictAsset(assetId) {
    if (!assetId) return;
    this.queue = this.queue.filter((j) => j.assetId !== assetId);
    for (const [key, entry] of this.textures.entries()) {
      if (key.startsWith(`${assetId}#`)) {
        if (entry.bmp && typeof entry.bmp.close === 'function') {
          try { entry.bmp.close(); } catch {}
        }
        this.vramBytes = Math.max(0, this.vramBytes - (entry.bytes || 0));
        this.textures.delete(key);
      }
    }
    this.rawBuffers.delete(assetId);
    this.docPromises.delete(assetId);
    const doc = this.docs.get(assetId);
    if (doc) {
      try { doc.destroy(); } catch {}
      this.docs.delete(assetId);
    }
  }
}

export const pdfCache = new PdfTextureManager();
