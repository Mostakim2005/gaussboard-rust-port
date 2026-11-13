// Shared pure-JS fallbacks for native Rust Tauri commands when running in Web PWA or Android WebView.
// Preserves TRAP 2 (point timestamp p.t preservation) and mirrors the window.board IPC surface.

const SEARCH_STORE_KEY = 'gazboard.fallback.search.v1';

function loadSearchDb() {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(SEARCH_STORE_KEY) : null;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {}
  return { boards: {}, links: {}, cards: {}, pdfs: {}, temporal: {}, transcripts: {} };
}

function saveSearchDb(db) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SEARCH_STORE_KEY, JSON.stringify(db));
  } catch {}
}

function rdpKeepMask(points, epsilon) {
  const n = points.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  if (n <= 2) return keep;
  const epsSq = epsilon * epsilon;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    if (end - start <= 1) continue;
    const ax = points[start].x, ay = points[start].y;
    const bx = points[end].x, by = points[end].y;
    const abx = bx - ax, aby = by - ay;
    const abLenSq = abx * abx + aby * aby;
    let maxDistSq = 0, maxIdx = start;
    for (let i = start + 1; i < end; i++) {
      const px = points[i].x, py = points[i].y;
      let dSq;
      if (abLenSq < 1e-12) {
        dSq = (px - ax) * (px - ax) + (py - ay) * (py - ay);
      } else {
        const proj = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / abLenSq));
        const dx = px - (ax + abx * proj);
        const dy = py - (ay + aby * proj);
        dSq = dx * dx + dy * dy;
      }
      if (dSq > maxDistSq) { maxDistSq = dSq; maxIdx = i; }
    }
    const timeGap = (Number(points[end].t) || 0) - (Number(points[start].t) || 0);
    if (maxDistSq > epsSq || (timeGap > 80 && end - start > 4)) {
      const split = maxIdx > start ? maxIdx : ((start + end) >> 1);
      keep[split] = 1;
      stack.push([start, split], [split, end]);
    }
  }
  return keep;
}

/** Fit C1 cubic Bezier segments while preserving hardware timestamps p.t (TRAP 2). */
export function fallbackFitStroke(points = [], epsilon = 0.8) {
  if (!Array.isArray(points) || points.length < 2) {
    return { segments: [], bounds: [0, 0, 0, 0], total_arc_length: 0, original_count: Array.isArray(points) ? points.length : 0, simplified_count: Array.isArray(points) ? points.length : 0 };
  }
  const eps = typeof epsilon === 'number' && epsilon >= 0 ? epsilon : 0.8;
  const keep = rdpKeepMask(points, eps);
  const kept = points.filter((_, idx) => keep[idx]);
  const segments = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, totalLen = 0;

  for (let i = 0; i < kept.length; i++) {
    const pt = kept[i];
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }

  for (let i = 0; i < kept.length - 1; i++) {
    const a = kept[i], b = kept[i + 1];
    const prev = kept[Math.max(0, i - 1)];
    const next = kept[Math.min(kept.length - 1, i + 2)];
    const p1x = a.x + (b.x - prev.x) / 6;
    const p1y = a.y + (b.y - prev.y) / 6;
    const p2x = b.x - (next.x - a.x) / 6;
    const p2y = b.y - (next.y - a.y) / 6;
    totalLen += Math.hypot(b.x - a.x, b.y - a.y);
    segments.push({
      p0: [a.x, a.y],
      p1: [p1x, p1y],
      p2: [p2x, p2y],
      p3: [b.x, b.y],
      t_start: Number(a.t) || 0,
      t_end: Number(b.t) || 0
    });
  }

  return {
    segments,
    bounds: [minX, minY, maxX, maxY],
    total_arc_length: totalLen,
    original_count: points.length,
    simplified_count: kept.length
  };
}

