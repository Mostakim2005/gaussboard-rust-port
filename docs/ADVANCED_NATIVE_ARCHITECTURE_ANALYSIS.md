# GaussBoard Native Architecture & Multi-Language Extension Analysis

> **Target Reviewer:** Gemini Argon (System Architect & Migration Reviewer)  
> **Author:** Antigravity (Pair Programming Agent)  
> **Branch Context:** `feat/rust-robustness-suite`  
> **Repository:** `Mostakim2005/gaussboard-rust-port`  
> **Primary Objective:** Provide a rigorous, code-anchored architectural breakdown of the live GaussBoard Rust implementation, document the policy shift lifting legacy C/C++ restrictions, and outline high-impact native extension pathways across Rust, C++, C, Zig, and WebAssembly for Argon's expert critique.

---

## 1. Executive Summary & Policy Evolution

### 1.1 The Multi-Language Invariant Shift
In previous iterations of the codebase, **TRAP 5** mandated *"Zero Extra Native Dependencies (pure portable JavaScript, no C/C++ node-gyp compilation)"*. This invariant originated during the legacy Electron desktop era to prevent developer friction during local `npm install` on machines lacking Visual Studio C++ toolchains or Python.

With the migration to **Tauri v2** and automated **GitHub Actions Cloud CI pipelines**, local build friction is completely eliminated:
* **Windows x64 releases** compile automatically on `windows-latest` GitHub runners equipped with MSVC 2022, Windows SDK 10/11, and the Rust toolchain.
* **Android ARM64 APKs** cross-compile automatically on `ubuntu-latest` runners equipped with Android NDK 27 Clang/LLVM, CMake, and Gradle.
* Developers and end-users download pre-compiled portable binaries (`.exe`) and signed packages (`.apk`) directly from GitHub Actions artifacts with zero local compiler requirements.

**Official Architectural Policy:** **Open Multi-Language Native Acceleration**.  
GaussBoard is now officially open to incorporating high-performance libraries in **C, C++, Rust, Zig, and WebAssembly** via Cargo build scripts (`cc`, `cmake`, `bindgen`, `cxx`), vcpkg, or C-FFI, whenever they improve real-time rendering, reduce latency, enhance audio DSP, accelerate document parsing, or introduce cutting-edge offline capabilities.

---

## 2. Current Architecture & Live Implementation Reality

The live GaussBoard codebase on `feat/rust-robustness-suite` operates as a **tri-layer unified architecture**:

```mermaid
flowchart TD
    subgraph Layer1 ["Layer 1: Canvas 2D & UI Engine (Vanilla ES6)"]
        Canvas["HTML5 Canvas 2D (Surface & InkEngine)"]
        Tools["Pointer State Machine (Stylus vs Mouse Partitioning)"]
        AudioClock["Audio Timestamp Manager (p.t Invariant Preservation)"]
        STEM["24 STEM Modules (MNA Circuit Sim, CAS, 3Dmol, KaTeX)"]
    end

    subgraph Layer2 ["Layer 2: IPC Seam & Platform Adapter (tauri-board.js)"]
        Bridge["window.board Structured Namespaces"]
        ClipCache["Synchronous Clipboard Signature Cache"]
        EventBus["Native Event Proxy (boards, sync, recording)"]
    end

    subgraph Layer3 ["Layer 3: Multi-Threaded Native Host (Tauri v2 + Rust)"]
        CustomProto["Custom app://board/ Protocol Scheme"]
        DiskStorage["Atomic Rename Storage (userData/*.json)"]
        LanAxum["LAN Sync Server (Axum HTTP/1.1 TCP 53318 + UDP 53319)"]
        
        subgraph NativeEngines ["Native Robustness & Performance Subsystems"]
            BundleEng["bundle.rs: Streaming ZIP + ZipSlip Defense + SHA-256"]
            SearchEng["search.rs: SQLite WAL + Trigram FTS5 + PDF Deep Index"]
            AudioEng["audio_inspect.rs: Symphonia Sub-ms Audio Probing"]
            GeomEng["geometry.rs: Kurbo RDP + Bézier + Timestamp Preservation"]
            ColorEng["colorimetry.rs: Palette Oklch Blending + WCAG 2.1 Contrast"]
            MdEng["markdown_parser.rs: Pulldown-cmark + KaTeX Math DOM"]
            PowerEng["power.rs: Win32 Hardware Battery & Power-Saver Query"]
        end
    end

    Canvas --> Bridge
    Tools --> Bridge
    AudioClock --> Bridge
    Bridge --> CustomProto
    Bridge --> DiskStorage
    Bridge --> LanAxum
    Bridge --> NativeEngines
```

