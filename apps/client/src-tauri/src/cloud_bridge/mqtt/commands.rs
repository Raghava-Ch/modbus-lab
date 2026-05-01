//! Tauri commands exposed to the Svelte frontend for the MQTT cloud bridge.

use tauri::{AppHandle, State};

use super::engine::{empty_status, start};
use super::events::{emit_log, emit_status, BridgeLogLevel};
use super::state::CloudBridgeState;
use super::types::{BridgeError, BridgeResult, BridgeStatus, StartBridgeRequest};
use crate::modbus::service::AppState as ModbusAppState;

/// Returns the current bridge status. Always succeeds — when nothing is
/// running the response carries `running: false, connected: false`.
#[tauri::command]
pub async fn get_cloud_bridge_status(
    state: State<'_, CloudBridgeState>,
) -> BridgeResult<BridgeStatus> {
    Ok(state.snapshot().await)
}

/// Start the MQTT bridge. Returns an error if it is already running so
/// the UI surfaces a clear "stop first" message instead of silently
/// replacing the running engine.
#[tauri::command]
pub async fn start_cloud_bridge(
    app: AppHandle,
    bridge_state: State<'_, CloudBridgeState>,
    modbus_state: State<'_, ModbusAppState>,
    request: StartBridgeRequest,
) -> BridgeResult<BridgeStatus> {
    if bridge_state.is_running().await {
        return Err(BridgeError::already_running());
    }

    emit_log(
        &app,
        BridgeLogLevel::Info,
        "cloud-bridge",
        format!(
            "start request broker={}:{} client_id={} mappings={}",
            request.broker.host,
            request.broker.port,
            request.broker.client_id,
            request.mappings.len()
        ),
    );

    let mapping_count = request.mappings.len();
    let broker_clone = request.broker.clone();

    // CloudBridgeState and ModbusAppState both wrap Arc<Mutex<…>> internally,
    // so cloning hands the engine a shared view of the same state.
    let bridge_for_engine = std::sync::Arc::new(bridge_state.inner().clone());
    let modbus_for_engine = std::sync::Arc::new(modbus_state.inner().clone());

    let handle = match start(app.clone(), bridge_for_engine, modbus_for_engine, request).await {
        Ok(handle) => handle,
        Err(err) => {
            emit_log(
                &app,
                BridgeLogLevel::Error,
                "cloud-bridge",
                format!("start failed: {}", err.message),
            );
            return Err(err);
        }
    };

    bridge_state
        .install(handle, broker_clone, mapping_count)
        .await;
    let snapshot = bridge_state.snapshot().await;
    emit_status(&app, &snapshot);
    Ok(snapshot)
}

/// Stop the MQTT bridge. Idempotent — calling on an already-stopped
/// bridge returns the empty status with no error.
#[tauri::command]
pub async fn stop_cloud_bridge(
    app: AppHandle,
    bridge_state: State<'_, CloudBridgeState>,
) -> BridgeResult<BridgeStatus> {
    if let Some(handle) = bridge_state.take().await {
        emit_log(
            &app,
            BridgeLogLevel::Info,
            "cloud-bridge",
            "stop requested",
        );
        handle.stop().await;
    }
    bridge_state.clear_after_stop().await;
    let snapshot = empty_status();
    emit_status(&app, &snapshot);
    emit_log(
        &app,
        BridgeLogLevel::Info,
        "cloud-bridge",
        "stopped",
    );
    Ok(snapshot)
}
