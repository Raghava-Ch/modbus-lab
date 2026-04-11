<svelte:options runes={true} />

<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import AppShell from "./components/layout/AppShell.svelte";
  import { addLog } from "./state/logs.svelte";
  import { applyBackendConnectionStatus } from "./state/connection.svelte";
  import { initLayoutState } from "./state/layout.svelte";
  import { initSettingsState } from "./state/settings.svelte";

  let seeded = $state(false);

  interface BackendEventPayload {
    level?: "info" | "warn" | "error";
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

  $effect(() => {
    if (seeded) {
      return;
    }

    seeded = true;
    console.log("[App] Initializing Modbus Lab...");
    addLog("info", "Modbus Lab shell initialized.");

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

          if (payload.status?.status) {
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
        const status = await invoke<{ status: string; details?: string }>("get_modbus_connection_status");
        console.log("[App] Backend status received:", status);
        applyBackendConnectionStatus(status.status, status.details);
      } catch (err) {
        console.error("[App] Failed to fetch backend status:", err);
        addLog("warn", `Unable to fetch backend connection status: ${err}`);
      }

      console.log("[App] Starting status poll timer...");
      statusPollTimer = setInterval(() => {
        void invoke<{ status: string; details?: string }>("get_modbus_connection_status")
          .then((status) => {
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