use std::{
    io::{ErrorKind, Read, Write},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::Mutex,
    task,
    time::{sleep, timeout, Duration, Instant},
};

use modbus_rs::mbus_async::AsyncTcpClient;
use modbus_rs::{Coils, DiagnosticSubFunction, DiscreteInputs, EncapsulatedInterfaceType, Registers};
use serialport::{ClearBuffer, DataBits, Parity, SerialPort, StopBits};

use super::types::{
    AnalyticsContext, ApiError, ApiResult, CoilEntry, CoilWriteFailure, ConnectionStatus,
    ConnectionStatusPayload, CustomFrameMode, CustomFrameRequest, CustomFrameResponse,
    DiagnosticRequest, DiagnosticResponse, DiscreteInputEntry,
    GetComEventCounterResponse, GetComEventLogRequest, GetComEventLogResponse,
    ReadCoilsRequest, ReadCoilsResponse, ReadDeviceIdentificationRequest,
    ReadDeviceIdentificationResponse, ReadDiscreteInputsRequest, ReadDiscreteInputsResponse,
    ReadExceptionStatusResponse, ReadHoldingRegistersRequest, ReadHoldingRegistersResponse,
    ReadInputRegistersRequest, ReadInputRegistersResponse, RegisterEntry, RegisterWriteFailure,
    ReportServerIdResponse, RetryBackoffStrategy, RetryJitterStrategy, SerialConnectRequest,
    TcpConnectRequest, WriteCoilRequest, WriteCoilResponse, WriteHoldingRegisterRequest,
    WriteHoldingRegisterResponse, WriteMassCoilsRequest, WriteMassCoilsResponse,
    WriteMassHoldingRegistersRequest, WriteMassHoldingRegistersResponse,
};

#[derive(Clone, Copy)]
struct TcpRuntimeConfig {
    response_timeout: Duration,
    retry_attempts: u8,
    retry_backoff_strategy: RetryBackoffStrategy,
    retry_jitter_strategy: RetryJitterStrategy,
}

impl TcpRuntimeConfig {
    fn from_request(request: &TcpConnectRequest) -> Self {
        Self {
            response_timeout: Duration::from_millis(request.resolved_response_timeout_ms()),
            retry_attempts: request.resolved_retry_attempts(),
            retry_backoff_strategy: request.resolved_retry_backoff_strategy(),
            retry_jitter_strategy: request.resolved_retry_jitter_strategy(),
        }
    }

    fn retry_delay(&self, retry_index: u8) -> Duration {
        let base_ms = match self.retry_backoff_strategy {
            RetryBackoffStrategy::Fixed => 250,
            RetryBackoffStrategy::Linear => 250 * u64::from(retry_index.max(1)),
            RetryBackoffStrategy::Exponential => 250 * (1_u64 << retry_index.min(6)),
        }
        .min(10_000);

        let jittered_ms = match self.retry_jitter_strategy {
            RetryJitterStrategy::None => base_ms,
            RetryJitterStrategy::Full => pseudo_random(base_ms),
            RetryJitterStrategy::Equal => {
                let floor = base_ms / 2;
                floor + pseudo_random(base_ms.saturating_sub(floor))
            }
        };

        Duration::from_millis(jittered_ms.max(1))
    }
}

pub struct DisconnectOutcome {
    pub status: ConnectionStatusPayload,
    pub had_active_connection: bool,
}

struct TcpSession {
    session_id: u64,
    host: String,
    port: u16,
    slave_id: u8,
    config: TcpRuntimeConfig,
    connection_timeout: Duration,
    heartbeat_idle_after: Duration,
    last_communication_at: Instant,
    reconnect_attempt: u32,
    last_reconnect_error_code: Option<String>,
    last_reconnect_error_message: Option<String>,
    traffic_sink: Option<TcpTrafficSink>,
    client: Arc<AsyncTcpClient<9>>,
}

type TcpTrafficSink = Arc<dyn Fn(String) + Send + Sync + 'static>;

struct SerialSession {
    frame_mode: SerialFrameMode,
    port_name: String,
    baud_rate: u32,
    data_bits: u8,
    stop_bits: u8,
    parity: String,
    timeout: Duration,
    slave_id: u8,
    port: Box<dyn SerialPort>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SerialFrameMode {
    Rtu,
    Ascii,
}

enum ActiveConnection {
    Tcp(TcpSession),
    SerialRtu(SerialSession),
    SerialAscii(SerialSession),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ActiveConnectionKind {
    Tcp,
    SerialRtu,
    SerialAscii,
}

struct RuntimeState {
    next_session_id: u64,
    status: ConnectionStatus,
    active: Option<ActiveConnection>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            next_session_id: 1,
            status: ConnectionStatus::Disconnected,
            active: None,
        }
    }
}

