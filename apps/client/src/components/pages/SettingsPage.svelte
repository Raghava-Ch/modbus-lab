<svelte:options runes={true} />

<script lang="ts">
  import SectionHeader from "../shared/SectionHeader.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";
  import {
    DEFAULT_SETTINGS,
    resetSettingsToDefaults,
    setFeatureDefaults,
    setForcedLayoutMode,
    setGlobalPollingDefaultInterval,
    setGlobalPollingMaxAddressCount,
    setLogTimeFormat,
    setLogTimePrecision,
    setMaxRetainedLogEntries,
    setRememberLastFeatureState,
    setTcpHeartbeatEnabled,
    setTcpHeartbeatIdleAfterMs,
    setValueViewFormat,
    settingsState,
  } from "../../state/settings.svelte";

  function onNumberInput(value: string, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
</script>

<div class="settings-page">
  <SectionHeader
    title="Settings"
    subtitle="Global preferences for polling, defaults, formatting, and layout"
  />

  <PanelFrame>
    {#snippet children()}
      <div class="settings-grid">
        <section class="group">
          <h3>Global Polling</h3>
          <label>
            <span>Default poll interval (ms)</span>
            <input
              type="number"
              min="250"
              step="50"
              value={settingsState.polling.defaultIntervalMs}
              oninput={(e) => setGlobalPollingDefaultInterval(onNumberInput(e.currentTarget.value, settingsState.polling.defaultIntervalMs))}
            />
          </label>
          <label>
            <span>Disable polling above address count</span>
            <input
              type="number"
              min="1"
              step="1"
              value={settingsState.polling.maxAddressCountForPolling}
              oninput={(e) => setGlobalPollingMaxAddressCount(onNumberInput(e.currentTarget.value, settingsState.polling.maxAddressCountForPolling))}
            />
          </label>
        </section>

        <section class="group">
          <h3>TCP Health Check</h3>
          <label class="toggle-label">
            <input
              type="checkbox"
              checked={settingsState.tcpHealth.heartbeatEnabled}
              onchange={(e) => setTcpHeartbeatEnabled(e.currentTarget.checked)}
            />
            <span>
              Enable idle heartbeat check. When enabled, the app probes the server after no traffic and can mark connection down faster.
            </span>
          </label>
          <label>
            <span>Heartbeat idle time (ms) before probe</span>
            <input
              type="number"
              min="1000"
              step="500"
              value={settingsState.tcpHealth.heartbeatIdleAfterMs}
              disabled={!settingsState.tcpHealth.heartbeatEnabled}
              oninput={(e) => setTcpHeartbeatIdleAfterMs(onNumberInput(e.currentTarget.value, settingsState.tcpHealth.heartbeatIdleAfterMs))}
            />
          </label>
          <p class="note">
            Lower values detect outages sooner but increase background traffic. Higher values reduce probes but can delay "server down" updates.
          </p>
        </section>

        <section class="group">
          <h3>Display</h3>
          <label>
            <span>Address and value format</span>
            <select
              value={settingsState.valueViewFormat}
              onchange={(e) => setValueViewFormat(e.currentTarget.value as "dec" | "hex")}
            >
              <option value="dec">Decimal</option>
              <option value="hex">Hex</option>
            </select>
          </label>

          <label>
            <span>Force layout</span>
            <select
              value={settingsState.forcedLayoutMode}
              onchange={(e) => setForcedLayoutMode(e.currentTarget.value as "auto" | "desktop" | "mobile")}
            >
              <option value="auto">Auto</option>
              <option value="desktop">Horizontal</option>
              <option value="mobile">Vertical</option>
            </select>
          </label>
        </section>

        <section class="group">
          <h3>Logs</h3>
          <label>
            <span>Time format</span>
            <select
              value={settingsState.logs.timeFormat}
              onchange={(e) => setLogTimeFormat(e.currentTarget.value as "24h" | "12h")}
            >
              <option value="24h">24 hour</option>
              <option value="12h">12 hour</option>
            </select>
          </label>
          <label>
            <span>Precision</span>
            <select
              value={settingsState.logs.timePrecision}
              onchange={(e) => setLogTimePrecision(e.currentTarget.value as "s" | "ms")}
            >
              <option value="s">Seconds</option>
              <option value="ms">Milliseconds</option>
            </select>
          </label>
          <label>
            <span>Max retained log rows</span>
            <input
              type="number"
              min="200"
              step="100"
              value={settingsState.logs.maxRetainedEntries}
              oninput={(e) => setMaxRetainedLogEntries(onNumberInput(e.currentTarget.value, settingsState.logs.maxRetainedEntries))}
            />
          </label>
        </section>

        <section class="group group-wide">
          <h3>Feature Defaults</h3>

          <label class="toggle-label">
            <input
              type="checkbox"
              checked={settingsState.rememberLastFeatureState}
              onchange={(e) => setRememberLastFeatureState(e.currentTarget.checked)}
            />
            <span>Remember last feature state (view/start/count). If off, defaults below are always used on load.</span>
          </label>

          <div class="defaults-table">
            <div class="head">Feature</div>
            <div class="head">View</div>
            <div class="head">Start</div>
            <div class="head">Count</div>

            <div>Coils</div>
            <select
              value={settingsState.defaults.coils.view}
              onchange={(e) => setFeatureDefaults("coils", { view: e.currentTarget.value as "table" | "switch" })}
            >
              <option value="table">Table</option>
              <option value="switch">Switch</option>
            </select>
            <input
              type="number"
              min="0"
              max="65535"
              value={settingsState.defaults.coils.startAddress}
              oninput={(e) => setFeatureDefaults("coils", { startAddress: onNumberInput(e.currentTarget.value, settingsState.defaults.coils.startAddress) })}
            />
            <input
              type="number"
              min="1"
              max="65535"
              value={settingsState.defaults.coils.count}
              oninput={(e) => setFeatureDefaults("coils", { count: onNumberInput(e.currentTarget.value, settingsState.defaults.coils.count) })}
            />

            <div>Discrete Inputs</div>
            <select
              value={settingsState.defaults.discreteInputs.view}
              onchange={(e) => setFeatureDefaults("discreteInputs", { view: e.currentTarget.value as "table" | "switch" })}
            >
              <option value="table">Table</option>
              <option value="switch">Switch</option>
            </select>
            <input
              type="number"
              min="0"
              max="65535"
              value={settingsState.defaults.discreteInputs.startAddress}
              oninput={(e) => setFeatureDefaults("discreteInputs", { startAddress: onNumberInput(e.currentTarget.value, settingsState.defaults.discreteInputs.startAddress) })}
            />
            <input
              type="number"
              min="1"
              max="65535"
              value={settingsState.defaults.discreteInputs.count}
              oninput={(e) => setFeatureDefaults("discreteInputs", { count: onNumberInput(e.currentTarget.value, settingsState.defaults.discreteInputs.count) })}
            />

            <div>Holding Registers</div>
            <select
              value={settingsState.defaults.holdingRegisters.view}
              onchange={(e) => setFeatureDefaults("holdingRegisters", { view: e.currentTarget.value as "table" | "cards" })}
            >
              <option value="table">Table</option>
              <option value="cards">Cards</option>
            </select>
            <input
              type="number"
              min="0"
              max="65535"
              value={settingsState.defaults.holdingRegisters.startAddress}
              oninput={(e) => setFeatureDefaults("holdingRegisters", { startAddress: onNumberInput(e.currentTarget.value, settingsState.defaults.holdingRegisters.startAddress) })}
            />
            <input
              type="number"
              min="1"
              max="65535"
              value={settingsState.defaults.holdingRegisters.count}
              oninput={(e) => setFeatureDefaults("holdingRegisters", { count: onNumberInput(e.currentTarget.value, settingsState.defaults.holdingRegisters.count) })}
            />

            <div>Input Registers</div>
            <select
              value={settingsState.defaults.inputRegisters.view}
              onchange={(e) => setFeatureDefaults("inputRegisters", { view: e.currentTarget.value as "table" | "cards" })}
            >
              <option value="table">Table</option>
              <option value="cards">Cards</option>
            </select>
            <input
              type="number"
              min="0"
              max="65535"
              value={settingsState.defaults.inputRegisters.startAddress}
              oninput={(e) => setFeatureDefaults("inputRegisters", { startAddress: onNumberInput(e.currentTarget.value, settingsState.defaults.inputRegisters.startAddress) })}
            />
            <input
              type="number"
              min="1"
              max="65535"
              value={settingsState.defaults.inputRegisters.count}
              oninput={(e) => setFeatureDefaults("inputRegisters", { count: onNumberInput(e.currentTarget.value, settingsState.defaults.inputRegisters.count) })}
            />
          </div>
        </section>
      </div>
    {/snippet}
    {#snippet footer()}
      <div class="footer-actions">
        <button class="reset-btn" type="button" onclick={resetSettingsToDefaults}>Reset All To Defaults</button>
        <span class="hint">
          Default poll: {DEFAULT_SETTINGS.polling.defaultIntervalMs} ms, max polling count: {DEFAULT_SETTINGS.polling.maxAddressCountForPolling}, heartbeat idle: {DEFAULT_SETTINGS.tcpHealth.heartbeatIdleAfterMs} ms
        </span>
      </div>
    {/snippet}
  </PanelFrame>
</div>

<style>
  .settings-page {
    display: grid;
    gap: 10px;
  }

  .settings-grid {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(2, minmax(280px, 1fr));
  }

  .group {
    display: grid;
    gap: 8px;
    padding: 10px;
    border: 1px solid var(--c-border);
    border-radius: 10px;
    background: var(--c-surface-2);
  }

  .group-wide {
    grid-column: 1 / -1;
  }

  h3 {
    margin: 0;
    font-size: 0.84rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--c-text-2);
  }

  label {
    display: grid;
    gap: 4px;
  }

  label > span {
    font-size: 0.72rem;
    color: var(--c-text-2);
  }

  input,
  select {
    height: 30px;
    padding: 0 8px;
    border: 1px solid var(--c-border);
    border-radius: 6px;
    background: var(--c-surface-1);
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.75rem;
  }

  .toggle-label {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .toggle-label input {
    width: 16px;
    height: 16px;
    padding: 0;
  }

  .toggle-label span {
    font-size: 0.74rem;
    color: var(--c-text-1);
  }

  .defaults-table {
    display: grid;
    grid-template-columns: minmax(140px, 1fr) 140px 120px 120px;
    gap: 6px;
    align-items: center;
  }

  .head {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--c-text-2);
    font-weight: 700;
  }

  .footer-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .reset-btn {
    height: 30px;
    padding: 0 10px;
    border: 1px solid color-mix(in srgb, var(--c-error) 35%, var(--c-border));
    border-radius: 6px;
    background: color-mix(in srgb, var(--c-error) 10%, var(--c-surface-2));
    color: var(--c-error);
    font: inherit;
    font-size: 0.74rem;
    cursor: pointer;
  }

  .hint {
    font-size: 0.7rem;
    color: var(--c-text-2);
  }

  .note {
    margin: 0;
    font-size: 0.72rem;
    color: var(--c-text-2);
    line-height: 1.4;
  }

  @media (max-width: 860px) {
    .settings-grid {
      grid-template-columns: 1fr;
    }

    .defaults-table {
      grid-template-columns: 1fr;
    }

    .head {
      display: none;
    }

    .footer-actions {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>
