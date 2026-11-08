# Product Intent & Feature Map (`docs/PRODUCT.md`)
> **1-Line Summary:** The permanent source of truth for what GaussBoard 6.9.2 must do and feel like, independent of how the code is currently organized.

## 1. Core Vision & User Experience Intent
* **What This App Does (Plain English):** GaussBoard (v6.9.2) is an offline-first digital whiteboard and STEM engineering workstation for electrical engineering students, inspired by StarNote, Flexcil, LiquidText, and Microsoft OneNote.
* **How It Must Feel to Use:** Pen writes like real ink with pressure and zero smoothing lag, canvas pans and zooms instantly at 5% to 800%, everything works offline with no account and no cloud, boards stay on the device and export cleanly to PNG, SVG, and PDF.
* **Lineage:** Original heritage from GazBoard by MD. Fakhruddin Gazzali (theBoringCodes), v4.8.1 baseline. This GaussBoard line (maintained by Kazi S. Mostakim) extends it through v4.8.2 to v6.9.2+. Native file format is `.gaussboard` (with full backward-compatibility for `.gazboard` and `.openboard`). Primary target is Windows portable binaries.

## 2. Active Features (Do Not Break)

### [FEATURE: Infinite-Canvas-Pen-Inking] | Aliases: whiteboard, infinite canvas, pen tool, highlighter, stylus, palm rejection
> **1-Line Summary:** Infinite pan/zoom canvas where the stylus inks and the mouse points, with pressure-sensitive pen and highlighter that stay exactly as drawn.
* **User Intention (Non-Negotiable):** Teachers and students must draw on an infinite canvas without losing work, with sticky pen colors, edge auto-pan, connection to figures, and 8 paper colors plus grid, dots, lines, columns, and graph patterns.
* **Visual / UI Behavior:** Ribbon tools V L P H E N T S; mouse with pen selected selects and pans once a stylus is known; drag on bare canvas pans; scroll wheel zooms; edge auto-pan speeds up near the window edge; backgrounds scale sensibly with zoom.
* **Code Anchors (Grep Targets):**
  * `src/js/core/ink.js` -> `createInkEngine`, `pressure`, `stroke`
  * `src/js/core/tools.js` -> `PEN`, `HILITE`, `toolStateMachine`
  * `src/js/core/camera.js` -> `pan`, `zoom`, `screenToBoard`
  * `src/js/core/render.js` -> `renderObject`, `applyBackground`
  * `src/js/ui/toolbar.js` -> `ribbon`, `penTray`

### [FEATURE: Audio-Ink-Replay] | Aliases: audio recording, replay, lecture replay, waveform, bookmarks, audio bar
> **1-Line Summary:** Record voice while writing, then replay the drawing in time with the audio using the waveform scrubber and bookmarks.
* **User Intention (Non-Negotiable):** Lecture notes must play back stroke-by-stroke in timestamp order, with live reveal, spotlight, static mode, seeking, and optional camera follow without cutting or re-timing strokes.
* **Visual / UI Behavior:** AudioBar waveform, 5s 10s 15s 30s skips, named bookmark editor, recording rename, canvas audio cards; Reading mode is read-only pan, Writing mode allows new timestamped ink.
* **Code Anchors (Grep Targets):**
  * `src/js/core/audio-recorder.js` -> `AudioRecorder`, `start`, `stop`
  * `src/js/core/replay.js` -> `ReplayEngine`, `applyRemote`
  * `src/js/core/surface.js` -> `drawReplaySession`, `firstPointAfter`
  * `src/js/ui/audio-bar.js` -> `renderWaveform`, `seekToTime`
  * `src/js/core/store.js` -> `checkpoint`, `applyRemote`

### [FEATURE: Study-Tape-Answer-Covers] | Aliases: study tape, answer cover, active recall, conceal, reveal, quiz
> **1-Line Summary:** Persistent tape and rectangular covers that hide work during recall and reveal it on tap while staying hittable as faint outlines.
* **User Intention (Non-Negotiable):** Students must mask answers and check themselves, with freehand tape and cards persisting on the board and attached ink following the cover state.
* **Visual / UI Behavior:** Study Tape tool in ribbon and Add/tools menus; tap toggles concealed/revealed; concealed covers redraw above replay so secrets stay hidden; study runner modal supports review.
* **Code Anchors (Grep Targets):**
  * `src/js/core/tools.js` -> `studyTapeTool`, `coverFor`
  * `src/js/core/render.js` -> `drawCover`, `boundsOf`
  * `src/js/core/hit.js` -> `hitTestCover`, `toggleCover`
  * `src/js/ui/study-runner.js` -> `setReviewState`, `refreshCanvas`

