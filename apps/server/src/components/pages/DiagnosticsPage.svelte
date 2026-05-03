<svelte:options runes={true} />

<script lang="ts">
  import PageShell from "./PageShell.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";
  import SectionHeader from "../shared/SectionHeader.svelte";
  import { getCurrentDeviceHealthSnapshot } from "../../state/connection-health.svelte";
  import { connectionState } from "../../state/connection.svelte";
  import { logState, type LogEntry } from "../../state/logs.svelte";
  import { formatLogTimestamp } from "../../state/settings.svelte";

  interface DiagnosticsFcMeta {
    code: number;
    hex: string;
    name: string;
    category: "serial" | "cross-protocol";
  }

  interface DiagnosticsBucket extends DiagnosticsFcMeta {
    total: number;
    rx: number;
    tx: number;
    exceptions: number;
    lastAt: number | null;
  }

  const DIAGNOSTIC_FUNCTIONS: DiagnosticsFcMeta[] = [
    { code: 0x07, hex: "07", name: "Read Exception Status", category: "serial" },
    { code: 0x08, hex: "08", name: "Diagnostics", category: "serial" },
    { code: 0x0b, hex: "0B", name: "Get Com Event Counter", category: "serial" },
    { code: 0x0c, hex: "0C", name: "Get Com Event Log", category: "serial" },
    { code: 0x11, hex: "11", name: "Report Server ID", category: "serial" },
    { code: 0x2b, hex: "2B", name: "Read Device Identification", category: "cross-protocol" },
  ];

  function parseFcCode(message: string | undefined | null): number | null {
    if (typeof message !== "string" || message.length === 0) return null;
    const m = message.match(/\bfc=0x([0-9A-Fa-f]{2})\b/);
    if (!m) return null;
    const parsed = Number.parseInt(m[1], 16);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  }

  function parseDirection(message: string | undefined | null): "rx" | "tx" | "other" {
    if (typeof message !== "string" || message.length === 0) return "other";
    const first = message.replace(/^\[.*?\]\s*/, "").split(" ")[0] ?? "";
    if (first.includes(".rx")) return "rx";
    if (first.includes(".tx")) return "tx";
    return "other";
  }

  function isDiagnosticTraffic(entry: LogEntry): boolean {
    if (entry.level !== "traffic") return false;
    const code = parseFcCode(entry.message);
    if (code == null) return false;
    const baseCode = code & 0x7f;
    return DIAGNOSTIC_FUNCTIONS.some((fc) => fc.code === baseCode);
  }

  function buildBuckets(entries: LogEntry[]): DiagnosticsBucket[] {
    return DIAGNOSTIC_FUNCTIONS.map((fc) => {
      const matching = entries.filter((entry) => {
        const code = parseFcCode(entry.message);
        if (code == null) return false;
        return (code & 0x7f) === fc.code;
      });

      const rx = matching.filter((entry) => parseDirection(entry.message) === "rx").length;
      const tx = matching.filter((entry) => parseDirection(entry.message) === "tx").length;
      const exceptions = matching.filter((entry) => entry.message.includes("exception=")).length;

      return {
        ...fc,
        total: matching.length,
        rx,
        tx,
        exceptions,
        lastAt: matching.length > 0 ? matching[matching.length - 1].timestamp : null,
      };
    });
  }

  function fallbackHealthSnapshot() {
    return {
      key: connectionState.protocol === "tcp"
        ? `tcp|${connectionState.tcp.host}:${connectionState.tcp.port}|slave=${connectionState.slaveId}`
        : `${connectionState.protocol}|${connectionState.serial.port}@${connectionState.serial.baudRate}|slave=${connectionState.slaveId}`,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      timeoutRate: 0,
      retryRate: 0,
      reconnectCount: 0,
      latestRttMs: null,
      medianRttMs: null,
      p95RttMs: null,
      qualityScore: 100,
      qualityBand: "good" as const,
      exceptionHistogram: [] as Array<{ code: string; count: number }>,
      tuningHints: ["Connection quality is stable. Keep current timeout/retry settings."],
    };
  }

  const safeEntries = $derived(Array.isArray(logState.entries) ? logState.entries : []);
  const diagnosticsTraffic = $derived(safeEntries.filter(isDiagnosticTraffic));
  const health = $derived.by(() => {
    try {
      return getCurrentDeviceHealthSnapshot();
    } catch {
      return fallbackHealthSnapshot();
    }
  });
  const diagnosticsBuckets = $derived(buildBuckets(diagnosticsTraffic));
  const serialBuckets = $derived(diagnosticsBuckets.filter((fc) => fc.category === "serial"));
  const fc43Bucket = $derived(diagnosticsBuckets.find((fc) => fc.code === 0x2b) ?? null);
  const recentDiagnosticsTraffic = $derived(diagnosticsTraffic.slice(-80).reverse());

  const diagnosticsOverview = $derived({
    total: diagnosticsTraffic.length,
    rx: diagnosticsTraffic.filter((entry) => parseDirection(entry.message) === "rx").length,
    tx: diagnosticsTraffic.filter((entry) => parseDirection(entry.message) === "tx").length,
    exceptions: diagnosticsTraffic.filter((entry) => entry.message.includes("exception=")).length,
  });
