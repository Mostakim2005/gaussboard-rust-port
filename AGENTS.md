# Project Operating Instructions (`AGENTS.md`)
> **Notice:** This project inherits user persona, confirmation gates, and documentation blueprints from the global master `AGENTS.md`. Do not duplicate those rules here.

## 1. Project Tech Stack & Environment
* **Runtime / Language:** Rust 1.80+, Node.js v20+, Vanilla ES6 JavaScript modules; fully open to high-performance C, C++, Rust, Zig, and Wasm native modules.
* **Framework / Host:** HTML5 Canvas 2D, Tauri v2 Native Desktop & Mobile Host (Edge WebView2 on Windows, System WebView on Android), with PWA web adapter fallback (zero Electron/Chromium dependency; Electron lives exclusively in the upstream `GaussBoard` repository).
* **Target OS / Build Output:** Windows x64 portable `.exe`, NSIS Setup `.exe`, & `.msi` installer; Android `aarch64` signed release `.apk`. Every cloud release binary uses the self-identifying naming scheme `GaussBoard-Rust-Tauri-v<Version>-branch-<BranchSlug>-<ShortSHA>-<Type>.<ext>` across all deduplicated branches.

## 2. Mandatory Verification & Build Commands
* **Active Features Smoke Test (24/24):** `node scripts/smoke.js` (or `node scripts/smoke.js --new-features`)
* **Strict 100% i18n Parity Check (7 Locales):** `node scripts/i18n-check.js`
* **Base Feature Regression Suite (Temporarily Optional):** `node scripts/smoke.js --base`
* **Build / Package (Windows Portable):** `npm run dist:win`

## 3. Repository Directory Structure & Conventions
* `src/` - Modular vanilla JavaScript source files (single-responsibility modules only).
* `docs/` - Core documentation suite (`PRODUCT.md`, `ARCHITECTURE.md`, `DECISIONS_AND_TRAPS.md`).
* `sync/` - Offline LAN handoff protocol (UDP 53319 discovery + TCP 53318 X25519 / AES-256-GCM transport).
* `scripts/` - Automated verification suites, smoke tests, and i18n linter.
* `test/` - Integration tests, test fixtures, and verification harnesses.

## 4. Repository-Specific Engineering Traps (The 6 Non-Negotiable Invariants)
* **TRAP 1: Scene Partitioning During Audio Replay:** Base canvas drawing passes MUST exclude active audio session strokes: `(o) => o.audioId !== activeTrackId`. Replay strokes render exclusively in the dynamic overlay pass (`Surface.drawReplaySession()`).
* **TRAP 2: Stroke Point Timestamp Preservation (`p.t`):** Point generators, smoothing passes, and curve fitters in `tools.js` and `ink.js` must preserve `p.t`. Stripping `p.t` breaks audio synchronization.
* **TRAP 3: Finite Audio Duration Safeguard:** For in-app recordings, never rely on `audio.duration` without checking `isFinite()`; retain elapsed wall-clock `track.durationMs`. For imported audio, use finite metadata when available and leave duration unknown when unavailable.
* **TRAP 4: 100% Internationalization (i18n) Parity:** Every user-facing UI string must be wrapped in `t('...')` and present across all 7 locale dictionaries (`ar.json`, `bn.json`, `de.json`, `es.json`, `pt-BR.json`, `zh-Hans.json`, `zh-Hant.json`).
* **TRAP 5: Zero Extra Native Dependencies:** Do not introduce npm packages that require C/C++ compilation (`node-gyp`). All algorithms must remain pure portable JavaScript.
* **TRAP 6: Study Tape and Answer Cover Toggle:** Both study tape (`subtype: 'tape'`) and rectangular answer covers (`subtype !== 'tape'`) persist on the board and toggle concealed/revealed on tap. Revealed covers remain hittable as faint outlines; attached content follows the cover state.
