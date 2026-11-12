// src-tauri/src/lan_sync/commands.rs
use crate::lan_sync::{
    discovery::collect_local_ipv4_and_broadcasts,
    protocol::*,
    start_lan_sync_services, ActivePairingSession, DiscoveredPeer, LanSyncManager, PairedPeerRecord,
    CODE_TTL_MS, DEFAULT_HTTP_PORT, SEND_TIMEOUT_MS,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::atomic::Ordering, sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter, Runtime, State};

async fn resolve_reachable_address(addresses: &[String], port: u16) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .map_err(|e| e.to_string())?;

    for addr in addresses {
        let url = format!("http://{}:{}/ping", addr, port);
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                return Ok(addr.clone());
            }
        }
    }
    addresses
        .first()
        .cloned()
        .ok_or_else(|| "No reachable IP address for peer".to_string())
}

#[tauri::command]
pub async fn sync_state(mgr: State<'_, Arc<LanSyncManager>>) -> Result<Value, String> {
    let ident = mgr.identity.read().clone();
    let (ips, _) = collect_local_ipv4_and_broadcasts();
    let peers: Vec<DiscoveredPeer> = mgr.discovered.lock().values().cloned().collect();
    let paired: Vec<PairedPeerRecord> = mgr.paired_peers.read().values().cloned().collect();
    Ok(json!({
        "running": mgr.running.load(Ordering::SeqCst),
        "deviceId": ident.device_id,
        "name": ident.name,
        "port": mgr.http_port.load(Ordering::SeqCst),
        "addresses": ips,
        "peers": peers,
        "paired": paired
    }))
}

#[tauri::command]
pub async fn sync_start<R: Runtime>(
    app: AppHandle<R>,
    mgr: State<'_, Arc<LanSyncManager>>,
) -> Result<Value, String> {
    let _ = start_lan_sync_services(app, (*mgr).clone()).await?;
    sync_state(mgr).await
}

#[tauri::command]
pub async fn sync_stop(mgr: State<'_, Arc<LanSyncManager>>) -> Result<bool, String> {
    mgr.running.store(false, Ordering::SeqCst);
    Ok(true)
}

#[tauri::command]
pub async fn sync_set_name(
    mgr: State<'_, Arc<LanSyncManager>>,
    name: String,
) -> Result<Value, String> {
    let clean: String = name.trim().chars().take(64).collect();
    if !clean.is_empty() {
        let mut guard = mgr.identity.write();
        guard.name = clean;
        let path = mgr.user_data_dir.join("sync-identity.json");
        if let Ok(bytes) = serde_json::to_vec(&*guard) {
            let _ = crate::storage::atomic_write_bytes(&path, &bytes);
        }
    }
    sync_state(mgr).await
}

