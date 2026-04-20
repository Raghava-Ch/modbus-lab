use std::sync::Arc;
use std::time::Instant;

use tauri::{AppHandle, Emitter, State};

use super::events::emit_log;
use super::service::AppState;
use super::types::{
    ApiError, ApiResult, BackendEventLevel, CommandAck, ConnectionStatus, ConnectionStatusPayload,
    CustomFrameMode, CustomFrameRequest, CustomFrameResponse, DisconnectRequest, DiagnosticRequest,
    DiagnosticResponse, ReadExceptionStatusResponse, GetComEventCounterResponse,
    GetComEventLogRequest, GetComEventLogResponse, ReportServerIdResponse,
    ReadDeviceIdentificationRequest,
    ReadCoilsRequest, ReadCoilsResponse, ReadDiscreteInputsRequest, ReadDiscreteInputsResponse,
    ReadHoldingRegistersRequest, ReadHoldingRegistersResponse, ReadInputRegistersRequest,
    ReadInputRegistersResponse, SerialConnectRequest, TcpConnectRequest, WriteCoilRequest,
    WriteCoilResponse, WriteHoldingRegisterRequest, WriteHoldingRegisterResponse,
    WriteMassCoilsRequest, WriteMassCoilsResponse, WriteMassHoldingRegistersRequest,
    WriteMassHoldingRegistersResponse,
};

fn format_error_message(err: &ApiError) -> String {
    match &err.details {
        Some(details) if !details.trim().is_empty() => format!("{} ({})", err.message, details),
        _ => err.message.clone(),
    }
}

fn is_expected_response_buffer_full(err: &ApiError) -> bool {
    let message = err.message.to_ascii_lowercase();
    let details = err
        .details
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    message.contains("expected responses buffer is full")
        || details.contains("expected responses buffer is full")
        || details.contains("too many requests")
}

/// True for transport-layer errors that are eligible for the consecutive-failure
/// down-detection counter. Protocol-level Modbus exceptions (illegal address,
/// illegal function, …) are NOT counted here because they confirm liveness.
fn is_transport_error(err: &ApiError) -> bool {
    let combined = format!(
        "{} {}",
        err.message,
        err.details.as_deref().unwrap_or("")
    )
    .to_ascii_lowercase();
    is_transport_message(&combined)
}

/// Same check against a plain string — used when failures are returned embedded
/// inside a bulk response (FC15 / FC16) rather than as top-level `ApiError`.
fn is_transport_message(msg: &str) -> bool {
    let t = msg.to_ascii_lowercase();
    t.contains("timeout")
        || t.contains("timed out")
        || t.contains("io error")
        || t.contains("broken pipe")
        || t.contains("connection reset")
        || t.contains("not connected")
        || t.contains("transport")
        || t.contains("connection closed")
        || t.contains("too many requests")
        || t.contains("expected responses buffer is full")
        || t.contains("sendfailed")
        || t.contains("send failed")
        || t.contains("failed to send")
        || t.contains("connection aborted")
        || t.contains("unexpected eof")
        || t.contains("early eof")
}

#[tauri::command]
pub async fn list_serial_ports() -> ApiResult<Vec<String>> {
    let ports = serialport::available_ports().map_err(|err| {
        ApiError::backend_failure(
            "Unable to enumerate serial ports.",
            Some(err.to_string()),
            None,
        )
    })?;

    Ok(ports.into_iter().map(|p| p.port_name).collect())
}


