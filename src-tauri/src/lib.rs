// src-tauri/src/lib.rs
pub mod assets;
pub mod clipboard;
pub mod converter;
pub mod lan_sync;
pub mod lease;
pub mod pdf_export;
pub mod protocol_app;
pub mod recording;
pub mod splash;
pub mod state;
pub mod storage;

use crate::{lan_sync::LanSyncManager, state::AppState};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime, State, WindowEvent};
use tauri_plugin_shell::ShellExt;
use url::Url;

#[tauri::command]
fn app_info(state: State<'_, Arc<AppState>>) -> Value {
    json!({
        "name": "GaussBoard",
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "runtime": "tauri",
        "language": *state.language.read()
    })
}

#[tauri::command]
fn app_set_language(state: State<'_, Arc<AppState>>, code: String) -> bool {
    *state.language.write() = code;
    true
}

#[tauri::command]
#[allow(deprecated)]
async fn shell_open_external<R: Runtime>(app: AppHandle<R>, url: String) -> Result<bool, String> {
    let parsed = Url::parse(&url).map_err(|_| "Invalid URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Only HTTPS release URLs are permitted".into());
    }
    let host = parsed.host_str().unwrap_or("");
    if !host.eq_ignore_ascii_case("github.com") && !host.ends_with(".github.com") {
        return Err("Untrusted external release domain".into());
    }
    app.shell().open(url, None).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn updates_check() -> Value {
    json!({ "updateAvailable": false })
}

#[tauri::command]
fn updates_mode() -> Value {
    json!({ "mode": "manual" })
}

#[tauri::command]
fn updates_download(_version: Option<String>) -> Value {
    json!({ "ok": false })
}

#[tauri::command]
fn updates_install(_opts: Option<Value>) -> Value {
    json!({ "ok": false })
}

#[tauri::command]
fn updates_note() -> Value {
    Value::Null
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .register_uri_scheme_protocol("app", protocol_app::handle_app_protocol)
        .setup(|app| {
            let user_data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("GaussBoardData"));
            let doc_dir = app
                .path()
                .document_dir()
                .unwrap_or_else(|_| user_data_dir.clone());

            let app_state = AppState::new(user_data_dir.clone(), doc_dir);
            let sync_mgr = LanSyncManager::new(user_data_dir);

            app.manage(app_state.clone());
            app.manage(sync_mgr);

            splash::init_splash_bypass_and_watchdog(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(true) = event {
                let label = window.label();
                if label != "splashscreen" && !label.starts_with("pdf-") && !label.starts_with("conv-") {
                    if let Some(state) = window.try_state::<Arc<AppState>>() {
                        *state.active_editor_window.write() = label.to_string();
                        lease::broadcast_lease_states(window.app_handle(), &state);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            app_set_language,
            shell_open_external,
            updates_check,
            updates_mode,
            updates_download,
            updates_install,
            updates_note,
            splash::app_startup_step,
            splash::app_startup_done,
            storage::boards_list,
            storage::boards_load,
            storage::boards_save,
            storage::boards_delete,
            storage::boards_get_last,
            storage::boards_set_last,
            storage::boards_resume,
            storage::boards_migrate,
            storage::storage_get,
            storage::storage_choose,
            storage::storage_apply,
            storage::storage_reset,
            storage::storage_delete_old,
            storage::storage_catalogue_read,
            storage::storage_catalogue_write,
            storage::storage_flush_ack,
            assets::assets_put,
            assets::assets_get,
            assets::assets_have,
            assets::assets_put_binary_direct,
            recording::recording_start,
            recording::recording_append_chunk,
            recording::recording_finish,
            lan_sync::commands::sync_state,
            lan_sync::commands::sync_start,
            lan_sync::commands::sync_stop,
            lan_sync::commands::sync_set_name,
            lan_sync::commands::sync_begin_pairing,
            lan_sync::commands::sync_cancel_pairing,
            lan_sync::commands::sync_pair_with,
            lan_sync::commands::sync_send,
            lan_sync::commands::sync_answer,
            lan_sync::commands::sync_add_by_address,
            lan_sync::commands::sync_unpair,
            lan_sync::commands::sync_still_paired,
            lan_sync::commands::sync_end_session,
            lan_sync::commands::sync_firewall_check,
            lan_sync::commands::sync_firewall_repair,
            lan_sync::commands::sync_firewall_remove,
            lan_sync::commands::sync_firewall_commands,
            lease::window_claim_lease,
            lease::window_get_lease_state,
            clipboard::clipboard_read,
            clipboard::clipboard_write,
            clipboard::clipboard_signature,
            converter::import_to_pdf,
            pdf_export::export_pdf,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GaussBoard Tauri application");
}
