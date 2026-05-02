<svelte:options runes={true} />

<script lang="ts">
  import {
    clearIbusState,
    ibusState,
    probeDevice,
    readAllPoints,
    applyDescriptorToRegisters,
    type EngineeringValue,
    type IbusPointDesc,
  } from "../../state/ibus.svelte";
  import { connectionState } from "../../state/connection.svelte";
  import PageShell from "./PageShell.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";

  let applyFeedback = $state<string | null>(null);

  function formatValue(reading: EngineeringValue | null, point: IbusPointDesc): string {
    if (!reading) return "—";
    // New serde shape from Rust: { kind: "number"|"bool"|"text", ... }
    if (typeof reading === "object" && reading !== null && "kind" in reading) {
      const tagged = reading as { kind?: string; value?: unknown };
      if (tagged.kind === "number" && typeof tagged.value === "number") {
        const v = tagged.value;
        const scaledDecimals = point.scaleDen > 1 ? Math.max(0, Math.floor(Math.log10(point.scaleDen))) : 0;
        switch (point.dataType) {
          case "Int16":
          case "UInt16":
          case "Int32":
          case "UInt32":
          case "Int64":
            return scaledDecimals > 0 ? v.toFixed(scaledDecimals) : String(Math.trunc(v));
          case "Float32":
          case "Float64": {
            const decimals = Math.max(scaledDecimals, 3);
            return v.toFixed(decimals);
          }
          default:
            return scaledDecimals > 0 ? v.toFixed(scaledDecimals) : String(v);
        }
      }
      if (tagged.kind === "bool" && typeof tagged.value === "boolean") {
        return tagged.value ? "ON" : "OFF";
      }
      if (tagged.kind === "text" && typeof tagged.value === "string") {
        return tagged.value;
      }
    }

    // Legacy shape fallback: { Number: ... } | { Bool: ... } | { Text: ... }
    if ("Number" in reading) {
      const v = reading.Number.value;
      const scaledDecimals = point.scaleDen > 1 ? Math.max(0, Math.floor(Math.log10(point.scaleDen))) : 0;
      switch (point.dataType) {
        case "Int16":
        case "UInt16":
        case "Int32":
        case "UInt32":
        case "Int64":
          return scaledDecimals > 0 ? v.toFixed(scaledDecimals) : String(Math.trunc(v));
        case "Float32":
        case "Float64": {
          const decimals = Math.max(scaledDecimals, 3);
          return v.toFixed(decimals);
        }
        default:
          return scaledDecimals > 0 ? v.toFixed(scaledDecimals) : String(v);
      }
    }
    if ("Bool" in reading) return reading.Bool ? "ON" : "OFF";
    if ("Text" in reading) return reading.Text;
    return "?";
  }

  async function probeAndRead(): Promise<void> {
    await probeDevice();
    if (ibusState.descriptor) {
      await readAllPoints();
    }
  }

  function levelClass(level: "Pass" | "Warn" | "Fail"): string {
    return level === "Pass" ? "ok" : level === "Warn" ? "warn" : "err";
  }

  function handleApplyToRegisters(): void {
    const n = applyDescriptorToRegisters();
    applyFeedback = n > 0
      ? `Added ${n} new entr${n === 1 ? "y" : "ies"} to register pages.`
      : "No new entries — all addresses already exist.";
    setTimeout(() => {
      applyFeedback = null;
    }, 4000);
  }

  function flagsLabel(point: IbusPointDesc): string {
    const parts: string[] = [];
    if (point.flags & 0x0001) parts.push("W");
    if (point.flags & 0x0004) parts.push("P");
    return parts.join("/") || "—";
  }
</script>