pub struct AppState {
    runtime: Arc<Mutex<RuntimeState>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            runtime: Arc::new(Mutex::new(RuntimeState::default())),
        }
    }

    pub async fn connect_tcp(
        &self,
        request: &TcpConnectRequest,
        traffic_sink: Option<TcpTrafficSink>,
    ) -> ApiResult<ConnectionStatusPayload> {
        if request.host.trim().is_empty() {
            return Err(ApiError::invalid_request(
                "TCP host is required.",
                request.analytics.clone(),
            ));
        }

        if !(1..=247).contains(&request.slave_id) {
            return Err(ApiError::invalid_request(
                "Slave ID must be between 1 and 247.",
                request.analytics.clone(),
            ));
        }

        if request.port == 0 {
            return Err(ApiError::invalid_request(
                "TCP port must be between 1 and 65535.",
                request.analytics.clone(),
            ));
        }

        let config = TcpRuntimeConfig::from_request(request);
        let connection_timeout = Duration::from_millis(request.resolved_connection_timeout_ms());
        let heartbeat_idle_after =
            Duration::from_millis(request.resolved_heartbeat_idle_after_ms());

        {
            let mut rt = self.runtime.lock().await;
            if rt.active.is_some() || matches!(rt.status, ConnectionStatus::Connecting) {
                return Err(ApiError::conflict(
                    "An active Modbus connection already exists. Disconnect first.",
                    request.analytics.clone(),
                ));
            }

            rt.status = ConnectionStatus::Connecting;
        }

        let client = match connect_tcp_client(
            request.host.trim().to_string(),
            request.port,
            connection_timeout,
            config,
            request.analytics.clone(),
            traffic_sink.clone(),
        )
        .await
        {
            Ok(client) => client,
            Err(err) => {
                let mut rt = self.runtime.lock().await;
                rt.status = ConnectionStatus::Disconnected;
                return Err(err);
            }
        };

        let mut rt = self.runtime.lock().await;
        if rt.active.is_some() {
            return Err(ApiError::conflict(
                "An active Modbus connection already exists. Disconnect first.",
                request.analytics.clone(),
            ));
        }

        let session_id = rt.next_session_id;
        rt.next_session_id = rt.next_session_id.saturating_add(1);

        rt.active = Some(ActiveConnection::Tcp(TcpSession {
            session_id,
            host: request.host.clone(),
            port: request.port,
            slave_id: request.slave_id,
            config,
            connection_timeout,
            heartbeat_idle_after,
            last_communication_at: Instant::now(),
            reconnect_attempt: 0,
            last_reconnect_error_code: None,
            last_reconnect_error_message: None,
            traffic_sink,
            client: Arc::new(client),
        }));
        rt.status = ConnectionStatus::ConnectedTcp;
        let runtime = Arc::clone(&self.runtime);
        tokio::spawn(async move {
            run_tcp_supervisor(runtime, session_id).await;
        });

        Ok(ConnectionStatusPayload {
            status: rt.status.clone(),
            details: Some(format!("TCP {}:{}", request.host, request.port)),
        })
    }

    pub async fn disconnect(&self) -> DisconnectOutcome {
        let mut rt = self.runtime.lock().await;
        let had_active = rt.active.is_some();

        if let Some(active) = rt.active.take() {
            match active {
                ActiveConnection::Tcp(session) => {
                    // Dropping AsyncTcpClient triggers worker shutdown via Drop implementation.
                    drop(session.client);
                }
                ActiveConnection::SerialRtu(session) => {
                    // Dropping the serial port closes the underlying device handle.
                    drop(session.port);
                }
                ActiveConnection::SerialAscii(session) => {
                    // Dropping the serial port closes the underlying device handle.
                    drop(session.port);
                }
            }
        }

        rt.active = None;
        rt.status = ConnectionStatus::Disconnected;

        let details = if had_active {
            "Connection closed"
        } else {
            "No active connection to close"
        };

        DisconnectOutcome {
            status: ConnectionStatusPayload {
                status: ConnectionStatus::Disconnected,
                details: Some(details.to_string()),
            },
            had_active_connection: had_active,
        }
    }

    pub async fn status(&self) -> ConnectionStatusPayload {
        let rt = self.runtime.lock().await;
        let details = match &rt.active {
            Some(ActiveConnection::Tcp(session)) => {
                let base = format!(
                    "TCP {}:{} (slave {})",
                    session.host, session.port, session.slave_id
                );
                if matches!(rt.status, ConnectionStatus::Reconnecting) {
                    let mut extra = format!("reconnect attempt {}", session.reconnect_attempt);
                    if let Some(code) = &session.last_reconnect_error_code {
                        extra.push_str(&format!(", code={code}"));
                    }
                    if let Some(message) = &session.last_reconnect_error_message {
                        extra.push_str(&format!(", lastError={message}"));
                    }
                    Some(format!("{base} | {extra}"))
                } else {
                    Some(base)
                }
            }
            Some(ActiveConnection::SerialRtu(session)) => Some(format!(
                "Serial RTU {} @ {} bps, {}{}{}, slave {}, timeout={}ms",
                session.port_name,
                session.baud_rate,
                session.data_bits,
                if session.parity.eq_ignore_ascii_case("none") {
                    "N"
                } else if session.parity.eq_ignore_ascii_case("even") {
                    "E"
                } else {
                    "O"
                },
                session.stop_bits,
                session.slave_id,
                session.timeout.as_millis(),
            )),
            Some(ActiveConnection::SerialAscii(session)) => Some(format!(
                "Serial ASCII {} @ {} bps, {}{}{}, slave {}, timeout={}ms",
                session.port_name,
                session.baud_rate,
                session.data_bits,
                if session.parity.eq_ignore_ascii_case("none") {
                    "N"
                } else if session.parity.eq_ignore_ascii_case("even") {
                    "E"
                } else {
                    "O"
                },
                session.stop_bits,
                session.slave_id,
                session.timeout.as_millis(),
            )),
            None => None,
        };

        ConnectionStatusPayload {
            status: rt.status.clone(),
            details,
        }
    }

    pub async fn read_coils(&self, request: &ReadCoilsRequest) -> ApiResult<ReadCoilsResponse> {
        self.mark_tcp_activity().await;

        if request.quantity == 0 || request.quantity > 2000 {
            return Err(ApiError::invalid_request(
                "Quantity must be between 1 and 2000.",
                request.analytics.clone(),
            ));
        }

        let entries = match self.active_connection_kind(request.analytics.clone()).await? {
            ActiveConnectionKind::Tcp => {
                let (client, slave_id, config) =
                    self.active_tcp_session(request.analytics.clone()).await?;

                let coils = read_multiple_coils_with_retry(
                    &client,
                    slave_id,
                    request.start_address,
                    request.quantity,
                    config,
                    request.analytics.clone(),
                )
                .await?;

                (0..request.quantity)
                    .map(|i| {
                        let addr = request.start_address + i;
                        CoilEntry {
                            address: addr,
                            value: coils.value(addr).unwrap_or(false),
                        }
                    })
                    .collect()
            }
            ActiveConnectionKind::SerialRtu | ActiveConnectionKind::SerialAscii => {
                let mut payload = Vec::with_capacity(4);
                payload.extend_from_slice(&request.start_address.to_be_bytes());
                payload.extend_from_slice(&request.quantity.to_be_bytes());

                let response = self
                    .with_serial_session(request.analytics.clone(), |session| {
                        serial_send_request(session, 0x01, &payload)
                    })
                    .await?;

                let bits = parse_bit_read_response(&response, request.quantity, 0x01).map_err(
                    |details| {
                        ApiError::backend_failure(
                            "Read coils failed.",
                            Some(details),
                            request.analytics.clone(),
                        )
                    },
                )?;
                bits.into_iter()
                    .enumerate()
                    .map(|(i, value)| CoilEntry {
                        address: request.start_address + i as u16,
                        value,
                    })
                    .collect()
            }
        };

        Ok(ReadCoilsResponse {
            coils: entries,
            start_address: request.start_address,
            quantity: request.quantity,
        })
    }

    pub async fn write_coil(&self, request: &WriteCoilRequest) -> ApiResult<WriteCoilResponse> {
        self.mark_tcp_activity().await;

        let (addr, value) = match self.active_connection_kind(request.analytics.clone()).await? {
            ActiveConnectionKind::Tcp => {
                let (client, slave_id, config) =
                    self.active_tcp_session(request.analytics.clone()).await?;

                write_single_coil_with_retry(
                    &client,
                    slave_id,
                    request.address,
                    request.value,
                    config,
                    request.analytics.clone(),
                )
                .await?
            }
            ActiveConnectionKind::SerialRtu | ActiveConnectionKind::SerialAscii => {
                let mut payload = Vec::with_capacity(4);
                payload.extend_from_slice(&request.address.to_be_bytes());
                payload.extend_from_slice(if request.value { &[0xFF, 0x00] } else { &[0x00, 0x00] });

                let response = self
                    .with_serial_session(request.analytics.clone(), |session| {
                        serial_send_request(session, 0x05, &payload)
                    })
                    .await?;

                parse_single_write_coil_response(&response).map_err(|details| {
                    ApiError::backend_failure(
                        "Write coil failed.",
                        Some(details),
                        request.analytics.clone(),
                    )
                })?
            }
        };

        Ok(WriteCoilResponse {
            address: addr,
            value,
        })
    }

    pub async fn read_discrete_inputs(
        &self,
        request: &ReadDiscreteInputsRequest,
    ) -> ApiResult<ReadDiscreteInputsResponse> {
        self.mark_tcp_activity().await;

        if request.quantity == 0 || request.quantity > 2000 {
            return Err(ApiError::invalid_request(
                "Quantity must be between 1 and 2000.",
                request.analytics.clone(),
            ));
        }

        let entries = match self.active_connection_kind(request.analytics.clone()).await? {
            ActiveConnectionKind::Tcp => {
                let (client, slave_id, config) =
                    self.active_tcp_session(request.analytics.clone()).await?;

                let inputs = read_multiple_discrete_inputs_with_retry(
                    &client,
                    slave_id,
                    request.start_address,
                    request.quantity,
                    config,
                    request.analytics.clone(),
                )
                .await?;

                (0..request.quantity)
                    .map(|i| {
                        let addr = request.start_address + i;
                        DiscreteInputEntry {
                            address: addr,
                            value: inputs.value(addr).unwrap_or(false),
                        }
                    })
                    .collect()
            }
            ActiveConnectionKind::SerialRtu | ActiveConnectionKind::SerialAscii => {
                let mut payload = Vec::with_capacity(4);
                payload.extend_from_slice(&request.start_address.to_be_bytes());
                payload.extend_from_slice(&request.quantity.to_be_bytes());

                let response = self
                    .with_serial_session(request.analytics.clone(), |session| {
                        serial_send_request(session, 0x02, &payload)
                    })
                    .await?;

                let bits = parse_bit_read_response(&response, request.quantity, 0x02).map_err(
                    |details| {
                        ApiError::backend_failure(
                            "Read discrete inputs failed.",
                            Some(details),
                            request.analytics.clone(),
                        )
                    },
                )?;
                bits.into_iter()
                    .enumerate()
                    .map(|(i, value)| DiscreteInputEntry {
                        address: request.start_address + i as u16,
                        value,
                    })
                    .collect()
            }
        };

        Ok(ReadDiscreteInputsResponse {
            inputs: entries,
            start_address: request.start_address,
            quantity: request.quantity,
        })
    }

    pub async fn read_holding_registers(
        &self,
        request: &ReadHoldingRegistersRequest,
    ) -> ApiResult<ReadHoldingRegistersResponse> {
        self.mark_tcp_activity().await;

        if request.quantity == 0 || request.quantity > 125 {
            return Err(ApiError::invalid_request(
                "Quantity must be between 1 and 125.",
                request.analytics.clone(),
            ));
        }

        let entries = match self.active_connection_kind(request.analytics.clone()).await? {
            ActiveConnectionKind::Tcp => {
                let (client, slave_id, config) =
                    self.active_tcp_session(request.analytics.clone()).await?;

                let registers = read_multiple_holding_registers_with_retry(
                    &client,
                    slave_id,
                    request.start_address,
                    request.quantity,
                    config,
                    request.analytics.clone(),
                )
                .await?;

                (0..request.quantity)
                    .map(|i| {
                        let addr = request.start_address + i;
                        RegisterEntry {
                            address: addr,
                            value: registers.value(addr).unwrap_or(0),
                        }
                    })
                    .collect()
            }
            ActiveConnectionKind::SerialRtu | ActiveConnectionKind::SerialAscii => {
                let mut payload = Vec::with_capacity(4);
                payload.extend_from_slice(&request.start_address.to_be_bytes());
                payload.extend_from_slice(&request.quantity.to_be_bytes());

                let response = self
                    .with_serial_session(request.analytics.clone(), |session| {
                        serial_send_request(session, 0x03, &payload)
                    })
                    .await?;

                let values = parse_register_read_response(&response, request.quantity, 0x03)
                    .map_err(|details| {
                        ApiError::backend_failure(
                            "Read holding registers failed.",
                            Some(details),
                            request.analytics.clone(),
                        )
                    })?;
                values
                    .into_iter()
                    .enumerate()
                    .map(|(i, value)| RegisterEntry {
                        address: request.start_address + i as u16,
                        value,
                    })
                    .collect()
            }
        };

        Ok(ReadHoldingRegistersResponse {
            registers: entries,
            start_address: request.start_address,
            quantity: request.quantity,
        })
    }

    pub async fn read_input_registers(
        &self,
        request: &ReadInputRegistersRequest,
    ) -> ApiResult<ReadInputRegistersResponse> {
        self.mark_tcp_activity().await;

        if request.quantity == 0 || request.quantity > 125 {
            return Err(ApiError::invalid_request(
                "Quantity must be between 1 and 125.",
                request.analytics.clone(),
            ));
        }

        let entries = match self.active_connection_kind(request.analytics.clone()).await? {
            ActiveConnectionKind::Tcp => {
                let (client, slave_id, config) =
                    self.active_tcp_session(request.analytics.clone()).await?;

                let registers = read_multiple_input_registers_with_retry(
                    &client,
                    slave_id,
                    request.start_address,
                    request.quantity,
                    config,
                    request.analytics.clone(),
                )
                .await?;

                (0..request.quantity)
                    .map(|i| {
                        let addr = request.start_address + i;
                        RegisterEntry {
                            address: addr,
                            value: registers.value(addr).unwrap_or(0),
                        }
                    })
                    .collect()
            }
            ActiveConnectionKind::SerialRtu | ActiveConnectionKind::SerialAscii => {
                let mut payload = Vec::with_capacity(4);
                payload.extend_from_slice(&request.start_address.to_be_bytes());
                payload.extend_from_slice(&request.quantity.to_be_bytes());

                let response = self
                    .with_serial_session(request.analytics.clone(), |session| {
                        serial_send_request(session, 0x04, &payload)
                    })
                    .await?;

                let values = parse_register_read_response(&response, request.quantity, 0x04)
                    .map_err(|details| {
                        ApiError::backend_failure(
                            "Read input registers failed.",
                            Some(details),
                            request.analytics.clone(),
                        )
                    })?;
                values
                    .into_iter()
                    .enumerate()
                    .map(|(i, value)| RegisterEntry {
                        address: request.start_address + i as u16,
                        value,
                    })
                    .collect()
            }
        };

        Ok(ReadInputRegistersResponse {
            registers: entries,
            start_address: request.start_address,
            quantity: request.quantity,
        })
    }

    pub async fn write_holding_register(
        &self,
        request: &WriteHoldingRegisterRequest,
    ) -> ApiResult<WriteHoldingRegisterResponse> {
        self.mark_tcp_activity().await;

        let (addr, value) = match self.active_connection_kind(request.analytics.clone()).await? {
            ActiveConnectionKind::Tcp => {
                let (client, slave_id, config) =
                    self.active_tcp_session(request.analytics.clone()).await?;

                write_single_register_with_retry(
                    &client,
                    slave_id,
                    request.address,
                    request.value,
                    config,
                    request.analytics.clone(),
                )
                .await?
            }
            ActiveConnectionKind::SerialRtu | ActiveConnectionKind::SerialAscii => {
                let mut payload = Vec::with_capacity(4);
                payload.extend_from_slice(&request.address.to_be_bytes());
                payload.extend_from_slice(&request.value.to_be_bytes());

                let response = self
                    .with_serial_session(request.analytics.clone(), |session| {
                        serial_send_request(session, 0x06, &payload)
                    })
                    .await?;

                parse_single_write_register_response(&response).map_err(|details| {
                    ApiError::backend_failure(
                        "Write holding register failed.",
                        Some(details),
                        request.analytics.clone(),
                    )
                })?
            }
        };

        Ok(WriteHoldingRegisterResponse {
            address: addr,
            value,
        })
    }

    pub async fn write_coils_optimized(
        &self,
        request: &WriteMassCoilsRequest,
    ) -> ApiResult<WriteMassCoilsResponse> {
        self.mark_tcp_activity().await;

        if request.coils.is_empty() {
            return Ok(WriteMassCoilsResponse {
                written_count: 0,
                total_count: 0,
                failures: vec![],
            });
        }

        if matches!(
            self.active_connection_kind(request.analytics.clone()).await?,
            ActiveConnectionKind::SerialRtu | ActiveConnectionKind::SerialAscii
        ) {
            let total = request.coils.len();
            let mut written = 0;
            let mut failures = Vec::new();

            for coil in &request.coils {
                let mut payload = Vec::with_capacity(4);
                payload.extend_from_slice(&coil.address.to_be_bytes());
                payload.extend_from_slice(if coil.value { &[0xFF, 0x00] } else { &[0x00, 0x00] });

                let result = self
                    .with_serial_session(request.analytics.clone(), |session| {
                        serial_send_request(session, 0x05, &payload)
                    })
                    .await;

                match result {
                    Ok(response) => match parse_single_write_coil_response(&response) {
                        Ok(_) => written += 1,
                        Err(details) => failures.push(CoilWriteFailure {
                            address: coil.address,
                            code: "BACKEND_FAILURE".to_string(),
                            message: details,
                        }),
                    },
                    Err(err) => failures.push(CoilWriteFailure {
                        address: coil.address,
                        code: api_error_code(&err).to_string(),
                        message: describe_api_error(&err),
                    }),
                }
            }

            return Ok(WriteMassCoilsResponse {
                written_count: written,
                total_count: total,
                failures,
            });
        }

        let (client, slave_id, config) = self.active_tcp_session(request.analytics.clone()).await?;

        let total = request.coils.len();
        let mut written = 0;
        let mut failures = Vec::new();

        // Sort coils by address to identify continuous ranges
        let mut sorted_coils = request.coils.clone();
        sorted_coils.sort_by_key(|c| c.address);

        // Group into continuous ranges
        let mut ranges: Vec<Vec<&CoilEntry>> = vec![];
        let mut current_range = vec![&sorted_coils[0]];

        for i in 1..sorted_coils.len() {
            if sorted_coils[i].address == sorted_coils[i - 1].address + 1 {
                // Continuous
                current_range.push(&sorted_coils[i]);
            } else {
                // Gap; save current range and start new one
                ranges.push(current_range.clone());
                current_range = vec![&sorted_coils[i]];
            }
        }
        ranges.push(current_range);

        // Process each range: use FC15 for ranges >= 2, FC05 for single
        for range in ranges {
            if range.len() >= 2 {
                // Use FC15 (write multiple coils)
                let start_addr = range[0].address;
                let quantity = range.len() as u16;

                match Coils::new(start_addr, quantity) {
                    Ok(mut coils_obj) => {
                        // Set each coil value
                        for coil in &range {
                            let _ = coils_obj.set_value(coil.address, coil.value);
                        }

                        match write_multiple_coils_with_retry(
                            &client,
                            slave_id,
                            start_addr,
                            &coils_obj,
                            config,
                            request.analytics.clone(),
                        )
                        .await
                        {
                            Ok(_) => {
                                written += range.len();
                            }
                            Err(fc15_err) => {
                                // Fall back to single writes for this range on error
                                for coil in &range {
                                    match write_single_coil_with_retry(
                                        &client,
                                        slave_id,
                                        coil.address,
                                        coil.value,
                                        config,
                                        request.analytics.clone(),
                                    )
                                    .await
                                    {
                                        Ok(_) => written += 1,
                                        Err(single_err) => failures.push(CoilWriteFailure {
                                            address: coil.address,
                                            code: api_error_code(&single_err).to_string(),
                                            message: format!(
                                                "FC15 failed ({}) and FC05 fallback failed ({}).",
                                                describe_api_error(&fc15_err),
                                                describe_api_error(&single_err)
                                            ),
                                        }),
                                    }
                                }
                            }
                        }
                    }
                    Err(err) => {
                        // Invalid range; fall back to single writes
                        for coil in &range {
                            match write_single_coil_with_retry(
                                &client,
                                slave_id,
                                coil.address,
                                coil.value,
                                config,
                                request.analytics.clone(),
                            )
                            .await
                            {
                                Ok(_) => written += 1,
                                Err(single_err) => failures.push(CoilWriteFailure {
                                    address: coil.address,
                                    code: api_error_code(&single_err).to_string(),
                                    message: format!(
                                        "FC15 range build failed ({}) and FC05 fallback failed ({}).",
                                        err,
                                        describe_api_error(&single_err)
                                    ),
                                }),
                            }
                        }
                    }
                }
            } else {
                // Single coil; use FC05
                let coil = range[0];
                match write_single_coil_with_retry(
                    &client,
                    slave_id,
                    coil.address,
                    coil.value,
                    config,
                    request.analytics.clone(),
                )
                .await
                {
                    Ok(_) => written += 1,
                    Err(err) => failures.push(CoilWriteFailure {
                        address: coil.address,
                        code: api_error_code(&err).to_string(),
                        message: describe_api_error(&err),
                    }),
                }
            }
        }

        Ok(WriteMassCoilsResponse {
            written_count: written,
            total_count: total,
            failures,
        })
    }

    pub async fn write_holding_registers_optimized(
        &self,
        request: &WriteMassHoldingRegistersRequest,
    ) -> ApiResult<WriteMassHoldingRegistersResponse> {
        self.mark_tcp_activity().await;

        if request.registers.is_empty() {
            return Ok(WriteMassHoldingRegistersResponse {
                written_count: 0,
                total_count: 0,
                failures: vec![],
            });
        }

        if matches!(
            self.active_connection_kind(request.analytics.clone()).await?,
            ActiveConnectionKind::SerialRtu | ActiveConnectionKind::SerialAscii
        ) {
            let total = request.registers.len();
            let mut written = 0;
            let mut failures = Vec::new();

            for reg in &request.registers {
                let mut payload = Vec::with_capacity(4);
                payload.extend_from_slice(&reg.address.to_be_bytes());
                payload.extend_from_slice(&reg.value.to_be_bytes());

                let result = self
                    .with_serial_session(request.analytics.clone(), |session| {
                        serial_send_request(session, 0x06, &payload)
                    })
                    .await;

                match result {
                    Ok(response) => match parse_single_write_register_response(&response) {
                        Ok(_) => written += 1,
                        Err(details) => failures.push(RegisterWriteFailure {
                            address: reg.address,
                            code: "BACKEND_FAILURE".to_string(),
                            message: details,
                        }),
                    },
                    Err(err) => failures.push(RegisterWriteFailure {
                        address: reg.address,
                        code: api_error_code(&err).to_string(),
                        message: describe_api_error(&err),
                    }),
                }
            }

            return Ok(WriteMassHoldingRegistersResponse {
                written_count: written,
                total_count: total,
                failures,
            });
        }

        let (client, slave_id, config) = self.active_tcp_session(request.analytics.clone()).await?;

        let total = request.registers.len();
        let mut written = 0;
        let mut failures = Vec::new();

        let mut sorted_registers = request.registers.clone();
        sorted_registers.sort_by_key(|r| r.address);

        let mut ranges: Vec<Vec<&RegisterEntry>> = vec![];
        let mut current_range = vec![&sorted_registers[0]];

        for i in 1..sorted_registers.len() {
            if sorted_registers[i].address == sorted_registers[i - 1].address + 1 {
                current_range.push(&sorted_registers[i]);
            } else {
                ranges.push(current_range.clone());
                current_range = vec![&sorted_registers[i]];
            }
        }
        ranges.push(current_range);

        for range in ranges {
            if range.len() >= 2 {
                let start_addr = range[0].address;
                let values: Vec<u16> = range.iter().map(|r| r.value).collect();

                match write_multiple_registers_with_retry(
                    &client,
                    slave_id,
                    start_addr,
                    &values,
                    config,
                    request.analytics.clone(),
                )
                .await
                {
                    Ok(_) => {
                        written += range.len();
                    }
                    Err(fc16_err) => {
                        for reg in &range {
                            match write_single_register_with_retry(
                                &client,
                                slave_id,
                                reg.address,
                                reg.value,
                                config,
                                request.analytics.clone(),
                            )
                            .await
                            {
                                Ok(_) => written += 1,
                                Err(single_err) => failures.push(RegisterWriteFailure {
                                    address: reg.address,
                                    code: api_error_code(&single_err).to_string(),
                                    message: format!(
                                        "FC16 failed ({}) and FC06 fallback failed ({}).",
                                        describe_api_error(&fc16_err),
                                        describe_api_error(&single_err)
                                    ),
                                }),
                            }
                        }
                    }
                }
            } else {
                let reg = range[0];
                match write_single_register_with_retry(
                    &client,
                    slave_id,
                    reg.address,
                    reg.value,
                    config,
                    request.analytics.clone(),
                )
                .await
                {
                    Ok(_) => written += 1,
                    Err(err) => failures.push(RegisterWriteFailure {
                        address: reg.address,
                        code: api_error_code(&err).to_string(),
                        message: describe_api_error(&err),
                    }),
                }
            }
        }

        Ok(WriteMassHoldingRegistersResponse {
            written_count: written,
            total_count: total,
            failures,
        })
    }

        // Diagnostics implementations: FC07/08/11/12/17/43
        pub async fn read_exception_status(&self) -> ApiResult<ReadExceptionStatusResponse> {
            self.mark_tcp_activity().await;

            let response = match self.active_connection_kind(None).await? {
                ActiveConnectionKind::Tcp => {
                    let (host, port, slave_id, config) = self.active_tcp_endpoint(None).await?;
                    read_exception_status_with_retry(&host, port, slave_id, config)
                        .await
                        .map_err(|err| ApiError::backend_failure("FC07 failed", Some(err), None))?
                }
                ActiveConnectionKind::SerialRtu | ActiveConnectionKind::SerialAscii => {
                    self.with_serial_session(None, |session| serial_read_exception_status(session))
                        .await?
                }
            };

            Ok(ReadExceptionStatusResponse { status: response })
        }

        pub async fn diagnostic(&self, request: &DiagnosticRequest) -> ApiResult<DiagnosticResponse> {
            self.mark_tcp_activity().await;

            let response = match self.active_connection_kind(request.analytics.clone()).await? {
                ActiveConnectionKind::Tcp => {
                    let (host, port, slave_id, config) =
                        self.active_tcp_endpoint(request.analytics.clone()).await?;
                    diagnostic_with_retry(
                        &host,
                        port,
                        slave_id,
                        request.subfunction,
                        &request.data,
                        config,
                    )
                    .await
                    .map_err(|err| {
                        ApiError::backend_failure(
                            "FC08 failed",
                            Some(err),
                            request.analytics.clone(),
                        )
                    })?
                }
                ActiveConnectionKind::SerialRtu | ActiveConnectionKind::SerialAscii => {
                    self.with_serial_session(request.analytics.clone(), |session| {
                        serial_diagnostic(session, request.subfunction, &request.data)
                    })
                    .await?
                }
            };

            Ok(DiagnosticResponse { data: response })
        }

        pub async fn send_custom_frame(
            &self,
            request: &CustomFrameRequest,
        ) -> ApiResult<CustomFrameResponse> {
            self.mark_tcp_activity().await;

            let (function_code, payload) = resolve_custom_frame_request(request)?;
            let response_payload = match self.active_connection_kind(request.analytics.clone()).await? {
                ActiveConnectionKind::Tcp => {
                    let (host, port, slave_id, config) =
                        self.active_tcp_endpoint(request.analytics.clone()).await?;
                    send_raw_modbus_request_with_retry(
                        &host,
                        port,
                        slave_id,
                        function_code,
                        &payload,
                        config,
                    )
                    .await
                    .map_err(|err| {
                        ApiError::backend_failure(
                            "Custom frame send failed.",
                            Some(err),
                            request.analytics.clone(),
                        )
                    })?
                }
                ActiveConnectionKind::SerialRtu | ActiveConnectionKind::SerialAscii => {
                    self.with_serial_session(request.analytics.clone(), |session| {
                        serial_send_request(session, function_code, &payload)
                    })
                    .await?
                }
            };

            let response_ascii = decode_modbus_text(&response_payload);
            Ok(CustomFrameResponse {
                mode: request.mode,
                function_code,
                function_name: modbus_function_name(function_code).to_string(),
                request_hex: format_hex_bytes(&payload),
                response_hex: format_hex_bytes(&response_payload),
                response_ascii: if response_ascii.is_empty() {
                    None
                } else {
                    Some(response_ascii)
                },
                request_summary: describe_custom_pdu("request", function_code, &payload),
                response_summary: describe_custom_pdu("response", function_code, &response_payload),
            })
        }

        pub async fn get_com_event_counter(&self) -> ApiResult<GetComEventCounterResponse> {
            self.mark_tcp_activity().await;

            let (status, count) = match self.active_connection_kind(None).await? {
                ActiveConnectionKind::Tcp => {
                    let (host, port, slave_id, config) = self.active_tcp_endpoint(None).await?;
                    get_com_event_counter_with_retry(&host, port, slave_id, config)
                        .await
                        .map_err(|err| ApiError::backend_failure("FC11 failed", Some(err), None))?
                }
                ActiveConnectionKind::SerialRtu | ActiveConnectionKind::SerialAscii => {
                    self.with_serial_session(None, |session| serial_get_com_event_counter(session))
                        .await?
                }
            };

            Ok(GetComEventCounterResponse {
                status,
                event_count: count,
            })
        }

        pub async fn get_com_event_log(
            &self,
            request: &GetComEventLogRequest,
        ) -> ApiResult<GetComEventLogResponse> {
            self.mark_tcp_activity().await;

            let entries = match self.active_connection_kind(request.analytics.clone()).await? {
                ActiveConnectionKind::Tcp => {
                    let (host, port, slave_id, config) =
                        self.active_tcp_endpoint(request.analytics.clone()).await?;
                    get_com_event_log_with_retry(
                        &host,
                        port,
                        slave_id,
                        request.start,
                        request.count,
                        config,
                    )
                    .await
                    .map_err(|err| {
                        ApiError::backend_failure(
                            "FC12 failed",
                            Some(err),
                            request.analytics.clone(),
                        )
                    })?
                }
                ActiveConnectionKind::SerialRtu | ActiveConnectionKind::SerialAscii => {
                    self.with_serial_session(request.analytics.clone(), |session| {
                        serial_get_com_event_log(session, request.start, request.count)
                    })
                    .await?
                }
            };

            Ok(GetComEventLogResponse { entries })
        }

        pub async fn report_server_id(&self) -> ApiResult<ReportServerIdResponse> {
            self.mark_tcp_activity().await;

            let data = match self.active_connection_kind(None).await? {
                ActiveConnectionKind::Tcp => {
                    let (host, port, slave_id, config) = self.active_tcp_endpoint(None).await?;
                    report_server_id_with_retry(&host, port, slave_id, config)
                        .await
                        .map_err(|err| ApiError::backend_failure("FC17 failed", Some(err), None))?
                }
                ActiveConnectionKind::SerialRtu | ActiveConnectionKind::SerialAscii => {
                    self.with_serial_session(None, |session| serial_report_server_id(session))
                        .await?
                }
            };

            Ok(ReportServerIdResponse { data })
        }

        pub async fn read_device_identification(
            &self,
            request: &ReadDeviceIdentificationRequest,
        ) -> ApiResult<ReadDeviceIdentificationResponse> {
            self.mark_tcp_activity().await;

            if !(1..=4).contains(&request.level) {
                return Err(ApiError::invalid_request(
                    format!(
                        "FC43 ReadDeviceIdCode must be 1 (Basic), 2 (Regular), 3 (Extended), or 4 (Individual); got {}.",
                        request.level
                    ),
                    request.analytics.clone(),
                ));
            }

            let (conformity, objects) =
                match self.active_connection_kind(request.analytics.clone()).await? {
                    ActiveConnectionKind::Tcp => {
                        let (host, port, slave_id, config) =
                            self.active_tcp_endpoint(request.analytics.clone()).await?;
                        read_device_identification_with_retry(
                            &host,
                            port,
                            slave_id,
                            request.level,
                            request.object_id,
                            config,
                        )
                        .await
                        .map_err(|err| {
                            ApiError::backend_failure(
                                "FC43 failed",
                                Some(err),
                                request.analytics.clone(),
                            )
                        })?
                    }
                    ActiveConnectionKind::SerialRtu | ActiveConnectionKind::SerialAscii => {
                        self.with_serial_session(request.analytics.clone(), |session| {
                            serial_read_device_identification(
                                session,
                                request.level,
                                request.object_id,
                            )
                        })
                        .await?
                    }
                };

            Ok(ReadDeviceIdentificationResponse { conformity, objects })
        }

    pub async fn scaffold_serial_rtu(
        &self,
        request: &SerialConnectRequest,
    ) -> ApiResult<ConnectionStatusPayload> {
        if request.port.trim().is_empty() {
            return Err(ApiError::invalid_request(
                "Serial port is required.",
                request.analytics.clone(),
            ));
        }

        if !(1..=247).contains(&request.slave_id) {
            return Err(ApiError::invalid_request(
                "Slave ID must be between 1 and 247.",
                request.analytics.clone(),
            ));
        }

        if request.baud_rate == 0 {
            return Err(ApiError::invalid_request(
                "Baud rate must be greater than 0.",
                request.analytics.clone(),
            ));
        }

        if !matches!(request.data_bits, 5..=8) {
            return Err(ApiError::invalid_request(
                "Data bits must be 5, 6, 7, or 8.",
                request.analytics.clone(),
            ));
        }

        if !matches!(request.stop_bits, 1 | 2) {
            return Err(ApiError::invalid_request(
                "Stop bits must be 1 or 2.",
                request.analytics.clone(),
            ));
        }

        let parity = request.parity.trim().to_ascii_lowercase();
        if !matches!(parity.as_str(), "none" | "even" | "odd") {
            return Err(ApiError::invalid_request(
                "Parity must be one of: none, even, odd.",
                request.analytics.clone(),
            ));
        }

        let timeout_ms = request.timeout_ms.unwrap_or(2_000).clamp(100, 60_000);

        {
            let mut rt = self.runtime.lock().await;
            if rt.active.is_some() || matches!(rt.status, ConnectionStatus::Connecting) {
                return Err(ApiError::conflict(
                    "An active Modbus connection already exists. Disconnect first.",
                    request.analytics.clone(),
                ));
            }

            rt.status = ConnectionStatus::Connecting;
        }

        let port_name = request.port.trim().to_string();
        let open_result = open_serial_port(
            port_name.clone(),
            request.baud_rate,
            request.data_bits,
            request.stop_bits,
            parity.clone(),
            timeout_ms,
        )
        .await;

        let serial_port = match open_result {
            Ok(port) => port,
            Err(err) => {
                let mut rt = self.runtime.lock().await;
                rt.status = ConnectionStatus::Disconnected;
                return Err(ApiError::backend_failure(
                    "Failed to open serial port.",
                    Some(err),
                    request.analytics.clone(),
                ));
            }
        };

        let mut rt = self.runtime.lock().await;
        if rt.active.is_some() {
            rt.status = ConnectionStatus::Disconnected;
            return Err(ApiError::conflict(
                "An active Modbus connection already exists. Disconnect first.",
                request.analytics.clone(),
            ));
        }

        rt.active = Some(ActiveConnection::SerialRtu(SerialSession {
            frame_mode: SerialFrameMode::Rtu,
            port_name: port_name.clone(),
            baud_rate: request.baud_rate,
            data_bits: request.data_bits,
            stop_bits: request.stop_bits,
            parity: parity.clone(),
            timeout: Duration::from_millis(timeout_ms),
            slave_id: request.slave_id,
            port: serial_port,
        }));
        rt.status = ConnectionStatus::ConnectedSerialRtu;

        Ok(ConnectionStatusPayload {
            status: rt.status.clone(),
            details: Some(format!(
                "Serial RTU {} @ {} bps, {}{}{}, slave {}",
                port_name,
                request.baud_rate,
                request.data_bits,
                if parity == "none" {
                    "N"
                } else if parity == "even" {
                    "E"
                } else {
                    "O"
                },
                request.stop_bits,
                request.slave_id,
            )),
        })
    }

    pub async fn scaffold_serial_ascii(
        &self,
        request: &SerialConnectRequest,
    ) -> ApiResult<ConnectionStatusPayload> {
        if request.port.trim().is_empty() {
            return Err(ApiError::invalid_request(
                "Serial port is required.",
                request.analytics.clone(),
            ));
        }

        if !(1..=247).contains(&request.slave_id) {
            return Err(ApiError::invalid_request(
                "Slave ID must be between 1 and 247.",
                request.analytics.clone(),
            ));
        }

        if request.baud_rate == 0 {
            return Err(ApiError::invalid_request(
                "Baud rate must be greater than 0.",
                request.analytics.clone(),
            ));
        }

        if !matches!(request.data_bits, 5..=8) {
            return Err(ApiError::invalid_request(
                "Data bits must be 5, 6, 7, or 8.",
                request.analytics.clone(),
            ));
        }

        if !matches!(request.stop_bits, 1 | 2) {
            return Err(ApiError::invalid_request(
                "Stop bits must be 1 or 2.",
                request.analytics.clone(),
            ));
        }

        let parity = request.parity.trim().to_ascii_lowercase();
        if !matches!(parity.as_str(), "none" | "even" | "odd") {
            return Err(ApiError::invalid_request(
                "Parity must be one of: none, even, odd.",
                request.analytics.clone(),
            ));
        }

        let timeout_ms = request.timeout_ms.unwrap_or(2_000).clamp(100, 60_000);

        {
            let mut rt = self.runtime.lock().await;
            if rt.active.is_some() || matches!(rt.status, ConnectionStatus::Connecting) {
                return Err(ApiError::conflict(
                    "An active Modbus connection already exists. Disconnect first.",
                    request.analytics.clone(),
                ));
            }

            rt.status = ConnectionStatus::Connecting;
        }

        let port_name = request.port.trim().to_string();
        let open_result = open_serial_port(
            port_name.clone(),
            request.baud_rate,
            request.data_bits,
            request.stop_bits,
            parity.clone(),
            timeout_ms,
        )
        .await;

        let serial_port = match open_result {
            Ok(port) => port,
            Err(err) => {
                let mut rt = self.runtime.lock().await;
                rt.status = ConnectionStatus::Disconnected;
                return Err(ApiError::backend_failure(
                    "Failed to open serial port.",
                    Some(err),
                    request.analytics.clone(),
                ));
            }
        };

        let mut rt = self.runtime.lock().await;
        if rt.active.is_some() {
            rt.status = ConnectionStatus::Disconnected;
            return Err(ApiError::conflict(
                "An active Modbus connection already exists. Disconnect first.",
                request.analytics.clone(),
            ));
        }

        rt.active = Some(ActiveConnection::SerialAscii(SerialSession {
            frame_mode: SerialFrameMode::Ascii,
            port_name: port_name.clone(),
            baud_rate: request.baud_rate,
            data_bits: request.data_bits,
            stop_bits: request.stop_bits,
            parity: parity.clone(),
            timeout: Duration::from_millis(timeout_ms),
            slave_id: request.slave_id,
            port: serial_port,
        }));
        rt.status = ConnectionStatus::ConnectedSerialAscii;

        Ok(ConnectionStatusPayload {
            status: rt.status.clone(),
            details: Some(format!(
                "Serial ASCII {} @ {} bps, {}{}{}, slave {}",
                port_name,
                request.baud_rate,
                request.data_bits,
                if parity == "none" {
                    "N"
                } else if parity == "even" {
                    "E"
                } else {
                    "O"
                },
                request.stop_bits,
                request.slave_id,
            )),
        })
    }

    async fn active_tcp_session(
        &self,
        analytics: Option<AnalyticsContext>,
    ) -> ApiResult<(Arc<AsyncTcpClient<9>>, u8, TcpRuntimeConfig)> {
        let rt = self.runtime.lock().await;
        match &rt.active {
            Some(ActiveConnection::Tcp(session)) => Ok((
                Arc::clone(&session.client),
                session.slave_id,
                session.config,
            )),
            Some(ActiveConnection::SerialRtu(_)) => Err(ApiError::backend_failure(
                "Operation not available on Serial RTU yet.",
                Some("This command path is currently TCP-only while serial routing is being implemented.".to_string()),
                analytics,
            )),
            Some(ActiveConnection::SerialAscii(_)) => Err(ApiError::backend_failure(
                "Operation not available on Serial ASCII yet.",
                Some("This command path is currently TCP-only while serial routing is being implemented.".to_string()),
                analytics,
            )),
            None => Err(ApiError::not_connected(
                "No active Modbus connection.",
                analytics,
            )),
        }
    }

    async fn active_connection_kind(
        &self,
        analytics: Option<AnalyticsContext>,
    ) -> ApiResult<ActiveConnectionKind> {
        let rt = self.runtime.lock().await;
        match &rt.active {
            Some(ActiveConnection::Tcp(_)) => Ok(ActiveConnectionKind::Tcp),
            Some(ActiveConnection::SerialRtu(_)) => Ok(ActiveConnectionKind::SerialRtu),
            Some(ActiveConnection::SerialAscii(_)) => Ok(ActiveConnectionKind::SerialAscii),
            None => Err(ApiError::not_connected(
                "No active Modbus connection.",
                analytics,
            )),
        }
    }

    async fn with_serial_session<T, F>(
        &self,
        analytics: Option<AnalyticsContext>,
        op: F,
    ) -> ApiResult<T>
    where
        F: FnOnce(&mut SerialSession) -> Result<T, String>,
    {
        let mut rt = self.runtime.lock().await;
        match rt.active.as_mut() {
            Some(ActiveConnection::SerialRtu(session)) => {
                op(session).map_err(|details| {
                    ApiError::backend_failure(
                        "Serial RTU operation failed.",
                        Some(details),
                        analytics,
                    )
                })
            }
            Some(ActiveConnection::SerialAscii(session)) => {
                op(session).map_err(|details| {
                    ApiError::backend_failure(
                        "Serial ASCII operation failed.",
                        Some(details),
                        analytics,
                    )
                })
            }
            Some(ActiveConnection::Tcp(_)) => Err(ApiError::backend_failure(
                "Operation requires Serial RTU connection.",
                Some("Switch protocol to Serial RTU/ASCII and reconnect.".to_string()),
                analytics,
            )),
            None => Err(ApiError::not_connected(
                "No active Modbus connection.",
                analytics,
            )),
        }
    }

    async fn active_tcp_endpoint(
        &self,
        analytics: Option<AnalyticsContext>,
    ) -> ApiResult<(String, u16, u8, TcpRuntimeConfig)> {
        let rt = self.runtime.lock().await;
        match &rt.active {
            Some(ActiveConnection::Tcp(session)) => Ok((
                session.host.clone(),
                session.port,
                session.slave_id,
                session.config,
            )),
            Some(ActiveConnection::SerialRtu(_)) => Err(ApiError::backend_failure(
                "Operation not available on Serial RTU yet.",
                Some("This command path is currently TCP-only while serial routing is being implemented.".to_string()),
                analytics,
            )),
            Some(ActiveConnection::SerialAscii(_)) => Err(ApiError::backend_failure(
                "Operation not available on Serial ASCII yet.",
                Some("This command path is currently TCP-only while serial routing is being implemented.".to_string()),
                analytics,
            )),
            None => Err(ApiError::not_connected(
                "No active Modbus connection.",
                analytics,
            )),
        }
    }

    async fn mark_tcp_activity(&self) {
        let mut rt = self.runtime.lock().await;
        if let Some(ActiveConnection::Tcp(session)) = rt.active.as_mut() {
            session.last_communication_at = Instant::now();
        }
    }
}

