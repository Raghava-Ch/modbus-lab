//! Tauri event emission helpers for the MQTT cloud bridge.
//!
//! Two channels are used:
//! * `cloud-bridge://event` for traffic / log lines mirrored into the app
//!   log panel (level: info | warn | error | traffic).
//! * `cloud-bridge://status` whenever the bridge running/connected state
//!   changes so the UI can update its badge without polling.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use super::types::BridgeStatus;

pub const EVT_BRIDGE_LOG: &str = "cloud-bridge://event";
pub const EVT_BRIDGE_STATUS: &str = "cloud-bridge://status";

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BridgeLogLevel {
    Info,
    Warn,
    Error,
    Traffic,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeLogEvent {
    pub level: BridgeLogLevel,
    pub topic: String,
    pub message: String,
}

pub fn emit_log(
    app: &AppHandle,
    level: BridgeLogLevel,
    topic: impl Into<String>,
    message: impl Into<String>,
) {
    let _ = app.emit(
        EVT_BRIDGE_LOG,
        BridgeLogEvent {
            level,
            topic: topic.into(),
            message: message.into(),
        },
    );
}

pub fn emit_status(app: &AppHandle, status: &BridgeStatus) {
    let _ = app.emit(EVT_BRIDGE_STATUS, status);
}
