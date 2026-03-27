<svelte:options runes={true} />

<script lang="ts">
  import { Link2, LogOut } from "lucide-svelte";
  import {
    connectionState,
    setConnectionStatus,
    setProtocol,
    setSlaveId,
    updateTcpSettings,
    updateSerialSettings,
    type ModbusProtocol,
    type SerialParity,
  } from "../../state/connection.svelte";
  import { addLog } from "../../state/logs.svelte";
  import IconButton from "../shared/IconButton.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";
  import SectionHeader from "../shared/SectionHeader.svelte";

  let connecting = $state(false);

  async function handleConnect(): Promise<void> {
    connecting = true;
    setConnectionStatus("connecting");
    addLog("info", `Attempting ${connectionState.protocol.toUpperCase()} connection...`);

    await new Promise((resolve) => setTimeout(resolve, 1200));

    setConnectionStatus("connected");
    addLog("info", "Connection established successfully.");
    connecting = false;
  }

  function handleDisconnect(): void {
    setConnectionStatus("disconnected");
    addLog("info", "Connection closed.");
  }

  function handleProtocolChange(proto: ModbusProtocol): void {
    setProtocol(proto);
    addLog("info", `Protocol changed to ${proto.toUpperCase()}.`);
  }
</script>

<div class="connection-page">
  <SectionHeader title="Connection Settings" subtitle="Configure Modbus device connection">
    {#snippet actions()}
      <div class="connection-status" class:connected={connectionState.status === "connected"}>
        <span class="status-dot"></span>
        <span class="status-text">{connectionState.status}</span>
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
                  placeholder="192.168.1.20"
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
              <label for="serial-port">Port</label>
              <input
                id="serial-port"
                type="text"
                placeholder="/dev/ttyUSB0 or COM3"
                value={connectionState.serial.port}
                onchange={(e) => updateSerialSettings({ port: e.currentTarget.value })}
              />
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
