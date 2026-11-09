// src-tauri/src/win32_shell.rs
// Windows 11 Mica Alt styling, HWND_MESSAGE event-driven clipboard watcher,
// and zero-latency pre-warmed scratchpad window lifecycle.

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE, DWMWA_USE_IMMERSIVE_DARK_MODE,
    DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
};

#[cfg(target_os = "windows")]
pub fn apply_win11_mica_alt(window: &tauri::WebviewWindow, dark_mode: bool) {
    if let Ok(raw_hwnd) = window.hwnd() {
        let hwnd = HWND(raw_hwnd.0 as _);
        unsafe {
            let use_dark: i32 = if dark_mode { 1 } else { 0 };
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_USE_IMMERSIVE_DARK_MODE,
                &use_dark as *const _ as *const _,
                std::mem::size_of::<i32>() as u32,
            );

            // 4 = DWMSBT_TABBEDWINDOW (Mica Alt), 2 = DWMSBT_MAINWINDOW (Mica)
            let backdrop_mica_alt: i32 = 4;
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_SYSTEMBACKDROP_TYPE,
                &backdrop_mica_alt as *const _ as *const _,
                std::mem::size_of::<i32>() as u32,
            );

            let corner_round = DWMWCP_ROUND;
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &corner_round as *const _ as *const _,
                std::mem::size_of_val(&corner_round) as u32,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn apply_win11_mica_alt(_window: &tauri::WebviewWindow, _dark_mode: bool) {}

#[cfg(target_os = "windows")]
pub fn spawn_win32_clipboard_listener(app: tauri::AppHandle) {
    use tauri::Emitter;
    use windows::Win32::System::DataExchange::{
        AddClipboardFormatListener, GetClipboardSequenceNumber,
    };
    use windows::Win32::UI::WindowsAndMessaging::*;

    std::thread::spawn(move || unsafe {
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            windows::core::w!("STATIC"),
            windows::core::w!("GaussBoardClipWatcher"),
            WINDOW_STYLE::default(),
            0,
            0,
            0,
            0,
            HWND_MESSAGE, // Invisible message-only window
            None,
            None,
            None,
        );

        if let Ok(hwnd) = hwnd {
            let _ = AddClipboardFormatListener(hwnd);
            let mut msg = MSG::default();

            while GetMessageW(&mut msg, None, 0, 0).into() {
                if msg.message == WM_CLIPBOARDUPDATE {
                    // O(1) kernel sequence number avoids OpenClipboard contention
                    let seq = GetClipboardSequenceNumber();
                    let _ = app.emit("board://clipboard-seq", seq);
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    });
}

#[cfg(not(target_os = "windows"))]
pub fn spawn_win32_clipboard_listener(_app: tauri::AppHandle) {}

#[tauri::command]
pub fn apply_window_mica(
    window: tauri::WebviewWindow,
    dark_mode: Option<bool>,
) -> Result<bool, String> {
    apply_win11_mica_alt(&window, dark_mode.unwrap_or(true));
    Ok(true)
}
