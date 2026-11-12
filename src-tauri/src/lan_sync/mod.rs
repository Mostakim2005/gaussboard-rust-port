// src-tauri/src/lan_sync/mod.rs
pub mod commands;
pub mod discovery;
pub mod protocol;

use crate::{
    lan_sync::{
        discovery::{DiscoveryPacket, PEER_FORGOTTEN_AFTER_MS},
        protocol::*,
    },
    state::AppState,
    storage::atomic_write_bytes,
};
use axum::{
    extract::{DefaultBodyLimit, State as AxumState},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use parking_lot::{Mutex, RwLock};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::IpAddr,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU16, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::oneshot;
use x25519_dalek::StaticSecret;

pub const DEFAULT_HTTP_PORT: u16 = 53318;
pub const CODE_TTL_MS: u64 = 300_000;
pub const CODE_MAX_ATTEMPTS: u32 = 5;
pub const MAX_BOARD_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_ASSET_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_PAIR_BYTES: usize = 8 * 1024;
pub const SEND_TIMEOUT_MS: u64 = 330_000;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncIdentity {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PairedPeerRecord {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub name: String,
    pub key: String, // base64 32-byte key
    #[serde(rename = "lastAddress")]
    pub last_address: Option<String>,
    #[serde(rename = "lastPort")]
    pub last_port: Option<u16>,
    #[serde(default)]
    pub remember: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DiscoveredPeer {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub name: String,
    pub port: u16,
    pub addresses: Vec<String>,
    #[serde(rename = "lastSeen")]
    pub last_seen: u64,
    pub paired: bool,
}

pub struct PendingHello {
    pub initiator_id: String,
    pub initiator_name: String,
    pub initiator_pub_b64: String,
    pub responder_secret: StaticSecret,
    pub responder_pub_b64: String,
    pub created_at_ms: u64,
}

pub struct ActivePairingSession {
    pub code: String,
    pub created_at_ms: u64,
    pub remember: bool,
    pub attempts_by_device: HashMap<String, u32>,
    pub hellos: HashMap<String, PendingHello>,
}

pub struct LanSyncManager {
    pub user_data_dir: PathBuf,
    pub app_state: Arc<AppState>,
    pub identity: RwLock<SyncIdentity>,
    pub paired_peers: RwLock<HashMap<String, PairedPeerRecord>>,
    pub session_keys: RwLock<HashMap<String, [u8; 32]>>,
    pub discovered: Mutex<HashMap<String, DiscoveredPeer>>,
    pub active_pairing: Mutex<Option<ActivePairingSession>>,
    pub incoming_waiters: Mutex<HashMap<String, oneshot::Sender<String>>>,
    pub running: AtomicBool,
    pub http_port: AtomicU16,
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl LanSyncManager {
    pub fn new(user_data_dir: PathBuf, app_state: Arc<AppState>) -> Arc<Self> {
        let ident_path = user_data_dir.join("sync-identity.json");
        let identity = std::fs::read_to_string(&ident_path)
            .ok()
            .and_then(|s| serde_json::from_str::<SyncIdentity>(&s).ok())
            .unwrap_or_else(|| {
                let mut raw_id = [0u8; 16];
                rand::rngs::OsRng.fill_bytes(&mut raw_id);
                let host = hostname::get()
                    .ok()
                    .and_then(|h| h.into_string().ok())
                    .unwrap_or_else(|| "GaussBoard PC".to_string());
                let ident = SyncIdentity {
                    device_id: hex::encode(raw_id),
                    name: host.chars().take(64).collect(),
                };
                if let Ok(bytes) = serde_json::to_vec(&ident) {
                    let _ = atomic_write_bytes(&ident_path, &bytes);
                }
                ident
            });

        let paired_path = user_data_dir.join("sync-paired.json");
        let paired_vec: Vec<PairedPeerRecord> = std::fs::read_to_string(&paired_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();

        let mut paired_map = HashMap::new();
        let mut session_keys = HashMap::new();
        for rec in paired_vec {
            if let Ok(k_bytes) = BASE64.decode(rec.key.trim()) {
                if let Ok(arr) = <[u8; 32]>::try_from(k_bytes.as_slice()) {
                    session_keys.insert(rec.device_id.clone(), arr);
                }
            }
            paired_map.insert(rec.device_id.clone(), rec);
        }

        Arc::new(Self {
            user_data_dir,
            app_state,
            identity: RwLock::new(identity),
            paired_peers: RwLock::new(paired_map),
            session_keys: RwLock::new(session_keys),
            discovered: Mutex::new(HashMap::new()),
            active_pairing: Mutex::new(None),
            incoming_waiters: Mutex::new(HashMap::new()),
            running: AtomicBool::new(false),
            http_port: AtomicU16::new(DEFAULT_HTTP_PORT),
        })
    }

    pub fn save_paired_peers(&self) {
        let paired_path = self.user_data_dir.join("sync-paired.json");
        let list: Vec<PairedPeerRecord> = self
            .paired_peers
            .read()
            .values()
            .filter(|r| r.remember)
            .cloned()
            .collect();
        if let Ok(bytes) = serde_json::to_vec(&list) {
            let _ = atomic_write_bytes(&paired_path, &bytes);
        }
    }

    pub fn get_device_key(&self, peer_id: &str) -> Option<[u8; 32]> {
        self.session_keys.read().get(peer_id).copied()
    }

    pub fn record_discovered_peer<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        pkt: DiscoveryPacket,
        src_ip: IpAddr,
    ) {
        let mut addrs = pkt.a;
        let src_str = src_ip.to_string();
        if !addrs.contains(&src_str) {
            addrs.insert(0, src_str);
        }
        let is_paired = self.session_keys.read().contains_key(&pkt.id);
        let peer = DiscoveredPeer {
            device_id: pkt.id.clone(),
            name: pkt.name,
            port: pkt.port,
            addresses: addrs,
            last_seen: now_ms(),
            paired: is_paired,
        };
        self.discovered.lock().insert(pkt.id, peer);
        self.emit_peers(app);
    }

    pub fn prune_stale_peers<R: Runtime>(&self, app: &AppHandle<R>) {
        let cutoff = now_ms().saturating_sub(PEER_FORGOTTEN_AFTER_MS);
        let mut disc = self.discovered.lock();
        let before = disc.len();
        disc.retain(|_, p| p.last_seen >= cutoff);
        let changed = disc.len() != before;
        drop(disc);
        if changed {
            self.emit_peers(app);
        }
    }

    pub fn emit_peers<R: Runtime>(&self, app: &AppHandle<R>) {
        let list: Vec<DiscoveredPeer> = self.discovered.lock().values().cloned().collect();
        let _ = app.emit("sync:peers", list);
    }
}

struct HttpServerContext<R: Runtime> {
    app: AppHandle<R>,
    mgr: Arc<LanSyncManager>,
}

impl<R: Runtime> Clone for HttpServerContext<R> {
    fn clone(&self) -> Self {
        Self {
            app: self.app.clone(),
            mgr: Arc::clone(&self.mgr),
        }
    }
}

fn json_no_store<T: Serialize>(status: StatusCode, body: T) -> Response {
    (
        status,
        [(axum::http::header::CACHE_CONTROL, "no-store")],
        Json(body),
    )
        .into_response()
}

async fn handle_ping<R: Runtime>(AxumState(ctx): AxumState<HttpServerContext<R>>) -> Response {
    let ident = ctx.mgr.identity.read().clone();
    json_no_store(
        StatusCode::OK,
        json!({
            "v": 1,
            "deviceId": ident.device_id,
            "name": ident.name
        }),
    )
}

#[derive(Deserialize)]
struct PairHelloReq {
    v: u32,
    #[serde(rename = "deviceId")]
    device_id: String,
    name: String,
    #[serde(rename = "publicKey")]
    public_key: String,
}

async fn handle_pair_hello<R: Runtime>(
    AxumState(ctx): AxumState<HttpServerContext<R>>,
    Json(req): Json<PairHelloReq>,
) -> Response {
    if req.v != 1 {
        return json_no_store(StatusCode::BAD_REQUEST, json!({ "error": "unsupported version" }));
    }
    let mut guard = ctx.mgr.active_pairing.lock();
    let Some(session) = guard.as_mut() else {
        return json_no_store(StatusCode::FORBIDDEN, json!({ "error": "not pairing" }));
    };
    if now_ms().saturating_sub(session.created_at_ms) > CODE_TTL_MS {
        *guard = None;
        return json_no_store(StatusCode::FORBIDDEN, json!({ "error": "pairing expired" }));
    }

    let (secret, pub_b64) = generate_x25519_keypair();
    session.hellos.insert(
        req.device_id.clone(),
        PendingHello {
            initiator_id: req.device_id,
            initiator_name: req.name,
            initiator_pub_b64: req.public_key,
            responder_secret: secret,
            responder_pub_b64: pub_b64.clone(),
            created_at_ms: now_ms(),
        },
    );

    let ident = ctx.mgr.identity.read().clone();
    json_no_store(
        StatusCode::OK,
        json!({
            "v": 1,
            "deviceId": ident.device_id,
            "name": ident.name,
            "publicKey": pub_b64
        }),
    )
}

#[derive(Deserialize)]
struct PairConfirmReq {
    #[allow(dead_code)]
    v: u32,
    #[serde(rename = "deviceId")]
    device_id: String,
    confirm: String,
}

async fn handle_pair_confirm<R: Runtime>(
    AxumState(ctx): AxumState<HttpServerContext<R>>,
    Json(req): Json<PairConfirmReq>,
) -> Response {
    let mut guard = ctx.mgr.active_pairing.lock();
    let Some(session) = guard.as_mut() else {
        return json_no_store(StatusCode::FORBIDDEN, json!({ "error": "not pairing" }));
    };
    if now_ms().saturating_sub(session.created_at_ms) > CODE_TTL_MS {
        *guard = None;
        return json_no_store(StatusCode::FORBIDDEN, json!({ "error": "pairing expired" }));
    }

    let attempts = session
        .attempts_by_device
        .entry(req.device_id.clone())
        .or_insert(0);
    if *attempts >= CODE_MAX_ATTEMPTS {
        return json_no_store(
            StatusCode::FORBIDDEN,
            json!({ "error": "too many attempts", "attemptsLeft": 0 }),
        );
    }

    let Some(hello) = session.hellos.get(&req.device_id) else {
        return json_no_store(StatusCode::BAD_REQUEST, json!({ "error": "missing hello" }));
    };

    let ident = ctx.mgr.identity.read().clone();
    let transcript = canonical_transcript(
        &hello.initiator_id,
        &hello.initiator_pub_b64,
        &ident.device_id,
        &hello.responder_pub_b64,
    );

    if !verify_confirmation_constant_time(
        &session.code,
        &transcript,
        "initiator",
        "confirm-a",
        &req.confirm,
    ) {
        *attempts += 1;
        let left = CODE_MAX_ATTEMPTS.saturating_sub(*attempts);
        return json_no_store(
            StatusCode::FORBIDDEN,
            json!({ "error": "wrong code", "attemptsLeft": left }),
        );
    }

    let Ok(shared) = diffie_hellman_shared(&hello.responder_secret, &hello.initiator_pub_b64) else {
        return json_no_store(StatusCode::BAD_REQUEST, json!({ "error": "invalid key" }));
    };

    let device_key = derive_device_key(
        &shared,
        &hello.initiator_id,
        &hello.initiator_pub_b64,
        &ident.device_id,
        &hello.responder_pub_b64,
    );
    let Ok(responder_confirm) = generate_confirmation(&session.code, &transcript, "responder") else {
        return json_no_store(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": "mac error" }));
    };

    let fp = key_fingerprint(&device_key);
    let remember = session.remember;
    let peer_id = hello.initiator_id.clone();
    let peer_name = hello.initiator_name.clone();

    // Complete pairing & store key
    *guard = None;
    drop(guard);

    ctx.mgr.session_keys.write().insert(peer_id.clone(), device_key);
    ctx.mgr.paired_peers.write().insert(
        peer_id.clone(),
        PairedPeerRecord {
            device_id: peer_id,
            name: peer_name,
            key: BASE64.encode(device_key),
            last_address: None,
            last_port: None,
            remember,
        },
    );
    if remember {
        ctx.mgr.save_paired_peers();
    }
    ctx.mgr.emit_peers(&ctx.app);

    json_no_store(
        StatusCode::OK,
        json!({
            "v": 1,
            "deviceId": ident.device_id,
            "name": ident.name,
            "confirm": responder_confirm,
            "fingerprint": fp,
            "remembered": remember
        }),
    )
}

async fn handle_sync_asset<R: Runtime>(
    AxumState(ctx): AxumState<HttpServerContext<R>>,
    headers: HeaderMap,
    Json(env): Json<WireEnvelope>,
) -> Response {
    let sender_id = headers
        .get("X-GazBoard-From")
        .and_then(|v| v.to_str().ok())
        .or_else(|| env.aad.get("from").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();

    let Some(device_key) = ctx.mgr.get_device_key(&sender_id) else {
        return json_no_store(StatusCode::UNAUTHORIZED, json!({ "error": "unpaired sender" }));
    };

    let raw_asset_id = headers
        .get("X-Asset-Id")
        .and_then(|v| v.to_str().ok())
        .or_else(|| env.aad.get("assetId").and_then(|v| v.as_str()))
        .unwrap_or("")
        .trim();

    if raw_asset_id.is_empty()
        || raw_asset_id.contains("..")
        || raw_asset_id.contains('/')
        || raw_asset_id.contains('\\')
    {
        return json_no_store(StatusCode::BAD_REQUEST, json!({ "error": "invalid assetId" }));
    }
    let Ok(asset_id) = crate::assets::sanitize_asset_id(raw_asset_id) else {
        return json_no_store(StatusCode::BAD_REQUEST, json!({ "error": "invalid assetId" }));
    };

    let Ok(raw_bytes) = open_envelope(&device_key, &env) else {
        return json_no_store(StatusCode::FORBIDDEN, json!({ "error": "decryption failed" }));
    };

    let assets_dir = ctx.mgr.app_state.assets_dir();
    let _ = std::fs::create_dir_all(&assets_dir);
    let target_path = assets_dir.join(&asset_id);
    if let Err(e) = atomic_write_bytes(&target_path, &raw_bytes) {
        return json_no_store(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": format!("failed writing asset: {}", e) }),
        );
    }

    json_no_store(StatusCode::OK, json!({ "ok": true, "assetId": asset_id }))
}

async fn handle_send<R: Runtime>(
    AxumState(ctx): AxumState<HttpServerContext<R>>,
    headers: HeaderMap,
    Json(env): Json<WireEnvelope>,
) -> Response {
    let sender_id = headers
        .get("X-GazBoard-From")
        .and_then(|v| v.to_str().ok())
        .or_else(|| env.aad.get("from").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();

    let Some(device_key) = ctx.mgr.get_device_key(&sender_id) else {
        return json_no_store(StatusCode::UNAUTHORIZED, json!({ "error": "unpaired sender" }));
    };

    let _ = ctx.app.emit("sync:receiving", json!({ "from": sender_id }));

    let Ok(plaintext) = open_envelope(&device_key, &env) else {
        return json_no_store(StatusCode::FORBIDDEN, json!({ "error": "decryption failed" }));
    };

    let Ok(board_json) = serde_json::from_slice::<Value>(&plaintext) else {
        return json_no_store(StatusCode::BAD_REQUEST, json!({ "error": "invalid board JSON" }));
    };

    let ticket = format!("inc-{}", rand::random::<u64>());
    let (tx, rx) = oneshot::channel::<String>();
    ctx.mgr.incoming_waiters.lock().insert(ticket.clone(), tx);

    let sender_name = env
        .aad
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Peer");

    let _ = ctx.app.emit(
        "sync:incoming",
        json!({
            "ticket": ticket,
            "from": sender_id,
            "senderName": sender_name,
            "board": board_json
        }),
    );

    match tokio::time::timeout(Duration::from_millis(SEND_TIMEOUT_MS), rx).await {
        Ok(Ok(outcome)) => {
            let accepted = outcome != "declined" && outcome != "cancel";
            json_no_store(
                StatusCode::OK,
                json!({
                    "accepted": accepted,
                    "outcome": outcome
                }),
            )
        }
        _ => {
            ctx.mgr.incoming_waiters.lock().remove(&ticket);
            json_no_store(
                StatusCode::OK,
                json!({
                    "accepted": false,
                    "outcome": "declined"
                }),
            )
        }
    }
}

async fn handle_paired<R: Runtime>(
    AxumState(ctx): AxumState<HttpServerContext<R>>,
    headers: HeaderMap,
    Json(env): Json<WireEnvelope>,
) -> Response {
    let sender_id = headers
        .get("X-GazBoard-From")
        .and_then(|v| v.to_str().ok())
        .or_else(|| env.aad.get("from").and_then(|v| v.as_str()))
        .unwrap_or("");

    let is_paired = if let Some(key) = ctx.mgr.get_device_key(sender_id) {
        open_envelope(&key, &env).is_ok()
    } else {
        false
    };

    json_no_store(StatusCode::OK, json!({ "paired": is_paired }))
}

async fn handle_unpair<R: Runtime>(
    AxumState(ctx): AxumState<HttpServerContext<R>>,
    headers: HeaderMap,
    Json(env): Json<WireEnvelope>,
) -> Response {
    let sender_id = headers
        .get("X-GazBoard-From")
        .and_then(|v| v.to_str().ok())
        .or_else(|| env.aad.get("from").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();

    if let Some(key) = ctx.mgr.get_device_key(&sender_id) {
        if open_envelope(&key, &env).is_ok() {
            ctx.mgr.session_keys.write().remove(&sender_id);
            ctx.mgr.paired_peers.write().remove(&sender_id);
            ctx.mgr.save_paired_peers();
            ctx.mgr.emit_peers(&ctx.app);
        }
    }

    json_no_store(StatusCode::OK, json!({ "ok": true }))
}

pub async fn start_lan_sync_services<R: Runtime>(
    app: AppHandle<R>,
    mgr: Arc<LanSyncManager>,
) -> Result<u16, String> {
    if mgr.running.swap(true, Ordering::SeqCst) {
        return Ok(mgr.http_port.load(Ordering::SeqCst));
    }

    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", DEFAULT_HTTP_PORT)).await {
        Ok(l) => l,
        Err(_) => tokio::net::TcpListener::bind(("0.0.0.0", 0))
            .await
            .map_err(|e| format!("Failed binding LAN sync TCP port: {}", e))?,
    };

    let bound_port = listener.local_addr().map(|a| a.port()).unwrap_or(DEFAULT_HTTP_PORT);
    mgr.http_port.store(bound_port, Ordering::SeqCst);

    let ctx = HttpServerContext {
        app: app.clone(),
        mgr: mgr.clone(),
    };

    let router = Router::new()
        .route("/ping", get(handle_ping::<R>))
        .route(
            "/pair/hello",
            post(handle_pair_hello::<R>).layer(DefaultBodyLimit::max(MAX_PAIR_BYTES)),
        )
        .route(
            "/pair/confirm",
            post(handle_pair_confirm::<R>).layer(DefaultBodyLimit::max(MAX_PAIR_BYTES)),
        )
        .route(
            "/send",
            post(handle_send::<R>).layer(DefaultBodyLimit::max(MAX_BOARD_BYTES)),
        )
        .route(
            "/sync-asset",
            post(handle_sync_asset::<R>).layer(DefaultBodyLimit::max(MAX_ASSET_BYTES)),
        )
        .route(
            "/paired",
            post(handle_paired::<R>).layer(DefaultBodyLimit::max(MAX_PAIR_BYTES)),
        )
        .route(
            "/unpair",
            post(handle_unpair::<R>).layer(DefaultBodyLimit::max(MAX_PAIR_BYTES)),
        )
        .with_state(ctx);

    let mgr_http = mgr.clone();
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, router).await;
        mgr_http.running.store(false, Ordering::SeqCst);
    });

    discovery::spawn_discovery_loops(app, mgr);
    Ok(bound_port)
}
