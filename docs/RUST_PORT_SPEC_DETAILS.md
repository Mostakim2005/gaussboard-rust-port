# GaussBoard Rust Migration: Network Transport, IPC Seam & Disk Schema Specification

> **Target Audience:** Gemini Argon (System Architect & Migration Planner)  
> **Source Codebase:** GaussBoard (`feat/upstream-risk-eval`)  
> **Companion Document:** `docs/RUST_PORT_ARGON_EVALUATION.md`  
> **Purpose:** Concrete technical specification answering the 3 architectural queries regarding LAN sync transport, synchronous IPC semantics, disk index/config schemas, and splash window mechanics.

---

## 1. LAN Sync Network Transport & Discovery (`sync/`)

GaussBoard uses **Option A**: **UDP Broadcast Discovery (IPv4)** paired with an **HTTP/1.1 REST Server over TCP**. It does **not** use raw TCP sockets or WebSockets for transfers.

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

### 1.1 Port Numbers & Timing Constants (`sync/node.js`)
* **Discovery Port:** `53319` (UDP, fixed, `reuseAddr: true`)
* **Transfer Port:** `53318` (TCP HTTP/1.1 server; if taken by another process, falls back to `listen(0)` ephemeral port and broadcasts the allocated port in UDP announcements)
* **Announcement Interval:** `3000 ms` (`ANNOUNCE_EVERY_MS`)
* **Peer Stale Timeout:** `12000 ms` (`PEER_FORGOTTEN_AFTER_MS`)
* **Pairing Code TTL:** `300000 ms` (5 minutes, `P.CODE_TTL_MS`)
* **Max Attempts Per Device:** `5` (`P.CODE_MAX_ATTEMPTS`)
* **Max Request Payload:** `64 MB` (`MAX_BOARD_BYTES` for `/send`), `8 KB` (`MAX_PAIR_BYTES` for `/pair/*`)
* **Send Response Timeout:** `330000 ms` (5.5 minutes, `SEND_TIMEOUT_MS`, allowing the receiver human time to review the incoming preview dialog)

---

### 1.2 Discovery Packet (UDP 53319)

Announcements are sent via UDP broadcast every 3 seconds to:
1. Every local network adapter's computed subnet broadcast address (e.g. `192.168.1.255` for `192.168.1.50/24`).
2. Global limited broadcast fallback: `255.255.255.255`.

#### Announcement JSON Structure:
```json
{
  "t": "gazboard",
  "v": 1,
  "id": "e4f8b2d19c3a4e5f60718293a4b5c6d7",
  "name": "Prof. Smith (Lab PC)",
  "port": 53318,
  "a": [
    "192.168.1.105",
    "10.0.0.12"
  ]
}
```

* `t`: Protocol identifier literal `"gazboard"`.
* `v`: Protocol version integer (`1`).
* `id`: 32-character hex device ID (randomly generated once and stored in `userData/sync-identity.json`).
* `name`: Human-readable device display name (defaults to `os.hostname()`, max 64 chars).
* `port`: The listening TCP HTTP port (usually `53318`).
* `a`: Up to 6 active non-self-assigned IPv4 addresses sorted by priority (ignoring `169.254.x.x` unless no other IP exists).

---

### 1.3 HTTP/1.1 Endpoints on TCP 53318 (`sync/node.js`)

All endpoints serve `content-type: application/json` with `cache-control: no-store`.

#### 1. `GET /ping`
* **Purpose:** Heartbeat probe (`knock`) to quickly verify which IP address of a peer is reachable.
* **Response `(200 OK)`:**
  ```json
  { "v": 1, "deviceId": "<id>", "name": "<name>" }
  ```

#### 2. `POST /pair/hello`
* **Request Body:**
  ```json
  {
    "v": 1,
    "deviceId": "<initiator_id>",
    "name": "<initiator_name>",
    "publicKey": "<initiator_x25519_spki_base64>",
    "port": 53318
  }
  ```
* **Response `(200 OK)`:**
  ```json
  {
    "v": 1,
    "deviceId": "<responder_id>",
    "name": "<responder_name>",
    "publicKey": "<responder_x25519_spki_base64>"
  }
  ```

#### 3. `POST /pair/confirm`
* **Request Body:**
  ```json
  {
    "v": 1,
    "deviceId": "<initiator_id>",
    "confirm": "<hmac_sha256_base64(key=clean_code, data='initiator\\n' + transcript)>"
  }
  ```
