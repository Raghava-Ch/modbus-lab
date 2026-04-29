<svelte:options runes={true} />

<script lang="ts">
  import { untrack } from "svelte";
  import { ChevronDown, ChevronUp, LoaderCircle, Play, RefreshCw, SlidersHorizontal, Timer } from "lucide-svelte";
  import SectionHeader from "../shared/SectionHeader.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";
  import { estimateFrameMs } from "../../lib/frame-timing";
  import { connectionState } from "../../state/connection.svelte";
  import { notifyWarning } from "../../state/notifications.svelte";
  import {
    addFifoAddress,
    fifoState,
    initFifoState,
    readFifoAddress,
    refreshAllFifoQueues,
    removeFifoAddress,
    setActiveFifoAddress,
    setFifoPollActive,
    setFifoPollInterval,
    teardownFifoState,
  } from "../../state/fifo.svelte";
  import {
    formatAddressWithSettings,
    formatLogTimestamp,
    getGlobalPollingMaxAddressCount,
    isPollingAllowedForCount,
  } from "../../state/settings.svelte";

  let queueManageOpen = $state(false);
  let newAddressInput = $state("");

  const connected = $derived(connectionState.status === "connected");
  const pollMaxCount = $derived(getGlobalPollingMaxAddressCount());
  const pollDisabledByCount = $derived(!isPollingAllowedForCount(fifoState.addresses.length));

  const pollIntervals: { ms: number; label: string }[] = [
    { ms: 500, label: "500 ms" },
    { ms: 1000, label: "1 s" },
    { ms: 2000, label: "2 s" },
    { ms: 5000, label: "5 s" },
  ];

  const readPlan = $derived.by(() => {
    const frames = Math.max(0, fifoState.addresses.length);
    const frameMs = estimateFrameMs(
      120,
      connectionState.protocol,
      connectionState.serial.baudRate,
      connectionState.serial.dataBits,
      connectionState.serial.parity,
      connectionState.serial.stopBits,
      connectionState.tcp.responseTimeoutMs,
    );
    return {
      frames,
      cycleMs: frames * frameMs,
    };
  });

  $effect(() => {
    untrack(() => {
      initFifoState();
    });

    return () => {
      teardownFifoState();
    };
  });

  $effect(() => {
    if (connectionState.status !== "connected" && fifoState.pollActive) {
      setFifoPollActive(false);
    }
  });

  function formatAddressHex(value: number): string {
    const normalized = Math.max(0, Math.min(65535, Math.floor(value)));
    return `0x${normalized.toString(16).toUpperCase().padStart(4, "0")}`;
  }

  function formatWordHex(value: number): string {
    const normalized = Math.max(0, Math.min(65535, Math.floor(value)));
    return `0x${normalized.toString(16).toUpperCase().padStart(4, "0")}`;
  }

  function addAddressFromInput(): void {
    const parsed = Number(newAddressInput.trim());
    if (!Number.isFinite(parsed)) return;
    if (addFifoAddress(parsed)) {
      newAddressInput = "";
    }
  }

  function togglePoll(): void {
    setFifoPollActive(!fifoState.pollActive);
  }

  function handleManualReadAllFifo(): void {
    if (fifoState.pollActive) {
      notifyWarning("Polling is already in progress. Stop polling to use manual refresh.");
      return;
    }
    void refreshAllFifoQueues({ queueIfBusy: false });
  }

  function selectEntry(address: number): void {
    setActiveFifoAddress(address);
  }

  function readEntry(address: number): void {
    setActiveFifoAddress(address);
    void readFifoAddress(address);
  }
</script>

