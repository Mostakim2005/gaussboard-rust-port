// src-tauri/src/lib.rs
pub mod assets;
pub mod audio_dsp;
pub mod audio_inspect;
pub mod bundle;
pub mod clipboard;
pub mod colorimetry;
pub mod converter;
pub mod export_engine;
pub mod geometry;
pub mod lan_sync;
pub mod lease;
pub mod markdown_parser;
pub mod pdf_export;
pub mod power;
pub mod protocol_app;
pub mod recording;
pub mod search;
pub mod splash;
pub mod state;
pub mod storage;
pub mod win32_shell;

use crate::{lan_sync::LanSyncManager, state::AppState};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WindowEvent};
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
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.emit("app:external-open", argv);
            }
        }));
    }

    builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init());

    #[cfg(desktop)]
    {
        if let Ok(shortcut_plugin) = tauri_plugin_global_shortcut::Builder::new()
            .with_shortcuts(["Ctrl+Shift+Space", "Alt+G"])
            .and_then(|b| {
                Ok(b.with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                            let _ = w.emit("app:quick-scratchpad", ());
                        }
                    }
                })
                .build())
            })
        {
            builder = builder.plugin(shortcut_plugin);
        }
    }

    builder
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
            let sync_mgr = LanSyncManager::new(user_data_dir.clone(), app_state.clone());

            let db_pool = search::init_search_db(user_data_dir)
                .unwrap_or_else(|e| {
                    eprintln!("Warning: failed to init search db: {}", e);
                    search::init_search_db(std::env::temp_dir().join("GaussBoardSearch"))
                        .expect("Failed to initialize fallback search db")
                });

            app.manage(app_state.clone());
            app.manage(sync_mgr);
            app.manage(db_pool);

            splash::init_splash_bypass_and_watchdog(app.handle());
            win32_shell::spawn_win32_clipboard_listener(app.handle().clone());
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
            assets::assets_delete,
            assets::assets_put_binary,
            assets::assets_put_binary_direct,
            assets::assets_read_raw,
            assets::pdf_ingest_path,
            assets::pdf_ingest_bytes,
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
            bundle::bundle_export,
            bundle::bundle_import,
            audio_inspect::audio_inspect,
            geometry::stroke_simplify_and_fit,
            geometry::binary_simplify_stroke,
            search::search_index_board,
            search::search_delete_board,
            search::search_boards,
            search::search_audio_to_ink,
            search::record_stroke_temporal_map,
            search::index_audio_transcript,
            search::graph_record_links,
            search::graph_get_backlinks,
            search::study_card_upsert,
            search::study_cards_due,
            search::search_index_pdf,
            search::pdf_extract_full_text,
            export_engine::export_board_high_res_png,
            win32_shell::apply_window_mica,
            colorimetry::color_wcag_contrast,
            colorimetry::color_oklch_mix,
            colorimetry::color_invert_theme_ink,
            markdown_parser::markdown_to_html,
            power::get_power_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GaussBoard Tauri application");
}