const HEARTBEAT_TICK: Duration = Duration::from_secs(1);

async fn run_tcp_supervisor(runtime: Arc<Mutex<RuntimeState>>, session_id: u64) {
    loop {
        sleep(HEARTBEAT_TICK).await;

        let snapshot = {
            let rt = runtime.lock().await;
            let Some(ActiveConnection::Tcp(session)) = &rt.active else {
                return;
            };

            if session.session_id != session_id {
                return;
            }

            if session.last_communication_at.elapsed() < session.heartbeat_idle_after {
                None
            } else {
                Some((
                    Arc::clone(&session.client),
                    session.host.clone(),
                    session.port,
                    session.slave_id,
                    session.config,
                    session.connection_timeout,
                    session.heartbeat_idle_after,
                ))
            }
        };

        let Some((client, host, port, slave_id, config, connection_timeout, _heartbeat_idle_after)) =
            snapshot
        else {
            continue;
        };

        let heartbeat = timeout(
            config.response_timeout,
            client.read_multiple_coils(slave_id, 0, 1),
        )
        .await;

        match heartbeat {
            Ok(Ok(_)) => {
                let mut rt = runtime.lock().await;
                if let Some(ActiveConnection::Tcp(session)) = rt.active.as_mut() {
                    if session.session_id == session_id {
                        session.last_communication_at = Instant::now();
                    }
                }
            }
            Ok(Err(err)) => {
                let err_text = err.to_string();
                if !should_reconnect_from_heartbeat_error(&err_text) {
                    let mut rt = runtime.lock().await;
                    if let Some(ActiveConnection::Tcp(session)) = rt.active.as_mut() {
                        if session.session_id == session_id {
                            // Protocol exceptions still confirm end-to-end liveness.
                            session.last_communication_at = Instant::now();
                        }
                    }
                    continue;
                }
                attempt_supervisor_reconnect(
                    Arc::clone(&runtime),
                    session_id,
                    host,
                    port,
                    connection_timeout,
                    config,
                )
                .await;
            }
            Err(_) => {
                attempt_supervisor_reconnect(
                    Arc::clone(&runtime),
                    session_id,
                    host,
                    port,
                    connection_timeout,
                    config,
                )
                .await;
            }
        }
    }
}

