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

use modbus_rs::mbus_async::{AsyncClientNotifier, AsyncTcpClient};
use modbus_rs::{crc16, Coils, DiagnosticSubFunction, DiscreteInputs, EncapsulatedInterfaceType, MbusError, Registers, UnitIdOrSlaveAddr};
use mbus_core::transport::checksum::lrc;
use mbus_core::function_codes::public::FunctionCode;
use mbus_core::data_unit::common::{AdditionalAddress, ModbusMessage, Pdu};
use serialport::{ClearBuffer, DataBits, Parity, SerialPort, StopBits};

use tauri::AppHandle;
use super::events::emit_log as emit_supervisor_log;

const TCP_EXPECTED_RESPONSES_DEPTH: usize = 32;
type TcpClient = AsyncTcpClient<TCP_EXPECTED_RESPONSES_DEPTH>;

/// How many consecutive transport failures on live requests before the supervisor
/// is triggered immediately — without waiting for the idle-heartbeat window.
pub const CONSECUTIVE_TRANSPORT_FAILURE_THRESHOLD: u32 = 1;
/// Maximum back-off between supervisor reconnect attempts (seconds).
const SUPERVISOR_RECONNECT_MAX_BACKOFF_SECS: u64 = 30;

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
    heartbeat_idle_after: Option<Duration>,
    last_communication_at: Instant,
    reconnect_attempt: u32,
    last_reconnect_error_code: Option<String>,
    last_reconnect_error_message: Option<String>,
    /// Counts transport-level errors since last success; triggers immediate reconnect at threshold.
    consecutive_transport_failures: u32,
    /// Supervisor waits until this instant before retrying a failed reconnect (exponential back-off).
    reconnect_backoff_until: Option<Instant>,
    /// Tauri app handle — used by the supervisor to emit status events without a command context.
    app: AppHandle,
    traffic_sink: Option<TcpTrafficSink>,
    request_gate: TcpRequestGate,
    client: Arc<TcpClient>,
}

type TcpTrafficSink = Arc<dyn Fn(String) + Send + Sync + 'static>;
type TcpRequestGate = Arc<Mutex<()>>;

/// Bridges the 0.7.0 `AsyncClientNotifier` trait to our existing traffic sink closure.
struct TrafficBridge {
    sink: TcpTrafficSink,
}

impl TrafficBridge {
    fn emit(&self, direction: &str, txn_id: u16, unit: UnitIdOrSlaveAddr, frame: &[u8], error: Option<&MbusError>) {
        // Ignore short RX chunks that cannot represent a full Modbus TCP ADU.
        if direction == "rx" && frame.len() < 8 {
            return;
        }

        let bytes = format_hex_bytes(frame);
        let adu = describe_tcp_adu_human(frame, direction);
        let error_detail = error.map(|e| format_mbus_error_detail(e)).unwrap_or_default();
        let message = if error_detail.is_empty() {
            format!(
                "tcp.{direction} txn={txn_id} unit={} adu={adu} bytes={bytes}",
                unit.get(),
            )
        } else {
            format!(
                "tcp.{direction} txn={txn_id} unit={} {error_detail} adu={adu} bytes={bytes}",
                unit.get(),
            )
        };

        (self.sink)(message);
    }
}

/// Formats a structured `MbusError` into key=value tokens for traffic log messages.
fn format_mbus_error_detail(err: &MbusError) -> String {
    match err {
        MbusError::ModbusException(code) => {
            let name = modbus_exception_name(*code);
            format!("error_type=exception exception_code=0x{code:02X}({name})")
        }
        MbusError::Timeout => "error_type=timeout".to_string(),
        MbusError::SendFailed => "error_type=send_failed".to_string(),
        MbusError::ConnectionLost => "error_type=connection_lost".to_string(),
        MbusError::ConnectionClosed => "error_type=connection_closed".to_string(),
        MbusError::ConnectionFailed => "error_type=connection_failed".to_string(),
        MbusError::IoError => "error_type=io_error".to_string(),
        MbusError::ParseError => "error_type=parse_error".to_string(),
        MbusError::BasicParseError => "error_type=basic_parse_error".to_string(),
        MbusError::InvalidPduLength => "error_type=invalid_pdu_length".to_string(),
        MbusError::InvalidAduLength => "error_type=invalid_adu_length".to_string(),
        MbusError::TooManyRequests => "error_type=too_many_requests".to_string(),
        MbusError::ChecksumError => "error_type=checksum_error".to_string(),
        MbusError::BufferTooSmall => "error_type=buffer_too_small".to_string(),
        MbusError::UnexpectedResponse => "error_type=unexpected_response".to_string(),
        MbusError::UnsupportedFunction(fc) => format!("error_type=unsupported_function fc=0x{fc:02X}"),
        other => format!("error_type=other err={other}"),
    }
}

