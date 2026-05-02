//! Server-side iBus v1.1 publisher.
//!
//! When `set_descriptor` is called from the UI, an `Overlay` is constructed
//! from the descriptor and stored in a process-wide `RwLock`. The Modbus
//! listener's FC03 handler queries this overlay first; if the requested
//! address falls in the iBus reserved region (HR 9000..9999) the overlay
//! value is returned, bypassing the application register table.
//!
//! This mirrors the integration model from
//! `ibus.tmp.specs/ibus-kit-2/reference/c/example_thermostat.c` — iBus owns
//! 9000..9999, everything else falls through.

use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

use ibus_core::{IbusDescriptor, Overlay, REGION_END, REGION_START};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::modbus::service::AppState;

// ---------------------------------------------------------------------------
// Process-wide overlay slot
// ---------------------------------------------------------------------------

fn slot() -> &'static RwLock<Option<Overlay>> {
    static SLOT: OnceLock<RwLock<Option<Overlay>>> = OnceLock::new();
    SLOT.get_or_init(|| RwLock::new(None))
}

/// True if iBus is active and owns the given HR address.
pub fn owns_hr(addr: u16) -> bool {
    if !(REGION_START..=REGION_END).contains(&addr) {
        return false;
    }
    slot().read().ok().and_then(|g| g.as_ref().map(|_| ())).is_some()
}

/// Read one HR via the overlay, if active. Returns `None` when no overlay is
/// installed (caller should fall through to the application register table).
pub fn read_hr(addr: u16) -> Option<u16> {
    if !(REGION_START..=REGION_END).contains(&addr) {
        return None;
    }
    let guard = slot().read().ok()?;
    let overlay = guard.as_ref()?;
    Some(overlay.read_hr(addr))
}

/// Snapshot the active descriptor (for command responses).
pub fn current_descriptor() -> Option<IbusDescriptor> {
    let guard = slot().read().ok()?;
    guard.as_ref().map(|o| o.descriptor().clone())
}

fn install(overlay: Overlay) {
    if let Ok(mut g) = slot().write() {
        *g = Some(overlay);
    }
}

fn uninstall() {
    if let Ok(mut g) = slot().write() {
        *g = None;
    }
}

// ---------------------------------------------------------------------------
// Persistence (app_data_dir/ibus_descriptor.json)
// ---------------------------------------------------------------------------

const STORE_FILE: &str = "ibus_descriptor.json";

fn descriptor_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(STORE_FILE))
}

fn save_to_disk(app: &AppHandle, descriptor: &IbusDescriptor) {
    if let Some(path) = descriptor_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(descriptor) {
            let _ = std::fs::write(path, json);
        }
    }
}

fn delete_from_disk(app: &AppHandle) {
    if let Some(path) = descriptor_path(app) {
        let _ = std::fs::remove_file(path);
    }
}

/// Load any persisted descriptor at startup. Called from `lib::run` after the
/// AppHandle is available. Errors are swallowed — startup must not fail just
/// because the descriptor file is missing or malformed.
pub fn load_persisted(app: &AppHandle) {
    let Some(path) = descriptor_path(app) else { return; };
    let Ok(text) = std::fs::read_to_string(&path) else { return; };
    let Ok(d): Result<IbusDescriptor, _> = serde_json::from_str(&text) else { return; };
    if let Ok(o) = Overlay::new(d) {
        install(o);
    }
}

// ---------------------------------------------------------------------------
// Tauri command DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDescriptorRequest {
    pub descriptor: IbusDescriptor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlapWarning {
    pub address: u16,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub manifest_addr: u16,
    pub point_addr: u16,
    pub overlaps: Vec<OverlapWarning>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ibus_set_descriptor(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SetDescriptorRequest,
) -> Result<ApplyResult, String> {
    // Build overlay (validates name lengths, address range, region overflow).
    let overlay = Overlay::new(request.descriptor.clone()).map_err(|e| e.to_string())?;
    let manifest_addr = overlay.manifest_addr();
    let point_addr = overlay.point_addr();

    // Detect overlap with currently-registered application HR addresses in
    // 9000..9999. We warn (not block) because the overlay always wins inside
    // the region; the user just won't be able to read those app registers.
    let mut overlaps = Vec::new();
    if let Some(handle) = state.listener_handle.lock().await.as_ref() {
        let guard = handle.app.lock().await;
        for addr in REGION_START..=REGION_END {
            if guard.is_holding_reg_registered(addr) {
                overlaps.push(OverlapWarning {
                    address: addr,
                    kind: "holding-register".to_string(),
                });
            }
            // Cap to avoid huge payloads.
            if overlaps.len() > 32 {
                break;
            }
        }
    }

    install(overlay);
    save_to_disk(&app, &request.descriptor);
    Ok(ApplyResult { manifest_addr, point_addr, overlaps })
}

#[tauri::command]
pub fn ibus_get_descriptor() -> Option<IbusDescriptor> {
    current_descriptor()
}

#[tauri::command]
pub fn ibus_clear(app: AppHandle) {
    uninstall();
    delete_from_disk(&app);
}

#[tauri::command]
pub fn ibus_export_descriptor() -> Result<String, String> {
    let d = current_descriptor().ok_or_else(|| "no descriptor installed".to_string())?;
    serde_json::to_string_pretty(&d).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub json: String,
}

#[tauri::command]
pub fn ibus_import_descriptor(request: ImportRequest) -> Result<IbusDescriptor, String> {
    let d: IbusDescriptor =
        serde_json::from_str(&request.json).map_err(|e| format!("invalid JSON: {}", e))?;
    // Validate by attempting overlay construction; do NOT install yet.
    Overlay::new(d.clone()).map_err(|e| e.to_string())?;
    Ok(d)
}