#[tauri::command]
pub async fn sync_begin_pairing(
    mgr: State<'_, Arc<LanSyncManager>>,
    opts: Option<Value>,
) -> Result<Value, String> {
    let remember = opts
        .as_ref()
        .and_then(|o| o.get("remember"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let code = generate_pairing_code();
    let now = super::now_ms();
    *mgr.active_pairing.lock() = Some(ActivePairingSession {
        code: code.clone(),
        created_at_ms: now,
        remember,
        attempts_by_device: HashMap::new(),
        hellos: HashMap::new(),
    });
    Ok(json!({
        "code": code,
        "expiresAt": now + CODE_TTL_MS
    }))
}

#[tauri::command]
pub async fn sync_cancel_pairing(mgr: State<'_, Arc<LanSyncManager>>) -> Result<bool, String> {
    *mgr.active_pairing.lock() = None;
    Ok(true)
}

#[tauri::command]
pub async fn sync_pair_with<R: Runtime>(
    app: AppHandle<R>,
    mgr: State<'_, Arc<LanSyncManager>>,
    peer: Value,
    code: String,
) -> Result<Value, String> {
    let port = peer
        .get("port")
        .and_then(|v| v.as_u64())
        .map(|p| p as u16)
        .unwrap_or(DEFAULT_HTTP_PORT);
    let addrs: Vec<String> = peer
        .get("addresses")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .or_else(|| {
            peer.get("address")
                .and_then(|v| v.as_str())
                .map(|s| vec![s.to_string()])
        })
        .unwrap_or_default();

    let host = resolve_reachable_address(&addrs, port).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let (my_secret, my_pub_b64) = generate_x25519_keypair();
    let my_ident = mgr.identity.read().clone();
    let my_port = mgr.http_port.load(Ordering::SeqCst);

    // Step 1: POST /pair/hello
    let hello_resp: Value = client
        .post(format!("http://{}:{}/pair/hello", host, port))
        .json(&json!({
            "v": 1,
            "deviceId": my_ident.device_id,
            "name": my_ident.name,
            "publicKey": my_pub_b64,
            "port": my_port
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let resp_id = hello_resp
        .get("deviceId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing responder deviceId".to_string())?;
    let resp_name = hello_resp
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Peer");
    let resp_pub_b64 = hello_resp
        .get("publicKey")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing responder publicKey".to_string())?;

    let shared = diffie_hellman_shared(&my_secret, resp_pub_b64)?;
    let transcript = canonical_transcript(&my_ident.device_id, &my_pub_b64, resp_id, resp_pub_b64);
    let confirm_tag = generate_confirmation(&code, &transcript, "initiator")?;

    // Step 2: POST /pair/confirm
    let confirm_http = client
        .post(format!("http://{}:{}/pair/confirm", host, port))
        .json(&json!({
            "v": 1,
            "deviceId": my_ident.device_id,
            "confirm": confirm_tag
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !confirm_http.status().is_success() {
        let err_json: Value = confirm_http.json().await.unwrap_or_else(|_| json!({}));
        return Err(err_json
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Pairing rejected")
            .to_string());
    }

    let confirm_resp: Value = confirm_http.json().await.map_err(|e| e.to_string())?;
    let peer_confirm = confirm_resp
        .get("confirm")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    if !verify_confirmation_constant_time(&code, &transcript, "responder", "confirm-b", peer_confirm)
    {
        return Err("Responder SAS HMAC verification failed".into());
    }

    let device_key = derive_device_key(
        &shared,
        &my_ident.device_id,
        &my_pub_b64,
        resp_id,
        resp_pub_b64,
    );
    let remember = confirm_resp
        .get("remembered")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    mgr.session_keys.write().insert(resp_id.to_string(), device_key);
    mgr.paired_peers.write().insert(
        resp_id.to_string(),
        PairedPeerRecord {
            device_id: resp_id.to_string(),
            name: resp_name.to_string(),
            key: BASE64.encode(device_key),
            last_address: Some(host),
            last_port: Some(port),
            remember,
        },
    );
    if remember {
        mgr.save_paired_peers();
    }
    mgr.emit_peers(&app);

    Ok(json!({
        "ok": true,
        "deviceId": resp_id,
        "name": resp_name,
        "fingerprint": key_fingerprint(&device_key)
    }))
}

#[tauri::command]
pub async fn sync_send<R: Runtime>(
    app: AppHandle<R>,
    mgr: State<'_, Arc<LanSyncManager>>,
    peer: Value,
    board: Value,
) -> Result<Value, String> {
    let peer_id = peer
        .get("deviceId")
        .or_else(|| peer.get("id"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing target peer deviceId".to_string())?;

    let device_key = mgr
        .get_device_key(peer_id)
        .ok_or_else(|| "Not paired with target peer".to_string())?;

    let port = peer
        .get("port")
        .and_then(|v| v.as_u64())
        .map(|p| p as u16)
        .unwrap_or(DEFAULT_HTTP_PORT);
    let addrs: Vec<String> = peer
        .get("addresses")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let host = resolve_reachable_address(&addrs, port).await?;
    let my_ident = mgr.identity.read().clone();
    let my_port = mgr.http_port.load(Ordering::SeqCst);

    let _ = app.emit("sync:sendProgress", json!({ "phase": "sending", "peerId": peer_id }));

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(SEND_TIMEOUT_MS + 5000))
        .build()
        .map_err(|e| e.to_string())?;

    let mut asset_ids = crate::bundle::collect_external_asset_ids(&board);
    if let Some(inner_doc) = board.get("board").or_else(|| board.get("doc")) {
        asset_ids.extend(crate::bundle::collect_external_asset_ids(inner_doc));
    }
    if let Some(linked) = board.get("linkedBoards") {
        if let Some(arr) = linked.as_array() {
            for item in arr {
                asset_ids.extend(crate::bundle::collect_external_asset_ids(item));
                if let Some(inner) = item.get("board").or_else(|| item.get("doc")) {
                    asset_ids.extend(crate::bundle::collect_external_asset_ids(inner));
                }
            }
        } else if let Some(obj) = linked.as_object() {
            for (_k, item) in obj {
                asset_ids.extend(crate::bundle::collect_external_asset_ids(item));
                if let Some(inner) = item.get("board").or_else(|| item.get("doc")) {
                    asset_ids.extend(crate::bundle::collect_external_asset_ids(inner));
                }
            }
        }
    }

    let assets_dir = mgr.app_state.assets_dir();
    for asset_id in asset_ids {
        let direct = assets_dir.join(&asset_id);
        let resolved = if direct.is_file() {
            Some(direct)
        } else {
            crate::assets::resolve_asset_path(&assets_dir, &asset_id)
        };
        if let Some(path) = resolved {
            if let Ok(raw_bytes) = std::fs::read(&path) {
                let asset_aad = json!({
                    "from": my_ident.device_id,
                    "kind": "asset",
                    "assetId": asset_id,
                    "v": 1
                });
                let asset_env = seal_envelope(&device_key, asset_aad, &raw_bytes)?;
                let asset_resp = client
                    .post(format!("http://{}:{}/sync-asset", host, port))
                    .header("X-GazBoard-From", &my_ident.device_id)
                    .header("X-Asset-Id", &asset_id)
                    .json(&asset_env)
                    .send()
                    .await
                    .map_err(|e| format!("Failed sending external asset {}: {}", asset_id, e))?;
                if !asset_resp.status().is_success() {
                    return Err(format!(
                        "Peer rejected external asset {} (HTTP {})",
                        asset_id,
                        asset_resp.status()
                    ));
                }
            }
        }
    }

    let aad = json!({
        "from": my_ident.device_id,
        "kind": "board",
        "v": 1,
        "port": my_port,
        "name": my_ident.name
    });

    let plaintext = serde_json::to_vec(&board).map_err(|e| e.to_string())?;
    let envelope = seal_envelope(&device_key, aad, &plaintext)?;

    let resp: Value = client
        .post(format!("http://{}:{}/send", host, port))
        .header("X-GazBoard-From", &my_ident.device_id)
        .json(&envelope)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let _ = app.emit("sync:sendProgress", json!({ "phase": "done", "peerId": peer_id }));
    Ok(resp)
}

#[tauri::command]
pub async fn sync_answer(
    mgr: State<'_, Arc<LanSyncManager>>,
    ticket: String,
    outcome: String,
) -> Result<bool, String> {
    if let Some(tx) = mgr.incoming_waiters.lock().remove(&ticket) {
        let _ = tx.send(outcome);
        return Ok(true);
    }
    Ok(false)
}

#[tauri::command]
pub async fn sync_add_by_address<R: Runtime>(
    app: AppHandle<R>,
    mgr: State<'_, Arc<LanSyncManager>>,
    address: String,
) -> Result<Value, String> {
    let trimmed = address.trim();
    let (host, port) = if let Some((h, p)) = trimmed.rsplit_once(':') {
        (h.to_string(), p.parse::<u16>().unwrap_or(DEFAULT_HTTP_PORT))
    } else {
        (trimmed.to_string(), DEFAULT_HTTP_PORT)
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    let resp: Value = client
        .get(format!("http://{}:{}/ping", host, port))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;

    let id = resp
        .get("deviceId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Invalid ping response".to_string())?
        .to_string();
    let name = resp
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Peer")
        .to_string();

    let is_paired = mgr.session_keys.read().contains_key(&id);
    let peer = DiscoveredPeer {
        device_id: id.clone(),
        name,
        port,
        addresses: vec![host],
        last_seen: super::now_ms(),
        paired: is_paired,
    };
    mgr.discovered.lock().insert(id, peer.clone());
    mgr.emit_peers(&app);
    Ok(serde_json::to_value(peer).unwrap())
}

#[tauri::command]
pub async fn sync_unpair<R: Runtime>(
    app: AppHandle<R>,
    mgr: State<'_, Arc<LanSyncManager>>,
    #[allow(non_snake_case)] deviceId: String,
) -> Result<bool, String> {
    mgr.session_keys.write().remove(&deviceId);
    mgr.paired_peers.write().remove(&deviceId);
    mgr.save_paired_peers();
    mgr.emit_peers(&app);
    Ok(true)
}

#[tauri::command]
pub async fn sync_still_paired(
    mgr: State<'_, Arc<LanSyncManager>>,
    peer: Value,
) -> Result<bool, String> {
    let peer_id = peer
        .get("deviceId")
        .or_else(|| peer.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    Ok(mgr.session_keys.read().contains_key(peer_id))
}

#[tauri::command]
pub async fn sync_end_session<R: Runtime>(
    app: AppHandle<R>,
    mgr: State<'_, Arc<LanSyncManager>>,
) -> Result<bool, String> {
    let remembered_ids: Vec<String> = mgr
        .paired_peers
        .read()
        .values()
        .filter(|r| r.remember)
        .map(|r| r.device_id.clone())
        .collect();
    mgr.session_keys
        .write()
        .retain(|k, _| remembered_ids.contains(k));
    mgr.emit_peers(&app);
    Ok(true)
}

#[tauri::command]
pub async fn sync_firewall_check() -> Result<Value, String> {
    Ok(json!({ "ok": true, "udpPort": 53319, "tcpPort": 53318 }))
}

#[tauri::command]
pub async fn sync_firewall_repair() -> Result<Value, String> {
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sync_firewall_remove() -> Result<Value, String> {
    Ok(json!({ "ok": true }))
}

#[tauri::command]
pub async fn sync_firewall_commands() -> Result<Value, String> {
    let exe = std::env::current_exe()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    Ok(json!({
        "add": format!("netsh advfirewall firewall add rule name=\"GaussBoard LAN Sync\" dir=in action=allow program=\"{}\" enable=yes", exe),
        "remove": "netsh advfirewall firewall delete rule name=\"GaussBoard LAN Sync\""
    }))
}
