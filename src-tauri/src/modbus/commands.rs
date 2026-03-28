use tauri::{AppHandle, State};

use super::events::emit_log;
use super::service::AppState;
use super::types::{
    ApiError, ApiResult, BackendEventLevel, CommandAck, ConnectionStatusPayload, DisconnectRequest,
    ReadCoilsRequest, ReadCoilsResponse, SerialConnectRequest, TcpConnectRequest,
    WriteCoilRequest, WriteCoilResponse, WriteMassCoilsRequest, WriteMassCoilsResponse,
};

#[tauri::command]
pub async fn connect_modbus_tcp(
    app: AppHandle,
    state: State<'_, AppState>,
    request: TcpConnectRequest,
) -> ApiResult<CommandAck> {
    emit_log(
        &app,
        BackendEventLevel::Info,
        "connection",
        format!("Connecting TCP {}:{}", request.host, request.port),
        None,
        request.analytics.clone(),
    )
    .await;

    let status = match state.connect_tcp(&request).await {
        Ok(status) => status,
        Err(err) => {
            emit_log(
                &app,
                BackendEventLevel::Error,
                "connection",
                format!("TCP connect failed: {}", err.message),
                None,
                err.analytics.clone(),
            )
            .await;
            return Err(err);
        }
    };

    emit_log(
        &app,
        BackendEventLevel::Info,
        "connection",
        "TCP connected",
        Some(status.clone()),
        request.analytics.clone(),
    )
    .await;

    Ok(CommandAck {
        ok: true,
        message: "TCP connection established".to_string(),
        status,
        analytics: request.analytics,
    })
}

#[tauri::command]
pub async fn disconnect_modbus(
    app: AppHandle,
    state: State<'_, AppState>,
    request: Option<DisconnectRequest>,
) -> ApiResult<CommandAck> {
    let analytics = request.and_then(|r| r.analytics);

    let current = state.status().await;
    if matches!(current.status, super::types::ConnectionStatus::Disconnected) {
        emit_log(
            &app,
            BackendEventLevel::Warn,
            "connection",
            "Disconnect requested but no active Modbus session exists",
            Some(current.clone()),
            analytics.clone(),
        )
        .await;
    } else {
        emit_log(
            &app,
            BackendEventLevel::Info,
            "connection",
            "Disconnecting Modbus session",
            Some(current.clone()),
            analytics.clone(),
        )
        .await;
    }

    let outcome = state.disconnect().await;

    if outcome.had_active_connection {
        emit_log(
            &app,
            BackendEventLevel::Info,
            "connection",
            "Disconnected",
            Some(outcome.status.clone()),
            analytics.clone(),
        )
        .await;
    }

    Ok(CommandAck {
        ok: true,
        message: if outcome.had_active_connection {
            "Disconnected".to_string()
        } else {
            "No active connection".to_string()
        },
        status: outcome.status,
        analytics,
    })
}

#[tauri::command]
pub async fn connect_modbus_serial_rtu(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SerialConnectRequest,
) -> ApiResult<CommandAck> {
    emit_log(
        &app,
        BackendEventLevel::Warn,
        "connection",
        "Serial RTU command scaffold reached",
        None,
        request.analytics.clone(),
    )
    .await;

    match state.scaffold_serial_rtu(&request).await {
        Ok(status) => Ok(CommandAck {
            ok: true,
            message: "Serial RTU connected".to_string(),
            status,
            analytics: request.analytics,
        }),
        Err(err) => {
            emit_log(
                &app,
                BackendEventLevel::Warn,
                "connection",
                err.message.clone(),
                None,
                err.analytics.clone(),
            )
            .await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn connect_modbus_serial_ascii(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SerialConnectRequest,
) -> ApiResult<CommandAck> {
    emit_log(
        &app,
        BackendEventLevel::Warn,
        "connection",
        "Serial ASCII command scaffold reached",
        None,
        request.analytics.clone(),
    )
    .await;

    match state.scaffold_serial_ascii(&request).await {
        Ok(status) => Ok(CommandAck {
            ok: true,
            message: "Serial ASCII connected".to_string(),
            status,
            analytics: request.analytics,
        }),
        Err(err) => {
            emit_log(
                &app,
                BackendEventLevel::Warn,
                "connection",
                err.message.clone(),
                None,
                err.analytics.clone(),
            )
            .await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn get_modbus_connection_status(
    state: State<'_, AppState>,
) -> Result<ConnectionStatusPayload, ApiError> {
    Ok(state.status().await)
}

#[tauri::command]
pub async fn read_coils(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ReadCoilsRequest,
) -> ApiResult<ReadCoilsResponse> {
    match state.read_coils(&request).await {
        Ok(response) => Ok(response),
        Err(err) => {
            emit_log(
                &app,
                BackendEventLevel::Error,
                "coils",
                format!("Read coils failed: {}", err.message),
                None,
                err.analytics.clone(),
            )
            .await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn write_coil(
    app: AppHandle,
    state: State<'_, AppState>,
    request: WriteCoilRequest,
) -> ApiResult<WriteCoilResponse> {
    match state.write_coil(&request).await {
        Ok(response) => {
            emit_log(
                &app,
                BackendEventLevel::Traffic,
                "coils",
                format!("Coil {} → {}", response.address, if response.value { "ON" } else { "OFF" }),
                None,
                request.analytics.clone(),
            )
            .await;
            Ok(response)
        }
        Err(err) => {
            emit_log(
                &app,
                BackendEventLevel::Error,
                "coils",
                format!("Write coil {} failed: {}", request.address, err.message),
                None,
                err.analytics.clone(),
            )
            .await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn write_coils_batch(
    app: AppHandle,
    state: State<'_, AppState>,
    request: WriteMassCoilsRequest,
) -> ApiResult<WriteMassCoilsResponse> {
    match state.write_coils_optimized(&request).await {
        Ok(response) => {
            emit_log(
                &app,
                BackendEventLevel::Traffic,
                "coils",
                format!(
                    "Batch write {} coils ({}/{} success)",
                    request.coils.len(),
                    response.written_count,
                    response.total_count
                ),
                None,
                request.analytics.clone(),
            )
            .await;
            Ok(response)
        }
        Err(err) => {
            emit_log(
                &app,
                BackendEventLevel::Error,
                "coils",
                format!("Batch write failed: {}", err.message),
                None,
                err.analytics.clone(),
            )
            .await;
            Err(err)
        }
    }
}