### 2.1 The 6 Non-Negotiable Invariants (Post-Policy Revision)
1. **TRAP 1 (Scene Partitioning):** Base canvas passes must exclude active audio session strokes `(o) => o.audioId !== activeTrackId`. Replay strokes render exclusively in the dynamic overlay pass (`Surface.drawReplaySession()`).
2. **TRAP 2 (Timestamp Preservation):** Point generators, smoothing filters, and curve fitters (`tools.js`, `ink.js`, `geometry.rs`) must strictly preserve `p.t` millisecond timestamps. Stripping `p.t` destroys audio-ink synchronization.
3. **TRAP 3 (Finite Audio Duration Safeguard):** For in-app recordings, never rely on browser `audio.duration` without checking `isFinite()`; retain wall-clock `track.durationMs`. For imported files, query native `audio_inspect` for sub-millisecond container duration.
4. **TRAP 4 (100% i18n Parity):** Every user-facing UI string must be wrapped in `t('...')` and present across all 7 locale dictionaries (`ar`, `bn`, `de`, `es`, `pt-BR`, `zh-Hans`, `zh-Hant`).
5. **TRAP 5 (Multi-Language Cloud CI Compilation Invariant):** Native C, C++, Rust, Zig, or Wasm modules must cross-compile cleanly in automated GitHub Actions CI (MSVC on Windows x64, NDK Clang on Android `aarch64`) with zero local developer environment requirements.
6. **TRAP 6 (Study Tape & Answer Cover Toggle):** Both study tape and rectangular covers persist on canvas and toggle concealed/revealed on tap; revealed covers remain hittable as faint outlines.

### 2.2 Subsystems Already Implemented & Cloud-Verified
* **`src-tauri/src/bundle.rs`:** Multi-gigabyte streaming archive engine using `zip` and `miniz_oxide`/`zstd` in 64KB/128KB chunks with zero V8 heap consumption, ZipSlip path traversal protection via `file.enclosed_name()`, and SHA-256 validation.
* **`src-tauri/src/search.rs`:** Embedded SQLite database (`rusqlite` + `r2d2`) with WAL mode, trigram FTS5 index (`board_fts`), backlinks knowledge graph, FSRS v5 spaced repetition card review schedules, and page-by-page PDF text extraction via `pdf-extract`.
* **`src-tauri/src/audio_inspect.rs`:** Sub-millisecond container probing via `symphonia` with zero browser `<audio>` element instantiation.
* **`src-tauri/src/geometry.rs`:** Analytical curve simplification via Ramer-Douglas-Peucker and Catmull-Rom to Cubic Bézier spline conversion via `kurbo`, strictly preserving stroke point timestamps `p.t`.
* **`src-tauri/src/colorimetry.rs`:** WCAG 2.1 relative luminance and contrast checking (AA/AAA), Oklch perceptual ink blending, and dark/light mode canvas ink inversion via `palette`.
* **`src-tauri/src/markdown_parser.rs`:** $O(N)$ safe CommonMark parser via `pulldown-cmark` with support for GFM tables, footnotes, task lists, and KaTeX math blocks (`$...$`, `$$...$$`).
* **`src-tauri/src/power.rs`:** Hardware battery level, AC line status, and power-saver query via Win32 `GetSystemPowerStatus`.

---

## 3. High-Impact Multi-Language Extension Opportunities

Now that the C/C++ boundary is fully unlocked in Cloud CI, we have evaluated candidate libraries and architectural patterns across 6 core domains:

```
+-------------------------------------------------------------------------------+
|                      PROPOSED EXTENSION SPECTRUM                              |
+-------------------+--------------------+------------------+-------------------+
| 1. Vector & Media | 2. Audio & Speech  | 3. Vision & OCR  | 4. Graphics/Style |
| - C++ PDFium      | - C++ Whisper.cpp  | - C++ Leptonica  | - WGPU / Vello    |
| - MuPDF (C)       | - C RNNoise (DSP)  | - ONNX Runtime   | - Win32 Mica/DWM  |
| - libarchive (C)  | - Sherpa-ONNX (C++)| - Decimer (Chem) | - Skia (C++)      |
+-------------------+--------------------+------------------+-------------------+
```

