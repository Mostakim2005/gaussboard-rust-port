import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import {
  splitMarkdownBlocksWithLines,
  renderMarkdownToHtml
} from '../src/js/core/markdown.js';
import { sortBookmarks, parseVideoUrl } from '../src/js/ui/video-dialog.js';
import { boardAssetUrl } from '../src/js/core/util.js';
import { Store } from '../src/js/core/store.js';

test('splitMarkdownBlocksWithLines covers every line with exact offsets and block boundaries', () => {
  const raw = [
    '---',
    'title: "Circuit Notes"',
    '---',
    '# Heading 1',
    '',
    '- [ ] Task 1',
    '- [x] Task 2',
    '3. Ordered third',
    '```js',
    '# not a heading inside fence',
    'const x = 1;',
    '```',
    '$$',
    'E = mc^2',
    '$$',
    '> [!tip] Advice',
    '> Keep lines short.',
    '| Col A | Col B |',
    '| :--- | ---: |',
    '| 1 | 2 |',
    'Paragraph line 1',
    'Paragraph line 2'
  ].join('\r\n');

  const norm = raw.replace(/\r\n?/g, '\n');
  const blocks = splitMarkdownBlocksWithLines(raw);

  assert.deepEqual(
    blocks.map((b) => b.type),
    [
      'frontmatter',
      'heading',
      'blank',
      'list',
      'list',
      'list',
      'codeblock',
      'mathblock',
      'callout',
      'table',
      'paragraph'
    ]
  );

  // Every block slice must match rawText and lines must be strictly contiguous 0..N-1.
  let expectedLine = 0;
  for (const b of blocks) {
    assert.equal(b.startLine, expectedLine, `block ${b.type} startLine contiguous`);
    assert.ok(b.endLine >= b.startLine);
    assert.equal(norm.slice(b.startOffset, b.endOffset), b.rawText);
    expectedLine = b.endLine + 1;
  }
  assert.equal(expectedLine, norm.split('\n').length);

  // Empty string produces one selectable blank block.
  const empty = splitMarkdownBlocksWithLines('');
  assert.equal(empty.length, 1);
  assert.equal(empty[0].type, 'blank');
  assert.equal(empty[0].isEmpty, true);
});

test('renderMarkdownToHtml preserves ordered list start numbering for Live Preview blocks', () => {
  const html = renderMarkdownToHtml('3. Third step');
  assert.match(html, /<ol[^>]*start="3"/);
});

test('video bookmarks sort chronologically in-place and YouTube embed enforces playsinline', () => {
  const original = [
    { id: 'b3', time: 185, label: 'Conclusion' },
    { id: 'b1', time: 12, label: 'Intro' },
    { id: 'b2', time: 75, label: 'Derivation' }
  ];
  const sorted = sortBookmarks(original);
  assert.deepEqual(sorted.map((b) => b.time), [12, 75, 185]);

  const yt = parseVideoUrl('https://youtu.be/dQw4w9WgXcQ?t=42');
  assert.equal(yt.type, 'youtube');
  assert.equal(yt.startTime, 42);
  assert.match(yt.embedUrl, /enablejsapi=1/);
  assert.match(yt.embedUrl, /playsinline=1/);
  assert.match(yt.embedUrl, /rel=0/);
});

test('boardAssetUrl adapts cleanly between https://app.localhost and app://board origins', () => {
  const origWindow = globalThis.window;
  try {
    globalThis.window = { location: { origin: 'https://app.localhost', protocol: 'https:' } };
    assert.equal(boardAssetUrl('audio_123'), 'https://app.localhost/asset/audio_123');
    assert.equal(boardAssetUrl('../bad/id!'), 'https://app.localhost/asset/..%2Fbad%2Fid!');

    globalThis.window = { location: { origin: 'app://board', protocol: 'app:' } };
    assert.equal(boardAssetUrl('img_9', '__asset'), 'app://board/__asset/img_9');
  } finally {
    globalThis.window = origWindow;
  }
});

test('Store keeps freeform unclipped canvas (pageClip: false) by default and honors undoable page clipping', () => {
  const store = new Store();
  assert.equal(store.doc.pageClip, false);

  store.doc.pages = [{ id: 'p1', kind: 'a4', x: 0, y: 0, w: 794, h: 1123 }];
  assert.equal(store.doc.pageClip, false);

  store.setPageClip(true, 'enable page clip');
  assert.equal(store.doc.pageClip, true);

  store.undo();
  assert.equal(store.doc.pageClip, false);

  store.redo();
  assert.equal(store.doc.pageClip, true);

  // Serialization round-trip via load() preserves pageClip boolean.
  const copy = new Store();
  copy.load(JSON.parse(JSON.stringify(store.doc)));
  assert.equal(copy.doc.pageClip, true);
});

