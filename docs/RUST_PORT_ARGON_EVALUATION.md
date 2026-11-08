# GaussBoard Rust Migration: Architectural Audit & Codebase Evaluation

> **Target Audience:** Gemini Argon (System Architect & Migration Planner)  
> **Evaluator:** Antigravity (Audited with direct AST and source access across `GaussBoard` codebase)  
> **Source Commit Evaluated:** `feat/upstream-risk-eval` (`eaa397d`)  
> **Primary Objective:** Provide concrete, code-verified technical feedback on Argon's 3-Part Porting Plan so Plan Revision 2.0 achieves 100% wire-protocol compatibility, zero runtime type regressions, and true crash-safe storage parity.

---

## Executive Summary & Scorecard

Gemini Argon produced an exceptionally well-structured conceptual blueprint. The decision to retain 100% of the Vanilla ES6 and Canvas 2D engine while swapping the Electron host for Tauri 2 on Windows WebView2 is **architecturally sound, viable, and highly recommended**.

However, because Gemini Argon designed the plan exclusively from documentation without source-file access, **9 critical architectural disconnects** were identified when auditing against the live implementation. Implementing Argon’s plan as currently written would result in:
1. **Immediate boot crash** due to mismatched `window.board` namespaces in renderer modules (`app.js`, `panels.js`, `tabs.js`).
2. **Total LAN sync failure and network incompatibility** with existing GaussBoard / GazBoard peers due to conflicting HKDF derivation salts, pairing code alphabets, and missing AEAD Associated Data (AAD) envelopes.
3. **Library failure** caused by saving boards as `<id>.gazboard` instead of the internal `<id>.json` schema.
4. **Broken PDF export and document conversion** due to an unaddressed `printToPDF` dependency in WebView2.
5. **Silent loss of media and audio-ink synchronization** because the content-addressed asset store (`assetsDir`) and audio chunk streaming were omitted.

### Architecture Fidelity Scorecard

| Area | Argon Plan Grade | Codebase Reality & Critical Divergence |
| :--- | :---: | :--- |
| **High-Level Host Strategy** | **A+** | Tauri 2 + Edge WebView2 is 100% compatible with Canvas 2D, WebAudio & WebCodecs. |
| **Platform Seam (`window.board`)** | **D** | Argon used a flat API; codebase requires a heavily nested namespace (`boards.*`, `storage.*`, `assets.*`, `recording.*`, `sync.*`). |
| **Board File Storage Format** | **C** | Argon assumed `<id>.gazboard`; library files on disk are `<id>.json` with cached indexing. |
| **Atomic File I/O Safety** | **B+** | `tempfile` persist is good, but lacks Windows-specific sharing-violation fallback handling. |
| **Path & URL Security** | **A-** | Sound logic; needs `safeBoardId` regex and release URL domain pinning from `main.js`. |
| **LAN Sync Cryptography** | **F (Incompatible)** | Argon put pairing code in HKDF salt and used 6-digit PIN; wire protocol uses code for SAS HMAC confirmation, sorted transcript salt, and `XXXX-XXXX` base-32 alphabet. |
| **Document Conversion Engine** | **C** | Omitted the native Microsoft Office COM engine (`msoffice.js`) and stubbed out WebView2 `printToPDF`. |
| **Multi-Window Lease Model** | **C-** | Argon designed board-ID locking; codebase implements single-writer active-window lease arbitration. |
| **Smoke & Verification Pipeline**| **C+** | `scripts/smoke.js` directly requires and spawns `electron` binary; needs a standalone harness strategy. |

---

## Detailed Gap Analysis (9 Critical Discrepancies)

### Discrepancy 1: `window.board` API Structure Disconnect (Boot Breaker)
* **Argon's Assumption (Part 1, Section 3):**
  Argon drafted `src/js/platform/tauri-board.js` with a flat surface:
  `window.board.listBoards()`, `openBoard()`, `saveBoard()`, `moveToTrash()`, `readConfig()`, `writeConfig()`.
