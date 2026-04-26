<svelte:options runes={true} />

<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import AppShell from "./components/layout/AppShell.svelte";
  import { addLog } from "./state/logs.svelte";
  import { applyBackendConnectionStatus } from "./state/connection.svelte";
  import { notifyError, notifyInfo } from "./state/notifications.svelte";
  import { initLayoutState } from "./state/layout.svelte";
  import { initSettingsState } from "./state/settings.svelte";
  import { trackConnectionHealthEvent } from "./state/connection-health.svelte";

  let seeded = $state(false);
  let previousBackendStatus = $state<string | null>(null);
  let outageNotified = $state(false);

  interface BackendEventPayload {
    level?: "info" | "warn" | "error" | "traffic";
    topic?: string;
    message?: string;
    status?: {
      status?: string;
      details?: string;
    };
  }

  function toLogLevel(level: string | undefined): "info" | "warn" | "error" | "traffic" {
    if (level === "warn" || level === "error" || level === "traffic") {
      return level;
    }
    return "info";
  }

  function formatBackendEventMessage(payload: BackendEventPayload): string {
    const topic = payload.topic ? `[${payload.topic.toUpperCase()}] ` : "";
    const message = payload.message ?? "Backend event";

    if (payload.status?.status) {
      const statusText = payload.status.details
        ? `${payload.status.status} (${payload.status.details})`
        : payload.status.status;
      return `${topic}${message} | status=${statusText}`;
    }

    return `${topic}${message}`;
  }

  function normalizeStatus(status: string | undefined): string {
    return (status ?? "").toLowerCase();
  }

  function isConnectedStatus(status: string): boolean {
    return status.startsWith("connected") || status === "running";
  }

  function isOutageStatus(status: string): boolean {
    return status === "reconnecting" || status === "disconnected" || status === "error" || status === "idle";
  }

  function maybeNotifyServerDown(nextStatusRaw: string | undefined, details?: string): void {
    const nextStatus = normalizeStatus(nextStatusRaw);
    const previousStatus = normalizeStatus(previousBackendStatus ?? undefined);
    const droppedFromConnected = isConnectedStatus(previousStatus) && isOutageStatus(nextStatus);

    if (droppedFromConnected && !outageNotified) {
      const suffix = details?.trim() ? ` (${details})` : "";
      notifyError(`Modbus server appears to be down${suffix}`);
      outageNotified = true;
    }

    if (isConnectedStatus(nextStatus)) {
      if (outageNotified) {
        notifyInfo("Reconnected to Modbus server.");
      }
      outageNotified = false;
    }

    previousBackendStatus = nextStatus;
  }

  $effect(() => {
    if (seeded) {
      return;
    }

    seeded = true;
    console.log("[App] Initializing Modbus Lab Server...");
    addLog("info", "Modbus Lab Server shell initialized.");

    // Initialize settings and layout state
    initSettingsState();
    initLayoutState();

    let unlisten: (() => void) | undefined;
    let statusPollTimer: ReturnType<typeof setInterval> | undefined;

    const setup = async (): Promise<void> => {
      console.log("[App] Setup starting...");
      try {
        console.log("[App] Setting up event listener...");
        unlisten = await listen<BackendEventPayload>("modbus://event", (event) => {
          const payload = event.payload;
          addLog(toLogLevel(payload.level), formatBackendEventMessage(payload));
          trackConnectionHealthEvent(payload);

          if (payload.status?.status) {
            maybeNotifyServerDown(payload.status.status, payload.status.details);
            applyBackendConnectionStatus(payload.status.status, payload.status.details);
          }
        });
        console.log("[App] Event listener setup successfully");
      } catch (err) {
        console.error("[App] Failed to setup event listener:", err);
        addLog("warn", `Failed to setup event listener: ${err}`);
      }

      try {
        console.log("[App] Fetching backend status...");
        const status = await invoke<{ status: string; details?: string }>("listener_status");
        console.log("[App] Backend status received:", status);
        maybeNotifyServerDown(status.status, status.details);
        applyBackendConnectionStatus(status.status, status.details);
      } catch (err) {
        console.error("[App] Failed to fetch backend status:", err);
        addLog("warn", `Unable to fetch backend connection status: ${err}`);
      }

      console.log("[App] Starting status poll timer...");
      statusPollTimer = setInterval(() => {
        void invoke<{ status: string; details?: string }>("listener_status")
          .then((status) => {
            maybeNotifyServerDown(status.status, status.details);
            applyBackendConnectionStatus(status.status, status.details);
          })
          .catch(() => {
            // Keep polling silent
          });
      }, 1000);
    };

    console.log("[App] Calling setup...");
    void setup();

    return () => {
      console.log("[App] Cleanup called");
      if (unlisten) {
        unlisten();
      }
      if (statusPollTimer) {
        clearInterval(statusPollTimer);
      }
    };
  });
</script>

<AppShell />