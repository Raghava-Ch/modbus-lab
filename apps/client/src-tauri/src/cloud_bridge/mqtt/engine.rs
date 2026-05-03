//! MQTT bridge engine.
//!
//! Owns:
//!   * an `rumqttc` client + event loop running in a Tokio task,
//!   * a periodic publisher task per publish-direction mapping,
//!   * the inbound dispatcher that routes incoming MQTT messages to
//!     Modbus writes.
//!
//! All tasks honour a single shared `CancellationToken` so the engine
//! can be torn down cleanly when the user clicks "Stop" or the app
//! exits.

use std::sync::Arc;
use std::time::Duration;

use rumqttc::{AsyncClient, Event, MqttOptions, Packet, QoS};
use tauri::AppHandle;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use super::events::{emit_log, emit_status, BridgeLogLevel};
use super::state::CloudBridgeState;
use super::types::{
    BridgeError, BridgeResult, BridgeStatus, MappingDefinition, ModbusArea,
    StartBridgeRequest,
};
use crate::modbus::service::AppState as ModbusAppState;
use crate::modbus::types::{
    AnalyticsContext, ReadCoilsRequest, ReadDiscreteInputsRequest, ReadHoldingRegistersRequest,
    ReadInputRegistersRequest, WriteCoilRequest, WriteHoldingRegisterRequest,
};

/// Handle the bridge state holds onto while running. Dropping the handle
/// (via `take().stop().await`) tears down every spawned task.
pub struct EngineHandle {
    cancel: Arc<Notify>,
    /// Background tasks: event loop driver + per-mapping publishers.
    tasks: Vec<JoinHandle<()>>,
    /// Underlying MQTT client kept alive for the lifetime of the engine.
    /// Dropping it triggers an orderly disconnect from the broker.
    _client: AsyncClient,
}

impl EngineHandle {
    pub async fn stop(mut self) {
        self.cancel.notify_waiters();
        for task in self.tasks.drain(..) {
            // Best-effort: ignore JoinError (panics surface in logs already).
            let _ = task.await;
        }
    }
}

/// Maximum number of in-flight MQTT messages waiting to be sent.
const MQTT_CHANNEL_CAPACITY: usize = 64;
/// Modbus quantity for a single-address read.
const SINGLE: u16 = 1;

