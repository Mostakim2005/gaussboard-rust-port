// src-tauri/src/converter.rs
use crate::pdf_export::print_webview_to_pdf_bytes;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Runtime, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const MS_OFFICE_PS_SCRIPT: &str = r#"
param([string]$InputPath, [string]$OutputPath, [string]$Ext)
$ErrorActionPreference = 'Stop'
try {
    if ($Ext -match '^(doc|docx|rtf|txt|odt)$') {
        $word = New-Object -ComObject Word.Application
        $word.Visible = $false
        $word.DisplayAlerts = 0
        try {
            $doc = $word.Documents.Open($InputPath, $false, $true, $false)
            $doc.ExportAsFixedFormat($OutputPath, 17) # wdExportFormatPDF = 17
            $doc.Close(0)
        } finally {
            $word.Quit(0)
            [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
        }
    } elseif ($Ext -match '^(ppt|pptx|pps|ppsx|odp)$') {
        $ppt = New-Object -ComObject PowerPoint.Application
        try {
            # WithWindow = msoFalse (0), ReadOnly = msoTrue (-1)
            $pres = $ppt.Presentations.Open($InputPath, -1, 0, 0)
            $pres.ExportAsFixedFormat($OutputPath, 2) # ppFixedFormatTypePDF = 2
            $pres.Close()
        } finally {
            $ppt.Quit()
            [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) | Out-Null
        }
    } elseif ($Ext -match '^(xls|xlsx|csv|ods)$') {
        $excel = New-Object -ComObject Excel.Application
        $excel.Visible = $false
        $excel.DisplayAlerts = $false
        try {
            $wb = $excel.Workbooks.Open($InputPath, 0, $true)
            $wb.ExportAsFixedFormat(0, $OutputPath) # xlTypePDF = 0
            $wb.Close($false)
        } finally {
            $excel.Quit()
            [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
        }
    } else {
        exit 2
    }
    exit 0
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
"#;

#[cfg(target_os = "windows")]
fn try_msoffice_com_convert(input_path: &Path, output_pdf: &Path, ext: &str) -> Result<(), String> {
    let ps_path = std::env::temp_dir().join("gaussboard-msoffice-convert.ps1");
    fs::write(&ps_path, MS_OFFICE_PS_SCRIPT).map_err(|e| e.to_string())?;

    let status = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &ps_path.to_string_lossy(),
            "-InputPath",
            &input_path.to_string_lossy(),
            "-OutputPath",
            &output_pdf.to_string_lossy(),
            "-Ext",
            ext,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| e.to_string())?;

    if status.success() && output_pdf.is_file() {
        Ok(())
    } else {
        Err("MS Office COM conversion unavailable or failed".into())
    }
}

fn find_soffice_binary() -> Option<PathBuf> {
    let candidates = [
        r"C:\Program Files\LibreOffice\program\soffice.exe",
        r"C:\Program Files (x86)\LibreOffice\program\soffice.exe",
        "/usr/bin/soffice",
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    ];
    for c in candidates {
        let p = PathBuf::from(c);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn try_libreoffice_convert(input_path: &Path, out_dir: &Path) -> Result<PathBuf, String> {
    let soffice = find_soffice_binary().ok_or_else(|| "LibreOffice not found".to_string())?;
    let mut cmd = Command::new(soffice);
    cmd.args([
        "--headless",
        "--nologo",
        "--nofirststartwizard",
        "--convert-to",
        "pdf",
        "--outdir",
        &out_dir.to_string_lossy(),
        &input_path.to_string_lossy(),
    ]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let status = cmd.status().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("LibreOffice conversion exited with error".into());
    }

    let stem = input_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("converted");
    let expected_pdf = out_dir.join(format!("{}.pdf", stem));
    if expected_pdf.is_file() {
        Ok(expected_pdf)
    } else {
        Err("LibreOffice did not produce expected PDF".into())
    }
}

async fn try_builtin_webview_convert<R: Runtime>(
    app: &AppHandle<R>,
    input_path: &Path,
    ext: &str,
) -> Result<Vec<u8>, String> {
    let raw_bytes = fs::read(input_path).map_err(|e| e.to_string())?;
    let b64_data = BASE64.encode(&raw_bytes);
    let label = format!("conv-{}", rand::random::<u32>());

    let win = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::CustomProtocol("app://board/convert.html".parse().unwrap()),
    )
    .visible(false)
    .inner_size(1200.0, 900.0)
    .build()
    .map_err(|e| e.to_string())?;

    tokio::time::sleep(Duration::from_millis(300)).await;

    let payload = json!({
        "ext": ext,
        "name": input_path.file_name().and_then(|n| n.to_str()).unwrap_or("document"),
        "base64": b64_data
    });
    let js = format!(
        "if (typeof window.convertDocument === 'function') {{ window.convertDocument({}); }}",
        serde_json::to_string(&payload).unwrap()
    );
    let _ = win.eval(&js);

    tokio::time::sleep(Duration::from_millis(800)).await;
    let pdf_bytes = print_webview_to_pdf_bytes(&win, false).await;
    let _ = win.close();
    pdf_bytes
}

#[tauri::command]
pub async fn import_to_pdf<R: Runtime>(
    app: AppHandle<R>,
    #[allow(non_snake_case)] filePath: Value,
    opts: Option<Value>,
) -> Result<Vec<u8>, String> {
    let tmp_dir = std::env::temp_dir().join(format!(
        "gb-import-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;

    // Accept either a file path string or raw byte array (when importTakesBytes = true)
    let (input_path, ext) = if let Some(path_str) = filePath.as_str() {
        let p = PathBuf::from(path_str);
        let e = p
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        (p, e)
    } else if let Some(arr) = filePath.as_array() {
        let bytes: Vec<u8> = arr
            .iter()
            .filter_map(|v| v.as_u64().map(|b| b as u8))
            .collect();
        let name = opts
            .as_ref()
            .and_then(|o| o.get("name").or_else(|| o.get("filename")))
            .and_then(|v| v.as_str())
            .unwrap_or("input.docx");
        let e = Path::new(name)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("docx")
            .to_ascii_lowercase();
        let p = tmp_dir.join(format!("input.{}", e));
        fs::write(&p, bytes).map_err(|e| e.to_string())?;
        (p, e)
    } else {
        let _ = fs::remove_dir_all(&tmp_dir);
        return Err("Unsupported filePath argument in import_to_pdf".into());
    };

    if ext == "pdf" {
        let bytes = fs::read(&input_path).map_err(|e| e.to_string())?;
        let _ = fs::remove_dir_all(&tmp_dir);
        return Ok(bytes);
    }

    let out_pdf = tmp_dir.join("output.pdf");

    // 1. Try Microsoft Office COM on Windows
    #[cfg(target_os = "windows")]
    {
        let in_clone = input_path.clone();
        let out_clone = out_pdf.clone();
        let ext_clone = ext.clone();
        if let Ok(Ok(())) = tokio::task::spawn_blocking(move || {
            try_msoffice_com_convert(&in_clone, &out_clone, &ext_clone)
        })
        .await
        {
            if let Ok(bytes) = fs::read(&out_pdf) {
                let _ = fs::remove_dir_all(&tmp_dir);
                return Ok(bytes);
            }
        }
    }

    // 2. Try LibreOffice Headless
    {
        let in_clone = input_path.clone();
        let dir_clone = tmp_dir.clone();
        if let Ok(Ok(lo_pdf)) =
            tokio::task::spawn_blocking(move || try_libreoffice_convert(&in_clone, &dir_clone))
                .await
        {
            if let Ok(bytes) = fs::read(&lo_pdf) {
                let _ = fs::remove_dir_all(&tmp_dir);
                return Ok(bytes);
            }
        }
    }

    // 3. Fallback to built-in off-screen WebView2 convert.html
    let fallback_res = try_builtin_webview_convert(&app, &input_path, &ext).await;
    let _ = fs::remove_dir_all(&tmp_dir);
    fallback_res
}