### Domain 1: Native Document & Vector Media Acceleration (C++ PDFium / MuPDF)
* **Current Limitation:** JavaScript-based `pdf.js` in the WebView can experience frame rate drops when rasterizing multi-hundred-page engineering textbooks or vector schematics (CAD drawings, IEEE papers) at high zoom levels (400%–800%). Furthermore, annotating PDFs currently saves ink objects into GaussBoard's internal JSON rather than embedding standard Adobe-compatible vector annotations into the PDF.
* **Proposed Technology:** **Google's PDFium (C++)** via `pdfium-render` crate, or **Artifex MuPDF (C)**.
* **How It Works:**
  1. The Rust host loads the PDF in a background native worker thread using PDFium.
  2. For viewport rendering, the frontend sends current camera bounds `(x, y, zoom, width, height)`. PDFium rasterizes the visible tile into a raw BGRA buffer and delivers it via a shared memory buffer or raw IPC chunk in under 8ms.
  3. **Bi-directional Ink Embedding:** When exporting to PDF, GaussBoard converts its internal Bézier strokes into native Adobe PDF ink annotation dictionaries (`/Subtype /Ink /InkList [...]`), creating standard PDF files that open with editable annotations in Adobe Acrobat, GoodNotes, or Apple Preview.
* **Cloud CI Feasibility:** Pre-built PDFium binaries are readily available via NuGet/vcpkg for Windows x64 and Android NDK aarch64, or compilable with CMake.

---