/// Validate the request and start the engine. Returns the handle to the
/// caller for installation into [`CloudBridgeState`].
pub async fn start(
    app: AppHandle,
    bridge_state: Arc<CloudBridgeState>,
    modbus: Arc<ModbusAppState>,
    request: StartBridgeRequest,
) -> BridgeResult<EngineHandle> {
    validate_request(&request)?;

    let StartBridgeRequest { broker, mappings } = request;
    let client_id = broker.client_id.clone();

    let mut options = MqttOptions::new(
        client_id.clone(),
        broker.host.clone(),
        broker.port,
    );
    options.set_keep_alive(Duration::from_secs(u64::from(
        broker.resolved_keep_alive_secs(),
    )));
    if let (Some(user), Some(pass)) = (broker.username.as_ref(), broker.password.as_ref()) {
        options.set_credentials(user, pass);
    }
    if broker.use_tls {
        // Build a rustls ClientConfig using the OS root certificate store.
        let mut roots = rumqttc::tokio_rustls::rustls::RootCertStore::empty();
        let native = rustls_native_certs::load_native_certs();
        for cert in native.certs {
            // Best-effort: ignore individual unparsable certs.
            let _ = roots.add(cert);
        }
        if roots.is_empty() {
            return Err(BridgeError::backend_failure(
                "TLS requested but no system root certificates were available",
            ));
        }
        let tls_config = rumqttc::tokio_rustls::rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        options.set_transport(rumqttc::Transport::tls_with_config(
            rumqttc::TlsConfiguration::Rustls(Arc::new(tls_config)),
        ));
    }

    let (client, mut event_loop) = AsyncClient::new(options, MQTT_CHANNEL_CAPACITY);

    // Subscribe to topics for subscribe-side mappings up front.
    for mapping in mappings.iter().filter(|m| m.is_subscribe()) {
        if !mapping.area.is_writable() {
            emit_log(
                &app,
                BridgeLogLevel::Warn,
                "mqtt",
                format!(
                    "subscribe mapping name=\"{}\" ignored (area {:?} is read-only)",
                    mapping.name, mapping.area
                ),
            );
            continue;
        }
        let topic = mapping.render_topic(&client_id);
        let qos = qos_from_u8(mapping.resolved_qos());
        if let Err(err) = client.subscribe(topic.clone(), qos).await {
            emit_log(
                &app,
                BridgeLogLevel::Error,
                "mqtt",
                format!("subscribe failed topic={} err={}", topic, err),
            );
        } else {
            emit_log(
                &app,
                BridgeLogLevel::Info,
                "mqtt",
                format!("subscribed topic={} qos={}", topic, mapping.resolved_qos()),
            );
        }
    }

    let cancel = Arc::new(Notify::new());

    // Event-loop driver task.
    let event_loop_task = {
        let cancel = cancel.clone();
        let app = app.clone();
        let bridge_state = bridge_state.clone();
        let modbus = modbus.clone();
        let client_for_writes = client.clone();
        let mappings = mappings.clone();
        let client_id = client_id.clone();
        tokio::spawn(async move {
            let mut last_transient_error: Option<String> = None;
            loop {
                tokio::select! {
                    biased;
                    _ = cancel.notified() => break,
                    notification = event_loop.poll() => {
                        match notification {
                            Ok(Event::Incoming(Packet::ConnAck(_))) => {
                                bridge_state.set_connected(true).await;
                                bridge_state.set_last_error(None).await;
                                emit_log(&app, BridgeLogLevel::Info, "mqtt", "broker connected");
                                let snapshot = bridge_state.snapshot().await;
                                emit_status(&app, &snapshot);
                            }
                            Ok(Event::Incoming(Packet::Publish(publish))) => {
                                handle_incoming_publish(
                                    &app,
                                    &modbus,
                                    &mappings,
                                    &client_id,
                                    &client_for_writes,
                                    &publish.topic,
                                    &publish.payload,
                                )
                                .await;
                            }
                            Ok(Event::Incoming(Packet::Disconnect)) => {
                                bridge_state.set_connected(false).await;
                                emit_log(
                                    &app,
                                    BridgeLogLevel::Warn,
                                    "mqtt",
                                    "broker disconnected (server-initiated)",
                                );
                                let snapshot = bridge_state.snapshot().await;
                                emit_status(&app, &snapshot);
                            }
                            Ok(_) => {}
                            Err(err) => {
                                let err_text = err.to_string();
                                let was_connected = bridge_state.snapshot().await.connected;
                                if was_connected {
                                    bridge_state.set_connected(false).await;
                                    let snapshot = bridge_state.snapshot().await;
                                    emit_status(&app, &snapshot);
                                }
                                if is_transient_disconnect_error(&err_text) {
                                    bridge_state.set_last_error(None).await;
                                    if last_transient_error.as_deref() != Some(err_text.as_str()) {
                                        emit_log(
                                            &app,
                                            BridgeLogLevel::Warn,
                                            "mqtt",
                                            format!("broker connection lost; reconnecting ({err_text})"),
                                        );
                                        last_transient_error = Some(err_text);
                                    }
                                } else {
                                    bridge_state
                                        .set_last_error(Some(err_text.clone()))
                                        .await;
                                    emit_log(
                                        &app,
                                        BridgeLogLevel::Error,
                                        "mqtt",
                                        format!("event loop error: {err_text}"),
                                    );
                                    last_transient_error = None;
                                }
                                // Back off briefly so we don't hot-loop on repeated DNS/auth errors.
                                tokio::time::sleep(Duration::from_millis(500)).await;
                            }
                        }
                    }
                }
            }
        })
    };

    let mut tasks: Vec<JoinHandle<()>> = vec![event_loop_task];

    // Per-mapping publish tasks.
    for mapping in mappings.iter().filter(|m| m.is_publish()).cloned() {
        let topic = mapping.render_topic(&client_id);
        let qos = qos_from_u8(mapping.resolved_qos());
        let interval = mapping.resolved_publish_interval();
        let app = app.clone();
        let modbus = modbus.clone();
        let client = client.clone();
        let cancel = cancel.clone();
        tasks.push(tokio::spawn(async move {
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            // Skip the immediate first tick so we don't blast the device on start.
            ticker.tick().await;
            loop {
                tokio::select! {
                    biased;
                    _ = cancel.notified() => break,
                    _ = ticker.tick() => {
                        run_publish_once(&app, &modbus, &client, &mapping, &topic, qos, mapping.retain).await;
                    }
                }
            }
        }));
    }

    Ok(EngineHandle {
        cancel,
        tasks,
        _client: client,
    })
}

