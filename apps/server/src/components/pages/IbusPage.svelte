<svelte:options runes={true} />

<script lang="ts">
  import { untrack } from "svelte";
  import {
    applyDescriptor,
    clearDescriptor,
    deriveDescriptorFromRegisters,
    derivedDescriptor,
    derivedDroppedPoints,
    emptyDescriptor,
    exportDescriptorJson,
    ibusState,
    importDescriptorJson,
    loadCurrentDescriptor,
    sampleDescriptor,
    setDescriptor,
    type IbusBlockType,
    type IbusDataType,
    type IbusManifestEntry,
    type IbusPointDesc,
  } from "../../state/ibus.svelte";
  import PageShell from "./PageShell.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";

  let jsonText = $state("");
  let jsonError = $state<string | null>(null);
  let showJson = $state(false);
  let liveMode = $state(false);

  const MANIFEST_BASE_MIN = 9040;
  const REGION_END = 9999;
  const REGION_END_PLUS_ONE = REGION_END + 1;
  const MANIFEST_ENTRY_REGS = 7;
  const POINT_DESC_REGS = 20;

  const manifestCount = $derived(ibusState.descriptor.manifest.length);
  const pointCount = $derived(ibusState.descriptor.points.length);
  const currentManifestAddr = $derived(
    Number.isFinite(ibusState.descriptor.manifestAddr)
      ? ibusState.descriptor.manifestAddr
      : MANIFEST_BASE_MIN,
  );
  const requiredRegs = $derived(manifestCount * MANIFEST_ENTRY_REGS + pointCount * POINT_DESC_REGS);
  const maxManifestAddrThatFits = $derived(REGION_END_PLUS_ONE - requiredRegs);
  const canFitInRegion = $derived(maxManifestAddrThatFits >= MANIFEST_BASE_MIN);
  const suggestedManifestAddr = $derived(
    canFitInRegion ? Math.max(MANIFEST_BASE_MIN, Math.min(currentManifestAddr, maxManifestAddrThatFits)) : MANIFEST_BASE_MIN,
  );
  const needsThrough = $derived(currentManifestAddr + requiredRegs - 1);
  const overflowsAtCurrentAddr = $derived(requiredRegs > 0 && needsThrough > REGION_END);
  const maxPointsAtMinAddr = $derived(Math.max(0, Math.floor((REGION_END_PLUS_ONE - MANIFEST_BASE_MIN - manifestCount * MANIFEST_ENTRY_REGS) / POINT_DESC_REGS)));
  const pointsToTrim = $derived(Math.max(0, pointCount - maxPointsAtMinAddr));

  $effect(() => {
    untrack(() => {
      void loadCurrentDescriptor();
    });
  });

  $effect(() => {
    if (showJson) {
      jsonText = JSON.stringify(ibusState.descriptor, null, 2);
    }
  });

  const blockTypes: IbusBlockType[] = ["HoldingRegister", "InputRegister", "Coil", "DiscreteInput"];
  const dataTypes: IbusDataType[] = [
    "Int16",
    "UInt16",
    "Int32",
    "UInt32",
    "Float32",
    "Ascii",
    "Bool",
    "Int64",
    "Float64",
  ];

  const FLAG_WRITABLE = 0x0001;
  const FLAG_PERSISTENT = 0x0004;

  const unitOptions: { code: number; label: string }[] = [
    { code: 0x05, label: "A — Amperes" },
    { code: 0x08, label: "V — Volts" },
    { code: 0x11, label: "Hz — Hertz" },
    { code: 0x1F, label: "W — Watts" },
    { code: 0x20, label: "kW — Kilowatts" },
    { code: 0x27, label: "kWh — Kilowatt-hours" },
    { code: 0x2F, label: "°C — Degrees Celsius" },
    { code: 0x31, label: "% — Percent" },
    { code: 0x3A, label: "m³/h — Cubic meters/hour" },
    { code: 0x62, label: "%RH — Relative Humidity" },
    { code: 0x70, label: "— No units" },
  ];

  const knownUnitCodes = new Set(unitOptions.map((u) => u.code));

  function unitLabel(code: number): string {
    const found = unitOptions.find((u) => u.code === code);
    return found ? found.label : `0x${code.toString(16).toUpperCase().padStart(2, "0")}`;
  }

  function loadSample(): void {
    setDescriptor(sampleDescriptor());
  }

  function clearLocal(): void {
    setDescriptor(emptyDescriptor());
  }

  function addManifestRow(): void {
    const entry: IbusManifestEntry = {
      blockType: "HoldingRegister",
      startAddress: 0,
      length: 1,
      name: "blk",
    };
    ibusState.descriptor.manifest = [...ibusState.descriptor.manifest, entry];
  }

  function removeManifestRow(idx: number): void {
    ibusState.descriptor.manifest = ibusState.descriptor.manifest.filter((_, i) => i !== idx);
  }

  function addPointRow(): void {
    const point: IbusPointDesc = {
      address: 0,
      blockType: "HoldingRegister",
      dataType: "Int16",
      scaleNum: 1,
      scaleDen: 1,
      unitCode: 0x70,
      flags: 0,
      name: "p",
      description: "",
    };
    ibusState.descriptor.points = [...ibusState.descriptor.points, point];
  }

  function removePointRow(idx: number): void {
    ibusState.descriptor.points = ibusState.descriptor.points.filter((_, i) => i !== idx);
  }

  async function applyJson(): Promise<void> {
    const ok = await importDescriptorJson(jsonText);
    if (ok) {
      jsonError = null;
      showJson = false;
    } else {
      jsonError = ibusState.lastError;
    }
  }

  async function exportJson(): Promise<void> {
    const text = await exportDescriptorJson();
    if (text) {
      jsonText = text;
      showJson = true;
    }
  }

  function applySuggestedManifestAddr(): void {
    if (!canFitInRegion) return;
    ibusState.descriptor.manifestAddr = suggestedManifestAddr;
  }

  async function applyDescriptorWithAutoFit(): Promise<void> {
    // If current address overflows but descriptor can fit in range, auto-adjust first.
    if (overflowsAtCurrentAddr && canFitInRegion) {
      ibusState.descriptor.manifestAddr = suggestedManifestAddr;
    }
    await applyDescriptor();
  }
