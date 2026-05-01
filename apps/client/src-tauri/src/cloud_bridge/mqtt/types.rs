//! DTOs exchanged between the Tauri frontend and the MQTT cloud bridge.
//!
//! Everything here is `Serialize`/`Deserialize` so the same shapes can be
//! invoked from the Svelte UI via `invoke()` and emitted back via Tauri
//! events.

use serde::{Deserialize, Serialize};

/// Direction of message flow for a single mapping.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BridgeDirection {
    /// Periodically read from Modbus and publish to MQTT.
    Publish,
    /// Subscribe to MQTT and write the value down to Modbus.
    Subscribe,
    /// Both: publish on poll and write on incoming message.
    Bidirectional,
}

/// Modbus address space targeted by a mapping.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModbusArea {
    Coil,
    DiscreteInput,
    HoldingRegister,
    InputRegister,
}

impl ModbusArea {
    pub fn as_topic_segment(self) -> &'static str {
        match self {
            ModbusArea::Coil => "coil",
            ModbusArea::DiscreteInput => "discrete-input",
            ModbusArea::HoldingRegister => "holding-register",
            ModbusArea::InputRegister => "input-register",
        }
    }

    /// Whether the area supports writes (only output areas do).
    pub fn is_writable(self) -> bool {
        matches!(self, ModbusArea::Coil | ModbusArea::HoldingRegister)
    }

    /// Whether the area supports reads. All four currently do.
    #[allow(dead_code)]
    pub fn is_readable(self) -> bool {
        true
    }
}

/// Broker connection settings supplied by the user. Credentials, when
/// present, live only in memory for the lifetime of the app process.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerConfig {
    pub host: String,
    pub port: u16,
    pub client_id: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    /// Keepalive in seconds (1..=3600). Defaults to 30 when omitted.
    #[serde(default)]
    pub keep_alive_secs: Option<u16>,
    /// If true, connect over TLS using the platform root certificates.
    #[serde(default)]
    pub use_tls: bool,
}

impl BrokerConfig {
    pub fn resolved_keep_alive_secs(&self) -> u16 {
        self.keep_alive_secs.unwrap_or(30).clamp(1, 3600)
    }
}

/// One Modbus ↔ MQTT mapping entry.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingDefinition {
    /// Stable client-side identifier (UUID-like).
    pub id: String,
    pub name: String,
    pub direction: BridgeDirection,
    pub area: ModbusArea,
    /// Modbus address (0..=65535).
    pub address: u16,
    /// MQTT topic. Templated tokens `{client_id}`, `{area}`, `{address}`,
    /// and `{name}` are expanded at engine start.
    pub topic: String,
    /// MQTT QoS: 0, 1, or 2.
    #[serde(default)]
    pub qos: u8,
    /// Retained-publish flag (publish direction only).
    #[serde(default)]
    pub retain: bool,
    /// Poll interval in milliseconds for publish direction.
    /// Clamped to >= 100 ms by the engine.
    #[serde(default)]
    pub publish_interval_ms: Option<u64>,
}

impl MappingDefinition {
    pub fn resolved_qos(&self) -> u8 {
        self.qos.min(2)
    }

    pub fn resolved_publish_interval(&self) -> std::time::Duration {
        let ms = self
            .publish_interval_ms
            .unwrap_or(1_000)
            .max(100);
        std::time::Duration::from_millis(ms)
    }

    /// Whether this mapping participates in the publish (Modbus → MQTT) path.
    pub fn is_publish(&self) -> bool {
        matches!(
            self.direction,
            BridgeDirection::Publish | BridgeDirection::Bidirectional
        )
    }

    /// Whether this mapping participates in the subscribe (MQTT → Modbus) path.
    pub fn is_subscribe(&self) -> bool {
        matches!(
            self.direction,
            BridgeDirection::Subscribe | BridgeDirection::Bidirectional
        )
    }

    pub fn render_topic(&self, client_id: &str) -> String {
        render_topic_template(&self.topic, client_id, self.area, self.address, &self.name)
    }
}

/// Expand template tokens in a topic string. Unknown tokens are left
/// untouched so users can carry them through to e.g. broker-side rules.
pub fn render_topic_template(
    template: &str,
    client_id: &str,
    area: ModbusArea,
    address: u16,
    name: &str,
) -> String {
    template
        .replace("{client_id}", client_id)
        .replace("{area}", area.as_topic_segment())
        .replace("{address}", &address.to_string())
        .replace("{name}", name)
}