fn validate_request(request: &StartBridgeRequest) -> BridgeResult<()> {
    if request.broker.host.trim().is_empty() {
        return Err(BridgeError::invalid_request("Broker host is required"));
    }
    if request.broker.port == 0 {
        return Err(BridgeError::invalid_request("Broker port must be > 0"));
    }
    if request.broker.client_id.trim().is_empty() {
        return Err(BridgeError::invalid_request("Client id is required"));
    }
    for m in &request.mappings {
        if m.topic.trim().is_empty() {
            return Err(BridgeError::invalid_request(format!(
                "Mapping \"{}\" is missing an MQTT topic",
                m.name
            )));
        }
        if m.qos > 2 {
            return Err(BridgeError::invalid_request(format!(
                "Mapping \"{}\" has invalid QoS {} (must be 0, 1, or 2)",
                m.name, m.qos
            )));
        }
        if m.is_subscribe() && !m.area.is_writable() {
            return Err(BridgeError::invalid_request(format!(
                "Mapping \"{}\" subscribes to a read-only Modbus area",
                m.name
            )));
        }
    }
    Ok(())
}

fn qos_from_u8(value: u8) -> QoS {
    match value {
        0 => QoS::AtMostOnce,
        1 => QoS::AtLeastOnce,
        _ => QoS::ExactlyOnce,
    }
}

async fn run_publish_once(
    app: &AppHandle,
    modbus: &ModbusAppState,
    client: &AsyncClient,
    mapping: &MappingDefinition,
    topic: &str,
    qos: QoS,
    retain: bool,
) {
    let payload = match read_modbus_value(modbus, mapping).await {
        Ok(payload) => payload,
        Err(err) => {
            emit_log(
                app,
                BridgeLogLevel::Warn,
                "mqtt",
                format!(
                    "publish skipped name=\"{}\" topic={} reason={}",
                    mapping.name, topic, err
                ),
            );
            return;
        }
    };

    match client
        .publish(topic.to_string(), qos, retain, payload.as_bytes().to_vec())
        .await
    {
        Ok(()) => {
            emit_log(
                app,
                BridgeLogLevel::Traffic,
                "mqtt",
                format!(
                    "publish ok topic={} payload={} qos={}",
                    topic,
                    payload,
                    qos as u8
                ),
            );
        }
        Err(err) => {
            emit_log(
                app,
                BridgeLogLevel::Error,
                "mqtt",
                format!("publish err topic={} msg={}", topic, err),
            );
        }
    }
}

async fn read_modbus_value(
    modbus: &ModbusAppState,
    mapping: &MappingDefinition,
) -> Result<String, String> {
    let analytics: Option<AnalyticsContext> = None;
    match mapping.area {
        ModbusArea::Coil => {
            let resp = modbus
                .read_coils(&ReadCoilsRequest {
                    start_address: mapping.address,
                    quantity: SINGLE,
                    analytics: analytics.clone(),
                })
                .await
                .map_err(|e| e.message)?;
            let value = resp.coils.first().map(|c| c.value).unwrap_or(false);
            Ok(if value { "true".to_string() } else { "false".to_string() })
        }
        ModbusArea::DiscreteInput => {
            let resp = modbus
                .read_discrete_inputs(&ReadDiscreteInputsRequest {
                    start_address: mapping.address,
                    quantity: SINGLE,
                    analytics,
                })
                .await
                .map_err(|e| e.message)?;
            let value = resp.inputs.first().map(|c| c.value).unwrap_or(false);
            Ok(if value { "true".to_string() } else { "false".to_string() })
        }
        ModbusArea::HoldingRegister => {
            let resp = modbus
                .read_holding_registers(&ReadHoldingRegistersRequest {
                    start_address: mapping.address,
                    quantity: SINGLE,
                    analytics,
                })
                .await
                .map_err(|e| e.message)?;
            let value = resp.registers.first().map(|r| r.value).unwrap_or(0);
            Ok(value.to_string())
        }
        ModbusArea::InputRegister => {
            let resp = modbus
                .read_input_registers(&ReadInputRegistersRequest {
                    start_address: mapping.address,
                    quantity: SINGLE,
                    analytics,
                })
                .await
                .map_err(|e| e.message)?;
            let value = resp.registers.first().map(|r| r.value).unwrap_or(0);
            Ok(value.to_string())
        }
    }
}