* **Codebase Reality (`preload.js` lines 162–304):**
  The entire renderer (`src/js/app.js`, `src/js/ui/panels.js`, `src/js/ui/tabs.js`, `src/js/ui/split-workspace.js`) expects structured namespaces:
  ```javascript
  window.board = {
    info: () => Promise<PlatformInfo>,
    boards: {
      list: () => Promise<BoardMeta[]>,
      load: (id) => Promise<BoardDoc>,
      save: ({ id, json, setLast }) => Promise<boolean>,
      remove: (id) => Promise<boolean>,
      last: () => Promise<string>,
      setLast: (id) => Promise<void>,
      resume: (opts) => Promise<ResumeResult>,
      migrate: () => Promise<void>
    },
    storage: {
      get: () => Promise<StorageInfo>,
      choose: () => Promise<ChooseResult>,
      apply: (opts) => Promise<boolean>,
      reset: (opts) => Promise<boolean>,
      deleteOld: (token) => Promise<boolean>,
      readCatalogue: () => Promise<any>,
      writeCatalogue: (json) => Promise<boolean>,
      flushAck: (ticket, ok) => Promise<void>,
      onFlush: (cb) => void,
      onResume: (cb) => void,
      onChanged: (cb) => void
    },
    assets: {
      put: (dataUrl) => Promise<{ id: string }>,
      get: (id) => Promise<string>, // returns data: URL
      have: (ids) => Promise<Record<string, boolean>>,
      putBinaryDirect: (assetId, buffer) => Promise<boolean>
    },
    recording: {
      start: (sessionId) => Promise<boolean>,
      appendChunk: (sessionId, chunk) => Promise<boolean>,
      finish: (sessionId, durationMs) => Promise<{ assetId: string, durationMs: number }>
    },
    sync: { /* full LAN sync namespace */ },
    claimLease: () => Promise<void>,
    getLeaseState: () => Promise<LeaseState>,
    onLeaseChanged: (cb) => void,
    onBoardExternalUpdate: (cb) => void,
    onOpenBoardById: (cb) => void,
    clipboardRead: () => Promise<ClipboardPayload>,
    clipboardWrite: (payload) => Promise<boolean>,
    clipboardSignature: () => string | null,
    importToPdf: (filePath, opts) => Promise<Uint8Array>,
    exportPdf: (payload) => Promise<Uint8Array>
  };
  ```
* **Required Fix for Argon:** The Tauri adapter must strictly implement these exact namespace paths.

---

### Discrepancy 2: Board File Storage vs Package Format (`.json` vs `.gazboard` / `.gaussboard`)
* **Argon's Assumption (Part 1, Section 4):**
  Argon assumed library files on disk are named `<id>.gazboard`:
  `let file_name = if board_id.ends_with(".gazboard") { ... } else { format!("{}.gazboard", board_id) };`
* **Codebase Reality (`storage-location.js`, `main.js:1578`, `main.js:1633`):**
  - **Internal library files are stored as `<id>.json`!**
  - `boards:list` filters `(await fsp.readdir(dir)).filter((f) => f.endsWith('.json'))`.
  - `.gaussboard` (formerly `.gazboard`) is exclusively the file extension for **exported packages** and desktop drag-and-drop imports.
  - In addition, `main.js` maintains a persistent fast index file (`.gazboard-index.json`) mapping `filename -> { mtime, size, meta }` so opening the "My Boards" panel does not read and JSON-parse 500+ board documents from disk every time.
* **Required Fix for Argon:** Store boards in `boardsDir` as `<id>.json` and maintain the metadata indexing cache in Rust.

---

### Discrepancy 3: LAN Handoff Cryptography & Wire Protocol Breakage
* **Argon's Assumption (Part 2, Section 1):**
  - HKDF salt: `pairing_code.as_bytes()`
  - Info: `b"gaussboard-lan-sync-v1"`
  - Pairing code: "6-digit code"
  - Encrypted payload: AES-256-GCM ciphertext without AAD envelope.
