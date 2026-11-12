#!/usr/bin/env node
/*
 * Pure Node.js + Tauri v2 Smoke Runner for GaussBoard Rust Port.
 * Executes the 24/24 active features smoke test suite directly in Node.js (v20+)
 * with zero Electron or Chromium runtime dependency.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { register } = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const SRC_DIR_URL = pathToFileURL(path.join(ROOT, 'src') + path.sep).href;

// Register custom ESM loader hook to map `app://board/*` -> `src/*`
const loaderCode = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('app://board/')) {
    const rel = specifier.slice('app://board/'.length);
    const target = new URL(rel, ${JSON.stringify(SRC_DIR_URL)}).href;
    return nextResolve(target, context);
  }
  return nextResolve(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(loaderCode));

// Minimal DOM & Web API shims for headless Node.js execution of UI/core modules
function installDomShim() {
  const storageMap = new Map();
  const localStorage = {
    getItem: (k) => (storageMap.has(String(k)) ? storageMap.get(String(k)) : null),
    setItem: (k, v) => { storageMap.set(String(k), String(v)); },
    removeItem: (k) => { storageMap.delete(String(k)); },
    clear: () => { storageMap.clear(); }
  };

  const makeEl = (tag = 'div') => ({
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    children: [],
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { return c; },
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; },
    getContext() {
      return {
        save() {}, restore() {}, scale() {}, translate() {}, rotate() {},
        clearRect() {}, fillRect() {}, strokeRect() {}, beginPath() {},
        moveTo() {}, lineTo() {}, bezierCurveTo() {}, quadraticCurveTo() {},
        arc() {}, closePath() {}, stroke() {}, fill() {}, fillText() {},
        measureText(t) { return { width: String(t).length * 8 }; },
        setLineDash() {}, drawImage() {}, createLinearGradient() { return { addColorStop() {} }; }
      };
    }
  });

  globalThis.localStorage = localStorage;
  globalThis.sessionStorage = localStorage;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

  globalThis.document = {
    documentElement: makeEl('html'),
    head: makeEl('head'),
    body: makeEl('body'),
    createElement: (tag) => makeEl(tag),
    createElementNS: (_ns, tag) => makeEl(tag),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {}
  };

  globalThis.window = globalThis;
  globalThis.window.__errors = [];
  globalThis.window.addEventListener = () => {};
  globalThis.window.removeEventListener = () => {};
  globalThis.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.HTMLElement = class HTMLElement {};
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, opts = {}) { this.type = type; this.detail = opts.detail; }
  };
  globalThis.dispatchEvent = () => true;
}

async function createAppHarness() {
  installDomShim();

  const { Store } = await import(pathToFileURL(path.join(ROOT, 'src/js/core/store.js')).href);
  const { Camera } = await import(pathToFileURL(path.join(ROOT, 'src/js/core/camera.js')).href);
  const { StudyRunner } = await import(pathToFileURL(path.join(ROOT, 'src/js/ui/study-runner.js')).href);

  const store = new Store();
  const cam = new Camera();
  const surface = {
    cam,
    fadeOut() {},
    touch() {},
    invalidate() {}
  };

  const app = {
    store,
    surface,
    studyRunner: null,
    toast() {},
    syncUI() {},
    dropHidden() {},
    onCovers(ids) {
      const set = new Set(ids);
      return store.objects.filter((o) => o.coverId && set.has(o.coverId));
    },
    setCovers(ids, revealed, label) {
      const ops = [];
      const set = (o, key, val) => {
        if ((o[key] ?? false) === val) return;
        ops.push({ t: 'set', id: o.id, before: { [key]: o[key] }, after: { [key]: val } });
      };
      for (const id of ids) { const c = this.store.get(id); if (c) set(c, 'revealed', revealed); }
      for (const o of this.onCovers(ids)) set(o, 'hidden', revealed);
      this.store.commit(label, ops);
    },
    toggleCurtain(id) {
      const o = this.store.get(id);
      if (!o || o.type !== 'curtain') return false;
      const next = !o.revealed;
      const label = o.subtype === 'tape'
        ? (next ? 'reveal tape' : 'conceal tape')
        : (next ? 'reveal' : 'conceal');
      this.setCovers([id], next, label);
      this.dropHidden();
      this.surface.invalidate();
      this.syncUI();
      return true;
    }
  };

  app.studyRunner = new StudyRunner(app);
  globalThis.window.app = app;
  return app;
}

async function main() {
  await createAppHarness();
  const suite = require(path.join(ROOT, 'test', 'smoke-new-features.js'));

  const win = {
    webContents: {
      executeJavaScript: async (code) => {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const fn = new AsyncFunction(`return (${code});`);
        return await fn();
      }
    }
  };

  const hostApp = {
    exit: (code) => process.exit(code)
  };

  await suite.run(win, hostApp);
}

main().catch((err) => {
  console.error('Smoke runner error:', err);
  process.exit(1);
});
