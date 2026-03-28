use serde::{Deserialize, Serialize};

pub type ApiResult<T> = Result<T, ApiError>;

pub const DEFAULT_TCP_CONNECTION_TIMEOUT_MS: u64 = 2_000;
pub const DEFAULT_TCP_RESPONSE_TIMEOUT_MS: u64 = 2_000;
pub const DEFAULT_TCP_RETRY_ATTEMPTS: u8 = 2;
pub const DEFAULT_TCP_HEARTBEAT_IDLE_AFTER_MS: u64 = 5_000;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsContext {
    pub trace_id: Option<String>,
    pub session_id: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RetryBackoffStrategy {
    Fixed,
    Linear,
    Exponential,
}

impl Default for RetryBackoffStrategy {
    fn default() -> Self {
        Self::Fixed
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RetryJitterStrategy {
    None,
    Full,
    Equal,
}

impl Default for RetryJitterStrategy {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpConnectRequest {
    pub host: String,
    pub port: u16,
    pub slave_id: u8,
    #[serde(default, alias = "timeoutMs")]
    pub connection_timeout_ms: Option<u64>,
    #[serde(default)]
    pub response_timeout_ms: Option<u64>,
    #[serde(default)]
    pub retry_attempts: Option<u8>,
    #[serde(default)]
    pub retry_backoff_strategy: Option<RetryBackoffStrategy>,
    #[serde(default)]
    pub retry_jitter_strategy: Option<RetryJitterStrategy>,
    #[serde(default)]
    pub heartbeat_idle_after_ms: Option<u64>,
    pub analytics: Option<AnalyticsContext>,
}

impl TcpConnectRequest {
    pub fn resolved_connection_timeout_ms(&self) -> u64 {
        self.connection_timeout_ms
            .unwrap_or(DEFAULT_TCP_CONNECTION_TIMEOUT_MS)
            .max(100)
    }

    pub fn resolved_response_timeout_ms(&self) -> u64 {
        self.response_timeout_ms
            .unwrap_or(DEFAULT_TCP_RESPONSE_TIMEOUT_MS)
            .max(100)
    }

    pub fn resolved_retry_attempts(&self) -> u8 {
        self.retry_attempts
            .unwrap_or(DEFAULT_TCP_RETRY_ATTEMPTS)
            .min(10)
    }

    pub fn resolved_retry_backoff_strategy(&self) -> RetryBackoffStrategy {
        self.retry_backoff_strategy.clone().unwrap_or_default()
    }

    pub fn resolved_retry_jitter_strategy(&self) -> RetryJitterStrategy {
        self.retry_jitter_strategy.clone().unwrap_or_default()
    }

    pub fn resolved_heartbeat_idle_after_ms(&self) -> u64 {
        self.heartbeat_idle_after_ms
            .unwrap_or(DEFAULT_TCP_HEARTBEAT_IDLE_AFTER_MS)
            .max(1_000)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConnectRequest {
    pub port: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub stop_bits: u8,
    pub parity: String,
    pub slave_id: u8,
    pub timeout_ms: Option<u64>,
    pub analytics: Option<AnalyticsContext>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectRequest {
    pub analytics: Option<AnalyticsContext>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Reconnecting,
    ConnectedTcp,
    ConnectedSerialRtu,
    ConnectedSerialAscii,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatusPayload {
    pub status: ConnectionStatus,
    pub details: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandAck {
    pub ok: bool,
    pub message: String,
    pub status: ConnectionStatusPayload,
    pub analytics: Option<AnalyticsContext>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidRequest,
    ConnectionConflict,
    NotImplementedYet,
    NotConnected,
    BackendFailure,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
    pub details: Option<String>,
    pub analytics: Option<AnalyticsContext>,
}

impl ApiError {
    pub fn invalid_request(message: impl Into<String>, analytics: Option<AnalyticsContext>) -> Self {
        Self {
            code: ErrorCode::InvalidRequest,
            message: message.into(),
            details: None,
            analytics,
        }
    }

    pub fn conflict(message: impl Into<String>, analytics: Option<AnalyticsContext>) -> Self {
        Self {
            code: ErrorCode::ConnectionConflict,
            message: message.into(),
            details: None,
            analytics,
        }
    }

    pub fn not_implemented(feature: impl Into<String>, analytics: Option<AnalyticsContext>) -> Self {
        let feature = feature.into();
        Self {
            code: ErrorCode::NotImplementedYet,
            message: format!("{feature} is scaffolded and will be implemented in next phase."),
            details: None,
            analytics,
        }
    }

    pub fn not_connected(message: impl Into<String>, analytics: Option<AnalyticsContext>) -> Self {
        Self {
            code: ErrorCode::NotConnected,
            message: message.into(),
            details: None,
            analytics,
        }
    }

    pub fn backend_failure(
        message: impl Into<String>,
        details: Option<String>,
        analytics: Option<AnalyticsContext>,
    ) -> Self {
        Self {
            code: ErrorCode::BackendFailure,
            message: message.into(),
            details,
            analytics,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BackendEventLevel {
    Info,
    Warn,
    Error,
    Traffic,
}

// ── Coil operation DTOs ───────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadCoilsRequest {
    pub start_address: u16,
    pub quantity: u16,
    pub analytics: Option<AnalyticsContext>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteCoilRequest {
    pub address: u16,
    pub value: bool,
    pub analytics: Option<AnalyticsContext>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoilEntry {
    pub address: u16,
    pub value: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadCoilsResponse {
    pub coils: Vec<CoilEntry>,
    pub start_address: u16,
    pub quantity: u16,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteCoilResponse {
    pub address: u16,
    pub value: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteMassCoilsRequest {
    pub coils: Vec<CoilEntry>,
    pub analytics: Option<AnalyticsContext>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoilWriteFailure {
    pub address: u16,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteMassCoilsResponse {
    pub written_count: usize,
    pub total_count: usize,
    pub failures: Vec<CoilWriteFailure>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendEvent {
    pub level: BackendEventLevel,
    pub topic: String,
    pub message: String,
    pub status: Option<ConnectionStatusPayload>,
    pub analytics: Option<AnalyticsContext>,
}