* **Codebase Reality (`sync/protocol.js` lines 18–175):**
  - **Security Invariant:** The pairing code is **NEVER** an input to key derivation! (`"The pairing code is deliberately NOT an input: it is a one-time proof of who is in the room, and a key that outlived it should not be recoverable from it."`).
  - **Key Agreement:**
    - X25519 diffie-hellman shared secret: `shared = x25519(my_priv, their_pub)`.
    - Canonical Transcript:
      ```
      gazboard-pair/v1\n
      ${min(devA|pubA, devB|pubB)}\n
      ${max(devA|pubA, devB|pubB)}
      ```
    - HKDF derivation: Salt = `transcript`, Info = `"gazboard-device-key"`, Hash = `SHA256`, Length = 32 bytes.
  - **Confirmation Proof (SAS):**
    - `HMAC-SHA256(key = normalise(code), data = "${label}\n${transcript}")` where label is `"confirm-a"` or `"confirm-b"`.
    - Verified using constant-time equality.
  - **Pairing Code Specification:**
    - Alphabet: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (32 characters, no ambiguous `0/O`, `1/I`).
    - Format: `XXXX-XXXX` (8 characters, 2 groups of 4 separated by a hyphen, ~40 bits of entropy).
  - **Wire Envelope:**
    ```json
    {
      "v": 1,
      "iv": "<base64 12 bytes>",
      "tag": "<base64 16 bytes auth tag>",
      "aad": { "type": "board", "sender": "..." },
      "body": "<base64 ciphertext>"
    }
    ```
* **Required Fix for Argon:** Update `lan_sync.rs` to follow `sync/protocol.js` verbatim so Tauri nodes can seamlessly interoperate with existing Electron and Android GaussBoard nodes on the local Wi-Fi.

---

### Discrepancy 4: The 3rd Converter Engine — Native Microsoft Office COM Automation
* **Argon's Assumption (Part 2, Section 2):**
  Argon documented LibreOffice and hidden-window `convert.html`.
* **Codebase Reality (`msoffice.js`):**
  GaussBoard includes a premier 3rd engine for Windows: **Microsoft Office COM automation** driven via PowerShell:
  - If a user has Microsoft Office installed (Word, Excel, PowerPoint), GaussBoard can invoke `Word.Application`, `Excel.Application`, and `PowerPoint.Application` out of sight to export fixed-format PDF (`ExportAsFixedFormat`).
  - It runs isolated, read-only, and leaves existing open user documents untouched.
  - Teachers and students rely on this for 100% layout and font fidelity when importing slides and sheets without installing LibreOffice.
* **Required Fix for Argon:** In Rust for Windows, document conversion can directly invoke the Windows COM interfaces (`winapi` / `windows-rs` or PowerShell fallback) for Word/PowerPoint/Excel.

---

### Discrepancy 5: The Hidden Window `printToPDF` Dilemma in WebView2
* **Argon's Assumption (Part 2, Section 2):**
  Argon drafted:
  ```rust
  // Trigger built-in conversion in convert.html and await returned PDF bytes
  Err("ROUTE_TO_BUILTIN_WEBVIEW_CONVERTER".into())
  ```
* **Codebase Reality (`main.js:1185–1245` & `convert.html`):**
  Both the fallback document converter (`convert.html`) and the board PDF exporter (`exportPdf`) work by loading rendered HTML inside an off-screen window and invoking Chromium's **`win.webContents.printToPDF()`**!
  - WebView2 in Tauri does **not** have an automatic JavaScript `window.printToPdf()` return method.
  - In Windows WebView2, printing to PDF is achieved via:
    1. **Native WebView2 COM API:** Calling `ICoreWebView2_7::PrintToPdfAsync(outputPath, printSettings, handler)`.
    2. **Chrome DevTools Protocol (CDP):** Calling `Page.printToPDF` over WebView2's `CallDevToolsProtocolMethod`.
* **Required Fix for Argon:** Provide the concrete Rust implementation invoking WebView2's native `PrintToPdfAsync` or CDP rather than leaving it as a runtime error.

---

### Discrepancy 6: Missing Content-Addressed Asset Subsystem & Audio Streaming
* **Argon's Assumption:**
  Argon did not model the `assets` or `recording` IPC subsystems.