### [FEATURE: Scratch-Out-Eraser] | Aliases: scratch eraser, scribble erase, gesture erase, partial erase
> **1-Line Summary:** StarNote-style scribble eraser that removes only the ink it crosses and splits strokes instead of deleting whole objects.
* **User Intention (Non-Negotiable):** Fast natural erasing with zero false positives on handwriting, plus whole-object and erase-everything modes, with eraser growth to 2.8x while scrubbing.
* **Visual / UI Behavior:** Four eraser sizes; dominant reversal axis with spatial overlap guard; concealed covers spare the ink beneath; selection prunes after deletion.
* **Code Anchors (Grep Targets):**
  * `src/js/core/scratch.js` -> `classifyScratch`, `isScratch`
  * `src/js/core/tools.js` -> `ERASE`, `eraseStroke`
  * `src/js/core/erase.js` -> `partialErase`, `t0`, `t1`
  * `src/js/core/hit.js` -> `eraseSweep`, `pruneSelection`

### [FEATURE: Split-Workspace] | Aliases: split view, dual pane, side by side, reference pane, multi-window
> **1-Line Summary:** Two independent side-by-side boards with separate cameras, stores, undo stacks, and text editors for textbook plus notes work.
* **User Intention (Non-Negotiable):** Students must read a textbook on one side and write notes on the other, with left saves chained, focus lease driving undo, and no silent loss when switching boards.
* **Visual / UI Behavior:** SplitStudyWorkspace enable/disable; left pane owns its TextEditor and camera offset; openBoardInSplit guards against opening the same board twice; multi-window lease manager switches Active Editor versus Read-Only.
* **Code Anchors (Grep Targets):**
  * `src/js/ui/split-workspace.js` -> `SplitStudyWorkspace`, `openBoardInSplit`, `flushLeftBoard`
  * `src/js/app.js` -> `activePane`, `isLeftFocused`
  * `src/js/ui/textedit.js` -> `TextEditor`, `commit`
  * `main.js` -> `leaseManager`, `crossWindowSync`

### [FEATURE: Document-Import-Pages] | Aliases: PDF import, Word import, PowerPoint import, page picker, LibreOffice
> **1-Line Summary:** Drag in PDF, Word, PowerPoint, and spreadsheet files, pick pages and layout, then annotate each page as an independent object.
* **User Intention (Non-Negotiable):** Teachers must bring lecture slides and handouts onto the board, choose Standard/High/Maximum quality, and move, lock, and export pages with ink that erases without touching the page.
* **Visual / UI Behavior:** Insert Document or drag-drop; thumbnail picker with range box and row/grid/stacked layout; quality changes pixel density only, board size stays identical; About shows LibreOffice versus built-in engine; GAZBOARD_DISABLE_LIBREOFFICE forces built-in path.
* **Code Anchors (Grep Targets):**
  * `src/js/insert.js` -> `importDocument`, `pagePicker`
  * `src/js/importers/pdf.js` -> `rasterizePdf`, `renderPage`
  * `src/js/importers/pptx.js` -> `readOOXML`, `renderSlide`
  * `src/js/ui/pagepicker.js` -> `showPagePicker`, `rangeParse`
  * `soffice.js` -> `convertWithLibreOffice`
  * `msoffice.js` -> `convertBuiltin`

### [FEATURE: Circuit-Sim-EE-Workbench] | Aliases: circuit simulator, MNA, DOL starter, Forward-Reverse, DMM, oscilloscope, ladder logic
> **1-Line Summary:** Headless MNA circuit engine with semiconductors, 555 timer, industrial presets, and live meters that drive LEDs correctly across long circuits.
* **User Intention (Non-Negotiable):** EE students must wire DOL and Forward-Reverse presets that actually latch, see correct diode drops and driver outputs, measure with DMM continuity, and export BOM and ladder views.
* **Visual / UI Behavior:** 2.5D workbench modal, object-textured design, animated current particles, snapped terminals, cubic Bezier wires, Web Audio clicks and hums.
* **Code Anchors (Grep Targets):**
  * `src/js/core/circuit-sim.js` -> `solveMNA`, `DOL`, `forwardReverse`, `diodeDrop`
  * `src/js/ui/circuit-workbench.js` -> `openWorkbench`, `stepSim`
  * `src/js/core/connectors.js` -> `routeOrthogonal`, `arrowHead`