* **Response `(200 OK)`:**
  ```json
  {
    "v": 1,
    "deviceId": "<responder_id>",
    "name": "<responder_name>",
    "confirm": "<hmac_sha256_base64(key=clean_code, data='responder\\n' + transcript)>",
    "fingerprint": "7MPU-K7TM-9X2B",
    "remembered": false
  }
  ```
* **Error `(403 Forbidden)`:** `{"error": "wrong code", "attemptsLeft": 4}`

#### 4. `POST /send`
* **Request Headers:**
  * `Content-Type: application/json`
  * `X-GazBoard-From: <sender_deviceId>`
* **Request Body (WireEnvelope):**
  ```json
  {
    "v": 1,
    "iv": "<base64_12_bytes>",
    "tag": "<base64_16_bytes>",
    "aad": {
      "from": "<sender_deviceId>",
      "kind": "board",
      "v": 1,
      "port": 53318,
      "name": "<sender_name>"
    },
    "body": "<base64_ciphertext_of_board_json>"
  }
  ```
* **Response `(200 OK)`:**
  ```json
  {
    "accepted": true,
    "outcome": "replace" // or "keep-both" / "declined"
  }
  ```

#### 5. `POST /paired`
* **Purpose:** Asks peer if pairing is still recognized.
* **Payload:** Sealed envelope containing plaintext `<my_deviceId>`.
* **Response `(200 OK)`:** `{"paired": true}` or `{"paired": false}`.

#### 6. `POST /unpair`
* **Purpose:** Drops pairing record.
* **Payload:** Sealed envelope with `<my_deviceId>`.
* **Response `(200 OK)`:** `{"ok": true}`.

---

## 2. Synchronous vs. Async Methods on `window.board` (`preload.js`)

### 2.1 `clipboardSignature()`: STRICTLY SYNCHRONOUS
* **Frontend Usage (`src/js/app.js`):**
  * `this.clipStamp = this.clipboardStamp();` in `copy()` (line 3579)
  * `this.clipStamp = this.clipboardStamp();` in `cut()` (line 3660)
  * `const now = this.clipboardStamp();` in `paste()` (line 3887)
  * `if (now && this.clipStamp && now === this.clipStamp) { ... }`
* **Analysis:**
  The frontend expects a synchronous string return (`string | null`). If `clipboardSignature()` returns a `Promise`, the identity check `now === this.clipStamp` compares Promise object references, causing the board's internal clipboard to fail to disambiguate against external paste events.
* **Tauri 2 Implementation Recipe:**
  Because Tauri IPC `invoke()` is asynchronous, `tauri-board.js` must maintain an **in-memory cached signature**:
  1. Initialize `let cachedSignature = null;` in `tauri-board.js`.
  2. Refresh `cachedSignature` asynchronously on `window.addEventListener('focus', ...)`, `window.addEventListener('copy', ...)`, and whenever `window.board.clipboardWrite()` is called.
  3. `window.board.clipboardSignature()` synchronously returns `cachedSignature`.
* **Note on `clipboardRead()`:**
  `window.board.clipboardRead()` **is asynchronous** in the frontend (`await window.board?.clipboardRead?.()`), so it maps directly to `invoke('clipboard_read')`.

### 2.2 `on*` Event Listeners: IGNORE RETURN VALUES
* **Frontend Usage (`app.js`, `panels.js`, `split-workspace.js`):**
  * `window.board.onMenu((id) => this.command(id));`
  * `window.board.onFlush(() => flushForStorageSwitch());`
  * `window.board.sync.onPeers((peers) => { ... });`
  * `window.board.onLeaseChanged?.((state) => { ... });`
  * `window.board.onBoardExternalUpdate?.(async (info) => { ... });`
* **Analysis:**
  In all cases, the frontend **completely ignores the return value**. No code assigns `const unsub = window.board.on*()` or ever calls an unlisten handle.
* **Tauri 2 Implementation Recipe:**
  In `tauri-board.js`, simply call `listen('event-name', (e) => cb(e.payload))` without awaiting:
  ```javascript
  onLeaseChanged: (cb) => { listen('lease:state', (e) => cb(e.payload)); }
  ```

---

## 3. Exact JSON Keys for Disk Index & Config (`main.js` / `storage-location.js`)

### 3.1 Board Index Cache (`userData/board-index.json`)
The board index is stored in the user's application data folder, **not** inside the boards directory (preventing cross-sync conflicts on Google Drive / OneDrive).