</script>

{#if connectionState.status === "disconnected"}
  <div class="disconnected-banner" role="alert">
    <span class="banner-icon">⚠</span>
    <span class="banner-text">Server not running. Start it in <strong>Listener</strong> to capture diagnostics traffic.</span>
  </div>
{/if}

<PageShell title="Diagnostics" feature="Server-side diagnostics from observed traffic" icon="stethoscope">
  {#snippet children()}

    <section class="diag-section">
      <SectionHeader title="Server Diagnostics Overview" subtitle="Passive view: counts are derived from received/sent server traffic, not active probe commands" />
      <PanelFrame>
        {#snippet children()}
          <div class="overview-grid">
            <article class="overview-card">
              <div class="label">Total Diagnostic Frames</div>
              <div class="value">{diagnosticsOverview.total}</div>
            </article>
            <article class="overview-card">
              <div class="label">RX Frames</div>
              <div class="value">{diagnosticsOverview.rx}</div>
            </article>
            <article class="overview-card">
              <div class="label">TX Frames</div>
              <div class="value">{diagnosticsOverview.tx}</div>
            </article>
            <article class="overview-card">
              <div class="label">Exception Responses</div>
              <div class="value warn">{diagnosticsOverview.exceptions}</div>
            </article>
          </div>
        {/snippet}
      </PanelFrame>
    </section>

    <section class="diag-section">
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
              <div class="health-label">Requests</div>
              <div class="health-value">{health.totalRequests} total | {health.successfulRequests} success | {health.failedRequests} failed</div>
            </div>

            <div class="health-card">
              <div class="health-label">RTT</div>
              <div class="health-value">latest {health.latestRttMs ?? "-"} ms | median {health.medianRttMs ?? "-"} ms | p95 {health.p95RttMs ?? "-"} ms</div>
            </div>

            <div class="health-card">
              <div class="health-label">Rates</div>
              <div class="health-value">timeout {(health.timeoutRate * 100).toFixed(1)}% | retry {(health.retryRate * 100).toFixed(1)}% | reconnects {health.reconnectCount}</div>
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
      <SectionHeader title="Serial-only Diagnostics" subtitle="FC07, FC08, FC11, FC12, FC17" />
      <div class="protocol-note" role="note">These function codes are serial-line diagnostics in Modbus. On TCP, values are shown only if a peer still sends them.</div>
      <PanelFrame>
        {#snippet children()}
          <div class="bucket-grid">
            {#each serialBuckets as item}
              <article class="bucket-card">
                <div class="bucket-head">
                  <span class="fc-chip">FC{item.hex}</span>
                  <span class="bucket-title">{item.name}</span>
                </div>
                <div class="bucket-row">total <strong>{item.total}</strong></div>
                <div class="bucket-row">rx <strong>{item.rx}</strong> | tx <strong>{item.tx}</strong></div>
                <div class="bucket-row">exceptions <strong>{item.exceptions}</strong></div>
                <div class="bucket-row">last seen <strong>{item.lastAt ? formatLogTimestamp(item.lastAt) : "-"}</strong></div>
              </article>
            {/each}
          </div>
        {/snippet}
      </PanelFrame>
    </section>

    <section class="diag-section">
      <SectionHeader title="FC43 Device Identification" subtitle="TCP + Serial" />
      <PanelFrame>
        {#snippet children()}
          {#if fc43Bucket}
            <div class="single-row">
              <span class="fc-chip">FC{fc43Bucket.hex}</span>
              <span class="bucket-title">{fc43Bucket.name}</span>
              <span class="stat">total <strong>{fc43Bucket.total}</strong></span>
              <span class="stat">rx <strong>{fc43Bucket.rx}</strong></span>
              <span class="stat">tx <strong>{fc43Bucket.tx}</strong></span>
              <span class="stat">exceptions <strong>{fc43Bucket.exceptions}</strong></span>
              <span class="stat">last seen <strong>{fc43Bucket.lastAt ? formatLogTimestamp(fc43Bucket.lastAt) : "-"}</strong></span>
            </div>
          {:else}
            <p class="empty-note">No FC43 traffic observed yet.</p>
          {/if}
        {/snippet}
      </PanelFrame>
    </section>

    <section class="diag-section diag-last">
      <SectionHeader title="Recent Diagnostic Traffic" subtitle="Latest FC07/08/11/12/17/43 frames from traffic log" />
      <PanelFrame>
        {#snippet children()}
          {#if recentDiagnosticsTraffic.length === 0}
            <p class="empty-note">No diagnostic traffic observed yet.</p>
          {:else}
            <div class="traffic-list" role="list">
              {#each recentDiagnosticsTraffic as entry (entry.id)}
                <div class="traffic-row" role="listitem">
                  <span class="time">{formatLogTimestamp(entry.timestamp)}</span>
                  <span class="msg">{entry.message}</span>
                </div>
              {/each}
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

  .diag-last {
    margin-bottom: 24px;
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

  .protocol-note {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    margin-bottom: 8px;
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--c-border-strong) 42%, var(--c-border));
    background: color-mix(in srgb, var(--c-surface-2) 78%, var(--c-surface-3));
    font-size: 0.78rem;
    color: var(--c-text-2);
  }

  .protocol-note::before {
    content: "i";
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--c-accent) 38%, var(--c-border));
    background: color-mix(in srgb, var(--c-accent) 16%, transparent);
    color: var(--c-text-1);
    font-size: 0.68rem;
    font-weight: 700;
    line-height: 1;
    flex-shrink: 0;
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

  .overview-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 8px;
  }

  .overview-card {
    border: 1px solid color-mix(in srgb, var(--c-border) 72%, transparent);
    border-radius: 8px;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--c-surface-2) 52%, transparent);
  }

  .label {
    font-size: 0.66rem;
    color: var(--c-text-2);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .value {
    font-size: 1rem;
    color: var(--c-text-1);
    margin-top: 4px;
    font-weight: 700;
  }

  .value.warn {
    color: var(--c-warn);
  }

  .bucket-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 8px;
  }

  .bucket-card {
    border: 1px solid color-mix(in srgb, var(--c-border) 72%, transparent);
    border-radius: 8px;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--c-surface-2) 52%, transparent);
    display: grid;
    gap: 3px;
  }

  .bucket-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }

  .fc-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 40px;
    height: 20px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--c-accent) 35%, var(--c-border));
    background: color-mix(in srgb, var(--c-accent) 12%, var(--c-surface-2));
    color: var(--c-text-1);
    font-size: 0.68rem;
    font-weight: 600;
  }

  .bucket-title {
    color: var(--c-text-1);
    font-size: 0.78rem;
    font-weight: 600;
  }

  .bucket-row {
    font-size: 0.75rem;
    color: var(--c-text-2);
  }

  .bucket-row strong {
    color: var(--c-text-1);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-weight: 700;
  }

  .single-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
    align-items: center;
    font-size: 0.76rem;
  }

  .stat {
    color: var(--c-text-2);
  }

  .stat strong {
    color: var(--c-text-1);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-weight: 700;
  }

  .traffic-list {
    display: grid;
    gap: 6px;
    max-height: 280px;
    overflow: auto;
  }

  .traffic-row {
    display: grid;
    grid-template-columns: 100px 1fr;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid color-mix(in srgb, var(--c-border) 72%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--c-surface-2) 52%, transparent);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 0.74rem;
  }

  .time {
    color: var(--c-text-2);
  }

  .msg {
    color: var(--c-text-1);
    line-height: 1.35;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .empty-note {
    margin: 0;
    color: var(--c-text-2);
    font-size: 0.78rem;
  }

  @media (max-width: 720px) {
    .traffic-row {
      grid-template-columns: 1fr;
    }
  }
</style>