### [FEATURE: Math-Studio-CAS-Grapher] | Aliases: math editor, SymPy, KaTeX, function grapher, CAS, calculus, matrix builder
> **1-Line Summary:** Offline math studio with 6 palettes, matrix builder, quick evaluator, and 2D/3D graphing with tangent and Riemann shading.
* **User Intention (Non-Negotiable):** Students must edit matrices and calculus symbols offline, see correct domain/asymptote handling, and export syntax without network calls.
* **Visual / UI Behavior:** MathEdit dialog, palette categories Calculus/Linear Algebra/Cases/Greek/Symbols/Physics/Stats, on-demand KaTeX load; grapher supports y=f(x), z=f(x,y), polar r=theta.
* **Code Anchors (Grep Targets):**
  * `src/js/core/scientific-math.js` -> `evaluateExpr`, `solveQuadratic`
  * `src/js/ui/mathedit.js` -> `MatheditDialog`, `matrixBuilder`
  * `src/js/ui/function-grapher.js` -> `plotFunction`, `riemannShade`
  * `src/js/core/formula-graph.js` -> `parseFormula`, `derivative`

### [FEATURE: Knowledge-Interop-Graph] | Aliases: JSON Canvas, knowledge graph, Markdown sidecar, LiquidText tethers, document navigator
> **1-Line Summary:** Bidirectional JSON Canvas 1.0, interactive knowledge graph, Obsidian Markdown sidecar with YAML and KaTeX, tethers, and TOC navigator.
* **User Intention (Non-Negotiable):** Notes must move between GaussBoard and Obsidian cleanly, show as a force-directed network with zoom/search/drag, and keep LiquidText-style links to source regions.
* **Visual / UI Behavior:** GraphView modal, sidecar export on demand or auto on save, cyan tether lines with glide-to-source badges, Alt+T TOC drawer with thumbnail navigation.
* **Code Anchors (Grep Targets):**
  * `src/js/core/json-canvas.js` -> `exportCanvas`, `importCanvas`
  * `src/js/ui/graph-view.js` -> `GraphViewModal`, `layoutForce`
  * `src/js/core/markdown-sidecar.js` -> `exportSidecar`, `frontmatter`
  * `src/js/core/boardrefs.js` -> `resolveHeading`, `resolveBlock`
  * `src/js/ui/pdf-sidebar.js` -> `PdfSidebarDrawer`, `buildTOC`

### [FEATURE: LAN-Handoff-Sync] | Aliases: LAN sync, share on network, pairing code, TCP 53318, UDP 53319, firewall
> **1-Line Summary:** Device-to-device board handoff on the same Wi-Fi with X25519 and AES-256-GCM, one-time codes, previews, and firewall self-checks.
* **User Intention (Non-Negotiable):** Classrooms must send boards without cloud or accounts, with Just-for-now versus Remember pairing, explicit accept/replace/keep-both, and no automatic acceptance.
* **Visual / UI Behavior:** Settings Share on this network off by default; pairing code shown on receiver; sender/board/size/preview shown before save; firewall repair on Windows with UAC, detect-only on macOS/Linux.
* **Code Anchors (Grep Targets):**
  * `sync/protocol.js` -> `PROTOCOL`, `createPairingCode`, `sealMessage`
  * `sync/node.js` -> `startDiscovery`, `sendBoard`
  * `sync/firewall.js` -> `checkFirewall`, `repairWindowsRules`
  * `sync/desktop.js` -> `openTransferDialog`, `confirmTransfer`

### [FEATURE: Workspace-Tabs-Storage] | Aliases: multi-tab, tab bar, boards panel, storage folder, autosave, atomic save
> **1-Line Summary:** Chrome-style tab strip with sub-5ms LRU session cache, board library in a chosen folder, and atomic temp-file-plus-rename saves.
* **User Intention (Non-Negotiable):** Students must switch boards instantly, keep tabs across restarts, and trust that an unclean shutdown still restores the last open board without a blank greeting.
* **Visual / UI Behavior:** Ctrl+T/W/Tab/1..9 shortcuts, tab undo cache, duplicate and session dialogs, Boards panel shows active folder with open button, Settings Storage Change folder with move-to-trash option.
* **Code Anchors (Grep Targets):**
  * `src/js/ui/tabs.js` -> `TabBar`, `WorkspaceSessionManager`
  * `storage-location.js` -> `readConfig`, `writeConfig`, `defaultBoardsDir`
  * `src/js/core/store.js` -> `checkpoint`, `atomicSave`
  * `src/js/core/recent.js` -> `recordLastOpen`, `loadRecent`
  * `src/js/core/folders.js` -> `listBoards`, `moveToTrash`