async fn attempt_supervisor_reconnect(
    runtime: Arc<Mutex<RuntimeState>>,
    session_id: u64,
    host: String,
    port: u16,
    connection_timeout: Duration,
    config: TcpRuntimeConfig,
) {
    let traffic_sink = {
        let mut rt = runtime.lock().await;
        if let Some(ActiveConnection::Tcp(session)) = rt.active.as_mut() {
            if session.session_id != session_id {
                return;
            }

            let sink = session.traffic_sink.clone();
            session.reconnect_attempt = session.reconnect_attempt.saturating_add(1);
            rt.status = ConnectionStatus::Reconnecting;
            sink
        } else {
            return;
        }
    };

    let reconnect = connect_tcp_client(host, port, connection_timeout, config, None, traffic_sink).await;

    let mut rt = runtime.lock().await;
    if let Some(ActiveConnection::Tcp(session)) = rt.active.as_mut() {
        if session.session_id != session_id {
            return;
        }

        match reconnect {
            Ok(new_client) => {
                session.client = Arc::new(new_client);
                session.last_communication_at = Instant::now();
                session.reconnect_attempt = 0;
                session.last_reconnect_error_code = None;
                session.last_reconnect_error_message = None;
                rt.status = ConnectionStatus::ConnectedTcp;
            }
            Err(err) => {
                session.last_reconnect_error_code = Some(api_error_code(&err).to_string());
                session.last_reconnect_error_message = Some(describe_api_error(&err));
                rt.status = ConnectionStatus::Reconnecting;
            }
        }
    }
}

