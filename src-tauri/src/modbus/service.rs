use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use tokio::{
    sync::Mutex,
    task,
    time::{sleep, timeout, Duration, Instant},
};

use modbus_rs::mbus_async::AsyncTcpClient;
use modbus_rs::Coils;

use super::types::{
    AnalyticsContext, ApiError, ApiResult, CoilEntry, CoilWriteFailure, ConnectionStatus, ConnectionStatusPayload,
    ReadCoilsRequest, ReadCoilsResponse, RetryBackoffStrategy, RetryJitterStrategy,
    SerialConnectRequest, TcpConnectRequest, WriteCoilRequest, WriteCoilResponse,
    WriteMassCoilsRequest, WriteMassCoilsResponse,
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
    client: Arc<AsyncTcpClient<9>>,
}

enum ActiveConnection {
    Tcp(TcpSession),
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

    pub async fn connect_tcp(&self, request: &TcpConnectRequest) -> ApiResult<ConnectionStatusPayload> {
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
        let heartbeat_idle_after = Duration::from_millis(request.resolved_heartbeat_idle_after_ms());

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

        if let Some(ActiveConnection::Tcp(session)) = rt.active.take() {
            // Dropping AsyncTcpClient triggers worker shutdown via Drop implementation.
            drop(session.client);
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
                let base = format!("TCP {}:{} (slave {})", session.host, session.port, session.slave_id);
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

        let (client, slave_id, config) = self.active_tcp_session(request.analytics.clone()).await?;

        let coils = read_multiple_coils_with_retry(
            &client,
            slave_id,
            request.start_address,
            request.quantity,
            config,
            request.analytics.clone(),
        )
        .await?;

        let entries: Vec<CoilEntry> = (0..request.quantity)
            .map(|i| {
                let addr = request.start_address + i;
                CoilEntry {
                    address: addr,
                    value: coils.value(addr).unwrap_or(false),
                }
            })
            .collect();

        Ok(ReadCoilsResponse {
            coils: entries,
            start_address: request.start_address,
            quantity: request.quantity,
        })
    }

    pub async fn write_coil(&self, request: &WriteCoilRequest) -> ApiResult<WriteCoilResponse> {
        self.mark_tcp_activity().await;

        let (client, slave_id, config) = self.active_tcp_session(request.analytics.clone()).await?;

        let (addr, value) = write_single_coil_with_retry(
            &client,
            slave_id,
            request.address,
            request.value,
            config,
            request.analytics.clone(),
        )
        .await?;

        Ok(WriteCoilResponse { address: addr, value })
    }

    pub async fn write_coils_optimized(&self, request: &WriteMassCoilsRequest) -> ApiResult<WriteMassCoilsResponse> {
        self.mark_tcp_activity().await;

        if request.coils.is_empty() {
            return Ok(WriteMassCoilsResponse {
                written_count: 0,
                total_count: 0,
                failures: vec![],
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

    pub async fn scaffold_serial_rtu(
        &self,
        request: &SerialConnectRequest,
    ) -> ApiResult<ConnectionStatusPayload> {
        Err(ApiError::not_implemented(
            "Serial RTU connection",
            request.analytics.clone(),
        ))
    }

    pub async fn scaffold_serial_ascii(
        &self,
        request: &SerialConnectRequest,
    ) -> ApiResult<ConnectionStatusPayload> {
        Err(ApiError::not_implemented(
            "Serial ASCII connection",
            request.analytics.clone(),
        ))
    }

    async fn active_tcp_session(
        &self,
        analytics: Option<AnalyticsContext>,
    ) -> ApiResult<(Arc<AsyncTcpClient<9>>, u8, TcpRuntimeConfig)> {
        let rt = self.runtime.lock().await;
        match &rt.active {
            Some(ActiveConnection::Tcp(session)) => {
                Ok((Arc::clone(&session.client), session.slave_id, session.config))
            }
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

        let Some((client, host, port, slave_id, config, connection_timeout, _heartbeat_idle_after)) = snapshot else {
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
    {
        let mut rt = runtime.lock().await;
        if let Some(ActiveConnection::Tcp(session)) = rt.active.as_mut() {
            if session.session_id != session_id {
                return;
            }

            session.reconnect_attempt = session.reconnect_attempt.saturating_add(1);
            rt.status = ConnectionStatus::Reconnecting;
        } else {
            return;
        }
    }

    let reconnect = connect_tcp_client(host, port, connection_timeout, config, None).await;

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
) -> ApiResult<AsyncTcpClient<9>> {
    let mut last_details = None;

    for attempt in 0..=u32::from(config.retry_attempts) {
        let host_for_attempt = host.clone();
        let connect_handle = task::spawn_blocking(move || AsyncTcpClient::<9>::connect(&host_for_attempt, port));

        match timeout(connection_timeout, connect_handle).await {
            Ok(join_result) => match join_result {
                Ok(Ok(client)) => return Ok(client),
                Ok(Err(err)) => last_details = Some(err.to_string()),
                Err(err) => last_details = Some(err.to_string()),
            },
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