<div class="fifo-page">
  {#if connectionState.status !== "connected"}
    <div class="disconnected-banner" role="alert">
      <span class="banner-icon">⚠</span>
      <span class="banner-text">Not connected — go to <strong>Connection</strong> and connect to a device before using FIFO queue operations.</span>
    </div>
  {/if}

  <SectionHeader title="FIFO Queue" subtitle="FC 24 queue monitor">
    {#snippet actions()}
      <span class="icon-wrap">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 2 4 6l8 4 8-4-8-4Z"></path>
          <path d="m4 10 8 4 8-4"></path>
          <path d="m4 14 8 4 8-4"></path>
        </svg>
      </span>
    {/snippet}
  </SectionHeader>

  <section class="fifo-section data-section">
    <SectionHeader
      title="Queue Data"
      subtitle={`Configured queues: ${fifoState.addresses.length} | Active: ${formatAddressWithSettings(fifoState.activeAddress)}`}
    >
      {#snippet actions()}
          <div class="poll-controls">
            <select
              class="ctrl-select has-tip"
              value={fifoState.pollInterval}
              onchange={(e) => setFifoPollInterval(Number(e.currentTarget.value))}
              data-tip="Poll interval"
              disabled={pollDisabledByCount}
            >
              {#each pollIntervals as pi}
                <option value={pi.ms}>{pi.label}</option>
              {/each}
            </select>
            <button
              class="ctrl-btn poll-btn has-tip"
              class:active={fifoState.pollActive}
              data-tip={pollDisabledByCount ? "Polling disabled for large lists" : fifoState.pollActive ? "Stop polling" : "Start polling"}
              type="button"
              disabled={!connected || pollDisabledByCount}
              onclick={togglePoll}
            >
              {#if fifoState.pollActive}
                <Timer size={14} />
                <span>Polling</span>
              {:else}
                <Play size={14} />
                <span>Poll</span>
              {/if}
            </button>
            <button class="ctrl-btn icon-only has-tip" data-tip="Read once" type="button" disabled={!connected || fifoState.readInProgress}
              onclick={handleManualReadAllFifo}>
              {#if fifoState.readInProgress}
                <LoaderCircle size={14} style="animation: spin 0.9s linear infinite;" />
              {:else}
                <RefreshCw size={14} />
              {/if}
            </button>
            {#if pollDisabledByCount}
              <span class="pending-chip has-tip" data-tip="Global polling max reached">
                Poll disabled: list &gt; {pollMaxCount}
              </span>
            {/if}
            {#if readPlan.frames > 0}
              <span class="plan-chip has-tip" data-tip="Estimated FC24 frames and cycle time per read-all run">
                Read {readPlan.frames}f ~{readPlan.cycleMs}ms
              </span>
            {/if}
          </div>

          <div class="divider-v"></div>

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
                  <button
                    class="chip-main"
                    type="button"
                    onclick={() => setActiveFifoAddress(address)}
                  >
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
          </div>
        {/snippet}
      </PanelFrame>
    {/if}

    <PanelFrame>
      {#snippet children()}
        {#if fifoState.entries.length === 0}
          <p class="empty-note">No FIFO queues configured yet.</p>
        {:else}
          <div class="queues-box" role="list" aria-label="All configured FIFO queues">
            {#each fifoState.entries as entry (entry.address)}
              <div
                class="queue-card selectable-item"
                role="button"
                tabindex="0"
                aria-pressed={entry.address === fifoState.activeAddress}
                class:selected-item={entry.address === fifoState.activeAddress}
                onclick={() => selectEntry(entry.address)}
                onkeydown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    selectEntry(entry.address);
                  }
                }}
              >
                <div class="queue-card-head">
                  <div class="queue-card-select">
                    <span class="mono">{formatAddressWithSettings(entry.address)}</span>
                    <span class="mono secondary">{formatAddressHex(entry.address)}</span>
                  </div>
                  <div class="queue-head-right">
                    <button
                      class="ctrl-btn icon-only has-tip queue-read-btn"
                      data-tip="Read this queue"
                      type="button"
                      disabled={!connected || entry.pending || fifoState.readInProgress}
                      onclick={(e) => {
                        e.stopPropagation();
                        readEntry(entry.address);
                      }}
                    >
                      {#if entry.pending}<LoaderCircle size={13} style="animation: spin 0.9s linear infinite;" />{:else}<RefreshCw size={13} />{/if}
                    </button>
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
      {/snippet}
    </PanelFrame>
  </section>
</div>

<style>
  .fifo-page {
    display: grid;
    gap: 10px;
  }

  .icon-wrap {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--c-border);
    border-radius: 8px;
    background: var(--c-surface-2);
    width: 32px;
    height: 32px;
  }

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

  .add-controls,
  .poll-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    font-size: 0.73rem;
    color: var(--c-text-2);
    letter-spacing: 0.03em;
    text-transform: uppercase;
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

  .ctrl-btn:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--c-accent) 58%, var(--c-border));
    background: color-mix(in srgb, var(--c-accent) 8%, var(--c-surface-3));
    box-shadow: 0 0 8px color-mix(in srgb, var(--c-accent) 35%, transparent);
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
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

  .queue-head-right {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .queue-read-btn {
    min-width: 30px;
    height: 28px;
    padding: 0;
  }

  .queue-meta-item {
    font-size: 0.73rem;
    color: var(--c-text-2);
    width: 80px;
    text-align: center;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .queue-meta-item:first-of-type {
    width: 60px;
  }

  .queue-meta-item:nth-of-type(2) {
    width: 115px;
  }

  .queue-count {
    font-size: 0.74rem;
    color: var(--c-text-2);
    width: 50px;
    text-align: left;
    flex-shrink: 0;
    white-space: nowrap;
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
  }
</style>
