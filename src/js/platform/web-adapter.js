// Complete Web Platform Adapter implementing the `window.board` bridge.
// Provides 100% API parity with the Electron preload bridge using standard browser APIs.

import * as storage from './web-storage.js';
import * as files from './web-files.js';
import { generatePdfFromHtml } from './web-pdf.js';
import * as updater from './update-manager.js';
import { t } from '../i18n.js';
import { boardAssetUrl } from '../core/util.js';
import { browserClipboardWrite } from './web-clipboard.js';

const APP_VERSION = '__APP_VERSION__';
updater.setAppVersion(APP_VERSION);

const _menuListeners = new Set();
const _openFileListeners = new Set();
const STORE_ASSETS = 'assets';
const _memRawAssets = new Map();
const _vaultHandles = new Map();

async function walkDirectoryMd(dirHandle, prefix = '', out = []) {
  for await (const [name, entry] of dirHandle.entries()) {
    if (!name || name.startsWith('.')) continue;
    const relPath = prefix ? `${prefix}/${name}` : name;
    if (entry.kind === 'directory') {
      await walkDirectoryMd(entry, relPath, out);
    } else if (entry.kind === 'file' && /\.md$/i.test(name)) {
      let modifiedMs = 0, size = 0;
      try {
        const f = await entry.getFile();
        modifiedMs = f.lastModified || 0;
        size = f.size || 0;
      } catch {}
      out.push({ relPath, name: name.replace(/\.md$/i, ''), modifiedMs, size });
    }
    if (out.length >= 4000) break;
  }
  return out;
}

async function resolveVaultHandleFile(vaultRoot, relPath, create = false) {
  const dir = _vaultHandles.get(vaultRoot);
  if (!dir) throw new Error('Select the Obsidian vault folder in this browser session first');
  const parts = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p === '..' || p === '.' || p.startsWith('.'))) {
    throw new Error('Invalid vault note path');
  }
  let cur = dir;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = await cur.getDirectoryHandle(parts[i], { create });
  }
  return cur.getFileHandle(parts[parts.length - 1], { create });
}

function toUint8(input) {
  if (!input) return new Uint8Array(0);
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (Array.isArray(input)) return new Uint8Array(input);
  return new Uint8Array(0);
}

async function computeSha256Hex(u8) {
  if (typeof crypto !== 'undefined' && crypto?.subtle?.digest) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    } catch {}
  }
  // Fallback FNV-extended 64-hex deterministic digest if WebCrypto unavailable
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  for (let i = 0; i < u8.length; i++) {
    const lane = i & 7;
    h[lane] = Math.imul(h[lane] ^ u8[i], 0x01000193) >>> 0;
  }
  return Array.from(h).map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