### [FEATURE: Media-Export] | Aliases: PNG export, SVG export, PDF export, WebM video, MP4 video, compression
> **1-Line Summary:** Export whole boards or selections to PNG at 2x, editable SVG, paginated PDF, and stitched WebM with audio by default plus MP4 with a no-sound notice.
* **User Intention (Non-Negotiable):** Students must share work anywhere, with correct page sizes and tiling, real vector text in SVG, and no silent video loss.
* **Visual / UI Behavior:** Export dialog with fixed/whole-board/follow framing, six video presets, MP4 shows translated no-sound warning, WebM default; compression studio with live before/after sizes.
* **Code Anchors (Grep Targets):**
  * `src/js/board-export.js` -> `exportPNG`, `exportSVG`, `exportPDF`
  * `src/js/export-video.js` -> `exportWebM`, `exportMP4`, `stitchSessions`
  * `src/js/core/compression.js` -> `compressImage`, `bulkCompress`
  * `src/js/ui/compression-dialog.js` -> `CompressionDialog`, `qualitySlider`

### [FEATURE: I18n-Offline] | Aliases: translations, 7 locales, offline, vendored, no CDN, service worker
> **1-Line Summary:** 100% i18n parity across 7 locales (2,245 keys) with every runtime library vendored locally and zero external CDN leaks.
* **User Intention (Non-Negotiable):** Non-English users must see every UI string translated and work fully offline on desktop and PWA, with board text measured consistently everywhere.
* **Visual / UI Behavior:** English sentence is the key via t(); missing translations fall back to English; board fonts bundled via @font-face rather than borrowed from the OS.
* **Code Anchors (Grep Targets):**
  * `src/js/i18n.js` -> `t`, `loadDictionary`, `LANGUAGES`
  * `src/locales/*.json` -> `keys`, `translations`
  * `src/vendor/libraries.json` -> `manifestVersion`, `bundledPath`
  * `scripts/i18n-check.js` -> `checkParity`
  * `src/sw.js` -> `precache`, `runtimeCache`

### [FEATURE: WISHLIST-Multi-Layer-System] | Aliases: layers, multi-layer standby, future feature
> **1-Line Summary:** Multi-layer board system kept intentionally on standby while other features ship safely.
* **User Intention:** Larger board organization beyond current infinite canvas, without destabilizing shipped behavior.
* **Target Integration Point:** `src/js/core/store.js` -> `doc.layers`, `src/js/core/render.js` -> `renderLayer`

### [FEATURE: Presentation-View-Mode-And-Page-Strip] | Aliases: view mode, page strip, music staff, guitar tab, table repair
> **1-Line Summary:** Read-only presentation view mode with fading ghost highlighters, thumbnail page strip, manuscript score templates, and automatic table corruption healing.
* **User Intention (Non-Negotiable):** Teachers and students need to walk through boards without accidental edits (`Ctrl+Alt+V`), browse pages via quick sidebar thumbnails, write music notes on standard 5-line staff / 6-line guitar tab, and open legacy or damaged tables without UI lockup.
* **Visual / UI Behavior:** View mode displays persistent top `#viewPill` with `Done` button; inking becomes temporary fading overlay; `#pagestrip` sidebar opens from left margin tab; background palette offers music staff and guitar tab; table loader auto-mends out-of-bounds tables up to 40x40.
* **Code Anchors (Grep Targets):**
  * `src/js/ui/pagestrip.js` -> `PageStrip`
  * `src/js/core/render.js` -> `drawStaves`, `staffLayout`
  * `src/js/core/surface.js` -> `ghosts`, `_drawGhosts`
  * `src/js/core/store.js` -> `repairTable`, `frozen`
  * `src/js/app.js` -> `toggleViewMode`, `hintViewMode`

### [FEATURE: Set-Squares-And-Protractor-Drafting] | Aliases: set squares, triangles, protractor, drafting, angle input, geometry tools
> **1-Line Summary:** Geometric set squares (30°/60°/90°, 45°/45°/90°) and protractor with edge snapping, dial/knob adjustment, typed angle aiming, and stylus-isolated drafting.
* **User Intention (Non-Negotiable):** Engineering students and technical drafters need precise geometric triangles and protractors to construct accurate diagrams, measure angles (0° pointing right or up), and draw edge-guided lines while strictly preserving audio-ink timestamps (`p.t`) and stylus-pointer partitioning.
* **Visual / UI Behavior:** Ruler menu offers Ruler, Triangle 45°, Triangle 30°/60°, and Protractor; protractor shows dual 0°–180° scales (outer dark, inner blue) with adjustable needle arm; set squares show millimeter ticks and angle readouts; drafting edge snapping engages exclusively for stylus writing without trapping mouse pointers; circuit connector wiring automatically bypasses ruler latching.
* **Code Anchors (Grep Targets):**
  * `src/js/core/tools.js` -> `triProject`, `protProject`, `triEdgesAt`, `protEdgesAt`, `aimProtArm`
  * `src/js/app.js` -> `openRulerMenu`, `fitTriangle`, `toggleRuler`
  * `test/set-squares-protractor.test.mjs` -> `triCorners`, `protGeom`

