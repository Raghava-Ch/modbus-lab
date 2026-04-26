/// Real Modbus TCP listener runtime using `AsyncTcpServer`.
///
/// This module manages the full lifecycle of an inbound Modbus TCP server:
/// - Binding with `AsyncTcpServer::bind()`
/// - Custom accept loop that tracks each connected client
/// - Graceful shutdown via a tokio watch channel
/// - Emitting `modbus://listener_status_changed` and `modbus://listener_clients`
///   events to the Tauri event bus on every state change
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use modbus_rs::mbus_async::server::{
    AsyncAppHandler, AsyncTcpServer, AsyncTrafficNotifier, ModbusRequest, ModbusResponse,
};
use modbus_rs::UnitIdOrSlaveAddr;
use tauri::{AppHandle, Emitter};
use tokio::sync::{watch, Mutex};

use super::events::emit_log;
use super::listener_app::ServerApp;
use super::types::{
    AnalyticsContext, ApiError, ApiResult, BackendEventLevel, ListenerClientSession,
    ListenerClientsResponse, ListenerStatusPayload,
};

// ---------------------------------------------------------------------------
// Per-session app wrapper
// ---------------------------------------------------------------------------

/// Wraps `Arc<Mutex<ServerApp>>` with a per-session traffic sink so that
/// traffic notifications actually fire.
///
/// The library's blanket `AsyncTrafficNotifier for Arc<Mutex<APP>>` is a
/// deliberate no-op.  To receive `on_rx_frame` / `on_tx_frame` callbacks we
/// must implement the trait on a concrete wrapper type that is NOT behind
/// `Arc<Mutex<…>>`.  Each TCP session creates one `SessionApp`; they all share
/// the same inner `Arc<Mutex<ServerApp>>` for data access.
struct SessionApp {
    inner: Arc<Mutex<ServerApp>>,
    traffic_sink: Option<Arc<dyn Fn(String) + Send + Sync + 'static>>,
}

impl AsyncAppHandler for SessionApp {
    fn handle(&mut self, req: ModbusRequest) -> impl std::future::Future<Output = ModbusResponse> + Send {
        let inner = self.inner.clone();
        async move { inner.lock().await.handle(req).await }
    }
}

impl AsyncTrafficNotifier for SessionApp {
    fn on_rx_frame(&mut self, _txn_id: u16, _unit: UnitIdOrSlaveAddr, frame: &[u8]) {
        if let Some(sink) = &self.traffic_sink {
            // Server *receives* a request — direction "tx" tells describe_tcp_adu_human
            // to label it kind=request (consistent with the client-side TrafficBridge).
            let adu = super::service::describe_tcp_adu_human(frame, "tx");
            let raw = super::service::format_hex_bytes(frame);
            sink(format!("srv.rx {adu} raw={raw}"));
        }
    }

    fn on_tx_frame(&mut self, _txn_id: u16, _unit: UnitIdOrSlaveAddr, frame: &[u8]) {
        if let Some(sink) = &self.traffic_sink {
            // Server *sends* a response — direction "rx" labels it kind=response.
            let adu = super::service::describe_tcp_adu_human(frame, "rx");
            let raw = super::service::format_hex_bytes(frame);
            sink(format!("srv.tx {adu} raw={raw}"));
        }
    }
}

// ---------------------------------------------------------------------------
// Public handle returned to AppState
// ---------------------------------------------------------------------------

/// Handle to a running listener.  Dropping it does NOT stop the listener;
/// call `stop()` explicitly so the accept-loop task can be cancelled cleanly.
pub struct ListenerHandle {
    /// Send `true` to signal the accept loop to exit.
    shutdown_tx: watch::Sender<bool>,
    /// Bind address (for status reporting).
    pub bind_addr: String,
    /// Unit ID the server responds to.
    pub unit_id: u8,
    /// Transport label ("tcp").
    pub transport: String,
    /// Milliseconds since UNIX epoch when the server started.
    pub started_at_ms: u64,
    /// Shared list of currently connected client sessions.
    pub sessions: Arc<Mutex<Vec<ConnectedSession>>>,
    /// The server's shared data store so UI commands can read/write registers.
    pub app: Arc<Mutex<ServerApp>>,
}