#[tauri::command]
pub async fn connect_modbus_tcp(
    app: AppHandle,
    state: State<'_, AppState>,
    request: TcpConnectRequest,
) -> ApiResult<CommandAck> {
    let traffic_app = app.clone();
    let traffic_sink = Arc::new(move |message: String| {
        let event = super::types::BackendEvent {
            level: BackendEventLevel::Traffic,
            topic: "network".to_string(),
            message,
            status: None,
            analytics: None,
        };
        let _ = traffic_app.emit("modbus://event", &event);
    });

    emit_log(
        &app,
        BackendEventLevel::Info,
        "connection",
        format!(
            "connect.tcp start host={} port={}",
            request.host, request.port
        ),
        None,
        request.analytics.clone(),
    )
    .await;

    let status = match state.connect_tcp(app.clone(), &request, Some(traffic_sink)).await {
        Ok(status) => status,
        Err(err) => {
            emit_log(
                &app,
                BackendEventLevel::Error,
                "connection",
                format!("connect.tcp err msg={}", err.message),
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
        "connect.tcp ok",
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
            "disconnect req=no_session",
            Some(current.clone()),
            analytics.clone(),
        )
        .await;
    } else {
        emit_log(
            &app,
            BackendEventLevel::Info,
            "connection",
            "disconnect start",
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
            "disconnect ok",
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
        BackendEventLevel::Info,
        "connection",
        format!(
            "connect.rtu start port={} baud={} slave={}",
            request.port, request.baud_rate, request.slave_id
        ),
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
                format!("connect.rtu err msg={}", err.message),
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
        BackendEventLevel::Info,
        "connection",
        format!(
            "connect.ascii start port={} baud={} slave={}",
            request.port, request.baud_rate, request.slave_id
        ),
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
                format!("connect.ascii err msg={}", err.message),
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
    let started_at = Instant::now();
    let mut retried_after_recovery = false;

    loop {
    match state.read_coils(&request).await {
        Ok(response) => {
            state.record_request_success().await;
            emit_log(
                &app,
                BackendEventLevel::Info,
                "coils",
                format!(
                    "fc01.read ok start={} qty={} end={} rttMs={}",
                    response.start_address,
                    response.quantity,
                    response
                        .start_address
                        .saturating_add(response.quantity.saturating_sub(1)),
                    started_at.elapsed().as_millis()
                ),
                None,
                request.analytics.clone(),
            )
            .await;
            return Ok(response)
        }
        Err(err) => {
            if !retried_after_recovery && is_expected_response_buffer_full(&err) {
                retried_after_recovery = true;
                if let Err(recovery_err) = state
                    .recover_tcp_client_pipeline(request.analytics.clone())
                    .await
                {
                    return Err(recovery_err);
                }
                continue;
            }

            if is_transport_error(&err) && state.record_request_transport_failure().await {
                emit_log(
                    &app,
                    BackendEventLevel::Warn,
                    "connection",
                    "Server unreachable after consecutive transport failures. Pausing requests until reconnected.".to_string(),
                    Some(ConnectionStatusPayload {
                        status: ConnectionStatus::Reconnecting,
                        details: Some(format_error_message(&err)),
                    }),
                    err.analytics.clone(),
                )
                .await;
            } else if !is_transport_error(&err) {
                // Protocol exception or other definitive server response — server is reachable.
                state.record_request_success().await;
            }
            let details_msg = format_error_message(&err);
            emit_log(
                &app,
                BackendEventLevel::Error,
                "coils",
                format!(
                    "fc01.read err start={} qty={} end={} msg={} rttMs={}",
                    request.start_address,
                    request.quantity,
                    request
                        .start_address
                        .saturating_add(request.quantity.saturating_sub(1)),
                    details_msg,
                    started_at.elapsed().as_millis()
                ),
                None,
                err.analytics.clone(),
            )
            .await;
            return Err(err)
        }
    }
    }
}

#[tauri::command]
pub async fn read_discrete_inputs(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ReadDiscreteInputsRequest,
) -> ApiResult<ReadDiscreteInputsResponse> {
    let started_at = Instant::now();
    let mut retried_after_recovery = false;
    loop {
    match state.read_discrete_inputs(&request).await {
        Ok(response) => {
            state.record_request_success().await;
            emit_log(
                &app,
                BackendEventLevel::Info,
                "discrete-inputs",
                format!(
                    "fc02.read ok start={} qty={} end={} rttMs={}",
                    response.start_address,
                    response.quantity,
                    response
                        .start_address
                        .saturating_add(response.quantity.saturating_sub(1)),
                    started_at.elapsed().as_millis()
                ),
                None,
                request.analytics.clone(),
            )
            .await;
            return Ok(response)
        }
        Err(err) => {
            if !retried_after_recovery && is_expected_response_buffer_full(&err) {
                retried_after_recovery = true;
                if let Err(recovery_err) = state
                    .recover_tcp_client_pipeline(request.analytics.clone())
                    .await
                {
                    return Err(recovery_err);
                }
                continue;
            }
            if is_transport_error(&err) && state.record_request_transport_failure().await {
                emit_log(
                    &app,
                    BackendEventLevel::Warn,
                    "connection",
                    "Server unreachable after consecutive transport failures. Pausing requests until reconnected.".to_string(),
                    Some(ConnectionStatusPayload {
                        status: ConnectionStatus::Reconnecting,
                        details: Some(format_error_message(&err)),
                    }),
                    err.analytics.clone(),
                )
                .await;
            } else if !is_transport_error(&err) {
                state.record_request_success().await;
            }
            let details_msg = if let Some(details) = &err.details {
                format!("{} ({})", err.message, details)
            } else {
                err.message.clone()
            };
            emit_log(
                &app,
                BackendEventLevel::Error,
                "discrete-inputs",
                format!(
                    "fc02.read err start={} qty={} end={} msg={} rttMs={}",
                    request.start_address,
                    request.quantity,
                    request
                        .start_address
                        .saturating_add(request.quantity.saturating_sub(1)),
                    details_msg,
                    started_at.elapsed().as_millis()
                ),
                None,
                err.analytics.clone(),
            )
            .await;
            return Err(err)
        }
    }
    }
}

#[tauri::command]
pub async fn read_holding_registers(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ReadHoldingRegistersRequest,
) -> ApiResult<ReadHoldingRegistersResponse> {
    let started_at = Instant::now();
    let mut retried_after_recovery = false;
    loop {
    match state.read_holding_registers(&request).await {
        Ok(response) => {
            state.record_request_success().await;
            emit_log(
                &app,
                BackendEventLevel::Info,
                "holding-registers",
                format!(
                    "fc03.read ok start={} qty={} end={} rttMs={}",
                    response.start_address,
                    response.quantity,
                    response
                        .start_address
                        .saturating_add(response.quantity.saturating_sub(1)),
                    started_at.elapsed().as_millis()
                ),
                None,
                request.analytics.clone(),
            )
            .await;
            return Ok(response)
        }
        Err(err) => {
            if !retried_after_recovery && is_expected_response_buffer_full(&err) {
                retried_after_recovery = true;
                if let Err(recovery_err) = state
                    .recover_tcp_client_pipeline(request.analytics.clone())
                    .await
                {
                    return Err(recovery_err);
                }
                continue;
            }
            if is_transport_error(&err) && state.record_request_transport_failure().await {
                emit_log(
                    &app,
                    BackendEventLevel::Warn,
                    "connection",
                    "Server unreachable after consecutive transport failures. Pausing requests until reconnected.".to_string(),
                    Some(ConnectionStatusPayload {
                        status: ConnectionStatus::Reconnecting,
                        details: Some(format_error_message(&err)),
                    }),
                    err.analytics.clone(),
                )
                .await;
            } else if !is_transport_error(&err) {
                state.record_request_success().await;
            }
            let details_msg = if let Some(details) = &err.details {
                format!("{} ({})", err.message, details)
            } else {
                err.message.clone()
            };
            emit_log(
                &app,
                BackendEventLevel::Error,
                "holding-registers",
                format!(
                    "fc03.read err start={} qty={} end={} msg={} rttMs={}",
                    request.start_address,
                    request.quantity,
                    request
                        .start_address
                        .saturating_add(request.quantity.saturating_sub(1)),
                    details_msg,
                    started_at.elapsed().as_millis()
                ),
                None,
                err.analytics.clone(),
            )
            .await;
            return Err(err)
        }
    }
    }
}

#[tauri::command]
pub async fn read_input_registers(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ReadInputRegistersRequest,
) -> ApiResult<ReadInputRegistersResponse> {
    let started_at = Instant::now();
    let mut retried_after_recovery = false;
    loop {
    match state.read_input_registers(&request).await {
        Ok(response) => {
            state.record_request_success().await;
            emit_log(
                &app,
                BackendEventLevel::Info,
                "input-registers",
                format!(
                    "fc04.read ok start={} qty={} end={} rttMs={}",
                    response.start_address,
                    response.quantity,
                    response
                        .start_address
                        .saturating_add(response.quantity.saturating_sub(1)),
                    started_at.elapsed().as_millis()
                ),
                None,
                request.analytics.clone(),
            )
            .await;
            return Ok(response)
        }
        Err(err) => {
            if !retried_after_recovery && is_expected_response_buffer_full(&err) {
                retried_after_recovery = true;
                if let Err(recovery_err) = state
                    .recover_tcp_client_pipeline(request.analytics.clone())
                    .await
                {
                    return Err(recovery_err);
                }
                continue;
            }
            if is_transport_error(&err) && state.record_request_transport_failure().await {
                emit_log(
                    &app,
                    BackendEventLevel::Warn,
                    "connection",
                    "Server unreachable after consecutive transport failures. Pausing requests until reconnected.".to_string(),
                    Some(ConnectionStatusPayload {
                        status: ConnectionStatus::Reconnecting,
                        details: Some(format_error_message(&err)),
                    }),
                    err.analytics.clone(),
                )
                .await;
            } else if !is_transport_error(&err) {
                state.record_request_success().await;
            }
            let details_msg = if let Some(details) = &err.details {
                format!("{} ({})", err.message, details)
            } else {
                err.message.clone()
            };
            emit_log(
                &app,
                BackendEventLevel::Error,
                "input-registers",
                format!(
                    "fc04.read err start={} qty={} end={} msg={} rttMs={}",
                    request.start_address,
                    request.quantity,
                    request
                        .start_address
                        .saturating_add(request.quantity.saturating_sub(1)),
                    details_msg,
                    started_at.elapsed().as_millis()
                ),
                None,
                err.analytics.clone(),
            )
            .await;
            return Err(err)
        }
    }
    }
}

#[tauri::command]
pub async fn read_exception_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> ApiResult<ReadExceptionStatusResponse> {
    match state.read_exception_status().await {
        Ok(response) => Ok(response),
        Err(err) => {
            emit_log(
                &app,
                BackendEventLevel::Error,
                "diagnostics",
                format!("fc07.read err msg={}", err.message),
                None,
                err.analytics.clone(),
            )
            .await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn diagnostic(
    app: AppHandle,
    state: State<'_, AppState>,
    request: DiagnosticRequest,
) -> ApiResult<DiagnosticResponse> {
    match state.diagnostic(&request).await {
        Ok(response) => Ok(response),
        Err(err) => {
            emit_log(
                &app,
                BackendEventLevel::Error,
                "diagnostics",
                format!("fc08.run err sub={} msg={}", request.subfunction, err.message),
                None,
                err.analytics.clone(),
            )
            .await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn send_custom_frame(
    app: AppHandle,
    state: State<'_, AppState>,
    request: CustomFrameRequest,
) -> ApiResult<CustomFrameResponse> {
    let payload_bytes = match request.mode {
        CustomFrameMode::FunctionPayload => request
            .payload_hex
            .as_ref()
            .map(|v| v.chars().filter(|ch| ch.is_ascii_hexdigit()).count() / 2)
            .unwrap_or(0),
        CustomFrameMode::RawBytes => request
            .raw_hex
            .as_ref()
            .map(|v| v.chars().filter(|ch| ch.is_ascii_hexdigit()).count() / 2)
            .unwrap_or(0)
            .saturating_sub(1),
    };

    let function_hint = request
        .function_code
        .or_else(|| {
            request.raw_hex.as_ref().and_then(|raw| {
                let cleaned: String = raw.chars().filter(|ch| ch.is_ascii_hexdigit()).collect();
                if cleaned.len() >= 2 {
                    u8::from_str_radix(&cleaned[..2], 16).ok()
                } else {
                    None
                }
            })
        })
        .unwrap_or(0);

    if function_hint == 0 || function_hint >= 0x80 {
        emit_log(
            &app,
            BackendEventLevel::Warn,
            "custom-frame",
            format!(
                "custom.frame warn unusual_fc=0x{:02X} mode={:?}",
                function_hint, request.mode
            ),
            None,
            request.analytics.clone(),
        )
        .await;
    }

    if payload_bytes > 252 {
        emit_log(
            &app,
            BackendEventLevel::Warn,
            "custom-frame",
            format!(
                "custom.frame warn large_payload bytes={} max_pdu_payload=252",
                payload_bytes
            ),
            None,
            request.analytics.clone(),
        )
        .await;
    }

    emit_log(
        &app,
        BackendEventLevel::Info,
        "custom-frame",
        format!(
            "custom.frame send mode={:?} fc=0x{:02X} payload_bytes={}",
            request.mode, function_hint, payload_bytes
        ),
        None,
        request.analytics.clone(),
    )
    .await;

    match state.send_custom_frame(&request).await {
        Ok(response) => {
            emit_log(
                &app,
                BackendEventLevel::Traffic,
                "network",
                format!(
                    "custom.frame fc=0x{:02X}({}) req={} rsp={} summary={}",
                    response.function_code,
                    response.function_name,
                    response.request_hex,
                    response.response_hex,
                    response.response_summary
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
                "custom-frame",
                format!("custom.frame err msg={}", format_error_message(&err)),
                None,
                err.analytics.clone(),
            )
            .await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn get_com_event_counter(
    app: AppHandle,
    state: State<'_, AppState>,
) -> ApiResult<GetComEventCounterResponse> {
    match state.get_com_event_counter().await {
        Ok(response) => Ok(response),
        Err(err) => {
            emit_log(
                &app,
                BackendEventLevel::Error,
                "diagnostics",
                format!("fc11.read err msg={}", err.message),
                None,
                err.analytics.clone(),
            )
            .await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn get_com_event_log(
    app: AppHandle,
    state: State<'_, AppState>,
    request: GetComEventLogRequest,
) -> ApiResult<GetComEventLogResponse> {
    match state.get_com_event_log(&request).await {
        Ok(response) => Ok(response),
        Err(err) => {
            emit_log(
                &app,
                BackendEventLevel::Error,
                "diagnostics",
                format!(
                    "fc12.read err start={} count={} msg={}",
                    request.start, request.count, err.message
                ),
                None,
                err.analytics.clone(),
            )
            .await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn report_server_id(
    app: AppHandle,
    state: State<'_, AppState>,
) -> ApiResult<ReportServerIdResponse> {
    match state.report_server_id().await {
        Ok(response) => Ok(response),
        Err(err) => {
            emit_log(
                &app,
                BackendEventLevel::Error,
                "diagnostics",
                format!("fc17.read err msg={}", err.message),
                None,
                err.analytics.clone(),
            )
            .await;
            Err(err)
        }
    }
}

#[tauri::command]
pub async fn read_device_identification(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ReadDeviceIdentificationRequest,
) -> ApiResult<super::types::ReadDeviceIdentificationResponse> {
    match state.read_device_identification(&request).await {
        Ok(response) => Ok(response),
        Err(err) => {
            emit_log(
                &app,
                BackendEventLevel::Error,
                "diagnostics",
                format!("fc43.read err msg={}", err.message),
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
    let started_at = Instant::now();
    let mut retried_after_recovery = false;
    loop {
    match state.write_coil(&request).await {
        Ok(response) => {
            state.record_request_success().await;
            emit_log(
                &app,
                BackendEventLevel::Info,
                "coils",
                format!(
                    "fc05.write ok addr={} val={} rttMs={}",
                    response.address,
                    if response.value { 1 } else { 0 },
                    started_at.elapsed().as_millis()
                ),
                None,
                request.analytics.clone(),
            )
            .await;
            return Ok(response)
        }
        Err(err) => {
            if !retried_after_recovery && is_expected_response_buffer_full(&err) {
                retried_after_recovery = true;
                if let Err(recovery_err) = state
                    .recover_tcp_client_pipeline(request.analytics.clone())
                    .await
                {
                    return Err(recovery_err);
                }
                continue;
            }
            if is_transport_error(&err) && state.record_request_transport_failure().await {
                emit_log(
                    &app,
                    BackendEventLevel::Warn,
                    "connection",
                    "Server unreachable after consecutive transport failures. Pausing requests until reconnected.".to_string(),
                    Some(ConnectionStatusPayload {
                        status: ConnectionStatus::Reconnecting,
                        details: Some(format_error_message(&err)),
                    }),
                    err.analytics.clone(),
                )
                .await;
            }
            emit_log(
                &app,
                BackendEventLevel::Error,
                "coils",
                format!(
                    "fc05.write err addr={} msg={} rttMs={}",
                    request.address,
                    err.message,
                    started_at.elapsed().as_millis()
                ),
                None,
                err.analytics.clone(),
            )
            .await;
            return Err(err)
        }
    }
    }
}

#[tauri::command]
pub async fn write_coils_batch(
    app: AppHandle,
    state: State<'_, AppState>,
    request: WriteMassCoilsRequest,
) -> ApiResult<WriteMassCoilsResponse> {
    let started_at = Instant::now();
    let mut retried_after_recovery = false;
    loop {
    match state.write_coils_optimized(&request).await {
        Ok(response) => {
            // write_coils_optimized never returns Err for individual write
            // failures — they are stuffed into response.failures.  We must
            // inspect them to feed the down-detection counter correctly.
            let all_failed = response.written_count == 0 && response.total_count > 0;
            if all_failed {
                let transport_fail_count = response
                    .failures
                    .iter()
                    .filter(|f| is_transport_message(&f.message))
                    .count();
                let is_full_transport_down =
                    transport_fail_count == response.failures.len() && transport_fail_count > 0;
                if is_full_transport_down && state.record_request_transport_failure().await {
                    emit_log(
                        &app,
                        BackendEventLevel::Warn,
                        "connection",
                        "Server unreachable: all batch coil writes failed with transport errors. Pausing until reconnected."
                            .to_string(),
                        Some(ConnectionStatusPayload {
                            status: ConnectionStatus::Reconnecting,
                            details: Some(format!(
                                "All {} coil writes failed (transport).",
                                transport_fail_count
                            )),
                        }),
                        request.analytics.clone(),
                    )
                    .await;
                }
                // Do NOT call record_request_success — don't reset the counter.
            } else if response.written_count > 0 {
                // At least one write got through; connection is live.
                state.record_request_success().await;
            }
            emit_log(
                &app,
                BackendEventLevel::Info,
                "coils",
                format!(
                    "fc15.write ok req={} ok={} fail={} rttMs={}",
                    request.coils.len(),
                    response.written_count,
                    response.total_count.saturating_sub(response.written_count),
                    started_at.elapsed().as_millis()
                ),
                None,
                request.analytics.clone(),
            )
            .await;
            return Ok(response)
        }
        Err(err) => {
            if !retried_after_recovery && is_expected_response_buffer_full(&err) {
                retried_after_recovery = true;
                if let Err(recovery_err) = state
                    .recover_tcp_client_pipeline(request.analytics.clone())
                    .await
                {
                    return Err(recovery_err);
                }
                continue;
            }
            if is_transport_error(&err) && state.record_request_transport_failure().await {
                emit_log(
                    &app,
                    BackendEventLevel::Warn,
                    "connection",
                    "Server unreachable after consecutive transport failures. Pausing requests until reconnected.".to_string(),
                    Some(ConnectionStatusPayload {
                        status: ConnectionStatus::Reconnecting,
                        details: Some(format_error_message(&err)),
                    }),
                    err.analytics.clone(),
                )
                .await;
            }
            emit_log(
                &app,
                BackendEventLevel::Error,
                "coils",
                format!(
                    "fc15.write err req={} msg={} rttMs={}",
                    request.coils.len(),
                    err.message,
                    started_at.elapsed().as_millis()
                ),
                None,
                err.analytics.clone(),
            )
            .await;
            return Err(err)
        }
    }
    }
}

#[tauri::command]
pub async fn write_holding_register(
    app: AppHandle,
    state: State<'_, AppState>,
    request: WriteHoldingRegisterRequest,
) -> ApiResult<WriteHoldingRegisterResponse> {
    let started_at = Instant::now();
    let mut retried_after_recovery = false;
    loop {
    match state.write_holding_register(&request).await {
        Ok(response) => {
            state.record_request_success().await;
            emit_log(
                &app,
                BackendEventLevel::Info,
                "holding-registers",
                format!(
                    "fc06.write ok addr={} val={} rttMs={}",
                    response.address,
                    response.value,
                    started_at.elapsed().as_millis()
                ),
                None,
                request.analytics.clone(),
            )
            .await;
            return Ok(response)
        }
        Err(err) => {
            if !retried_after_recovery && is_expected_response_buffer_full(&err) {
                retried_after_recovery = true;
                if let Err(recovery_err) = state
                    .recover_tcp_client_pipeline(request.analytics.clone())
                    .await
                {
                    return Err(recovery_err);
                }
                continue;
            }
            if is_transport_error(&err) && state.record_request_transport_failure().await {
                emit_log(
                    &app,
                    BackendEventLevel::Warn,
                    "connection",
                    "Server unreachable after consecutive transport failures. Pausing requests until reconnected.".to_string(),
                    Some(ConnectionStatusPayload {
                        status: ConnectionStatus::Reconnecting,
                        details: Some(format_error_message(&err)),
                    }),
                    err.analytics.clone(),
                )
                .await;
            }
            emit_log(
                &app,
                BackendEventLevel::Error,
                "holding-registers",
                format!(
                    "fc06.write err addr={} msg={} rttMs={}",
                    request.address,
                    err.message,
                    started_at.elapsed().as_millis()
                ),
                None,
                err.analytics.clone(),
            )
            .await;
            return Err(err)
        }
    }
    }
}

#[tauri::command]
pub async fn write_holding_registers_batch(
    app: AppHandle,
    state: State<'_, AppState>,
    request: WriteMassHoldingRegistersRequest,
) -> ApiResult<WriteMassHoldingRegistersResponse> {
    let started_at = Instant::now();
    let mut retried_after_recovery = false;
    loop {
    match state.write_holding_registers_optimized(&request).await {
        Ok(response) => {
            let all_failed = response.written_count == 0 && response.total_count > 0;
            if all_failed {
                let transport_fail_count = response
                    .failures
                    .iter()
                    .filter(|f| is_transport_message(&f.message))
                    .count();
                let is_full_transport_down =
                    transport_fail_count == response.failures.len() && transport_fail_count > 0;
                if is_full_transport_down && state.record_request_transport_failure().await {
                    emit_log(
                        &app,
                        BackendEventLevel::Warn,
                        "connection",
                        "Server unreachable: all batch register writes failed with transport errors. Pausing until reconnected."
                            .to_string(),
                        Some(ConnectionStatusPayload {
                            status: ConnectionStatus::Reconnecting,
                            details: Some(format!(
                                "All {} register writes failed (transport).",
                                transport_fail_count
                            )),
                        }),
                        request.analytics.clone(),
                    )
                    .await;
                }
            } else if response.written_count > 0 {
                state.record_request_success().await;
            }
            emit_log(
                &app,
                BackendEventLevel::Info,
                "holding-registers",
                format!(
                    "fc16.write ok req={} ok={} fail={} rttMs={}",
                    request.registers.len(),
                    response.written_count,
                    response.total_count.saturating_sub(response.written_count),
                    started_at.elapsed().as_millis()
                ),
                None,
                request.analytics.clone(),
            )
            .await;
            return Ok(response)
        }
        Err(err) => {
            if !retried_after_recovery && is_expected_response_buffer_full(&err) {
                retried_after_recovery = true;
                if let Err(recovery_err) = state
                    .recover_tcp_client_pipeline(request.analytics.clone())
                    .await
                {
                    return Err(recovery_err);
                }
                continue;
            }
            if is_transport_error(&err) && state.record_request_transport_failure().await {
                emit_log(
                    &app,
                    BackendEventLevel::Warn,
                    "connection",
                    "Server unreachable after consecutive transport failures. Pausing requests until reconnected.".to_string(),
                    Some(ConnectionStatusPayload {
                        status: ConnectionStatus::Reconnecting,
                        details: Some(format_error_message(&err)),
                    }),
                    err.analytics.clone(),
                )
                .await;
            }
            emit_log(
                &app,
                BackendEventLevel::Error,
                "holding-registers",
                format!(
                    "fc16.write err req={} msg={} rttMs={}",
                    request.registers.len(),
                    err.message,
                    started_at.elapsed().as_millis()
                ),
                None,
                err.analytics.clone(),
            )
            .await;
            return Err(err)
        }
    }
    }
}