fn should_reconnect_from_heartbeat_error(error_text: &str) -> bool {
    let t = error_text.to_ascii_lowercase();

    // Protocol exceptions often mean the server is reachable but rejected the request.
    if t.contains("exception") || t.contains("illegal") {
        return false;
    }

    t.contains("timeout")
        || t.contains("timed out")
        || t.contains("io")
        || t.contains("broken pipe")
        || t.contains("connection reset")
        || t.contains("not connected")
        || t.contains("transport")
}

fn pseudo_random(max_inclusive: u64) -> u64 {
    if max_inclusive == 0 {
        return 0;
    }

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    nanos % (max_inclusive + 1)
}

async fn connect_tcp_client(
    host: String,
    port: u16,
    connection_timeout: Duration,
    config: TcpRuntimeConfig,
    analytics: Option<AnalyticsContext>,
    traffic_sink: Option<TcpTrafficSink>,
) -> ApiResult<AsyncTcpClient<9>> {
    let mut last_details = None;

    for attempt in 0..=u32::from(config.retry_attempts) {
        let client = match AsyncTcpClient::<9>::new(host.as_str(), port) {
            Ok(client) => client,
            Err(err) => {
                last_details = Some(err.to_string());
                continue;
            }
        };

        if let Some(sink) = traffic_sink.clone() {
            client.set_traffic_handler(move |event| {
                let direction = format!("{:?}", event.direction).to_ascii_lowercase();
                let bytes = format_hex_bytes(&event.frame);
                let adu = describe_tcp_adu_human(&event.frame, direction.as_str());
                let message = if let Some(err) = event.error {
                    format!(
                        "tcp.{direction} txn={} unit={} adu={} err={:?} bytes={bytes}",
                        event.txn_id,
                        event.unit_id_slave_addr.get(),
                        adu,
                        err
                    )
                } else {
                    format!(
                        "tcp.{direction} txn={} unit={} adu={} bytes={bytes}",
                        event.txn_id,
                        event.unit_id_slave_addr.get(),
                        adu,
                    )
                };

                sink(message);
            });
        }

        match timeout(connection_timeout, client.connect()).await {
            Ok(Ok(())) => return Ok(client),
            Ok(Err(err)) => last_details = Some(err.to_string()),
            Err(_) => {
                last_details = Some(format!(
                    "Connection timed out after {} ms.",
                    connection_timeout.as_millis()
                ));
            }
        }

        if attempt < u32::from(config.retry_attempts) {
            sleep(config.retry_delay((attempt + 1) as u8)).await;
        }
    }

    Err(ApiError::backend_failure(
        "Failed to establish TCP connection.",
        last_details,
        analytics,
    ))
}

fn map_data_bits(bits: u8) -> Result<DataBits, String> {
    match bits {
        5 => Ok(DataBits::Five),
        6 => Ok(DataBits::Six),
        7 => Ok(DataBits::Seven),
        8 => Ok(DataBits::Eight),
        _ => Err(format!("Unsupported data bits: {}.", bits)),
    }
}

fn map_stop_bits(bits: u8) -> Result<StopBits, String> {
    match bits {
        1 => Ok(StopBits::One),
        2 => Ok(StopBits::Two),
        _ => Err(format!("Unsupported stop bits: {}.", bits)),
    }
}

fn map_parity(parity: &str) -> Result<Parity, String> {
    match parity {
        "none" => Ok(Parity::None),
        "even" => Ok(Parity::Even),
        "odd" => Ok(Parity::Odd),
        _ => Err(format!("Unsupported parity: {}.", parity)),
    }
}

async fn open_serial_port(
    port_name: String,
    baud_rate: u32,
    data_bits: u8,
    stop_bits: u8,
    parity: String,
    timeout_ms: u64,
) -> Result<Box<dyn SerialPort>, String> {
    let data_bits = map_data_bits(data_bits)?;
    let stop_bits = map_stop_bits(stop_bits)?;
    let parity_mode = map_parity(&parity)?;
    let timeout_duration = Duration::from_millis(timeout_ms);

    let open_handle = task::spawn_blocking(move || {
        serialport::new(port_name, baud_rate)
            .data_bits(data_bits)
            .stop_bits(stop_bits)
            .parity(parity_mode)
            .timeout(timeout_duration)
            .open()
            .map_err(|err| err.to_string())
    });

    match timeout(timeout_duration + Duration::from_millis(300), open_handle).await {
        Ok(joined) => joined
            .map_err(|err| err.to_string())
            .and_then(|result| result),
        Err(_) => Err(format!(
            "Opening serial port timed out after {} ms.",
            timeout_duration.as_millis()
        )),
    }
}

async fn read_multiple_coils_with_retry(
    client: &AsyncTcpClient<9>,
    slave_id: u8,
    start_address: u16,
    quantity: u16,
    config: TcpRuntimeConfig,
    analytics: Option<AnalyticsContext>,
) -> ApiResult<Coils> {
    let mut last_details = None;

    for attempt in 0..=u32::from(config.retry_attempts) {
        match timeout(
            config.response_timeout,
            client.read_multiple_coils(slave_id, start_address, quantity),
        )
        .await
        {
            Ok(Ok(coils)) => return Ok(coils),
            Ok(Err(err)) => last_details = Some(err.to_string()),
            Err(_) => {
                last_details = Some(format!(
                    "Response timed out after {} ms.",
                    config.response_timeout.as_millis()
                ));
            }
        }

        if attempt < u32::from(config.retry_attempts) {
            sleep(config.retry_delay((attempt + 1) as u8)).await;
        }
    }

    Err(ApiError::backend_failure(
        "Read coils failed.",
        last_details,
        analytics,
    ))
}

async fn read_multiple_discrete_inputs_with_retry(
    client: &AsyncTcpClient<9>,
    slave_id: u8,
    start_address: u16,
    quantity: u16,
    config: TcpRuntimeConfig,
    analytics: Option<AnalyticsContext>,
) -> ApiResult<DiscreteInputs> {
    let mut last_details = None;

    for attempt in 0..=u32::from(config.retry_attempts) {
        match timeout(
            config.response_timeout,
            client.read_discrete_inputs(slave_id, start_address, quantity),
        )
        .await
        {
            Ok(Ok(inputs)) => return Ok(inputs),
            Ok(Err(err)) => last_details = Some(err.to_string()),
            Err(_) => {
                last_details = Some(format!(
                    "Response timed out after {} ms.",
                    config.response_timeout.as_millis()
                ));
            }
        }

        if attempt < u32::from(config.retry_attempts) {
            sleep(config.retry_delay((attempt + 1) as u8)).await;
        }
    }

    Err(ApiError::backend_failure(
        "Read discrete inputs failed.",
        last_details,
        analytics,
    ))
}

async fn read_multiple_holding_registers_with_retry(
    client: &AsyncTcpClient<9>,
    slave_id: u8,
    start_address: u16,
    quantity: u16,
    config: TcpRuntimeConfig,
    analytics: Option<AnalyticsContext>,
) -> ApiResult<Registers> {
    let mut last_details = None;

    for attempt in 0..=u32::from(config.retry_attempts) {
        match timeout(
            config.response_timeout,
            client.read_holding_registers(slave_id, start_address, quantity),
        )
        .await
        {
            Ok(Ok(registers)) => return Ok(registers),
            Ok(Err(err)) => last_details = Some(err.to_string()),
            Err(_) => {
                last_details = Some(format!(
                    "Response timed out after {} ms.",
                    config.response_timeout.as_millis()
                ));
            }
        }

        if attempt < u32::from(config.retry_attempts) {
            sleep(config.retry_delay((attempt + 1) as u8)).await;
        }
    }

    Err(ApiError::backend_failure(
        "Read holding registers failed.",
        last_details,
        analytics,
    ))
}

async fn read_multiple_input_registers_with_retry(
    client: &AsyncTcpClient<9>,
    slave_id: u8,
    start_address: u16,
    quantity: u16,
    config: TcpRuntimeConfig,
    analytics: Option<AnalyticsContext>,
) -> ApiResult<Registers> {
    let mut last_details = None;

    for attempt in 0..=u32::from(config.retry_attempts) {
        match timeout(
            config.response_timeout,
            client.read_input_registers(slave_id, start_address, quantity),
        )
        .await
        {
            Ok(Ok(registers)) => return Ok(registers),
            Ok(Err(err)) => last_details = Some(err.to_string()),
            Err(_) => {
                last_details = Some(format!(
                    "Response timed out after {} ms.",
                    config.response_timeout.as_millis()
                ));
            }
        }

        if attempt < u32::from(config.retry_attempts) {
            sleep(config.retry_delay((attempt + 1) as u8)).await;
        }
    }

    Err(ApiError::backend_failure(
        "Read input registers failed.",
        last_details,
        analytics,
    ))
}

async fn write_single_coil_with_retry(
    client: &AsyncTcpClient<9>,
    slave_id: u8,
    address: u16,
    value: bool,
    config: TcpRuntimeConfig,
    analytics: Option<AnalyticsContext>,
) -> ApiResult<(u16, bool)> {
    let mut last_details = None;

    for attempt in 0..=u32::from(config.retry_attempts) {
        match timeout(
            config.response_timeout,
            client.write_single_coil(slave_id, address, value),
        )
        .await
        {
            Ok(Ok(response)) => return Ok(response),
            Ok(Err(err)) => last_details = Some(err.to_string()),
            Err(_) => {
                last_details = Some(format!(
                    "Response timed out after {} ms.",
                    config.response_timeout.as_millis()
                ));
            }
        }

        if attempt < u32::from(config.retry_attempts) {
            sleep(config.retry_delay((attempt + 1) as u8)).await;
        }
    }

    Err(ApiError::backend_failure(
        "Write coil failed.",
        last_details,
        analytics,
    ))
}