</script>

<PageShell title="iBus" feature="iBus v1.1 publisher" icon="compass">
  <PanelFrame>
    {#snippet children()}
      <div class="ibus-toolbar mode-tabs">
        <button type="button" class:active={!liveMode} onclick={() => liveMode = false}>Manual editor</button>
        <button type="button" class:active={liveMode} onclick={() => liveMode = true}>Live (from registers)</button>
      </div>

      {#if liveMode}
        <div class="ibus-toolbar">
          <button type="button" class="primary" onclick={() => { setDescriptor(deriveDescriptorFromRegisters()); liveMode = false; }}>
            Use as base &amp; edit
          </button>
          <button type="button" class="primary" onclick={() => { setDescriptor(deriveDescriptorFromRegisters()); void applyDescriptorWithAutoFit(); }} disabled={ibusState.busy}>
            Apply &amp; Publish live
          </button>
        </div>

        {#if derivedDroppedPoints() > 0}
          <p class="error">
            Live descriptor auto-trimmed {derivedDroppedPoints()} point{derivedDroppedPoints() === 1 ? "" : "s"} to fit iBus region limits.
          </p>
        {/if}

        {#if derivedDescriptor().manifest.length === 0 && derivedDescriptor().points.length === 0}
          <p class="hint">No registers configured yet. Add entries on the Coils, DI, HR, or IR pages and they will appear here automatically.</p>
        {:else}
          <h3>Manifest ({derivedDescriptor().manifest.length} blocks)</h3>
          <table>
            <thead><tr><th>Block</th><th>Start</th><th>Len</th></tr></thead>
            <tbody>
              {#each derivedDescriptor().manifest as m}
                <tr><td>{m.blockType}</td><td>{m.startAddress}</td><td>{m.length}</td></tr>
              {/each}
            </tbody>
          </table>
          <h3>Points ({derivedDescriptor().points.length})</h3>
          <table>
            <thead><tr><th>Block</th><th>Addr</th><th>Type</th><th>Name</th><th>Desc</th></tr></thead>
            <tbody>
              {#each derivedDescriptor().points as p}
                <tr><td>{p.blockType}</td><td>{p.address}</td><td>{p.dataType}</td><td>{p.name}</td><td>{p.description}</td></tr>
              {/each}
            </tbody>
          </table>
        {/if}
      {:else}

      <div class="ibus-toolbar">
        <button type="button" onclick={loadSample} disabled={ibusState.busy}>Load sample</button>
        <button type="button" onclick={clearLocal} disabled={ibusState.busy}>Reset editor</button>
        <button type="button" onclick={exportJson} disabled={!ibusState.installed || ibusState.busy}>Export JSON</button>
        <button
          type="button"
          onclick={() => {
            showJson = !showJson;
            jsonError = null;
          }}
        >
          {showJson ? "Close JSON" : "Edit JSON"}
        </button>
        <span class="spacer"></span>
        <button type="button" class="primary" onclick={() => applyDescriptorWithAutoFit()} disabled={ibusState.busy}>Apply &amp; Publish</button>
        <button type="button" class="danger" onclick={() => clearDescriptor()} disabled={!ibusState.installed || ibusState.busy}>
          Uninstall
        </button>
      </div>

      {#if ibusState.lastError}
        <p class="error">{ibusState.lastError}</p>
      {/if}

      {#if !ibusState.lastError && ibusState.installed && ibusState.lastApply}
        <p class="ok">
          Installed. Manifest @ {ibusState.lastApply.manifestAddr}, points @ {ibusState.lastApply.pointAddr}
          {#if ibusState.lastApply.overlaps.length > 0}
            — {ibusState.lastApply.overlaps.length} overlap warning(s)
          {/if}
        </p>
      {:else if !ibusState.lastError && ibusState.installed}
        <p class="ok">Descriptor installed (loaded from disk).</p>
      {/if}

      {#if showJson}
        <textarea class="json" bind:value={jsonText} rows="18"></textarea>
        <div class="ibus-toolbar">
          <button type="button" class="primary" onclick={applyJson}>Apply JSON to editor</button>
          {#if jsonError}<span class="error">{jsonError}</span>{/if}
        </div>
      {:else}
        <h3>Identity</h3>
        <div class="grid4">
          <label>Device name<input type="text" bind:value={ibusState.descriptor.identity.deviceName} maxlength="16" /></label>
          <label>Vendor<input type="text" bind:value={ibusState.descriptor.identity.vendor} maxlength="8" /></label>
          <label>Model<input type="text" bind:value={ibusState.descriptor.identity.model} maxlength="8" /></label>
          <label>Firmware<input type="text" bind:value={ibusState.descriptor.identity.firmware} maxlength="4" /></label>
        </div>
        <label class="manifest-addr">
          Manifest address (≥ 9040, ≤ 9999)
          <input type="number" min="9040" max="9999" bind:value={ibusState.descriptor.manifestAddr} />
        </label>
        <div class="fit-row">
          {#if canFitInRegion}
            <span class="hint-inline">
              Auto-fit: valid manifest address range is {MANIFEST_BASE_MIN}..{maxManifestAddrThatFits}; suggested {suggestedManifestAddr}.
            </span>
            <button type="button" onclick={applySuggestedManifestAddr} disabled={ibusState.descriptor.manifestAddr === suggestedManifestAddr}>
              Auto
            </button>
          {:else}
            <span class="error-inline">
              Descriptor cannot fit even at {MANIFEST_BASE_MIN}. Remove at least {pointsToTrim} point{pointsToTrim === 1 ? "" : "s"}.
            </span>
          {/if}
        </div>

        <h3>Manifest</h3>
        <table>
          <thead>
            <tr><th>Block</th><th>Start</th><th>Len</th><th>Name (≤8)</th><th></th></tr>
          </thead>
          <tbody>
            {#each ibusState.descriptor.manifest as entry, idx}
              <tr>
                <td>
                  <select bind:value={entry.blockType}>
                    {#each blockTypes as bt}<option value={bt}>{bt}</option>{/each}
                  </select>
                </td>
                <td><input type="number" min="0" max="65535" bind:value={entry.startAddress} /></td>
                <td><input type="number" min="1" max="65535" bind:value={entry.length} /></td>
                <td><input type="text" maxlength="8" bind:value={entry.name} /></td>
                <td><button type="button" onclick={() => removeManifestRow(idx)}>×</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
        <button type="button" onclick={addManifestRow}>+ Add manifest row</button>

        <h3>Points</h3>
        <table>
          <thead>
            <tr>
              <th>Block</th><th>Addr</th><th>Type</th><th>Num</th><th>Den</th>
              <th>Unit</th><th>Flags</th><th>Name (≤12)</th><th>Desc (≤10)</th><th></th>
            </tr>
          </thead>
          <tbody>
            {#each ibusState.descriptor.points as point, idx}
              <tr>
                <td>
                  <select bind:value={point.blockType}>
                    {#each blockTypes as bt}<option value={bt}>{bt}</option>{/each}
                  </select>
                </td>
                <td><input type="number" min="0" max="65535" bind:value={point.address} /></td>
                <td>
                  <select bind:value={point.dataType}>
                    {#each dataTypes as dt}<option value={dt}>{dt}</option>{/each}
                  </select>
                </td>
                <td><input type="number" bind:value={point.scaleNum} /></td>
                <td><input type="number" bind:value={point.scaleDen} /></td>
                <td>
                  {#if knownUnitCodes.has(point.unitCode)}
                    <select bind:value={point.unitCode}>
                      {#each unitOptions as u}<option value={u.code}>{u.label}</option>{/each}
                    </select>
                  {:else}
                    <div class="unit-custom">
                      <select
                        value={-1}
                        onchange={(e) => {
                          const v = Number((e.target as HTMLSelectElement).value);
                          if (v !== -1) point.unitCode = v;
                        }}
                      >
                        <option value={-1}>{unitLabel(point.unitCode)}</option>
                        {#each unitOptions as u}<option value={u.code}>{u.label}</option>{/each}
                      </select>
                    </div>
                  {/if}
                </td>
                <td class="flags-cell">
                  <label class="flag-check" title="Writable (0x0001)">
                    <input
                      type="checkbox"
                      checked={!!(point.flags & FLAG_WRITABLE)}
                      onchange={(e) => {
                        if ((e.target as HTMLInputElement).checked) point.flags |= FLAG_WRITABLE;
                        else point.flags &= ~FLAG_WRITABLE;
                      }}
                    /> W
                  </label>
                  <label class="flag-check" title="Persistent (0x0004)">
                    <input
                      type="checkbox"
                      checked={!!(point.flags & FLAG_PERSISTENT)}
                      onchange={(e) => {
                        if ((e.target as HTMLInputElement).checked) point.flags |= FLAG_PERSISTENT;
                        else point.flags &= ~FLAG_PERSISTENT;
                      }}
                    /> P
                  </label>
                </td>
                <td><input type="text" maxlength="12" bind:value={point.name} /></td>
                <td><input type="text" maxlength="10" bind:value={point.description} /></td>
                <td><button type="button" onclick={() => removePointRow(idx)}>×</button></td>
              </tr>
            {/each}
          </tbody>
        </table>
        <button type="button" onclick={addPointRow}>+ Add point row</button>
      {/if}
      {/if}
    {/snippet}
  </PanelFrame>
</PageShell>

<style>
  .ibus-toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }
  .ibus-toolbar .spacer { flex: 1; }
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
  button.danger { color: var(--c-danger, #c33); }
  h3 { margin: 14px 0 6px 0; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--c-text-2); }
  .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .grid4 label, .manifest-addr { display: grid; gap: 4px; font-size: 0.72rem; color: var(--c-text-2); }
  .manifest-addr { max-width: 220px; margin-top: 8px; }
  .fit-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 6px;
  }
  .hint-inline {
    font-size: 0.72rem;
    color: var(--c-text-2);
  }
  .error-inline {
    font-size: 0.72rem;
    color: var(--c-danger, #c33);
  }
  input, select, textarea {
    background: var(--c-surface-1);
    color: var(--c-text-1);
    border: 1px solid var(--c-border);
    border-radius: 3px;
    padding: 4px 6px;
    font-size: 0.72rem;
    font-family: inherit;
  }
  textarea.json { width: 100%; font-family: ui-monospace, SFMono-Regular, monospace; }
  table { width: 100%; border-collapse: collapse; font-size: 0.7rem; }
  th, td { border-bottom: 1px solid var(--c-border); padding: 3px 4px; text-align: left; }
  th { color: var(--c-text-2); font-weight: 600; }
  td input[type="number"] { width: 70px; }
  td input[type="text"] { width: 100px; }
  .flags-cell { white-space: nowrap; }
  .flag-check { display: inline-flex; align-items: center; gap: 2px; font-size: 0.7rem; cursor: pointer; margin-right: 4px; }
  .flag-check input[type="checkbox"] { width: auto; padding: 0; }
  .error { color: var(--c-danger, #c33); font-size: 0.72rem; }
  .ok { color: var(--c-success, #2a8); font-size: 0.72rem; }
  .hint { color: var(--c-text-2); font-size: 0.75rem; font-style: italic; margin-top: 16px; }
  .mode-tabs { border-bottom: 1px solid var(--c-border); margin-bottom: 0; }
  .mode-tabs button { border-bottom: 2px solid transparent; border-radius: 4px 4px 0 0; }
  .mode-tabs button.active { border-bottom-color: var(--c-accent); color: var(--c-accent); }
</style>
