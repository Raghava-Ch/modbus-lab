<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { Link2, LogOut } from "lucide-svelte";
  import {
    applyBackendConnectionStatus,
    connectionState,
    setConnectionStatus,
    setProtocol,
    setSlaveId,
    updateTcpSettings,
    updateSerialSettings,
    type ModbusProtocol,
    type RetryBackoffStrategy,
    type RetryJitterStrategy,
    type SerialParity,
  } from "../../state/connection.svelte";
  import { addLog } from "../../state/logs.svelte";
  import IconButton from "../shared/IconButton.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";
  import SectionHeader from "../shared/SectionHeader.svelte";

  let connecting = $state(false);
  let listingPorts = $state(false);
  let availableSerialPorts = $state<string[]>([]);
  let showSerialPortDropdown = $state(false);
  const filteredSerialPorts = $derived.by(() => {
    const query = connectionState.serial.port.trim().toLowerCase();
    if (!query) return availableSerialPorts;
    return availableSerialPorts.filter((port) => port.toLowerCase().includes(query));
  });
  const backendSource = $derived.by(() => {
    const normalized = connectionState.backendStatus.toLowerCase();
    if (normalized.includes("connectedtcp")) {
      return "TCP";
    }
    if (normalized.includes("connectedserialrtu")) {
      return "SERIAL RTU";
    }
    if (normalized.includes("connectedserialascii")) {
      return "SERIAL ASCII";
    }

    const details = connectionState.backendDetails.toUpperCase();
    if (details.startsWith("TCP ")) {
      return "TCP";
    }
    if (details.includes("RTU")) {
      return "SERIAL RTU";
    }
    if (details.includes("ASCII")) {
      return "SERIAL ASCII";
    }

    return "";
  });

  const compactBackendDetails = $derived.by(() => {
    const raw = connectionState.backendDetails.trim();
    if (!raw) return "";

    const status = connectionState.backendStatus.toLowerCase();

    if (status === "reconnecting") {
      const attempt = raw.match(/reconnect attempt\s+(\d+)/i)?.[1];
      const code = raw.match(/code=([A-Z_]+)/)?.[1];
      const lastError = raw.match(/lastError=([^|]+)/i)?.[1] ?? "";

      let reason = "";
      if (/timed out/i.test(lastError)) {
        reason = "timeout";
      } else if (/refused/i.test(lastError)) {
        reason = "refused";
      } else if (/reset/i.test(lastError)) {
        reason = "reset";
      } else if (/not connected/i.test(lastError)) {
        reason = "not connected";
      } else if (code === "BACKEND_FAILURE") {
        reason = "network error";
      } else if (code) {
        reason = code.toLowerCase().replaceAll("_", " ");
      }

      const prefix = attempt ? `Retry ${attempt}` : "Reconnecting";
      return reason ? `${prefix} - ${reason}` : prefix;
    }

    const tcpMatch = raw.match(/^TCP\s+([^\s]+)/i);
    if (tcpMatch) {
      return tcpMatch[1];
    }

    return raw;
  });

  interface AnalyticsContext {
    traceId?: string;
    sessionId?: string;
    tags?: string[];
  }

  interface TcpConnectRequest {
    host: string;
    port: number;
    slaveId: number;
    connectionTimeoutMs?: number;
    responseTimeoutMs?: number;
    retryAttempts?: number;
    retryBackoffStrategy?: RetryBackoffStrategy;
    retryJitterStrategy?: RetryJitterStrategy;
    analytics?: AnalyticsContext;
  }

  interface SerialConnectRequest {
    port: string;
    baudRate: number;
    dataBits: number;
    stopBits: number;
    parity: string;
    slaveId: number;
    timeoutMs?: number;
    analytics?: AnalyticsContext;
  }

  interface CommandAck {
    ok: boolean;
    message: string;
    status: {
      status: string;
      details?: string;
    };
  }

  interface ApiErrorPayload {
    code?: string;
    message?: string;
    details?: string;
  }

  function parseApiError(err: unknown): ApiErrorPayload {
    if (typeof err === "string") {
      try {
        return JSON.parse(err) as ApiErrorPayload;
      } catch {
        return { message: err };
      }
    }

    if (typeof err === "object" && err !== null) {
      const maybe = err as Record<string, unknown>;
      return {
        code: typeof maybe.code === "string" ? maybe.code : undefined,
        message: typeof maybe.message === "string" ? maybe.message : undefined,
        details: typeof maybe.details === "string" ? maybe.details : undefined,
      };
    }

    return {};
  }

  async function handleConnect(): Promise<void> {
    connecting = true;
    setConnectionStatus("connecting");

    try {
      let response: CommandAck;

      if (connectionState.protocol === "tcp") {
        const request: TcpConnectRequest = {
          host: connectionState.tcp.host.trim(),
          port: connectionState.tcp.port,
          slaveId: connectionState.slaveId,
          connectionTimeoutMs: connectionState.tcp.connectionTimeoutMs,
          responseTimeoutMs: connectionState.tcp.responseTimeoutMs,
          retryAttempts: connectionState.tcp.retryAttempts,
          retryBackoffStrategy: connectionState.tcp.retryBackoffStrategy,
          retryJitterStrategy: connectionState.tcp.retryJitterStrategy,
        };

        response = await invoke<CommandAck>("connect_modbus_tcp", { request });
      } else {
        const request: SerialConnectRequest = {
          port: connectionState.serial.port.trim(),
          baudRate: connectionState.serial.baudRate,
          dataBits: connectionState.serial.dataBits,
          stopBits: connectionState.serial.stopBits,
          parity: connectionState.serial.parity,
          slaveId: connectionState.slaveId,
          timeoutMs: 2000,
        };

        response = await invoke<CommandAck>(
          connectionState.protocol === "serial-rtu"
            ? "connect_modbus_serial_rtu"
            : "connect_modbus_serial_ascii",
          { request },
        );
      }

      applyBackendConnectionStatus(response.status.status, response.status.details);
    } catch (err) {
      const parsed = parseApiError(err);
      applyBackendConnectionStatus("disconnected", parsed.details ?? parsed.message);

      // Serial commands are scaffolded in this phase; keep UX explicit and non-alarming.
      if (parsed.code === "NOT_IMPLEMENTED_YET") {
        addLog("warn", parsed.message ?? "Serial connection is scaffolded for next phase.");
      } else if (parsed.message) {
        const extra = parsed.details ? ` (${parsed.details})` : "";
        addLog("error", `${parsed.message}${extra}`);
      } else {
        addLog("error", "Connection command failed.");
      }
    } finally {
      connecting = false;
    }
  }

  async function handleDisconnect(): Promise<void> {
    try {
      const response = await invoke<CommandAck>("disconnect_modbus", {
        request: {},
      });
      applyBackendConnectionStatus(response.status.status, response.status.details);
    } catch (err) {
      const parsed = parseApiError(err);
      addLog("error", parsed.message ?? "Disconnect command failed.");
      setConnectionStatus("disconnected");
    }
  }

  function handleProtocolChange(proto: ModbusProtocol): void {
    setProtocol(proto);
    addLog("info", `Protocol changed to ${proto.toUpperCase()}.`);

    if (proto === "serial-rtu" || proto === "serial-ascii") {
      void refreshSerialPorts();
    }
  }

  async function refreshSerialPorts(): Promise<void> {
    if (listingPorts) return;

    listingPorts = true;
    try {
      const ports = await invoke<string[]>("list_serial_ports");
      availableSerialPorts = ports;
      addLog("info", `Serial ports refreshed (${ports.length} found).`);
    } catch (err) {
      const parsed = parseApiError(err);
      const msg = parsed.message ?? "Failed to list serial ports.";
      const extra = parsed.details ? ` (${parsed.details})` : "";
      addLog("warn", `${msg}${extra}`);
    } finally {
      listingPorts = false;
    }
  }

  function selectSerialPort(port: string): void {
    updateSerialSettings({ port });
    showSerialPortDropdown = false;
  }

  onMount(() => {
    if (connectionState.protocol === "serial-rtu" || connectionState.protocol === "serial-ascii") {
      void refreshSerialPorts();
    }
  });