function parseHexRgb(hex) {
  let clean = String(hex || '#000000').trim().replace(/^#/, '');
  if (clean.length === 3) clean = clean.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return [0, 0, 0];
  return [
    parseInt(clean.slice(0, 2), 16) / 255,
    parseInt(clean.slice(2, 4), 16) / 255,
    parseInt(clean.slice(4, 6), 16) / 255
  ];
}

function toHexRgb(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function linearizeChannel(u) {
  return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
}

function relLuminance([r, g, b]) {
  return 0.2126 * linearizeChannel(r) + 0.7152 * linearizeChannel(g) + 0.0722 * linearizeChannel(b);
}

function contrastRatio(rgbA, rgbB) {
  const l1 = relLuminance(rgbA);
  const l2 = relLuminance(rgbB);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Create pure-JS fallbacks for Rust Tauri subsystems so Web & Android stay 100% parity-safe.
 * @returns {object}
 */
export function createNativeFallbacks() {
  const db = loadSearchDb();

  return {
    archive: {
      exportBundle: async () => ({ archive_path: '', total_bytes: 0, sha256: '', unsupported: true }),
      importBundle: async () => ({ extracted_dir: '', files_count: 0, sha256: '', unsupported: true })
    },

    audioInspect: {
      inspect: async (filePath) => ({
        duration_ms: null,
        sample_rate: 48000,
        channels: 1,
        codec: 'webm',
        is_finite: false,
        source: String(filePath || '')
      })
    },

    geometry: {
      fitStroke: async (points, epsilon) => fallbackFitStroke(points, epsilon),
      binaryFitStroke: async (points, epsilon) => fallbackFitStroke(points, epsilon)
    },

    search: {
      indexBoard: async (boardId, title, content, tags) => {
        if (!boardId) return false;
        db.boards[String(boardId)] = { board_id: String(boardId), title: String(title || ''), content: String(content || ''), tags: Array.isArray(tags) ? tags : [] };
        saveSearchDb(db);
        return true;
      },
      deleteBoard: async (boardId) => {
        delete db.boards[String(boardId)];
        delete db.links[String(boardId)];
        saveSearchDb(db);
        return true;
      },
      query: async (query, limit = 25) => {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return [];
        const hits = [];
        for (const rec of Object.values(db.boards)) {
          const hay = `${rec.title} ${rec.content} ${(rec.tags || []).join(' ')}`.toLowerCase();
          const idx = hay.indexOf(q);
          if (idx === -1) continue;
          const start = Math.max(0, idx - 24);
          const snippet = `${rec.title} — ${rec.content}`.slice(start, start + 96);
          hits.push({ board_id: rec.board_id, title: rec.title, snippet, rank: -(100 / (1 + idx)) });
        }
        hits.sort((a, b) => a.rank - b.rank);
        return hits.slice(0, typeof limit === 'number' ? limit : 25);
      },
      recordLinks: async (boardId, boardTitle, links) => {
        db.links[String(boardId)] = { board_title: String(boardTitle || ''), targets: Array.isArray(links) ? links.map(String) : [] };
        saveSearchDb(db);
        return true;
      },
      getBacklinks: async (boardId) => {
        const out = [];
        const target = String(boardId);
        for (const [srcId, entry] of Object.entries(db.links)) {
          if (srcId === target || !Array.isArray(entry.targets)) continue;
          if (entry.targets.some((t) => t === target || t.endsWith(`#${target}`))) {
            out.push({ source_board_id: srcId, source_title: entry.board_title || srcId, edge_type: 'wikilink' });
          }
        }
        return out;
      },
      upsertCard: async (cardId, boardId, prompt, dueTimestamp) => {
        db.cards[String(cardId)] = { card_id: String(cardId), board_id: String(boardId), prompt: String(prompt || ''), due_timestamp: Number(dueTimestamp) || 0 };
        saveSearchDb(db);
        return true;
      },
      getDueCards: async (nowTimestamp = Math.floor(Date.now() / 1000), limit = 50) => {
        const now = Number(nowTimestamp) || Math.floor(Date.now() / 1000);
        return Object.values(db.cards)
          .filter((c) => (c.due_timestamp || 0) <= now)
          .sort((a, b) => (a.due_timestamp || 0) - (b.due_timestamp || 0))
          .slice(0, typeof limit === 'number' ? limit : 50);
      },
      scheduleSrsCard: async (cardId, boardId, prompt, intervalDays, stability, difficulty) => {
        const due = Math.floor(Date.now() / 1000) + Math.round((Number(intervalDays) || 0) * 86400);
        db.cards[String(cardId)] = {
          card_id: String(cardId), board_id: String(boardId), prompt: String(prompt || ''),
          due_timestamp: due, stability: Number(stability) || 0, difficulty: Number(difficulty) || 0
        };
        saveSearchDb(db);
        return true;
      },
      getSrsDueCards: async () => {
        const now = Math.floor(Date.now() / 1000);
        return Object.values(db.cards)
          .filter((c) => (c.due_timestamp || 0) <= now)
          .sort((a, b) => (a.due_timestamp || 0) - (b.due_timestamp || 0))
          .slice(0, 100);
      },
      indexPdf: async (boardId, title, filePath, tags) => {
        db.pdfs[String(boardId)] = { board_id: String(boardId), title: String(title || ''), filePath: String(filePath || ''), tags: Array.isArray(tags) ? tags : [] };
        saveSearchDb(db);
        return { board_id: String(boardId), title: String(title || ''), total_pages: 0, indexed_pages: 0, total_chars: 0 };
      },
      extractPdfText: async () => '',
      recordStrokeTiming: async (boardId, sessionId, strokes) => {
        const arr = Array.isArray(strokes) ? strokes : [];
        db.temporal[`${boardId}:${sessionId}`] = arr;
        saveSearchDb(db);
        return arr.length;
      },
      indexAudioTranscript: async (boardId, sessionId, tokens) => {
        const arr = Array.isArray(tokens) ? tokens : [];
        db.transcripts[`${boardId}:${sessionId}`] = arr;
        saveSearchDb(db);
        return arr.length;
      },
      searchAudioToInk: async (query, limit = 20) => {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return [];
        const out = [];
        for (const [key, tokens] of Object.entries(db.transcripts)) {
          const [board_id, session_id] = key.split(':');
          const strokes = db.temporal[key] || [];
          for (const tok of tokens) {
            if (!String(tok.word || '').toLowerCase().includes(q)) continue;
            const ms = Number(tok.start_ms) || 0;
            const match = strokes.find((s) => ms >= (Number(s.t_start_ms) || 0) - 500 && ms <= (Number(s.t_end_ms) || 0) + 500) || strokes[0];
            out.push({
              board_id, session_id, matched_word: tok.word, audio_seek_ms: ms,
              stroke_id: match?.stroke_id || '', camera_center_x: match?.center_x || 0,
              camera_center_y: match?.center_y || 0, bbox_width: match?.bbox_width || 120, bbox_height: match?.bbox_height || 60
            });
          }
        }
        return out.slice(0, typeof limit === 'number' ? limit : 20);
      }
    },

    export: {
      exportHighResPng: async () => false
    },

    window: {
      applyMica: async () => false
    },

    colorimetry: {
      wcagContrast: async (foregroundHex, backgroundHex) => {
        const ratio = contrastRatio(parseHexRgb(foregroundHex), parseHexRgb(backgroundHex));
        return {
          ratio,
          wcag_aa_normal: ratio >= 4.5,
          wcag_aa_large: ratio >= 3.0,
          wcag_aaa_normal: ratio >= 7.0,
          wcag_aaa_large: ratio >= 4.5,
          wcag_graphics: ratio >= 3.0
        };
      },
      oklchMix: async (colorAHex, colorBHex, factor = 0.5) => {
        const t = Math.max(0, Math.min(1, Number(factor) || 0));
        const a = parseHexRgb(colorAHex), b = parseHexRgb(colorBHex);
        return toHexRgb(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
      },
      invertThemeInk: async (colorHex, targetBgHex, isDarkTarget = true) => {
        const ink = parseHexRgb(colorHex), bg = parseHexRgb(targetBgHex);
        if (contrastRatio(ink, bg) >= 4.5) return colorHex;
        const lum = Math.max(0.05, 1 - relLuminance(ink));
        const adj = isDarkTarget ? Math.max(0.75, lum) : Math.min(0.25, 1 - lum);
        return toHexRgb(
          Math.max(0, Math.min(1, 0.5 + (adj - 0.5) * 0.9 + (ink[0] - ink[1]) * 0.3)),
          Math.max(0, Math.min(1, 0.5 + (adj - 0.5) * 0.9)),
          Math.max(0, Math.min(1, 0.5 + (adj - 0.5) * 0.9 + (ink[2] - ink[1]) * 0.3))
        );
      }
    },

    markdown: {
      renderToHtml: async (markdown) => `<div class="md-fallback"><p>${escapeHtml(markdown).replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>')}</p></div>`
    },

    power: {
      getStatus: async () => {
        try {
          if (typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function') {
            const bat = await navigator.getBattery();
            return {
              on_battery: !bat.charging,
              battery_percent: Number.isFinite(bat.level) ? Math.round(bat.level * 100) : null,
              power_saver: !bat.charging && Number.isFinite(bat.level) && bat.level <= 0.2
            };
          }
        } catch {}
        return { on_battery: false, battery_percent: null, power_saver: false };
      }
    }
  };
}

/** Merge fallback namespaces onto a Web or Android adapter without clobbering native overrides. */
export function attachNativeFallbacks(target) {
  if (!target || typeof target !== 'object') return target;
  const fb = createNativeFallbacks();
  for (const [k, v] of Object.entries(fb)) {
    if (!target[k]) target[k] = v;
    else if (v && typeof v === 'object') {
      for (const [subK, subV] of Object.entries(v)) {
        if (target[k][subK] === undefined) target[k][subK] = subV;
      }
    }
  }
  if (!target.bundle && target.archive) target.bundle = target.archive;
  return target;
}
