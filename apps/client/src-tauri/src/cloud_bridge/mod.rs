//! Cloud Bridge module.
//!
//! Forwards Modbus values to (and from) cloud message brokers. The first
//! shipping bridge is MQTT (`mqtt` submodule). Future cloud bridges
//! (e.g. AWS IoT, Azure IoT, Kafka) should live as siblings under
//! `cloud_bridge::<vendor>` so they can share none-to-some of the
//! orchestration patterns established here while remaining independent.
//!
//! Free-tier scope: every app launch is a fresh start. Broker config and
//! mappings live entirely in process memory; persistence is reserved for
//! the paid tier.

pub mod mqtt;
