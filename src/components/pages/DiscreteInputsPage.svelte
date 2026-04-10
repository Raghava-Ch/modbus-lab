<svelte:options runes={true} />
<script lang="ts">
  import { untrack } from "svelte";
  import {
    Table2,
    LayoutGrid,
    RefreshCw,
    Play,
    SlidersHorizontal,
    Wand,
    ChevronDown,
    ChevronUp,
    LoaderCircle,
    Zap,
    Timer,
    Repeat,
  } from "lucide-svelte";
  import {
    addExclusiveDiscreteInput,
    addDiscreteInputRange,
    discreteInputState,
    generateRandomExclusiveDiscreteInputAddress,
    getFilteredDiscreteInputs,
    initDiscreteInputState,
    readAllDiscreteInputs,
    readDiscreteInput,
    removeAllDiscreteInputs,
    removeDiscreteInput,
    setDiscreteInputFilter,
    setDiscreteInputLabel,
    setDiscreteInputPollActive,
    setDiscreteInputPollInterval,
    setDiscreteInputView,
  } from "../../state/discrete-inputs.svelte";
  import { connectionState } from "../../state/connection.svelte";
  import {
    formatAddressWithSettings,
    getGlobalPollingMaxAddressCount,
    isPollingAllowedForCount,
  } from "../../state/settings.svelte";
  import SectionHeader from "../shared/SectionHeader.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";
  import ToggleSwitch from "../shared/ToggleSwitch.svelte";
  import TableRow from "../shared/TableRow.svelte";
  import SwitchCard from "../shared/SwitchCard.svelte";

  // ── Init & cleanup ──────────────────────────────────────────────────────────
  $effect(() => {
    untrack(() => initDiscreteInputState());
    return () => {
      setDiscreteInputPollActive(false);
    };
  });

  // Stop polling automatically when connection drops
  $effect(() => {
    if (connectionState.status !== "connected" && discreteInputState.pollActive) {
      setDiscreteInputPollActive(false);
    }
  });

  const connected = $derived(connectionState.status === "connected");

  // ── Local panel open/close state ────────────────────────────────────────────
  let readPanelOpen = $state(false);

  // ── Address range inputs (local; committed on Apply) ────────────────────────
  let rangeStart = $state(discreteInputState.startAddress);
  let rangeCount = $state(discreteInputState.inputCount);
  let rangeApplyPending = $state(false);
  const RANGE_APPLY_MIN_SPINNER_MS = 250;

  // ── Filtered coil list ──────────────────────────────────────────────────────
  const filtered = $derived(getFilteredDiscreteInputs());
  const VIRTUAL_TABLE_THRESHOLD = 300;
  const VIRTUAL_SWITCH_THRESHOLD = 200;
  const TABLE_ROW_HEIGHT = 34;
  const SWITCH_CARD_ROW_HEIGHT = 210;
  const SWITCH_CARD_MIN_WIDTH = 180;
  const VIRTUAL_OVERSCAN_ROWS = 8;

  let tableScrollTop = $state(0);
  let tableViewportHeight = $state(460);
  let switchScrollTop = $state(0);
  let switchViewportHeight = $state(520);
  let switchViewportWidth = $state(720);
  let tableBodyEl: HTMLDivElement | null = $state(null);
  let switchScrollEl: HTMLDivElement | null = $state(null);
  let dynamicScrollMaxHeight = $state(680);

  function refreshDynamicScrollMaxHeight(): void {
    if (typeof window === "undefined") return;

    const targetEl = discreteInputState.view === "table" ? tableBodyEl : switchScrollEl;
    if (!targetEl) return;

    const mainContent = document.querySelector(".main-content") as HTMLElement | null;
    const bodyRect = targetEl.getBoundingClientRect();
    const containerBottom = mainContent?.getBoundingClientRect().bottom ?? window.innerHeight;
    const reservedBottomGap = 28;
    const next = Math.max(180, Math.floor(containerBottom - bodyRect.top - reservedBottomGap));
    dynamicScrollMaxHeight = next;
  }

  $effect(() => {
    if (typeof window === "undefined") return;

    const mainContent = document.querySelector(".main-content") as HTMLElement | null;
    const resizeObserver = new ResizeObserver(() => {
      refreshDynamicScrollMaxHeight();
    });

    if (mainContent) {
      resizeObserver.observe(mainContent);
    }
    if (tableBodyEl) {
      resizeObserver.observe(tableBodyEl);
    }
    if (switchScrollEl) {
      resizeObserver.observe(switchScrollEl);
    }

    refreshDynamicScrollMaxHeight();
    window.addEventListener("resize", refreshDynamicScrollMaxHeight);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", refreshDynamicScrollMaxHeight);
    };
  });

  $effect(() => {
    readPanelOpen;
    discreteInputState.view;
    filtered.length;

    if (typeof window === "undefined") return;

    const raf1 = window.requestAnimationFrame(() => {
      const raf2 = window.requestAnimationFrame(() => {
        refreshDynamicScrollMaxHeight();
      });
      return () => window.cancelAnimationFrame(raf2);
    });

    return () => {
      window.cancelAnimationFrame(raf1);
    };
  });

  const tableVirtualEnabled = $derived(filtered.length >= VIRTUAL_TABLE_THRESHOLD);
  const tableStartRow = $derived(
    tableVirtualEnabled
      ? Math.max(0, Math.floor(tableScrollTop / TABLE_ROW_HEIGHT) - VIRTUAL_OVERSCAN_ROWS)
      : 0,
  );
  const tableVisibleRowCount = $derived(
    Math.max(1, Math.ceil(tableViewportHeight / TABLE_ROW_HEIGHT)),
  );
  const tableEndRow = $derived(
    tableVirtualEnabled
      ? Math.min(filtered.length, tableStartRow + tableVisibleRowCount + VIRTUAL_OVERSCAN_ROWS * 2)
      : filtered.length,
  );
  const visibleTableEntries = $derived(
    tableVirtualEnabled ? filtered.slice(tableStartRow, tableEndRow) : filtered,
  );
  const tableTopSpacerHeight = $derived(tableVirtualEnabled ? tableStartRow * TABLE_ROW_HEIGHT : 0);
  const tableBottomSpacerHeight = $derived(
    tableVirtualEnabled ? Math.max(0, (filtered.length - tableEndRow) * TABLE_ROW_HEIGHT) : 0,
  );

  const switchVirtualEnabled = $derived(filtered.length >= VIRTUAL_SWITCH_THRESHOLD);
  const switchCols = $derived(
    Math.max(1, Math.floor(Math.max(1, switchViewportWidth) / SWITCH_CARD_MIN_WIDTH)),
  );
  const switchTotalRows = $derived(Math.max(1, Math.ceil(filtered.length / switchCols)));
  const switchStartRow = $derived(
    switchVirtualEnabled
      ? Math.max(0, Math.floor(switchScrollTop / SWITCH_CARD_ROW_HEIGHT) - VIRTUAL_OVERSCAN_ROWS)
      : 0,
  );
  const switchVisibleRowCount = $derived(
    Math.max(1, Math.ceil(switchViewportHeight / SWITCH_CARD_ROW_HEIGHT)),
  );
  const switchEndRow = $derived(
    switchVirtualEnabled
      ? Math.min(switchTotalRows, switchStartRow + switchVisibleRowCount + VIRTUAL_OVERSCAN_ROWS * 2)
      : switchTotalRows,
  );
  const switchStartIndex = $derived(switchStartRow * switchCols);
  const switchEndIndex = $derived(
    switchVirtualEnabled ? Math.min(filtered.length, switchEndRow * switchCols) : filtered.length,
  );
  const visibleSwitchEntries = $derived(
    switchVirtualEnabled ? filtered.slice(switchStartIndex, switchEndIndex) : filtered,
  );
  const switchTopSpacerHeight = $derived(
    switchVirtualEnabled ? switchStartRow * SWITCH_CARD_ROW_HEIGHT : 0,
  );
  const switchBottomSpacerHeight = $derived(
    switchVirtualEnabled ? Math.max(0, (switchTotalRows - switchEndRow) * SWITCH_CARD_ROW_HEIGHT) : 0,
  );

  const onCount = $derived(discreteInputState.entries.filter((e) => e.value).length);
  const offCount = $derived(discreteInputState.entries.filter((e) => !e.value).length);
  const pollMaxCount = $derived(getGlobalPollingMaxAddressCount());
  const pollDisabledByCount = $derived(!isPollingAllowedForCount(discreteInputState.entries.length));

  // ── Inline label editing ────────────────────────────────────────────────────
  let editingAddress: number | null = $state(null);
  let editLabelVal = $state("");
  let addAddressInput = $state("");
  let singleWriteAddressInput = $state("");
  let singleWriteDesired = $state(false);

  function beginEdit(address: number, current: string): void {
    editingAddress = address;
    editLabelVal = current;
  }

  function commitEdit(): void {
    if (editingAddress !== null) {
      setDiscreteInputLabel(editingAddress, editLabelVal.trim());
      editingAddress = null;
    }
  }

  function cancelEdit(): void {
    editingAddress = null;
  }

  function onLabelKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter") commitEdit();
    else if (e.key === "Escape") cancelEdit();
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────
  async function handleApplyRange(): Promise<void> {
    if (rangeApplyPending) return;
    rangeApplyPending = true;
    try {
      // Let users see local processing state before applying changes.
      await new Promise<void>((resolve) => setTimeout(resolve, RANGE_APPLY_MIN_SPINNER_MS));
      addDiscreteInputRange(rangeStart, rangeCount);
      rangeStart = discreteInputState.startAddress;
      rangeCount = discreteInputState.inputCount;
      addAddressInput = "";
    } finally {
      rangeApplyPending = false;
    }
  }

  function tryAddAddress(): void {
    const parsed = Number(addAddressInput.trim());
    if (!Number.isFinite(parsed)) return;
    const ok = addExclusiveDiscreteInput(parsed);
    if (ok) {
      addAddressInput = "";
    }
  }

  function suggestRandomAddress(): void {
    const picked = generateRandomExclusiveDiscreteInputAddress();
    if (picked !== null) {
      addAddressInput = String(picked);
    }
  }

  const pollIntervals: { ms: number; label: string }[] = [
    { ms: 500,  label: "500 ms" },
    { ms: 1000, label: "1 s"    },
    { ms: 2000, label: "2 s"    },
    { ms: 5000, label: "5 s"    },
  ];

  function addrFmt(n: number): string {
    return formatAddressWithSettings(n);
  }
