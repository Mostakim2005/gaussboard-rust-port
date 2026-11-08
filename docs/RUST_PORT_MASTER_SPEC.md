# GaussBoard Rust Migration: Master Architectural Specification & Codebase Reference

> **Target Audience:** Gemini Argon (System Architect & Migration Planner) & Engineering Team  
> **Repository:** `Mostakim2005/gaussboard-rust-port`  
> **Source Base:** GaussBoard (`feat/upstream-risk-eval` @ commit `eaa397d`)  
> **Document Purpose:** Complete, authoritative master specification combining the initial 9-point architectural audit with the deep-dive transport, IPC, and disk schema specifications.

---

## Table of Contents
1. [Executive Summary & Architecture Scorecard](#1-executive-summary--architecture-scorecard)
2. [The 9 Architectural Discrepancies & Gap Analysis](#2-the-9-architectural-discrepancies--gap-analysis)
3. [LAN Sync Network Transport & Wire Protocol](#3-lan-sync-network-transport--wire-protocol)
4. [Dual-Runtime Platform Bridge (`window.board`) & Synchronous IPC](#4-dual-runtime-platform-bridge-windowboard--synchronous-ipc)
5. [Storage Architecture, Disk Schemas & Configuration](#5-storage-architecture-disk-schemas--configuration)
6. [Native Document Conversion & WebView2 PDF Printing](#6-native-document-conversion--webview2-pdf-printing)
7. [Multi-Window Lease Arbitration & Splash Screen Lifecycle](#7-multi-window-lease-arbitration--splash-screen-lifecycle)
8. [Directives for Porting Plan Revision 2.0](#8-directives-for-porting-plan-revision-20)

---

## 1. Executive Summary & Architecture Scorecard

The architectural shift proposed by Gemini Argon—retaining 100% of GaussBoard's Vanilla ES6 Canvas 2D engine, STEM toolchain (MNA Circuit Sim, CAS, 3Dmol, KaTeX), and WebCodecs/MediaRecorder pipelines while replacing Electron with Tauri 2 on Windows Edge WebView2—is **fully confirmed as the optimal migration path**.

Because WebView2 and Electron run identical Chromium Blink and V8 engines, the renderer requires zero logic rewrites. However, because Argon’s initial plan was designed from documentation without direct AST access to the codebase, critical discrepancies were discovered in IPC namespace shapes, wire-protocol cryptography, storage schemas, and headless PDF printing.

### Subsystem Verification Scorecard

| Subsystem | Audit Status | Resolution in Master Specification |
| :--- | :---: | :--- |
| **Renderer Engine & Canvas 2D** | **100% Retained** | Untouched; runs identically in Edge WebView2. |
| **Platform Bridge (`window.board`)** | **Restructured** | Swapped flat API for exact nested namespaces (`boards.*`, `storage.*`, `assets.*`, `recording.*`, `sync.*`). |
| **LAN Sync Wire Protocol** | **Corrected** | Aligned with `sync/protocol.js`: X25519 transcript salt, SAS HMAC confirmation, `XXXX-XXXX` alphabet, and AES-256-GCM with AAD. |
| **LAN Network Transport** | **Specified** | UDP 53319 IPv4 broadcast discovery + HTTP/1.1 REST server over TCP 53318. |
| **Storage & Board Formats** | **Aligned** | Internal library stores boards as `<id>.json` + `userData/board-index.json`. `.gaussboard` format is for export packages only. |
| **Clipboard Semantics** | **Calibrated** | `clipboardSignature()` is strictly synchronous in renderer; cached in JS adapter. `clipboardRead()` is async. |
| **Event Listeners (`on*`)** | **Calibrated** | Frontend ignores return values; no unlisten handles expected. |
| **Document Conversion** | **Expanded** | Added Microsoft Office COM automation engine (`msoffice.js`) alongside LibreOffice and WebView2 `PrintToPdfAsync`. |
| **Multi-Window Leases** | **Aligned** | Active-window focused model with `lease:state` and `board:externalUpdate` broadcast notifications. |
| **Splash Screen** | **Specified** | Frameless secondary window (`420x300`, `src/splash.html`) coordinated via `startupStep` and `startupDone`. |

---

## 2. The 9 Architectural Discrepancies & Gap Analysis

1. **`window.board` Namespace Shape:** The renderer expects nested namespaces (`window.board.boards.*`, `storage.*`, `assets.*`, etc.). A flat bridge causes immediate runtime `TypeError` exceptions on launch.
2. **Library File Extension:** Library boards are saved as `<id>.json`, not `<id>.gazboard`.
3. **LAN Sync Cryptography:** Pairing codes are never used as HKDF salt. HKDF salt is the canonical transcript of device IDs and public keys. Pairing codes authenticate the handshake via HMAC-SHA256 SAS confirmations.
4. **Document Conversion Engines:** In addition to LibreOffice and `convert.html`, GaussBoard includes a Windows-native Microsoft Office COM engine (`msoffice.js`) via PowerShell.
5. **PDF Printing in WebView2:** `convert.html` and `exportPdf` rely on Chromium's `printToPDF`. In Tauri 2, this requires calling WebView2's native `ICoreWebView2_7::PrintToPdfAsync` or CDP (`Page.printToPDF`).
6. **Omitted Asset & Recording Pipelines:** Content-addressed deduplication in `<boardsDir>/assets/<sha256>.<ext>` and live audio streaming (`recording:start`, `recording:appendChunk`, `recording:finish`) must be implemented in Rust.
7. **Window Lease Model:** Leases track the active editor window (`activeEditorWin`), not individual board IDs. Secondary windows receive read-only state and reload notifications.
8. **Test Runner Dependency:** `scripts/smoke.js` spawns the `electron` binary. `electron` must remain in `devDependencies` for headless regression testing during the hybrid phase.
9. **Custom URI Scheme:** Electron uses privileged `app://board/`. Tauri must register `app://` protocol so dynamic imports like `import('app://board/js/core/scratch.js')` resolve properly.

---

## 3. LAN Sync Network Transport & Wire Protocol

GaussBoard uses **UDP IPv4 Broadcast Discovery** paired with an **HTTP/1.1 REST Server over TCP**.

```
+-------------------------------------------------------------------------+
|                       GAUSSBOARD LAN SYNC ARCHITECTURE                  |
|                                                                         |
|  [Device A (Sender)]                               [Device B (Receiver)]|
|          |                                                  |           |
|          |---- UDP Broadcast (Port 53319, every 3s) ------->| (Discovers|
|          |<--- UDP Broadcast (Port 53319, every 3s) --------|   Peers)  |
|          |                                                  |           |
|          |=========== TCP HTTP/1.1 (Port 53318) ===========>|           |
|          |                                                  |           |
|          |  1. GET  /ping                                   |           |
|          |  2. POST /pair/hello                             | (X25519)  |
|          |  3. POST /pair/confirm                           | (SAS HMAC)|
|          |  4. POST /send (X-GazBoard-From, AES-256-GCM)    | (Payload) |
|          |  5. POST /paired                                 |           |
|          |  6. POST /unpair                                 |           |
+-------------------------------------------------------------------------+
```

### 3.1 Network Transport Constants
* **UDP Discovery Port:** `53319` (fixed, `reuseAddr: true`).
* **TCP Transfer Port:** `53318` (fixed default; if taken, falls back to ephemeral port `listen(0)` and advertises the assigned port via UDP).
* **Broadcast Targets:** All local interface subnet broadcast addresses (e.g., `192.168.1.255`) plus global `255.255.255.255`.
* **Timing:** Announcements every `3000 ms`, peer forgotten after `12000 ms`, send timeout `330000 ms` (5.5 minutes), pairing code TTL `300000 ms` (5 minutes).

### 3.2 Discovery Packet Schema (UDP 53319)
```json
{
  "t": "gazboard",
  "v": 1,
  "id": "e4f8b2d19c3a4e5f60718293a4b5c6d7",
  "name": "Prof. Smith (Lab PC)",
  "port": 53318,
  "a": ["192.168.1.105", "10.0.0.12"]
}
```

### 3.3 HTTP/1.1 REST Endpoints on TCP Port 53318
1. **`GET /ping`** $\rightarrow$ Heartbeat probe; returns `{"v": 1, "deviceId": "...", "name": "..."}`.
2. **`POST /pair/hello`** $\rightarrow$ Initiates X25519 exchange; sends `{v, deviceId, name, publicKey, port}`, returns responder's `{v, deviceId, name, publicKey}`.
3. **`POST /pair/confirm`** $\rightarrow$ Verifies pairing code via SAS HMAC proof; returns responder confirmation, human fingerprint (`XXXX-XXXX-XXXX`), and persistence status.
4. **`POST /send`** $\rightarrow$ Receives encrypted board payload; header `X-GazBoard-From: <deviceId>`, body is `WireEnvelope` with AAD; returns `{"accepted": true, "outcome": "replace"|"keep-both"|"declined"}`.
5. **`POST /paired`** $\rightarrow$ Verifies active pairing status using an encrypted challenge.
6. **`POST /unpair`** $\rightarrow$ Drops mutual pairing record.

### 3.4 Wire Cryptography Blueprint (`src-tauri/src/lan_sync/protocol.rs`)
```rust
use aes_gcm::{aead::{Aead, KeyInit, Payload}, Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

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

pub fn canonical_transcript(dev_a: &str, pub_a: &str, dev_b: &str, pub_b: &str) -> String {
    let end_a = format!("{}|{}", dev_a, pub_a);
    let end_b = format!("{}|{}", dev_b, pub_b);
    let (first, second) = if end_a <= end_b { (end_a, end_b) } else { (end_b, end_a) };
    format!("gazboard-pair/v{}\n{}\n{}", PROTOCOL_VERSION, first, second)
}

pub fn derive_device_key(shared_secret: &[u8; 32], dev_a: &str, pub_a: &str, dev_b: &str, pub_b: &str) -> [u8; 32] {
    let transcript = canonical_transcript(dev_a, pub_a, dev_b, pub_b);
    let hk = Hkdf::<Sha256>::new(Some(transcript.as_bytes()), shared_secret);
    let mut okm = [0u8; 32];
    hk.expand(b"gazboard-device-key", &mut okm).expect("32-byte expansion valid");
    okm
}

pub fn generate_confirmation(code: &str, transcript: &str, label: &str) -> Result<String, String> {
    let clean: String = code.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_uppercase();
    let mut mac = Hmac::<Sha256>::new_from_slice(clean.as_bytes()).map_err(|e| e.to_string())?;
    mac.update(format!("{}\n{}", label, transcript).as_bytes());
    Ok(BASE64.encode(mac.finalize().into_bytes()))
}

pub fn seal_envelope(device_key: &[u8; 32], aad: serde_json::Value, plaintext: &[u8]) -> Result<WireEnvelope, String> {
    let mut iv = [0u8; 12];
    OsRng.fill_bytes(&mut iv);
    let cipher = Aes256Gcm::new_from_slice(device_key).map_err(|e| e.to_string())?;
    let aad_bytes = serde_json::to_vec(&aad).map_err(|e| e.to_string())?;
    let payload = Payload { msg: plaintext, aad: &aad_bytes };
    let enc = cipher.encrypt(Nonce::from_slice(&iv), payload).map_err(|e| e.to_string())?;
    let tag_offset = enc.len() - 16;
    Ok(WireEnvelope {
        v: PROTOCOL_VERSION,
        iv: BASE64.encode(iv),
        tag: BASE64.encode(&enc[tag_offset..]),
        aad,
        body: BASE64.encode(&enc[..tag_offset]),
    })
}
```

---

## 4. Dual-Runtime Platform Bridge (`window.board`) & Synchronous IPC

### 4.1 Synchronous vs Async Contracts
* **`clipboardSignature()` is strictly SYNCHRONOUS:**
  The frontend calls `this.clipStamp = this.clipboardStamp()` in `app.js:3579`. Because Tauri IPC is async, `tauri-board.js` maintains a cached signature string updated on `window.onfocus`, `window.oncopy`, and `clipboardWrite()`. `clipboardSignature()` returns this cached string synchronously.
* **`clipboardRead()` is ASYNCHRONOUS:**
  Called only when pasting: `await window.board.clipboardRead()`.
* **`on*` Listeners IGNORE return values:**
  The frontend never captures or invokes unlisten callbacks. Background `listen()` bindings can run fire-and-forget.

### 4.2 Complete Drop-In Bridge Blueprint (`src/js/platform/tauri-board.js`)
```javascript
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export function installTauriBoardBridge() {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return false;

  let cachedSignature = null;
  const updateSignature = async () => {
    try { cachedSignature = await invoke('clipboard_signature'); } catch { cachedSignature = null; }
  };
  window.addEventListener('focus', updateSignature);
  window.addEventListener('copy', updateSignature);
  updateSignature();

  window.board = {
    info: () => invoke('app_info'),
    clipboardSignature: () => cachedSignature,
    clipboardRead: () => invoke('clipboard_read'),
    clipboardWrite: async (payload) => {
      const ok = await invoke('clipboard_write', { payload });
      await updateSignature();
      return ok;
    },

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
      onFlush: (cb) => { listen('storage:flush', (e) => cb(e.payload)); },
      onResume: (cb) => { listen('storage:resume', (e) => cb(e.payload)); },
      onChanged: (cb) => { listen('storage:changed', () => cb()); }
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
      onProgress: (cb) => { listen('updates:progress', (e) => cb(e.payload)); }
    },

    setLanguage: (code) => invoke('app_set_language', { code }),
    startupStep: (text) => invoke('app_startup_step', { text }),
    startupDone: (info) => invoke('app_startup_done', { info })
  };

  return true;
}
```

---

## 5. Storage Architecture, Disk Schemas & Configuration

### 5.1 Storage Locations & Configuration Files
1. **Board Index Cache (`userData/board-index.json`):**  
   Maintained on the local computer in `userData` to avoid file sync races on OneDrive/Google Drive:
   ```json
   {
     "version": 1,
     "dirs": {
       "C:\\Users\\kazir\\Documents\\GaussBoard": {
         "board-123.json": {
           "mtime": 1731075600000,
           "size": 48291,
           "meta": {
             "id": "board-123",
             "name": "Lecture 4",
             "objects": 42,
             "thumb": "data:image/webp;base64,...",
             "origin": null,
             "properties": null,
             "tags": null,
             "aliases": null
           }
         }
       }
     }
   }
   ```
2. **Custom Storage Path (`userData/storage-location.json`):**  
   `{"version": 1, "boardsDir": "C:\\Path\\To\\Folder"}`
3. **Last Board State (`userData/last-board.json`):**  
   `{"id": "board-123", "at": 1731075600000, "byFolder": {"<boardsDir>": "board-123"}}`
4. **User Preferences (`localStorage['gazboard.settings']`):**  
   Contains `language` (`'auto'`, `'en'`, `'bn'`, `'zh-Hans'`, `'ar'`, etc.), `theme`, `inkWithMouse`, folder hierarchies, and tool properties.
5. **LAN Identity (`userData/sync-identity.json`):**  
   `{"deviceId": "32_hex_chars", "name": "Computer Name"}`
6. **Remembered LAN Peers (`userData/sync-paired.json`):**  
   List of `{deviceId, name, key, lastAddress, lastPort, remember: true}` records.

### 5.2 Board Storage Rules
* Inside `boardsDir`, boards are saved as **`<id>.json`**.
* File writes must be atomic (write to temp file in same directory $\rightarrow$ flush $\rightarrow$ rename over target).
* `boards:list` scans `<boardsDir>`, stat-checks against `board-index.json`, extracts `BoardMeta`, updates the index if dirty, and returns items sorted by `modified` descending.

---

## 6. Native Document Conversion & WebView2 PDF Printing

GaussBoard incorporates three document conversion pathways:

1. **LibreOffice Headless (`soffice.exe`):**  
   Searches PATH and fixed drive roots `C:\` through `Z:\`. Invoked with `-env:UserInstallation=file:///...` to prevent desktop profile collisions.
2. **Microsoft Office COM Automation (`msoffice.js`):**  
   Available on Windows when Microsoft Office is installed. Invokes `Word.Application`, `Excel.Application`, and `PowerPoint.Application` out of sight using PowerShell COM automation to execute `ExportAsFixedFormat`.
3. **Built-in Webview Fallback (`convert.html`) & Board PDF Export (`exportPdf`):**  
   Both render HTML and require PDF generation. In Tauri 2 on Windows, the Rust backend invokes WebView2's native `ICoreWebView2_7::PrintToPdfAsync(outputPath, printSettings)` or CDP (`Page.printToPDF`) to produce the raw PDF bytes.

---

## 7. Multi-Window Lease Arbitration & Splash Screen Lifecycle

### 7.1 Single-Editor Active-Window Lease Arbitration
* GaussBoard arbitrates write access per window, not per board ID.
* Only the focused window is designated `activeEditorWin` (`isEditor: true`).
* When secondary windows gain focus, they invoke `window_claim_lease`.
* The backend broadcasts `lease:state` with `{ isEditor: boolean, windowCount: number }`.
* When an active editor saves a board, secondary windows receive `board:externalUpdate` (`{ id }`) so they can reload the updated JSON.

### 7.2 Splash Screen Coordination
* The splash screen is an independent frameless window (`420x300`, `src/splash.html`), skipped in `--smoke`.
* The main window initializes hidden (`visible: false`).
* Main process and renderer stream status updates (`window.board.startupStep("Opening board...")`) to the splash screen.
* When `src/js/app.js` mounts the canvas, it emits `startupDone`.
* The backend shows/maximizes the main window and closes the splash window.

---

## 8. Directives for Porting Plan Revision 2.0

When finalizing GaussBoard Porting Plan Revision 2.0, Gemini Argon should incorporate:
1. **The nested `window.board` bridge blueprint** from Section 4.2.
2. **The UDP 53319 + TCP 53318 HTTP/1.1 REST architecture** from Section 3.
3. **The X25519 transcript hashing & HMAC confirmation cryptography** from Section 3.4.
4. **The `<id>.json` library storage + `board-index.json` cache** from Section 5.
5. **The Microsoft Office COM engine & WebView2 `PrintToPdfAsync` binding** from Section 6.
6. **The multi-window lease arbitration & splashscreen workflow** from Section 7.