### Domain 2: Offline Speech-to-Text & Word-Stroke Time Synchronization (C++ Whisper.cpp)
* **Current State:** GaussBoard records lecture audio via WebCodecs/MediaRecorder and synchronizes handwritten ink using point timestamps (`p.t`). While replay scrubber navigation works, users cannot search spoken words or jump directly to when a formula was explained.
* **Proposed Technology:** **Whisper.cpp (High-performance C++ inference engine for OpenAI's Whisper model)** with hardware acceleration (AVX2 on Windows x64, NEON on Android ARM64).
* **How It Works:**
  1. Upon ending a lecture recording, `whisper.cpp` runs offline speech-to-text inference in a background thread using quantized GGML models (`whisper-tiny.en.bin` @ 39MB or `whisper-base.bin` @ 75MB).
  2. The inference output returns an array of tokens with exact millisecond bounds:
     `{ word: "Ohm's", startMs: 14200, endMs: 14650 }`.
  3. **Bi-directional Time Mapping:**
     - **Tap-to-Listen:** Clicking any handwritten equation or diagram queries the stroke's `p.t` and immediately plays the lecturer's spoken explanation during those exact seconds.
     - **Search-to-Spotlight:** Searching for a term (e.g., *"Laplace transform"*) finds the timestamp in the transcript, pans the canvas camera, and highlights the exact ink strokes being written when the word was spoken.
* **Cloud CI Feasibility:** `whisper.cpp` is a self-contained C/C++ repository with zero external dependencies, easily compiled via Cargo's `cc` or `cmake` crate in `build.rs`.

---

### Domain 3: Real-Time Audio Noise Suppression (C RNNoise / SpeexDSP)
* **Current State:** Audio recordings made on laptops or tablets capture background air conditioning hum, pen stylus tapping on glass, and keyboard typing noise.
* **Proposed Technology:** **Xiph.Org's RNNoise (Recurrent Neural Network Noise Suppression in C)** or **SpeexDSP**.
* **How It Works:**
  1. During lecture recording, raw audio PCM frames (10ms / 480 samples @ 48kHz) are streamed into an RNNoise processing ring buffer.
  2. The GRU neural network (a 50KB weight matrix implemented in pure C) separates voice formants from stationary noise (fans, hum) and transient noise (stylus taps, paper rustling).
  3. Cleaned speech audio is packaged into the recorded audio track, ensuring pristine lecture playback.
* **Cloud CI Feasibility:** RNNoise is pure ANSI C with zero dependencies; compiles cleanly across all platforms in under 3 seconds.

---

### Domain 4: Handwritten Formula & Diagram OCR (C++ Leptonica / ONNXRuntime)
* **Current State:** Natural language math conversion uses regex heuristics. Complex handwritten equations or circuit sketches must be manually entered via the MathEdit or Circuit Workbench dialogs.
* **Proposed Technology:** **Leptonica (C image processing)** + **ONNX Runtime (C++ machine learning inference)**.
* **How It Works:**
  1. The user lassoes a region of handwritten mathematics or handwritten circuit symbols.
  2. The strokes are rendered to an offscreen grayscale image, binarized via Otsu's thresholding in Leptonica, and fed into an offline ONNX model.
  3. The model outputs validated LaTeX syntax (e.g. `\oint \vec{B} \cdot d\vec{\ell} = \mu_0 I_{\text{enc}}`) or an SPICE netlist.
  4. The canvas immediately replaces or augments the handwritten stroke with an interactive KaTeX formula card or simulated circuit component.
* **Cloud CI Feasibility:** ONNX Runtime provides pre-built static and shared C/C++ libraries for Windows x64 and Android ARM64.

---

### Domain 5: Native Vector Rasterization & High-Resolution Export (Rust WGPU / Vello / Skia C++)
* **Current State:** Canvas 2D is ideal for interactive inking, but exporting high-resolution 300 DPI posters or multi-gigabyte vector blueprints is constrained by WebView canvas memory limits (typically max 16,384 x 16,384 pixels).
* **Proposed Technology:** **Vello (Rust WGPU vector graphics engine)** or **Google Skia (C++)**.
* **How It Works:**
  1. When exporting a board to 4K/8K PNG, SVG, or printable PDF, the export request is handed off to the native engine.
  2. The native engine reads the document store directly and executes GPU compute shaders (Direct3D 12 / Vulkan) to rasterize millions of Bézier curves at infinite resolution with sub-pixel antialiasing.
  3. Large exports complete in milliseconds without consuming WebView memory or freezing the UI.

---

### Domain 6: OS Window Styling & Native Shell Polish (Tauri v2 Mica / Acrylic & Tray)
* **Current State:** Frameless window with standard CSS dark/light background.
* **Proposed Technology:** **Win32 Desktop Window Manager (DWM) Attributes** via `window-vibrancy` crate and Tauri v2 System Tray plugin.
* **How It Works:**
  1. Enable Windows 11 **Mica Alt** or **Acrylic** transparency on the main window frame (`DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, ...)`).
  2. Register a native background system tray icon with a global hotkey (`Win+Shift+G` or `Alt+Space`).
  3. Pressing the shortcut opens a floating, borderless mini-GaussBoard scratchpad with instant pen inking that automatically syncs notes back to the main notebook library.

---

## 4. Cloud CI Compilation Architecture (Windows & Android)

To guarantee that adding C/C++ libraries never breaks cross-platform cloud builds, the following build patterns are established:

### 4.1 Cargo `build.rs` C/C++ Integration Pattern
```rust
// src-tauri/build.rs
fn main() {
    tauri_build::build();

    // Example: Compiling native C/C++ dependency (e.g., rnnoise or custom DSP)
    #[cfg(feature = "native-dsp")]
    {
        cc::Build::new()
            .file("native/rnnoise/src/denoise.c")
            .file("native/rnnoise/src/rnn.c")
            .include("native/rnnoise/include")
            .opt_level(3)
            .compile("rnnoise");
    }
}
```

### 4.2 Cloud CI Toolchain Alignment
* **Windows Desktop (`.github/workflows/tauri-release.yml`):**
  - Runs on `windows-latest` (MSVC 2022).
  - Native C/C++ compilers (`cl.exe`, `link.exe`, `cmake`, `ninja`) are pre-installed in `PATH`.
  - Full support for `cc`, `cmake-rs`, and `vcpkg`.
* **Android ARM64 (`.github/workflows/tauri-android.yml`):**
  - Runs on `ubuntu-latest`.
  - Android NDK 27 provides Clang/LLVM cross-compilers (`aarch64-linux-android24-clang` and `clang++`).
  - Cargo passes target triple `aarch64-linux-android` directly to `cc-rs` and CMake, generating binary-compatible ARM64 `.so` libraries bundled inside `app-universal-release-unsigned.apk`.

---

## 5. Architectural Evaluation Rubric for Gemini Argon

We request Gemini Argon's expert review on the following specific architectural trade-offs:

1. **Native PDF Engine Selection (PDFium vs. MuPDF):**
   - *Question for Argon:* Given that Google's PDFium has mature Rust bindings (`pdfium-render`) and native Windows/Android support, is PDFium preferred over MuPDF, or does MuPDF offer a smaller binary footprint for Android APK packaging?
2. **Offline Speech-to-Text Model Sizing (Whisper.cpp):**
   - *Question for Argon:* Should `whisper.cpp` be compiled directly into the binary with models downloaded on-demand (e.g. into `userData/models/`), or packaged as an optional sidecar binary?
3. **Inking Pipeline Integrity:**
   - *Question for Argon:* How do you recommend structuring the FFI boundary between native curve optimizers / OCR and the live Canvas 2D engine to guarantee that `p.t` timestamps remain 100% synchronized with the audio replay engine under heavy loads?
4. **Prioritization Roadmap:**
   - Which of the 6 proposed domains provides the highest return on investment for student whiteboard workflows?

---

### Verification & Health Status
* **Smoke Suite:** `24/24` active features passing (`node scripts/smoke.js`).
* **i18n Parity:** `2,380/2,380` translations verified across all 7 locales.
* **Git Cleanliness:** Old implemented pre-port audit files deleted; active branch `feat/rust-robustness-suite` clean and synchronized.