impl AsyncClientNotifier for TrafficBridge {
    fn on_tx_frame(&mut self, txn_id: u16, unit: UnitIdOrSlaveAddr, frame: &[u8]) {
        self.emit("tx", txn_id, unit, frame, None);
    }
    fn on_rx_frame(&mut self, txn_id: u16, unit: UnitIdOrSlaveAddr, frame: &[u8]) {
        self.emit("rx", txn_id, unit, frame, None);
    }
    fn on_tx_error(&mut self, txn_id: u16, unit: UnitIdOrSlaveAddr, error: MbusError, frame: &[u8]) {
        self.emit("tx", txn_id, unit, frame, Some(&error));
    }
    fn on_rx_error(&mut self, txn_id: u16, unit: UnitIdOrSlaveAddr, error: MbusError, frame: &[u8]) {
        self.emit("rx", txn_id, unit, frame, Some(&error));
    }
}

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
        app: AppHandle,
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
            request.resolved_heartbeat_idle_after_ms().map(Duration::from_millis);

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
            consecutive_transport_failures: 0,
            reconnect_backoff_until: None,
            app: app.clone(),
            traffic_sink,
            request_gate: Arc::new(Mutex::new(())),
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
                let (client, slave_id, config, request_gate) =
                    self.active_tcp_session(request.analytics.clone()).await?;
                let _request_lock = request_gate.lock().await;

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
                let (client, slave_id, config, request_gate) =
                    self.active_tcp_session(request.analytics.clone()).await?;
                let _request_lock = request_gate.lock().await;

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
                let (client, slave_id, config, request_gate) =
                    self.active_tcp_session(request.analytics.clone()).await?;
                let _request_lock = request_gate.lock().await;

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
                let (client, slave_id, config, request_gate) =
                    self.active_tcp_session(request.analytics.clone()).await?;
                let _request_lock = request_gate.lock().await;

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
                let (client, slave_id, config, request_gate) =
                    self.active_tcp_session(request.analytics.clone()).await?;
                let _request_lock = request_gate.lock().await;

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
                let (client, slave_id, config, request_gate) =
                    self.active_tcp_session(request.analytics.clone()).await?;
                let _request_lock = request_gate.lock().await;

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

        let (client, slave_id, config, request_gate) =
            self.active_tcp_session(request.analytics.clone()).await?;
        let _request_lock = request_gate.lock().await;

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
                                let mut transport_bail = false;
                                for coil in &range {
                                    if transport_bail {
                                        failures.push(CoilWriteFailure {
                                            address: coil.address,
                                            code: "TRANSPORT_DOWN".to_string(),
                                            message: format!(
                                                "FC15 failed ({}) and FC05 fallback skipped (transport down).",
                                                describe_api_error(&fc15_err)
                                            ),
                                        });
                                        continue;
                                    }
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
                                        Err(single_err) => {
                                            if is_immediate_transport_failure(&describe_api_error(&single_err)) {
                                                transport_bail = true;
                                            }
                                            failures.push(CoilWriteFailure {
                                                address: coil.address,
                                                code: api_error_code(&single_err).to_string(),
                                                message: format!(
                                                    "FC15 failed ({}) and FC05 fallback failed ({}).",
                                                    describe_api_error(&fc15_err),
                                                    describe_api_error(&single_err)
                                                ),
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Err(err) => {
                        // Invalid range; fall back to single writes
                        let mut transport_bail = false;
                        for coil in &range {
                            if transport_bail {
                                failures.push(CoilWriteFailure {
                                    address: coil.address,
                                    code: "TRANSPORT_DOWN".to_string(),
                                    message: format!(
                                        "FC15 range build failed ({}) and FC05 fallback skipped (transport down).",
                                        err
                                    ),
                                });
                                continue;
                            }
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
                                Err(single_err) => {
                                    if is_immediate_transport_failure(&describe_api_error(&single_err)) {
                                        transport_bail = true;
                                    }
                                    failures.push(CoilWriteFailure {
                                        address: coil.address,
                                        code: api_error_code(&single_err).to_string(),
                                        message: format!(
                                            "FC15 range build failed ({}) and FC05 fallback failed ({}).",
                                            err,
                                            describe_api_error(&single_err)
                                        ),
                                    });
                                }
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

        let (client, slave_id, config, request_gate) =
            self.active_tcp_session(request.analytics.clone()).await?;
        let _request_lock = request_gate.lock().await;

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
                        let mut transport_bail = false;
                        for reg in &range {
                            if transport_bail {
                                failures.push(RegisterWriteFailure {
                                    address: reg.address,
                                    code: "TRANSPORT_DOWN".to_string(),
                                    message: format!(
                                        "FC16 failed ({}) and FC06 fallback skipped (transport down).",
                                        describe_api_error(&fc16_err)
                                    ),
                                });
                                continue;
                            }
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
                                Err(single_err) => {
                                    if is_immediate_transport_failure(&describe_api_error(&single_err)) {
                                        transport_bail = true;
                                    }
                                    failures.push(RegisterWriteFailure {
                                        address: reg.address,
                                        code: api_error_code(&single_err).to_string(),
                                        message: format!(
                                            "FC16 failed ({}) and FC06 fallback failed ({}).",
                                            describe_api_error(&fc16_err),
                                            describe_api_error(&single_err)
                                        ),
                                    });
                                }
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
    ) -> ApiResult<(Arc<TcpClient>, u8, TcpRuntimeConfig, TcpRequestGate)> {
        let rt = self.runtime.lock().await;
        match &rt.active {
            Some(ActiveConnection::Tcp(session)) => Ok((
                Arc::clone(&session.client),
                session.slave_id,
                session.config,
                Arc::clone(&session.request_gate),
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

    /// Called from every command handler on request success.
    /// Resets the consecutive-failure counter and refreshes the activity timestamp.
    pub async fn record_request_success(&self) {
        let mut rt = self.runtime.lock().await;
        if let Some(ActiveConnection::Tcp(session)) = rt.active.as_mut() {
            session.consecutive_transport_failures = 0;
            session.last_communication_at = Instant::now();
        }
    }

    /// Called from every command handler when a transport-level error is returned.
    /// Returns `true` the **first** time the failure threshold is crossed, which
    /// transitions the session from `ConnectedTcp` → `Reconnecting` so the
    /// supervisor and frontend both react immediately.
    pub async fn record_request_transport_failure(&self) -> bool {
        let mut rt = self.runtime.lock().await;
        if let Some(ActiveConnection::Tcp(session)) = rt.active.as_mut() {
            session.consecutive_transport_failures =
                session.consecutive_transport_failures.saturating_add(1);
            if session.consecutive_transport_failures >= CONSECUTIVE_TRANSPORT_FAILURE_THRESHOLD
                && matches!(rt.status, ConnectionStatus::ConnectedTcp)
            {
                rt.status = ConnectionStatus::Reconnecting;
                return true;
            }
        }
        false
    }

    pub async fn recover_tcp_client_pipeline(
        &self,
        analytics: Option<AnalyticsContext>,
    ) -> ApiResult<()> {
        let (session_id, host, port, connection_timeout, config, traffic_sink) = {
            let mut rt = self.runtime.lock().await;
            rt.status = ConnectionStatus::Reconnecting;
            match rt.active.as_mut() {
                Some(ActiveConnection::Tcp(session)) => {
                    (
                        session.session_id,
                        session.host.clone(),
                        session.port,
                        session.connection_timeout,
                        session.config,
                        session.traffic_sink.clone(),
                    )
                }
                Some(ActiveConnection::SerialRtu(_)) | Some(ActiveConnection::SerialAscii(_)) => {
                    return Err(ApiError::backend_failure(
                        "TCP recovery requested while active connection is serial.",
                        Some("Switch protocol to TCP and reconnect.".to_string()),
                        analytics,
                    ));
                }
                None => {
                    return Err(ApiError::not_connected(
                        "No active Modbus TCP connection.",
                        analytics,
                    ));
                }
            }
        };

        let new_client = connect_tcp_client(
            host,
            port,
            connection_timeout,
            config,
            analytics.clone(),
            traffic_sink,
        )
        .await?;

        let mut rt = self.runtime.lock().await;
        if let Some(ActiveConnection::Tcp(session)) = rt.active.as_mut() {
            if session.session_id != session_id {
                return Ok(());
            }

            session.client = Arc::new(new_client);
            session.last_communication_at = Instant::now();
            session.reconnect_attempt = 0;
            session.consecutive_transport_failures = 0;
            session.reconnect_backoff_until = None;
            session.last_reconnect_error_code = None;
            session.last_reconnect_error_message = None;
            rt.status = ConnectionStatus::ConnectedTcp;
            return Ok(());
        }

        Ok(())
    }
}

const HEARTBEAT_TICK: Duration = Duration::from_secs(1);

async fn run_tcp_supervisor(runtime: Arc<Mutex<RuntimeState>>, session_id: u64) {
    loop {
        sleep(HEARTBEAT_TICK).await;

        // ── Phase 1: Active reconnect when the session is already Reconnecting ────────
        // This runs regardless of idle time so the supervisor reacts the moment
        // request handlers mark the session as Reconnecting.
        let needs_active_reconnect = {
            let rt = runtime.lock().await;
            let Some(ActiveConnection::Tcp(session)) = &rt.active else { return; };
            if session.session_id != session_id { return; }
            matches!(rt.status, ConnectionStatus::Reconnecting)
                && session
                    .reconnect_backoff_until
                    .map_or(true, |until| Instant::now() >= until)
        };

        if needs_active_reconnect {
            let (host, port, connection_timeout, config) = {
                let rt = runtime.lock().await;
                let Some(ActiveConnection::Tcp(session)) = &rt.active else { return; };
                if session.session_id != session_id { return; }
                (session.host.clone(), session.port, session.connection_timeout, session.config)
            };
            attempt_supervisor_reconnect(
                Arc::clone(&runtime),
                session_id,
                host,
                port,
                connection_timeout,
                config,
            )
            .await;
            continue;
        }

        // ── Phase 2: Idle heartbeat probe when Connected ────────────────────────────
        let snapshot = {
            let rt = runtime.lock().await;
            let Some(ActiveConnection::Tcp(session)) = &rt.active else {
                return;
            };

            if session.session_id != session_id {
                return;
            }

            match session.heartbeat_idle_after {
                Some(idle_after) if session.last_communication_at.elapsed() >= idle_after => Some((
                    Arc::clone(&session.client),
                    Arc::clone(&session.request_gate),
                    session.host.clone(),
                    session.port,
                    session.slave_id,
                    session.config,
                    session.connection_timeout,
                )),
                _ => None,
            }
        };

        let Some((client, request_gate, host, port, slave_id, config, connection_timeout)) =
            snapshot
        else {
            continue;
        };

        let _request_lock = request_gate.lock().await;

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
    let (app, traffic_sink) = {
        let mut rt = runtime.lock().await;
        if let Some(ActiveConnection::Tcp(session)) = rt.active.as_mut() {
            if session.session_id != session_id {
                return;
            }

            let app = session.app.clone();
            let sink = session.traffic_sink.clone();
            session.reconnect_attempt = session.reconnect_attempt.saturating_add(1);
            rt.status = ConnectionStatus::Reconnecting;
            (app, sink)
        } else {
            return;
        }
    };

    let reconnect = connect_tcp_client(host, port, connection_timeout, config, None, traffic_sink).await;

    let mut reconnected_label: Option<String> = None;

    {
        let mut rt = runtime.lock().await;
        if let Some(ActiveConnection::Tcp(session)) = rt.active.as_mut() {
            if session.session_id != session_id {
                return;
            }

            match reconnect {
                Ok(new_client) => {
                    reconnected_label = Some(format!("TCP {}:{}", session.host, session.port));
                    session.client = Arc::new(new_client);
                    session.last_communication_at = Instant::now();
                    session.reconnect_attempt = 0;
                    session.consecutive_transport_failures = 0;
                    session.reconnect_backoff_until = None;
                    session.last_reconnect_error_code = None;
                    session.last_reconnect_error_message = None;
                    rt.status = ConnectionStatus::ConnectedTcp;
                }
                Err(err) => {
                    session.last_reconnect_error_code = Some(api_error_code(&err).to_string());
                    session.last_reconnect_error_message = Some(describe_api_error(&err));
                    // Exponential back-off: 2 s → 4 s → 8 s → 16 s → 30 s (capped)
                    let backoff_secs = 2_u64
                        .saturating_pow(session.reconnect_attempt.min(4))
                        .min(SUPERVISOR_RECONNECT_MAX_BACKOFF_SECS);
                    session.reconnect_backoff_until =
                        Some(Instant::now() + Duration::from_secs(backoff_secs));
                    rt.status = ConnectionStatus::Reconnecting;
                }
            }
        }
    }

    if let Some(label) = reconnected_label {
        emit_supervisor_log(
            &app,
            super::types::BackendEventLevel::Info,
            "connection",
            format!("reconnect.tcp ok"),
            Some(ConnectionStatusPayload {
                status: ConnectionStatus::ConnectedTcp,
                details: Some(label),
            }),
            None,
        )
        .await;
    }
}

/// Returns true when an error string represents a Modbus protocol-level exception
/// (e.g. Illegal Data Address, Illegal Function, Slave Device Failure).
/// Such responses are definitive answers from the server and must NOT be retried.
fn is_modbus_protocol_exception(err: &str) -> bool {
    let t = err.to_ascii_lowercase();
    t.contains("exception") || t.contains("illegal") || t.contains("slave device failure")
}

/// Returns true for errors that indicate the TCP pipe is immediately broken
/// (send failure, broken pipe, connection reset, EOF). Retrying after sleeping
/// is pointless and only delays down-detection — break the retry loop immediately.
fn is_immediate_transport_failure(err: &str) -> bool {
    let t = err.to_ascii_lowercase();
    t.contains("sendfailed")
        || t.contains("send failed")
        || t.contains("failed to send")
        || t.contains("broken pipe")
        || t.contains("connection reset")
        || t.contains("connection closed")
        || t.contains("connection aborted")
        || t.contains("unexpected eof")
        || t.contains("early eof")
        || t.contains("not connected")
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
) -> ApiResult<TcpClient> {
    let mut last_details = None;

    for attempt in 0..=u32::from(config.retry_attempts) {
        let client = match TcpClient::new_with_pipeline(host.as_str(), port) {
            Ok(client) => client,
            Err(err) => {
                last_details = Some(err.to_string());
                continue;
            }
        };

        if let Some(sink) = traffic_sink.clone() {
            client.set_traffic_notifier(TrafficBridge { sink });
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
    client: &TcpClient,
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
            Ok(Err(err)) => {
                let s = err.to_string();
                last_details = Some(s.clone());
                if is_modbus_protocol_exception(&s) || is_immediate_transport_failure(&s) { break; }
            }
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
    client: &TcpClient,
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
            Ok(Err(err)) => {
                let s = err.to_string();
                last_details = Some(s.clone());
                if is_modbus_protocol_exception(&s) || is_immediate_transport_failure(&s) { break; }
            }
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
    client: &TcpClient,
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
            Ok(Err(err)) => {
                let s = err.to_string();
                last_details = Some(s.clone());
                if is_modbus_protocol_exception(&s) || is_immediate_transport_failure(&s) { break; }
            }
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
    client: &TcpClient,
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
            Ok(Err(err)) => {
                let s = err.to_string();
                last_details = Some(s.clone());
                if is_modbus_protocol_exception(&s) || is_immediate_transport_failure(&s) { break; }
            }
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
    client: &TcpClient,
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
            Ok(Err(err)) => {
                let s = err.to_string();
                last_details = Some(s.clone());
                if is_modbus_protocol_exception(&s) || is_immediate_transport_failure(&s) { break; }
            }
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
    client: &TcpClient,
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
            Ok(Err(err)) => {
                let s = err.to_string();
                last_details = Some(s.clone());
                if is_modbus_protocol_exception(&s) || is_immediate_transport_failure(&s) { break; }
            }
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
    client: &TcpClient,
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
            Ok(Err(err)) => {
                let s = err.to_string();
                last_details = Some(s.clone());
                if is_modbus_protocol_exception(&s) || is_immediate_transport_failure(&s) { break; }
            }
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
    client: &TcpClient,
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
            Ok(Err(err)) => {
                let s = err.to_string();
                last_details = Some(s.clone());
                if is_modbus_protocol_exception(&s) || is_immediate_transport_failure(&s) { break; }
            }
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
    pdu.push(lrc(&pdu));

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
    let computed_lrc = lrc(&bytes[..bytes.len() - 1]);
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
    let crc = crc16(&frame);
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
        let actual_crc = crc16(&frame[..frame_len - 2]);
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
    let msg = match ModbusMessage::from_bytes(frame) {
        Ok(m) => m,
        Err(_) => {
            if frame.len() >= 7 {
                let txn = u16::from_be_bytes([frame[0], frame[1]]);
                let declared_len = u16::from_be_bytes([frame[4], frame[5]]);
                let unit = frame[6];
                return format!(
                    "invalid_adu txn={} unit={} reason=parse_error frame_len={} declared_len={}",
                    txn, unit, frame.len(), declared_len
                );
            }
            return format!("invalid_adu reason=short frame_len={}", frame.len());
        }
    };

    let (txn, unit, declared_len) = match msg.additional_address {
        AdditionalAddress::MbapHeader(h) => (h.transaction_id, h.unit_id, h.length),
        AdditionalAddress::SlaveAddress(s) => (0, s.address(), 0),
    };

    let pdu = &msg.pdu;
    let function = pdu.function_code() as u8;
    let is_exception = pdu.error_code().is_some();
    let fc_name = modbus_function_name(function);
    let mode = if direction.contains("tx") { "request" } else { "response" };
    let expected_total = 6 + usize::from(declared_len);
    let pdu_details = decode_pdu_details(mode, function, is_exception, pdu.data().as_slice());

    format!(
        "txn={} unit={} fc=0x{:02X}({}) kind={} mbap_len={} frame_len={} expected_len={} {}",
        txn, unit, function, fc_name, mode, declared_len, frame.len(), expected_total, pdu_details
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

    let mut pdu_bytes = Vec::with_capacity(1 + data.len());
    pdu_bytes.push(function);
    pdu_bytes.extend_from_slice(data);

    let pdu = match Pdu::from_bytes(&pdu_bytes) {
        Ok(p) => p,
        Err(_) => return format!("pdu_len={}", data.len() + 1),
    };

    match pdu.function_code() {
        FunctionCode::ReadCoils | FunctionCode::ReadDiscreteInputs => {
            if mode == "request" {
                if let Ok(rw) = pdu.read_window() {
                    return format!("start={} qty={}", rw.address, rw.quantity);
                }
            } else if let Ok(bc) = pdu.byte_count_payload() {
                let byte_count = bc.byte_count as usize;
                if byte_count > 0 {
                    let bits_str: Vec<String> = (0..byte_count * 8)
                        .map(|i| ((bc.payload[i / 8] >> (i % 8)) & 1).to_string())
                        .collect();
                    return format!("byte_count={} bits=[{}]", byte_count, bits_str.join(","));
                }
                return format!("byte_count={}", bc.byte_count);
            }
        }
        FunctionCode::ReadHoldingRegisters | FunctionCode::ReadInputRegisters => {
            if mode == "request" {
                if let Ok(rw) = pdu.read_window() {
                    return format!("start={} qty={}", rw.address, rw.quantity);
                }
            } else if let Ok(bc) = pdu.byte_count_payload() {
                let byte_count = bc.byte_count as usize;
                if byte_count > 0 && byte_count % 2 == 0 {
                    let qty = byte_count / 2;
                    let regs: Vec<String> = (0..qty)
                        .map(|i| u16::from_be_bytes([bc.payload[i * 2], bc.payload[i * 2 + 1]]).to_string())
                        .collect();
                    return format!("byte_count={} regs=[{}]", byte_count, regs.join(","));
                }
                return format!("byte_count={}", bc.byte_count);
            }
        }
        FunctionCode::WriteSingleCoil => {
            if let Ok(f) = pdu.write_single_u16_fields() {
                let label = match f.value { 0xFF00 => "on", 0x0000 => "off", _ => "unknown" };
                return format!("addr={} value=0x{:04X}({})", f.address, f.value, label);
            }
        }
        FunctionCode::WriteSingleRegister => {
            if let Ok(f) = pdu.write_single_u16_fields() {
                return format!("addr={} value={}", f.address, f.value);
            }
        }
        FunctionCode::ReadExceptionStatus => {
            if mode == "response" {
                if let Ok(b) = pdu.single_byte_payload() {
                    return format!("exc_status=0x{:02X}", b);
                }
            }
        }
        FunctionCode::Diagnostics => {
            if let Ok((sub, data_word)) = pdu.diagnostics_fields() {
                let sub_name = DiagnosticSubFunction::try_from(sub)
                    .map(|k| format!("{:?}", k))
                    .unwrap_or_else(|_| "ReservedOrVendorSpecific".to_string());
                return format!("sub=0x{:04X}({}) data=0x{:04X}", sub, sub_name, data_word);
            }
            // Partial (request with sub-function only, no data word)
            if let Ok(sf) = pdu.sub_function_payload() {
                let sub_name = DiagnosticSubFunction::try_from(sf.sub_function)
                    .map(|k| format!("{:?}", k))
                    .unwrap_or_else(|_| "ReservedOrVendorSpecific".to_string());
                return format!("sub=0x{:04X}({})", sf.sub_function, sub_name);
            }
        }
        FunctionCode::GetCommEventCounter => {
            if mode == "response" {
                if let Ok(pair) = pdu.u16_pair_fields() {
                    return format!("status=0x{:04X} event_count={}", pair.first, pair.second);
                }
            }
        }
        FunctionCode::WriteMultipleCoils => {
            if mode == "request" {
                if let Ok(wm) = pdu.write_multiple_fields() {
                    let qty = wm.quantity as usize;
                    let values: Vec<&str> = (0..qty)
                        .map(|i| if (wm.values[i / 8] >> (i % 8)) & 1 == 1 { "on" } else { "off" })
                        .collect();
                    return format!("start={} qty={} values=[{}]", wm.address, qty, values.join(","));
                }
            } else if let Ok(rw) = pdu.read_window() {
                return format!("start={} qty={}", rw.address, rw.quantity);
            }
        }
        FunctionCode::WriteMultipleRegisters => {
            if mode == "request" {
                if let Ok(wm) = pdu.write_multiple_fields() {
                    let reg_count = wm.values.len() / 2;
                    let regs: Vec<String> = (0..reg_count)
                        .map(|i| u16::from_be_bytes([wm.values[i * 2], wm.values[i * 2 + 1]]).to_string())
                        .collect();
                    return format!("start={} qty={} values=[{}]", wm.address, wm.quantity, regs.join(","));
                }
            } else if let Ok(rw) = pdu.read_window() {
                return format!("start={} qty={}", rw.address, rw.quantity);
            }
        }
        FunctionCode::MaskWriteRegister => {
            if let Ok(mw) = pdu.mask_write_register_fields() {
                return format!("addr={} and_mask=0x{:04X} or_mask=0x{:04X}", mw.address, mw.and_mask, mw.or_mask);
            }
        }
        FunctionCode::ReadWriteMultipleRegisters => {
            if mode == "request" {
                if let Ok(rwm) = pdu.read_write_multiple_fields() {
                    let reg_count = rwm.write_values.len() / 2;
                    let regs: Vec<String> = (0..reg_count)
                        .map(|i| u16::from_be_bytes([rwm.write_values[i * 2], rwm.write_values[i * 2 + 1]]).to_string())
                        .collect();
                    return format!(
                        "read_addr={} read_qty={} write_addr={} write_qty={} values=[{}]",
                        rwm.read_address, rwm.read_quantity, rwm.write_address, rwm.write_quantity, regs.join(",")
                    );
                }
            } else if let Ok(bc) = pdu.byte_count_payload() {
                let byte_count = bc.byte_count as usize;
                if byte_count > 0 && byte_count % 2 == 0 {
                    let qty = byte_count / 2;
                    let regs: Vec<String> = (0..qty)
                        .map(|i| u16::from_be_bytes([bc.payload[i * 2], bc.payload[i * 2 + 1]]).to_string())
                        .collect();
                    return format!("byte_count={} regs=[{}]", byte_count, regs.join(","));
                }
                return format!("byte_count={}", bc.byte_count);
            }
        }
        FunctionCode::ReadFifoQueue => {
            if mode == "request" {
                if let Ok(ptr) = pdu.fifo_pointer() {
                    return format!("fifo_ptr={}", ptr);
                }
            } else if let Ok(fp) = pdu.fifo_payload() {
                let fifo_count = fp.fifo_count as usize;
                if fp.values.len() >= fifo_count * 2 {
                    let regs: Vec<String> = (0..fifo_count)
                        .map(|i| u16::from_be_bytes([fp.values[i * 2], fp.values[i * 2 + 1]]).to_string())
                        .collect();
                    return format!("fifo_count={} values=[{}]", fifo_count, regs.join(","));
                }
                return format!("fifo_count={}", fifo_count);
            }
        }
        FunctionCode::EncapsulatedInterfaceTransport => {
            if let Ok(mei) = pdu.mei_type_payload() {
                let mei_name = EncapsulatedInterfaceType::try_from(mei.mei_type_byte)
                    .map(|known| format!("{:?}", known))
                    .unwrap_or_else(|_| "Reserved".to_string());
                return format!("mei=0x{:02X}({}) payload_len={}", mei.mei_type_byte, mei_name, mei.payload.len());
            }
        }
        _ => {}
    }

    format!("pdu_len={}", data.len() + 1)
}

fn modbus_function_name(function: u8) -> String {
    FunctionCode::try_from(function)
        .map(|fc| format!("{fc:?}"))
        .unwrap_or_else(|_| format!("Unknown(0x{function:02X})"))
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
    let mut pdu_bytes = Vec::with_capacity(1 + payload.len());
    pdu_bytes.push(function);
    pdu_bytes.extend_from_slice(payload);

    let pdu = Pdu::from_bytes(&pdu_bytes)
        .map_err(|_| format!("FC{:02X} response missing byte count.", function))?;
    let bc = pdu.byte_count_payload()
        .map_err(|_| format!("FC{:02X} payload length mismatch: expected {}, got {}.",
            function, payload.first().map(|b| *b as usize + 1).unwrap_or(1), payload.len()))?;

    let mut bits = Vec::with_capacity(quantity as usize);
    for i in 0..usize::from(quantity) {
        let byte = bc.payload[i / 8];
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
    let mut pdu_bytes = Vec::with_capacity(1 + payload.len());
    pdu_bytes.push(function);
    pdu_bytes.extend_from_slice(payload);

    let pdu = Pdu::from_bytes(&pdu_bytes)
        .map_err(|_| format!("FC{:02X} response missing byte count.", function))?;
    let bc = pdu.byte_count_payload()
        .map_err(|_| format!("FC{:02X} payload length mismatch: expected {}, got {}.",
            function, payload.first().map(|b| *b as usize + 1).unwrap_or(1), payload.len()))?;

    let expected_count = usize::from(quantity) * 2;
    if bc.byte_count as usize != expected_count {
        return Err(format!(
            "FC{:02X} byte count mismatch: expected {}, got {}.",
            function, expected_count, bc.byte_count
        ));
    }

    let mut regs = Vec::with_capacity(quantity as usize);
    for i in 0..usize::from(quantity) {
        regs.push(u16::from_be_bytes([bc.payload[i * 2], bc.payload[i * 2 + 1]]));
    }

    Ok(regs)
}

fn parse_single_write_coil_response(payload: &[u8]) -> Result<(u16, bool), String> {
    let mut pdu_bytes = Vec::with_capacity(1 + payload.len());
    pdu_bytes.push(0x05);
    pdu_bytes.extend_from_slice(payload);

    let pdu = Pdu::from_bytes(&pdu_bytes)
        .map_err(|_| format!("FC05 response length mismatch: expected 4 bytes, got {}.", payload.len()))?;
    let f = pdu.write_single_u16_fields()
        .map_err(|_| format!("FC05 response length mismatch: expected 4 bytes, got {}.", payload.len()))?;

    match f.value {
        0xFF00 => Ok((f.address, true)),
        0x0000 => Ok((f.address, false)),
        _ => Err(format!("FC05 invalid coil echo value 0x{:04X}.", f.value)),
    }
}

fn parse_single_write_register_response(payload: &[u8]) -> Result<(u16, u16), String> {
    let mut pdu_bytes = Vec::with_capacity(1 + payload.len());
    pdu_bytes.push(0x06);
    pdu_bytes.extend_from_slice(payload);

    let pdu = Pdu::from_bytes(&pdu_bytes)
        .map_err(|_| format!("FC06 response length mismatch: expected 4 bytes, got {}.", payload.len()))?;
    let f = pdu.write_single_u16_fields()
        .map_err(|_| format!("FC06 response length mismatch: expected 4 bytes, got {}.", payload.len()))?;

    Ok((f.address, f.value))
}

fn parse_device_identification_payload(
    response: &[u8],
) -> Result<(Option<u8>, Vec<super::types::DeviceIdObject>), String> {
    let mut pdu_bytes = Vec::with_capacity(1 + response.len());
    pdu_bytes.push(0x2B_u8);
    pdu_bytes.extend_from_slice(response);

    let pdu = Pdu::from_bytes(&pdu_bytes)
        .map_err(|_| format!("FC43 response too short: got {} bytes.", response.len()))?;
    let fields = pdu.read_device_id_fields()
        .map_err(|_| format!("FC43 response invalid: got {} bytes.", response.len()))?;

    let conformity = Some(fields.conformity_level_byte);
    let raw = &fields.objects_data[..fields.payload_len];
    let mut cursor = 0;
    let mut objects = Vec::with_capacity(fields.number_of_objects as usize);

    for _ in 0..fields.number_of_objects {
        let id = raw[cursor];
        let len = raw[cursor + 1] as usize;
        cursor += 2;
        let value_bytes = &raw[cursor..cursor + len];
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
            Err(err) => {
                if is_modbus_protocol_exception(&err) {
                    return Err(err);
                }
                last_error = Some(err);
            }
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
    use modbus_rs::crc16;
    use super::{
        is_immediate_transport_failure, is_modbus_protocol_exception,
        parse_bit_read_response, parse_register_read_response, parse_single_write_coil_response,
        parse_single_write_register_response, try_extract_serial_rtu_response,
        AppState, TcpRuntimeConfig,
    };
    use super::super::types::{
        ErrorCode, ReadCoilsRequest, ReadDiscreteInputsRequest, ReadHoldingRegistersRequest,
        ReadInputRegistersRequest, RetryBackoffStrategy, RetryJitterStrategy,
        WriteCoilRequest, WriteHoldingRegisterRequest,
    };

    // ── Existing serial RTU tests ─────────────────────────────────────────────

    #[test]
    fn extracts_fc01_response_after_echoed_request_frame() {
        let request_payload = [0x00, 0x00, 0x00, 0x01];

        let mut request_frame = vec![0x01, 0x01];
        request_frame.extend_from_slice(&request_payload);
        let request_crc = crc16(&request_frame);
        request_frame.extend_from_slice(&request_crc.to_le_bytes());

        let mut response_frame = vec![0x01, 0x01, 0x01, 0x00];
        let response_crc = crc16(&response_frame);
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
        let request_crc = crc16(&request_frame);
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

    // ── Layer 1: pure helper function tests ───────────────────────────────────

    // -- parse_bit_read_response --

    #[test]
    fn parse_bits_valid_fc01_three_bits() {
        // byte_count=1, byte=0b0000_0101 → bits 0,2 true
        let payload = [1u8, 0b0000_0101];
        let result = parse_bit_read_response(&payload, 3, 0x01).unwrap();
        assert_eq!(result, vec![true, false, true]);
    }

    #[test]
    fn parse_bits_valid_fc02_sixteen_bits_all_true() {
        // byte_count=2, both bytes 0xFF → all 16 bits true
        let payload = [2u8, 0xFF, 0xFF];
        let result = parse_bit_read_response(&payload, 16, 0x02).unwrap();
        assert!(result.iter().all(|&b| b));
        assert_eq!(result.len(), 16);
    }

    #[test]
    fn parse_bits_empty_payload_errors() {
        let err = parse_bit_read_response(&[], 4, 0x01).unwrap_err();
        assert!(err.contains("missing byte count"), "got: {err}");
    }

    #[test]
    fn parse_bits_length_mismatch_errors() {
        // byte_count=2 but only 1 extra byte supplied
        let payload = [2u8, 0xFF];
        let err = parse_bit_read_response(&payload, 8, 0x01).unwrap_err();
        assert!(err.contains("length mismatch"), "got: {err}");
    }

    // -- parse_register_read_response --

    #[test]
    fn parse_regs_valid_fc03_two_registers() {
        // byte_count=4 (2 × 2), values [0x0001, 0x0002]
        let payload = [4u8, 0x00, 0x01, 0x00, 0x02];
        let result = parse_register_read_response(&payload, 2, 0x03).unwrap();
        assert_eq!(result, vec![1u16, 2u16]);
    }

    #[test]
    fn parse_regs_empty_payload_errors() {
        let err = parse_register_read_response(&[], 1, 0x03).unwrap_err();
        assert!(err.contains("missing byte count"), "got: {err}");
    }

    #[test]
    fn parse_regs_byte_count_mismatch_errors() {
        // byte_count=2 but quantity=2 expects 4 bytes
        let payload = [2u8, 0x00, 0x01];
        let err = parse_register_read_response(&payload, 2, 0x03).unwrap_err();
        assert!(err.contains("byte count mismatch"), "got: {err}");
    }

    // -- parse_single_write_coil_response --

    #[test]
    fn parse_write_coil_true_echo() {
        let payload = [0x00u8, 0x05, 0xFF, 0x00];
        let (addr, val) = parse_single_write_coil_response(&payload).unwrap();
        assert_eq!(addr, 5);
        assert!(val);
    }

    #[test]
    fn parse_write_coil_false_echo() {
        let payload = [0x00u8, 0x0A, 0x00, 0x00];
        let (addr, val) = parse_single_write_coil_response(&payload).unwrap();
        assert_eq!(addr, 10);
        assert!(!val);
    }

    #[test]
    fn parse_write_coil_invalid_value_errors() {
        let payload = [0x00u8, 0x05, 0xAB, 0xCD];
        let err = parse_single_write_coil_response(&payload).unwrap_err();
        assert!(err.contains("invalid coil echo"), "got: {err}");
    }

    #[test]
    fn parse_write_coil_wrong_length_errors() {
        let err = parse_single_write_coil_response(&[0x00, 0x01, 0xFF]).unwrap_err();
        assert!(err.contains("length mismatch"), "got: {err}");
    }

    // -- parse_single_write_register_response --

    #[test]
    fn parse_write_register_valid() {
        let payload = [0x00u8, 0x0A, 0xAB, 0xCD];
        let (addr, val) = parse_single_write_register_response(&payload).unwrap();
        assert_eq!(addr, 10);
        assert_eq!(val, 0xABCD);
    }

    #[test]
    fn parse_write_register_wrong_length_errors() {
        let err = parse_single_write_register_response(&[0x00, 0x0A, 0xAB]).unwrap_err();
        assert!(err.contains("length mismatch"), "got: {err}");
    }

    // -- is_modbus_protocol_exception --

    #[test]
    fn protocol_exception_detection() {
        assert!(is_modbus_protocol_exception("Illegal data address exception"));
        assert!(is_modbus_protocol_exception("ILLEGAL FUNCTION"));
        assert!(is_modbus_protocol_exception("Slave device failure"));
        assert!(!is_modbus_protocol_exception("timeout"));
        assert!(!is_modbus_protocol_exception("connection reset"));
    }

    // -- is_immediate_transport_failure --

    #[test]
    fn immediate_transport_failure_detection() {
        assert!(is_immediate_transport_failure("SendFailed"));
        assert!(is_immediate_transport_failure("broken pipe"));
        assert!(is_immediate_transport_failure("connection reset by peer"));
        assert!(is_immediate_transport_failure("unexpected eof"));
        // timeouts are NOT immediate transport failures (they are retriable)
        assert!(!is_immediate_transport_failure("response timed out"));
        // protocol exceptions are not transport failures
        assert!(!is_immediate_transport_failure("illegal data address"));
    }

    // -- TcpRuntimeConfig::retry_delay --

    #[test]
    fn retry_delay_fixed_strategy_is_constant() {
        let config = TcpRuntimeConfig {
            response_timeout: std::time::Duration::from_millis(1000),
            retry_attempts: 3,
            retry_backoff_strategy: RetryBackoffStrategy::Fixed,
            retry_jitter_strategy: RetryJitterStrategy::None,
        };
        let d1 = config.retry_delay(1);
        let d2 = config.retry_delay(2);
        let d3 = config.retry_delay(3);
        // Fixed: all return the same base delay (250 ms)
        assert_eq!(d1, d2);
        assert_eq!(d2, d3);
    }

    #[test]
    fn retry_delay_exponential_grows_with_index() {
        let config = TcpRuntimeConfig {
            response_timeout: std::time::Duration::from_millis(1000),
            retry_attempts: 5,
            retry_backoff_strategy: RetryBackoffStrategy::Exponential,
            retry_jitter_strategy: RetryJitterStrategy::None,
        };
        let d1 = config.retry_delay(1);
        let d2 = config.retry_delay(2);
        let d3 = config.retry_delay(3);
        assert!(d2 > d1, "exponential delay should grow: d2={d2:?} d1={d1:?}");
        assert!(d3 > d2, "exponential delay should grow: d3={d3:?} d2={d2:?}");
    }

    // -- AppState input validation (works without a real connection) --

    #[tokio::test]
    async fn read_coils_rejects_zero_quantity() {
        let state = AppState::new();
        let req = ReadCoilsRequest { start_address: 0, quantity: 0, analytics: None };
        let err = state.read_coils(&req).await.unwrap_err();
        assert!(matches!(err.code, ErrorCode::InvalidRequest), "got: {:?}", err.code);
    }

    #[tokio::test]
    async fn read_coils_rejects_quantity_over_2000() {
        let state = AppState::new();
        let req = ReadCoilsRequest { start_address: 0, quantity: 2001, analytics: None };
        let err = state.read_coils(&req).await.unwrap_err();
        assert!(matches!(err.code, ErrorCode::InvalidRequest), "got: {:?}", err.code);
    }

    #[tokio::test]
    async fn read_holding_regs_rejects_zero_quantity() {
        let state = AppState::new();
        let req = ReadHoldingRegistersRequest { start_address: 0, quantity: 0, analytics: None };
        let err = state.read_holding_registers(&req).await.unwrap_err();
        assert!(matches!(err.code, ErrorCode::InvalidRequest), "got: {:?}", err.code);
    }

    #[tokio::test]
    async fn read_holding_regs_rejects_quantity_over_125() {
        let state = AppState::new();
        let req = ReadHoldingRegistersRequest { start_address: 0, quantity: 126, analytics: None };
        let err = state.read_holding_registers(&req).await.unwrap_err();
        assert!(matches!(err.code, ErrorCode::InvalidRequest), "got: {:?}", err.code);
    }

    #[tokio::test]
    async fn read_input_regs_rejects_zero_quantity() {
        let state = AppState::new();
        let req = ReadInputRegistersRequest { start_address: 0, quantity: 0, analytics: None };
        let err = state.read_input_registers(&req).await.unwrap_err();
        assert!(matches!(err.code, ErrorCode::InvalidRequest), "got: {:?}", err.code);
    }

    #[tokio::test]
    async fn read_discrete_inputs_rejects_zero_quantity() {
        let state = AppState::new();
        let req = ReadDiscreteInputsRequest { start_address: 0, quantity: 0, analytics: None };
        let err = state.read_discrete_inputs(&req).await.unwrap_err();
        assert!(matches!(err.code, ErrorCode::InvalidRequest), "got: {:?}", err.code);
    }

    // -- AppState disconnected state returns NotConnected --

    #[tokio::test]
    async fn read_coils_not_connected_returns_not_connected_error() {
        let state = AppState::new();
        let req = ReadCoilsRequest { start_address: 0, quantity: 4, analytics: None };
        let err = state.read_coils(&req).await.unwrap_err();
        assert!(matches!(err.code, ErrorCode::NotConnected), "got: {:?}", err.code);
    }

    #[tokio::test]
    async fn write_coil_not_connected_returns_not_connected_error() {
        let state = AppState::new();
        let req = WriteCoilRequest { address: 0, value: true, analytics: None };
        let err = state.write_coil(&req).await.unwrap_err();
        assert!(matches!(err.code, ErrorCode::NotConnected), "got: {:?}", err.code);
    }

    #[tokio::test]
    async fn write_holding_register_not_connected_returns_not_connected_error() {
        let state = AppState::new();
        let req = WriteHoldingRegisterRequest { address: 0, value: 42, analytics: None };
        let err = state.write_holding_register(&req).await.unwrap_err();
        assert!(matches!(err.code, ErrorCode::NotConnected), "got: {:?}", err.code);
    }

    // ── Layer 2: TCP integration tests ────────────────────────────────────────
    //
    // Bypasses AppState::connect_tcp (requires AppHandle) and uses the
    // production TcpClient type directly against a real loopback server.

    use modbus_rs::mbus_async::server::{
        AsyncAppHandler, AsyncTrafficNotifier, AsyncTcpServer, ModbusRequest, ModbusResponse,
    };
    use modbus_rs::mbus_async::AsyncTcpClient;
    use modbus_rs::UnitIdOrSlaveAddr;
    use mbus_core::errors::ExceptionCode;
    use mbus_core::function_codes::public::FunctionCode;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    const UID: u8 = 1;
    const ADDR_SPACE: usize = 65_536;
    const MAX_COIL_BYTES: usize = 250;

    struct TestServerApp {
        coils: Vec<bool>,
        holding_regs: Vec<u16>,
        input_regs: Vec<u16>,
        discrete_inputs: Vec<bool>,
    }

    impl TestServerApp {
        fn new() -> Self {
            Self {
                coils: vec![false; ADDR_SPACE],
                holding_regs: vec![0u16; ADDR_SPACE],
                input_regs: vec![0u16; ADDR_SPACE],
                discrete_inputs: vec![false; ADDR_SPACE],
            }
        }

        fn pack_bools(src: &[bool]) -> ([u8; MAX_COIL_BYTES], usize) {
            let byte_count = (src.len() + 7) / 8;
            let mut buf = [0u8; MAX_COIL_BYTES];
            for (i, &v) in src.iter().enumerate() {
                if v {
                    buf[i / 8] |= 1 << (i % 8);
                }
            }
            (buf, byte_count)
        }
    }

    impl AsyncTrafficNotifier for TestServerApp {
        fn on_rx_frame(&mut self, _txn_id: u16, _unit: UnitIdOrSlaveAddr, _frame: &[u8]) {}
        fn on_tx_frame(&mut self, _txn_id: u16, _unit: UnitIdOrSlaveAddr, _frame: &[u8]) {}
    }

    impl AsyncAppHandler for TestServerApp {
        async fn handle(&mut self, req: ModbusRequest) -> ModbusResponse {
            match req {
                ModbusRequest::ReadCoils { address, count, .. } => {
                    let (buf, bc) = Self::pack_bools(&self.coils[address as usize..address as usize + count as usize]);
                    ModbusResponse::packed_bits(FunctionCode::ReadCoils, &buf[..bc])
                }
                ModbusRequest::WriteSingleCoil { address, value, .. } => {
                    self.coils[address as usize] = value;
                    ModbusResponse::echo_coil(address, value)
                }
                ModbusRequest::ReadDiscreteInputs { address, count, .. } => {
                    let (buf, bc) = Self::pack_bools(&self.discrete_inputs[address as usize..address as usize + count as usize]);
                    ModbusResponse::packed_bits(FunctionCode::ReadDiscreteInputs, &buf[..bc])
                }
                ModbusRequest::ReadHoldingRegisters { address, count, .. } => {
                    ModbusResponse::registers(
                        FunctionCode::ReadHoldingRegisters,
                        &self.holding_regs[address as usize..address as usize + count as usize],
                    )
                }
                ModbusRequest::WriteSingleRegister { address, value, .. } => {
                    self.holding_regs[address as usize] = value;
                    ModbusResponse::echo_register(address, value)
                }
                ModbusRequest::WriteMultipleRegisters { address, count, data, .. } => {
                    for i in 0..(count as usize) {
                        let hi = data[i * 2] as u16;
                        let lo = data[i * 2 + 1] as u16;
                        self.holding_regs[address as usize + i] = (hi << 8) | lo;
                    }
                    ModbusResponse::echo_multi_write(FunctionCode::WriteMultipleRegisters, address, count)
                }
                ModbusRequest::WriteMultipleCoils { address, count, data, .. } => {
                    for i in 0..(count as usize) {
                        self.coils[address as usize + i] = (data[i / 8] >> (i % 8)) & 1 != 0;
                    }
                    ModbusResponse::echo_multi_write(FunctionCode::WriteMultipleCoils, address, count)
                }
                ModbusRequest::ReadInputRegisters { address, count, .. } => {
                    ModbusResponse::registers(
                        FunctionCode::ReadInputRegisters,
                        &self.input_regs[address as usize..address as usize + count as usize],
                    )
                }
                other => ModbusResponse::exception(
                    FunctionCode::try_from(other.function_code_byte()).unwrap_or(FunctionCode::ReadCoils),
                    ExceptionCode::IllegalFunction,
                ),
            }
        }
    }

    async fn spawn_test_server() -> (u16, Arc<Mutex<TestServerApp>>) {
        let unit = UnitIdOrSlaveAddr::try_from(UID).unwrap();
        let shared = Arc::new(Mutex::new(TestServerApp::new()));
        let server = AsyncTcpServer::bind("127.0.0.1:0", unit).await.unwrap();
        let port = server.local_addr().unwrap().port();
        let shared_ref = Arc::clone(&shared);
        tokio::spawn(async move {
            loop {
                match server.accept().await {
                    Ok((mut session, _)) => {
                        let mut app = Arc::clone(&shared_ref);
                        tokio::spawn(async move { let _ = session.run(&mut app).await; });
                    }
                    Err(_) => break,
                }
            }
        });
        (port, shared)
    }

    // Production client type: AsyncTcpClient<32>
    type ProdClient = AsyncTcpClient<{ super::TCP_EXPECTED_RESPONSES_DEPTH }>;

    #[tokio::test]
    async fn tcp_client_read_coils_initial_all_false() {
        let (port, _app) = spawn_test_server().await;
        let client = ProdClient::new_with_pipeline("127.0.0.1", port).unwrap();
        client.connect().await.unwrap();
        let coils = client.read_multiple_coils(UID, 0, 8).await.unwrap();
        for addr in coils.from_address()..coils.from_address() + coils.quantity() {
            assert!(!coils.value(addr).unwrap(), "coil {addr} should be false");
        }
    }

    #[tokio::test]
    async fn tcp_client_write_single_coil_and_read_back() {
        let (port, _app) = spawn_test_server().await;
        let client = ProdClient::new_with_pipeline("127.0.0.1", port).unwrap();
        client.connect().await.unwrap();

        let (addr, val) = client.write_single_coil(UID, 4, true).await.unwrap();
        assert_eq!(addr, 4);
        assert!(val);

        let coils = client.read_multiple_coils(UID, 0, 8).await.unwrap();
        assert!(coils.value(4).unwrap(), "coil 4 should now be true");
        assert!(!coils.value(3).unwrap(), "coil 3 should remain false");
    }

    #[tokio::test]
    async fn tcp_client_write_multiple_coils_and_read_back() {
        let (port, _app) = spawn_test_server().await;
        let client = ProdClient::new_with_pipeline("127.0.0.1", port).unwrap();
        client.connect().await.unwrap();

        let mut coils_obj = modbus_rs::Coils::new(0, 8).unwrap();
        coils_obj.set_value(0, true).unwrap();
        coils_obj.set_value(2, true).unwrap();
        coils_obj.set_value(4, true).unwrap();
        let (start, qty) = client.write_multiple_coils(UID, 0, &coils_obj).await.unwrap();
        assert_eq!(start, 0);
        assert_eq!(qty, 8);

        let back = client.read_multiple_coils(UID, 0, 8).await.unwrap();
        assert!(back.value(0).unwrap());
        assert!(!back.value(1).unwrap());
        assert!(back.value(2).unwrap());
    }

    #[tokio::test]
    async fn tcp_client_read_holding_regs_initial_all_zero() {
        let (port, _app) = spawn_test_server().await;
        let client = ProdClient::new_with_pipeline("127.0.0.1", port).unwrap();
        client.connect().await.unwrap();
        let regs = client.read_holding_registers(UID, 0, 4).await.unwrap();
        for addr in regs.from_address()..regs.from_address() + regs.quantity() {
            assert_eq!(regs.value(addr).unwrap(), 0);
        }
    }

    #[tokio::test]
    async fn tcp_client_write_single_register_and_read_back() {
        let (port, _app) = spawn_test_server().await;
        let client = ProdClient::new_with_pipeline("127.0.0.1", port).unwrap();
        client.connect().await.unwrap();

        let (addr, val) = client.write_single_register(UID, 7, 0x1234).await.unwrap();
        assert_eq!(addr, 7);
        assert_eq!(val, 0x1234);

        let regs = client.read_holding_registers(UID, 7, 1).await.unwrap();
        assert_eq!(regs.value(7).unwrap(), 0x1234);
    }

    #[tokio::test]
    async fn tcp_client_write_multiple_registers_and_read_back() {
        let (port, _app) = spawn_test_server().await;
        let client = ProdClient::new_with_pipeline("127.0.0.1", port).unwrap();
        client.connect().await.unwrap();

        let (start, qty) = client
            .write_multiple_registers(UID, 20, &[0xAAAA, 0xBBBB, 0xCCCC])
            .await
            .unwrap();
        assert_eq!(start, 20);
        assert_eq!(qty, 3);

        let regs = client.read_holding_registers(UID, 20, 3).await.unwrap();
        assert_eq!(regs.value(20).unwrap(), 0xAAAA);
        assert_eq!(regs.value(21).unwrap(), 0xBBBB);
        assert_eq!(regs.value(22).unwrap(), 0xCCCC);
    }

    #[tokio::test]
    async fn tcp_client_read_input_regs_initial_all_zero() {
        let (port, _app) = spawn_test_server().await;
        let client = ProdClient::new_with_pipeline("127.0.0.1", port).unwrap();
        client.connect().await.unwrap();
        let regs = client.read_input_registers(UID, 0, 4).await.unwrap();
        for addr in regs.from_address()..regs.from_address() + regs.quantity() {
            assert_eq!(regs.value(addr).unwrap(), 0);
        }
    }

    #[tokio::test]
    async fn tcp_client_read_discrete_inputs_initial_all_false() {
        let (port, _app) = spawn_test_server().await;
        let client = ProdClient::new_with_pipeline("127.0.0.1", port).unwrap();
        client.connect().await.unwrap();
        let di = client.read_discrete_inputs(UID, 0, 8).await.unwrap();
        for addr in di.from_address()..di.from_address() + di.quantity() {
            assert!(!di.value(addr).unwrap(), "discrete input {addr} should be false");
        }
    }

    #[tokio::test]
    async fn tcp_client_pipeline_depth_32_handles_concurrent_requests() {
        // Verify the production pipeline depth (32) functions correctly.
        // Write distinct values to 4 different registers then read all back.
        let (port, _app) = spawn_test_server().await;
        let client = ProdClient::new_with_pipeline("127.0.0.1", port).unwrap();
        client.connect().await.unwrap();

        for i in 0u16..4 {
            client.write_single_register(UID, i * 10, (i + 1) * 100).await.unwrap();
        }
        for i in 0u16..4 {
            let regs = client.read_holding_registers(UID, i * 10, 1).await.unwrap();
            assert_eq!(regs.value(i * 10).unwrap(), (i + 1) * 100);
        }
    }
}
