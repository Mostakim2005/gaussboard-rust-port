// src-tauri/src/pdf_export.rs
use serde_json::Value;
use std::{
    fs,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
#[cfg(target_os = "windows")]
use tokio::sync::oneshot;

#[cfg(target_os = "windows")]
pub async fn print_webview_to_pdf_bytes<R: Runtime>(
    win: &WebviewWindow<R>,
    landscape: bool,
) -> Result<Vec<u8>, String> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Environment6, ICoreWebView2PrintSettings, ICoreWebView2_7,
            COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE, COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
        },
        PrintToPdfCompletedHandler,
    };
    use windows::core::{Interface, HSTRING, PCWSTR};

    let tmp_pdf = std::env::temp_dir().join(format!(
        "gaussboard-print-{}.pdf",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let tmp_pdf_str = tmp_pdf.to_string_lossy().to_string();

    let (tx, rx) = oneshot::channel::<Result<(), String>>();

    win.with_webview(move |platform_webview| {
        let result = (|| -> Result<(), String> {
            unsafe {
                let controller = platform_webview.controller();
                let core = controller.CoreWebView2().map_err(|e| e.to_string())?;
                let core7: ICoreWebView2_7 = core.cast().map_err(|e| e.to_string())?;

                // Configure print settings (orientation & background graphics)
                let mut settings_opt: Option<ICoreWebView2PrintSettings> = None;
                if let Ok(env) = platform_webview.environment().cast::<ICoreWebView2Environment6>()
                {
                    if let Ok(settings) = env.CreatePrintSettings() {
                        let _ = settings.SetShouldPrintBackgrounds(true);
                        let _ = settings.SetShouldPrintHeaderAndFooter(false);
                        let _ = settings.SetOrientation(if landscape {
                            COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
                        } else {
                            COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
                        });
                        settings_opt = Some(settings);
                    }
                }

                let path_hstring = HSTRING::from(&tmp_pdf_str);
                let mut tx_opt = Some(tx);

                let handler = PrintToPdfCompletedHandler::create(Box::new(
                    move |hr, is_success| {
                        if let Some(sender) = tx_opt.take() {
                            if hr.is_ok() && is_success {
                                let _ = sender.send(Ok(()));
                            } else {
                                let _ = sender.send(Err(format!(
                                    "PrintToPdf failed: {:?}",
                                    hr
                                )));
                            }
                        }
                        Ok(())
                    },
                ));

                core7
                    .PrintToPdf(
                        PCWSTR::from_raw(path_hstring.as_ptr()),
                        settings_opt.as_ref(),
                        &handler,
                    )
                    .map_err(|e| e.to_string())?;
                Ok(())
            }
        })();

        if let Err(err) = result {
            // Handler was never registered if PrintToPdf failed synchronously
            eprintln!("WebView2 PrintToPdf setup error: {}", err);
        }
    })
    .map_err(|e| e.to_string())?;

    match tokio::time::timeout(Duration::from_secs(30), rx).await {
        Ok(Ok(Ok(()))) => {
            let bytes = fs::read(&tmp_pdf).map_err(|e| e.to_string())?;
            let _ = fs::remove_file(&tmp_pdf);
            Ok(bytes)
        }
        Ok(Ok(Err(e))) => {
            let _ = fs::remove_file(&tmp_pdf);
            Err(e)
        }
        _ => {
            let _ = fs::remove_file(&tmp_pdf);
            Err("Timed out waiting for WebView2 PrintToPdfAsync".into())
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub async fn print_webview_to_pdf_bytes<R: Runtime>(
    _win: &WebviewWindow<R>,
    _landscape: bool,
) -> Result<Vec<u8>, String> {
    Err("Native WebView2 PrintToPdfAsync is only supported on Windows".into())
}

#[tauri::command]
pub async fn export_pdf<R: Runtime>(
    app: AppHandle<R>,
    payload: Value,
) -> Result<Vec<u8>, String> {
    let label = format!("pdf-export-{}", rand::random::<u32>());
    let landscape = payload
        .get("landscape")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    let html_content = payload
        .get("html")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let win = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::CustomProtocol("app://board/convert.html".parse().unwrap()),
    )
    .visible(false)
    .inner_size(1280.0, 900.0)
    .build()
    .map_err(|e| e.to_string())?;

    // Wait briefly for convert.html to mount
    tokio::time::sleep(Duration::from_millis(250)).await;

    if !html_content.is_empty() {
        let escaped = serde_json::to_string(html_content).map_err(|e| e.to_string())?;
        let _ = win.eval(&format!(
            "document.open(); document.write({}); document.close();",
            escaped
        ));
    } else {
        let serialized = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
        let _ = win.eval(&format!(
            "if (typeof window.renderExportPayload === 'function') {{ window.renderExportPayload({}); }}",
            serialized
        ));
    }

    // Allow fonts and images to settle before printing
    tokio::time::sleep(Duration::from_millis(350)).await;

    let pdf_res = print_webview_to_pdf_bytes(&win, landscape).await;
    let _ = win.close();
    pdf_res
}
