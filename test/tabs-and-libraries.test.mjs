import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

test('libraries.json manifest includes required libraries and versions', () => {
  const localManifestPath = path.join(root, 'src', 'vendor', 'libraries.json');
  assert.ok(fs.existsSync(localManifestPath), 'src/vendor/libraries.json exists');

  const manifest = JSON.parse(fs.readFileSync(localManifestPath, 'utf8'));
  assert.ok(manifest.manifestVersion.startsWith('1.'), 'manifestVersion is 1.x');
  assert.ok(Array.isArray(manifest.libraries), 'libraries array exists');

  const ids = manifest.libraries.map(l => l.id);
  assert.ok(ids.includes('katex'), 'KaTeX registered');
  assert.ok(ids.includes('pdfjs'), 'PDF.js registered');
  assert.ok(ids.includes('pdfjs-viewer'), 'PDF.js Viewer registered');
  assert.ok(ids.includes('pdf-lib'), 'pdf-lib registered');
  assert.ok(ids.includes('fontkit'), 'fontkit registered');
  assert.ok(ids.includes('tesseract'), 'Tesseract OCR registered');
  assert.ok(ids.includes('jszip'), 'JSZip registered');
  assert.ok(ids.includes('mammoth'), 'Mammoth registered');
  assert.ok(ids.includes('mermaid'), 'Mermaid registered');
  assert.ok(ids.includes('chartjs'), 'Chart.js registered');

  // Verify versions and statuses
  const katex = manifest.libraries.find(l => l.id === 'katex');
  assert.equal(katex.status, 'ready');
  assert.equal(katex.bundledInApp, true);

  const mermaid = manifest.libraries.find(l => l.id === 'mermaid');
  assert.equal(mermaid.version, '10.9.1');
  assert.equal(mermaid.category, 'Diagrams & Mind Maps');

  const chartjs = manifest.libraries.find(l => l.id === 'chartjs');
  assert.equal(chartjs.version, '4.4.7');

  const pdflib = manifest.libraries.find(l => l.id === 'pdf-lib');
  assert.equal(pdflib.version, '1.17.1');
});

test('Shared CommonLibraries repository exists on C: with all engines', () => {
  const sharedDir = 'C:\\Users\\kazir\\Documents\\Antigravity\\CommonLibraries';
  assert.ok(fs.existsSync(sharedDir), 'CommonLibraries folder exists');

  const manifestPath = path.join(sharedDir, 'libraries.json');
  assert.ok(fs.existsSync(manifestPath), 'CommonLibraries/libraries.json exists');

  const readmePath = path.join(sharedDir, 'README.md');
  assert.ok(fs.existsSync(readmePath), 'CommonLibraries/README.md exists');

  // Check shared engine bundles
  assert.ok(fs.existsSync(path.join(sharedDir, 'katex', 'katex.min.js')), 'KaTeX shared bundle exists');
  assert.ok(fs.existsSync(path.join(sharedDir, 'pdfjs', 'pdf.min.mjs')), 'PDF.js shared bundle exists');
  assert.ok(fs.existsSync(path.join(sharedDir, 'pdfjs', 'pdf_viewer.mjs')), 'PDF.js viewer shared bundle exists');
  assert.ok(fs.existsSync(path.join(sharedDir, 'mermaid', 'mermaid.min.js')), 'Mermaid.js shared bundle exists');
  assert.ok(fs.existsSync(path.join(sharedDir, 'chartjs', 'chart.umd.min.js')), 'Chart.js shared bundle exists');
  assert.ok(fs.existsSync(path.join(sharedDir, 'pdf-lib', 'pdf-lib.min.js')), 'pdf-lib shared bundle exists');
  assert.ok(fs.existsSync(path.join(sharedDir, 'fontkit', 'fontkit.umd.min.js')), 'fontkit shared bundle exists');
  assert.ok(fs.existsSync(path.join(sharedDir, 'tesseract', 'tesseract.min.js')), 'Tesseract shared bundle exists');
});

test('TabBar in-memory LRU session cache and tab life cycle', async () => {
  // Mock DOM and app environment
  const mockDoc = { id: 'board-alpha', name: 'Alpha Study Board', objects: { 's1': { type: 'stroke' } } };
  const mockStore = {
    doc: JSON.parse(JSON.stringify(mockDoc)),
    undoStack: [{ op: 'add', id: 's1' }],
    redoStack: [],
    reset() {
      this.doc = { id: 'temp', name: 'Untitled board', objects: {} };
      this.undoStack = [];
      this.redoStack = [];
    }
  };

  const mockApp = {
    store: mockStore,
    surface: {
      cam: { x: 100, y: 200, z: 1.5 },
      selection: { clear() {} },
      damageAll() {},
      focus() {}
    },
    settings: { showTabBar: true },
    saveBeforeLeaving: async () => {},
    newBoard(silent) {
      mockStore.doc = { id: 'board-beta', name: 'Beta Notes', objects: {} };
    },
    loadBoard(payload) {
      mockStore.doc = JSON.parse(JSON.stringify(payload));
    },
    syncUI() {},
    toast() {}
  };

  // Import TabBar
  const { TabBar } = await import('../src/js/ui/tabs.js');
  const tabBar = new TabBar(mockApp);

  // Initialize tabs state
  tabBar.tabs = [{ id: 'board-alpha', title: 'Alpha Study Board' }];
  tabBar.activeId = 'board-alpha';

  // 1. Cache current session
  tabBar.cacheCurrentSession();
  assert.equal(tabBar.cache.has('board-alpha'), true);
  const cachedAlpha = tabBar.cache.get('board-alpha');
  assert.equal(cachedAlpha.docSnapshot.id, 'board-alpha');
  assert.equal(cachedAlpha.camera.x, 100);
  assert.equal(cachedAlpha.undoStack.length, 1);

  // 2. Open new tab
  await tabBar.newTab();
  assert.equal(tabBar.tabs.length, 2);
  assert.equal(tabBar.activeId, 'board-beta');

  // 3. Rename current tab
  tabBar.onTitleChanged('board-beta', 'Beta Chemistry');
  assert.equal(tabBar.tabs[1].title, 'Beta Chemistry');

  // 4. Switch back to Alpha (sub-millisecond instant memory restoration)
  await tabBar.switchTab('board-alpha');
  assert.equal(tabBar.activeId, 'board-alpha');
  assert.equal(mockStore.doc.id, 'board-alpha');
  assert.equal(mockStore.doc.name, 'Alpha Study Board');
  assert.equal(mockApp.surface.cam.x, 100);
  assert.equal(mockApp.surface.cam.y, 200);

  // 5. Close active tab
  await tabBar.closeTab('board-alpha');
  assert.equal(tabBar.tabs.length, 1);
  assert.equal(tabBar.activeId, 'board-beta');
  assert.equal(tabBar.cache.has('board-alpha'), false);
});