/// Snapshot of the bridge runtime status, returned to the frontend.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub running: bool,
    pub connected: bool,
    pub broker: Option<BrokerConfig>,
    pub mapping_count: usize,
    pub last_error: Option<String>,
}

/// Errors returned to the frontend.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeError {
    pub code: BridgeErrorCode,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BridgeErrorCode {
    InvalidRequest,
    NotRunning,
    AlreadyRunning,
    BackendFailure,
}

impl BridgeError {
    pub fn invalid_request(msg: impl Into<String>) -> Self {
        Self {
            code: BridgeErrorCode::InvalidRequest,
            message: msg.into(),
        }
    }

    #[allow(dead_code)]
    pub fn not_running() -> Self {
        Self {
            code: BridgeErrorCode::NotRunning,
            message: "Cloud bridge is not running".to_string(),
        }
    }

    pub fn already_running() -> Self {
        Self {
            code: BridgeErrorCode::AlreadyRunning,
            message: "Cloud bridge is already running".to_string(),
        }
    }

    pub fn backend_failure(msg: impl Into<String>) -> Self {
        Self {
            code: BridgeErrorCode::BackendFailure,
            message: msg.into(),
        }
    }
}

pub type BridgeResult<T> = Result<T, BridgeError>;

/// Request payload to start the bridge. The frontend always sends the
/// full broker config + mapping list because nothing is persisted across
/// restarts in the free tier.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartBridgeRequest {
    pub broker: BrokerConfig,
    pub mappings: Vec<MappingDefinition>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topic_template_expands_known_tokens() {
        let rendered = render_topic_template(
            "modbus-lab/{client_id}/{area}/{address}/{name}",
            "lab-1",
            ModbusArea::HoldingRegister,
            42,
            "tank_level",
        );
        assert_eq!(
            rendered,
            "modbus-lab/lab-1/holding-register/42/tank_level"
        );
    }

    #[test]
    fn topic_template_leaves_unknown_tokens() {
        let rendered = render_topic_template(
            "{client_id}/{custom}/{address}",
            "lab-1",
            ModbusArea::Coil,
            7,
            "n",
        );
        assert_eq!(rendered, "lab-1/{custom}/7");
    }

    #[test]
    fn keep_alive_is_clamped() {
        let mut cfg = BrokerConfig {
            host: "h".into(),
            port: 1883,
            client_id: "c".into(),
            username: None,
            password: None,
            keep_alive_secs: Some(0),
            use_tls: false,
        };
        assert_eq!(cfg.resolved_keep_alive_secs(), 1);
        cfg.keep_alive_secs = Some(60_000);
        assert_eq!(cfg.resolved_keep_alive_secs(), 3600);
        cfg.keep_alive_secs = None;
        assert_eq!(cfg.resolved_keep_alive_secs(), 30);
    }

    #[test]
    fn publish_interval_is_floor_clamped() {
        let mapping = MappingDefinition {
            id: "1".into(),
            name: "n".into(),
            direction: BridgeDirection::Publish,
            area: ModbusArea::Coil,
            address: 0,
            topic: "t".into(),
            qos: 0,
            retain: false,
            publish_interval_ms: Some(10),
        };
        assert_eq!(
            mapping.resolved_publish_interval(),
            std::time::Duration::from_millis(100)
        );
    }

    #[test]
    fn area_writability_matches_modbus_semantics() {
        assert!(ModbusArea::Coil.is_writable());
        assert!(ModbusArea::HoldingRegister.is_writable());
        assert!(!ModbusArea::DiscreteInput.is_writable());
        assert!(!ModbusArea::InputRegister.is_writable());
    }

    #[test]
    fn direction_flags_round_trip() {
        let mut m = MappingDefinition {
            id: "1".into(),
            name: "n".into(),
            direction: BridgeDirection::Publish,
            area: ModbusArea::Coil,
            address: 0,
            topic: "t".into(),
            qos: 5,
            retain: false,
            publish_interval_ms: None,
        };
        assert!(m.is_publish() && !m.is_subscribe());
        assert_eq!(m.resolved_qos(), 2);

        m.direction = BridgeDirection::Subscribe;
        assert!(m.is_subscribe() && !m.is_publish());

        m.direction = BridgeDirection::Bidirectional;
        assert!(m.is_publish() && m.is_subscribe());
    }
}