* **File Path:** `path.join(app.getPath('userData'), 'board-index.json')`
* **Schema:**
```json
{
  "version": 1,
  "dirs": {
    "C:\\Users\\kazir\\Documents\\GaussBoard": {
      "board-2026-11-08-a1b2.json": {
        "mtime": 1731075600000,
        "size": 48291,
        "meta": {
          "id": "board-2026-11-08-a1b2",
          "name": "EE201 Lecture 4: Nodal Analysis",
          "objects": 124,
          "thumb": "data:image/webp;base64,UklGR...",
          "origin": null,
          "properties": {
            "tags": ["circuits", "ee201"],
            "aliases": ["lecture4"]
          },
          "tags": ["circuits", "ee201"],
          "aliases": ["lecture4"]
        }
      }
    }
  }
}
```

#### `BoardMeta` Object Returned by `window.board.boards.list()`:
```typescript
interface BoardMeta {
  id: string;                // raw.id || filename without .json
  name: string;              // raw.name || raw.title || "Untitled board"
  objects: number;           // (raw.objects || []).length
  thumb: string | null;      // data:image/webp;base64,... or null
  origin: string | null;     // imported source path or null
  properties: object | null; // arbitrary board properties or null
  tags: string[] | null;     // raw.tags || raw.properties?.tags || null
  aliases: string[] | null;  // raw.aliases || raw.properties?.aliases || null
  modified: number;          // st.mtimeMs (epoch milliseconds)
}
```
Sorted descending by `modified` (`b.modified - a.modified`).

---

### 3.2 Settings & Configuration Files

GaussBoard partitions configuration across three distinct locations:

| Setting Type | Storage Location | Exact Keys & Format |
| :--- | :--- | :--- |
| **Custom Boards Directory** | `userData/storage-location.json` | `{"version": 1, "boardsDir": "C:\\Absolute\\Path"}` |
| **Last Active Board** | `userData/last-board.json` | `{"id": "board-id", "at": 1731075600000, "byFolder": {"<boardsDir>": "board-id"}}` |
| **User Settings & Language** | `localStorage['gazboard.settings']` | `{"language": "en", "theme": "auto", "inkWithMouse": "auto", "folders": [], "boardFolders": {}}` |
| **LAN Device Identity** | `userData/sync-identity.json` | `{"deviceId": "32_hex_chars", "name": "Computer Name"}` |
| **Remembered LAN Peers** | `userData/sync-paired.json` | `[{"deviceId": "...", "name": "...", "key": "<base64>", "lastAddress": "192.168.1.5", "lastPort": 53318, "remember": true}]` |

* **Language Resolution:**
  `src/js/i18n.js` reads `JSON.parse(localStorage.getItem('gazboard.settings')).language || 'auto'`.
  When a language is resolved (`en`, `bn`, `zh-Hans`, `zh-Hant`, `ar`, `es`, `pt-BR`, `de`), the frontend calls `window.board.setLanguage(code)`.

---

### 3.3 Splash Screen Mechanics (`startupStep` / `startupDone`)

* **Execution Model:**
  The splash screen is a **SEPARATE, FRAMELESS `BrowserWindow`** (`420x300`), not an in-page `<div>` inside `index.html`.
* **Electron Lifecycle (`main.js:2003–2025`):**
  1. `showSplash()` creates a frameless `BrowserWindow` loading `src/splash.html?v=<version>`.
  2. `mainWindow` is created with `{ show: false }`.
  3. While booting, the main process and renderer invoke:
     * `splashStatus(text)` $\rightarrow$ calls `splash.webContents.executeJavaScript('window.setStatus(...)')`.
     * `window.board.startupStep(text)` (from `app.js:822`) updates the splash text: `"Opening “Untitled board”…"`.
  4. Once `app.js` finishes mounting the canvas and last board, it calls:
     ```javascript
     window.board.startupDone({ page: { settled: Math.round(performance.now()) } });
     ```
  5. On `app:startupDone`, `main.js` calls `revealMainWindow()`:
     * `mainWindow.show()` (or `maximize()`)
     * `closeSplash()` destroys the splash window.
     * Skipped entirely when launched with `--smoke` or `GAZBOARD_NO_SPLASH=1`.

* **Tauri 2 Implementation Pattern:**
  In `tauri.conf.json`, define two windows:
  1. `"label": "main"`, `"visible": false`
  2. `"label": "splashscreen"`, `"url": "splash.html"`, `"width": 420`, `"height": 300`, `"decorations": false`
  In Rust, listen for `app_startup_done` or `startupDone` from the `main` window $\rightarrow$ show `main` and close `splashscreen`.