async fn handle_incoming_publish(
    app: &AppHandle,
    modbus: &ModbusAppState,
    mappings: &[MappingDefinition],
    client_id: &str,
    _client: &AsyncClient,
    topic: &str,
    payload: &[u8],
) {
    // Match on the rendered topic so user-supplied tokens are honoured.
    let Some(mapping) = mappings
        .iter()
        .find(|m| m.is_subscribe() && m.render_topic(client_id) == topic)
    else {
        emit_log(
            app,
            BridgeLogLevel::Warn,
            "mqtt",
            format!("incoming on unmapped topic={}", topic),
        );
        return;
    };

    let payload_str = match std::str::from_utf8(payload) {
        Ok(s) => s.trim().to_string(),
        Err(err) => {
            emit_log(
                app,
                BridgeLogLevel::Error,
                "mqtt",
                format!(
                    "incoming topic={} payload not utf-8: {}",
                    topic, err
                ),
            );
            return;
        }
    };

    match mapping.area {
        ModbusArea::Coil => {
            let value = match parse_bool(&payload_str) {
                Some(v) => v,
                None => {
                    emit_log(
                        app,
                        BridgeLogLevel::Warn,
                        "mqtt",
                        format!(
                            "incoming topic={} payload \"{}\" is not a boolean",
                            topic, payload_str
                        ),
                    );
                    return;
                }
            };
            let result = modbus
                .write_coil(&WriteCoilRequest {
                    address: mapping.address,
                    value,
                    analytics: None,
                })
                .await;
            match result {
                Ok(_) => emit_log(
                    app,
                    BridgeLogLevel::Traffic,
                    "mqtt",
                    format!(
                        "fc05.write ok addr={} value={} via topic={}",
                        mapping.address, value, topic
                    ),
                ),
                Err(err) => emit_log(
                    app,
                    BridgeLogLevel::Error,
                    "mqtt",
                    format!("fc05.write err addr={} msg={}", mapping.address, err.message),
                ),
            }
        }
        ModbusArea::HoldingRegister => {
            let value = match parse_u16(&payload_str) {
                Some(v) => v,
                None => {
                    emit_log(
                        app,
                        BridgeLogLevel::Warn,
                        "mqtt",
                        format!(
                            "incoming topic={} payload \"{}\" is not a 16-bit unsigned integer",
                            topic, payload_str
                        ),
                    );
                    return;
                }
            };
            let result = modbus
                .write_holding_register(&WriteHoldingRegisterRequest {
                    address: mapping.address,
                    value,
                    analytics: None,
                })
                .await;
            match result {
                Ok(_) => emit_log(
                    app,
                    BridgeLogLevel::Traffic,
                    "mqtt",
                    format!(
                        "fc06.write ok addr={} value={} via topic={}",
                        mapping.address, value, topic
                    ),
                ),
                Err(err) => emit_log(
                    app,
                    BridgeLogLevel::Error,
                    "mqtt",
                    format!("fc06.write err addr={} msg={}", mapping.address, err.message),
                ),
            }
        }
        ModbusArea::DiscreteInput | ModbusArea::InputRegister => {
            // Filtered out at validation time, but be defensive.
            emit_log(
                app,
                BridgeLogLevel::Warn,
                "mqtt",
                format!(
                    "incoming topic={} targets read-only area {:?}",
                    topic, mapping.area
                ),
            );
        }
    }
}

fn parse_bool(s: &str) -> Option<bool> {
    match s.to_ascii_lowercase().as_str() {
        "1" | "true" | "on" | "yes" => Some(true),
        "0" | "false" | "off" | "no" => Some(false),
        _ => None,
    }
}

fn parse_u16(s: &str) -> Option<u16> {
    if let Ok(value) = s.parse::<u16>() {
        return Some(value);
    }
    if let Some(rest) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        if let Ok(value) = u16::from_str_radix(rest, 16) {
            return Some(value);
        }
    }
    // Allow integer-valued floats, e.g. "42.0".
    if let Ok(f) = s.parse::<f64>() {
        if f.is_finite() && f >= 0.0 && f <= u16::MAX as f64 && f.fract() == 0.0 {
            return Some(f as u16);
        }
    }
    None
}

