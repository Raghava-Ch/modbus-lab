<svelte:options runes={true} />

<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { X } from "lucide-svelte";
  import { applyBackendConnectionStatus } from "../../state/connection.svelte";
  import { initLayoutState, layoutState, closeMobileLog, toggleLogCollapsed } from "../../state/layout.svelte";
  import {
    addLog,
    clearLogs,
    getFilteredLogs,
    logState,
    saveLogsToFile,
    setLogFilter,
    type LogExportScope,
  } from "../../state/logs.svelte";
  import { navigationState } from "../../state/navigation.svelte";
  import StatusBar from "./StatusBar/StatusBar.svelte";
  import NavPanel from "./NavPanel/NavPanel.svelte";
  import LogPanel from "./LogPanel/LogPanel.svelte";
  import LogToolbar from "./LogPanel/LogToolbar.svelte";
  import LogList from "./LogPanel/LogList.svelte";
  import IconButton from "../shared/IconButton.svelte";
  import ConnectionPage from "../pages/ConnectionPage.svelte";
  import CoilsPage from "../pages/CoilsPage.svelte";
  import DiscreteInputsPage from "../pages/DiscreteInputsPage.svelte";
  import HoldingRegistersPage from "../pages/HoldingRegistersPage.svelte";
  import InputRegistersPage from "../pages/InputRegistersPage.svelte";
  import FileRecordsPage from "../pages/FileRecordsPage.svelte";
  import FifoPage from "../pages/FifoPage.svelte";
  import DiagnosticsPage from "../pages/DiagnosticsPage.svelte";
  import SettingsPage from "../pages/SettingsPage.svelte";

  const filtered = $derived(getFilteredLogs(logState.filter));

  interface BackendEventPayload {
    level?: "info" | "warn" | "error";
    topic?: string;
    message?: string;
    status?: {
      status?: string;
      details?: string;
    };
  }

  let listenersReady = false;

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

  function handleSave(scope: LogExportScope): void {
    saveLogsToFile(scope === "all" ? logState.entries : filtered, scope, logState.filter);
  }

  $effect(() => {
    initLayoutState();

    if (listenersReady) {
      return;
    }

    listenersReady = true;
    let unlisten: (() => void) | undefined;
    let statusPollTimer: ReturnType<typeof setInterval> | undefined;

    const setup = async (): Promise<void> => {
      unlisten = await listen<BackendEventPayload>("modbus://event", (event) => {
        const payload = event.payload;
        addLog(toLogLevel(payload.level), formatBackendEventMessage(payload));

        if (payload.status?.status) {
          applyBackendConnectionStatus(payload.status.status, payload.status.details);
        }
      });

      try {
        const status = await invoke<{ status: string; details?: string }>("get_modbus_connection_status");
        applyBackendConnectionStatus(status.status, status.details);
      } catch {
        addLog("warn", "Unable to fetch backend connection status.");
      }

      statusPollTimer = setInterval(() => {
        void invoke<{ status: string; details?: string }>("get_modbus_connection_status")
          .then((status) => {
            applyBackendConnectionStatus(status.status, status.details);
          })
          .catch(() => {
            // Keep polling silent to avoid log spam during transient reconnects.
          });
      }, 1000);
    };

    void setup();

    return () => {
      listenersReady = false;
      if (unlisten) {
        unlisten();
      }
      if (statusPollTimer) {
        clearInterval(statusPollTimer);
      }
    };
  });
</script>

<div class="app-shell">
  <StatusBar />
  <NavPanel />

  <main class="main-content">
    {#if navigationState.activeTab === "connection"}
      <ConnectionPage />
    {:else if navigationState.activeTab === "coils"}
      <CoilsPage />
    {:else if navigationState.activeTab === "discrete-inputs"}
      <DiscreteInputsPage />
    {:else if navigationState.activeTab === "holding-registers"}
      <HoldingRegistersPage />
    {:else if navigationState.activeTab === "input-registers"}
      <InputRegistersPage />
    {:else if navigationState.activeTab === "file-records"}
      <FileRecordsPage />
    {:else if navigationState.activeTab === "fifo-queue"}
      <FifoPage />
    {:else if navigationState.activeTab === "diagnostics"}
      <DiagnosticsPage />
    {:else}
      <SettingsPage />
    {/if}
  </main>

  <LogPanel />
</div>

{#if layoutState.mobileLogOpen}
  <div class="mobile-log-overlay" role="dialog" aria-label="Log panel">
    <section class="mobile-log-sheet">
      <header class="mobile-log-head">
        <strong>Logs</strong>
        <IconButton label="Close logs" title="Close logs" onclick={closeMobileLog}>
          {#snippet children()}
            <X size={16} />
          {/snippet}
        </IconButton>
      </header>
      <LogToolbar
        collapsed={layoutState.logCollapsed}
        filter={logState.filter}
        totalCount={logState.entries.length}
        visibleCount={filtered.length}
        onFilter={setLogFilter}
        onClear={clearLogs}
        onSave={handleSave}
        onToggle={toggleLogCollapsed}
      />
      {#if !layoutState.logCollapsed}
        <LogList entries={filtered} />
      {/if}
    </section>
  </div>
{/if}

<style>
  .app-shell {
    height: 100dvh;
    display: grid;
    grid-template-columns: auto 1fr;
    grid-template-rows: auto 1fr auto;
    grid-template-areas:
      "status status"
      "nav content"
      "logs logs";
    background: var(--c-bg);
    color: var(--c-text-1);
  }

  .main-content {
    grid-area: content;
    min-width: 0;
    min-height: 0;
    overflow: auto;
    padding: 12px;
    background:
      radial-gradient(circle at 0% 0%, color-mix(in srgb, var(--c-accent) 18%, transparent) 0%, transparent 42%),
      var(--c-bg);
  }

  .mobile-log-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: none;
    align-items: end;
    z-index: 50;
  }

  .mobile-log-sheet {
    width: 100%;
    max-height: min(65dvh, 460px);
    border-top: 1px solid var(--c-border);
    background: var(--c-surface-1);
    display: grid;
    grid-template-rows: auto auto 1fr;
    animation: slide-up 180ms ease;
  }

  .mobile-log-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--c-border);
  }

  @keyframes slide-up {
    from {
      transform: translateY(16px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  @media (max-width: 767px) {
    .app-shell {
      grid-template-columns: 1fr;
      grid-template-rows: auto 1fr auto;
      grid-template-areas:
        "status"
        "content"
        "nav";
    }

    .mobile-log-overlay {
      display: flex;
    }
  }
</style>
