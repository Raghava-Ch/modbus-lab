<svelte:options runes={true} />

<script lang="ts">
  import { Cloud, Play, Square, Trash2, Plus } from "lucide-svelte";
  import SectionHeader from "../shared/SectionHeader.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";
  import {
    addMapping,
    appendBridgeLog,
    clampInterval,
    clampKeepAlive,
    clampPort,
    clearBridgeLog,
    cloudBridgeState,
    removeMapping,
    setBrokerField,
    updateMapping,
    startCloudBridge,
    stopCloudBridge,
    type BridgeDirection,
    type ModbusArea,
  } from "../../state/cloud-bridge.svelte";
  import { addLog } from "../../state/logs.svelte";
  import { notifyError, notifyInfo } from "../../state/notifications.svelte";
  import { connectionState } from "../../state/connection.svelte";

  let busy = $state(false);

  const canStart = $derived(
    !cloudBridgeState.status.running &&
      cloudBridgeState.broker.host.trim().length > 0 &&
      cloudBridgeState.broker.clientId.trim().length > 0 &&
      cloudBridgeState.mappings.length > 0,
  );

  const modbusConnected = $derived(connectionState.status === "connected");

  async function handleStart(): Promise<void> {
    if (!canStart || busy) return;
    busy = true;
    try {
      startCloudBridge();
      notifyInfo("Cloud bridge started.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notifyError(`Failed to start cloud bridge: ${message}`);
      addLog("error", `Cloud bridge start failed: ${message}`);
    } finally {
      busy = false;
    }
  }

  async function handleStop(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      stopCloudBridge();
      notifyInfo("Cloud bridge stopped.");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notifyError(`Failed to stop cloud bridge: ${message}`);
      addLog("error", `Cloud bridge stop failed: ${message}`);
    } finally {
      busy = false;
    }
  }

  function formatTimestamp(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString();
  }

  const directionOptions: { value: BridgeDirection; label: string }[] = [
    { value: "publish", label: "Publish (Modbus → MQTT)" },
    { value: "subscribe", label: "Subscribe (MQTT → Modbus)" },
    { value: "bidirectional", label: "Bidirectional" },
  ];

  const areaOptions: { value: ModbusArea; label: string; writable: boolean }[] = [
    { value: "coil", label: "Coil (FC01/05)", writable: true },
    { value: "discreteInput", label: "Discrete Input (FC02, read-only)", writable: false },
    { value: "holdingRegister", label: "Holding Register (FC03/06)", writable: true },
    { value: "inputRegister", label: "Input Register (FC04, read-only)", writable: false },
  ];
</script>

