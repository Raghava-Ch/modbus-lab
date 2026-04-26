<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { Play, Square, RefreshCw, Users, Clock3, AlertTriangle } from "lucide-svelte";
  import {
    applyBackendConnectionStatus,
    connectionState,
    setConnectionStatus,
    setListenerClients,
    setListenerUptime,
    setProtocol,
    setSlaveId,
    updateSerialSettings,
    updateTcpSettings,
    type ModbusProtocol,
    type SerialParity,
  } from "../../state/connection.svelte";
  import { addLog } from "../../state/logs.svelte";
  import { syncCoilAddressesToBackend } from "../../state/coils.svelte";
  import { syncDiscreteInputAddressesToBackend } from "../../state/discrete-inputs.svelte";
  import { syncHoldingRegAddressesToBackend } from "../../state/holding-registers.svelte";
  import { syncInputRegAddressesToBackend } from "../../state/input-registers.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";
  import SectionHeader from "../shared/SectionHeader.svelte";

  interface ListenerStartRequest {
    transport: "tcp" | "serial-rtu" | "serial-ascii";
    bindAddress?: string;
    port?: number;
    unitId: number;
    responseTimeoutMs?: number;
    serialPort?: string;
    baudRate?: number;
    dataBits?: number;
    stopBits?: number;
    parity?: string;
  }

  interface ListenerStatus {
    status: string;
    details?: string;
    transport?: string;
    bindTarget?: string;
    unitId?: number;
    activeClients?: number;
    uptimeMs?: number;
    lastError?: string;
  }

  interface ListenerClientSession {
    id: string;
    endpoint: string;
    connectedAtMs: number;
  }

  interface ListenerClientsResponse {
    activeClients: number;
    sessions: ListenerClientSession[];
  }

  let busy = $state(false);
  let listingPorts = $state(false);
  let availableSerialPorts = $state<string[]>([]);
  let showSerialPortDropdown = $state(false);
  let nowMs = $state(Date.now());

  const filteredSerialPorts = $derived.by(() => {
    const query = connectionState.serial.port.trim().toLowerCase();
    if (!query) return availableSerialPorts;
    return availableSerialPorts.filter((p) => p.toLowerCase().includes(query));
  });

  function selectSerialPort(port: string): void {
    updateSerialSettings({ port });
    showSerialPortDropdown = false;
  }

  const canEdit = $derived(connectionState.listenerStatus === "idle" || connectionState.listenerStatus === "error");
  const listenerRunning = $derived(connectionState.listenerStatus === "running");
  const listenerStatusLabel = $derived(
    connectionState.listenerStatus === "running"
      ? "running"
      : connectionState.listenerStatus === "starting"
        ? "starting"
        : connectionState.listenerStatus === "error"
          ? "error"
          : "stopped",
  );

  const runtimeUptimeLabel = $derived.by(() => {
    const ms = connectionState.runtime.uptimeMs;
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) {
      return `${h}h ${m}m ${s}s`;
    }
    if (m > 0) {
      return `${m}m ${s}s`;
    }
    return `${s}s`;
  });

  function sessionDuration(connectedAtMs: number): string {
    const totalSeconds = Math.max(0, Math.floor((nowMs - connectedAtMs) / 1000));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function onProtocolChange(protocol: ModbusProtocol): void {
    if (!canEdit) return;
    setProtocol(protocol);
  }

  async function refreshSerialPorts(): Promise<void> {
    if (listingPorts) return;

    listingPorts = true;
    try {
      availableSerialPorts = await invoke<string[]>("list_serial_ports");
    } catch (err) {
      addLog("warn", `Failed to list serial ports: ${String(err)}`);
    } finally {
      listingPorts = false;
    }
  }

  async function refreshListenerRuntime(): Promise<void> {
    try {
      const status = await invoke<ListenerStatus>("listener_status");
      applyBackendConnectionStatus(status.status, status.details);
      if (typeof status.uptimeMs === "number") {
        setListenerUptime(status.uptimeMs);
      }

      const clients = await invoke<ListenerClientsResponse>("listener_clients");
      setListenerClients(clients.sessions);
    } catch {
      // Keep runtime refresh best-effort and silent.
    }
  }

  async function startListener(): Promise<void> {
    if (busy || !canEdit) return;

    busy = true;
    setConnectionStatus("connecting");

    try {
      const request: ListenerStartRequest = {
        transport: connectionState.protocol,
        bindAddress: connectionState.tcp.host.trim(),
        port: connectionState.tcp.port,
        unitId: connectionState.slaveId,
        responseTimeoutMs: connectionState.tcp.responseTimeoutMs,
        serialPort: connectionState.serial.port.trim(),
        baudRate: connectionState.serial.baudRate,
        dataBits: connectionState.serial.dataBits,
        stopBits: connectionState.serial.stopBits,
        parity: connectionState.serial.parity,
      };

      const response = await invoke<{ status: { status: string; details?: string } }>("listener_start", { request });
      applyBackendConnectionStatus(response.status.status, response.status.details);
      await refreshListenerRuntime();
      addLog("info", "Listener started.");
      // Sync all registered addresses to the fresh data store
      syncCoilAddressesToBackend();
      syncDiscreteInputAddressesToBackend();
      syncHoldingRegAddressesToBackend();
      syncInputRegAddressesToBackend();
    } catch (err) {
      applyBackendConnectionStatus("error", String(err));
      addLog("error", `Listener start failed: ${String(err)}`);
    } finally {
      busy = false;
    }
  }

  async function stopListener(): Promise<void> {
    if (busy) return;

    busy = true;
    try {
      const response = await invoke<{ status: { status: string; details?: string } }>("listener_stop", { request: {} });
      applyBackendConnectionStatus(response.status.status, response.status.details);
      setListenerClients([]);
      setListenerUptime(0);
      addLog("info", "Listener stopped.");
    } catch (err) {
      addLog("error", `Listener stop failed: ${String(err)}`);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    if (connectionState.protocol !== "tcp") {
      void refreshSerialPorts();
    }

    void refreshListenerRuntime();

    const timer = setInterval(() => {
      nowMs = Date.now();
      if (connectionState.listenerStatus === "running") {
        if (connectionState.runtime.startedAtMs) {
          setListenerUptime(nowMs - connectionState.runtime.startedAtMs);
        }
        void refreshListenerRuntime();
      }
    }, 1000);

    return () => clearInterval(timer);
  });
</script>

<div class="listener-page">
  <SectionHeader title="Listener" subtitle="Start/stop Modbus server listener and monitor active sessions">
    {#snippet actions()}
      <div class="header-status-cluster">
        <div class="listener-status" class:running={listenerRunning} class:error={connectionState.listenerStatus === "error"}>
          <span class="status-dot"></span>
          <span class="status-text">{listenerStatusLabel}</span>
        </div>
        <span class="status-chip"><Users size={13} /> {connectionState.runtime.activeClients} clients</span>
        {#if listenerRunning}
          <span class="status-chip"><Clock3 size={13} /> {runtimeUptimeLabel}</span>
        {/if}
      </div>
    {/snippet}
  </SectionHeader>

  <div class="forms-grid">
    <PanelFrame>
      {#snippet children()}
        <div class="section">
          <div class="section-title">Transport</div>
          <div class="protocol-buttons">
            <button class:active={connectionState.protocol === "tcp"} type="button" onclick={() => onProtocolChange("tcp")} disabled={!canEdit}>
              <span class="label">TCP</span>
              <span class="desc">Network listener</span>
            </button>
            <button class:active={connectionState.protocol === "serial-rtu"} type="button" onclick={() => onProtocolChange("serial-rtu")} disabled={!canEdit}>
              <span class="label">Serial RTU</span>
              <span class="desc">RTU line listener</span>
            </button>
            <button class:active={connectionState.protocol === "serial-ascii"} type="button" onclick={() => onProtocolChange("serial-ascii")} disabled={!canEdit}>
              <span class="label">Serial ASCII</span>
              <span class="desc">ASCII line listener</span>
            </button>
          </div>
        </div>
      {/snippet}
    </PanelFrame>

    <PanelFrame>
      {#snippet children()}
        <div class="section">
          <div class="section-title">Listener Config</div>

          {#if connectionState.protocol === "tcp"}
            <div class="form-row">
              <div class="form-group">
                <label for="bind-address">Bind Address</label>
                <input
                  id="bind-address"
                  type="text"
                  value={connectionState.tcp.host}
                  placeholder="0.0.0.0"
                  oninput={(e) => updateTcpSettings({ host: e.currentTarget.value })}
                  disabled={!canEdit}
                />
              </div>
              <div class="form-group">
                <label for="bind-port">Port</label>
                <input
                  id="bind-port"
                  type="number"
                  min="1"
                  max="65535"
                  value={connectionState.tcp.port}
                  oninput={(e) => updateTcpSettings({ port: Number(e.currentTarget.value) })}
                  disabled={!canEdit}
                />
              </div>
            </div>
          {:else}
            <div class="form-group">
              <label for="serial-port-input">Serial Port</label>
              <div class="serial-port-row">
                <div class="serial-port-combobox">
                  <input
                    id="serial-port-input"
                    type="text"
                    placeholder="COM3 or /dev/ttyUSB0"
                    value={connectionState.serial.port}
                    onfocus={() => (showSerialPortDropdown = true)}
                    oninput={(e) => {
                      updateSerialSettings({ port: e.currentTarget.value });
                      showSerialPortDropdown = true;
                    }}
                    onblur={() => setTimeout(() => { showSerialPortDropdown = false; }, 120)}
                    disabled={!canEdit}
                  />
                  {#if showSerialPortDropdown && canEdit}
                    <div class="serial-port-list" role="listbox">
                      {#if filteredSerialPorts.length === 0}
                        <div class="serial-port-empty">No detected ports match.</div>
                      {:else}
                        {#each filteredSerialPorts as port}
                          <button type="button" class="serial-port-option" onclick={() => selectSerialPort(port)}>
                            {port}
                          </button>
                        {/each}
                      {/if}
                    </div>
                  {/if}
                </div>
                <button class="btn btn-inline" type="button" onclick={() => void refreshSerialPorts()} disabled={listingPorts || !canEdit}>
                  <RefreshCw size={14} />
                  {listingPorts ? "Refreshing" : "Refresh"}
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
                  disabled={!canEdit}
                >
                  <option value="1200">1200</option>
                  <option value="2400">2400</option>
                  <option value="4800">4800</option>
                  <option value="9600">9600</option>
                  <option value="19200">19200</option>
                  <option value="38400">38400</option>
                  <option value="57600">57600</option>
                  <option value="115200">115200</option>
                  <option value="230400">230400</option>
                  <option value="460800">460800</option>
                  <option value="921600">921600</option>
                </select>
              </div>
              <div class="form-group">
                <label for="data-bits">Data Bits</label>
                <select
                  id="data-bits"
                  value={connectionState.serial.dataBits}
                  onchange={(e) => updateSerialSettings({ dataBits: Number(e.currentTarget.value) as 5 | 6 | 7 | 8 })}
                  disabled={!canEdit}
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
                  disabled={!canEdit}
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
                  disabled={!canEdit}
                >
                  <option value="none">None</option>
                  <option value="even">Even</option>
                  <option value="odd">Odd</option>
                </select>
              </div>
            </div>
          {/if}

          <div class="form-row">
            <div class="form-group">
              <label for="unit-id">Unit ID</label>
              <input
                id="unit-id"
                type="number"
                min="1"
                max="247"
                value={connectionState.slaveId}
                oninput={(e) => setSlaveId(Number(e.currentTarget.value))}
                disabled={!canEdit}
              />
            </div>
            <div class="form-group">
              <label for="listener-timeout">Response Timeout (ms)</label>
              <input
                id="listener-timeout"
                type="number"
                min="100"
                max="600000"
                value={connectionState.tcp.responseTimeoutMs}
                oninput={(e) => updateTcpSettings({ responseTimeoutMs: Number(e.currentTarget.value) })}
                disabled={!canEdit}
              />
            </div>
          </div>

          <div class="actions">
            {#if !listenerRunning}
              <button class="btn btn-primary" type="button" onclick={() => void startListener()} disabled={busy || !canEdit}>
                <Play size={16} />
                {busy ? "Starting..." : "Start Listener"}
              </button>
            {:else}
              <button class="btn btn-secondary" type="button" onclick={() => void stopListener()} disabled={busy}>
                <Square size={16} />
                {busy ? "Stopping..." : "Stop Listener"}
              </button>
            {/if}
          </div>

          {#if connectionState.runtime.lastError}
            <div class="error-box">
              <AlertTriangle size={15} />
              <span>{connectionState.runtime.lastError}</span>
            </div>
          {/if}
        </div>
      {/snippet}
    </PanelFrame>

    <PanelFrame>
      {#snippet children()}
        <div class="section">
          <div class="section-title">Active Client Sessions</div>
          {#if connectionState.sessions.length === 0}
            <div class="empty-state">No active client sessions.</div>
          {:else}
            <ul class="session-list">
              {#each connectionState.sessions as session}
                <li>
                  <span class="session-endpoint">{session.endpoint}</span>
                  <span class="session-meta">{sessionDuration(session.connectedAtMs)}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/snippet}
    </PanelFrame>
  </div>
</div>

<style>
  .listener-page {
    display: grid;
    gap: 14px;
  }

  .header-status-cluster {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .listener-status {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    border: 1px solid var(--c-border);
    border-radius: 999px;
    padding: 5px 10px;
    font-size: 0.78rem;
    text-transform: capitalize;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--c-error);
  }

  .listener-status.running .status-dot {
    background: var(--c-ok);
  }

  .listener-status.error .status-dot {
    background: var(--c-warn);
  }

  .status-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid var(--c-border);
    border-radius: 999px;
    padding: 5px 9px;
    font-size: 0.75rem;
    color: var(--c-text-2);
  }

  .forms-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  .section {
    display: grid;
    gap: 10px;
  }

  .section-title {
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--c-text-2);
  }

  .protocol-buttons {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .protocol-buttons button {
    border: 1px solid var(--c-border);
    border-radius: 10px;
    background: var(--c-surface-1);
    color: var(--c-text-1);
    padding: 10px;
    display: grid;
    gap: 3px;
    text-align: left;
  }

  .protocol-buttons button.active {
    border-color: color-mix(in srgb, var(--c-accent) 70%, var(--c-border));
    background: color-mix(in srgb, var(--c-accent) 10%, var(--c-surface-1));
  }

  .protocol-buttons .label {
    font-weight: 600;
    font-size: 0.86rem;
  }

  .protocol-buttons .desc {
    font-size: 0.72rem;
    color: var(--c-text-2);
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    align-items: end;
  }

  .form-group {
    display: grid;
    gap: 4px;
  }

  .form-group label {
    font-size: 0.72rem;
    color: var(--c-text-2);
  }

  .form-group input,
  .form-group select {
    width: 100%;
    min-height: 34px;
    border: 1px solid var(--c-border);
    border-radius: 8px;
    background: var(--c-surface-1);
    color: var(--c-text-1);
    padding: 7px 9px;
  }

  .btn {
    border: 1px solid var(--c-border);
    border-radius: 8px;
    min-height: 34px;
    padding: 0 12px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: var(--c-surface-1);
    color: var(--c-text-1);
  }

  .btn-primary {
    border-color: color-mix(in srgb, var(--c-accent) 75%, var(--c-border));
    background: color-mix(in srgb, var(--c-accent) 14%, var(--c-surface-1));
  }

  .actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }

  .error-box {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.78rem;
    color: var(--c-error);
    border: 1px solid color-mix(in srgb, var(--c-error) 45%, var(--c-border));
    background: color-mix(in srgb, var(--c-error) 10%, transparent);
    border-radius: 8px;
    padding: 8px 10px;
  }

  .empty-state {
    font-size: 0.8rem;
    color: var(--c-text-2);
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
    border: 1px solid var(--c-border);
    border-radius: 8px;
    background: var(--c-surface-2, var(--c-surface-1));
    box-shadow: 0 10px 24px rgba(0,0,0,0.3);
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
    background: color-mix(in srgb, var(--c-accent) 12%, var(--c-surface-1));
  }

  .serial-port-empty {
    padding: 6px 8px;
    color: var(--c-text-2);
    font-size: 0.72rem;
  }

  .session-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }

  .session-list li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border: 1px solid var(--c-border);
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 0.8rem;
  }

  .session-endpoint {
    color: var(--c-text-1);
  }

  .session-meta {
    color: var(--c-text-2);
    font-size: 0.72rem;
  }

  @media (max-width: 1100px) {
    .forms-grid {
      grid-template-columns: 1fr;
    }

    .protocol-buttons {
      grid-template-columns: 1fr;
    }

    .form-row {
      grid-template-columns: 1fr;
    }
  }
</style>
