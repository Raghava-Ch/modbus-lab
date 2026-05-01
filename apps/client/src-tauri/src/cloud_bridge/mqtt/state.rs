//! In-memory state for the MQTT cloud bridge.
//!
//! Holds the engine handle while the bridge is running. Nothing is
//! persisted to disk in the free tier — closing the app loses the
//! current broker config and mappings.

use std::sync::Arc;

use tokio::sync::Mutex;

use super::engine::EngineHandle;
use super::types::{BridgeStatus, BrokerConfig};

#[derive(Default, Clone)]
pub struct CloudBridgeState {
    inner: Arc<Mutex<Inner>>,
}

#[derive(Default)]
struct Inner {
    handle: Option<EngineHandle>,
    /// Last broker config used to start the bridge (kept for status
    /// readbacks). Cleared on stop.
    last_broker: Option<BrokerConfig>,
    /// Cached count of mappings the running engine was started with.
    mapping_count: usize,
    /// Most recent error message, if any.
    last_error: Option<String>,
    /// Whether the engine reports a live broker session.
    connected: bool,
}

impl CloudBridgeState {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn snapshot(&self) -> BridgeStatus {
        let inner = self.inner.lock().await;
        BridgeStatus {
            running: inner.handle.is_some(),
            connected: inner.connected,
            broker: inner.last_broker.clone(),
            mapping_count: inner.mapping_count,
            last_error: inner.last_error.clone(),
        }
    }

    pub async fn is_running(&self) -> bool {
        self.inner.lock().await.handle.is_some()
    }

    pub async fn install(
        &self,
        handle: EngineHandle,
        broker: BrokerConfig,
        mapping_count: usize,
    ) {
        let mut inner = self.inner.lock().await;
        inner.handle = Some(handle);
        inner.last_broker = Some(broker);
        inner.mapping_count = mapping_count;
        inner.last_error = None;
        inner.connected = false;
    }

    pub async fn take(&self) -> Option<EngineHandle> {
        let mut inner = self.inner.lock().await;
        inner.connected = false;
        inner.handle.take()
    }

    pub async fn clear_after_stop(&self) {
        let mut inner = self.inner.lock().await;
        inner.handle = None;
        inner.last_broker = None;
        inner.mapping_count = 0;
        inner.connected = false;
    }

    pub async fn set_connected(&self, connected: bool) {
        let mut inner = self.inner.lock().await;
        inner.connected = connected;
    }

    pub async fn set_last_error(&self, error: Option<String>) {
        let mut inner = self.inner.lock().await;
        inner.last_error = error;
    }
}
