use tauri::{AppHandle, Emitter};

use super::types::{AnalyticsContext, BackendEvent, BackendEventLevel, ConnectionStatusPayload};

const EVT_BACKEND_LOG: &str = "modbus://event";

pub async fn emit_log(
    app: &AppHandle,
    level: BackendEventLevel,
    topic: impl Into<String>,
    message: impl Into<String>,
    status: Option<ConnectionStatusPayload>,
    analytics: Option<AnalyticsContext>,
) {
    let event = BackendEvent {
        level,
        topic: topic.into(),
        message: message.into(),
        status,
        analytics,
    };

    // Frontend log listeners should subscribe to this event.
    let _ = app.emit(EVT_BACKEND_LOG, &event);

    // Reserved for future analytics integration with crate API calls.
    analytics_hook(&event).await;
}

pub async fn analytics_hook(_event: &BackendEvent) {
    // No-op in this phase. Keep call-site stable for next-phase analytics integration.
}
