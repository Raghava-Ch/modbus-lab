<svelte:options runes={true} />

<script lang="ts">
  import { untrack } from "svelte";
  import { ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-svelte";
  import PageShell from "./PageShell.svelte";
  import SectionHeader from "../shared/SectionHeader.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";
  import { connectionState } from "../../state/connection.svelte";
  import {
    addFifoAddress,
    addFifoSnapshotLink,
    clearFifoAddressQueue,
    fifoState,
    getActiveFifoEntry,
    initFifoState,
    removeFifoAddress,
    removeFifoSnapshotLink,
    setFifoSnapshotLinkEnabled,
    setFifoSnapshotLinkInterval,
    setFifoAddressQueue,
    setActiveFifoAddress,
    type FifoSnapshotSource,
    type FifoSnapshotTrigger,
  } from "../../state/fifo.svelte";
  import { formatAddressWithSettings, formatLogTimestamp } from "../../state/settings.svelte";

  let newAddressInput = $state("");
  let queueEditInput = $state("");
  let queueEditError = $state<string | null>(null);
  let lastSyncedAddress = $state<number | null>(null);
  let queueManageOpen = $state(false);
  let linkSource = $state<FifoSnapshotSource>("holding-register");
  let linkSourceAddress = $state(0);
  let linkTargetFifoAddress = $state(0);
  let linkTrigger = $state<FifoSnapshotTrigger>("on-change");
  let linkIntervalMs = $state(1000);
  let linkEditorOpen = $state(false);

  $effect(() => {
    untrack(() => {
      initFifoState();
    });
  });

  const activeEntry = $derived(getActiveFifoEntry());
  const queueEntries = $derived(
    fifoState.entries.filter((entry) => fifoState.addresses.includes(entry.address)),
  );
  const activeEntryLinks = $derived(
    activeEntry ? fifoState.snapshotLinks.filter((link) => link.fifoAddress === activeEntry.address) : [],
  );

  $effect(() => {
    const address = activeEntry?.address ?? null;
    if (address === null) {
      queueEditInput = "";
      queueEditError = null;
      lastSyncedAddress = null;
      return;
    }

    if (address !== lastSyncedAddress) {
      queueEditInput = (activeEntry?.values ?? []).join(", ");
      queueEditError = null;
      lastSyncedAddress = address;
    }
  });

  $effect(() => {
    if (!fifoState.addresses.includes(linkTargetFifoAddress)) {
      linkTargetFifoAddress = fifoState.activeAddress;
    }
  });

  function addAddressFromInput(): void {
    const parsed = Number(newAddressInput.trim());
    if (!Number.isFinite(parsed)) return;
    const added = addFifoAddress(parsed);
    if (added) {
      newAddressInput = "";
    }
  }

  function addSnapshotLink(): void {
    addFifoSnapshotLink({
      source: linkSource,
      sourceAddress: linkSourceAddress,
      fifoAddress: linkTargetFifoAddress,
      trigger: linkTrigger,
      intervalMs: linkIntervalMs,
    });
  }

  function addSnapshotLinkForActiveEntry(): void {
    if (!activeEntry) return;
    addFifoSnapshotLink({
      source: linkSource,
      sourceAddress: linkSourceAddress,
      fifoAddress: activeEntry.address,
      trigger: linkTrigger,
      intervalMs: linkIntervalMs,
    });
  }

  function sourceShortLabel(source: FifoSnapshotSource): string {
    return source === "holding-register" ? "HR" : "IR";
  }

  function sourceLongLabel(source: FifoSnapshotSource): string {
    return source === "holding-register" ? "Holding Register" : "Input Register";
  }

  function triggerLabel(trigger: FifoSnapshotTrigger): string {
    if (trigger === "on-change") return "On Change";
    if (trigger === "interval") return "Interval";
    return "Hybrid";
  }

  function formatWordHex(value: number): string {
    const normalized = Math.max(0, Math.min(65535, Math.floor(value)));
    return `0x${normalized.toString(16).toUpperCase().padStart(4, "0")}`;
  }

  function formatAddressHex(value: number): string {
    const normalized = Math.max(0, Math.min(65535, Math.floor(value)));
    return `0x${normalized.toString(16).toUpperCase().padStart(4, "0")}`;
  }

  function parseQueueEditorValues(raw: string): number[] | null {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return [];

    const tokens = trimmed
      .split(/[\s,;]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);

    if (tokens.length > 31) {
      queueEditError = "Maximum 31 values allowed by FC24.";
      return null;
    }

    const parsed: number[] = [];
    for (const token of tokens) {
      const value = Number(token);
      if (!Number.isFinite(value) || value < 0 || value > 65535) {
        queueEditError = `Invalid value '${token}'. Use integers from 0 to 65535.`;
        return null;
      }
      parsed.push(Math.floor(value));
    }

    queueEditError = null;
    return parsed;
  }

  async function applyQueueEdit(): Promise<void> {
    if (!activeEntry) return;
    const parsed = parseQueueEditorValues(queueEditInput);
    if (!parsed) return;
    await setFifoAddressQueue(activeEntry.address, parsed);
    queueEditInput = parsed.join(", ");
  }

  async function clearQueueEdit(): Promise<void> {
    if (!activeEntry) return;
    queueEditError = null;
    queueEditInput = "";
    await clearFifoAddressQueue(activeEntry.address);
  }

  // ── Generator ────────────────────────────────────────────────────────────
  type GenRule = "constant" | "sequential" | "ramp" | "sine" | "random";
  let genRule = $state<GenRule>("sequential");
  let genCount = $state(8);
  let genMin = $state(0);
  let genMax = $state(100);
  let genStep = $state(1);
  let genOpen = $state(false);

  function clampU16(v: number): number {
    return Math.max(0, Math.min(65535, Math.round(v)));
  }

  function runGenerator(): void {
    const count = Math.max(1, Math.min(31, Math.floor(genCount)));
    const lo = Math.max(0, Math.min(65535, Math.floor(genMin)));
    const hi = Math.max(0, Math.min(65535, Math.floor(genMax)));
    const step = Math.max(1, Math.floor(genStep));
    const result: number[] = [];

    if (genRule === "constant") {
      for (let i = 0; i < count; i++) result.push(clampU16(lo));
    } else if (genRule === "sequential") {
      for (let i = 0; i < count; i++) result.push(clampU16(lo + i * step));
    } else if (genRule === "ramp") {
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0 : i / (count - 1);
        result.push(clampU16(lo + t * (hi - lo)));
      }
    } else if (genRule === "sine") {
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0 : i / (count - 1);
        const s = (Math.sin(t * 2 * Math.PI) + 1) / 2;
        result.push(clampU16(lo + s * (hi - lo)));
      }
    } else if (genRule === "random") {
      const range = Math.max(1, hi - lo);
      for (let i = 0; i < count; i++) result.push(clampU16(lo + Math.floor(Math.random() * (range + 1))));
    }

    queueEditInput = result.join(", ");
    queueEditError = null;
  }