impl ListenerHandle {
    /// Signal the accept-loop task to stop and wait for it to finish.
    pub fn stop(&self) {
        // Ignore errors — receiver may already be gone if the task panicked.
        let _ = self.shutdown_tx.send(true);
    }

    /// Returns the uptime in milliseconds.
    pub fn uptime_ms(&self) -> u64 {
        now_ms().saturating_sub(self.started_at_ms)
    }
}

/// A single connected Modbus TCP client.
#[derive(Clone)]
pub struct ConnectedSession {
    pub id: String,
    pub peer: SocketAddr,
    pub connected_at_ms: u64,
}

// ---------------------------------------------------------------------------
// Start TCP listener
// ---------------------------------------------------------------------------

/// Binds `AsyncTcpServer` on `bind_addr`, spawns the accept loop, and returns
/// a `ListenerHandle`.  Emits `modbus://listener_status_changed` immediately
/// on success.
pub async fn start_tcp_listener(
    app_handle: AppHandle,
    bind_addr: String,
    unit_id: u8,
    analytics: Option<AnalyticsContext>,
) -> ApiResult<ListenerHandle> {
    let unit = UnitIdOrSlaveAddr::try_from(unit_id).map_err(|_| {
        ApiError::invalid_request(
            format!("Unit ID {unit_id} is not in the valid range 1–247."),
            analytics.clone(),
        )
    })?;

    // Build traffic sink that forwards frame events to the Tauri event bus.
    let traffic_app = app_handle.clone();
    let traffic_sink: Arc<dyn Fn(String) + Send + Sync + 'static> =
        Arc::new(move |message: String| {
            let event = super::types::BackendEvent {
                level: BackendEventLevel::Traffic,
                topic: "server".to_string(),
                message,
                status: None,
                analytics: None,
            };
            let _ = traffic_app.emit("modbus://event", &event);
        });

    // The ServerApp itself never receives traffic callbacks (the library's
    // Arc<Mutex<APP>> blanket impl is a no-op).  Traffic is handled by the
    // per-session SessionApp wrapper; ServerApp only manages the data store.
    let shared_app = Arc::new(Mutex::new(ServerApp::new(None)));

    // Bind the server socket first so we can report a useful error before
    // spawning anything.
    let server = AsyncTcpServer::bind(&bind_addr, unit)
        .await
        .map_err(|e| {
            ApiError::backend_failure(
                format!("Failed to bind Modbus TCP listener on {bind_addr}."),
                Some(format!("{e:?}")),
                analytics.clone(),
            )
        })?;

    let actual_addr = server
        .local_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| bind_addr.clone());

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let sessions: Arc<Mutex<Vec<ConnectedSession>>> = Arc::new(Mutex::new(Vec::new()));
    let started_at_ms = now_ms();

    // Spawn the custom accept loop.
    let loop_app = Arc::clone(&shared_app);
    let loop_sessions = Arc::clone(&sessions);
    let loop_handle = app_handle.clone();
    let loop_traffic_sink = Arc::clone(&traffic_sink);

    tokio::spawn(async move {
        run_accept_loop(
            server,
            loop_app,
            loop_sessions,
            loop_handle,
            shutdown_rx,
            Some(loop_traffic_sink),
        )
        .await;
    });

    let handle = ListenerHandle {
        shutdown_tx,
        bind_addr: actual_addr,
        unit_id,
        transport: "tcp".to_string(),
        started_at_ms,
        sessions,
        app: shared_app,
    };

    // Emit initial "running" status.
    emit_listener_status(&app_handle, &handle, "running", None);

    emit_log(
        &app_handle,
        BackendEventLevel::Info,
        "listener",
        format!("listener.start ok bind={} unit={unit_id}", handle.bind_addr),
        None,
        analytics,
    )
    .await;

    Ok(handle)
}

// ---------------------------------------------------------------------------
// Accept loop
// ---------------------------------------------------------------------------

