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
    ListenerClientSession, ListenerClientsResponse, ListenerStartRequest, ListenerStatusPayload,
    ListenerTransport,
    ReadDeviceIdentificationRequest,
    ReadCoilsRequest, ReadCoilsResponse, ReadDiscreteInputsRequest, ReadDiscreteInputsResponse,
    ReadFifoQueueRequest, ReadFifoQueueResponse,
    ReadHoldingRegistersRequest, ReadHoldingRegistersResponse, ReadInputRegistersRequest,
    ReadInputRegistersResponse, SerialConnectRequest, TcpConnectRequest, WriteCoilRequest,
    WriteCoilResponse, WriteHoldingRegisterRequest, WriteHoldingRegisterResponse,
    WriteMassCoilsRequest, WriteMassCoilsResponse, WriteMassHoldingRegistersRequest,
    WriteMassHoldingRegistersResponse,
    StoreReadBoolEntry, StoreReadU16Entry,
    ReadFileRecordsRequest, WriteFileRecordsRequest, FileRecordsResponse,
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

fn parse_hex_input_local(input: &str) -> Result<Vec<u8>, String> {
    let cleaned: String = input.chars().filter(|ch| ch.is_ascii_hexdigit()).collect();
    if cleaned.len() % 2 != 0 {
        return Err("Hex input must contain an even number of hex digits.".to_string());
    }

    let mut out = Vec::with_capacity(cleaned.len() / 2);
    let bytes = cleaned.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let part = std::str::from_utf8(&bytes[i..i + 2])
            .map_err(|_| "Invalid UTF-8 while parsing hex input.".to_string())?;
        let value = u8::from_str_radix(part, 16)
            .map_err(|_| format!("Invalid hex byte '{part}'."))?;
        out.push(value);
        i += 2;
    }

    Ok(out)
}

