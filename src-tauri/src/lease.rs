// src-tauri/src/lease.rs
use crate::state::AppState;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};

fn count_board_windows<R: Runtime>(app: &AppHandle<R>) -> usize {
    app.webview_windows()
        .keys()
        .filter(|label| *label != "splashscreen" && !label.starts_with("pdf-") && !label.starts_with("conv-"))
        .count()
        .max(1)
}

pub fn broadcast_lease_states<R: Runtime>(app: &AppHandle<R>, state: &AppState) {
    let active_label = state.active_editor_window.read().clone();
    let win_count = count_board_windows(app);

    for (label, win) in app.webview_windows() {
        if label == "splashscreen" || label.starts_with("pdf-") || label.starts_with("conv-") {
            continue;
        }
        let is_editor = label == active_label;
        let _ = win.emit(
            "lease:state",
            json!({
                "isEditor": is_editor,
                "windowCount": win_count
            }),
        );
    }
}

#[tauri::command]
pub async fn window_claim_lease<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let label = window.label().to_string();
    *state.active_editor_window.write() = label;
    broadcast_lease_states(&app, &state);
    Ok(())
}

#[tauri::command]
pub async fn window_get_lease_state<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    state: State<'_, Arc<AppState>>,
) -> Result<Value, String> {
    let active_label = state.active_editor_window.read().clone();
    let win_count = count_board_windows(&app);
    Ok(json!({
        "isEditor": window.label() == active_label,
        "windowCount": win_count
    }))
}