<div class="cloud-bridge-page">
  <SectionHeader title="Cloud Bridge" subtitle="Modbus ↔ MQTT">
    {#snippet actions()}
      <span class="status-badge" class:running={cloudBridgeState.status.running}
        class:connected={cloudBridgeState.status.connected}>
        <Cloud size={14} />
        {#if cloudBridgeState.status.running}
          {cloudBridgeState.status.connected ? "Connected" : "Connecting…"}
        {:else}
          Stopped
        {/if}
      </span>
    {/snippet}
  </SectionHeader>

  {#if !modbusConnected}
    <div class="warn-banner" role="alert">
      ⚠ Modbus is not connected. Open the <strong>Connection</strong> tab and connect to a device first;
      the bridge will publish empty / error values until then.
    </div>
  {/if}

  {#if cloudBridgeState.status.lastError}
    <div class="error-banner" role="alert">
      Last error: {cloudBridgeState.status.lastError}
    </div>
  {/if}

  <section class="cb-section">
    <SectionHeader title="Broker" subtitle="MQTT broker connection settings (in-memory only)" />
    <PanelFrame>
      {#snippet children()}
        <div class="form-grid">
          <label class="form-field">
            <span>Host</span>
            <input
              type="text"
              placeholder="broker.example.com"
              value={cloudBridgeState.broker.host}
              disabled={cloudBridgeState.status.running}
              oninput={(e) => setBrokerField("host", e.currentTarget.value)}
            />
          </label>
          <label class="form-field">
            <span>Port</span>
            <input
              type="number"
              min="1"
              max="65535"
              value={cloudBridgeState.broker.port}
              disabled={cloudBridgeState.status.running}
              oninput={(e) => setBrokerField("port", clampPort(Number(e.currentTarget.value)))}
            />
          </label>
          <label class="form-field">
            <span>WebSocket Path</span>
            <input
              type="text"
              placeholder="/mqtt"
              value={cloudBridgeState.broker.path}
              disabled={cloudBridgeState.status.running}
              oninput={(e) => setBrokerField("path", e.currentTarget.value)}
            />
          </label>
          <label class="form-field">
            <span>Client ID</span>
            <input
              type="text"
              value={cloudBridgeState.broker.clientId}
              disabled={cloudBridgeState.status.running}
              oninput={(e) => setBrokerField("clientId", e.currentTarget.value)}
            />
          </label>
          <label class="form-field">
            <span>Keep alive (s)</span>
            <input
              type="number"
              min="1"
              max="3600"
              value={cloudBridgeState.broker.keepAliveSecs}
              disabled={cloudBridgeState.status.running}
              oninput={(e) =>
                setBrokerField("keepAliveSecs", clampKeepAlive(Number(e.currentTarget.value)))}
            />
          </label>
          <label class="form-field">
            <span>Username (optional)</span>
            <input
              type="text"
              value={cloudBridgeState.broker.username}
              disabled={cloudBridgeState.status.running}
              oninput={(e) => setBrokerField("username", e.currentTarget.value)}
            />
          </label>
          <label class="form-field">
            <span>Password (optional)</span>
            <input
              type="password"
              value={cloudBridgeState.broker.password}
              disabled={cloudBridgeState.status.running}
              oninput={(e) => setBrokerField("password", e.currentTarget.value)}
            />
          </label>
          <label class="form-field checkbox">
            <input
              type="checkbox"
              checked={cloudBridgeState.broker.useTls}
              disabled={cloudBridgeState.status.running}
              onchange={(e) => setBrokerField("useTls", e.currentTarget.checked)}
            />
            <span>Use TLS (system root CAs)</span>
          </label>
        </div>

        <div class="actions">
          {#if cloudBridgeState.status.running}
            <button class="ctrl-btn danger" type="button" disabled={busy} onclick={handleStop}>
              <Square size={14} />
              <span>Stop</span>
            </button>
          {:else}
            <button
              class="ctrl-btn primary"
              type="button"
              disabled={!canStart || busy}
              onclick={handleStart}
            >
              <Play size={14} />
              <span>Start</span>
            </button>
          {/if}
          <span class="hint">
            Mappings: {cloudBridgeState.mappings.length} •
            {cloudBridgeState.status.running ? "Edits disabled while running" : "Stop to edit"}
          </span>
        </div>
      {/snippet}
    </PanelFrame>
  </section>

  <section class="cb-section">
    <SectionHeader title="Mappings" subtitle="Each row is one Modbus address ↔ MQTT topic">
      {#snippet actions()}
        <button
          class="ctrl-btn"
          type="button"
          disabled={cloudBridgeState.status.running}
          onclick={() => addMapping()}
        >
          <Plus size={14} />
          <span>Add Mapping</span>
        </button>
      {/snippet}
    </SectionHeader>

    <PanelFrame>
      {#snippet children()}
        {#if cloudBridgeState.mappings.length === 0}
          <p class="empty-note">No mappings yet — add one to start forwarding values.</p>
        {:else}
          <div class="mapping-list" role="list">
            {#each cloudBridgeState.mappings as mapping (mapping.id)}
              <div class="mapping-card" role="listitem">
                <div class="mapping-row">
                  <label class="form-field">
                    <span>Name</span>
                    <input
                      type="text"
                      value={mapping.name}
                      disabled={cloudBridgeState.status.running}
                      oninput={(e) => updateMapping(mapping.id, { name: e.currentTarget.value })}
                    />
                  </label>
                  <label class="form-field">
                    <span>Direction</span>
                    <select
                      value={mapping.direction}
                      disabled={cloudBridgeState.status.running}
                      onchange={(e) =>
                        updateMapping(mapping.id, {
                          direction: e.currentTarget.value as BridgeDirection,
                        })}
                    >
                      {#each directionOptions as opt}
                        <option value={opt.value}>{opt.label}</option>
                      {/each}
                    </select>
                  </label>
                  <label class="form-field">
                    <span>Modbus area</span>
                    <select
                      value={mapping.area}
                      disabled={cloudBridgeState.status.running}
                      onchange={(e) =>
                        updateMapping(mapping.id, { area: e.currentTarget.value as ModbusArea })}
                    >
                      {#each areaOptions as opt}
                        <option value={opt.value}>{opt.label}</option>
                      {/each}
                    </select>
                  </label>
                  <label class="form-field narrow">
                    <span>Address</span>
                    <input
                      type="number"
                      min="0"
                      max="65535"
                      value={mapping.address}
                      disabled={cloudBridgeState.status.running}
                      oninput={(e) =>
                        updateMapping(mapping.id, { address: Number(e.currentTarget.value) })}
                    />
                  </label>
                  <button
                    class="icon-btn danger"
                    type="button"
                    title="Remove mapping"
                    disabled={cloudBridgeState.status.running}
                    onclick={() => removeMapping(mapping.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>

                <div class="mapping-row mapping-row-meta">
                  <label class="form-field wide">
                    <span>MQTT topic (tokens: {`{client_id}, {area}, {address}, {name}`})</span>
                    <input
                      type="text"
                      value={mapping.topic}
                      disabled={cloudBridgeState.status.running}
                      oninput={(e) => updateMapping(mapping.id, { topic: e.currentTarget.value })}
                    />
                  </label>
                  <label class="form-field narrow">
                    <span>QoS</span>
                    <select
                      value={String(mapping.qos)}
                      disabled={cloudBridgeState.status.running}
                      onchange={(e) =>
                        updateMapping(mapping.id, {
                          qos: Number(e.currentTarget.value) as 0 | 1 | 2,
                        })}
                    >
                      <option value="0">0</option>
                      <option value="1">1</option>
                      <option value="2">2</option>
                    </select>
                  </label>
                  <label class="form-field narrow">
                    <span>Publish every (ms)</span>
                    <input
                      type="number"
                      min="100"
                      step="100"
                      value={mapping.publishIntervalMs}
                      disabled={cloudBridgeState.status.running ||
                        mapping.direction === "subscribe"}
                      oninput={(e) =>
                        updateMapping(mapping.id, {
                          publishIntervalMs: clampInterval(Number(e.currentTarget.value)),
                        })}
                    />
                  </label>
                  <label class="form-field checkbox">
                    <input
                      type="checkbox"
                      checked={mapping.retain}
                      disabled={cloudBridgeState.status.running ||
                        mapping.direction === "subscribe"}
                      onchange={(e) =>
                        updateMapping(mapping.id, { retain: e.currentTarget.checked })}
                    />
                    <span>Retain</span>
                  </label>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      {/snippet}
    </PanelFrame>
  </section>

  <section class="cb-section">
    <SectionHeader title="Live Traffic" subtitle="Most recent {cloudBridgeState.log.length} messages">
      {#snippet actions()}
        <button class="ctrl-btn" type="button" onclick={clearBridgeLog}>Clear</button>
      {/snippet}
    </SectionHeader>
    <PanelFrame>
      {#snippet children()}
        {#if cloudBridgeState.log.length === 0}
          <p class="empty-note">No bridge activity yet.</p>
        {:else}
          <div class="log-box mono">
            {#each cloudBridgeState.log.slice().reverse() as entry (entry.id)}
              <div class="log-line {entry.level}">
                <span class="log-time">{formatTimestamp(entry.timestamp)}</span>
                <span class="log-level">{entry.level.toUpperCase()}</span>
                <span class="log-msg">{entry.message}</span>
              </div>
            {/each}
          </div>
        {/if}
      {/snippet}
    </PanelFrame>
  </section>
</div>

<style>
  .cloud-bridge-page {
    display: grid;
    gap: 12px;
  }

  .cb-section {
    display: grid;
    gap: 8px;
  }

  .status-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid var(--c-border);
    background: var(--c-surface-2);
    color: var(--c-text-2);
    font-size: 0.74rem;
    font-weight: 600;
  }
  .status-badge.running {
    color: var(--c-text-1);
    border-color: color-mix(in srgb, var(--c-warn, #f0a500) 50%, var(--c-border));
    background: color-mix(in srgb, var(--c-warn, #f0a500) 12%, var(--c-surface-2));
  }
  .status-badge.connected {
    border-color: color-mix(in srgb, var(--c-accent) 60%, var(--c-border));
    background: color-mix(in srgb, var(--c-accent) 14%, var(--c-surface-2));
    color: var(--c-text-1);
  }

  .warn-banner,
  .error-banner {
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 0.8rem;
  }
  .warn-banner {
    border: 1px solid color-mix(in srgb, var(--c-warn, #f0a500) 35%, var(--c-border));
    background: color-mix(in srgb, var(--c-warn, #f0a500) 8%, var(--c-surface-2));
  }
  .error-banner {
    border: 1px solid color-mix(in srgb, var(--c-danger, #d9534f) 50%, var(--c-border));
    background: color-mix(in srgb, var(--c-danger, #d9534f) 12%, var(--c-surface-2));
  }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
    margin-top: 6px;
  }

  .form-field {
    display: grid;
    gap: 4px;
    font-size: 0.72rem;
    color: var(--c-text-2);
  }
  .form-field span {
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .form-field input[type="text"],
  .form-field input[type="number"],
  .form-field input[type="password"],
  .form-field select {
    height: 32px;
    border-radius: 6px;
    border: 1px solid var(--c-border);
    background: var(--c-surface-2);
    color: var(--c-text-1);
    padding: 0 8px;
    font-size: 0.85rem;
  }
  .form-field input:disabled,
  .form-field select:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .form-field.checkbox {
    flex-direction: row;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .form-field.checkbox span {
    white-space: nowrap;
  }
  .form-field.checkbox input {
    width: 16px;
    height: 16px;
  }
  .form-field.narrow {
    max-width: 140px;
  }
  .form-field.wide {
    flex: 1;
    min-width: 240px;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 10px;
  }
  .hint {
    font-size: 0.74rem;
    color: var(--c-text-2);
  }

  .ctrl-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 6px;
    border: 1px solid var(--c-border);
    background: var(--c-surface-2);
    color: var(--c-text-1);
    font-size: 0.78rem;
    cursor: pointer;
  }
  .ctrl-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .ctrl-btn.primary {
    border-color: color-mix(in srgb, var(--c-accent) 60%, var(--c-border));
    background: color-mix(in srgb, var(--c-accent) 12%, var(--c-surface-2));
  }
  .ctrl-btn.danger {
    border-color: color-mix(in srgb, var(--c-danger, #d9534f) 50%, var(--c-border));
    background: color-mix(in srgb, var(--c-danger, #d9534f) 12%, var(--c-surface-2));
  }
  .icon-btn {
    border: 1px solid var(--c-border);
    background: var(--c-surface-2);
    color: var(--c-text-1);
    border-radius: 6px;
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    align-self: end;
  }
  .icon-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .icon-btn.danger:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--c-danger, #d9534f) 60%, var(--c-border));
  }

  .mapping-list {
    display: grid;
    gap: 10px;
    margin-top: 6px;
  }
  .mapping-card {
    border: 1px solid var(--c-border);
    border-radius: 8px;
    padding: 10px;
    background: color-mix(in srgb, var(--c-surface-2) 60%, transparent);
    display: grid;
    gap: 8px;
  }
  .mapping-row {
    display: grid;
    grid-template-columns: minmax(180px, 1.1fr) minmax(220px, 1.25fr) minmax(220px, 1.25fr) minmax(
        96px,
        120px
      ) 32px;
    gap: 10px;
    align-items: end;
  }
  .mapping-row-meta {
    grid-template-columns: minmax(260px, 1fr) 72px minmax(160px, 180px) auto;
  }

  .mapping-row-meta .form-field.wide {
    min-width: 0;
  }
  .mapping-row-meta .form-field.narrow {
    max-width: none;
  }
  .mapping-row-meta .form-field.checkbox {
    justify-self: start;
    align-self: end;
    padding-bottom: 4px;
  }

  @media (max-width: 1200px) {
    .mapping-row {
      grid-template-columns: repeat(2, minmax(180px, 1fr));
    }
    .mapping-row .icon-btn {
      grid-column: 2;
      justify-self: end;
    }

    .mapping-row-meta {
      grid-template-columns: minmax(220px, 1fr) 72px minmax(140px, 170px) auto;
    }
  }

  @media (max-width: 760px) {
    .mapping-row,
    .mapping-row-meta {
      grid-template-columns: 1fr;
    }
    .mapping-row .icon-btn,
    .mapping-row-meta .form-field.checkbox {
      grid-column: auto;
      justify-self: start;
    }
    .mapping-row-meta .form-field.checkbox {
      padding-bottom: 0;
    }
  }

  .empty-note {
    margin: 8px 0 4px;
    color: var(--c-text-2);
    font-size: 0.8rem;
  }

  .log-box {
    max-height: 240px;
    overflow-y: auto;
    margin-top: 6px;
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--c-surface-2);
    border: 1px solid var(--c-border);
    font-size: 0.74rem;
    line-height: 1.45;
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono",
      "Courier New", monospace;
  }
  .log-line {
    display: grid;
    grid-template-columns: 64px 64px 1fr;
    gap: 8px;
    padding: 1px 0;
  }
  .log-line.warn {
    color: color-mix(in srgb, var(--c-warn, #f0a500) 80%, var(--c-text-1));
  }
  .log-line.error {
    color: color-mix(in srgb, var(--c-danger, #d9534f) 90%, var(--c-text-1));
  }
  .log-line.traffic {
    color: var(--c-text-2);
  }
  .log-time {
    color: var(--c-text-2);
  }
  .log-level {
    font-weight: 700;
    letter-spacing: 0.04em;
  }
</style>