fn format_hex_bytes_local(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{:02X}", byte))
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_fc20_read_segments(payload: &[u8]) -> Result<Vec<(u16, u16, u16)>, String> {
    if payload.is_empty() {
        return Err("FC20 payload is empty.".to_string());
    }

    let byte_count = payload[0] as usize;
    if byte_count != payload.len().saturating_sub(1) {
        return Err(format!(
            "FC20 byte count mismatch: header={}, actual={}",
            byte_count,
            payload.len().saturating_sub(1)
        ));
    }

    let mut cursor = 1_usize;
    let mut segments = Vec::new();
    while cursor < payload.len() {
        if cursor + 6 >= payload.len() {
            return Err("FC20 segment truncated.".to_string());
        }
        let reference_type = payload[cursor];
        if reference_type != 0x06 {
            return Err(format!("FC20 unsupported reference type 0x{:02X}", reference_type));
        }

        let file = u16::from_be_bytes([payload[cursor + 1], payload[cursor + 2]]);
        let record = u16::from_be_bytes([payload[cursor + 3], payload[cursor + 4]]);
        let word_count = u16::from_be_bytes([payload[cursor + 5], payload[cursor + 6]]);
        if word_count == 0 {
            return Err("FC20 word count must be > 0.".to_string());
        }
        segments.push((file, record, word_count));
        cursor += 7;
    }

    Ok(segments)
}

fn parse_fc21_write_segments(payload: &[u8]) -> Result<Vec<(u16, u16, Vec<u16>)>, String> {
    if payload.is_empty() {
        return Err("FC21 payload is empty.".to_string());
    }

    let byte_count = payload[0] as usize;
    if byte_count != payload.len().saturating_sub(1) {
        return Err(format!(
            "FC21 byte count mismatch: header={}, actual={}",
            byte_count,
            payload.len().saturating_sub(1)
        ));
    }

    let mut cursor = 1_usize;
    let mut segments = Vec::new();
    while cursor < payload.len() {
        if cursor + 6 >= payload.len() {
            return Err("FC21 segment truncated.".to_string());
        }

        let reference_type = payload[cursor];
        if reference_type != 0x06 {
            return Err(format!("FC21 unsupported reference type 0x{:02X}", reference_type));
        }

        let file = u16::from_be_bytes([payload[cursor + 1], payload[cursor + 2]]);
        let record = u16::from_be_bytes([payload[cursor + 3], payload[cursor + 4]]);
        let word_count = u16::from_be_bytes([payload[cursor + 5], payload[cursor + 6]]) as usize;
        cursor += 7;

        let bytes_needed = word_count * 2;
        if cursor + bytes_needed > payload.len() {
            return Err("FC21 segment data truncated.".to_string());
        }

        let mut values = Vec::with_capacity(word_count);
        for _ in 0..word_count {
            values.push(u16::from_be_bytes([payload[cursor], payload[cursor + 1]]));
            cursor += 2;
        }

        segments.push((file, record, values));
    }

    Ok(segments)
}

fn summarize_file_record_segments(mode: &str, count: usize) -> String {
    format!("store.{} segments={}", mode, count)
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
pub async fn listener_start(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ListenerStartRequest,
) -> ApiResult<CommandAck> {
    let analytics = request.analytics.clone();

    match request.transport {
        ListenerTransport::Tcp => {
            let bind_host = request
                .bind_address
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| "0.0.0.0".to_string());
            let port = request.port.unwrap_or(502);
            let bind_addr = format!("{bind_host}:{port}");

            // Stop any existing listener first.
            {
                let mut locked = state.listener_handle.lock().await;
                if let Some(old) = locked.take() {
                    old.stop();
                }
            }

            let handle = super::listener::start_tcp_listener(
                app.clone(),
                bind_addr.clone(),
                request.unit_id,
                analytics.clone(),
            )
            .await?;

            // Hydrate listener FIFO store from persistent server-side queue state.
            {
                let fifo_snapshot = state.fifo_store.lock().await.clone();
                let mut app_store = handle.app.lock().await;
                for (address, values) in fifo_snapshot {
                    app_store.set_fifo_queue(address, &values);
                }

                let file_record_snapshot = state.file_record_store.lock().await.clone();
                for ((file_number, record_number), values) in file_record_snapshot {
                    app_store.set_file_record(file_number, record_number, &values);
                }
            }

            let details = Some(format!("{bind_addr} (unit {})", request.unit_id));

            {
                let mut locked = state.listener_handle.lock().await;
                *locked = Some(handle);
            }

            Ok(CommandAck {
                ok: true,
                message: "Listener started".to_string(),
                status: ConnectionStatusPayload {
                    status: ConnectionStatus::ConnectedTcp,
                    details,
                },
                analytics,
            })
        }
        ListenerTransport::SerialRtu | ListenerTransport::SerialAscii => {
            Err(ApiError::not_implemented(
                "Serial Modbus server mode",
                analytics,
            ))
        }
    }
}

#[tauri::command]
pub async fn listener_stop(
    app: AppHandle,
    state: State<'_, AppState>,
    request: Option<DisconnectRequest>,
) -> ApiResult<CommandAck> {
    let analytics = request.and_then(|r| r.analytics);

    let had_listener = {
        let mut locked = state.listener_handle.lock().await;
        if let Some(handle) = locked.take() {
            handle.stop();
            true
        } else {
            false
        }
    };

    let idle_status = ListenerStatusPayload {
        status: "idle".to_string(),
        details: None,
        transport: None,
        bind_target: None,
        unit_id: None,
        active_clients: 0,
        uptime_ms: None,
        last_error: None,
    };
    let _ = app.emit("modbus://listener_status_changed", &idle_status);

    emit_log(
        &app,
        BackendEventLevel::Info,
        "listener",
        if had_listener { "listener.stop ok" } else { "listener.stop no_op (not running)" },
        None,
        analytics.clone(),
    )
    .await;

    Ok(CommandAck {
        ok: true,
        message: if had_listener {
            "Listener stopped".to_string()
        } else {
            "Listener was not running".to_string()
        },
        status: ConnectionStatusPayload {
            status: ConnectionStatus::Disconnected,
            details: None,
        },
        analytics,
    })
}

#[tauri::command]
pub async fn listener_status(
    state: State<'_, AppState>,
) -> ApiResult<ListenerStatusPayload> {
    let locked = state.listener_handle.lock().await;
    match locked.as_ref() {
        None => Ok(ListenerStatusPayload {
            status: "idle".to_string(),
            details: None,
            transport: None,
            bind_target: None,
            unit_id: None,
            active_clients: 0,
            uptime_ms: None,
            last_error: None,
        }),
        Some(handle) => {
            let sessions = handle.sessions.lock().await;
            Ok(ListenerStatusPayload {
                status: "running".to_string(),
                details: Some(format!(
                    "{} (unit {})",
                    handle.bind_addr, handle.unit_id
                )),
                transport: Some(handle.transport.clone()),
                bind_target: Some(handle.bind_addr.clone()),
                unit_id: Some(handle.unit_id),
                active_clients: sessions.len() as u32,
                uptime_ms: Some(handle.uptime_ms()),
                last_error: None,
            })
        }
    }
}

#[tauri::command]
pub async fn listener_clients(
    app: AppHandle,
    state: State<'_, AppState>,
) -> ApiResult<ListenerClientsResponse> {
    let locked = state.listener_handle.lock().await;
    let response = match locked.as_ref() {
        None => ListenerClientsResponse {
            active_clients: 0,
            sessions: Vec::new(),
        },
        Some(handle) => {
            let sessions = handle.sessions.lock().await;
            ListenerClientsResponse {
                active_clients: sessions.len() as u32,
                sessions: sessions
                    .iter()
                    .map(|s| ListenerClientSession {
                        id: s.id.clone(),
                        endpoint: s.peer.to_string(),
                        connected_at_ms: s.connected_at_ms,
                    })
                    .collect(),
            }
        }
    };

    let _ = app.emit("modbus://listener_clients", &response);
    Ok(response)
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
pub async fn read_fifo_queue(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ReadFifoQueueRequest,
) -> ApiResult<ReadFifoQueueResponse> {
    let started_at = Instant::now();
    let mut retried_after_recovery = false;
    loop {
        match state.read_fifo_queue(&request).await {
            Ok(response) => {
                state.record_request_success().await;
                emit_log(
                    &app,
                    BackendEventLevel::Info,
                    "fifo-queue",
                    format!(
                        "fc24.read ok addr={} count={} rttMs={}",
                        response.address,
                        response.fifo_count,
                        started_at.elapsed().as_millis()
                    ),
                    None,
                    request.analytics.clone(),
                )
                .await;
                return Ok(response);
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

                let details_msg = format_error_message(&err);
                emit_log(
                    &app,
                    BackendEventLevel::Error,
                    "fifo-queue",
                    format!(
                        "fc24.read err addr={} msg={} rttMs={}",
                        request.address,
                        details_msg,
                        started_at.elapsed().as_millis()
                    ),
                    None,
                    err.analytics.clone(),
                )
                .await;
                return Err(err);
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

/// Write a single coil directly to the server's in-memory data store.
/// This bypasses the Modbus client path and updates the value that Modbus
/// clients will see when they read coils from this server.
#[tauri::command]
pub async fn store_write_coil(
    state: State<'_, AppState>,
    request: WriteCoilRequest,
) -> ApiResult<WriteCoilResponse> {
    let locked = state.listener_handle.lock().await;
    match locked.as_ref() {
        None => Err(ApiError::backend_failure(
            "No listener is running. Start the server listener first.",
            None,
            request.analytics,
        )),
        Some(handle) => {
            let mut app = handle.app.lock().await;
            app.set_coil(request.address, request.value);
            Ok(WriteCoilResponse {
                address: request.address,
                value: request.value,
            })
        }
    }
}

/// Write multiple coils directly to the server's in-memory data store.
#[tauri::command]
pub async fn store_write_coils_batch(
    state: State<'_, AppState>,
    request: WriteMassCoilsRequest,
) -> ApiResult<WriteMassCoilsResponse> {
    let locked = state.listener_handle.lock().await;
    match locked.as_ref() {
        None => Err(ApiError::backend_failure(
            "No listener is running. Start the server listener first.",
            None,
            request.analytics,
        )),
        Some(handle) => {
            let mut app = handle.app.lock().await;
            let pairs: Vec<(u16, bool)> = request.coils.iter().map(|c| (c.address, c.value)).collect();
            app.set_coils_batch(&pairs);
            let total = request.coils.len();
            Ok(WriteMassCoilsResponse {
                written_count: total,
                total_count: total,
                failures: Vec::new(),
            })
        }
    }
}

// ── Address registration helpers ──────────────────────────────────────────────
// These commands are used by the server UI to keep the data-store registration
// masks in sync with the address tables shown in the UI. They silently no-op
// when no listener is running; the UI syncs again after the listener starts.

#[tauri::command]
pub async fn store_remove_coil(state: State<'_, AppState>, address: u16) -> ApiResult<()> {
    let locked = state.listener_handle.lock().await;
    if let Some(handle) = locked.as_ref() {
        handle.app.lock().await.remove_coil(address);
    }
    Ok(())
}

#[tauri::command]
pub async fn store_clear_coils(state: State<'_, AppState>) -> ApiResult<()> {
    let locked = state.listener_handle.lock().await;
    if let Some(handle) = locked.as_ref() {
        handle.app.lock().await.clear_coils();
    }
    Ok(())
}

#[tauri::command]
pub async fn store_sync_coil_addresses(state: State<'_, AppState>, addresses: Vec<u16>) -> ApiResult<()> {
    let locked = state.listener_handle.lock().await;
    if let Some(handle) = locked.as_ref() {
        handle.app.lock().await.sync_coil_addresses(&addresses);
    }
    Ok(())
}

#[tauri::command]
pub async fn store_set_discrete_input(state: State<'_, AppState>, address: u16, value: bool) -> ApiResult<()> {
    let locked = state.listener_handle.lock().await;
    if let Some(handle) = locked.as_ref() {
        handle.app.lock().await.set_discrete_input(address, value);
    }
    Ok(())
}

#[tauri::command]
pub async fn store_remove_discrete_input(state: State<'_, AppState>, address: u16) -> ApiResult<()> {
    let locked = state.listener_handle.lock().await;
    if let Some(handle) = locked.as_ref() {
        handle.app.lock().await.remove_discrete_input(address);
    }
    Ok(())
}

#[tauri::command]
pub async fn store_clear_discrete_inputs(state: State<'_, AppState>) -> ApiResult<()> {
    let locked = state.listener_handle.lock().await;
    if let Some(handle) = locked.as_ref() {
        handle.app.lock().await.clear_discrete_inputs();
    }
    Ok(())
}

#[tauri::command]
pub async fn store_sync_discrete_input_addresses(state: State<'_, AppState>, addresses: Vec<u16>) -> ApiResult<()> {
    let locked = state.listener_handle.lock().await;
    if let Some(handle) = locked.as_ref() {
        handle.app.lock().await.sync_discrete_input_addresses(&addresses);
    }
    Ok(())
}

#[tauri::command]
pub async fn store_write_holding_reg(state: State<'_, AppState>, address: u16, value: u16) -> ApiResult<()> {
    let locked = state.listener_handle.lock().await;
    if let Some(handle) = locked.as_ref() {
        handle.app.lock().await.set_holding_reg(address, value);
    }
    Ok(())
}

#[tauri::command]
pub async fn store_remove_holding_reg(state: State<'_, AppState>, address: u16) -> ApiResult<()> {
    let locked = state.listener_handle.lock().await;
    if let Some(handle) = locked.as_ref() {
        handle.app.lock().await.remove_holding_reg(address);
    }
    Ok(())
}

#[tauri::command]
pub async fn store_clear_holding_regs(state: State<'_, AppState>) -> ApiResult<()> {
    let locked = state.listener_handle.lock().await;
    if let Some(handle) = locked.as_ref() {
        handle.app.lock().await.clear_holding_regs();
    }
    Ok(())
}

#[tauri::command]
pub async fn store_sync_holding_reg_addresses(state: State<'_, AppState>, addresses: Vec<u16>) -> ApiResult<()> {
    let locked = state.listener_handle.lock().await;
    if let Some(handle) = locked.as_ref() {
        handle.app.lock().await.sync_holding_reg_addresses(&addresses);
    }
    Ok(())
}

// ── Store-read commands (Option A: server UI reads values back from its own store) ──

/// Read coil values directly from the server's in-memory store.
/// Works even when the listener is stopped — returns false for all addresses in that case.
#[tauri::command]
pub async fn store_read_coils(
    state: State<'_, AppState>,
    addresses: Vec<u16>,
) -> ApiResult<Vec<StoreReadBoolEntry>> {
    let locked = state.listener_handle.lock().await;
    match locked.as_ref() {
        None => Ok(addresses.into_iter().map(|address| StoreReadBoolEntry { address, value: false }).collect()),
        Some(handle) => {
            let app = handle.app.lock().await;
            Ok(app.get_coil_values(&addresses)
                .into_iter()
                .map(|(address, value)| StoreReadBoolEntry { address, value })
                .collect())
        }
    }
}

/// Read discrete input values directly from the server's in-memory store.
#[tauri::command]
pub async fn store_read_discrete_inputs(
    state: State<'_, AppState>,
    addresses: Vec<u16>,
) -> ApiResult<Vec<StoreReadBoolEntry>> {
    let locked = state.listener_handle.lock().await;
    match locked.as_ref() {
        None => Ok(addresses.into_iter().map(|address| StoreReadBoolEntry { address, value: false }).collect()),
        Some(handle) => {
            let app = handle.app.lock().await;
            Ok(app.get_discrete_input_values(&addresses)
                .into_iter()
                .map(|(address, value)| StoreReadBoolEntry { address, value })
                .collect())
        }
    }
}

/// Read holding register values directly from the server's in-memory store.
#[tauri::command]
pub async fn store_read_holding_regs(
    state: State<'_, AppState>,
    addresses: Vec<u16>,
) -> ApiResult<Vec<StoreReadU16Entry>> {
    let locked = state.listener_handle.lock().await;
    match locked.as_ref() {
        None => Ok(addresses.into_iter().map(|address| StoreReadU16Entry { address, value: 0 }).collect()),
        Some(handle) => {
            let app = handle.app.lock().await;
            Ok(app.get_holding_reg_values(&addresses)
                .into_iter()
                .map(|(address, value)| StoreReadU16Entry { address, value })
                .collect())
        }
    }
}

/// Read file-record values directly from the server's in-memory file-record store.
#[tauri::command]
pub async fn store_read_file_records(
    state: State<'_, AppState>,
    request: ReadFileRecordsRequest,
) -> ApiResult<FileRecordsResponse> {
    let request_payload = parse_hex_input_local(&request.payload_hex)
        .map_err(|details| ApiError::invalid_request(details, request.analytics.clone()))?;
    let segments = parse_fc20_read_segments(&request_payload)
        .map_err(|details| ApiError::invalid_request(details, request.analytics.clone()))?;

    let mut response_body: Vec<u8> = Vec::new();
    let listener_guard = state.listener_handle.lock().await;
    if let Some(handle) = listener_guard.as_ref() {
        let app = handle.app.lock().await;
        for (file, record, word_count) in &segments {
            let words = app.get_file_record(*file, *record, *word_count);
            let data_len = 1 + (words.len() * 2);
            response_body.push(data_len as u8);
            response_body.push(0x06);
            for value in words {
                let [hi, lo] = value.to_be_bytes();
                response_body.push(hi);
                response_body.push(lo);
            }
        }
    } else {
        let store = state.file_record_store.lock().await;
        for (file, record, word_count) in &segments {
            let record_words = store
                .get(&(*file, *record))
                .cloned()
                .unwrap_or_default();
            let needed = *word_count as usize;
            let mut words = vec![0_u16; needed];
            for (idx, value) in record_words.into_iter().take(needed).enumerate() {
                words[idx] = value;
            }

            let data_len = 1 + (needed * 2);
            response_body.push(data_len as u8);
            response_body.push(0x06);
            for value in words {
                let [hi, lo] = value.to_be_bytes();
                response_body.push(hi);
                response_body.push(lo);
            }
        }
    }

    if response_body.len() > 255 {
        return Err(ApiError::invalid_request(
            "FC20 response payload exceeds 255 bytes.",
            request.analytics.clone(),
        ));
    }

    let mut response_payload = Vec::with_capacity(1 + response_body.len());
    response_payload.push(response_body.len() as u8);
    response_payload.extend_from_slice(&response_body);

    Ok(FileRecordsResponse {
        function_code: 0x14,
        request_hex: format_hex_bytes_local(&request_payload),
        response_hex: format_hex_bytes_local(&response_payload),
        request_summary: summarize_file_record_segments("read", segments.len()),
        response_summary: summarize_file_record_segments("read.response", segments.len()),
    })
}

/// Write file-record values directly into the server's in-memory file-record store.
#[tauri::command]
pub async fn store_write_file_records(
    state: State<'_, AppState>,
    request: WriteFileRecordsRequest,
) -> ApiResult<FileRecordsResponse> {
    let request_payload = parse_hex_input_local(&request.payload_hex)
        .map_err(|details| ApiError::invalid_request(details, request.analytics.clone()))?;
    let segments = parse_fc21_write_segments(&request_payload)
        .map_err(|details| ApiError::invalid_request(details, request.analytics.clone()))?;

    {
        let mut store = state.file_record_store.lock().await;
        for (file, record, values) in &segments {
            store.insert((*file, *record), values.clone());
        }
    }

    {
        let listener_guard = state.listener_handle.lock().await;
        if let Some(handle) = listener_guard.as_ref() {
            let mut app = handle.app.lock().await;
            for (file, record, values) in &segments {
                app.set_file_record(*file, *record, values);
            }
        }
    }

    // FC21 response echoes the request payload.
    let response_payload = request_payload.clone();

    Ok(FileRecordsResponse {
        function_code: 0x15,
        request_hex: format_hex_bytes_local(&request_payload),
        response_hex: format_hex_bytes_local(&response_payload),
        request_summary: summarize_file_record_segments("write", segments.len()),
        response_summary: summarize_file_record_segments("write.response", segments.len()),
    })
}

/// Read FIFO queue values directly from the server's in-memory store.
#[tauri::command]
pub async fn store_read_fifo_queue(
    state: State<'_, AppState>,
    address: u16,
) -> ApiResult<ReadFifoQueueResponse> {
    let store = state.fifo_store.lock().await;
    let values = store.get(&address).cloned().unwrap_or_default();
    Ok(ReadFifoQueueResponse {
        address,
        fifo_count: values.len() as u16,
        values,
    })
}

/// Set FIFO queue values directly in the server's in-memory store.
#[tauri::command]
pub async fn store_set_fifo_queue(
    state: State<'_, AppState>,
    address: u16,
    values: Vec<u16>,
) -> ApiResult<ReadFifoQueueResponse> {
    let mut next = values;
    if next.len() > 31 {
        next.truncate(31);
    }

    {
        let mut store = state.fifo_store.lock().await;
        store.insert(address, next.clone());
    }

    let locked = state.listener_handle.lock().await;
    if let Some(handle) = locked.as_ref() {
        handle.app.lock().await.set_fifo_queue(address, &next);
    }

    Ok(ReadFifoQueueResponse {
        address,
        fifo_count: next.len() as u16,
        values: next,
    })
}

/// Append one FIFO queue value directly in the server's in-memory store.
#[tauri::command]
pub async fn store_append_fifo_queue_value(
    state: State<'_, AppState>,
    address: u16,
    value: u16,
) -> ApiResult<ReadFifoQueueResponse> {
    let next = {
        let mut store = state.fifo_store.lock().await;
        let queue = store.entry(address).or_default();
        queue.push(value);
        if queue.len() > 31 {
            let overflow = queue.len() - 31;
            queue.drain(0..overflow);
        }
        queue.clone()
    };

    let locked = state.listener_handle.lock().await;
    if let Some(handle) = locked.as_ref() {
        handle.app.lock().await.append_fifo_queue_value(address, value);
    }

    Ok(ReadFifoQueueResponse {
        address,
        fifo_count: next.len() as u16,
        values: next,
    })
}

/// Clear a FIFO queue value list directly in the server's in-memory store.
#[tauri::command]
pub async fn store_clear_fifo_queue(
    state: State<'_, AppState>,
    address: u16,
) -> ApiResult<ReadFifoQueueResponse> {
    {
        let mut store = state.fifo_store.lock().await;
        store.remove(&address);
    }

    let locked = state.listener_handle.lock().await;
    if let Some(handle) = locked.as_ref() {
        handle.app.lock().await.clear_fifo_queue(address);
    }

    Ok(ReadFifoQueueResponse {
        address,
        fifo_count: 0,
        values: Vec::new(),
    })
}

#[tauri::command]
pub async fn store_set_input_reg(state: State<'_, AppState>, address: u16, value: u16) -> ApiResult<()> {
    let locked = state.listener_handle.lock().await;
    if let Some(handle) = locked.as_ref() {
        handle.app.lock().await.set_input_reg(address, value);
    }
    Ok(())
}

#[tauri::command]
pub async fn store_remove_input_reg(state: State<'_, AppState>, address: u16) -> ApiResult<()> {
    let locked = state.listener_handle.lock().await;
    if let Some(handle) = locked.as_ref() {
        handle.app.lock().await.remove_input_reg(address);
    }
    Ok(())
}

#[tauri::command]
pub async fn store_clear_input_regs(state: State<'_, AppState>) -> ApiResult<()> {
    let locked = state.listener_handle.lock().await;
    if let Some(handle) = locked.as_ref() {
        handle.app.lock().await.clear_input_regs();
    }
    Ok(())
}

#[tauri::command]
pub async fn store_sync_input_reg_addresses(state: State<'_, AppState>, addresses: Vec<u16>) -> ApiResult<()> {
    let locked = state.listener_handle.lock().await;
    if let Some(handle) = locked.as_ref() {
        handle.app.lock().await.sync_input_reg_addresses(&addresses);
    }
    Ok(())
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

#[tauri::command]
pub async fn read_file_records(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ReadFileRecordsRequest,
) -> ApiResult<FileRecordsResponse> {
    let started_at = Instant::now();
    let mut retried_after_recovery = false;

    loop {
        match state.read_file_records(&request).await {
            Ok(response) => {
                state.record_request_success().await;
                emit_log(
                    &app,
                    BackendEventLevel::Info,
                    "file-records",
                    format!(
                        "fc20.read ok req={} rsp={} rttMs={}",
                        response.request_hex,
                        response.response_hex,
                        started_at.elapsed().as_millis()
                    ),
                    None,
                    request.analytics.clone(),
                )
                .await;
                return Ok(response);
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
                        "Server unreachable after consecutive transport failures. Pausing requests until reconnected."
                            .to_string(),
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

                emit_log(
                    &app,
                    BackendEventLevel::Error,
                    "file-records",
                    format!(
                        "fc20.read err msg={} rttMs={}",
                        format_error_message(&err),
                        started_at.elapsed().as_millis()
                    ),
                    None,
                    err.analytics.clone(),
                )
                .await;
                return Err(err);
            }
        }
    }
}

#[tauri::command]
pub async fn write_file_records(
    app: AppHandle,
    state: State<'_, AppState>,
    request: WriteFileRecordsRequest,
) -> ApiResult<FileRecordsResponse> {
    let started_at = Instant::now();
    let mut retried_after_recovery = false;

    loop {
        match state.write_file_records(&request).await {
            Ok(response) => {
                state.record_request_success().await;
                emit_log(
                    &app,
                    BackendEventLevel::Info,
                    "file-records",
                    format!(
                        "fc21.write ok req={} rsp={} rttMs={}",
                        response.request_hex,
                        response.response_hex,
                        started_at.elapsed().as_millis()
                    ),
                    None,
                    request.analytics.clone(),
                )
                .await;
                return Ok(response);
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
                        "Server unreachable after consecutive transport failures. Pausing requests until reconnected."
                            .to_string(),
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

                emit_log(
                    &app,
                    BackendEventLevel::Error,
                    "file-records",
                    format!(
                        "fc21.write err msg={} rttMs={}",
                        format_error_message(&err),
                        started_at.elapsed().as_millis()
                    ),
                    None,
                    err.analytics.clone(),
                )
                .await;
                return Err(err);
            }
        }
    }
}
