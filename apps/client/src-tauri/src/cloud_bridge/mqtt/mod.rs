//! MQTT cloud bridge.
//!
//! Connects to an MQTT broker and routes messages between MQTT topics and
//! the active Modbus session. Direction per mapping: publish (Modbus →
//! MQTT), subscribe (MQTT → Modbus), or bidirectional. State is in-memory
//! only and resets on every app launch (free tier).

pub mod commands;
pub mod engine;
pub mod events;
pub mod state;
pub mod types;
