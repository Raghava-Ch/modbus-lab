<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from "svelte";
  import PageShell from "./PageShell.svelte";
  import SectionHeader from "../shared/SectionHeader.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";

  import {
    initDiagnosticsState,
    diagnosticsState,
    readExceptionStatus,
    runDiagnostic,
    getComEventCounter,
    getComEventLog,
    reportServerId,
    readDeviceIdentification,
    cancelDiagnosticsRead,
    setDiagnosticsPollActive,
    setDiagnosticsPollInterval,
  } from "../../state/diagnostics.svelte";
  import { connectionState } from "../../state/connection.svelte";
  import { getCurrentDeviceHealthSnapshot } from "../../state/connection-health.svelte";

  const isTcp = $derived(connectionState.protocol === "tcp");

  let fc08Subfunction = $state(0);
  let fc08Payload = $state("");
  let comLogStart = $state(0);
  let comLogCount = $state(50);
  // ReadDeviceIdCode: 1=Basic, 2=Regular, 3=Extended, 4=Individual
  let deviceIdLevel = $state(1);
  let deviceIdObject = $state<number | null>(null);

  const connected = $derived(connectionState.status === "connected");
  const health = $derived(getCurrentDeviceHealthSnapshot());

  onMount(() => {
    initDiagnosticsState();
  });
</script>

