// src/js/platform/tauri-board.js
(function initTauriBridge() {
  if (typeof window === 'undefined' || window.board) {
    return; // Native bridge already mounted window.board
  }
  const tauri = window.__TAURI__;
  if (!tauri || !tauri.core || !tauri.event) {
    return;
  }

  const { invoke } = tauri.core;
  const { listen } = tauri.event;

  let cachedClipboardSig = null;

  async function refreshClipboardSignature() {
    try {
      cachedClipboardSig = await invoke('clipboard_signature');
    } catch (_) {
      // Ignore transient clipboard lock errors on Windows
    }
  }

  // Keep synchronous signature cache warm on focus and clipboard operations
  window.addEventListener('focus', refreshClipboardSignature, true);
  window.addEventListener('copy', () => setTimeout(refreshClipboardSignature, 20), true);
  window.addEventListener('cut', () => setTimeout(refreshClipboardSignature, 20), true);
  if (window.__TAURI__?.event?.listen) {
    try {
      window.__TAURI__.event.listen('board://clipboard-seq', (e) => {
        cachedClipboardSig = 'seq:' + e.payload;
      });
    } catch {}
  }
  refreshClipboardSignature();

  function toByteArray(buf) {
    if (!buf) return [];
    if (Array.isArray(buf)) return buf;
    if (buf instanceof Uint8Array) return Array.from(buf);
    if (buf instanceof ArrayBuffer) return Array.from(new Uint8Array(buf));
    if (ArrayBuffer.isView(buf)) {
      return Array.from(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    }
    return [];
  }

  function toUint8Array(buf) {
    if (!buf) return new Uint8Array(0);
    if (buf instanceof Uint8Array) return buf;
    if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
    if (ArrayBuffer.isView(buf)) {
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    if (Array.isArray(buf)) return new Uint8Array(buf);
    return new Uint8Array(0);
  }

  function uint8ToBase64(uint8Array) {
    const u8 = toUint8Array(uint8Array);
    const CHUNK = 0x8000;
    const parts = [];
    for (let i = 0; i < u8.length; i += CHUNK) {
      parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK)));
    }
    return btoa(parts.join(''));
  }

  let _webFiles = null;
  const _fallbackFiles = new Map();
  let _fallbackSeq = 0;

  async function ensureWebFiles() {
    if (_webFiles) return _webFiles;
    try {
      _webFiles = await import('./web-files.js');
    } catch (_) {}
    return _webFiles;
  }
  ensureWebFiles();

  function registerFileToken(file) {
    if (_webFiles && typeof _webFiles.registerSessionFile === 'function') {
      return _webFiles.registerSessionFile(file);
    }
    const token = `virt://session-${++_fallbackSeq}/${String(file?.name || 'file').replace(/[\\/]/g, '_')}`;
    _fallbackFiles.set(token, file);
    return token;
  }

  function resolveFileOrigin(token) {
    if (_webFiles && typeof _webFiles.fileOrigin === 'function') {
      const orig = _webFiles.fileOrigin(token);
      if (orig) return orig;
    }
    const f = _fallbackFiles.get(token);
    if (!f) return typeof token === 'string' ? token : null;
    return 'web:' + (f.name || 'file') + '|' + (f.size || 0) + '|' + (f.lastModified || 0);
  }

  async function readFileHelper(filePath) {
    if (_fallbackFiles.has(filePath)) {
      const f = _fallbackFiles.get(filePath);
      if (f && typeof f.arrayBuffer === 'function') return await f.arrayBuffer();
    }
    const wf = await ensureWebFiles();
    const reader = wf?.readVirtualFile || wf?.getFileByHandle;
    if (reader) {
      return await reader(filePath);
    }
    throw new Error('File not found: ' + filePath);
  }

  async function writeFileHelper(filePath, data) {
    const wf = await ensureWebFiles();
    const writer = wf?.writeVirtualFile || wf?.writePendingSave;
    if (writer) {
      return await writer(filePath, data);
    }
    return false;
  }

  async function openDialogHelper(opts = {}) {
    const wf = await ensureWebFiles();
    const opener = wf?.openFileDialog || wf?.webOpenDialog;
    if (opener) {
      return await opener(opts);
    }
    return [];
  }

  async function saveDialogHelper(opts = {}) {
    const wf = await ensureWebFiles();
    const saver = wf?.saveFileDialog || wf?.webSaveDialog;
    if (saver) {
      return await saver(opts);
    }
    return opts?.defaultPath || 'untitled';
  }

  window.board = {
    info: () => invoke('app_info'),

    openDialog: (opts) => openDialogHelper(opts),
    saveDialog: (opts) => saveDialogHelper(opts),
    readFile: (p) => readFileHelper(p),
    writeFile: (filePath, data) => writeFileHelper(filePath, data),
    pathForFile: (f) => registerFileToken(f),
    fileOrigin: (p) => resolveFileOrigin(p),

    boards: {
      list: () => invoke('boards_list'),
      load: (id) => invoke('boards_load', { id }),
      save: (payload) => invoke('boards_save', { payload }),
      remove: (id) => invoke('boards_delete', { id }),
      last: () => invoke('boards_get_last'),
      setLast: (id) => invoke('boards_set_last', { id }),
      resume: (opts) => invoke('boards_resume', { opts: opts || {} }),
      migrate: () => invoke('boards_migrate')
    },

    storage: {
      get: () => invoke('storage_get'),
      choose: () => invoke('storage_choose'),
      apply: (opts) => invoke('storage_apply', { opts: opts || {} }),
      reset: (opts) => invoke('storage_reset', { opts: opts || {} }),
      deleteOld: (token) => invoke('storage_delete_old', { token }),
      readCatalogue: () => invoke('storage_catalogue_read'),
      writeCatalogue: (json) => invoke('storage_catalogue_write', { json }),
      flushAck: (ticket, ok) => invoke('storage_flush_ack', { ticket, ok: !!ok }),
      onFlush: (cb) => { listen('storage:flush', (e) => cb(e.payload)); },
      onResume: (cb) => { listen('storage:resume', (e) => cb(e.payload)); },
      onChanged: (cb) => { listen('storage:changed', () => cb()); }
    },

    assets: {
      put: (dataUrl) => invoke('assets_put', { dataUrl }),
      get: (id) => invoke('assets_get', { id }),
      have: (ids) => invoke('assets_have', { ids: Array.isArray(ids) ? ids : [] }),
      readRaw: async (id) => {
        const bytes = await invoke('assets_read_raw', { id });
        return new Uint8Array(bytes);
      },
      putBinaryDirect: async (id, uint8Array) =>
        invoke('assets_put_binary', { id, dataB64: uint8ToBase64(uint8Array) })
    },

    pdf: {
      ingestPath: async (filePath) => {
        if (typeof filePath === 'string' && filePath.startsWith('virt://')) {
          const buf = await readFileHelper(filePath);
          const bytes = Array.from(new Uint8Array(buf));
          return invoke('pdf_ingest_bytes', { bytes });
        }
        return invoke('pdf_ingest_path', { path: filePath });
      },
      ingestBytes: async (uint8Array) => {
        const bytes = uint8Array instanceof Uint8Array
          ? Array.from(uint8Array)
          : Array.from(new Uint8Array(uint8Array));
        return invoke('pdf_ingest_bytes', { bytes });
      }
    },

    recording: {
      start: (sessionId) => invoke('recording_start', { sessionId }),
      appendChunk: (sessionId, chunk) =>
        invoke('recording_append_chunk', { sessionId, chunk: toByteArray(chunk) }),
      finish: (sessionId, durationMs) =>
        invoke('recording_finish', { sessionId, durationMs: Math.round(durationMs || 0) }),
      readAsset: async (id) => {
        const bytes = await invoke('assets_read_raw', { id });
        return new Uint8Array(bytes);
      }
    },

    sync: {
      state: () => invoke('sync_state'),
      start: () => invoke('sync_start'),
      stop: () => invoke('sync_stop'),
      setName: (name) => invoke('sync_set_name', { name }),
      beginPairing: (opts) => invoke('sync_begin_pairing', { opts: opts || {} }),
      cancelPairing: () => invoke('sync_cancel_pairing'),
      pairWith: (peer, code) => invoke('sync_pair_with', { peer, code }),
      send: (peer, board) => invoke('sync_send', { peer, board }),
      addByAddress: (address) => invoke('sync_add_by_address', { address }),
      unpair: (deviceId) => invoke('sync_unpair', { deviceId }),
      stillPaired: (peer) => invoke('sync_still_paired', { peer }),
      endSession: () => invoke('sync_end_session'),
      firewall: {
        check: () => invoke('sync_firewall_check'),
        repair: () => invoke('sync_firewall_repair'),
        remove: () => invoke('sync_firewall_remove'),
        commands: () => invoke('sync_firewall_commands')
      },
      onPeers: (fn) => { listen('sync:peers', (e) => fn(e.payload)); },
      onReceiving: (fn) => { listen('sync:receiving', (e) => fn(e.payload)); },
      onIncoming: (fn) => { listen('sync:incoming', (e) => fn(e.payload)); },
      onSendProgress: (fn) => { listen('sync:sendProgress', (e) => fn(e.payload)); },
      answer: (ticket, outcome) => invoke('sync_answer', { ticket, outcome })
    },

    claimLease: () => invoke('window_claim_lease'),
    getLeaseState: () => invoke('window_get_lease_state'),
    onLeaseChanged: (cb) => { listen('lease:state', (e) => cb(e.payload)); },
    onBoardExternalUpdate: (cb) => { listen('board:externalUpdate', (e) => cb(e.payload)); },
    onOpenBoardById: (cb) => { listen('board:openById', (e) => cb(e.payload)); },
    onMenu: (cb) => { listen('app:menu', (e) => cb(e.payload)); },
    onFlush: (cb) => { listen('storage:flush', (e) => cb(e.payload)); },

    clipboardRead: () => invoke('clipboard_read'),
    clipboardWrite: async (payload) => {
      const res = await invoke('clipboard_write', { payload });
      if (res && typeof res.signature === 'string') {
        cachedClipboardSig = res.signature;
      } else {
        await refreshClipboardSignature();
      }
      return !!(res && res.ok !== false);
    },
    clipboardSignature: () => cachedClipboardSig,

    importToPdf: async (filePath, opts) => {
      try {
        let arg = filePath;
        const mergedOpts = { ...(opts || {}) };
        if (mergedOpts.bytes) {
          arg = toByteArray(mergedOpts.bytes);
          if (!mergedOpts.name && typeof filePath === 'string') {
            mergedOpts.name = filePath.split(/[\\/]/).pop();
          }
          delete mergedOpts.bytes;
        } else if (typeof filePath === 'string' && filePath.startsWith('virt://')) {
          const buf = await readFileHelper(filePath);
          const name = filePath.split(/[\\/]/).pop() || 'document.pdf';
          if (/\.pdf$/i.test(name)) {
            const data = new Uint8Array(buf);
            return { ok: true, data, engine: 'native', byteLength: data.byteLength, name };
          }
          arg = Array.from(new Uint8Array(buf));
          mergedOpts.name = name;
        }
        const bytes = await invoke('import_to_pdf', { filePath: arg, opts: mergedOpts });
        const data = new Uint8Array(bytes);
        return { ok: true, data, engine: 'native', byteLength: data.byteLength };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    },
    importTakesBytes: true,
    exportPdf: async (payload) => {
      try {
        const bytes = await invoke('export_pdf', { payload });
        const data = new Uint8Array(bytes);
        return { ok: true, data, engine: 'native', byteLength: data.byteLength };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    },

    openReleases: (url) => invoke('shell_open_external', { url }),
    checkForUpdate: () => invoke('updates_check'),
    updates: {
      mode: () => invoke('updates_mode'),
      download: (version) => invoke('updates_download', { version }),
      install: (opts) => invoke('updates_install', { opts: opts || {} }),
      note: () => invoke('updates_note'),
      onProgress: (cb) => { listen('updates:progress', (e) => cb(e.payload)); }
    },

    setLanguage: (code) => invoke('app_set_language', { code }),
    startupStep: (text) => invoke('app_startup_step', { text }),
    startupDone: (info) => invoke('app_startup_done', { info: info || {} }),

    archive: {
      exportBundle: (sourceDir, destZipPath, useZstd) =>
        invoke('bundle_export', { sourceDir, destZipPath, useZstd: !!useZstd }),
      importBundle: (archivePath, targetDir) =>
        invoke('bundle_import', { archivePath, targetDir })
    },

    audioInspect: {
      inspect: (filePath) => invoke('audio_inspect', { filePath })
    },

    geometry: {
      fitStroke: (points, epsilon) =>
        invoke('stroke_simplify_and_fit', { points, epsilon: typeof epsilon === 'number' ? epsilon : null })
    },

    search: {
      indexBoard: (boardId, title, content, tags) =>
        invoke('search_index_board', { boardId, title, content, tags: tags || null }),
      deleteBoard: (boardId) =>
        invoke('search_delete_board', { boardId }),
      query: (query, limit) =>
        invoke('search_boards', { query, limit: typeof limit === 'number' ? limit : null }),
      recordLinks: (boardId, boardTitle, links) =>
        invoke('graph_record_links', { boardId, boardTitle, links: Array.isArray(links) ? links : [] }),
      getBacklinks: (boardId) =>
        invoke('graph_get_backlinks', { boardId }),
      upsertCard: (cardId, boardId, prompt, dueTimestamp) =>
        invoke('study_card_upsert', { cardId, boardId, prompt, dueTimestamp: Number(dueTimestamp) }),
      getDueCards: (nowTimestamp, limit) =>
        invoke('study_cards_due', { nowTimestamp: Number(nowTimestamp), limit: typeof limit === 'number' ? limit : null }),
      indexPdf: (boardId, title, filePath, tags) =>
        invoke('search_index_pdf', { boardId, title, filePath, tags: tags || null }),
      extractPdfText: (filePath) =>
        invoke('pdf_extract_full_text', { filePath }),
      searchAudioToInk: (query, limit) =>
        invoke('search_audio_to_ink', { query, limit: typeof limit === 'number' ? limit : null }),
      recordStrokeTiming: (boardId, sessionId, strokes) =>
        invoke('record_stroke_temporal_map', { boardId, sessionId, strokes: Array.isArray(strokes) ? strokes : [] }),
      indexAudioTranscript: (boardId, sessionId, tokens) =>
        invoke('index_audio_transcript', { boardId, sessionId, tokens: Array.isArray(tokens) ? tokens : [] })
    },

    export: {
      exportHighResPng: (outputPath, fullWidth, fullHeight, scale, strokes) =>
        invoke('export_board_high_res_png', { outputPath, fullWidth, fullHeight, scale, strokes })
    },

    window: {
      applyMica: (darkMode) =>
        invoke('apply_window_mica', { darkMode: darkMode !== false })
    },

    colorimetry: {
      wcagContrast: (foregroundHex, backgroundHex) =>
        invoke('color_wcag_contrast', { foregroundHex, backgroundHex }),
      oklchMix: (colorAHex, colorBHex, factor) =>
        invoke('color_oklch_mix', { colorAHex, colorBHex, factor: Number(factor) }),
      invertThemeInk: (colorHex, targetBgHex, isDarkTarget) =>
        invoke('color_invert_theme_ink', { colorHex, targetBgHex, isDarkTarget: !!isDarkTarget })
    },

    markdown: {
      renderToHtml: (markdown) =>
        invoke('markdown_to_html', { markdown })
    },

    power: {
      getStatus: () => invoke('get_power_status')
    },

    // Desktop menu labels catalog (retained for 7-locale i18n parity across native host menus)
    menuLabels: (t) => [
      t('File'),
      t('Insert document (Word / PowerPoint / PDF)…'),
      t('Insert answer cover'),
      t('Insert link to a board…'),
      t('Close window'),
      t('Quit'),
      t('Edit'),
      t('View'),
      t('Format background…'),
      t('Toggle ruler'),
      t('Full screen'),
      t('Maximise window'),
      t('Developer tools'),
      t('Help')
    ]
  };
})();
