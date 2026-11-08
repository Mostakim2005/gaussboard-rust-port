use tauri::{AppHandle, Manager, Runtime};

pub fn init_splash_bypass_and_watchdog<R: Runtime>(app: &AppHandle<R>) {
    let no_splash = std::env::args().any(|a| a == "--smoke")
        || std::env::var("GAZBOARD_NO_SPLASH").as_deref() == Ok("1");

    if no_splash {
        reveal_main_and_close_splash(app);
        return;
    }

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        reveal_main_and_close_splash(&handle);
    });
}

pub fn reveal_main_and_close_splash<R: Runtime>(app: &AppHandle<R>) {
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.show();
        let _ = main_win.set_focus();
    }
    if let Some(splash_win) = app.get_webview_window("splashscreen") {
        let _ = splash_win.close();
    }
}

#[tauri::command]
pub fn app_startup_step<R: Runtime>(app: AppHandle<R>, text: String) {
    if let Some(splash_win) = app.get_webview_window("splashscreen") {
        if let Ok(escaped) = serde_json::to_string(&text) {
            let js = format!("if (typeof window.setStatus === 'function') {{ window.setStatus({}); }}", escaped);
            let _ = splash_win.eval(&js);
        }
    }
}

#[tauri::command]
pub fn app_startup_done<R: Runtime>(app: AppHandle<R>, _info: serde_json::Value) {
    reveal_main_and_close_splash(&app);
}