</script>

<div class="connection-page">
  <SectionHeader title="Connection Settings" subtitle="Configure Modbus device connection">
    {#snippet actions()}
      <div class="header-status-cluster">
        <div class="connection-status" class:connected={connectionState.status === "connected"}>
          <span class="status-dot"></span>
          <span class="status-text">{connectionState.status}</span>
        </div>
        {#if backendSource}
          <span class="status-chip">{backendSource}</span>
        {/if}
        {#if compactBackendDetails}
          <span class="status-chip details" title={connectionState.backendDetails}>
            {compactBackendDetails}
          </span>
        {/if}
      </div>
    {/snippet}
  </SectionHeader>

  <div class="forms-grid">
    <!-- Protocol Selector -->
    <PanelFrame>
      {#snippet children()}
        <div class="section">
          <div class="section-title">Protocol</div>
          <div class="protocol-buttons">
            <button
              class:active={connectionState.protocol === "tcp"}
              type="button"
              onclick={() => handleProtocolChange("tcp")}
            >
              <span class="label">Modbus TCP</span>
              <span class="desc">Ethernet/IP</span>
            </button>
            <button
              class:active={connectionState.protocol === "serial-rtu"}
              type="button"
              onclick={() => handleProtocolChange("serial-rtu")}
            >
              <span class="label">Serial RTU</span>
              <span class="desc">Binary protocol</span>
            </button>
            <button
              class:active={connectionState.protocol === "serial-ascii"}
              type="button"
              onclick={() => handleProtocolChange("serial-ascii")}
            >
              <span class="label">Serial ASCII</span>
              <span class="desc">Text protocol</span>
            </button>
          </div>
        </div>
      {/snippet}
    </PanelFrame>

    <!-- TCP Settings -->
    {#if connectionState.protocol === "tcp"}
      <PanelFrame>
        {#snippet children()}
          <div class="section">
            <div class="section-title">TCP Settings</div>

            <div class="tcp-fields">
              <div class="form-group tcp-host">
                <label for="tcp-host">Host / IP Address</label>
                <input
                  id="tcp-host"
                  type="text"
                  placeholder="192.168.55.200"
                  value={connectionState.tcp.host}
                  onchange={(e) => updateTcpSettings({ host: e.currentTarget.value })}
                />
              </div>

              <div class="form-group tcp-port">
                <label for="tcp-port">Port</label>
                <input
                  id="tcp-port"
                  type="number"
                  min="1"
                  max="65535"
                  value={connectionState.tcp.port}
                  onchange={(e) => updateTcpSettings({ port: Number(e.currentTarget.value) })}
                />
              </div>
            </div>

            <div class="section-subtitle">Advanced TCP</div>

            <div class="form-row">
              <div class="form-group">
                <label for="tcp-connection-timeout">Connection Timeout (ms)</label>
                <input
                  id="tcp-connection-timeout"
                  type="number"
                  min="100"
                  max="600000"
                  step="100"
                  value={connectionState.tcp.connectionTimeoutMs}
                  onchange={(e) => updateTcpSettings({ connectionTimeoutMs: Number(e.currentTarget.value) })}
                />
              </div>

              <div class="form-group">
                <label for="tcp-response-timeout">Response Timeout (ms)</label>
                <input
                  id="tcp-response-timeout"
                  type="number"
                  min="100"
                  max="600000"
                  step="100"
                  value={connectionState.tcp.responseTimeoutMs}
                  onchange={(e) => updateTcpSettings({ responseTimeoutMs: Number(e.currentTarget.value) })}
                />
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label for="tcp-retry-attempts">Retry Attempts</label>
                <input
                  id="tcp-retry-attempts"
                  type="number"
                  min="0"
                  max="10"
                  value={connectionState.tcp.retryAttempts}
                  onchange={(e) => updateTcpSettings({ retryAttempts: Number(e.currentTarget.value) })}
                />
              </div>

              <div class="form-group">
                <label for="tcp-backoff-strategy">Retry Backoff</label>
                <select
                  id="tcp-backoff-strategy"
                  value={connectionState.tcp.retryBackoffStrategy}
                  onchange={(e) => updateTcpSettings({ retryBackoffStrategy: e.currentTarget.value as RetryBackoffStrategy })}
                >
                  <option value="fixed">Fixed</option>
                  <option value="linear">Linear</option>
                  <option value="exponential">Exponential</option>
                </select>
              </div>
            </div>

            <div class="form-group">
              <label for="tcp-jitter-strategy">Retry Jitter</label>
              <select
                id="tcp-jitter-strategy"
                value={connectionState.tcp.retryJitterStrategy}
                onchange={(e) => updateTcpSettings({ retryJitterStrategy: e.currentTarget.value as RetryJitterStrategy })}
              >
                <option value="none">None</option>
                <option value="full">Full</option>
                <option value="equal">Equal</option>
              </select>
            </div>
          </div>
        {/snippet}
      </PanelFrame>
    {/if}

    <!-- Serial Settings -->
    {#if connectionState.protocol === "serial-rtu" || connectionState.protocol === "serial-ascii"}
      <PanelFrame>
        {#snippet children()}
          <div class="section">
            <div class="section-title">
              {connectionState.protocol === "serial-rtu" ? "Serial RTU" : "Serial ASCII"} Settings
            </div>

            <div class="form-group">
              <label for="serial-port-input">Port</label>
              <div class="serial-port-row">
                <div class="serial-port-combobox">
                  <input
                    id="serial-port-input"
                    type="text"
                    placeholder="/dev/ttyUSB0 or COM3"
                    value={connectionState.serial.port}
                    onfocus={() => (showSerialPortDropdown = true)}
                    oninput={(e) => {
                      updateSerialSettings({ port: e.currentTarget.value });
                      showSerialPortDropdown = true;
                    }}
                    onblur={() => {
                      setTimeout(() => {
                        showSerialPortDropdown = false;
                      }, 120);
                    }}
                  />

                  {#if showSerialPortDropdown}
                    <div class="serial-port-list" role="listbox">
                      {#if filteredSerialPorts.length === 0}
                        <div class="serial-port-empty">No detected ports match.</div>
                      {:else}
                        {#each filteredSerialPorts as port}
                          <button
                            type="button"
                            class="serial-port-option"
                            onclick={() => selectSerialPort(port)}
                          >
                            {port}
                          </button>
                        {/each}
                      {/if}
                    </div>
                  {/if}
                </div>

                <button
                  class="btn btn-inline"
                  type="button"
                  onclick={() => void refreshSerialPorts()}
                  disabled={listingPorts}
                >
                  {listingPorts ? "Refreshing..." : "Refresh Ports"}
                </button>
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label for="baud-rate">Baud Rate</label>
                <select
                  id="baud-rate"
                  value={connectionState.serial.baudRate}
                  onchange={(e) => updateSerialSettings({ baudRate: Number(e.currentTarget.value) })}
                >
                  <option value="1200">1200</option>
                  <option value="2400">2400</option>
                  <option value="4800">4800</option>
                  <option value="9600">9600</option>
                  <option value="19200">19200</option>
                  <option value="38400">38400</option>
                  <option value="57600">57600</option>
                  <option value="115200">115200</option>
                </select>
              </div>

              <div class="form-group">
                <label for="data-bits">Data Bits</label>
                <select
                  id="data-bits"
                  value={connectionState.serial.dataBits}
                  onchange={(e) => updateSerialSettings({ dataBits: Number(e.currentTarget.value) as 5 | 6 | 7 | 8 })}
                >
                  <option value="5">5</option>
                  <option value="6">6</option>
                  <option value="7">7</option>
                  <option value="8">8</option>
                </select>
              </div>
            </div>

            <div class="form-row">
              <div class="form-group">
                <label for="stop-bits">Stop Bits</label>
                <select
                  id="stop-bits"
                  value={connectionState.serial.stopBits}
                  onchange={(e) => updateSerialSettings({ stopBits: Number(e.currentTarget.value) as 1 | 2 })}
                >
                  <option value="1">1</option>
                  <option value="2">2</option>
                </select>
              </div>

              <div class="form-group">
                <label for="parity">Parity</label>
                <select
                  id="parity"
                  value={connectionState.serial.parity}
                  onchange={(e) => updateSerialSettings({ parity: e.currentTarget.value as SerialParity })}
                >
                  <option value="none">None</option>
                  <option value="even">Even</option>
                  <option value="odd">Odd</option>
                </select>
              </div>
            </div>
          </div>
        {/snippet}
      </PanelFrame>
    {/if}

    <!-- Slave ID & Actions -->
    <PanelFrame>
      {#snippet children()}
        <div class="section">
          <div class="section-title">Device Settings</div>

          <div class="device-fields">
            <div class="form-group slave-id-group">
              <label for="slave-id">Slave ID (1-247)</label>
              <input
                id="slave-id"
                type="number"
                min="1"
                max="247"
                value={connectionState.slaveId}
                onchange={(e) => setSlaveId(Number(e.currentTarget.value))}
              />
            </div>

          <div class="actions">
            {#if connectionState.status === "disconnected"}
              <button class="btn btn-primary" type="button" onclick={handleConnect} disabled={connecting}>
                {#if connecting}
                  <span class="spinner"></span>
                {:else}
                  <Link2 size={16} />
                {/if}
                {connecting ? "Connecting..." : "Connect"}
              </button>
            {:else}
              <button class="btn btn-secondary" type="button" onclick={handleDisconnect}>
                <LogOut size={16} />
                Disconnect
              </button>
            {/if}
          </div>
          </div>
        </div>
      {/snippet}
    </PanelFrame>
  </div>
</div>

<style>
  .connection-page {
    display: grid;
    gap: 14px;
  }

  .connection-status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 0.8rem;
    color: var(--c-text-2);
  }

  .connection-status.connected {
    color: var(--c-ok);
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--c-text-2);
    animation: pulse-dim 2s infinite;
  }

  .connection-status.connected .status-dot {
    background: var(--c-ok);
    animation: pulse-bright 1.7s infinite;
  }

  @keyframes pulse-dim {
    0% {
      box-shadow: 0 0 0 0 currentColor;
    }
    75% {
      box-shadow: 0 0 0 4px transparent;
    }
    100% {
      box-shadow: 0 0 0 0 transparent;
    }
  }

  @keyframes pulse-bright {
    0% {
      box-shadow: 0 0 0 0 currentColor;
    }
    75% {
      box-shadow: 0 0 0 6px transparent;
    }
    100% {
      box-shadow: 0 0 0 0 transparent;
    }
  }

  .status-text {
    text-transform: capitalize;
  }

  .header-status-cluster {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .status-chip {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--c-border);
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 0.68rem;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--c-text-2);
    background: color-mix(in srgb, var(--c-surface-2) 80%, var(--c-bg));
  }

  .status-chip.details {
    max-width: 38ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-transform: none;
    letter-spacing: 0;
  }

  .forms-grid {
    display: grid;
    gap: 8px;
  }

  .section {
    display: grid;
    gap: 8px;
  }

  .section-title {
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--c-text-1);
  }

  .section-subtitle {
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--c-text-2);
    margin-top: 4px;
  }

  .protocol-buttons {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 6px;
  }

  .protocol-buttons button {
    display: flex;
    flex-direction: column;
    gap: 3px;
    align-items: flex-start;
    border: 1px solid var(--c-border);
    border-radius: 8px;
    padding: 8px 10px;
    background: var(--c-surface-2);
    color: var(--c-text-2);
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
    transition: all 160ms ease;
  }

  .protocol-buttons button:hover {
    border-color: var(--c-border-strong);
    color: var(--c-text-1);
    background: color-mix(in srgb, var(--c-surface-3) 65%, var(--c-surface-2));
  }

  .protocol-buttons button.active {
    border-color: color-mix(in srgb, var(--c-border-strong) 88%, var(--c-surface-3));
    background: color-mix(in srgb, var(--c-accent) 8%, var(--c-surface-2));
    color: var(--c-text-1);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-accent) 18%, transparent);
  }

  .protocol-buttons button.active .label {
    color: var(--c-accent);
  }

  .label {
    font-size: 0.8rem;
    font-weight: 500;
  }

  .desc {
    font-size: 0.65rem;
    color: inherit;
    opacity: 0.6;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .form-group label {
    font-size: 0.7rem;
    font-weight: 500;
    color: var(--c-text-1);
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }

  .serial-port-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: stretch;
    gap: 8px;
  }

  .serial-port-combobox {
    position: relative;
    width: 100%;
    min-width: 0;
  }

  .serial-port-combobox input {
    width: 100%;
    padding-right: 28px;
  }

  .serial-port-combobox::after {
    content: "";
    position: absolute;
    right: 10px;
    top: 50%;
    width: 10px;
    height: 6px;
    transform: translateY(-50%);
    pointer-events: none;
    opacity: 0.85;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%23c9cfda' d='M1 1l4 4 4-4'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-size: 10px 6px;
  }

  .serial-port-combobox:focus-within::after {
    opacity: 1;
  }

  .serial-port-list {
    position: absolute;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    z-index: 15;
    max-height: 180px;
    overflow-y: auto;
    border: 1px solid var(--c-border-strong);
    border-radius: 8px;
    background: var(--c-surface-2);
    box-shadow: 0 10px 24px color-mix(in srgb, var(--c-bg) 70%, transparent);
    padding: 4px;
  }

  .serial-port-option {
    width: 100%;
    text-align: left;
    border: 0;
    border-radius: 6px;
    padding: 6px 8px;
    background: transparent;
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.74rem;
    cursor: pointer;
  }

  .serial-port-option:hover {
    background: color-mix(in srgb, var(--c-accent) 12%, var(--c-surface-2));
  }

  .serial-port-empty {
    padding: 6px 8px;
    color: var(--c-text-2);
    font-size: 0.72rem;
  }

  input,
  select {
    border: 1px solid var(--c-border);
    border-radius: 6px;
    padding: 6px 8px;
    background: var(--c-surface-2);
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.75rem;
    line-height: 1.4;
  }

  select {
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath fill='%23c9cfda' d='M1 1l5 5 5-5'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 6px center;
    padding-right: 24px;
  }

  input::placeholder {
    color: var(--c-text-2);
    opacity: 0.5;
  }

  input:hover,
  select:hover {
    border-color: var(--c-border-strong);
  }

  input:focus,
  select:focus {
    outline: none;
    border-color: var(--c-accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--c-accent) 14%, transparent);
  }

  .form-row {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }

  .tcp-fields {
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }

  .tcp-host { flex: 1; }

  .tcp-port { width: 110px; }

  .device-fields {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    margin-top: 6px;
  }

  .slave-id-group { width: 110px; }

  .actions {
    flex: 1;
    display: flex;
    gap: 6px;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 36px;
    padding: 0 14px;
    flex: 1;
    border: 1px solid var(--c-border);
    border-radius: 8px;
    font: inherit;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 160ms ease;
    white-space: nowrap;
  }

  .btn-primary {
    border-color: color-mix(in srgb, var(--c-accent) 30%, var(--c-border));
    background: color-mix(in srgb, var(--c-accent) 18%, var(--c-surface-2));
    color: var(--c-accent);
  }

  .btn-primary:hover:not(:disabled) {
    border-color: var(--c-accent);
    background: color-mix(in srgb, var(--c-accent) 28%, var(--c-surface-2));
    color: var(--c-text-1);
  }

  .btn-secondary {
    border-color: color-mix(in srgb, var(--c-error) 30%, var(--c-border));
    background: color-mix(in srgb, var(--c-error) 12%, var(--c-surface-2));
    color: var(--c-error);
  }

  .btn-secondary:hover {
    border-color: var(--c-error);
    background: color-mix(in srgb, var(--c-error) 22%, var(--c-surface-2));
  }

  .btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-inline {
    min-height: 34px;
    padding: 0 10px;
    flex: 0;
    font-size: 0.7rem;
    font-weight: 500;
    border-color: color-mix(in srgb, var(--c-border) 85%, var(--c-surface-3));
    background: color-mix(in srgb, var(--c-surface-2) 90%, var(--c-bg));
    color: var(--c-text-2);
  }

  .btn-inline:hover:not(:disabled) {
    border-color: var(--c-border-strong);
    color: var(--c-text-1);
  }

  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid transparent;
    border-top-color: var(--c-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 767px) {
    .form-row {
      grid-template-columns: 1fr;
    }

    .protocol-buttons {
      grid-template-columns: 1fr;
    }
  }
</style>