### [FEATURE: Rust-Native-Performance-Engines] | Aliases: bundle.rs, search.rs, audio_inspect.rs, geometry.rs, colorimetry.rs, markdown_parser.rs, power.rs
> **1-Line Summary:** Native Rust high-performance engine extensions delivering streaming multi-gigabyte ZIP packaging, SQLite FTS5 trigram search and PDF indexing, pure-Rust audio duration inspection, curve fitting, WCAG 2.1 color contrast and Oklch blending, safe CommonMark parsing with KaTeX, and battery monitoring.
* **User Intention (Non-Negotiable):** Keep the whiteboard completely lag-free regardless of library size, large PDF attachments, or continuous inking, offloading I/O and heavy computation to native background threads while preserving 100% offline invariants.
* **Visual / UI Behavior:** Instant search across all `.gaussboard` notes and embedded PDF pages; lossless archive export and import with SHA-256 integrity; seamless dark/light mode canvas ink inversion with WCAG AAA contrast safety; and smooth Catmull-Rom Bézier spline rendering without dropping audio timestamp anchors (`p.t`).
* **Code Anchors (Grep Targets):**
  * `src-tauri/src/bundle.rs` -> `bundle_export`, `bundle_import`
  * `src-tauri/src/search.rs` -> `init_search_db`, `search_boards`, `index_pdf_pages`
  * `src-tauri/src/audio_inspect.rs` -> `audio_inspect`
  * `src-tauri/src/geometry.rs` -> `stroke_simplify_and_fit`
  * `src-tauri/src/colorimetry.rs` -> `color_contrast_check`, `oklch_blend`, `invert_ink_colors`
  * `src-tauri/src/markdown_parser.rs` -> `markdown_to_html`
  * `src-tauri/src/power.rs` -> `get_power_status`
  * `src/js/platform/tauri-board.js` -> `window.board.archive`, `window.board.search`, `window.board.geometry`, `window.board.colorimetry`, `window.board.markdown`
  * `test/tauri-native-bridge.test.mjs` -> `tauri-board bridge suite`


## 3. Planned Features & App-Merge Wishlist

### [WISHLIST: Pane-Aware-Command-Dispatcher] | Aliases: pane commands, Delete routing, Copy routing
> **1-Line Summary:** Full per-pane Delete/Copy/Select-all/z-order routing for split workspace, beyond the current selection-clearing mitigation.
* **User Intention:** Commands should act on the pane the user pressed in, not always the primary board.
* **Target Integration Point:** `src/js/app.js` -> `dispatchCommand`, `src/js/ui/split-workspace.js` -> `activePane`

### [WISHLIST: Live-Collaboration-Seam] | Aliases: real-time collaboration, presence cursors, cloud boards
> **1-Line Summary:** Future live co-editing built on the operation log without changing the editor model.
* **User Intention:** Presence and shared editing if ever requested, while keeping offline-first handoff as the default.
* **Target Integration Point:** `src/js/core/store.js` -> `checkpoint`, `applyRemote`, `onOp`

## 4. Canonical References & Live Verification
* **Core Documentation Suite:** `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS_AND_TRAPS.md`, `docs/releases/ANDROID_READINESS.md`
* **Active Verification Suite:** `node scripts/smoke.js --new-features` (24/24 passing)
* **Internationalization Suite:** `node scripts/i18n-check.js` (2,380/2,380 across 7 locales)
* **Android Platform Suite:** `node --test test/android-*.test.js` (82/82 passing)
* **Tauri 2 Rust Native Port:** `src-tauri/` (Tauri 2.1 native host with custom `app://board/` protocol, crash-safe `<id>.json` storage, SHA-256 assets, Axum sync, Windows portable/NSIS/MSI, and v2/v3 signed Android ARM64 APK via `tauri-android` workflow)
* **Core Data Schemas & State:** `src/js/core/store.js` (`Store`, `doc.objects`, `doc.pages`, `doc.audioTracks`)
* **Platform & Packaging:** `main.js`, `preload.js`, `package.json`, `.github/workflows/tauri-release.yml`, `.github/workflows/tauri-android.yml`