* **Codebase Reality (`main.js:1650–1730`):**
  - **Content-Addressed Asset Store:** Pictures and rasterized PDF pages are stored in `<boardsDir>/assets/<sha256>.<ext>`. The renderer checks existence via `assets.have([ids])` and uploads via `assets.put(dataUrl)` or `assets.putBinaryDirect(assetId, buffer)`.
  - **Audio Session Streaming:** When recording audio-ink lectures, the renderer streams PCM/WebM audio chunks in real-time via `recording:start(sessionId)` and `recording:appendChunk(sessionId, chunk)`. On `recording:finish(sessionId, durationMs)`, the backend finalizes the write stream, calculates the SHA-256 hash, renames it into `assets/<hash>.webm`, and returns `{ assetId, durationMs }`.
* **Required Fix for Argon:** Add `assets.rs` and `recording.rs` to handle content-addressed deduplication and chunked streaming.

---

### Discrepancy 7: Multi-Window Lease Model & Active-Window Arbitration
* **Argon's Assumption (Part 3, Section 1):**
  Argon modeled board-level leases:
  `lease_acquire(board_id)`, `lease_release(board_id)`.
* **Codebase Reality (`main.js:702–724`):**
  - GaussBoard uses a **per-window single-editor model**:
    - Only the currently focused window is granted `isEditor: true`.
    - When a secondary window opens or gains focus, `window:claimLease` is called.
    - The backend broadcasts `lease:state` with `{ isEditor: boolean, windowCount: number }`.
    - When a board is saved in the active editor, the backend broadcasts `board:externalUpdate` with `{ id }` to secondary windows so they can cleanly reload the updated JSON.
  - Multi-board side-by-side editing within the same window is managed entirely inside `src/js/ui/split-workspace.js` using dual `Store` instances and an `activePane` pointer.
* **Required Fix for Argon:** Align `lease.rs` with `activeEditorWin` focus tracking and `lease:state` broadcasting.

---

### Discrepancy 8: Verification Runner (`scripts/smoke.js`) Hardcoded to Electron
* **Argon's Assumption (Part 3, Section 3):**
  "Run `node scripts/smoke.js --new-features` to verify all 24 directive checks pass prior to building the Rust shell."
* **Codebase Reality (`scripts/smoke.js` lines 20 & 52):**
  ```javascript
  const electron = require('electron'); // Spawns Electron binary
  spawnSync(electron, args, { stdio: 'inherit', env });
  ```
  `scripts/smoke.js` explicitly requires and executes the `electron` binary. If Electron is removed from `package.json`, `npm test` and `scripts/smoke.js` fail immediately.
* **Required Fix for Argon:** Detail the test harness migration:
  - **Option A (Recommended for hybrid stage):** Keep `electron` in `devDependencies` strictly as an automated headless smoke runner for the unchanged renderer modules.
  - **Option B (Pure Rust):** Implement a `tauri-driver` / WebDriver suite or Playwright browser runner targeting the built static web assets (`dist-web`).

---

### Discrepancy 9: Custom URI Scheme (`app://board/`) vs Tauri Default Origins
* **Argon's Assumption:**
  Argon assumed standard relative or asset loading.
* **Codebase Reality (`main.js:158`, `test/smoke-new-features.js:12`, `convert.html`):**
  - In Electron, `main.js` registers `protocol.handle('app', ...)` serving files from `src/` under `app://board/`.
  - Smoke tests and dynamic imports use absolute scheme URIs:
    `const { isScratchGesture } = await import('app://board/js/core/scratch.js');`
  - In Tauri 2 on Windows, the default origin is `http://tauri.localhost` or `https://tauri.localhost`.
* **Required Fix for Argon:** Register a custom URI scheme protocol in Tauri:
  ```rust
  tauri::Builder::default()
      .register_uri_scheme_protocol("app", |_app, req| { ... })
  ```
  This guarantees that all dynamic imports, Web Workers, and CSP rules expecting `app://board/` execute without path re-writing.

---

## Concrete Rust Implementation Blueprints for Argon Revision 2.0

### 1. Corrected Wire-Compatible Cryptography (`src-tauri/src/lan_sync/protocol.rs`)

