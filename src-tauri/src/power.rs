// src-tauri/src/power.rs
use serde_json::{json, Value};

#[cfg(windows)]
#[tauri::command]
pub fn get_power_status() -> Result<Value, String> {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut status = SYSTEM_POWER_STATUS::default();
    unsafe {
        GetSystemPowerStatus(&mut status).map_err(|e| e.to_string())?;
    }
    Ok(json!({
        "on_battery": status.ACLineStatus == 0,
        "battery_percent": if status.BatteryLifePercent != 255 { Some(status.BatteryLifePercent) } else { None },
        "power_saver": (status.SystemStatusFlag & 1) != 0
    }))
}

#[cfg(not(windows))]
#[tauri::command]
pub fn get_power_status() -> Result<Value, String> {
    Ok(json!({
        "on_battery": false,
        "battery_percent": None::<u8>,
        "power_saver": false
    }))
}
