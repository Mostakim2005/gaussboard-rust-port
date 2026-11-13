/**
 * GazBoard v4.8.13 — Pure-JS Obsidian Markdown, Embeds, Hashtags & Wikilinks Engine
 * Zero native dependencies. Produces strict XHTML for SVG <foreignObject>
 * Canvas2D caching and interactive Live Preview DOM overlays.
 */

import { ensureKatexLoaded } from './maths.js';

/*
 * Link/wikilink tokenizers use BOUNDED quantifiers.
 *
 * The previous unbounded `[^\]]+` style runs are quadratic on text with many
 * unmatched openers: a 100 KB note made only of "[" took 23 seconds of
 * main-thread work because every "[" rescanned to the end of the string
 * looking for a "]" that never comes. Real labels and URLs are short, so the
 * caps cost nothing, and excluding "[" from the URL keeps a run of brackets
 * from being rescanned. The closing delimiters are also checked once before
 * each pass (see renderInlineMarkdown).
 */
export const EMBED_WIKILINK_RE = /!\[\[([^\]\[|#\n]{0,512})(?:#([^\]|\n]{1,512}))?(?:\|([^\]\n]{1,512}))?\]\]/g;
export const WIKILINK_RE = /(?<!!)\[\[([^\]\[|#\n]{0,512})(?:#([^\]|\n]{1,512}))?(?:\|([^\]\n]{1,512}))?\]\]/g;
export const EMBED_BOARDREF_RE = /@!\[([^\]\n]{1,512})\]\(b:([a-zA-Z0-9_-]{1,128})(?:#([^\)\n]{1,200}))?\)/g;
export const BOARDREF_RE = /@\[([^\]\n]{1,512})\]\(b:([a-zA-Z0-9_-]{1,128})(?:#([^\)\n]{1,200}))?\)/g;
export const CALLOUT_HEADER_RE = /^\[!([A-Za-z]+)\]([+-])?\s*(.*)$/;
export const TASK_LINE_RE = /^([ \t]*)[-*+]\s+\[([ xX])\]\s+(.*)$/;
export const DISPLAY_MATH_RE = /\$\$([\s\S]+?)\$\$/g;
export const INLINE_MATH_RE = /(?:^|(?<=[^\$\\\w]))\$([^\s\$\n](?:[^\$\n]*?[^\s\$\n])?)\$(?=[^\$\w\d]|$)/g;
export const HASHTAG_RE = /(?:^|(?<=[\s(\[{"']))#([a-zA-Z][a-zA-Z0-9_\-/]*)/g;
export const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export const CALLOUT_TYPES = new Set([
  'note', 'tip', 'warning', 'danger', 'info', 'success',
  'question', 'bug', 'example', 'quote', 'abstract', 'todo'
]);

const CALLOUT_ICONS = {
  note: '📝',
  tip: '💡',
  warning: '⚠️',
  danger: '⚡',
  info: 'ℹ️',
  success: '✅',
  question: '❓',
  bug: '🐛',
  example: '📋',
  quote: '💬',
  abstract: '📄',
  todo: '☑️'
};

const MD_HEURISTIC_RE = /(?:^|\n)\s*(?:#{1,6}\s+|>{1}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+|\|.+\||`{3,}|~{3,})|^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)|(?:\*\*[^*]+\*\*|\*[^*\n]+\*|~~[^~]+~~|(?<!~)~(?!~)[^~\n]+(?<!~)~(?!~)|\^[^^\n]+\^|==[^=\n]+==|`[^`\n]+`|<u>[\s\S]+?<\/u>|\$\$[\s\S]+?\$\$|(?<=[^\$\\\w])\$[^\s\$\n](?:[^\$\n]*?[^\s\$\n])?\$|!?\[\[[^\]]+\]\]|\[\^[^\]]+\]|%%[\s\S]*?%%|@!?\[[^\]]+\]\(b:|(?:^|[\s(\[{"'])#[a-zA-Z][a-zA-Z0-9_\-/]*)/;

/** Remove Obsidian comments while preserving line numbers and fenced code. */
export function stripObsidianComments(markdownText) {
  const lines = String(markdownText ?? '').replace(/\r\n?/g, '\n').split('\n');
  let fence = null, inComment = false;
  return lines.map((line) => {
    const fenceLine = line.match(/^\s*(`{3,}|~{3,})/);
    if (!inComment && fenceLine) {
      const mark = fenceLine[1];
      if (!fence) fence = { char: mark[0], length: mark.length };
      else if (mark[0] === fence.char && mark.length >= fence.length) fence = null;
      return line;
    }
    if (fence) return line;
    let out = '';
    let inlineTicks = 0;
    for (let i = 0; i < line.length; i++) {
      if (!inComment && line[i] === '`') {
        let end = i + 1;
        while (line[end] === '`') end++;
        const count = end - i;
        inlineTicks = inlineTicks === count ? 0 : (inlineTicks ? inlineTicks : count);
        out += line.slice(i, end); i = end - 1; continue;
      }
      if (!inlineTicks && line.slice(i, i + 2) === '%%') {
        inComment = !inComment; i++; continue;
      }
      out += inComment ? ' ' : line[i];
    }
    return out;
  }).join('\n');
}

export function extractFootnotes(markdownText) {
  const lines = String(markdownText ?? '').split('\n');
  const definitions = new Map();
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const fenceLine = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (fenceLine) {
      const mark = fenceLine[1];
      if (!fence) fence = { char: mark[0], length: mark.length };
      else if (mark[0] === fence.char && mark.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const def = lines[i].match(/^\[\^([^\]\s]+)\]:\s*(.*)$/);
    if (!def) continue;
    const content = [def[2]];
    lines[i] = '';
    let j = i + 1;
    while (j < lines.length && (/^(?: {2,}|\t)\S/.test(lines[j]) || /^\s*$/.test(lines[j]))) {
      if (lines[j].trim()) content.push(lines[j].trim());
      lines[j] = '';
      j++;
    }
    definitions.set(def[1], content.join('\n').trim());
    i = j - 1;
  }
  const body = lines.join('\n');
  const scan = body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const numbers = new Map();
  const re = /\[\^([^\]\s]+)\]/g;
  let match;
  while ((match = re.exec(scan))) if (definitions.has(match[1]) && !numbers.has(match[1])) numbers.set(match[1], numbers.size + 1);
  return { body, definitions, numbers };
}

function footnoteId(id) {
  return String(id).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'note';
}

function parseFrontmatterScalar(raw) {
  const value = String(raw || '').trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    const items = [];
    let part = '', quote = '', escaped = false;
    for (const char of value.slice(1, -1)) {
      if (escaped) { part += char; escaped = false; continue; }
      if (char === '\\' && quote === '"') { part += char; escaped = true; continue; }
      if ((char === '"' || char === "'") && (!quote || quote === char)) { quote = quote ? '' : char; part += char; continue; }
      if (char === ',' && !quote) { if (part.trim()) items.push(parseFrontmatterScalar(part)); part = ''; continue; }
      part += char;
    }
    if (part.trim()) items.push(parseFrontmatterScalar(part));
    return items;
  }
  if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
    const inner = value.slice(1, -1);
    if (value[0] === '"') {
      try { return JSON.parse(value); } catch { return inner.replace(/\\(["\\])/g, '$1'); }
    }
    return inner.replace(/''/g, "'");
  }
  return value;
}

/**
 * Parses Obsidian YAML frontmatter from the beginning of a document.
 * @param {string} markdownText
 * @returns {{ attributes: Record<string, any>, body: string }}
 */
export function parseFrontmatter(markdownText) {
  if (!markdownText || typeof markdownText !== 'string') return { attributes: {}, body: markdownText || '' };
  const match = markdownText.match(FRONTMATTER_RE);
  if (!match) return { attributes: {}, body: markdownText };

  const rawYaml = match[1];
  const body = markdownText.slice(match[0].length);
  const attributes = {};

  let listKey = null;
  for (const line of rawYaml.split(/\r?\n/)) {
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listKey && listItem) {
      attributes[listKey].push(parseFrontmatterScalar(listItem[1]));
      continue;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { listKey = null; continue; }
    const key = line.slice(0, colonIdx).trim();
    if (!key) { listKey = null; continue; }
    const rawValue = line.slice(colonIdx + 1).trim();
    if (!rawValue) {
      attributes[key] = [];
      listKey = key;
    } else {
      attributes[key] = parseFrontmatterScalar(rawValue);
      listKey = null;
    }
  }
  return { attributes, body };
}

/**
 * Fast check to determine if a text string contains Markdown or Obsidian syntax.
 * @param {string} text
 * @returns {boolean}
 */
export function isMarkdown(text) {
  if (!text || typeof text !== 'string') return false;
  return MD_HEURISTIC_RE.test(text);
}

/**
 * Escapes text for strict XML / XHTML compliance inside SVG <foreignObject>.
 * @param {string} str
 * @returns {string}
 */
export function escapeXhtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Extracts all `#hashtag` tokens from a Markdown string (ignoring fenced code blocks
 * and inline code spans) and returns their frequency counts.
 *
 * @param {string} markdownText
 * @returns {Record<string, number>}
 */
export function countTags(markdownText) {
  const counts = {};
  if (!markdownText || typeof markdownText !== 'string') return counts;

  const { attributes, body } = parseFrontmatter(markdownText);
  if (Array.isArray(attributes.tags)) {
    for (const tg of attributes.tags) {
      const clean = tg.startsWith('#') ? tg.slice(1) : tg;
      counts[clean] = (counts[clean] || 0) + 1;
    }
  } else if (typeof attributes.tags === 'string') {
    const clean = attributes.tags.startsWith('#') ? attributes.tags.slice(1) : attributes.tags;
    counts[clean] = (counts[clean] || 0) + 1;
  }

  // Strip fenced code blocks and inline code before scanning for tags
  const cleaned = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]+`/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]+\$/g, ' ');

  HASHTAG_RE.lastIndex = 0;
  let m;
  while ((m = HASHTAG_RE.exec(cleaned))) {
    const tag = m[1];
    counts[tag] = (counts[tag] || 0) + 1;
  }
  return counts;
}

/**
 * Extracts unique `#hashtag` strings from Markdown text, ordered by frequency.
 * @param {string} markdownText
 * @returns {string[]}
 */
export function extractTags(markdownText) {
  const counts = countTags(markdownText);
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
}

/**
 * Renders TeX math via bundled offline KaTeX if available, or clean XHTML fallback.
 * @param {string} tex
 * @param {boolean} displayMode
 * @returns {string}
 */
export function renderMathToXhtml(tex, displayMode = false) {
  const raw = String(tex || '').trim();
  const katexObj = typeof globalThis !== 'undefined' ? globalThis.katex : null;
  if (katexObj && typeof katexObj.renderToString === 'function') {
    try {
      const html = katexObj.renderToString(raw, {
        displayMode,
        throwOnError: false,
        errorColor: '#f43f5e',
        strict: false,
        output: 'htmlAndMathml'
      });
      return html.replace(/<(img|br|hr|input|col|area|base|link|meta|param|source|track|wbr)([^>]*?)(?<!\/)>/gi, '<$1$2 />');
    } catch (err) {
      console.warn('KaTeX parsing error caught:', err);
      // Fall through to safe fallback
    }
  }
  const tag = displayMode ? 'div' : 'span';
  const cls = displayMode ? 'gb-math-block' : 'gb-math-inline';
  // KaTeX is loaded on first use. Markdown cards are often what first needs it
  // (there may be no maths box on the board), so ask for it here; when it
  // arrives the board repaints and the renderer's cache key changes, replacing
  // these fallback spans with typeset maths.
  ensureKatexLoaded();
  return `<${tag} class="${cls}" data-tex="${escapeXhtml(raw)}">${escapeXhtml(raw)}</${tag}>`;
}

/**
 * Renders an embedded board transclusion block (`![[Board#Page|Alias]]` or `@![Label](b:id#page)`).
 */
function renderEmbedCardXhtml({ boardId = '', target = '', page = '', heading = '', label = '' }) {
  const displayLabel = label || (page ? `${target} › Page ${page}` : heading ? `${target} › ${heading}` : target);
  const pageBadge = page ? `<span class="gb-embed-page">P${escapeXhtml(page)}</span>` : heading ? `<span class="gb-embed-page">§ ${escapeXhtml(heading)}</span>` : '';
  const dataId = boardId ? ` data-board-id="${escapeXhtml(boardId)}"` : '';
  const dataPage = page ? ` data-page="${escapeXhtml(page)}"` : '';
  const dataHeading = heading ? ` data-anchor="${escapeXhtml(heading)}"` : '';
  const dataTarget = target ? ` data-wikilink="${escapeXhtml(target)}"` : '';
  return (
    `<span class="gb-embed-card" data-embed="true"${dataId}${dataPage}${dataHeading}${dataTarget}>` +
      `<span class="gb-embed-icon">⊞</span>` +
      `<span class="gb-embed-title">${escapeXhtml(displayLabel)}</span>` +
      pageBadge +
    `</span>`
  );
}

/**
 * Parses inline Markdown tokens into strict XHTML.
 *
 * @param {string} text
 * @param {Object} [options]
 * @param {(title: string, page?: string, alias?: string, embed?: boolean) => {id?: string, href?: string, label: string}} [options.resolveWikilink]
 * @returns {string}
 */
export function renderInlineMarkdown(text, options = {}) {
  if (!text) return '';

  const placeholders = [];
  const stash = (xhtml) => {
    const token = `\u0000GBPH_${placeholders.length}_\u0000`;
    placeholders.push(xhtml);
    return token;
  };

  let src = String(text);

  // 1. Inline code spans: `code`
  src = src.replace(/`([^`\n]+)`/g, (_, code) =>
    stash(`<code class="gb-inline-code">${escapeXhtml(code)}</code>`)
  );
  src = src.replace(/(^|\s)\^([A-Za-z0-9-]{2,})\s*$/g, (_, prefix, id) =>
    stash(`${escapeXhtml(prefix)}<span class="gb-md-block-id" data-block-id="${escapeXhtml(id)}"></span>`)
  );

  // Obsidian footnotes and comments/formatting extensions. Code has already
  // been stashed so marker-looking text inside it remains literal.
  src = src.replace(/\[\^([^\]\s]+)\]/g, (whole, id) => {
    const number = options.footnoteNumbers?.get(id);
    return number
      ? stash(`<sup class="gb-md-footnote-ref"><a href="#gb-footnote-${footnoteId(id)}">${number}</a></sup>`)
      : whole;
  });
  src = src.replace(/==([^=\n]+)==/g, (_, value) => stash(`<mark class="gb-md-highlight">${renderInlineMarkdown(value, options)}</mark>`));
  src = src.replace(/(?<!~)~(?!~)([^~\n]+)(?<!~)~(?!~)/g, (_, value) => stash(`<sub>${renderInlineMarkdown(value, options)}</sub>`));
  src = src.replace(/(?<!\^)\^([^\^\n]+)\^(?!\^)/g, (_, value) => stash(`<sup>${renderInlineMarkdown(value, options)}</sup>`));

  // 2. Display math appearing inline & Inline math: $$...$$ and $...$
  src = src.replace(DISPLAY_MATH_RE, (_, tex) =>
    stash(renderMathToXhtml(tex, true))
  );
  src = src.replace(INLINE_MATH_RE, (_, tex) =>
    stash(renderMathToXhtml(tex, false))
  );

  // 3a. Native GazBoard Embed tokens: @![Label](b:boardId#page)
  const hasBoardRef = src.includes('](b:');
  if (hasBoardRef) src = src.replace(EMBED_BOARDREF_RE, (_, label, boardId, rawAnchor) => {
    const page = rawAnchor && /^\d+$/.test(rawAnchor) ? rawAnchor : '';
    const heading = rawAnchor && !page ? rawAnchor.replace(/^h:/, '') : '';
    return stash(renderEmbedCardXhtml({ boardId, target: label, page, heading, label }));
  });

  // 3b. Obsidian Embed Wikilinks: ![[Board Name#Page|Alias]]
  const hasWikilink = src.includes(']]');
  if (hasWikilink) src = src.replace(EMBED_WIKILINK_RE, (_, rawTarget, rawAnchor, rawAlias) => {
    const target = rawTarget.trim();
    const anchor = rawAnchor ? rawAnchor.trim() : '';
    const alias = rawAlias ? rawAlias.trim() : '';

    if (typeof options.resolveWikilink === 'function') {
      const resolved = options.resolveWikilink(target, anchor, alias, true);
      if (resolved) {
        return stash(
          renderEmbedCardXhtml({
            boardId: resolved.id || '',
            target,
            page: /^\d+$/.test(anchor) ? anchor : '',
            heading: anchor && !/^\d+$/.test(anchor) ? anchor.replace(/^h:/, '') : '',
            label: alias || resolved.label || target
          })
        );
      }
    }
    const defaultLabel = alias || (anchor ? `${target} › ${anchor}` : target);
    return stash(renderEmbedCardXhtml({ target, page: anchor, label: defaultLabel }));
  });

  // 3c. Native GazBoard link tokens: @[Label](b:boardId#page)
  if (hasBoardRef) src = src.replace(BOARDREF_RE, (_, label, boardId, page) => {
    const isPage = page && /^\d+$/.test(page);
    const pageSuffix = page ? `#${escapeXhtml(page)}` : '';
    const dataPage = isPage ? ` data-page="${escapeXhtml(page)}"` : '';
    const dataAnchor = page && !isPage ? ` data-anchor="${escapeXhtml(page.replace(/^h:/, ''))}"` : '';
    return stash(
      `<a class="gb-wikilink" href="b:${escapeXhtml(boardId)}${pageSuffix}" data-board-id="${escapeXhtml(boardId)}"${dataPage}${dataAnchor}>${escapeXhtml(label)}</a>`
    );
  });

  // 3d. Obsidian Wikilinks: [[Board Name#Page|Alias]]
  if (hasWikilink) src = src.replace(WIKILINK_RE, (_, rawTarget, rawAnchor, rawAlias) => {
    const target = rawTarget.trim();
    const anchor = rawAnchor ? rawAnchor.trim() : '';
    const alias = rawAlias ? rawAlias.trim() : '';

    if (typeof options.resolveWikilink === 'function') {
      const resolved = options.resolveWikilink(target, anchor, alias, false);
      if (resolved) {
        const boardAttr = resolved.id ? ` data-board-id="${escapeXhtml(resolved.id)}"` : '';
        const anchorAttr = anchor ? ` data-anchor="${escapeXhtml(anchor)}"` : '';
        return stash(
          `<a class="gb-wikilink" href="${escapeXhtml(resolved.href || '#')}" data-wikilink="${escapeXhtml(target)}"${boardAttr}${anchorAttr}>${escapeXhtml(resolved.label)}</a>`
        );
      }
    }

    const defaultLabel = alias || (anchor ? `${target} > ${anchor}` : target);
    const href = `b:${target}${anchor ? '#' + anchor : ''}`;
    const anchorAttr = anchor ? ` data-anchor="${escapeXhtml(anchor)}"` : '';
    return stash(
      `<a class="gb-wikilink" href="${escapeXhtml(href)}" data-wikilink="${escapeXhtml(target)}"${anchorAttr}>${escapeXhtml(defaultLabel)}</a>`
    );
  });

  // 4. Standard links [label](url) including obsidian:// URIs
  //    Bounded label/URL and "[" excluded from the URL: see the tokenizer note
  //    at the top of this file. The pass is skipped outright when the text
  //    cannot contain a link at all.
  if (src.includes('](') && src.includes(')')) src = src.replace(/\[([^\]\n]{1,512})\]\(([^)\s\[]{1,2048})\)/g, (_, label, url) => {
    const trimmedUrl = url.trim();
    const isSafeProtocol = /^(https?:\/\/|obsidian:\/\/|mailto:|b:|#|\/)/i.test(trimmedUrl);
    const safeHref = isSafeProtocol ? escapeXhtml(trimmedUrl) : '#';
    const isObsidianUri = /^obsidian:\/\//i.test(trimmedUrl);
    const cls = isObsidianUri ? 'gb-obsidian-uri' : 'gb-ext-link';
    return stash(
      `<a class="${cls}" href="${safeHref}">${renderInlineMarkdown(label, options)}</a>`
    );
  });

  // 5. Explicit underline tags: <u>text</u>
  src = src.replace(/<u>([\s\S]+?)<\/u>/gi, (_, inner) =>
    stash(`<u>${renderInlineMarkdown(inner, options)}</u>`)
  );

  // 6. Hashtags: #tag
  src = src.replace(HASHTAG_RE, (_, tag) =>
    stash(`<span class="gb-hashtag" data-tag="${escapeXhtml(tag)}">#${escapeXhtml(tag)}</span>`)
  );

  // Escape any remaining raw XML characters before applying emphasis
  src = escapeXhtml(src);

  // 7. Bold + Italic (***text***)
  src = src.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold (**text**)
  src = src.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // Italic (*text*)
  src = src.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  // Strikethrough (~~text~~)
  src = src.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // Restore stashed tokens
  src = src.replace(/\u0000GBPH_(\d+)_\u0000/g, (_, idx) => placeholders[Number(idx)] ?? '');

  return src;
}

/**
 * Splits a GFM table row into cells.
 */
function splitTableCells(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

/**
 * Checks if a line is a valid GFM table delimiter row.
 */
function parseTableDelimiter(line) {
  if (!line || !line.includes('|')) return null;
  const cells = splitTableCells(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    if (cell.startsWith(':') && cell.endsWith(':')) aligns.push('center');
    else if (cell.endsWith(':')) aligns.push('right');
    else if (cell.startsWith(':')) aligns.push('left');
    else aligns.push(null);
  }
  return aligns;
}

/**
 * Minimal pure-JS syntax highlighter for fenced code blocks.
 */
function highlightCodeXhtml(code) {
  const escaped = escapeXhtml(code);
  return escaped.replace(
    /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|new|try|catch|true|false|null|undefined)\b/g,
    '<span class="gb-hl-kw">$1</span>'
  );
}

/**
 * Parses a full Markdown document into an AST with line numbers preserved.
 */
export function parseMarkdownAST(markdownText) {
  const raw = String(markdownText ?? '').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n');
  const ast = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 1. Empty line
    if (/^\s*$/.test(line)) {
      i++;
      continue;
    }

    // 2. Fenced Code Block (```lang ... ```)
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})([a-zA-Z0-9_-]*)\s*$/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = fenceMatch[2] || '';
      const startLine = i;
      i++;
      const codeLines = [];
      const closeRe = new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`);
      while (i < lines.length && !closeRe.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      ast.push({
        type: 'codeblock',
        lang,
        code: codeLines.join('\n'),
        lineStart: startLine,
        lineEnd: i - 1
      });
      continue;
    }

    // 3. Multi-line or Single-line Display Math Block ($$ ... $$)
    if (line.trim().startsWith('$$')) {
      const startLine = i;
      const singleLineMatch = line.trim().match(/^\$\$([\s\S]+?)\$\$$/);
      if (singleLineMatch) {
        ast.push({
          type: 'mathblock',
          tex: singleLineMatch[1].trim(),
          lineStart: startLine,
          lineEnd: i
        });
        i++;
        continue;
      }
      const mathLines = [line.trim().slice(2)];
      i++;
      while (i < lines.length && !lines[i].trim().endsWith('$$')) {
        mathLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        mathLines.push(lines[i].trim().slice(0, -2));
        i++;
      }
      ast.push({
        type: 'mathblock',
        tex: mathLines.join('\n').trim(),
        lineStart: startLine,
        lineEnd: i - 1
      });
      continue;
    }

    // 4. Headings (# through ######)
    const headingMatch = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      ast.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2],
        line: i
      });
      i++;
      continue;
    }

    // 5. Horizontal Rule (---, ***, ___)
    if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) {
      ast.push({ type: 'hr', line: i });
      i++;
      continue;
    }

    // 6. Blockquote or Obsidian Callout (> [!NOTE] Title ...)
    if (/^\s*>\s?/.test(line)) {
      const startLine = i;
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const firstLine = quoteLines[0] || '';
      const calloutMatch = firstLine.match(CALLOUT_HEADER_RE);
      if (calloutMatch) {
        const rawType = calloutMatch[1].toLowerCase();
        const kind = CALLOUT_TYPES.has(rawType) ? rawType : 'note';
        const fold = calloutMatch[2] || '';
        const title = calloutMatch[3] || calloutMatch[1];
        ast.push({
          type: 'callout',
          calloutType: kind,
          rawType: calloutMatch[1],
          fold,
          title,
          body: quoteLines.slice(1).join('\n'),
          lineStart: startLine,
          lineEnd: i - 1
        });
      } else {
        ast.push({
          type: 'blockquote',
          body: quoteLines.join('\n'),
          lineStart: startLine,
          lineEnd: i - 1
        });
      }
      continue;
    }

    // 7. GFM Table
    if (line.includes('|') && i + 1 < lines.length) {
      const aligns = parseTableDelimiter(lines[i + 1]);
      if (aligns) {
        const startLine = i;
        const headers = splitTableCells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
          rows.push(splitTableCells(lines[i]));
          i++;
        }
        ast.push({
          type: 'table',
          headers,
          aligns,
          rows,
          lineStart: startLine,
          lineEnd: i - 1
        });
        continue;
      }
    }

    // 8. Lists (Task Checklists, Unordered, Ordered)
    const taskMatch = line.match(TASK_LINE_RE);
    const ulMatch = !taskMatch && line.match(/^([ \t]*)[-*+]\s+(.*)$/);
    const olMatch = !taskMatch && !ulMatch && line.match(/^([ \t]*)(\d+)\.\s+(.*)$/);

    if (taskMatch || ulMatch || olMatch) {
      const startLine = i;
      const ordered = Boolean(olMatch);
      const items = [];

      while (i < lines.length) {
        const cur = lines[i];
        const tM = cur.match(TASK_LINE_RE);
        if (tM) {
          items.push({
            task: true,
            checked: tM[2].toLowerCase() === 'x',
            indent: tM[1].length,
            text: tM[3],
            line: i
          });
          i++;
          continue;
        }
        const uM = cur.match(/^([ \t]*)[-*+]\s+(.*)$/);
        if (uM && !ordered) {
          items.push({
            task: false,
            checked: false,
            indent: uM[1].length,
            text: uM[2],
            line: i
          });
          i++;
          continue;
        }
        const oM = cur.match(/^([ \t]*)(\d+)\.\s+(.*)$/);
        if (oM && ordered) {
          items.push({
            task: false,
            checked: false,
            indent: oM[1].length,
            orderNum: Number(oM[2]),
            text: oM[3],
            line: i
          });
          i++;
          continue;
        }
        break;
      }

      ast.push({
        type: 'list',
        ordered,
        items,
        lineStart: startLine,
        lineEnd: i - 1
      });
      continue;
    }

    // 9. Standard Paragraph
    const startLine = i;
    const paraLines = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\s*(?:#{1,6}\s+|`{3,}|~{3,}|>\s?|[-*+]\s+|\d+\.\s+|\$\$)/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && parseTableDelimiter(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    ast.push({
      type: 'paragraph',
      text: paraLines.join('\n'),
      lineStart: startLine,
      lineEnd: i - 1
    });
  }

  return ast;
}

/**
 * Splits normalized Markdown text into contiguous line-indexed blocks covering
 * every line 0..lines.length-1 with exact character offsets for cursor-line
 * Obsidian Live Preview.
 */
export function splitMarkdownBlocksWithLines(markdownText) {
  const raw = String(markdownText ?? '').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n');
  const lineStarts = new Array(lines.length);
  let charPos = 0;
  for (let k = 0; k < lines.length; k++) {
    lineStarts[k] = charPos;
    charPos += lines[k].length + 1;
  }

  const blocks = [];
  const pushBlock = (type, startLine, endLine, isEmpty = false) => {
    const startOffset = lineStarts[startLine];
    const endOffset = lineStarts[endLine] + lines[endLine].length;
    blocks.push({
      type,
      startLine,
      endLine,
      startOffset,
      endOffset,
      rawText: lines.slice(startLine, endLine + 1).join('\n'),
      isEmpty
    });
  };

  let i = 0;
  const fmMatch = raw.match(FRONTMATTER_RE);
  if (fmMatch) {
    const fmRaw = fmMatch[0].replace(/\n$/, '');
    const fmLineCount = fmRaw.split('\n').length;
    pushBlock('frontmatter', 0, Math.min(fmLineCount, lines.length) - 1, false);
    i = fmLineCount;
  }

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      pushBlock('blank', i, i, true);
      i++;
      continue;
    }

    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})([a-zA-Z0-9_-]*)\s*$/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const startLine = i;
      i++;
      const closeRe = new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`);
      while (i < lines.length && !closeRe.test(lines[i])) i++;
      if (i < lines.length) i++;
      pushBlock('codeblock', startLine, i - 1, false);
      continue;
    }

    if (line.trim().startsWith('$$')) {
      const startLine = i;
      if (/^\$\$([\s\S]+?)\$\$$/.test(line.trim())) {
        pushBlock('mathblock', startLine, startLine, false);
        i++;
        continue;
      }
      i++;
      while (i < lines.length && !lines[i].trim().endsWith('$$')) i++;
      if (i < lines.length) i++;
      pushBlock('mathblock', startLine, i - 1, false);
      continue;
    }

    if (/^\s*(#{1,6})(?:\s+(.*))?$/.test(line)) {
      pushBlock('heading', i, i, false);
      i++;
      continue;
    }

    if (/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(line)) {
      pushBlock('hr', i, i, false);
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const startLine = i;
      const firstBody = line.replace(/^\s*>\s?/, '');
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) i++;
      const type = CALLOUT_HEADER_RE.test(firstBody) ? 'callout' : 'blockquote';
      pushBlock(type, startLine, i - 1, false);
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && parseTableDelimiter(lines[i + 1])) {
      const startLine = i;
      i += 2;
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) i++;
      pushBlock('table', startLine, i - 1, false);
      continue;
    }

    if (TASK_LINE_RE.test(line) || /^([ \t]*)[-*+]\s+(.*)$/.test(line) || /^([ \t]*)(\d+)\.\s+(.*)$/.test(line)) {
      pushBlock('list', i, i, false);
      i++;
      continue;
    }

    const startLine = i;
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^\s*(?:#{1,6}(?:\s|$)|`{3,}|~{3,}|>\s?|[-*+]\s+|\d+\.\s+|\$\$)/.test(lines[i]) &&
      !/^\s*(?:-\s*){3,}$|^\s*(?:\*\s*){3,}$|^\s*(?:_\s*){3,}$/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && parseTableDelimiter(lines[i + 1]))
    ) {
      i++;
    }
    pushBlock('paragraph', startLine, i - 1, false);
  }

  return blocks;
}

/**
 * Renders parsed Markdown AST into strict XHTML.
 */
export function renderMarkdownToHtml(markdownText, options = {}) {
  /*
   * Blockquotes and callouts render their body by recursion, one level per
   * quote marker. A hostile or imported note with thousands of ">" levels
   * overflowed the call stack and aborted the whole card render. Past a
   * sensible depth the remaining text is shown escaped instead.
   */
  const depth = Number.isInteger(options._depth) ? options._depth : 0;
  if (depth > 24) return `<p class="gb-md-p">${escapeXhtml(String(markdownText ?? ''))}</p>`;
  const { attributes, body: cleanBody } = parseFrontmatter(stripObsidianComments(markdownText));
  const footnoteData = extractFootnotes(cleanBody);
  const renderOptions = {
    ...options,
    _depth: depth + 1,
    footnoteNumbers: footnoteData.numbers.size ? footnoteData.numbers : (options.footnoteNumbers || new Map())
  };
  const ast = parseMarkdownAST(footnoteData.body);
  const blocks = [];

  for (const node of ast) {
    switch (node.type) {
      case 'heading': {
        const tag = `h${node.level}`;
        blocks.push(
          `<${tag} class="gb-md-h gb-md-h${node.level}" data-line="${node.line}">${renderInlineMarkdown(node.text, renderOptions)}</${tag}>`
        );
        break;
      }

      case 'hr': {
        blocks.push(`<hr class="gb-md-hr" data-line="${node.line}" />`);
        break;
      }

      case 'codeblock': {
        const langAttr = node.lang ? ` data-lang="${escapeXhtml(node.lang)}"` : '';
        const langBadge = node.lang
          ? `<div class="gb-code-lang">${escapeXhtml(node.lang)}</div>`
          : '';
        blocks.push(
          `<div class="gb-codeblock-wrap" data-line="${node.lineStart}"${langAttr}>${langBadge}<pre class="gb-codeblock"><code>${highlightCodeXhtml(node.code)}</code></pre></div>`
        );
        break;
      }

      case 'mathblock': {
        blocks.push(
          `<div class="gb-mathblock-wrap" data-line="${node.lineStart}">${renderMathToXhtml(node.tex, true)}</div>`
        );
        break;
      }

      case 'callout': {
        const icon = CALLOUT_ICONS[node.calloutType] || CALLOUT_ICONS.note;
        const bodyHtml = node.body
          ? `<div class="callout-content">${renderMarkdownToHtml(node.body, { ...renderOptions, includeFootnotes: false })}</div>`
          : '';
        blocks.push(
          `<div class="callout callout-${escapeXhtml(node.calloutType)}" data-callout="${escapeXhtml(node.calloutType)}" data-line="${node.lineStart}">` +
            `<div class="callout-title">` +
              `<span class="callout-icon">${icon}</span>` +
              `<span class="callout-title-inner">${renderInlineMarkdown(node.title, renderOptions)}</span>` +
            `</div>` +
            bodyHtml +
          `</div>`
        );
        break;
      }

      case 'blockquote': {
        blocks.push(
          `<blockquote class="gb-blockquote" data-line="${node.lineStart}">${renderMarkdownToHtml(node.body, { ...renderOptions, includeFootnotes: false })}</blockquote>`
        );
        break;
      }

      case 'table': {
        const ths = node.headers
          .map((h, colIdx) => {
            const align = node.aligns[colIdx];
            const style = align ? ` style="text-align:${align}"` : '';
            return `<th${style}>${renderInlineMarkdown(h, renderOptions)}</th>`;
          })
          .join('');

        const trs = node.rows
          .map((row) => {
            const tds = node.headers
              .map((_, colIdx) => {
                const align = node.aligns[colIdx];
                const style = align ? ` style="text-align:${align}"` : '';
                const cellText = row[colIdx] ?? '';
                return `<td${style}>${renderInlineMarkdown(cellText, renderOptions)}</td>`;
              })
              .join('');
            return `<tr>${tds}</tr>`;
          })
          .join('');

        blocks.push(
          `<table class="gb-md-table" data-line="${node.lineStart}"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`
        );
        break;
      }

      case 'list': {
        const tag = node.ordered ? 'ol' : 'ul';
        const hasTasks = node.items.some((it) => it.task);
        const listCls = hasTasks ? 'gb-md-list gb-task-list' : 'gb-md-list';
        const lis = node.items
          .map((item) => {
            if (item.task) {
              const checkedAttr = item.checked ? ' checked="checked"' : '';
              const itemCls = item.checked ? 'gb-task-item is-checked' : 'gb-task-item';
              return (
                `<li class="${itemCls}" data-line="${item.line}">` +
                  `<input type="checkbox" class="gb-task-checkbox" data-line="${item.line}"${checkedAttr} />` +
                  `<span class="gb-task-label">${renderInlineMarkdown(item.text, renderOptions)}</span>` +
                `</li>`
              );
            }
            return `<li data-line="${item.line}">${renderInlineMarkdown(item.text, renderOptions)}</li>`;
          })
          .join('');
        const startAttr = node.ordered && node.items[0]?.orderNum > 1 ? ` start="${node.items[0].orderNum}"` : '';
        blocks.push(`<${tag} class="${listCls}" data-line="${node.lineStart}"${startAttr}>${lis}</${tag}>`);
        break;
      }

      case 'paragraph': {
        const lineHtml = node.text
          .split('\n')
          .map((l) => renderInlineMarkdown(l, renderOptions))
          .join('<br />');
        blocks.push(`<p class="gb-md-p" data-line="${node.lineStart}">${lineHtml}</p>`);
        break;
      }
    }
  }

  if (options.includeFootnotes !== false && footnoteData.numbers.size) {
    const entries = [...footnoteData.numbers.entries()].sort((a, b) => a[1] - b[1]);
    const items = entries.map(([id, number]) => {
      const body = footnoteData.definitions.get(id) || '';
      return `<li id="gb-footnote-${footnoteId(id)}" value="${number}">${renderInlineMarkdown(body, renderOptions)}</li>`;
    }).join('');
    blocks.push(`<section class="gb-md-footnotes"><ol>${items}</ol></section>`);
  }
  return blocks.join('\n');
}

/**
 * Extracts all task checklist items with their 0-based line indices.
 */
export function extractTaskItems(markdownText) {
  const lines = String(markdownText ?? '').replace(/\r\n?/g, '\n').split('\n');
  const tasks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TASK_LINE_RE);
    if (m) {
      tasks.push({
        line: i,
        indent: m[1].length,
        checked: m[2].toLowerCase() === 'x',
        text: m[3]
      });
    }
  }
  return tasks;
}

/**
 * Toggles a Markdown task item (`- [ ]` <-> `- [x]`) at a specific 0-based line index.
 */
export function toggleTaskAtLine(markdownText, lineIndex) {
  const raw = String(markdownText ?? '');
  const crlf = raw.includes('\r\n');
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');

  if (lineIndex < 0 || lineIndex >= lines.length) {
    return { text: raw, toggled: false };
  }

  const match = lines[lineIndex].match(/^([ \t]*[-*+]\s+\[)([ xX])(\]\s+.*)$/);
  if (!match) {
    return { text: raw, toggled: false };
  }

  const nextChecked = match[2].toLowerCase() !== 'x';
  lines[lineIndex] = `${match[1]}${nextChecked ? 'x' : ' '}${match[3]}`;

  return {
    text: lines.join(crlf ? '\r\n' : '\n'),
    toggled: true,
    checked: nextChecked
  };
}

/**
 * Generates self-contained inline CSS for the SVG <foreignObject> renderer.
 */
export function getMarkdownInlineCss({
  color = '#1e293b',
  fontSize = 20,
  fontFamily = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  align = 'left'
} = {}) {
  /*
   * These values come from board data (an object's colour, alignment, font),
   * and the CSS is embedded in the SVG that renders a Markdown card. A value
   * carrying `}` could inject arbitrary rules into that stylesheet, so each is
   * restricted to the shape the renderer actually produces.
   */
  const safeColor = /^[#a-zA-Z0-9(),.%\s-]{1,64}$/.test(String(color ?? '')) ? color : '#1e293b';
  const safeFamily = /^[a-zA-Z0-9\s,"'_-]{1,120}$/.test(String(fontFamily ?? '')) ? fontFamily
    : 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const safeSize = Number.isFinite(Number(fontSize)) ? Math.max(6, Math.min(200, Number(fontSize))) : 20;
  const safeAlign = ['left', 'center', 'right', 'justify'].includes(align) ? align : 'left';
  return `
    .gb-markdown-body {
      box-sizing: border-box;
      margin: 0;
      padding: 8px 10px;
      color: ${safeColor};
      font-family: ${safeFamily};
      font-size: ${safeSize}px;
      line-height: 1.45;
      text-align: ${safeAlign};
      word-wrap: break-word;
      overflow-wrap: break-word;
    }
    .gb-markdown-body * { box-sizing: border-box; }
    .gb-md-h { margin: 0.35em 0 0.25em; font-weight: 700; line-height: 1.25; }
    .gb-md-h1 { font-size: 1.6em; border-bottom: 1px solid rgba(128,128,128,0.25); padding-bottom: 0.15em; }
    .gb-md-h2 { font-size: 1.38em; }
    .gb-md-h3 { font-size: 1.2em; }
    .gb-md-h4, .gb-md-h5, .gb-md-h6 { font-size: 1.05em; }
    .gb-md-p { margin: 0.3em 0; }
    .gb-md-hr { border: 0; border-top: 1px solid rgba(128,128,128,0.35); margin: 0.6em 0; }
    .gb-inline-code {
      font-family: Consolas, "JetBrains Mono", monospace;
      font-size: 0.88em;
      background: rgba(128,128,128,0.16);
      padding: 0.12em 0.35em;
      border-radius: 4px;
    }
    .gb-md-highlight { background: rgba(255, 225, 82, 0.62); color: inherit; padding: 0 0.12em; border-radius: 2px; }
    .gb-md-footnotes { border-top: 1px solid rgba(128,128,128,0.28); margin-top: 0.65em; padding-top: 0.25em; font-size: 0.82em; }
    .gb-md-footnote-ref { font-size: 0.75em; vertical-align: super; }
    .gb-md-footnotes ol { margin: 0.2em 0; padding-left: 1.6em; }
    .gb-md-block-id { display: none; }
    .gb-codeblock-wrap {
      position: relative;
      margin: 0.45em 0;
      background: rgba(15, 23, 42, 0.07);
      border: 1px solid rgba(128,128,128,0.22);
      border-radius: 6px;
      overflow: hidden;
    }
    .gb-code-lang {
      font-family: Consolas, monospace;
      font-size: 0.7em;
      text-transform: uppercase;
      opacity: 0.65;
      padding: 2px 8px;
      border-bottom: 1px solid rgba(128,128,128,0.15);
    }
    .gb-codeblock {
      margin: 0;
      padding: 8px 10px;
      font-family: Consolas, "JetBrains Mono", monospace;
      font-size: 0.85em;
      white-space: pre-wrap;
    }
    .gb-hl-kw { font-weight: 600; color: #7c3aed; }
    .gb-blockquote {
      margin: 0.4em 0;
      padding: 0.2em 0.75em;
      border-left: 4px solid rgba(100,116,139,0.6);
      opacity: 0.9;
    }
    .callout {
      margin: 0.45em 0;
      padding: 8px 12px;
      border-left: 4px solid #3b82f6;
      background: rgba(59, 130, 246, 0.1);
      border-radius: 4px 6px 6px 4px;
    }
    .callout-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .callout-tip, .callout-success, .callout-todo { border-left-color: #10b981; background: rgba(16, 185, 129, 0.1); }
    .callout-warning, .callout-question { border-left-color: #f59e0b; background: rgba(245, 158, 11, 0.12); }
    .callout-danger, .callout-bug { border-left-color: #ef4444; background: rgba(239, 68, 68, 0.12); }
    .callout-info, .callout-abstract { border-left-color: #06b6d4; background: rgba(6, 182, 212, 0.1); }
    .callout-example, .callout-quote { border-left-color: #8b5cf6; background: rgba(139, 92, 246, 0.1); }
    .gb-md-list { margin: 0.35em 0; padding-left: 1.4em; }
    .gb-task-list { list-style: none; padding-left: 0.2em; }
    .gb-task-item { display: flex; align-items: baseline; gap: 0.45em; margin: 0.2em 0; }
    .gb-task-item.is-checked .gb-task-label { text-decoration: line-through; opacity: 0.65; }
    .gb-task-checkbox { width: 0.95em; height: 0.95em; margin: 0; vertical-align: middle; }
    .gb-md-table {
      border-collapse: collapse;
      width: 100%;
      margin: 0.45em 0;
      font-size: 0.92em;
    }
    .gb-md-table th, .gb-md-table td {
      border: 1px solid rgba(128,128,128,0.35);
      padding: 4px 8px;
    }
    .gb-md-table th { background: rgba(128,128,128,0.12); font-weight: 700; }
    .gb-wikilink, .gb-obsidian-uri, .gb-ext-link {
      color: #6366f1;
      text-decoration: underline;
      font-weight: 500;
    }
    .gb-embed-card {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      margin: 2px 0;
      border-radius: 6px;
      border: 1px solid rgba(99, 102, 241, 0.4);
      background: rgba(99, 102, 241, 0.1);
      color: #4f46e5;
      font-weight: 600;
      font-size: 0.9em;
    }
    .gb-embed-page {
      font-size: 0.8em;
      padding: 1px 5px;
      border-radius: 4px;
      background: rgba(99, 102, 241, 0.18);
    }
    .gb-hashtag {
      display: inline-block;
      padding: 1px 7px;
      border-radius: 10px;
      background: rgba(0, 120, 212, 0.12);
      color: #0078d4;
      font-size: 0.88em;
      font-weight: 600;
    }
    .gb-math-block, .gb-mathblock-wrap {
      margin: 0.4em 0;
      text-align: center;
      font-family: "KaTeX_Main", "Cambria Math", serif;
    }
    .gb-math-inline {
      font-family: "KaTeX_Main", "Cambria Math", serif;
      font-style: italic;
    }
  `;
}

/**
 * Render Markdown through the Rust pulldown-cmark engine when running in Tauri,
 * falling back to the pure-JS Obsidian/Markdown HTML renderer on Web/Android.
 * @param {string} markdownText
 * @param {object} [options]
 * @returns {Promise<string>}
 */
export async function renderMarkdownToHtmlNative(markdownText, options = {}) {
  const source = String(markdownText || '');
  try {
    const fn = typeof window !== 'undefined' ? window.board?.markdown?.renderToHtml : null;
    if (typeof fn === 'function') {
      const html = await fn(source);
      if (typeof html === 'string' && html.length) return html;
    }
  } catch {}
  return renderMarkdownToHtml(source, options);
}

/**
 * Builds an SVG <foreignObject> data URI for sharp Canvas2D rendering.
 */
export function buildMarkdownSvgDataUri(markdownText, options = {}) {
  const width = Math.max(40, Math.ceil(options.width || 320));
  const height = Math.max(24, Math.ceil(options.height || 160));
  const htmlContent = renderMarkdownToHtml(markdownText, options);
  const cssContent = getMarkdownInlineCss(options);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<foreignObject width="100%" height="100%">` +
        `<div xmlns="http://www.w3.org/1999/xhtml" class="gb-markdown-body">` +
          `<style>${cssContent}</style>` +
          htmlContent +
        `</div>` +
      `</foreignObject>` +
    `</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