async fn write_single_register_with_retry(
    client: &AsyncTcpClient<9>,
    slave_id: u8,
    address: u16,
    value: u16,
    config: TcpRuntimeConfig,
    analytics: Option<AnalyticsContext>,
) -> ApiResult<(u16, u16)> {
    let mut last_details = None;

    for attempt in 0..=u32::from(config.retry_attempts) {
        match timeout(
            config.response_timeout,
            client.write_single_register(slave_id, address, value),
        )
        .await
        {
            Ok(Ok(response)) => return Ok(response),
            Ok(Err(err)) => last_details = Some(err.to_string()),
            Err(_) => {
                last_details = Some(format!(
                    "Response timed out after {} ms.",
                    config.response_timeout.as_millis()
                ));
            }
        }

        if attempt < u32::from(config.retry_attempts) {
            sleep(config.retry_delay((attempt + 1) as u8)).await;
        }
    }

    Err(ApiError::backend_failure(
        "Write holding register failed.",
        last_details,
        analytics,
    ))
}

async fn write_multiple_coils_with_retry(
    client: &AsyncTcpClient<9>,
    slave_id: u8,
    start_address: u16,
    coils: &Coils,
    config: TcpRuntimeConfig,
    analytics: Option<AnalyticsContext>,
) -> ApiResult<()> {
    let mut last_details = None;

    for attempt in 0..=u32::from(config.retry_attempts) {
        match timeout(
            config.response_timeout,
            client.write_multiple_coils(slave_id, start_address, coils),
        )
        .await
        {
            Ok(Ok(_)) => return Ok(()),
            Ok(Err(err)) => last_details = Some(err.to_string()),
            Err(_) => {
                last_details = Some(format!(
                    "Response timed out after {} ms.",
                    config.response_timeout.as_millis()
                ));
            }
        }

        if attempt < u32::from(config.retry_attempts) {
            sleep(config.retry_delay((attempt + 1) as u8)).await;
        }
    }

    Err(ApiError::backend_failure(
        "Write multiple coils failed.",
        last_details,
        analytics,
    ))
}

async fn write_multiple_registers_with_retry(
    client: &AsyncTcpClient<9>,
    slave_id: u8,
    start_address: u16,
    values: &[u16],
    config: TcpRuntimeConfig,
    analytics: Option<AnalyticsContext>,
) -> ApiResult<()> {
    let mut last_details = None;

    for attempt in 0..=u32::from(config.retry_attempts) {
        match timeout(
            config.response_timeout,
            client.write_multiple_registers(slave_id, start_address, values),
        )
        .await
        {
            Ok(Ok(_)) => return Ok(()),
            Ok(Err(err)) => last_details = Some(err.to_string()),
            Err(_) => {
                last_details = Some(format!(
                    "Response timed out after {} ms.",
                    config.response_timeout.as_millis()
                ));
            }
        }

        if attempt < u32::from(config.retry_attempts) {
            sleep(config.retry_delay((attempt + 1) as u8)).await;
        }
    }

    Err(ApiError::backend_failure(
        "Write multiple holding registers failed.",
        last_details,
        analytics,
    ))
}

fn crc16_modbus(data: &[u8]) -> u16 {
    let mut crc: u16 = 0xFFFF;
    for byte in data {
        crc ^= u16::from(*byte);
        for _ in 0..8 {
            if (crc & 0x0001) != 0 {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }
    crc
}

fn lrc_modbus(data: &[u8]) -> u8 {
    let sum: u8 = data.iter().fold(0_u8, |acc, b| acc.wrapping_add(*b));
    (!sum).wrapping_add(1)
}

fn nibble_to_hex(n: u8) -> u8 {
    match n {
        0..=9 => b'0' + n,
        10..=15 => b'A' + (n - 10),
        _ => b'0',
    }
}

fn hex_to_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(10 + (b - b'a')),
        b'A'..=b'F' => Some(10 + (b - b'A')),
        _ => None,
    }
}

fn bytes_to_ascii_hex_frame(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + data.len() * 2 + 2);
    out.push(b':');
    for byte in data {
        out.push(nibble_to_hex(byte >> 4));
        out.push(nibble_to_hex(byte & 0x0F));
    }
    out.extend_from_slice(b"\r\n");
    out
}

fn ascii_hex_frame_to_bytes(frame: &[u8]) -> Result<Vec<u8>, String> {
    let mut body = frame;
    if let Some(pos) = body.iter().position(|b| *b == b':') {
        body = &body[pos + 1..];
    }

    while matches!(body.last(), Some(b'\r' | b'\n')) {
        body = &body[..body.len() - 1];
    }

    if body.len() % 2 != 0 {
        return Err("ASCII frame has odd hex length.".to_string());
    }

    let mut out = Vec::with_capacity(body.len() / 2);
    let mut i = 0;
    while i < body.len() {
        let hi = hex_to_nibble(body[i])
            .ok_or_else(|| format!("Invalid ASCII hex character 0x{:02X}.", body[i]))?;
        let lo = hex_to_nibble(body[i + 1])
            .ok_or_else(|| format!("Invalid ASCII hex character 0x{:02X}.", body[i + 1]))?;
        out.push((hi << 4) | lo);
        i += 2;
    }

    Ok(out)
}

fn serial_send_request(
    session: &mut SerialSession,
    function: u8,
    payload: &[u8],
) -> Result<Vec<u8>, String> {
    match session.frame_mode {
        SerialFrameMode::Rtu => serial_send_request_rtu(session, function, payload),
        SerialFrameMode::Ascii => serial_send_request_ascii(session, function, payload),
    }
}

fn serial_send_request_ascii(
    session: &mut SerialSession,
    function: u8,
    payload: &[u8],
) -> Result<Vec<u8>, String> {
    let mut pdu = Vec::with_capacity(2 + payload.len() + 1);
    pdu.push(session.slave_id);
    pdu.push(function);
    pdu.extend_from_slice(payload);
    pdu.push(lrc_modbus(&pdu));

    let frame = bytes_to_ascii_hex_frame(&pdu);

    let _ = session.port.clear(ClearBuffer::All);
    session
        .port
        .write_all(&frame)
        .map_err(|err| format!("Serial ASCII write failed: {}", err))?;
    // Some Windows serial drivers report flush as unsupported; write_all is sufficient here.
    let _ = session.port.flush();

    let mut buffer = Vec::with_capacity(256);
    let mut byte = [0_u8; 1];
    loop {
        session
            .port
            .read_exact(&mut byte)
            .map_err(|err| format!("Serial ASCII read failed: {}", err))?;
        buffer.push(byte[0]);
        if byte[0] == b'\n' {
            break;
        }
        if buffer.len() > 2048 {
            return Err("Serial ASCII response exceeded max frame size.".to_string());
        }
    }

    let bytes = ascii_hex_frame_to_bytes(&buffer)?;
    if bytes.len() < 4 {
        return Err("Serial ASCII response frame too short.".to_string());
    }

    let frame_lrc = *bytes.last().unwrap_or(&0);
    let computed_lrc = lrc_modbus(&bytes[..bytes.len() - 1]);
    if frame_lrc != computed_lrc {
        return Err("Invalid LRC in serial ASCII response frame.".to_string());
    }

    if bytes[0] != session.slave_id {
        return Err(format!(
            "Unit ID mismatch: expected {}, got {}.",
            session.slave_id, bytes[0]
        ));
    }

    let response_function = bytes[1];
    if response_function == (function | 0x80) {
        let exception_code = *bytes.get(2).unwrap_or(&0);
        return Err(format!(
            "Modbus exception for FC{:02X}: code 0x{:02X}.",
            function, exception_code
        ));
    }

    if response_function != function {
        return Err(format!(
            "Function code mismatch: expected 0x{:02X}, got 0x{:02X}.",
            function, response_function
        ));
    }

    Ok(bytes[2..bytes.len() - 1].to_vec())
}