test('tauri-board bridge exposes Obsidian vault IPC and suppresses immediate self-write clipboard race', async () => {
  const calls = [];
  const listeners = new Map();
  let fakeSig = 'old-sig';

  const mockWindow = {
    location: { origin: 'https://app.localhost', protocol: 'https:' },
    addEventListener: () => {},
    __TAURI__: {
      core: {
        invoke: async (cmd, args) => {
          calls.push({ cmd, args });
          if (cmd === 'clipboard_write') { fakeSig = 'excerpt-sig-1'; return true; }
          if (cmd === 'clipboard_signature') return fakeSig;
          if (cmd === 'clipboard_read') return { text: '', html: '', image: 'data:image/png;base64,iVBOR', signature: fakeSig };
          if (cmd === 'vault_choose_folder') return { ok: true, canceled: false, path: 'C:/Vault', name: 'Vault' };
          if (cmd === 'vault_list_notes') return [{ relPath: 'Notes/Intro.md', name: 'Intro.md', modifiedMs: 1000, size: 42 }];
          if (cmd === 'vault_read_note') return { ok: true, relPath: args.relPath, content: '# Intro', modifiedMs: 1000 };
          if (cmd === 'vault_write_note') return { ok: true, relPath: args.relPath, modifiedMs: 2000 };
          return null;
        }
      },
      event: {
        listen: async (name, cb) => { listeners.set(name, cb); return () => {}; }
      }
    }
  };

  const scriptSrc = fs.readFileSync('src/js/platform/tauri-board.js', 'utf8');
  vm.runInNewContext(scriptSrc, {
    window: mockWindow,
    document: { addEventListener: () => {} },
    navigator: {},
    setTimeout,
    clearTimeout,
    URL,
    Date,
    Promise,
    console
  });

  // Vault Bridge IPC
  assert.ok(mockWindow.board.vault);
  const picked = await mockWindow.board.vault.chooseFolder();
  assert.equal(picked.name, 'Vault');
  const notes = await mockWindow.board.vault.listNotes('C:/Vault');
  assert.equal(notes[0].relPath, 'Notes/Intro.md');
  const readRes = await mockWindow.board.vault.readNote('C:/Vault', 'Notes/Intro.md');
  assert.equal(readRes.content, '# Intro');
  await mockWindow.board.vault.writeNote('C:/Vault', 'Notes/Intro.md', '# Updated');

  // Clipboard own-write race guard: write -> check cached sig survives immediate seq tick.
  await mockWindow.board.clipboardWrite({ image: 'data:image/png;base64,iVBOR' });
  const cbSeq = listeners.get('board://clipboard-seq');
  if (cbSeq) {
    // Simulate stale external sequence event arriving immediately after our own write.
    fakeSig = 'different-external-sig';
    cbSeq({ payload: { seq: 99, signature: 'different-external-sig' } });
  }
  const clipNow = await mockWindow.board.clipboardRead();
  assert.equal(clipNow.image, 'data:image/png;base64,iVBOR');

  const cmds = calls.map((c) => c.cmd);
  assert.ok(cmds.includes('vault_choose_folder'));
  assert.ok(cmds.includes('vault_list_notes'));
  assert.ok(cmds.includes('vault_read_note'));
  assert.ok(cmds.includes('vault_write_note'));
});

test('Tauri configuration, capabilities, and Android CI manifest support secure mic & clipboard images', () => {
  const conf = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const mainWin = conf.app.windows.find((w) => w.label === 'main');
  const splashWin = conf.app.windows.find((w) => w.label === 'splashscreen');
  assert.equal(mainWin.useHttpsScheme, true);
  assert.equal(splashWin.useHttpsScheme, true);
  assert.match(conf.app.security.csp, /https:\/\/app\.localhost/);
  assert.match(conf.app.security.csp, /https:\/\/ipc\.localhost/);

  const caps = JSON.parse(fs.readFileSync('src-tauri/capabilities/default.json', 'utf8'));
  assert.ok(caps.permissions.includes('clipboard-manager:allow-read-image'));
  assert.ok(caps.permissions.includes('clipboard-manager:allow-write-image'));

  const androidYml = fs.readFileSync('.github/workflows/tauri-android.yml', 'utf8');
  assert.match(androidYml, /android\.permission\.RECORD_AUDIO/);
});