<PageShell title="Traffic" feature="Request/error analytics" icon="stethoscope">
  {#snippet children()}
    {#if connectionState.status === "disconnected"}
      <div class="disconnected-banner" role="alert">
        <span class="banner-icon">⚠</span>
        <span class="banner-text">Server not running — go to <strong>Listener</strong> and start the server to accept client connections.</span>
      </div>
    {/if}

    <section>
      <SectionHeader title="Connection Health" subtitle="RTT, timeout/retry pressure, exception histogram, and quality hints" />
      <PanelFrame>
        {#snippet children()}
          <div class="health-grid">
            <div class="health-card">
              <div class="health-label">Device</div>
              <div class="health-value health-key">{health.key}</div>
            </div>

            <div class="health-card">
              <div class="health-label">Quality</div>
              <div class={`health-value health-score ${health.qualityBand}`}>{health.qualityScore}/100 ({health.qualityBand})</div>
            </div>

            <div class="health-card">
              <div class="health-label">RTT</div>
              <div class="health-value">
                latest {health.latestRttMs ?? "-"} ms | median {health.medianRttMs ?? "-"} ms | p95 {health.p95RttMs ?? "-"} ms
              </div>
            </div>

            <div class="health-card">
              <div class="health-label">Rates</div>
              <div class="health-value">
                timeout {(health.timeoutRate * 100).toFixed(1)}% | retry {(health.retryRate * 100).toFixed(1)}% | reconnects {health.reconnectCount}
              </div>
            </div>

            <div class="health-card health-wide">
              <div class="health-label">Exception Histogram</div>
              {#if health.exceptionHistogram.length === 0}
                <div class="health-value">No exception codes observed.</div>
              {:else}
                <div class="histogram-list">
                  {#each health.exceptionHistogram as item}
                    <div class="histogram-row">
                      <span class="histogram-code">{item.code}</span>
                      <span class="histogram-bar" style={`--w:${Math.max(8, item.count * 10)}px`}></span>
                      <span class="histogram-count">{item.count}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>

            <div class="health-card health-wide">
              <div class="health-label">Tuning Hints</div>
              <ul class="hint-list">
                {#each health.tuningHints as hint}
                  <li>{hint}</li>
                {/each}
              </ul>
            </div>
          </div>
        {/snippet}
      </PanelFrame>
    </section>

    <section class="diag-section">
      <SectionHeader title="Exception Status (FC07)" subtitle="Read single-byte device exception status" />
      {#if isTcp}
        <div class="serial-only-note" role="note">Serial line only — defined for serial connections per Modbus spec. Support over TCP varies by device.</div>
      {/if}
      <PanelFrame>
        {#snippet children()}
          <div class="diag-actions wide-gap">
            <button onclick={() => void readExceptionStatus()} disabled={!connected || isTcp || diagnosticsState.readInProgress}>Read</button>
            <button onclick={() => cancelDiagnosticsRead()} disabled={!diagnosticsState.readInProgress}>Cancel</button>
            <label class="diag-inline-label offset">Poll
              <input
                type="checkbox"
                checked={diagnosticsState.pollActive}
                disabled={!connected || isTcp}
                onchange={(event) => setDiagnosticsPollActive((event.currentTarget as HTMLInputElement).checked)}
              />
            </label>
            <label class="diag-inline-label">
              Interval (ms)
              <input
                type="number"
                min="100"
                value={diagnosticsState.pollInterval}
                disabled={!connected || isTcp}
                onchange={(event) => setDiagnosticsPollInterval(Number((event.currentTarget as HTMLInputElement).value))}
              />
            </label>
          </div>

          {#if diagnosticsState.exceptionStatus}
            <div class="diag-result">
              <strong>Parsed:</strong>
              <pre>{JSON.stringify(diagnosticsState.exceptionStatus.parsed, null, 2)}</pre>
              <strong>Hex:</strong> <code>{diagnosticsState.exceptionStatus.rawHex}</code>
              {#if diagnosticsState.exceptionStatus.ascii}
                <div><strong>ASCII:</strong> {diagnosticsState.exceptionStatus.ascii}</div>
              {/if}
            </div>
          {/if}
        {/snippet}
      </PanelFrame>
    </section>

    <section class="diag-section">
      <SectionHeader title="Diagnostics (FC08)" subtitle="Support for various subfunctions; enter subfunction and optional payload" />
      {#if isTcp}
        <div class="serial-only-note" role="note">Serial line only — defined for serial connections per Modbus spec. Support over TCP varies by device.</div>
      {/if}
      <PanelFrame>
        {#snippet children()}
          <div class="diag-actions">
            <label class="diag-inline-label">Subfunction <input type="number" class="diag-input-field" bind:value={fc08Subfunction} min="0" max="255" /></label>
            <label class="diag-inline-label">Payload (hex) <input type="text" class="diag-input-field" bind:value={fc08Payload} placeholder="DE AD BE EF" /></label>
            <button onclick={() => void runDiagnostic(Number(fc08Subfunction), fc08Payload)} disabled={!connected || isTcp || diagnosticsState.readInProgress}>Run</button>
          </div>

          {#if diagnosticsState.lastDiagnostic}
            <div class="diag-result">
              <strong>Info:</strong>
              <pre>{JSON.stringify(diagnosticsState.lastDiagnostic.parsed, null, 2)}</pre>
              <strong>Hex:</strong> <code>{diagnosticsState.lastDiagnostic.rawHex}</code>
              {#if diagnosticsState.lastDiagnostic.ascii}
                <div><strong>ASCII:</strong> {diagnosticsState.lastDiagnostic.ascii}</div>
              {/if}
            </div>
          {/if}
        {/snippet}
      </PanelFrame>
    </section>

    <section class="diag-section">
      <SectionHeader title="Get Com Event Counter (FC11)" />
      {#if isTcp}
        <div class="serial-only-note" role="note">Serial line only — defined for serial connections per Modbus spec. Support over TCP varies by device.</div>
      {/if}
      <PanelFrame>
        {#snippet children()}
          <div class="diag-actions wide-gap">
            <button onclick={() => void getComEventCounter()} disabled={!connected || isTcp || diagnosticsState.readInProgress}>Read Counter</button>
          </div>
          {#if diagnosticsState.comEventCounter}
            <div class="diag-result">
              <pre>{JSON.stringify(diagnosticsState.comEventCounter.parsed, null, 2)}</pre>
              <strong>Hex:</strong> <code>{diagnosticsState.comEventCounter.rawHex}</code>
            </div>
          {/if}
        {/snippet}
      </PanelFrame>
    </section>

    <section class="diag-section">
      <SectionHeader title="Get Com Event Log (FC12)" subtitle="Paged event entries" />
      {#if isTcp}
        <div class="serial-only-note" role="note">Serial line only — defined for serial connections per Modbus spec. Support over TCP varies by device.</div>
      {/if}
      <PanelFrame>
        {#snippet children()}
          <div class="diag-actions">
            <label class="diag-inline-label">Start <input type="number" class="diag-input-field" bind:value={comLogStart} min="0" /></label>
            <label class="diag-inline-label">Count <input type="number" class="diag-input-field" bind:value={comLogCount} min="1" /></label>
            <button onclick={() => void getComEventLog(Number(comLogStart), Number(comLogCount))} disabled={!connected || isTcp || diagnosticsState.readInProgress}>Read Log</button>
          </div>
          {#if diagnosticsState.comEventLog.length > 0}
            <div class="diag-result">
              <ul class="diag-list">
                {#each diagnosticsState.comEventLog as entry, idx}
                  <li><strong>#{idx + 1}</strong> <code>{entry.rawHex}</code> {entry.ascii ? ` — ${entry.ascii}` : ""}</li>
                {/each}
              </ul>
            </div>
          {/if}
        {/snippet}
      </PanelFrame>
    </section>

    <section class="diag-section">
      <SectionHeader title="Report Server ID (FC17)" />
      {#if isTcp}
        <div class="serial-only-note" role="note">Serial line only — defined for serial connections per Modbus spec. Support over TCP varies by device.</div>
      {/if}
      <PanelFrame>
        {#snippet children()}
          <div class="diag-actions wide-gap">
            <button onclick={() => void reportServerId()} disabled={!connected || isTcp || diagnosticsState.readInProgress}>Read Server ID</button>
          </div>
          {#if diagnosticsState.serverId}
            <div class="diag-result">
              <pre>{JSON.stringify(diagnosticsState.serverId.parsed, null, 2)}</pre>
              <code>{diagnosticsState.serverId.rawHex}</code>
            </div>
          {/if}
        {/snippet}
      </PanelFrame>
    </section>

    <section class="diag-section diag-section-last">
      <SectionHeader title="Read Device Identification (FC43)" subtitle="Read device id objects — TCP and Serial" />
      <PanelFrame>
        {#snippet children()}
          <div class="diag-actions">
            <label class="diag-inline-label">
              Code
              <select class="diag-input-field" bind:value={deviceIdLevel}>
                <option value={1}>1 — Basic</option>
                <option value={2}>2 — Regular</option>
                <option value={3}>3 — Extended</option>
                <option value={4}>4 — Individual (needs Object ID)</option>
              </select>
            </label>
            <label class="diag-inline-label">Object ID <input type="number" class="diag-input-field" bind:value={deviceIdObject} min="0" max="255" placeholder="0" /></label>
            <button onclick={() => void readDeviceIdentification(Number(deviceIdLevel), deviceIdObject ?? undefined)} disabled={!connected || diagnosticsState.readInProgress}>Read</button>
          </div>

          {#if diagnosticsState.deviceIdentification}
            <div class="diag-result">
              <strong>Objects</strong>
              <pre>{JSON.stringify(diagnosticsState.deviceIdentification.parsed, null, 2)}</pre>
            </div>
          {/if}
        {/snippet}
      </PanelFrame>
    </section>
  {/snippet}
</PageShell>

<style>
  .diag-section {
    margin-top: 18px;
  }

  .diag-section-last {
    margin-bottom: 24px;
  }

  .diag-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }

  .diag-actions.wide-gap {
    gap: 12px;
  }

  .diag-actions button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 30px;
    padding: 0 10px;
    border: 1px solid color-mix(in srgb, var(--c-border) 78%, var(--c-surface-3));
    border-radius: 6px;
    background: color-mix(in srgb, var(--c-surface-1) 72%, var(--c-surface-2));
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
    transition: border-color 120ms ease, background 120ms ease;
  }

  .diag-actions button:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--c-border-strong) 68%, var(--c-surface-3));
    background: color-mix(in srgb, var(--c-surface-3) 62%, var(--c-surface-2));
  }

  .diag-actions button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .diag-inline-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.74rem;
    color: var(--c-text-2);
  }

  .diag-inline-label.offset {
    margin-left: 12px;
  }

  .diag-result {
    margin-top: 12px;
    display: grid;
    gap: 6px;
  }

  .diag-result pre {
    margin: 0;
    padding: 8px;
    border: 1px solid color-mix(in srgb, var(--c-border) 72%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--c-surface-2) 52%, transparent);
    color: var(--c-text-1);
    font-size: 0.75rem;
    overflow-x: auto;
  }

  .diag-result code {
    font-size: 0.74rem;
    color: var(--c-text-1);
  }

  .diag-list {
    margin: 0;
    padding-left: 18px;
    display: grid;
    gap: 4px;
  }

  .disconnected-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--c-warn, #f0a500) 35%, var(--c-border));
    background: color-mix(in srgb, var(--c-warn, #f0a500) 8%, var(--c-surface-2));
    color: var(--c-text-1);
    margin-bottom: 12px;
    font-size: 0.8rem;
  }

  .banner-icon {
    flex-shrink: 0;
    font-size: 1rem;
    line-height: 1;
  }

  .banner-text strong {
    color: var(--c-accent);
  }

  .diag-input-field {
    width: 120px;
    padding: 6px 8px;
    background: var(--c-surface-2);
    border: 1px solid var(--c-border);
    border-radius: 6px;
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.95rem;
  }

  .diag-input-field:focus {
    outline: none;
    border-color: var(--c-accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--c-accent) 25%, transparent);
  }

  .serial-only-note {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    margin-bottom: 4px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--c-border) 80%, transparent);
    background: color-mix(in srgb, var(--c-surface-3) 60%, transparent);
    font-size: 0.78rem;
    color: var(--c-text-2);
  }

  .serial-only-note::before {
    content: "ℹ";
    flex-shrink: 0;
    font-size: 0.9rem;
    color: var(--c-border-strong);
  }

  .health-grid {
    display: grid;
    gap: 8px;
  }

  .health-card {
    border: 1px solid color-mix(in srgb, var(--c-border) 72%, transparent);
    border-radius: 8px;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--c-surface-2) 52%, transparent);
  }

  .health-card.health-wide {
    grid-column: 1 / -1;
  }

  .health-label {
    font-size: 0.68rem;
    color: var(--c-text-2);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    margin-bottom: 3px;
  }

  .health-value {
    font-size: 0.82rem;
    color: var(--c-text-1);
  }

  .health-key {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 0.74rem;
    word-break: break-all;
  }

  .health-score.good { color: var(--c-ok); }
  .health-score.fair { color: var(--c-warn); }
  .health-score.poor { color: var(--c-error); }

  .histogram-list {
    display: grid;
    gap: 5px;
  }

  .histogram-row {
    display: grid;
    grid-template-columns: 52px 1fr 36px;
    align-items: center;
    gap: 6px;
    font-size: 0.75rem;
  }

  .histogram-code {
    color: var(--c-text-2);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  }

  .histogram-bar {
    height: 7px;
    width: var(--w);
    border-radius: 999px;
    background: color-mix(in srgb, var(--c-accent) 62%, var(--c-surface-2));
  }

  .histogram-count {
    text-align: right;
    color: var(--c-text-2);
  }

  .hint-list {
    margin: 0;
    padding-left: 18px;
    display: grid;
    gap: 4px;
    font-size: 0.8rem;
    color: var(--c-text-2);
  }
</style>