fn is_transient_disconnect_error(error_text: &str) -> bool {
    let normalized = error_text.to_ascii_lowercase();
    normalized.contains("connection closed by peer")
        || normalized.contains("connection reset by peer")
        || normalized.contains("broken pipe")
        || normalized.contains("connection aborted")
}

/// Public for use by `commands::stop_cloud_bridge` so the snapshot is
/// always consistent with the post-stop state.
pub fn empty_status() -> BridgeStatus {
    BridgeStatus {
        running: false,
        connected: false,
        broker: None,
        mapping_count: 0,
        last_error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::BrokerConfig;

    fn mapping(direction: super::super::types::BridgeDirection, area: ModbusArea) -> MappingDefinition {
        MappingDefinition {
            id: "id".into(),
            name: "n".into(),
            direction,
            area,
            address: 0,
            topic: "t".into(),
            qos: 0,
            retain: false,
            publish_interval_ms: None,
        }
    }

    #[test]
    fn parse_bool_handles_common_forms() {
        assert_eq!(parse_bool("true"), Some(true));
        assert_eq!(parse_bool("FALSE"), Some(false));
        assert_eq!(parse_bool("1"), Some(true));
        assert_eq!(parse_bool("0"), Some(false));
        assert_eq!(parse_bool("on"), Some(true));
        assert_eq!(parse_bool("OFF"), Some(false));
        assert_eq!(parse_bool("yes"), Some(true));
        assert_eq!(parse_bool("no"), Some(false));
        assert_eq!(parse_bool("maybe"), None);
        assert_eq!(parse_bool(""), None);
    }

    #[test]
    fn parse_u16_handles_decimal_hex_and_integer_floats() {
        assert_eq!(parse_u16("0"), Some(0));
        assert_eq!(parse_u16("65535"), Some(65535));
        assert_eq!(parse_u16("0x00FF"), Some(255));
        assert_eq!(parse_u16("0X10"), Some(16));
        assert_eq!(parse_u16("42.0"), Some(42));
        assert_eq!(parse_u16("42.5"), None);
        assert_eq!(parse_u16("65536"), None);
        assert_eq!(parse_u16("-1"), None);
        assert_eq!(parse_u16("oops"), None);
    }

    #[test]
    fn classifies_transient_disconnect_errors() {
        assert!(is_transient_disconnect_error(
            "Mqtt state: Connection closed by peer abruptly"
        ));
        assert!(is_transient_disconnect_error(
            "Mqtt state: Mqtt serialization/deserialization error: IO: Connection reset by peer (os error 54)"
        ));
        assert!(is_transient_disconnect_error("IO error: broken pipe"));
        assert!(!is_transient_disconnect_error("bad username or password"));
    }

    #[test]
    fn validate_rejects_blank_host_and_zero_port() {
        let mut req = StartBridgeRequest {
            broker: BrokerConfig {
                host: "".into(),
                port: 1883,
                client_id: "c".into(),
                username: None,
                password: None,
                keep_alive_secs: None,
                use_tls: false,
            },
            mappings: vec![],
        };
        assert!(validate_request(&req).is_err());
        req.broker.host = "h".into();
        req.broker.port = 0;
        assert!(validate_request(&req).is_err());
    }

    #[test]
    fn validate_rejects_subscribe_to_read_only_area() {
        let req = StartBridgeRequest {
            broker: BrokerConfig {
                host: "h".into(),
                port: 1883,
                client_id: "c".into(),
                username: None,
                password: None,
                keep_alive_secs: None,
                use_tls: false,
            },
            mappings: vec![mapping(
                super::super::types::BridgeDirection::Subscribe,
                ModbusArea::DiscreteInput,
            )],
        };
        assert!(validate_request(&req).is_err());
    }

    #[test]
    fn validate_accepts_publish_for_any_area() {
        let req = StartBridgeRequest {
            broker: BrokerConfig {
                host: "h".into(),
                port: 1883,
                client_id: "c".into(),
                username: None,
                password: None,
                keep_alive_secs: None,
                use_tls: false,
            },
            mappings: vec![
                mapping(
                    super::super::types::BridgeDirection::Publish,
                    ModbusArea::DiscreteInput,
                ),
                mapping(
                    super::super::types::BridgeDirection::Publish,
                    ModbusArea::InputRegister,
                ),
            ],
        };
        assert!(validate_request(&req).is_ok());
    }
}