fn serial_send_request_rtu(
    session: &mut SerialSession,
    function: u8,
    payload: &[u8],
) -> Result<Vec<u8>, String> {
    let mut frame = Vec::with_capacity(2 + payload.len() + 2);
    frame.push(session.slave_id);
    frame.push(function);
    frame.extend_from_slice(payload);
    let crc = crc16_modbus(&frame);
    frame.extend_from_slice(&crc.to_le_bytes());

    let _ = session.port.clear(ClearBuffer::All);
    session
        .port
        .write_all(&frame)
        .map_err(|err| format!("Serial write failed: {}", err))?;
    // Some Windows serial drivers report flush as unsupported; write_all is sufficient here.
    let _ = session.port.flush();

    let deadline = Instant::now() + session.timeout;
    let mut buffer = Vec::with_capacity(256);
    let mut chunk = [0_u8; 256];

    loop {
        if let Some(response_payload) = try_extract_serial_rtu_response(
            &mut buffer,
            session.slave_id,
            function,
            payload,
            &frame,
        )? {
            return Ok(response_payload);
        }

        if Instant::now() >= deadline {
            let observed = if buffer.is_empty() {
                "no bytes received".to_string()
            } else {
                format!("received {}", format_hex_bytes(&buffer))
            };
            return Err(format!(
                "Serial response timed out after {} ms ({observed}).",
                session.timeout.as_millis()
            ));
        }

        match session.port.read(&mut chunk) {
            Ok(0) => {}
            Ok(read) => {
                buffer.extend_from_slice(&chunk[..read]);
                if buffer.len() > 4096 {
                    return Err("Serial response exceeded max frame size.".to_string());
                }
            }
            Err(err) if matches!(err.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {}
            Err(err) => return Err(format!("Serial response read failed: {}", err)),
        }
    }
}

fn try_extract_serial_rtu_response(
    buffer: &mut Vec<u8>,
    slave_id: u8,
    function: u8,
    request_payload: &[u8],
    request_frame: &[u8],
) -> Result<Option<Vec<u8>>, String> {
    loop {
        if buffer.is_empty() {
            return Ok(None);
        }

        if buffer.len() >= request_frame.len()
            && buffer.starts_with(request_frame)
            && !serial_response_can_equal_request(function)
        {
            buffer.drain(..request_frame.len());
            continue;
        }

        if buffer[0] != slave_id {
            buffer.remove(0);
            continue;
        }

        if buffer.len() < 2 {
            return Ok(None);
        }

        let response_function = buffer[1];
        if response_function != function && response_function != (function | 0x80) {
            buffer.remove(0);
            continue;
        }

        let Some(frame_len) = serial_rtu_frame_length(buffer, function, request_payload)? else {
            return Ok(None);
        };

        if buffer.len() < frame_len {
            return Ok(None);
        }

        let frame = buffer[..frame_len].to_vec();
        let expected_crc = u16::from_le_bytes([frame[frame_len - 2], frame[frame_len - 1]]);
        let actual_crc = crc16_modbus(&frame[..frame_len - 2]);
        if expected_crc != actual_crc {
            if frame == request_frame {
                buffer.drain(..frame_len);
                continue;
            }

            buffer.remove(0);
            continue;
        }

        buffer.drain(..frame_len);

        if response_function == (function | 0x80) {
            let exception_code = frame.get(2).copied().unwrap_or_default();
            return Err(format!(
                "Modbus exception for FC{:02X}: code 0x{:02X}.",
                function, exception_code
            ));
        }

        return Ok(Some(frame[2..frame_len - 2].to_vec()));
    }
}

fn serial_response_can_equal_request(function: u8) -> bool {
    matches!(function, 0x05 | 0x06 | 0x08)
}

fn serial_rtu_frame_length(
    frame: &[u8],
    function: u8,
    request_payload: &[u8],
) -> Result<Option<usize>, String> {
    if frame.len() < 2 {
        return Ok(None);
    }

    let response_function = frame[1];
    if response_function == (function | 0x80) {
        return Ok(Some(5));
    }

    if response_function != function {
        return Ok(None);
    }

    match function {
        0x01 | 0x02 | 0x03 | 0x04 | 0x0C | 0x11 => {
            if frame.len() < 3 {
                Ok(None)
            } else {
                Ok(Some(usize::from(frame[2]) + 5))
            }
        }
        0x05 | 0x06 | 0x0F | 0x10 | 0x0B => Ok(Some(8)),
        0x07 => Ok(Some(5)),
        0x08 => Ok(Some(request_payload.len() + 4)),
        0x2B => {
            if frame.len() < 8 {
                return Ok(None);
            }

            let object_count = usize::from(frame[7]);
            let mut total_len = 10;
            let mut cursor = 8;
            for _ in 0..object_count {
                if frame.len() < cursor + 2 {
                    return Ok(None);
                }

                let value_len = usize::from(frame[cursor + 1]);
                cursor += 2;
                if frame.len() < cursor + value_len {
                    return Ok(None);
                }

                cursor += value_len;
                total_len += 2 + value_len;
            }

            Ok(Some(total_len))
        }
        _ => Err(format!(
            "Serial RTU function 0x{:02X} not implemented in request parser.",
            function
        )),
    }
}

fn format_hex_bytes(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{:02X}", byte))
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_hex_input(input: &str) -> Result<Vec<u8>, String> {
    let mut cleaned = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_ascii_hexdigit() {
            cleaned.push(ch);
        }
    }

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

fn resolve_custom_frame_request(request: &CustomFrameRequest) -> ApiResult<(u8, Vec<u8>)> {
    match request.mode {
        CustomFrameMode::FunctionPayload => {
            let function = request.function_code.ok_or_else(|| {
                ApiError::invalid_request(
                    "functionCode is required for function-payload mode.",
                    request.analytics.clone(),
                )
            })?;
            let payload_hex = request.payload_hex.clone().unwrap_or_default();
            let payload = parse_hex_input(&payload_hex).map_err(|details| {
                ApiError::backend_failure(
                    "payloadHex is not valid hex.",
                    Some(details),
                    request.analytics.clone(),
                )
            })?;
            Ok((function, payload))
        }
        CustomFrameMode::RawBytes => {
            let raw_hex = request.raw_hex.clone().unwrap_or_default();
            let raw = parse_hex_input(&raw_hex).map_err(|details| {
                ApiError::backend_failure(
                    "rawHex is not valid hex.",
                    Some(details),
                    request.analytics.clone(),
                )
            })?;

            if raw.is_empty() {
                return Err(ApiError::invalid_request(
                    "rawHex must include at least one byte (function code).",
                    request.analytics.clone(),
                ));
            }

            Ok((raw[0], raw[1..].to_vec()))
        }
    }
}

fn describe_custom_pdu(mode: &str, function: u8, payload: &[u8]) -> String {
    let details = decode_pdu_details(mode, function, false, payload);
    format!(
        "fc=0x{:02X}({}) kind={} {}",
        function,
        modbus_function_name(function),
        mode,
        details
    )
}

fn describe_tcp_adu_human(frame: &[u8], direction: &str) -> String {
    if frame.len() < 8 {
        return format!("invalid_adu reason=short frame_len={}", frame.len());
    }

    let txn = u16::from_be_bytes([frame[0], frame[1]]);
    let protocol = u16::from_be_bytes([frame[2], frame[3]]);
    let declared_len = u16::from_be_bytes([frame[4], frame[5]]);
    let unit = frame[6];

    if protocol != 0 {
        return format!(
            "invalid_adu txn={} unit={} reason=protocol_id protocol={}",
            txn, unit, protocol
        );
    }

    let expected_total = 6 + usize::from(declared_len);
    let pdu = &frame[7..];
    if pdu.is_empty() {
        return format!(
            "invalid_adu txn={} unit={} reason=missing_pdu declared_len={}",
            txn, unit, declared_len
        );
    }

    let function_raw = pdu[0];
    let is_exception = (function_raw & 0x80) != 0;
    let function = function_raw & 0x7F;
    let fc_name = modbus_function_name(function);
    let mode = if direction.contains("tx") {
        "request"
    } else {
        "response"
    };
    let pdu_details = decode_pdu_details(mode, function, is_exception, &pdu[1..]);

    format!(
        "txn={} unit={} fc=0x{:02X}({}) kind={} mbap_len={} frame_len={} expected_len={} {}",
        txn,
        unit,
        function,
        fc_name,
        mode,
        declared_len,
        frame.len(),
        expected_total,
        pdu_details
    )
}

fn decode_pdu_details(mode: &str, function: u8, is_exception: bool, data: &[u8]) -> String {
    if is_exception {
        let exception = data.first().copied().unwrap_or_default();
        return format!(
            "exception=0x{:02X}({})",
            exception,
            modbus_exception_name(exception)
        );
    }

    match function {
        0x01 | 0x02 | 0x03 | 0x04 => {
            if mode == "request" && data.len() >= 4 {
                let start = u16::from_be_bytes([data[0], data[1]]);
                let qty = u16::from_be_bytes([data[2], data[3]]);
                return format!("start={} qty={}", start, qty);
            }

            if mode == "response" && !data.is_empty() {
                return format!("byte_count={}", data[0]);
            }
        }
        0x05 => {
            if data.len() >= 4 {
                let addr = u16::from_be_bytes([data[0], data[1]]);
                let raw = u16::from_be_bytes([data[2], data[3]]);
                let value = match raw {
                    0xFF00 => "on",
                    0x0000 => "off",
                    _ => "unknown",
                };
                return format!("addr={} value=0x{:04X}({})", addr, raw, value);
            }
        }
        0x06 => {
            if data.len() >= 4 {
                let addr = u16::from_be_bytes([data[0], data[1]]);
                let value = u16::from_be_bytes([data[2], data[3]]);
                return format!("addr={} value={}", addr, value);
            }
        }
        0x08 => {
            if data.len() >= 2 {
                let sub = u16::from_be_bytes([data[0], data[1]]);
                let sub_name = DiagnosticSubFunction::try_from(sub)
                    .map(|known| format!("{:?}", known))
                    .unwrap_or_else(|_| "ReservedOrVendorSpecific".to_string());
                return format!("sub=0x{:04X}({}) data_len={}", sub, sub_name, data.len().saturating_sub(2));
            }
        }
        0x0F | 0x10 => {
            if mode == "request" && data.len() >= 5 {
                let start = u16::from_be_bytes([data[0], data[1]]);
                let qty = u16::from_be_bytes([data[2], data[3]]);
                let byte_count = data[4];
                return format!("start={} qty={} byte_count={}", start, qty, byte_count);
            }

            if mode == "response" && data.len() >= 4 {
                let start = u16::from_be_bytes([data[0], data[1]]);
                let qty = u16::from_be_bytes([data[2], data[3]]);
                return format!("start={} qty={}", start, qty);
            }
        }
        0x2B => {
            if let Some(mei_raw) = data.first().copied() {
                let mei_name = EncapsulatedInterfaceType::try_from(mei_raw)
                    .map(|known| format!("{:?}", known))
                    .unwrap_or_else(|_| "Reserved".to_string());
                return format!("mei=0x{:02X}({}) payload_len={}", mei_raw, mei_name, data.len().saturating_sub(1));
            }
        }
        _ => {}
    }

    format!("pdu_len={}", data.len() + 1)
}

fn modbus_function_name(function: u8) -> &'static str {
    match function {
        0x01 => "ReadCoils",
        0x02 => "ReadDiscreteInputs",
        0x03 => "ReadHoldingRegisters",
        0x04 => "ReadInputRegisters",
        0x05 => "WriteSingleCoil",
        0x06 => "WriteSingleRegister",
        0x07 => "ReadExceptionStatus",
        0x08 => "Diagnostics",
        0x0B => "GetCommEventCounter",
        0x0C => "GetCommEventLog",
        0x0F => "WriteMultipleCoils",
        0x10 => "WriteMultipleRegisters",
        0x11 => "ReportServerId",
        0x14 => "ReadFileRecord",
        0x15 => "WriteFileRecord",
        0x16 => "MaskWriteRegister",
        0x17 => "ReadWriteMultipleRegisters",
        0x18 => "ReadFifoQueue",
        0x2B => "EncapsulatedInterfaceTransport",
        _ => "Unknown",
    }
}

fn modbus_exception_name(code: u8) -> &'static str {
    match code {
        0x01 => "IllegalFunction",
        0x02 => "IllegalDataAddress",
        0x03 => "IllegalDataValue",
        0x04 => "ServerDeviceFailure",
        0x05 => "Acknowledge",
        0x06 => "ServerDeviceBusy",
        0x08 => "MemoryParityError",
        0x0A => "GatewayPathUnavailable",
        0x0B => "GatewayTargetFailedToRespond",
        _ => "UnknownException",
    }
}

fn parse_bit_read_response(payload: &[u8], quantity: u16, function: u8) -> Result<Vec<bool>, String> {
    if payload.is_empty() {
        return Err(format!("FC{:02X} response missing byte count.", function));
    }

    let byte_count = usize::from(payload[0]);
    if payload.len() != byte_count + 1 {
        return Err(format!(
            "FC{:02X} payload length mismatch: expected {}, got {}.",
            function,
            byte_count + 1,
            payload.len()
        ));
    }

    let mut bits = Vec::with_capacity(quantity as usize);
    let data = &payload[1..];
    for i in 0..usize::from(quantity) {
        let byte = data[i / 8];
        let bit = (byte >> (i % 8)) & 0x01;
        bits.push(bit == 1);
    }

    Ok(bits)
}

fn parse_register_read_response(
    payload: &[u8],
    quantity: u16,
    function: u8,
) -> Result<Vec<u16>, String> {
    if payload.is_empty() {
        return Err(format!("FC{:02X} response missing byte count.", function));
    }

    let byte_count = usize::from(payload[0]);
    let expected_count = usize::from(quantity) * 2;
    if byte_count != expected_count {
        return Err(format!(
            "FC{:02X} byte count mismatch: expected {}, got {}.",
            function, expected_count, byte_count
        ));
    }

    if payload.len() != byte_count + 1 {
        return Err(format!(
            "FC{:02X} payload length mismatch: expected {}, got {}.",
            function,
            byte_count + 1,
            payload.len()
        ));
    }

    let mut regs = Vec::with_capacity(quantity as usize);
    let bytes = &payload[1..];
    for i in 0..usize::from(quantity) {
        let hi = bytes[i * 2];
        let lo = bytes[i * 2 + 1];
        regs.push(u16::from_be_bytes([hi, lo]));
    }

    Ok(regs)
}

fn parse_single_write_coil_response(payload: &[u8]) -> Result<(u16, bool), String> {
    if payload.len() != 4 {
        return Err(format!(
            "FC05 response length mismatch: expected 4 bytes, got {}.",
            payload.len()
        ));
    }

    let address = u16::from_be_bytes([payload[0], payload[1]]);
    let raw = u16::from_be_bytes([payload[2], payload[3]]);
    match raw {
        0xFF00 => Ok((address, true)),
        0x0000 => Ok((address, false)),
        _ => Err(format!("FC05 invalid coil echo value 0x{:04X}.", raw)),
    }
}

fn parse_single_write_register_response(payload: &[u8]) -> Result<(u16, u16), String> {
    if payload.len() != 4 {
        return Err(format!(
            "FC06 response length mismatch: expected 4 bytes, got {}.",
            payload.len()
        ));
    }

    let address = u16::from_be_bytes([payload[0], payload[1]]);
    let value = u16::from_be_bytes([payload[2], payload[3]]);
    Ok((address, value))
}

fn parse_device_identification_payload(
    response: &[u8],
) -> Result<(Option<u8>, Vec<super::types::DeviceIdObject>), String> {
    if response.len() < 6 {
        return Err(format!("FC43 response too short: got {} bytes.", response.len()));
    }
    if response[0] != 0x0E {
        return Err(format!(
            "FC43 invalid MEI type: expected 0x0E, got 0x{:02X}.",
            response[0]
        ));
    }

    let conformity = Some(response[2]);
    let object_count = response[5] as usize;
    let mut cursor = 6;
    let mut objects = Vec::with_capacity(object_count);

    for _ in 0..object_count {
        if cursor + 2 > response.len() {
            return Err("FC43 truncated object header.".to_string());
        }

        let id = response[cursor];
        let len = response[cursor + 1] as usize;
        cursor += 2;

        if cursor + len > response.len() {
            return Err(format!(
                "FC43 object {} truncated: expected {} bytes.",
                id, len
            ));
        }

        let value_bytes = &response[cursor..cursor + len];
        cursor += len;

        objects.push(super::types::DeviceIdObject {
            id,
            value: decode_modbus_text(value_bytes),
        });
    }

    Ok((conformity, objects))
}

fn serial_read_exception_status(session: &mut SerialSession) -> Result<u8, String> {
    let response = serial_send_request(session, 0x07, &[])?;
    if response.len() != 1 {
        return Err(format!(
            "FC07 response length mismatch: expected 1 byte, got {}.",
            response.len()
        ));
    }
    Ok(response[0])
}

fn serial_diagnostic(
    session: &mut SerialSession,
    subfunction: u16,
    data: &[u8],
) -> Result<Vec<u8>, String> {
    let mut payload = Vec::with_capacity(2 + data.len());
    payload.extend_from_slice(&subfunction.to_be_bytes());
    payload.extend_from_slice(data);
    serial_send_request(session, 0x08, &payload)
}

fn serial_get_com_event_counter(session: &mut SerialSession) -> Result<(u16, u16), String> {
    let response = serial_send_request(session, 0x0B, &[])?;
    if response.len() != 4 {
        return Err(format!(
            "FC11 response length mismatch: expected 4 bytes, got {}.",
            response.len()
        ));
    }

    let status = u16::from_be_bytes([response[0], response[1]]);
    let event_count = u16::from_be_bytes([response[2], response[3]]);
    Ok((status, event_count))
}