```rust
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::cmp::Ordering;

pub const PROTOCOL_VERSION: u32 = 1;
pub const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WireEnvelope {
    pub v: u32,
    pub iv: String,
    pub tag: String,
    pub aad: serde_json::Value,
    pub body: String,
}

pub fn canonical_transcript(
    dev_a: &str,
    pub_a_b64: &str,
    dev_b: &str,
    pub_b_b64: &str,
) -> String {
    let end_a = format!("{}|{}", dev_a, pub_a_b64);
    let end_b = format!("{}|{}", dev_b, pub_b_b64);
    let (first, second) = if end_a <= end_b {
        (end_a, end_b)
    } else {
        (end_b, end_a)
    };
    format!("gazboard-pair/v{}\n{}\n{}", PROTOCOL_VERSION, first, second)
}

pub fn derive_device_key(
    shared_secret_32: &[u8; 32],
    dev_a: &str,
    pub_a_b64: &str,
    dev_b: &str,
    pub_b_b64: &str,
) -> [u8; 32] {
    let transcript = canonical_transcript(dev_a, pub_a_b64, dev_b, pub_b_b64);
    let hk = Hkdf::<Sha256>::new(Some(transcript.as_bytes()), shared_secret_32);
    let mut okm = [0u8; 32];
    hk.expand(b"gazboard-device-key", &mut okm)
        .expect("32-byte HKDF expansion is always valid");
    okm
}

pub fn generate_confirmation(
    pairing_code: &str,
    transcript: &str,
    label: &str,
) -> Result<String, String> {
    let clean_code: String = pairing_code
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_uppercase();

    let mut mac = Hmac::<Sha256>::new_from_slice(clean_code.as_bytes())
        .map_err(|e| e.to_string())?;
    mac.update(format!("{}\n{}", label, transcript).as_bytes());
    Ok(BASE64.encode(mac.finalize().into_bytes()))
}

pub fn seal_envelope(
    device_key: &[u8; 32],
    aad_json: serde_json::Value,
    plaintext: &[u8],
) -> Result<WireEnvelope, String> {
    let mut iv = [0u8; 12];
    OsRng.fill_bytes(&mut iv);

    let cipher = Aes256Gcm::new_from_slice(device_key).map_err(|e| e.to_string())?;
    let aad_bytes = serde_json::to_vec(&aad_json).map_err(|e| e.to_string())?;

    let payload = Payload {
        msg: plaintext,
        aad: &aad_bytes,
    };

    let ciphertext_with_tag = cipher
        .encrypt(Nonce::from_slice(&iv), payload)
        .map_err(|e| e.to_string())?;

    // In Rust aes-gcm, the 16-byte auth tag is appended at the end of ciphertext
    let tag_offset = ciphertext_with_tag.len() - 16;
    let body_bytes = &ciphertext_with_tag[..tag_offset];
    let tag_bytes = &ciphertext_with_tag[tag_offset..];

    Ok(WireEnvelope {
        v: PROTOCOL_VERSION,
        iv: BASE64.encode(iv),
        tag: BASE64.encode(tag_bytes),
        aad: aad_json,
        body: BASE64.encode(body_bytes),
    })
}
```

---

### 2. Full Dual-Runtime Platform Bridge (`src/js/platform/tauri-board.js`)