</script>

<div class="coils-page">
  {#if !connected}
    <div class="disconnected-banner" role="alert">
      <span class="banner-icon">⚠</span>
      <span class="banner-text">Not connected — go to <strong>Connection</strong> and connect to a device before using coil operations.</span>
    </div>
  {/if}

  <!-- ── Header ─────────────────────────────────────────────────────────────── -->
  <SectionHeader
    title="Discrete Inputs"
    subtitle="FC 02 Read only"
  >
    {#snippet actions()}
      <!-- Poll controls -->
      <div class="poll-controls">
        <select
          class="ctrl-select has-tip"
          value={discreteInputState.pollInterval}
          onchange={(e) => setDiscreteInputPollInterval(Number(e.currentTarget.value))}
          data-tip="Poll interval"
        >
          {#each pollIntervals as pi}
            <option value={pi.ms}>{pi.label}</option>
          {/each}
        </select>
        <button
          class="ctrl-btn has-tip"
          class:active={discreteInputState.pollActive}
          data-tip={pollDisabledByCount ? "Polling disabled for large lists" : discreteInputState.pollActive ? "Stop polling" : "Start polling"}
          type="button"
          disabled={!connected || pollDisabledByCount}
          onclick={() => setDiscreteInputPollActive(!discreteInputState.pollActive)}
        >
          {#if discreteInputState.pollActive}
            <Timer size={14} />
            <span>Polling</span>
          {:else}
            <Play size={14} />
            <span>Poll</span>
          {/if}
        </button>
        <button class="ctrl-btn icon-only has-tip" data-tip="Read once" type="button" disabled={!connected}
          onclick={() => { void readAllDiscreteInputs(); }}>
          <RefreshCw size={14} />
        </button>
        {#if pollDisabledByCount}
          <span class="pending-chip has-tip" data-tip="Global polling max reached">
            Poll disabled: list &gt; {pollMaxCount}
          </span>
        {/if}
      </div>

      <div class="divider-v"></div>

      <!-- View toggle -->
      <div class="view-toggle">
        <button
          class="ctrl-btn icon-only has-tip"
          class:active={discreteInputState.view === "table"}
          data-tip="Table view"
          type="button"
          onclick={() => setDiscreteInputView("table")}
        >
          <Table2 size={15} />
        </button>
        <button
          class="ctrl-btn icon-only has-tip"
          class:active={discreteInputState.view === "switch"}
          data-tip="Switch view"
          type="button"
          onclick={() => setDiscreteInputView("switch")}
        >
          <LayoutGrid size={15} />
        </button>
      </div>
    {/snippet}
  </SectionHeader>

  <!-- ── Toolbar ────────────────────────────────────────────────────────────── -->
  <div class="toolbar">
    <div class="filter-tabs">
      <button
        class="filter-tab"
        class:active={discreteInputState.filter === "all"}
        type="button"
        onclick={() => setDiscreteInputFilter("all")}
      >All <span class="count">{discreteInputState.entries.length}</span></button>
      <button
        class="filter-tab"
        class:active={discreteInputState.filter === "on"}
        type="button"
        onclick={() => setDiscreteInputFilter("on")}
      >ON <span class="count on">{onCount}</span></button>
      <button
        class="filter-tab"
        class:active={discreteInputState.filter === "off"}
        type="button"
        onclick={() => setDiscreteInputFilter("off")}
      >OFF <span class="count off">{offCount}</span></button>
    </div>

    <div class="toolbar-actions">

      <button
        class="ctrl-btn has-tip"
        class:active={readPanelOpen}
        type="button"
        onclick={() => { readPanelOpen = !readPanelOpen; }}
        data-tip="Add coils"
      >
        <SlidersHorizontal size={13} />
        <span>Add Inputs</span>
        {#if readPanelOpen}<ChevronUp size={12} />{:else}<ChevronDown size={12} />{/if}
      </button>
    </div>
  </div>

  <!-- ── Address Range Panel ────────────────────────────────────────────────── -->
  {#if readPanelOpen}
    <PanelFrame>
      {#snippet children()}
        <div class="sub-panel">
          <div class="sub-title">Add Inputs</div>

          <div class="mini-section">
            <div class="mini-title">Single Add</div>
            <div class="sub-row">
              <div class="form-group">
                <label for="single-add-address">Address</label>
                <input
                  id="single-add-address"
                  class="custom-address-input"
                  type="number"
                  min="0"
                  max="65535"
                  placeholder="Type address"
                  value={addAddressInput}
                  oninput={(e) => { addAddressInput = e.currentTarget.value; }}
                  onkeydown={(e) => { if (e.key === "Enter") tryAddAddress(); }}
                />
              </div>
              <button
                class="btn btn-sm btn-apply has-tip"
                type="button"
                onclick={suggestRandomAddress}
                data-tip="Generate random free address"
              >
                Random
              </button>
              <button class="btn btn-sm btn-apply" type="button" onclick={tryAddAddress}>
                Add
              </button>
            </div>
          </div>

          <div class="mini-section">
            <div class="mini-title">Range Add</div>
            <div class="sub-row">
            <div class="form-group">
              <label for="range-start">Start Address</label>
              <input
                id="range-start"
                type="number"
                min="0"
                max="65535"
                value={rangeStart}
                oninput={(e) => { rangeStart = Number(e.currentTarget.value); }}
              />
            </div>
            <div class="form-group">
              <label for="range-count">Count</label>
              <input
                id="range-count"
                type="number"
                min="1"
                max="65535"
                value={rangeCount}
                oninput={(e) => { rangeCount = Number(e.currentTarget.value); }}
              />
            </div>
            <button
              class="btn btn-sm btn-apply"
              class:btn-processing={rangeApplyPending}
              type="button"
              onclick={handleApplyRange}
              disabled={rangeApplyPending}
            >
              {#if rangeApplyPending}
                <span class="spin"><LoaderCircle size={14} /></span>
                Applying...
              {:else}
                Apply
              {/if}
            </button>
          </div>
          </div>

          <div class="mini-section mini-section-danger">
            <div class="mini-title">Cleanup</div>
            <div class="sub-row">
              <button class="btn btn-sm btn-clear" type="button" onclick={removeAllDiscreteInputs}>
                Remove All Inputs
              </button>
            </div>
          </div>
        </div>
      {/snippet}
    </PanelFrame>
  {/if}

  <!-- ── Main inputs display ──────────────────────────────────────────────────── -->
  <PanelFrame>
    {#snippet children()}
      {#if filtered.length === 0}
        <div class="empty">No coils match the current filter.</div>
      {:else if discreteInputState.view === "table"}
        <!-- TABLE view -->
        <div class="coil-table">
          <div class="ct-header">
            <span>Label</span>
            <span>Status</span>
            <span>Addr</span>
            <span>Read Value</span>
            <span>Operation</span>
            <span>Delete</span>
          </div>
          <div
            class="ct-body"
            onscroll={(e) => { tableScrollTop = e.currentTarget.scrollTop; }}
            bind:clientHeight={tableViewportHeight}
            bind:this={tableBodyEl}
            style:max-height={`${dynamicScrollMaxHeight}px`}
          >
            {#if tableTopSpacerHeight > 0}
              <div class="ct-spacer" style={`height: ${tableTopSpacerHeight}px;`}></div>
            {/if}

            {#each visibleTableEntries as entry (entry.address)}
              <TableRow
                entry={{
                  address: entry.address,
                  slaveValue: entry.value,
                  desiredValue: entry.value,
                  pending: entry.pending,
                  writeError: entry.readError,
                  label: entry.label,
                }}
                {connected}
                {editingAddress}
                {editLabelVal}
                {addrFmt}
                {beginEdit}
                {commitEdit}
                {cancelEdit}
                {onLabelKeydown}
                onEditLabelValChange={(next: string) => { editLabelVal = next; }}
                onToggle={undefined}
                onRead={(address: number) => { void readDiscreteInput(address); }}
                onWrite={undefined}
                onDelete={(address: number) => removeDiscreteInput(address)}
                showStatusColumn={true}
              />
            {/each}

            {#if tableBottomSpacerHeight > 0}
              <div class="ct-spacer" style={`height: ${tableBottomSpacerHeight}px;`}></div>
            {/if}
          </div>
        </div>

      {:else}
        <!-- SWITCH view -->
        <div
          class="switch-virtual-scroll"
          onscroll={(e) => { switchScrollTop = e.currentTarget.scrollTop; }}
          bind:clientHeight={switchViewportHeight}
          bind:clientWidth={switchViewportWidth}
          bind:this={switchScrollEl}
          style:max-height={`${dynamicScrollMaxHeight}px`}
        >
          {#if switchTopSpacerHeight > 0}
            <div class="switch-spacer" style={`height: ${switchTopSpacerHeight}px;`}></div>
          {/if}

          <div class="switch-grid">
            {#each visibleSwitchEntries as entry (entry.address)}
              <SwitchCard
                address={entry.address}
                label={entry.label}
                pending={entry.pending}
                readValue={entry.value}
                toggleValue={entry.value}
                {connected}
                cardDirty={entry.readError !== null}
                {editingAddress}
                {editLabelVal}
                {addrFmt}
                onBeginEdit={beginEdit}
                onCommitEdit={commitEdit}
                onCancelEdit={cancelEdit}
                {onLabelKeydown}
                onEditLabelValChange={(next: string) => { editLabelVal = next; }}
                onToggle={undefined}
                onRead={(address: number) => { void readDiscreteInput(address); }}
                onWrite={undefined}
                onDelete={(address: number) => removeDiscreteInput(address)}
                statusBadgeText={entry.readError ? "Not avail" : (entry.pending ? "Reading" : null)}
                statusBadgeTitle={entry.readError ?? "Reading from device"}
                statusBadgeVariant={entry.readError ? "failed" : "pending"}
                writeButtonTitle={connected ? "Read only" : "Connect to device first"}
                deleteButtonTitle="Delete coil"
              />
            {/each}
          </div>

          {#if switchBottomSpacerHeight > 0}
            <div class="switch-spacer" style={`height: ${switchBottomSpacerHeight}px;`}></div>
          {/if}
        </div>
      {/if}
    {/snippet}
  </PanelFrame>
</div>

<style>
  /* ── Layout ──────────────────────────────────────────────────────────────── */
  .coils-page {
    display: grid;
    gap: 10px;
  }

  /* ── Header controls ─────────────────────────────────────────────────────── */
  .poll-controls {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .view-toggle {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .divider-v {
    width: 1px;
    height: 20px;
    background: var(--c-border);
  }

  .ctrl-select {
    height: 24px;
    padding: 0 20px 0 7px;
    border: 1px solid var(--c-border);
    border-radius: 4px;
    background: color-mix(in srgb, var(--c-surface-1) 72%, var(--c-surface-2));
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%23c9cfda' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 5px center;
    appearance: none;
    color: var(--c-text-2);
    font: inherit;
    font-size: 0.64rem;
    cursor: pointer;
  }

  .ctrl-btn {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 24px;
    padding: 0 8px;
    border: 1px solid var(--c-border);
    border-radius: 4px;
    background: color-mix(in srgb, var(--c-surface-1) 72%, var(--c-surface-2));
    color: var(--c-text-2);
    font: inherit;
    font-size: 0.64rem;
    cursor: pointer;
    transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
    white-space: nowrap;
  }

  .ctrl-btn.icon-only {
    padding: 0 6px;
  }

  .ctrl-btn:hover {
    border-color: var(--c-border-strong);
    color: var(--c-text-1);
  }

  .ctrl-btn.active {
    border-color: color-mix(in srgb, var(--c-border-strong) 88%, var(--c-surface-3));
    background: color-mix(in srgb, var(--c-surface-3) 62%, var(--c-surface-2));
    color: var(--c-text-1);
    box-shadow: inset 0 -1px 0 0 var(--c-accent);
  }

  .ctrl-btn.active :global(svg) {
    color: var(--c-accent);
  }

  /* ── Toolbar ─────────────────────────────────────────────────────────────── */
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  .filter-tabs {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    background: transparent;
    border: 0;
    border-radius: 0;
    padding: 0;
  }

  .filter-tab {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 9px;
    border: 0;
    border-bottom: 1px solid transparent;
    border-radius: 0;
    background: transparent;
    color: var(--c-text-2);
    font: inherit;
    font-size: 0.62rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    cursor: pointer;
    transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
  }

  .filter-tab:hover {
    color: var(--c-text-1);
    background: color-mix(in srgb, var(--c-surface-3) 34%, transparent);
  }

  .filter-tab.active {
    border-bottom-color: var(--c-accent);
    background: color-mix(in srgb, var(--c-surface-3) 50%, transparent);
    color: var(--c-text-1);
  }

  .count {
    display: inline-flex;
    align-items: center;
    height: 14px;
    font-size: 0.58rem;
    color: var(--c-text-2);
    background: var(--c-surface-3);
    border-radius: 999px;
    padding: 0 5px;
  }

  .count.on  { color: var(--c-ok);   background: color-mix(in srgb, var(--c-ok) 15%, var(--c-surface-3)); }
  .count.off { color: var(--c-text-2); }

  .toolbar-actions {
    display: flex;
    align-items: center;
    gap: 3px;
  }

  /* ── Sub-panels (range + write) ──────────────────────────────────────────── */
  .sub-panel {
    display: grid;
    gap: 10px;
  }

  .mini-section {
    display: grid;
    gap: 8px;
    border-top: 1px solid color-mix(in srgb, var(--c-border) 55%, transparent);
    padding-top: 8px;
  }

  .mini-section:first-of-type {
    border-top: none;
    padding-top: 0;
  }

  .mini-section-danger {
    border-top-style: dashed;
  }

  .mini-title {
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--c-text-2);
  }

  .sub-title {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--c-text-1);
  }

  .sub-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .form-group label {
    font-size: 0.68rem;
    font-weight: 500;
    color: var(--c-text-1);
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }

  input[type="number"], select {
    height: 30px;
    padding: 0 8px;
    border: 1px solid var(--c-border);
    border-radius: 6px;
    background: var(--c-surface-2);
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.75rem;
  }

  input[type="number"]:focus, select:focus {
    outline: none;
    border-color: var(--c-accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--c-accent) 14%, transparent);
  }

  select {
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%23c9cfda' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 6px center;
    padding-right: 24px;
    cursor: pointer;
  }

  /* Shared btn */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 14px;
    border-radius: 7px;
    font: inherit;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 140ms ease;
    white-space: nowrap;
  }

  .btn-sm {
    height: 30px;
    padding: 0 12px;
    font-size: 0.72rem;
  }

  .btn-apply {
    border: 1px solid var(--c-border);
    background: var(--c-surface-3);
    color: var(--c-text-1);
  }
  .btn-apply:hover { border-color: var(--c-border-strong); }

  .btn-processing,
  .btn:disabled {
    opacity: 0.78;
    cursor: not-allowed;
  }

  .spin {
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .btn-clear {
    border: 1px solid color-mix(in srgb, var(--c-text-2) 25%, var(--c-border));
    background: color-mix(in srgb, var(--c-text-2) 8%, var(--c-surface-2));
    color: var(--c-text-2);
  }

  .btn-clear:hover:not(:disabled) {
    border-color: var(--c-border-strong);
    color: var(--c-text-1);
  }

  .btn-clear:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* ── Table view ──────────────────────────────────────────────────────────── */
  .coil-table {
    display: grid;
    gap: 0;
  }

  .ct-body {
    max-height: min(62vh, 680px);
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
  }

  .ct-spacer {
    width: 100%;
  }

  .ct-header {
    display: grid;
    grid-template-columns: minmax(140px, 1fr) 92px 64px 88px 182px 52px;
    align-items: center;
    gap: 0;
  }

  .ct-header {
    font-size: 0.63rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--c-text-2);
    padding: 0 4px 6px;
    border-bottom: 1px solid var(--c-border);
  }

  .ct-header > span { padding: 0 4px; }

  /* ── Switch / card view ──────────────────────────────────────────────────── */
  .switch-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    justify-content: stretch;
    gap: 7px;
  }

  .switch-virtual-scroll {
    max-height: min(62vh, 680px);
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
  }

  .switch-spacer {
    width: 100%;
  }

  @media (max-width: 760px) {
    .toolbar {
      flex-direction: column;
      align-items: stretch;
    }

    .toolbar-actions {
      justify-content: space-between;
    }

    .switch-grid {
      grid-template-columns: 1fr;
      justify-content: stretch;
    }
  }

  /* ── Empty state ─────────────────────────────────────────────────────────── */
  .empty {
    padding: 32px 0;
    text-align: center;
    color: var(--c-text-2);
    font-size: 0.82rem;
    font-style: italic;
  }

  /* ── Disconnected banner ─────────────────────────────────────────────────── */
  .disconnected-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--c-warn, #f0a500) 35%, var(--c-border));
    background: color-mix(in srgb, var(--c-warn, #f0a500) 8%, var(--c-surface-2));
    font-size: 0.8rem;
    color: var(--c-text-1);
  }

  .banner-icon {
    flex-shrink: 0;
    font-size: 1rem;
    line-height: 1;
  }

  .banner-text strong {
    color: var(--c-accent);
  }

  :global(button:disabled),
  :global(select:disabled) {
    opacity: 0.38;
    cursor: not-allowed;
    pointer-events: none;
  }
</style>