fn serial_get_com_event_log(
    session: &mut SerialSession,
    _start: u16,
    count: u16,
) -> Result<Vec<super::types::ComEventLogEntry>, String> {
    let response = serial_send_request(session, 0x0C, &[])?;
    if response.len() < 7 {
        return Err(format!("FC12 response too short: got {} bytes.", response.len()));
    }

    let byte_count = response[0] as usize;
    if response.len() != byte_count + 1 {
        return Err(format!(
            "FC12 byte-count mismatch: header says {}, frame contains {} payload bytes.",
            byte_count,
            response.len().saturating_sub(1)
        ));
    }

    let events = &response[7..];
    let take_count = usize::from(count).min(events.len());
    Ok(events[..take_count]
        .iter()
        .map(|byte| super::types::ComEventLogEntry { data: vec![*byte] })
        .collect())
}

fn serial_report_server_id(session: &mut SerialSession) -> Result<Vec<u8>, String> {
    serial_send_request(session, 0x11, &[])
}

fn serial_read_device_identification(
    session: &mut SerialSession,
    level: u8,
    object_id: u8,
) -> Result<(Option<u8>, Vec<super::types::DeviceIdObject>), String> {
    let payload = [0x0E, level, object_id];
    let response = serial_send_request(session, 0x2B, &payload)?;
    parse_device_identification_payload(&response)
}

fn describe_api_error(err: &ApiError) -> String {
    match &err.details {
        Some(details) if !details.trim().is_empty() => format!("{} ({})", err.message, details),
        _ => err.message.clone(),
    }
}

fn api_error_code(err: &ApiError) -> &'static str {
    match err.code {
        super::types::ErrorCode::InvalidRequest => "INVALID_REQUEST",
        super::types::ErrorCode::ConnectionConflict => "CONNECTION_CONFLICT",
        super::types::ErrorCode::NotImplementedYet => "NOT_IMPLEMENTED_YET",
        super::types::ErrorCode::NotConnected => "NOT_CONNECTED",
        super::types::ErrorCode::BackendFailure => "BACKEND_FAILURE",
    }
}

// Diagnostics Helper Functions (FC07/08/11/12/17/43)

async fn read_exception_status_with_retry(
    host: &str,
    port: u16,
    slave_id: u8,
    config: TcpRuntimeConfig,
) -> Result<u8, String> {
    let response = send_raw_modbus_request_with_retry(host, port, slave_id, 0x07, &[], config).await?;
    if response.len() != 1 {
        return Err(format!("FC07 response length mismatch: expected 1 byte, got {}.", response.len()));
    }

    Ok(response[0])
}

async fn diagnostic_with_retry(
    host: &str,
    port: u16,
    slave_id: u8,
    subfunction: u16,
    data: &[u8],
    config: TcpRuntimeConfig,
) -> Result<Vec<u8>, String> {
    let mut payload = Vec::with_capacity(2 + data.len());
    payload.extend_from_slice(&subfunction.to_be_bytes());
    payload.extend_from_slice(data);

    send_raw_modbus_request_with_retry(host, port, slave_id, 0x08, &payload, config).await
}

async fn get_com_event_counter_with_retry(
    host: &str,
    port: u16,
    slave_id: u8,
    config: TcpRuntimeConfig,
) -> Result<(u16, u16), String> {
    let response = send_raw_modbus_request_with_retry(host, port, slave_id, 0x0B, &[], config).await?;
    if response.len() != 4 {
        return Err(format!("FC11 response length mismatch: expected 4 bytes, got {}.", response.len()));
    }

    let status = u16::from_be_bytes([response[0], response[1]]);
    let event_count = u16::from_be_bytes([response[2], response[3]]);
    Ok((status, event_count))
}

async fn get_com_event_log_with_retry(
    host: &str,
    port: u16,
    slave_id: u8,
    _start: u16,
    count: u16,
    config: TcpRuntimeConfig,
) -> Result<Vec<super::types::ComEventLogEntry>, String> {
    let response = send_raw_modbus_request_with_retry(host, port, slave_id, 0x0C, &[], config).await?;
    if response.len() < 7 {
        return Err(format!("FC12 response too short: got {} bytes.", response.len()));
    }

    let byte_count = response[0] as usize;
    if response.len() != byte_count + 1 {
        return Err(format!(
            "FC12 byte-count mismatch: header says {}, frame contains {} payload bytes.",
            byte_count,
            response.len().saturating_sub(1)
        ));
    }

    let events = &response[7..];
    let take_count = usize::from(count).min(events.len());
    let entries = events[..take_count]
        .iter()
        .map(|byte| super::types::ComEventLogEntry { data: vec![*byte] })
        .collect();

    Ok(entries)
}

async fn report_server_id_with_retry(
    host: &str,
    port: u16,
    slave_id: u8,
    config: TcpRuntimeConfig,
) -> Result<Vec<u8>, String> {
    send_raw_modbus_request_with_retry(host, port, slave_id, 0x11, &[], config).await
}

async fn read_device_identification_with_retry(
    host: &str,
    port: u16,
    slave_id: u8,
    level: u8,
    object_id: u8,
    config: TcpRuntimeConfig,
) -> Result<(Option<u8>, Vec<super::types::DeviceIdObject>), String> {
    let payload = [0x0E, level, object_id];
    let response = send_raw_modbus_request_with_retry(host, port, slave_id, 0x2B, &payload, config).await?;
    if response.len() < 6 {
        return Err(format!("FC43 response too short: got {} bytes.", response.len()));
    }
    if response[0] != 0x0E {
        return Err(format!("FC43 invalid MEI type: expected 0x0E, got 0x{:02X}.", response[0]));
    }

    let conformity = Some(response[2]);
    let object_count = response[5] as usize;
    let mut cursor = 6;
    let mut objects = Vec::with_capacity(object_count);

    for _ in 0..object_count {
        if cursor + 2 > response.len() {
            return Err("FC43 truncated object header.".to_string());
        }

        let id = response[cursor];
        let len = response[cursor + 1] as usize;
        cursor += 2;

        if cursor + len > response.len() {
            return Err(format!("FC43 object {} truncated: expected {} bytes.", id, len));
        }

        let value_bytes = &response[cursor..cursor + len];
        cursor += len;

        objects.push(super::types::DeviceIdObject {
            id,
            value: decode_modbus_text(value_bytes),
        });
    }

    Ok((conformity, objects))
}

async fn send_raw_modbus_request_with_retry(
    host: &str,
    port: u16,
    slave_id: u8,
    function: u8,
    payload: &[u8],
    config: TcpRuntimeConfig,
) -> Result<Vec<u8>, String> {
    let mut last_error = None;

    for attempt in 0..=u32::from(config.retry_attempts) {
        match send_raw_modbus_request_once(host, port, slave_id, function, payload, config).await {
            Ok(response) => return Ok(response),
            Err(err) => last_error = Some(err),
        }

        if attempt < u32::from(config.retry_attempts) {
            sleep(config.retry_delay((attempt + 1) as u8)).await;
        }
    }

    Err(last_error.unwrap_or_else(|| "Unknown error".to_string()))
}

async fn send_raw_modbus_request_once(
    host: &str,
    port: u16,
    slave_id: u8,
    function: u8,
    payload: &[u8],
    config: TcpRuntimeConfig,
) -> Result<Vec<u8>, String> {
    let address = format!("{host}:{port}");
    let mut stream = timeout(config.response_timeout, TcpStream::connect(address.as_str()))
        .await
        .map_err(|_| format!("TCP connect timed out after {} ms.", config.response_timeout.as_millis()))
        .and_then(|result| result.map_err(|err| err.to_string()))?;

    let transaction_id = pseudo_random(u16::MAX as u64) as u16;
    let length = u16::try_from(payload.len() + 2).map_err(|_| "Modbus request too large.".to_string())?;

    let mut request = Vec::with_capacity(8 + payload.len());
    request.extend_from_slice(&transaction_id.to_be_bytes());
    request.extend_from_slice(&0_u16.to_be_bytes());
    request.extend_from_slice(&length.to_be_bytes());
    request.push(slave_id);
    request.push(function);
    request.extend_from_slice(payload);

    timeout(config.response_timeout, stream.write_all(&request))
        .await
        .map_err(|_| format!("TCP write timed out after {} ms.", config.response_timeout.as_millis()))
        .and_then(|result| result.map_err(|err| err.to_string()))?;

    let mut header = [0_u8; 7];
    timeout(config.response_timeout, stream.read_exact(&mut header))
        .await
        .map_err(|_| format!("TCP header read timed out after {} ms.", config.response_timeout.as_millis()))
        .and_then(|result| result.map_err(|err| err.to_string()))?;

    let response_transaction_id = u16::from_be_bytes([header[0], header[1]]);
    if response_transaction_id != transaction_id {
        return Err(format!(
            "Transaction ID mismatch: sent {}, received {}.",
            transaction_id, response_transaction_id
        ));
    }

    if header[6] != slave_id {
        return Err(format!("Unit ID mismatch: sent {}, received {}.", slave_id, header[6]));
    }

    let remaining_length = usize::from(u16::from_be_bytes([header[4], header[5]]));
    if remaining_length < 2 {
        return Err(format!("Invalid Modbus TCP length: {}.", remaining_length));
    }

    let mut response = vec![0_u8; remaining_length - 1];
    timeout(config.response_timeout, stream.read_exact(&mut response))
        .await
        .map_err(|_| format!("TCP payload read timed out after {} ms.", config.response_timeout.as_millis()))
        .and_then(|result| result.map_err(|err| err.to_string()))?;

    let response_function = response[0];
    if response_function == (function | 0x80) {
        let exception_code = response.get(1).copied().unwrap_or_default();
        return Err(format!("Modbus exception for FC{:02X}: code 0x{:02X}.", function, exception_code));
    }

    if response_function != function {
        return Err(format!(
            "Function code mismatch: expected 0x{:02X}, received 0x{:02X}.",
            function, response_function
        ));
    }

    Ok(response[1..].to_vec())
}

fn decode_modbus_text(bytes: &[u8]) -> String {
    let trimmed: Vec<u8> = bytes.iter().copied().filter(|byte| *byte != 0).collect();
    if trimmed.is_empty() {
        return String::new();
    }

    let printable = trimmed
        .iter()
        .filter(|byte| matches!(byte, 0x20..=0x7E | b'\n' | b'\r' | b'\t'))
        .count();

    if printable * 100 >= trimmed.len() * 70 {
        String::from_utf8_lossy(&trimmed)
            .chars()
            .map(|ch| if ch.is_ascii_control() && ch != '\n' && ch != '\r' && ch != '\t' { ' ' } else { ch })
            .collect::<String>()
            .trim()
            .to_string()
    } else {
        trimmed
            .iter()
            .map(|byte| format!("{:02X}", byte))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::{crc16_modbus, try_extract_serial_rtu_response};

    #[test]
    fn extracts_fc01_response_after_echoed_request_frame() {
        let request_payload = [0x00, 0x00, 0x00, 0x01];

        let mut request_frame = vec![0x01, 0x01];
        request_frame.extend_from_slice(&request_payload);
        let request_crc = crc16_modbus(&request_frame);
        request_frame.extend_from_slice(&request_crc.to_le_bytes());

        let mut response_frame = vec![0x01, 0x01, 0x01, 0x00];
        let response_crc = crc16_modbus(&response_frame);
        response_frame.extend_from_slice(&response_crc.to_le_bytes());

        let mut buffer = request_frame.clone();
        buffer.extend_from_slice(&response_frame);

        let payload = try_extract_serial_rtu_response(
            &mut buffer,
            0x01,
            0x01,
            &request_payload,
            &request_frame,
        )
        .expect("response should parse")
        .expect("response should be available");

        assert_eq!(payload, vec![0x01, 0x00]);
        assert!(buffer.is_empty());
    }

    #[test]
    fn accepts_fc05_response_equal_to_request_frame() {
        let request_payload = [0x00, 0x06, 0xFF, 0x00];

        let mut request_frame = vec![0x01, 0x05];
        request_frame.extend_from_slice(&request_payload);
        let request_crc = crc16_modbus(&request_frame);
        request_frame.extend_from_slice(&request_crc.to_le_bytes());

        let mut buffer = request_frame.clone();

        let payload = try_extract_serial_rtu_response(
            &mut buffer,
            0x01,
            0x05,
            &request_payload,
            &request_frame,
        )
        .expect("response should parse")
        .expect("response should be available");

        assert_eq!(payload, request_payload);
        assert!(buffer.is_empty());
    }
}
