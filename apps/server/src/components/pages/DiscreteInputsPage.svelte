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
    type DiscreteInputAddressFilter,
    setDiscreteInputAddressFilter,
    setDiscreteInputAddressList,
    setDiscreteInputAddressRange,
    setDiscreteInputFilter,
    setDiscreteInputLabel,
    setDiscreteInputPollActive,
    setDiscreteInputPollInterval,
    setDiscreteInputView,
  } from "../../state/discrete-inputs.svelte";
  import { connectionState } from "../../state/connection.svelte";
  import { estimateFrameMs } from "../../lib/frame-timing";
  import {
    formatAddressWithSettings,
    getGlobalPollingMaxAddressCount,
    isPollingAllowedForCount,
  } from "../../state/settings.svelte";
  import { notifyWarning } from "../../state/notifications.svelte";
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
  const DISCRETE_READ_CHUNK_MAX = 2000;

  interface AddressSection {
    start: number;
    quantity: number;
  }

  function buildAddressSections(addresses: number[]): AddressSection[] {
    if (addresses.length === 0) return [];

    const uniqueSorted = [...new Set(addresses)].sort((a, b) => a - b);
    const sections: AddressSection[] = [];
    let sectionStart = uniqueSorted[0];
    let prev = uniqueSorted[0];

    for (let i = 1; i < uniqueSorted.length; i += 1) {
      const current = uniqueSorted[i];
      if (current === prev + 1) {
        prev = current;
        continue;
      }

      sections.push({ start: sectionStart, quantity: prev - sectionStart + 1 });
      sectionStart = current;
      prev = current;
    }

    sections.push({ start: sectionStart, quantity: prev - sectionStart + 1 });
    return sections;
  }

  function buildRequestPlan(
    addresses: number[],
    chunkMax: number,
    responsePayloadBytes: number,
  ): { frames: number; cycleMs: number } {
    const sections = buildAddressSections(addresses);
    const frames = sections.reduce((total, section) => total + Math.max(1, Math.ceil(section.quantity / chunkMax)), 0);
    const { protocol, serial, tcp } = connectionState;
    const frameMs = estimateFrameMs(
      responsePayloadBytes,
      protocol,
      serial.baudRate,
      serial.dataBits,
      serial.parity,
      serial.stopBits,
      tcp.responseTimeoutMs,
    );
    return { frames, cycleMs: frames * frameMs };
  }

  // ── Filtered coil list ──────────────────────────────────────────────────────
  const filtered = $derived(getFilteredDiscreteInputs());
  const readPlan = $derived(
    buildRequestPlan(discreteInputState.entries.map((entry) => entry.address), DISCRETE_READ_CHUNK_MAX, 250),
  );
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
    const availableHeight = Math.floor(containerBottom - bodyRect.top - reservedBottomGap);
    const viewportCap = Math.min(680, Math.floor(window.innerHeight * 0.62));
    const next = Math.max(180, Math.min(viewportCap, availableHeight));
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
  const anyAddressFilterActive = $derived(discreteInputState.addressFilter !== "all");
  const anyFilterActive = $derived(
    discreteInputState.filter !== "all" || discreteInputState.addressFilter !== "all",
  );
  const pollMaxCount = $derived(getGlobalPollingMaxAddressCount());
  const pollDisabledByCount = $derived(!isPollingAllowedForCount(discreteInputState.entries.length));

  // ── Inline label editing ────────────────────────────────────────────────────
  let editingAddress: number | null = $state(null);
  let selectedInputAddress: number | null = $state(null);
  let editLabelVal = $state("");
  let addAddressInput = $state("");
  let singleWriteAddressInput = $state("");
  let singleWriteDesired = $state(false);
  let filterPanelOpen = $state(false);
  let addressRangeStart = $state(discreteInputState.addressRangeStart);
  let addressRangeEnd = $state(discreteInputState.addressRangeEnd);
  let addressListInput = $state(discreteInputState.addressList.join(","));

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

  function handleManualReadAllDiscreteInputs(): void {
    if (discreteInputState.pollActive) {
      notifyWarning("Polling is already in progress. Stop polling to use manual refresh.");
      return;
    }

    // Keep current visible states stable during manual refresh to avoid UI flicker.
    void readAllDiscreteInputs({ markPending: false });
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

  function handleScrollChain(e: WheelEvent): void {
    const target = e.currentTarget as HTMLElement;
    const delta = e.deltaY;
    if (delta === 0) return;

    const atBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 1;
    const atTop = target.scrollTop <= 1;

    // If at boundary and trying to scroll past it, scroll parent instead
    if ((delta > 0 && atBottom) || (delta < 0 && atTop)) {
      const parent = document.querySelector(".main-content") as HTMLElement | null;
      if (parent) {
        const canScrollDown = parent.scrollTop + parent.clientHeight < parent.scrollHeight - 1;
        const canScrollUp = parent.scrollTop > 1;
        const shouldDelegate = (delta > 0 && canScrollDown) || (delta < 0 && canScrollUp);

        if (!shouldDelegate) return;

        const delegatedDelta = Math.sign(delta) * Math.min(48, Math.abs(delta) * 0.3);
        parent.scrollBy({ top: delegatedDelta, left: 0, behavior: "auto" });
        e.preventDefault();
      }
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

  function parseAddressListInput(raw: string): number[] {
    const values = new Set<number>();
    const tokens = raw
      .split(/[\s,;]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);

    for (const token of tokens) {
      const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
      if (rangeMatch) {
        const start = Math.max(0, Math.min(65535, Number(rangeMatch[1])));
        const end = Math.max(0, Math.min(65535, Number(rangeMatch[2])));
        const from = Math.min(start, end);
        const to = Math.max(start, end);
        for (let address = from; address <= to; address += 1) {
          values.add(address);
        }
        continue;
      }

      const single = Number(token);
      if (Number.isFinite(single) && single >= 0 && single <= 65535) {
        values.add(Math.floor(single));
      }
    }

    return [...values].sort((a, b) => a - b);
  }

  function applyAddressRangeFilter(): void {
    setDiscreteInputAddressRange(addressRangeStart, addressRangeEnd);
    addressRangeStart = discreteInputState.addressRangeStart;
    addressRangeEnd = discreteInputState.addressRangeEnd;
  }

  function applyAddressListFilter(): void {
    setDiscreteInputAddressList(parseAddressListInput(addressListInput));
    addressListInput = discreteInputState.addressList.join(",");
  }

  function onAddressFilterModeChange(mode: DiscreteInputAddressFilter): void {
    setDiscreteInputAddressFilter(mode);
    if (mode === "required-range" || mode === "non-required-range") {
      applyAddressRangeFilter();
    }
    if (mode === "required-list" || mode === "not-required-list") {
      applyAddressListFilter();
    }
  }
</script>

<div class="coils-page">
  {#if connectionState.status === "disconnected"}
    <div class="disconnected-banner" role="alert">
      <span class="banner-icon">⚠</span>
      <span class="banner-text">Server not running — go to <strong>Listener</strong> and start the server to accept client connections.</span>
    </div>
  {/if}

  <!-- ── Header ─────────────────────────────────────────────────────────────── -->
  <SectionHeader
    title="Discrete Inputs"
    subtitle="Server-hosted discrete inputs (FC 02) — read-only, clients can monitor these values"
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
          class="ctrl-btn poll-btn has-tip"
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
          onclick={handleManualReadAllDiscreteInputs}>
          <RefreshCw size={14} />
        </button>
        {#if pollDisabledByCount}
          <span class="pending-chip has-tip" data-tip="Global polling max reached">
            Poll disabled: list &gt; {pollMaxCount}
          </span>
        {/if}
        {#if discreteInputState.entries.length > 0}
          <span class="plan-chip has-tip" data-tip="Estimated FC02 frames and cycle time per read-all run">
            Read {readPlan.frames}f ~{readPlan.cycleMs}ms
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
    <div class="toolbar-left">
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

      <button
        class="ctrl-btn"
        class:active={filterPanelOpen}
        class:notice={anyFilterActive}
        type="button"
        onclick={() => { filterPanelOpen = !filterPanelOpen; }}
        title={anyFilterActive ? "Filters active" : "Open filters"}
      >
        <span>Filters</span>
        {#if anyFilterActive}
          <span class="active-filter-pill">Active</span>
        {/if}
      </button>
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

  {#if filterPanelOpen}
    <div class="address-filter-row">
      <div class="address-filter-title">Address Filter</div>
      <select
        class="address-filter-select"
        value={discreteInputState.addressFilter}
        onchange={(e) => onAddressFilterModeChange(e.currentTarget.value as DiscreteInputAddressFilter)}
        title="Address filter mode"
      >
        <option value="all">All addresses</option>
        <option value="required-range">Required range</option>
        <option value="non-required-range">Non-required range</option>
        <option value="required-list">Required list</option>
        <option value="not-required-list">Not-required list</option>
      </select>

      {#if discreteInputState.addressFilter === "required-range" || discreteInputState.addressFilter === "non-required-range"}
        <input
          class="address-filter-input"
          type="number"
          min="0"
          max="65535"
          value={addressRangeStart}
          oninput={(e) => { addressRangeStart = Number(e.currentTarget.value); }}
          placeholder="Start"
          title="Range start address"
        />
        <input
          class="address-filter-input"
          type="number"
          min="0"
          max="65535"
          value={addressRangeEnd}
          oninput={(e) => { addressRangeEnd = Number(e.currentTarget.value); }}
          placeholder="End"
          title="Range end address"
        />
        <button class="ctrl-btn" type="button" onclick={applyAddressRangeFilter}>Apply</button>
      {/if}

      {#if discreteInputState.addressFilter === "required-list" || discreteInputState.addressFilter === "not-required-list"}
        <input
          class="address-filter-list-input"
          type="text"
          value={addressListInput}
          oninput={(e) => { addressListInput = e.currentTarget.value; }}
          placeholder="e.g. 1,2,10-20,42"
          title="Comma, semicolon, or space separated addresses and ranges"
        />
        <button class="ctrl-btn" type="button" onclick={applyAddressListFilter}>Apply</button>
      {/if}

      {#if anyAddressFilterActive}
        <button
          class="ctrl-btn"
          type="button"
          onclick={() => setDiscreteInputAddressFilter("all")}
          title="Clear address filter"
        >
          <span>Clear Address Filter</span>
        </button>
      {/if}
    </div>
  {/if}

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
            onwheel={handleScrollChain}
            bind:clientHeight={tableViewportHeight}
            bind:this={tableBodyEl}
            style:max-height={`${dynamicScrollMaxHeight}px`}
          >
            {#if tableTopSpacerHeight > 0}
              <div class="ct-spacer" style={`height: ${tableTopSpacerHeight}px;`}></div>
            {/if}

            {#each visibleTableEntries as entry, rowIndex (entry.address)}
              <div
                class="selectable-item"
                class:zebra-row={(tableStartRow + rowIndex) % 2 === 1}
                class:selected-item={selectedInputAddress === entry.address}
                role="button"
                tabindex="0"
                onclick={() => { selectedInputAddress = entry.address; }}
                onkeydown={(e) => {
                  const target = e.target as HTMLElement | null;
                  if (
                    target &&
                    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
                  ) {
                    return;
                  }
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    selectedInputAddress = entry.address;
                  }
                }}
              >
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
              </div>
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
          onwheel={handleScrollChain}
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
              <div
                class="selectable-item"
                class:selected-item={selectedInputAddress === entry.address}
                role="button"
                tabindex="0"
                onclick={() => { selectedInputAddress = entry.address; }}
                onkeydown={(e) => {
                  const target = e.target as HTMLElement | null;
                  if (
                    target &&
                    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
                  ) {
                    return;
                  }
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    selectedInputAddress = entry.address;
                  }
                }}
              >
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
                  deleteButtonTitle="Delete coil"
                />
              </div>
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
  /* ── Page-unique: table column layout ───────────────────────────────────── */
  .ct-header {
    grid-template-columns: minmax(140px, 1fr) 92px 64px 88px 182px 52px;
  }
</style>