<PageShell title="iBus" feature="iBus v1.1 discovery" icon="compass">
  <PanelFrame>
    {#snippet children()}
      <div class="ibus-toolbar">
        <button
          type="button"
          class="primary"
          onclick={probeAndRead}
          disabled={ibusState.busy || connectionState.status !== "connected"}
        >
          Probe device (slave {connectionState.slaveId})
        </button>
        <button
          type="button"
          onclick={() => readAllPoints()}
          disabled={ibusState.busy || !ibusState.descriptor || connectionState.status !== "connected"}
        >
          Read all points
        </button>
        <button type="button" onclick={clearIbusState} disabled={ibusState.busy}>Clear</button>
        <button
          type="button"
          class="primary"
          onclick={handleApplyToRegisters}
          disabled={ibusState.busy || !ibusState.descriptor}
        >
          Apply to register pages
        </button>
        {#if applyFeedback}
          <span class="ok">{applyFeedback}</span>
        {/if}
        {#if ibusState.lastProbedAt}
          <span class="hint">Last probe: {new Date(ibusState.lastProbedAt).toLocaleTimeString()}</span>
        {/if}
      </div>

      {#if ibusState.lastError}
        <p class="error">{ibusState.lastError}</p>
      {/if}

      {#if ibusState.descriptor}
        <h3>Identity</h3>
        <table class="kv">
          <tbody>
            <tr><th>Device</th><td>{ibusState.descriptor.identity.deviceName}</td></tr>
            <tr><th>Vendor</th><td>{ibusState.descriptor.identity.vendor}</td></tr>
            <tr><th>Model</th><td>{ibusState.descriptor.identity.model}</td></tr>
            <tr><th>Firmware</th><td>{ibusState.descriptor.identity.firmware}</td></tr>
            <tr><th>Signature</th><td>0x{ibusState.signature?.toString(16).toUpperCase().padStart(4, "0")}</td></tr>
            <tr><th>Version</th><td>0x{ibusState.version?.toString(16).toUpperCase().padStart(4, "0")}</td></tr>
            <tr><th>Manifest @</th><td>{ibusState.descriptor.manifestAddr}</td></tr>
          </tbody>
        </table>

        <h3>Manifest</h3>
        <table>
          <thead><tr><th>Block</th><th>Start</th><th>Length</th><th>Name</th></tr></thead>
          <tbody>
            {#each ibusState.descriptor.manifest as entry}
              <tr>
                <td>{entry.blockType}</td>
                <td>{entry.startAddress}</td>
                <td>{entry.length}</td>
                <td>{entry.name}</td>
              </tr>
            {/each}
          </tbody>
        </table>

        <h3>Points</h3>
        <table>
          <thead>
            <tr>
              <th>Block</th><th>Addr</th><th>Type</th><th>Scale</th>
              <th>Unit</th><th>Flags</th><th>Name</th><th>Description</th><th>Value</th>
            </tr>
          </thead>
          <tbody>
            {#each ibusState.readings as reading}
              <tr>
                <td>{reading.point.blockType}</td>
                <td>{reading.point.address}</td>
                <td>{reading.point.dataType}</td>
                <td>{reading.point.scaleNum}/{reading.point.scaleDen}</td>
                <td>0x{reading.point.unitCode.toString(16).toUpperCase().padStart(2, "0")}</td>
                <td>{flagsLabel(reading.point)}</td>
                <td>{reading.point.name}</td>
                <td>{reading.point.description}</td>
                <td class={reading.error ? "err" : ""}>
                  {reading.error ? reading.error : formatValue(reading.value, reading.point)}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>

        <h3>Conformance</h3>
        <table>
          <thead><tr><th>ID</th><th>Level</th><th>Title</th><th>Message</th></tr></thead>
          <tbody>
            {#each ibusState.conformance as f}
              <tr>
                <td>{f.id}</td>
                <td><span class={levelClass(f.level)}>{f.level}</span></td>
                <td>{f.title}</td>
                <td>{f.message}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="hint">Probe a connected iBus device to discover its identity, manifest, and points.</p>
      {/if}
    {/snippet}
  </PanelFrame>
</PageShell>

<style>
  .ibus-toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  button {
    padding: 6px 10px;
    border: 1px solid var(--c-border);
    background: var(--c-surface-2);
    color: var(--c-text-1);
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.72rem;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.primary { background: var(--c-accent); color: var(--c-on-accent, #fff); border-color: var(--c-accent); }
  h3 { margin: 14px 0 6px 0; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--c-text-2); }
  table { width: 100%; border-collapse: collapse; font-size: 0.72rem; }
  th, td { border-bottom: 1px solid var(--c-border); padding: 4px 6px; text-align: left; }
  th { color: var(--c-text-2); font-weight: 600; }
  table.kv th { width: 130px; }
  .error { color: var(--c-danger, #c33); font-size: 0.72rem; }
  .ok { color: var(--c-success, #2a8); }
  .warn { color: var(--c-warn, #d80); }
  .err { color: var(--c-danger, #c33); }
  .hint { color: var(--c-text-2); font-size: 0.7rem; }
</style>