</script>

{#if connectionState.status === "disconnected"}
  <div class="disconnected-banner" role="alert">
    <span class="banner-icon">⚠</span>
    <span class="banner-text">Server not running — go to <strong>Listener</strong> and start the server to accept client connections.</span>
  </div>
{/if}

<PageShell title="FIFO Queue" feature="FC 24 queue monitor" icon="layers">
  {#snippet children()}

    <section class="fifo-section data-section">
      <SectionHeader
        title="Queue Data"
        subtitle={`Configured queues: ${fifoState.addresses.length} | Active: ${formatAddressWithSettings(fifoState.activeAddress)}`}
      >
        {#snippet actions()}
          <button class="ctrl-btn" type="button" onclick={() => { queueManageOpen = !queueManageOpen; }}>
            <SlidersHorizontal size={13} />
            <span>Queue Controls</span>
            {#if queueManageOpen}<ChevronUp size={12} />{:else}<ChevronDown size={12} />{/if}
          </button>
        {/snippet}
      </SectionHeader>
      {#if queueManageOpen}
        <PanelFrame>
          {#snippet children()}
            <div class="manage-panel">
              <div class="add-controls">
                <label class="field-label" for="fifo-address-input">FIFO address</label>
                <input
                  id="fifo-address-input"
                  class="num-input"
                  type="number"
                  min="0"
                  max="65535"
                  placeholder="e.g. 120"
                  value={newAddressInput}
                  oninput={(e) => { newAddressInput = e.currentTarget.value; }}
                  onkeydown={(e) => { if (e.key === "Enter") addAddressFromInput(); }}
                />
                <button class="ctrl-btn" type="button" onclick={addAddressFromInput}>Add Queue</button>
              </div>
              <div class="address-list" role="list" aria-label="FIFO address list">
                {#each fifoState.addresses as address (address)}
                  <div class="address-chip" role="listitem" class:active={fifoState.activeAddress === address}>
                    <button class="chip-main" type="button" onclick={() => setActiveFifoAddress(address)}>
                      <span class="chip-dec">{formatAddressWithSettings(address)}</span>
                      <span class="chip-hex">{formatAddressHex(address)}</span>
                    </button>
                    <button
                      class="chip-remove"
                      type="button"
                      title="Remove address"
                      onclick={() => removeFifoAddress(address)}
                      disabled={fifoState.addresses.length <= 1}
                    >
                      x
                    </button>
                  </div>
                {/each}
              </div>

              <div class="link-panel">
                <div class="link-title">Snapshot Links</div>
                <p class="link-help">Link holding/input registers into a FIFO queue on value change, interval, or both.</p>
                <div class="link-controls">
                  <div class="link-field">
                    <label class="field-label" for="link-source-type">Source</label>
                    <select id="link-source-type" class="gen-select link-select" value={linkSource} onchange={(e) => { linkSource = e.currentTarget.value as FifoSnapshotSource; }}>
                      <option value="holding-register">Holding Register</option>
                      <option value="input-register">Input Register</option>
                    </select>
                  </div>

                  <div class="link-field">
                    <label class="field-label" for="link-source-address">Source Addr</label>
                    <input id="link-source-address" class="num-input link-num" type="number" min="0" max="65535" value={linkSourceAddress} oninput={(e) => { linkSourceAddress = Number(e.currentTarget.value); }} />
                  </div>

                  <div class="link-field">
                    <label class="field-label" for="link-target-fifo">FIFO Addr</label>
                    <select id="link-target-fifo" class="gen-select link-select" value={linkTargetFifoAddress} onchange={(e) => { linkTargetFifoAddress = Number(e.currentTarget.value); }}>
                      {#each fifoState.addresses as address (address)}
                        <option value={address}>{formatAddressWithSettings(address)}</option>
                      {/each}
                    </select>
                  </div>

                  <div class="link-field">
                    <label class="field-label" for="link-trigger">Trigger</label>
                    <select id="link-trigger" class="gen-select link-select" value={linkTrigger} onchange={(e) => { linkTrigger = e.currentTarget.value as FifoSnapshotTrigger; }}>
                      <option value="on-change">On Change</option>
                      <option value="interval">Interval</option>
                      <option value="hybrid">Hybrid</option>
                    </select>
                  </div>

                  {#if linkTrigger !== "on-change"}
                    <div class="link-field">
                      <label class="field-label" for="link-interval">Interval ms</label>
                      <input id="link-interval" class="num-input link-num" type="number" min="200" max="60000" value={linkIntervalMs} oninput={(e) => { linkIntervalMs = Number(e.currentTarget.value); }} />
                    </div>
                  {/if}

                  <div class="link-action">
                    <button class="ctrl-btn" type="button" onclick={addSnapshotLink}>Add Link</button>
                  </div>
                </div>

                {#if fifoState.snapshotLinks.length === 0}
                  <p class="link-empty">No snapshot links configured.</p>
                {:else}
                  <div class="link-list" role="list" aria-label="Snapshot links">
                    {#each fifoState.snapshotLinks as link (link.id)}
                      <div class="link-item" role="listitem">
                        <label class="link-toggle">
                          <input type="checkbox" checked={link.enabled} onchange={(e) => setFifoSnapshotLinkEnabled(link.id, (e.currentTarget as HTMLInputElement).checked)} />
                          <span class="link-toggle-label">{link.enabled ? "On" : "Off"}</span>
                        </label>
                        <div class="link-summary">
                          <span class="link-pill source-pill">{sourceShortLabel(link.source)}</span>
                          <span class="mono link-route">{formatAddressWithSettings(link.sourceAddress)} -&gt; FIFO {formatAddressWithSettings(link.fifoAddress)}</span>
                          <span class="link-pill trigger-pill">{triggerLabel(link.trigger)}</span>
                        </div>
                        <div class="link-controls-inline">
                          {#if link.trigger !== "on-change"}
                            <label class="link-inline-label">
                              <span>Interval</span>
                              <input class="num-input link-item-interval" type="number" min="200" max="60000" value={link.intervalMs} oninput={(e) => setFifoSnapshotLinkInterval(link.id, Number(e.currentTarget.value))} />
                            </label>
                          {/if}
                          <span class="link-meta">Dropped {link.droppedSamples}</span>
                          <button class="ctrl-btn" type="button" onclick={() => removeFifoSnapshotLink(link.id)}>Remove</button>
                        </div>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
          {/snippet}
        </PanelFrame>
      {/if}
      <PanelFrame>
        {#snippet children()}
          {#if queueEntries.length === 0}
            <p class="empty-note">No FIFO queues configured yet.</p>
          {:else}
            <div class="queues-box" role="list" aria-label="All configured FIFO queues">
              {#each queueEntries as entry (entry.address)}
                <div
                  class="queue-card selectable-item"
                  role="button"
                  tabindex="0"
                  aria-pressed={entry.address === fifoState.activeAddress}
                  class:selected-item={entry.address === fifoState.activeAddress}
                  onclick={() => setActiveFifoAddress(entry.address)}
                  onkeydown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setActiveFifoAddress(entry.address);
                    }
                  }}
                >
                  <div class="queue-card-head">
                    <div class="queue-card-select">
                      <span class="mono">{formatAddressWithSettings(entry.address)}</span>
                      <span class="mono secondary">{formatAddressHex(entry.address)}</span>
                    </div>
                    <div class="queue-head-right">
                      <span class="queue-meta-item">Values: {entry.values.length}</span>
                      <span class="queue-meta-item">Last read: {entry.lastReadAt ? formatLogTimestamp(entry.lastReadAt) : "Never"}</span>
                      <span class="queue-count">count={entry.fifoCount}</span>
                    </div>
                  </div>
                  {#if entry.error}
                    <div class="error-note" role="alert">{entry.error}</div>
                  {:else if entry.values.length === 0}
                    <div class="queue-empty">Queue is empty.</div>
                  {:else}
                    <div class="queue-values">
                      {#each entry.values as value, idx (`${entry.address}:${idx}`)}
                        <span class="queue-value-chip mono" title={`#${idx + 1} | ${value}`}>
                          {idx + 1}:{value} ({formatWordHex(value)})
                        </span>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          {#if activeEntry}
            <div class="queue-editor">
              <div class="editor-title">
                Queue Editor - {formatAddressWithSettings(activeEntry.address)}
                <span class="editor-title-secondary">{formatAddressHex(activeEntry.address)}</span>
              </div>

              <div class="gen-bar">
                <button
                  class="ctrl-btn"
                  type="button"
                  onclick={() => { genOpen = !genOpen; }}
                  title="Generate queue values from a pattern"
                >
                  {#if genOpen}<ChevronUp size={12} />{:else}<ChevronDown size={12} />{/if}
                  <span>Generator</span>
                </button>
                <button
                  class="ctrl-btn"
                  type="button"
                  onclick={() => { linkEditorOpen = !linkEditorOpen; }}
                  title="Link register snapshots into this FIFO"
                >
                  {#if linkEditorOpen}<ChevronUp size={12} />{:else}<ChevronDown size={12} />{/if}
                  <span>Snapshot Link</span>
                </button>
              </div>

              {#if genOpen}
                <div class="gen-panel">
                  <div class="gen-row">
                    <div class="gen-field">
                      <label class="field-label" for="gen-rule">Pattern</label>
                      <select id="gen-rule" class="gen-select" value={genRule} onchange={(e) => { genRule = e.currentTarget.value as GenRule; }}>
                        <option value="constant">Constant</option>
                        <option value="sequential">Sequential</option>
                        <option value="ramp">Linear Ramp</option>
                        <option value="sine">Sine</option>
                        <option value="random">Random Uniform</option>
                      </select>
                    </div>
                    <div class="gen-field">
                      <label class="field-label" for="gen-count">Count</label>
                      <input id="gen-count" class="num-input gen-num" type="number" min="1" max="31" value={genCount} oninput={(e) => { genCount = Number(e.currentTarget.value); }} />
                    </div>
                    <div class="gen-field">
                      <label class="field-label" for="gen-min">{genRule === 'constant' ? 'Value' : 'Min'}</label>
                      <input id="gen-min" class="num-input gen-num" type="number" min="0" max="65535" value={genMin} oninput={(e) => { genMin = Number(e.currentTarget.value); }} />
                    </div>
                    {#if genRule !== 'constant'}
                      <div class="gen-field">
                        <label class="field-label" for="gen-max">Max</label>
                        <input id="gen-max" class="num-input gen-num" type="number" min="0" max="65535" value={genMax} oninput={(e) => { genMax = Number(e.currentTarget.value); }} />
                      </div>
                    {/if}
                    {#if genRule === 'sequential'}
                      <div class="gen-field">
                        <label class="field-label" for="gen-step">Step</label>
                        <input id="gen-step" class="num-input gen-num" type="number" min="1" max="65535" value={genStep} oninput={(e) => { genStep = Number(e.currentTarget.value); }} />
                      </div>
                    {/if}
                    <button class="ctrl-btn" type="button" onclick={runGenerator}>Generate</button>
                  </div>
                  <p class="gen-note">Generated values are loaded into the editor below for review. Click Apply Queue to save.</p>
                </div>
              {/if}

              {#if linkEditorOpen}
                <div class="gen-panel link-editor-panel">
                  <div class="editor-panel-title">Link into FIFO {formatAddressWithSettings(activeEntry.address)}</div>
                  <div class="link-controls link-controls-editor">
                    <div class="link-field">
                      <label class="field-label" for="editor-link-source-type">Source</label>
                      <select id="editor-link-source-type" class="gen-select link-select" value={linkSource} onchange={(e) => { linkSource = e.currentTarget.value as FifoSnapshotSource; }}>
                        <option value="holding-register">Holding Register</option>
                        <option value="input-register">Input Register</option>
                      </select>
                    </div>

                    <div class="link-field">
                      <label class="field-label" for="editor-link-source-address">Source Addr</label>
                      <input id="editor-link-source-address" class="num-input link-num" type="number" min="0" max="65535" value={linkSourceAddress} oninput={(e) => { linkSourceAddress = Number(e.currentTarget.value); }} />
                    </div>

                    <div class="link-field">
                      <label class="field-label" for="editor-link-trigger">Trigger</label>
                      <select id="editor-link-trigger" class="gen-select link-select" value={linkTrigger} onchange={(e) => { linkTrigger = e.currentTarget.value as FifoSnapshotTrigger; }}>
                        <option value="on-change">On Change</option>
                        <option value="interval">Interval</option>
                        <option value="hybrid">Hybrid</option>
                      </select>
                    </div>

                    {#if linkTrigger !== "on-change"}
                      <div class="link-field">
                        <label class="field-label" for="editor-link-interval">Interval ms</label>
                        <input id="editor-link-interval" class="num-input link-num" type="number" min="200" max="60000" value={linkIntervalMs} oninput={(e) => { linkIntervalMs = Number(e.currentTarget.value); }} />
                      </div>
                    {/if}

                    <div class="link-action">
                      <button class="ctrl-btn" type="button" onclick={addSnapshotLinkForActiveEntry}>Add Link</button>
                    </div>
                  </div>

                  {#if activeEntryLinks.length === 0}
                    <p class="link-empty">No snapshot links target this FIFO yet.</p>
                  {:else}
                    <div class="link-list compact-link-list" role="list" aria-label="Active FIFO snapshot links">
                      {#each activeEntryLinks as link (link.id)}
                        <div class="link-item compact-link-item" role="listitem">
                          <label class="link-toggle">
                            <input type="checkbox" checked={link.enabled} onchange={(e) => setFifoSnapshotLinkEnabled(link.id, (e.currentTarget as HTMLInputElement).checked)} />
                            <span class="link-toggle-label">{link.enabled ? "On" : "Off"}</span>
                          </label>
                          <div class="link-summary">
                            <span class="link-pill source-pill">{sourceLongLabel(link.source)}</span>
                            <span class="mono link-route">{formatAddressWithSettings(link.sourceAddress)}</span>
                            <span class="link-pill trigger-pill">{triggerLabel(link.trigger)}</span>
                          </div>
                          <div class="link-controls-inline">
                            {#if link.trigger !== "on-change"}
                              <label class="link-inline-label">
                                <span>Interval</span>
                                <input class="num-input link-item-interval" type="number" min="200" max="60000" value={link.intervalMs} oninput={(e) => setFifoSnapshotLinkInterval(link.id, Number(e.currentTarget.value))} />
                              </label>
                            {/if}
                            <span class="link-meta">Dropped {link.droppedSamples}</span>
                            <button class="ctrl-btn" type="button" onclick={() => removeFifoSnapshotLink(link.id)}>Remove</button>
                          </div>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}

              <p class="editor-help">Enter comma, space, or semicolon separated 16-bit values (0..65535, max 31 values).</p>
              <textarea
                class="queue-editor-input"
                rows="4"
                placeholder="Example: 10, 20, 30"
                value={queueEditInput}
                oninput={(e) => { queueEditInput = e.currentTarget.value; }}
              ></textarea>
              {#if queueEditError}
                <div class="editor-error" role="alert">{queueEditError}</div>
              {/if}
              <div class="editor-actions">
                <button
                  class="ctrl-btn"
                  type="button"
                  onclick={() => { queueEditInput = activeEntry.values.join(", "); queueEditError = null; }}
                  disabled={fifoState.writeInProgress}
                >
                  Load Current
                </button>
                <button
                  class="ctrl-btn"
                  type="button"
                  onclick={() => void applyQueueEdit()}
                  disabled={fifoState.writeInProgress}
                >
                  {fifoState.writeInProgress ? "Applying..." : "Apply Queue"}
                </button>
                <button
                  class="ctrl-btn"
                  type="button"
                  onclick={() => void clearQueueEdit()}
                  disabled={fifoState.writeInProgress}
                >
                  Clear Queue
                </button>
              </div>
            </div>
          {/if}
        {/snippet}
      </PanelFrame>
    </section>
  {/snippet}
</PageShell>

<style>
  .fifo-section {
    display: grid;
    gap: 10px;
    margin-top: 6px;
    margin-bottom: 8px;
  }

  .data-section {
    margin-bottom: 4px;
    flex: 1;
    min-height: 0;
    overflow: hidden;
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
    font-weight: 700;
  }

  .manage-panel {
    margin-top: 8px;
    border-top: 1px solid color-mix(in srgb, var(--c-border) 65%, transparent);
    padding-top: 10px;
    display: grid;
    gap: 10px;
  }

  .add-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: 0.73rem;
    color: var(--c-text-2);
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .link-panel {
    border-top: 1px solid color-mix(in srgb, var(--c-border) 65%, transparent);
    padding-top: 10px;
    display: grid;
    gap: 8px;
  }

  .link-title {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--c-text-1);
  }

  .link-help {
    margin: 0;
    font-size: 0.72rem;
    color: var(--c-text-2);
  }

  .link-controls {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 10px;
    align-items: end;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--c-border) 62%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--c-surface-2) 48%, transparent);
  }

  .link-field {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .link-action {
    display: flex;
    align-items: end;
  }

  .link-num {
    min-width: 0;
    height: 32px;
  }

  .link-select {
    min-width: 0;
  }

  .link-empty {
    margin: 0;
    font-size: 0.74rem;
    color: var(--c-text-2);
  }

  .link-list {
    display: grid;
    gap: 6px;
  }

  .link-item {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 10px;
    align-items: center;
    border: 1px solid color-mix(in srgb, var(--c-border) 72%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--c-surface-2) 55%, transparent);
    padding: 10px 12px;
    font-size: 0.74rem;
    color: var(--c-text-2);
  }

  .compact-link-item {
    grid-template-columns: auto 1fr;
  }

  .link-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .link-toggle-label {
    font-weight: 600;
    color: var(--c-text-1);
  }

  .link-summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .link-route {
    color: var(--c-text-1);
  }

  .link-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 3px 8px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--c-border) 72%, transparent);
    background: color-mix(in srgb, var(--c-surface-3) 70%, transparent);
    color: var(--c-text-1);
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .source-pill {
    border-color: color-mix(in srgb, var(--c-accent) 42%, var(--c-border));
    background: color-mix(in srgb, var(--c-accent) 10%, var(--c-surface-3));
  }

  .trigger-pill {
    border-color: color-mix(in srgb, var(--c-border) 84%, transparent);
  }

  .link-controls-inline {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }

  .link-inline-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--c-text-2);
  }

  .link-item-interval {
    min-width: 82px;
    height: 28px;
    padding: 0 8px;
    border-radius: 6px;
    border: 1px solid var(--c-border);
    background: color-mix(in srgb, var(--c-surface-2) 80%, transparent);
    color: var(--c-text-1);
    font-size: 0.74rem;
  }

  .link-meta {
    color: var(--c-text-2);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  }

  .field-label {
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .num-input {
    min-width: 140px;
    height: 36px;
    padding: 0 10px;
    border-radius: 8px;
    border: 1px solid var(--c-border);
    background: color-mix(in srgb, var(--c-surface-2) 80%, transparent);
    color: var(--c-text-1);
    font-size: 0.9rem;
    line-height: 1.1;
    text-transform: none;
    letter-spacing: normal;
  }

  .num-input::placeholder {
    text-transform: none;
    letter-spacing: normal;
    color: var(--c-text-2);
  }

  .ctrl-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--c-border) 78%, transparent);
    background: color-mix(in srgb, var(--c-surface-2) 82%, transparent);
    color: var(--c-text-1);
    font-size: 0.76rem;
    font-weight: 600;
    cursor: pointer;
  }

  .ctrl-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .address-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .address-chip {
    display: inline-flex;
    align-items: stretch;
    border: 1px solid color-mix(in srgb, var(--c-border) 75%, transparent);
    border-radius: 8px;
    overflow: hidden;
    background: color-mix(in srgb, var(--c-surface-2) 62%, transparent);
  }

  .address-chip.active {
    border-color: color-mix(in srgb, var(--c-accent) 58%, var(--c-border));
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--c-accent) 30%, transparent);
  }

  .chip-main {
    border: 0;
    background: transparent;
    color: inherit;
    padding: 6px 8px;
    cursor: pointer;
    display: inline-flex;
    gap: 6px;
    align-items: baseline;
  }

  .chip-remove {
    border: 0;
    border-left: 1px solid color-mix(in srgb, var(--c-border) 75%, transparent);
    background: transparent;
    color: var(--c-text-2);
    width: 28px;
    cursor: pointer;
    font-size: 0.72rem;
    font-weight: 600;
  }

  .chip-dec,
  .chip-hex,
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  }

  .chip-dec {
    font-size: 0.75rem;
    color: var(--c-text-1);
  }

  .chip-hex,
  .mono.secondary {
    font-size: 0.72rem;
    color: var(--c-text-2);
  }

  .queues-box {
    display: grid;
    gap: 8px;
    max-height: 280px;
    min-height: 80px;
    overflow: auto;
    padding-right: 2px;
  }

  .queue-card {
    border: 1px solid color-mix(in srgb, var(--c-border) 72%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--c-surface-2) 55%, transparent);
    padding: 8px;
    display: grid;
    gap: 8px;
  }

  .selectable-item {
    border: 1px solid transparent;
    border-radius: 10px;
  }

  .selected-item {
    border: 1px solid var(--c-accent);
    background: color-mix(in srgb, var(--c-accent) 5%, var(--c-surface-3));
    box-shadow: 0 0 8px color-mix(in srgb, var(--c-accent) 40%, transparent);
    border-radius: 10px;
  }

  .queue-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .queue-card-select {
    border: 0;
    background: transparent;
    color: var(--c-text-1);
    display: inline-flex;
    gap: 8px;
    align-items: baseline;
    cursor: pointer;
    padding: 0;
  }

  .queue-count {
    font-size: 0.74rem;
    color: var(--c-text-2);
  }

  .queue-head-right {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .queue-meta-item {
    font-size: 0.73rem;
    color: var(--c-text-2);
  }

  .queue-values {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .queue-value-chip {
    display: inline-flex;
    align-items: center;
    border: 1px solid color-mix(in srgb, var(--c-border) 72%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--c-surface-2) 72%, transparent);
    padding: 4px 6px;
    font-size: 0.72rem;
    color: var(--c-text-1);
  }

  .queue-empty {
    font-size: 0.74rem;
    color: var(--c-text-2);
  }

  .error-note {
    padding: 8px 10px;
    border: 1px solid color-mix(in srgb, var(--c-danger, #d9534f) 35%, var(--c-border));
    border-radius: 8px;
    background: color-mix(in srgb, var(--c-danger, #d9534f) 10%, var(--c-surface-2));
    color: var(--c-text-1);
    font-size: 0.76rem;
  }

  .queue-editor {
    margin-top: 12px;
    border-top: 1px solid color-mix(in srgb, var(--c-border) 65%, transparent);
    padding-top: 10px;
    display: grid;
    gap: 8px;
  }

  .gen-bar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }

  .link-editor-panel {
    border-color: color-mix(in srgb, var(--c-accent) 34%, var(--c-border));
  }

  .editor-panel-title {
    font-size: 0.76rem;
    font-weight: 600;
    color: var(--c-text-1);
  }

  .link-controls-editor {
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  }

  .compact-link-list {
    gap: 8px;
  }

  .gen-panel {
    border: 1px solid color-mix(in srgb, var(--c-border) 58%, transparent);
    border-radius: 8px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--c-surface-2) 60%, transparent);
    display: grid;
    gap: 8px;
  }

  .gen-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 10px;
  }

  .gen-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .gen-select {
    height: 32px;
    padding: 0 8px;
    border-radius: 8px;
    border: 1px solid var(--c-border);
    background: color-mix(in srgb, var(--c-surface-2) 80%, transparent);
    color: var(--c-text-1);
    font-size: 0.78rem;
    cursor: pointer;
  }

  .gen-num {
    min-width: 80px;
    height: 32px;
  }

  .gen-note {
    margin: 0;
    font-size: 0.72rem;
    color: var(--c-text-2);
  }

  .editor-title {
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--c-text-1);
  }

  .editor-title-secondary {
    font-size: 0.72rem;
    color: var(--c-text-2);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  }

  .editor-help {
    margin: 0;
    font-size: 0.73rem;
    color: var(--c-text-2);
  }

  .queue-editor-input {
    width: 100%;
    border-radius: 8px;
    border: 1px solid var(--c-border);
    background: color-mix(in srgb, var(--c-surface-2) 80%, transparent);
    color: var(--c-text-1);
    font-size: 0.76rem;
    padding: 8px;
    resize: vertical;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  }

  .editor-error {
    font-size: 0.74rem;
    color: color-mix(in srgb, var(--c-danger, #d9534f) 90%, var(--c-text-1));
  }

  .editor-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .empty-note {
    margin: 0;
    color: var(--c-text-2);
    font-size: 0.78rem;
  }

  @media (max-width: 640px) {
    .queue-head-right {
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .link-item,
    .compact-link-item {
      grid-template-columns: 1fr;
    }

    .link-controls-inline {
      justify-content: flex-start;
    }
  }
</style>