async function idbPutAsset(id, u8) {
  const cleanId = String(id || '').trim();
  if (!cleanId || cleanId.includes('..') || cleanId.includes('/') || cleanId.includes('\\')) {
    throw new Error('Unsafe asset ID');
  }
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  _memRawAssets.set(cleanId, copy);
  try {
    const db = await storage.openDatabase();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE_ASSETS, 'readwrite');
      const store = tx.objectStore(STORE_ASSETS);
      const mime = cleanId.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
      store.put({
        id: cleanId,
        mime,
        buffer: copy.buffer,
        created: Date.now()
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  } catch {}
  return { ok: true, id: cleanId };
}

async function idbGetAssetRaw(id) {
  const cleanId = String(id || '').trim();
  if (!cleanId || cleanId.includes('..') || cleanId.includes('/') || cleanId.includes('\\')) {
    throw new Error('Unsafe asset ID');
  }
  if (_memRawAssets.has(cleanId)) {
    return new Uint8Array(_memRawAssets.get(cleanId));
  }
  try {
    const db = await storage.openDatabase();
    const record = await new Promise((resolve) => {
      const tx = db.transaction(STORE_ASSETS, 'readonly');
      const req = tx.objectStore(STORE_ASSETS).get(cleanId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    if (record) {
      if (record.buffer) {
        const out = new Uint8Array(record.buffer);
        _memRawAssets.set(cleanId, out);
        return new Uint8Array(out);
      }
      if (typeof record.dataUrl === 'string') {
        const comma = record.dataUrl.indexOf(',');
        if (comma >= 0) {
          const b64 = record.dataUrl.slice(comma + 1);
          const bin = atob(b64);
          const out = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
          _memRawAssets.set(cleanId, out);
          return out;
        }
      }
    }
  } catch {}
  return null;
}

async function webIngestPdfBytes(uint8Array) {
  const u8 = toUint8(uint8Array);
  if (
    u8.byteLength < 5 ||
    u8[0] !== 0x25 || // %
    u8[1] !== 0x50 || // P
    u8[2] !== 0x44 || // D
    u8[3] !== 0x46 || // F
    u8[4] !== 0x2d    // -
  ) {
    throw new Error('Invalid PDF file: missing %PDF- magic header');
  }
  const hash = await computeSha256Hex(u8);
  const assetId = `${hash}.pdf`;
  await idbPutAsset(assetId, u8);
  return {
    ok: true,
    assetId,
    byteLength: u8.byteLength,
    uri: boardAssetUrl(assetId, '__asset')
  };
}

export function createWebAdapter() {
  // Request persistent storage on startup
  storage.requestPersistentStorage().catch(() => {});

  // Initialize update monitoring
  updater.initUpdateWatcher();

  // Wire keyboard shortcuts for menu commands in browser
  window.addEventListener('keydown', (e) => {
    const isCmdOrCtrl = e.metaKey || e.ctrlKey;
    if (e.target && (['INPUT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable)) return;

    if (isCmdOrCtrl && !e.shiftKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      emitMenu('board.new');
    } else if (isCmdOrCtrl && !e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      emitMenu('board.open');
    } else if (isCmdOrCtrl && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      emitMenu('board.save');
    }
  });

  return {
    info: async () => {
      const chromeMatch = /Chrome\/([\d.]+)/.exec(navigator.userAgent);
      return {
        version: APP_VERSION,
        platform: 'browser',
        electron: null,
        chrome: chromeMatch ? chromeMatch[1] : 'Web',
        libreoffice: false,
        userData: t('Browser Storage (IndexedDB)'),
        smoke: false,
        isWeb: true,
        pwa: typeof window !== 'undefined' && (
          (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
          (typeof navigator !== 'undefined' && navigator.standalone === true)
        )
      };
    },

    readFile: (p) => files.readVirtualFile(p),
    // a dropped file gets the same stand-in path Add would have given it, so a dropped PDF imports like a picked one
    pathForFile: (f) => files.registerSessionFile(f),
    fileOrigin: (p) => files.fileOrigin(p),
    writeFile: (filePath, data) => files.writeVirtualFile(filePath, data),
    openDialog: (opts) => files.openFileDialog(opts),
    saveDialog: (opts) => files.saveFileDialog(opts),
    showItem: (_p) => {
      console.log('[platform] Data stored in persistent browser IndexedDB');
    },
    openReleases: (url) => {
      window.open(url || 'https://github.com/Mostakim2005/GaussBoard/releases', '_blank', 'noopener,noreferrer');
      return Promise.resolve(true);
    },
    checkForUpdate: () => updater.checkForUpdate(),
    // A browser will only hand over the clipboard with permission, and may
    // simply refuse. An empty description is the honest answer to that, and
    // leaves paste falling back to the board's own copy.
    clipboardRead: async () => {
      try {
        const text = (await navigator.clipboard?.readText?.()) || '';
        return { text, image: null, signature: text ? `text/plain\u0000${text}` : '' };
      } catch {
        return { text: '', image: null, signature: null };
      }
    },
    clipboardWrite: (payload) => browserClipboardWrite(payload),

    boards: {
      list: () => storage.listBoards(),
      load: (id) => storage.loadBoard(id),
      save: (b) => storage.saveBoard(b),
      remove: (id) => storage.deleteBoard(id),
      last: () => storage.getLastBoard(),
      setLast: (id) => storage.setLastBoard(id),
      resume: () => storage.resumeBoard(),
      migrate: () => storage.migrateLegacyData()
    },

    assets: {
      put: (dataUrl) => storage.putAsset(dataUrl),
      get: (id) => storage.getAsset(id),
      have: async (ids) => {
        const res = await storage.haveAssets(ids);
        for (const id of Array.isArray(ids) ? ids : []) {
          if (_memRawAssets.has(String(id || '').trim())) {
            res[id] = true;
          }
        }
        return res;
      },
      readRaw: (id) => idbGetAssetRaw(id),
      putBinaryDirect: (id, uint8Array) => idbPutAsset(id, toUint8(uint8Array))
    },

    pdf: {
      ingestPath: async (filePath) => {
        try {
          if (filePath) {
            const buf = await files.readVirtualFile(filePath);
            return await webIngestPdfBytes(new Uint8Array(buf));
          }
        } catch {}
        return { ok: false };
      },
      ingestBytes: (uint8Array) => webIngestPdfBytes(uint8Array)
    },

    importToPdf: async (filePath) => {
      try {
        const buf = await files.readVirtualFile(filePath);
        const name = String(filePath).split(/[\\/]/).pop() || 'document.pdf';
        const ext = name.split('.').pop().toLowerCase();

        if (ext === 'pdf') {
          return { ok: true, engine: 'native', data: buf, name };
        }

        // For other formats in web runtime, advise user
        return {
          ok: false,
          error: t('Web runtime directly imports PDF and image files. For {ext} documents, please export to PDF first.', { ext: ext.toUpperCase() })
        };
      } catch (e) {
        return { ok: false, error: e.message || t('Could not import file') };
      }
    },

    exportPdf: (payload) => generatePdfFromHtml(payload),

    vault: {
      chooseFolder: async () => {
        if (typeof window.showDirectoryPicker !== 'function') {
          return { ok: false, canceled: true, unsupported: true };
        }
        try {
          const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
          const key = `fsa://${handle.name}`;
          _vaultHandles.set(key, handle);
          return { ok: true, canceled: false, path: key, name: handle.name };
        } catch (err) {
          if (err?.name === 'AbortError') return { ok: false, canceled: true };
          return { ok: false, error: err?.message || String(err) };
        }
      },
      listNotes: async (vaultRoot) => {
        const dir = _vaultHandles.get(vaultRoot);
        if (!dir) return [];
        const list = await walkDirectoryMd(dir);
        list.sort((a, b) => (b.modifiedMs || 0) - (a.modifiedMs || 0));
        return list;
      },
      readNote: async (vaultRoot, relPath) => {
        const fh = await resolveVaultHandleFile(vaultRoot, relPath, false);
        const file = await fh.getFile();
        return { ok: true, relPath, content: await file.text(), modifiedMs: file.lastModified || 0 };
      },
      writeNote: async (vaultRoot, relPath, content) => {
        const fh = await resolveVaultHandleFile(vaultRoot, relPath, true);
        const w = await fh.createWritable();
        await w.write(String(content ?? ''));
        await w.close();
        return { ok: true, relPath, modifiedMs: Date.now() };
      }
    },

    onMenu: (cb) => { _menuListeners.add(cb); },
    onOpenFile: (cb) => { _openFileListeners.add(cb); },
    onWindowResized: (cb) => {
      window.addEventListener('resize', () => cb());
      if (screen && screen.orientation) {
        screen.orientation.addEventListener('change', () => cb());
      }
    },
    onFlush: (cb) => {
      window.addEventListener('beforeunload', async () => {
        try { await cb(); } catch {}
      });
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'hidden') {
          try { await cb(); } catch {}
        }
      });
    },

    // Hidden window converter hooks (no-op in browser)
    convertReady: () => {},
    convertError: () => {}
  };
}

function emitMenu(id) {
  for (const cb of _menuListeners) {
    try { cb(id); } catch {}
  }
}

export function emitOpenFile(data) {
  for (const cb of _openFileListeners) {
    try { cb(data); } catch {}
  }
}
