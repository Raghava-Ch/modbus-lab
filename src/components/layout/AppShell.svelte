<svelte:options runes={true} />

<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { X } from "lucide-svelte";
  import { applyBackendConnectionStatus } from "../../state/connection.svelte";
  import {
    layoutState,
    closeMobileLog,
    setLogPanelView,
    toggleLogCollapsed,
  } from "../../state/layout.svelte";
  import { settingsState } from "../../state/settings.svelte";
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
  import AppNotifications from "./AppNotifications.svelte";
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
  import CustomFramePage from "../pages/CustomFramePage.svelte";
  import SettingsPage from "../pages/SettingsPage.svelte";

  const filtered = $derived(getFilteredLogs(logState.filter));
  let showAbout = $state(false);
  const appVersion = "0.0.3";
  const buildDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

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
</script>

<div class="app-shell" class:force-mobile={settingsState.forcedLayoutMode === "mobile"} class:force-desktop={settingsState.forcedLayoutMode === "desktop"}>
  <StatusBar onShowAbout={() => (showAbout = true)} />
  <AppNotifications />
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
    {:else if navigationState.activeTab === "custom-frame"}
      <CustomFramePage />
    {:else}
      <SettingsPage />
    {/if}
  </main>

  <LogPanel />
</div>

{#if layoutState.mobileLogOpen && settingsState.forcedLayoutMode !== "desktop"}
  <div class="mobile-log-overlay" class:force-open={settingsState.forcedLayoutMode === "mobile"} role="dialog" aria-label="Log panel">
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
        panelView={layoutState.logPanelView}
        filter={logState.filter}
        totalCount={logState.entries.length}
        visibleCount={filtered.length}
        onFilter={setLogFilter}
        onClear={clearLogs}
        onSave={handleSave}
        onPanelView={setLogPanelView}
        onToggle={toggleLogCollapsed}
      />
      {#if !layoutState.logCollapsed}
        <LogList entries={filtered} />
      {/if}
    </section>
  </div>
{/if}

{#if showAbout}
  <div
    class="about-backdrop"
    role="button"
    aria-label="Close about dialog"
    tabindex="-1"
    onclick={(e) => e.target === e.currentTarget && (showAbout = false)}
    onkeydown={(e) => e.key === "Escape" && (showAbout = false)}
  >
    <div class="about-modal" role="dialog" aria-modal="true" aria-label="About Modbus Lab">
      <header class="about-header">
        <h2>About Modbus Lab</h2>
        <button class="close-btn" type="button" aria-label="Close" onclick={() => (showAbout = false)}>
          <X size={18} />
        </button>
      </header>
      <div class="about-body">
        <div class="about-section">
          <p><strong>Version:</strong> {appVersion} (Alpha)</p>
          <p><strong>Build Date:</strong> {buildDate}</p>
        </div>

        <div class="about-section">
          <h3>About</h3>
          <p>
            Modbus Lab is a professional-grade desktop Modbus master client purpose-built for industrial automation engineers and system integrators.
            It demonstrates a modern, production-ready approach to factory floor operations, IoT device management, and SCADA system testing.
          </p>
          <p style="margin-top: 8px; font-size: 0.95em; opacity: 0.9;">
            Built on deterministic, embedded-grade Rust with a responsive TypeScript frontend and native desktop runtime.
            Validated across desktop, embedded (no_std), RTOS, and Linux deployments.
          </p>
        </div>

        <div class="about-section">
          <h3>Supported Protocols</h3>
          <ul>
            <li>Modbus TCP</li>
            <li>Modbus RTU</li>
            <li>Modbus ASCII</li>
          </ul>
        </div>

        <div class="about-section">
          <h3>Tech Stack</h3>
          <ul>
            <li>Frontend: Svelte 5 + TypeScript + Vite</li>
            <li>Desktop Runtime: Tauri v2 (cross-platform native)</li>
            <li>Backend: Rust + <a href="https://github.com/Raghava-Ch/modbus-rs" target="_blank" style="color: inherit; text-decoration: underline;">modbus-rs</a> engine</li>
          </ul>
          <p style="margin-top: 8px; font-size: 0.9em; opacity: 0.85;">
            The <a href="https://github.com/Raghava-Ch/modbus-rs" target="_blank" style="color: inherit; text-decoration: underline;"><strong>modbus-rs</strong></a> stack delivers deterministic, embedded-grade Modbus protocol handling with efficient memory usage and minimal dependencies.
          </p>
        </div>

        <div class="about-section">
          <h3>License</h3>
          <p>GPL v3 for open-source use</p>
        </div>

        <div class="about-section">
          <h3>Resources</h3>
          <ul>
            <li><a href="https://github.com/Raghava-Ch/modbus-rs" target="_blank" style="color: inherit; text-decoration: underline;">modbus-rs GitHub</a> – Core Modbus protocol engine</li>
            <li><a href="https://github.com/Raghava-Ch/modbus-lab" target="_blank" style="color: inherit; text-decoration: underline;">modbus-lab GitHub</a> – This application</li>
          </ul>
        </div>

        <div class="about-section">
          <h3>Creator</h3>
          <p><strong>Raghava Ch</strong></p>
          <p><a href="mailto:ch.raghava44@gmail.com">ch.raghava44@gmail.com</a></p>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .app-shell {
    height: 100dvh;
    width: 100%;
    min-width: 0;
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
    overflow-y: auto;
    overflow-x: hidden;
    padding: 12px 12px 18px;
    background:
      radial-gradient(circle at 0% 0%, color-mix(in srgb, var(--c-accent) 18%, transparent) 0%, transparent 42%),
      var(--c-bg);
  }

  :global(html[data-forced-layout="mobile"]) .main-content {
    padding-bottom: calc(18px + 94px + env(safe-area-inset-bottom, 0px));
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

    .main-content {
      padding-bottom: calc(18px + 94px + env(safe-area-inset-bottom, 0px));
    }
  }

  .app-shell.force-mobile {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr auto;
    grid-template-areas:
      "status"
      "content"
      "nav";
  }

  .app-shell.force-mobile :global(.log-panel) {
    display: none;
  }

  .app-shell.force-mobile :global(.status-bar) {
    grid-template-columns: 1fr auto;
    gap: 8px;
  }

  .app-shell.force-mobile :global(.status-bar .center) {
    display: none;
  }

  .app-shell.force-mobile :global(.status-actions .mobile-only) {
    display: inline-flex;
  }

  .app-shell.force-mobile :global(.nav-panel),
  .app-shell.force-mobile :global(.nav-panel.collapsed) {
    position: relative;
    width: auto;
    border-right: none;
    border-top: 1px solid var(--c-border);
    grid-template-rows: 1fr;
    display: flex;
    align-items: stretch;
    padding: 4px;
    gap: 4px;
    background: var(--c-surface-1);
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
  }

  .app-shell.force-mobile :global(.nav-panel)::before,
  .app-shell.force-mobile :global(.nav-panel)::after {
    content: "";
    position: absolute;
    width: 100%;
    height: 100%;
    top: 0;
    pointer-events: none;
    z-index: 10;
  }

  .app-shell.force-mobile :global(.nav-panel)::before {
    left: 0;
    background: linear-gradient(to right, var(--c-surface-1), transparent);
  }

  .app-shell.force-mobile :global(.nav-panel)::after {
    right: 0;
    background: linear-gradient(to left, var(--c-surface-1), transparent);
  }

  .about-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    animation: fade-in 150ms ease;
  }

  .about-modal {
    background: var(--c-surface-1);
    border: 1px solid var(--c-border);
    border-radius: 12px;
    max-width: 500px;
    width: 90%;
    max-height: 80dvh;
    overflow-y: auto;
    display: grid;
    grid-template-rows: auto 1fr;
    animation: scale-in 150ms ease;
  }

  .about-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 16px;
    border-bottom: 1px solid var(--c-border);
  }

  .about-header h2 {
    margin: 0;
    font-size: 1.1rem;
    color: var(--c-text-1);
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--c-text-2);
    cursor: pointer;
    padding: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    transition: background 120ms ease;
  }

  .close-btn:hover {
    background: var(--c-surface-2);
    color: var(--c-text-1);
  }

  .about-body {
    padding: 16px;
    display: grid;
    gap: 12px;
    font-size: 0.9rem;
    color: var(--c-text-1);
    line-height: 1.5;
  }

  .about-section {
    display: grid;
    gap: 6px;
  }

  .about-section h3 {
    margin: 0;
    font-size: 0.95rem;
    color: var(--c-accent);
    font-weight: 600;
  }

  .about-section p {
    margin: 0;
  }

  .about-section ul {
    margin: 0;
    padding-left: 20px;
  }

  .about-section li {
    margin: 4px 0;
  }

  .about-section a {
    color: var(--c-accent);
    text-decoration: none;
  }

  .about-section a:hover {
    text-decoration: underline;
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes scale-in {
    from {
      opacity: 0;
      transform: scale(0.95);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .app-shell.force-mobile :global(.nav-panel)::before {
    left: 0;
    background: linear-gradient(to right, var(--c-surface-1), transparent);
  }

  .app-shell.force-mobile :global(.nav-panel)::after {
    right: 0;
    background: linear-gradient(to left, var(--c-surface-1), transparent);
  }

  .app-shell.force-mobile :global(.nav-panel .main-nav),
  .app-shell.force-mobile :global(.nav-panel .settings-nav) {
    padding: 0;
    border: 0;
    flex: 0 0 auto;
  }

  .app-shell.force-mobile :global(.nav-panel .main-nav) {
    min-width: 0;
  }

  .app-shell.force-mobile :global(.nav-collapse-btn) {
    display: none;
  }

  .app-shell.force-mobile :global(.nav-section) {
    display: flex;
    gap: 4px;
    overflow: visible;
    padding: 0 2px;
    white-space: nowrap;
  }

  .app-shell.force-mobile :global(.nav-section .nav-item) {
    min-width: 70px;
    width: auto;
    grid-template-columns: 1fr;
    justify-items: center;
    gap: 4px;
    border-radius: 8px;
    padding: 8px 4px;
    font-size: 0.7rem;
    text-align: center;
  }

  .app-shell.force-mobile :global(.nav-section .nav-item span) {
    display: block;
    line-height: 1;
  }

  .app-shell.force-mobile :global(.main-content) {
    overflow-x: auto;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  .app-shell.force-mobile :global(.panel-frame) {
    overflow-x: auto;
  }

  .app-shell.force-mobile :global(.toolbar) {
    flex-direction: column;
    align-items: stretch;
  }

  .app-shell.force-mobile :global(.toolbar-left) {
    justify-content: space-between;
  }

  .app-shell.force-mobile :global(.toolbar-actions) {
    justify-content: space-between;
    flex-wrap: wrap;
  }

  .app-shell.force-mobile :global(.address-filter-row) {
    align-items: stretch;
  }

  .app-shell.force-mobile :global(.address-filter-select),
  .app-shell.force-mobile :global(.address-filter-input),
  .app-shell.force-mobile :global(.address-filter-list-input) {
    width: 100%;
  }

  .app-shell.force-mobile :global(.form-row),
  .app-shell.force-mobile :global(.protocol-buttons) {
    grid-template-columns: 1fr !important;
  }

  .app-shell.force-mobile :global(.tcp-fields),
  .app-shell.force-mobile :global(.device-fields) {
    flex-wrap: wrap;
  }

  .app-shell.force-mobile :global(.tcp-host),
  .app-shell.force-mobile :global(.tcp-port),
  .app-shell.force-mobile :global(.slave-id-group),
  .app-shell.force-mobile :global(.actions) {
    width: 100%;
    flex: 1 1 100%;
  }

  .mobile-log-overlay.force-open {
    display: flex;
  }

  .app-shell.force-desktop {
    grid-template-columns: auto 1fr;
    grid-template-rows: auto 1fr auto;
    grid-template-areas:
      "status status"
      "nav content"
      "logs logs";
  }

  .app-shell.force-desktop :global(.log-panel) {
    display: grid !important;
  }

  .app-shell.force-desktop :global(.status-bar) {
    grid-template-columns: auto 1fr auto;
    gap: 10px;
  }

  .app-shell.force-desktop :global(.status-bar .center) {
    display: flex;
  }

  .app-shell.force-desktop :global(.status-actions .mobile-only) {
    display: none;
  }

  .app-shell.force-desktop :global(.nav-panel) {
    width: var(--nav-width-open);
    border-right: 1px solid var(--c-border);
    border-top: none;
    grid-template-rows: auto 1fr auto;
    display: grid;
    padding: 0;
    gap: 0;
    background: var(--c-surface-1);
  }

  .app-shell.force-desktop :global(.nav-panel.collapsed) {
    width: var(--nav-width-collapsed);
  }

  .app-shell.force-desktop :global(.nav-panel .main-nav),
  .app-shell.force-desktop :global(.nav-panel .settings-nav) {
    padding: 8px;
  }

  .app-shell.force-desktop :global(.nav-panel .settings-nav) {
    border-top: 1px solid var(--c-border);
  }

  .app-shell.force-desktop :global(.nav-collapse-btn) {
    display: block;
    padding: 8px;
  }

  .app-shell.force-desktop :global(.nav-section) {
    display: grid;
    gap: 6px;
    overflow: visible;
    padding: 0;
  }

  .app-shell.force-desktop :global(.nav-section .nav-item) {
    width: 100%;
    min-width: 0;
    grid-template-columns: 20px 1fr;
    justify-items: stretch;
    gap: 10px;
    border-radius: 10px;
    padding: 10px 12px;
    font-size: inherit;
    text-align: left;
  }

  .app-shell.force-desktop :global(.nav-section .nav-item span) {
    display: block;
    line-height: inherit;
  }

  .app-shell.force-desktop :global(.nav-section .nav-item.collapsed) {
    grid-template-columns: 1fr;
    justify-items: center;
    padding: 10px 6px;
  }

  .app-shell.force-desktop :global(.nav-section .nav-item.collapsed span) {
    display: none;
  }

</style>