```javascript
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export function installTauriBoardBridge() {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return false;
  }

  window.board = {
    info: () => invoke('app_info'),

    boards: {
      list: () => invoke('boards_list'),
      load: (id) => invoke('boards_load', { id }),
      save: (payload) => invoke('boards_save', { payload }),
      remove: (id) => invoke('boards_delete', { id }),
      last: () => invoke('boards_get_last'),
      setLast: (id) => invoke('boards_set_last', { id }),
      resume: (opts) => invoke('boards_resume', { opts }),
      migrate: () => invoke('boards_migrate')
    },

    storage: {
      get: () => invoke('storage_get'),
      choose: () => invoke('storage_choose'),
      apply: (opts) => invoke('storage_apply', { opts }),
      reset: (opts) => invoke('storage_reset', { opts }),
      deleteOld: (token) => invoke('storage_delete_old', { token }),
      readCatalogue: () => invoke('storage_catalogue_read'),
      writeCatalogue: (json) => invoke('storage_catalogue_write', { json }),
      flushAck: (ticket, ok) => invoke('storage_flush_ack', { ticket, ok }),
      onFlush: (cb) => listen('storage:flush', (e) => cb(e.payload)),
      onResume: (cb) => listen('storage:resume', (e) => cb(e.payload)),
      onChanged: (cb) => listen('storage:changed', () => cb())
    },

    assets: {
      put: (dataUrl) => invoke('assets_put', { dataUrl }),
      get: (id) => invoke('assets_get', { id }),
      have: (ids) => invoke('assets_have', { ids }),
      putBinaryDirect: (assetId, buffer) => invoke('assets_put_binary_direct', { assetId, buffer })
    },

    recording: {
      start: (sessionId) => invoke('recording_start', { sessionId }),
      appendChunk: (sessionId, chunk) => invoke('recording_append_chunk', { sessionId, chunk }),
      finish: (sessionId, durationMs) => invoke('recording_finish', { sessionId, durationMs })
    },

    sync: {
      state: () => invoke('sync_state'),
      start: () => invoke('sync_start'),
      stop: () => invoke('sync_stop'),
      setName: (name) => invoke('sync_set_name', { name }),
      beginPairing: (opts) => invoke('sync_begin_pairing', { opts }),
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
      onPeers: (fn) => listen('sync:peers', (e) => fn(e.payload)),
      onReceiving: (fn) => listen('sync:receiving', (e) => fn(e.payload)),
      onIncoming: (fn) => listen('sync:incoming', (e) => fn(e.payload)),
      onSendProgress: (fn) => listen('sync:sendProgress', (e) => fn(e.payload)),
      answer: (ticket, outcome) => invoke('sync_answer', { ticket, outcome })
    },

    claimLease: () => invoke('window_claim_lease'),
    getLeaseState: () => invoke('window_get_lease_state'),
    onLeaseChanged: (cb) => listen('lease:state', (e) => cb(e.payload)),
    onBoardExternalUpdate: (cb) => listen('board:externalUpdate', (e) => cb(e.payload)),
    onOpenBoardById: (cb) => listen('board:openById', (e) => cb(e.payload)),

    clipboardRead: () => invoke('clipboard_read'),
    clipboardWrite: (payload) => invoke('clipboard_write', { payload }),
    clipboardSignature: () => invoke('clipboard_signature'),

    importToPdf: (filePath, opts) => invoke('import_to_pdf', { filePath, opts }),
    importTakesBytes: true,
    exportPdf: (payload) => invoke('export_pdf', { payload }),

    openReleases: (url) => invoke('shell_open_external', { url }),
    checkForUpdate: () => invoke('updates_check'),
    updates: {
      mode: () => invoke('updates_mode'),
      download: (version) => invoke('updates_download', { version }),
      install: (opts) => invoke('updates_install', { opts }),
      note: () => invoke('updates_note'),
      onProgress: (cb) => listen('updates:progress', (e) => cb(e.payload))
    },

    setLanguage: (code) => invoke('app_set_language', { code }),
    startupStep: (text) => invoke('app_startup_step', { text }),
    startupDone: (info) => invoke('app_startup_done', { info })
  };

  return true;
}
```

---

## Action Plan for Gemini Argon (Revision 2.0 Directives)

When passing this document to Gemini Argon, request the following specific revisions:

1. **Adopt Namespace Parity:** Revise Part 1, Section 3 to replace the flat bridge with the structured namespace blueprint above.
2. **Standardize Storage to `<id>.json` + `.gazboard-index.json`:** Update `storage.rs` to persist boards as `<id>.json` and implement the in-memory mtime metadata cache.
3. **Align LAN Sync Wire Protocol:** Replace the hypothetical HKDF and AES-GCM code in Part 2 with the exact X25519 transcript hashing, HMAC pairing confirmation, and AAD envelope handling from `sync/protocol.js`.
4. **Integrate Microsoft Office COM Engine:** Add the Windows COM automation recipe to Part 2 alongside LibreOffice headless conversion.
5. **Resolve the WebView2 `printToPdf` Implementation:** Provide the native Win32 `CoreWebView2.PrintToPdfAsync` binding in Rust for off-screen PDF export and `convert.html` rasterization.
6. **Incorporate `assets` and `recording` Subsystems:** Detail the content-addressed SHA-256 asset store and chunked audio streaming pipeline.
7. **Transition Smoke Tests:** Explicitly outline the verification strategy to retain Electron in `devDependencies` for existing regression tests while building the production binary via Tauri 2.