async fn run_accept_loop(
    server: AsyncTcpServer,
    shared_app: Arc<Mutex<ServerApp>>,
    sessions: Arc<Mutex<Vec<ConnectedSession>>>,
    app_handle: AppHandle,
    mut shutdown_rx: watch::Receiver<bool>,
    traffic_sink: Option<Arc<dyn Fn(String) + Send + Sync + 'static>>,
) {
    let mut next_session_id: u64 = 1;

    loop {
        let accept_fut = server.accept();

        tokio::select! {
            // Shutdown signal received — exit accept loop.
            _ = shutdown_rx.changed() => {
                if *shutdown_rx.borrow() {
                    break;
                }
            }

            // New client connected.
            result = accept_fut => {
                match result {
                    Ok((mut session, peer)) => {
                        let session_id = format!("s{next_session_id}");
                        next_session_id += 1;
                        let connected_at_ms = now_ms();

                        // Register in the shared session list.
                        {
                            let mut locked = sessions.lock().await;
                            locked.push(ConnectedSession {
                                id: session_id.clone(),
                                peer,
                                connected_at_ms,
                            });
                        }

                        emit_client_sessions(&app_handle, &sessions).await;

                        // Spawn a task for this client session.
                        // Each session gets its own SessionApp that wraps the
                        // shared ServerApp and implements AsyncTrafficNotifier
                        // so that on_rx_frame / on_tx_frame actually fire.
                        // (The library's Arc<Mutex<APP>> blanket impl is a no-op.)
                        let task_app = Arc::clone(&shared_app);
                        let task_sessions = Arc::clone(&sessions);
                        let task_handle = app_handle.clone();
                        let task_id = session_id.clone();
                        let task_sink = traffic_sink.clone();

                        tokio::spawn(async move {
                            let mut session_app = SessionApp {
                                inner: task_app,
                                traffic_sink: task_sink,
                            };
                            let _ = session.run(&mut session_app).await;

                            // Remove session on disconnect.
                            {
                                let mut locked = task_sessions.lock().await;
                                locked.retain(|s| s.id != task_id);
                            }
                            emit_client_sessions(&task_handle, &task_sessions).await;
                        });
                    }
                    Err(e) => {
                        // Accept error (e.g., OS resource limit) — log and stop the loop.
                        emit_log(
                            &app_handle,
                            BackendEventLevel::Error,
                            "listener",
                            format!("listener.accept err: {e:?}"),
                            None,
                            None,
                        )
                        .await;
                        break;
                    }
                }
            }
        }
    }

    // Clear sessions and emit final stopped status.
    {
        let mut locked = sessions.lock().await;
        locked.clear();
    }
    emit_client_sessions(&app_handle, &sessions).await;

    emit_log(
        &app_handle,
        BackendEventLevel::Info,
        "listener",
        "listener.accept_loop exited",
        None,
        None,
    )
    .await;
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

/// Emits `modbus://listener_status_changed`.
pub fn emit_listener_status(
    app: &AppHandle,
    handle: &ListenerHandle,
    state: &str,
    last_error: Option<String>,
) {
    let payload = ListenerStatusPayload {
        status: state.to_string(),
        details: Some(format!(
            "{} (unit {})",
            handle.bind_addr, handle.unit_id
        )),
        transport: Some(handle.transport.clone()),
        bind_target: Some(handle.bind_addr.clone()),
        unit_id: Some(handle.unit_id),
        active_clients: 0, // caller updates via emit_client_sessions separately
        uptime_ms: Some(handle.uptime_ms()),
        last_error,
    };
    let _ = app.emit("modbus://listener_status_changed", &payload);
}

/// Emits `modbus://listener_clients` with the current session list.
async fn emit_client_sessions(app: &AppHandle, sessions: &Arc<Mutex<Vec<ConnectedSession>>>) {
    let locked = sessions.lock().await;
    let payload = ListenerClientsResponse {
        active_clients: locked.len() as u32,
        sessions: locked
            .iter()
            .map(|s| ListenerClientSession {
                id: s.id.clone(),
                endpoint: s.peer.to_string(),
                connected_at_ms: s.connected_at_ms,
            })
            .collect(),
    };
    let _ = app.emit("modbus://listener_clients", &payload);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
