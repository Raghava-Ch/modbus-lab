<svelte:options runes={true} />

<script lang="ts">
  import { untrack } from "svelte";
  import {
    Table2,
    LayoutGrid,
    RefreshCw,
    Play,
    SlidersHorizontal,
    ChevronDown,
    ChevronUp,
    LoaderCircle,
    Timer,
    X,
  } from "lucide-svelte";
  import {
    addHoldingRegisterRange,
    addExclusiveHoldingRegister,
    generateRandomExclusiveHoldingRegisterAddress,
    getFilteredHoldingRegisters,
    type HoldingRegisterAddressFilter,
    holdingRegisterState,
    initHoldingRegisterState,
    readAllHoldingRegisters,
    readHoldingRegister,
    removeAllHoldingRegisters,
    removeHoldingRegister,
    setAllHoldingRegisterDesiredFromRead,
    setHoldingRegisterAddressFilter,
    setHoldingRegisterAddressList,
    setHoldingRegisterAddressRange,
    setHoldingRegisterDesiredValue,
    setHoldingRegisterFilter,
    setHoldingRegisterLabel,
    setHoldingRegisterPollActive,
    setHoldingRegisterPollInterval,
    setHoldingRegisterView,
    writeHoldingRegister,
    writePendingHoldingRegisters,
  } from "../../state/holding-registers.svelte";
  import { connectionState } from "../../state/connection.svelte";
  import { estimateFrameMs } from "../../lib/frame-timing";
  import {
    formatAddressWithSettings,
    formatWordValueWithSettings,
    getGlobalPollingMaxAddressCount,
  } from "../../state/settings.svelte";
  import { notifyWarning } from "../../state/notifications.svelte";
  import { registerDetailsState, selectRegisterDetails } from "../../state/register-details.svelte";
  import SectionHeader from "../shared/SectionHeader.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";
  import RegisterTableRow from "../shared/RegisterTableRow.svelte";
  import RegisterCard from "../shared/RegisterCard.svelte";

  $effect(() => {
    untrack(() => initHoldingRegisterState());
    return () => {
      setHoldingRegisterPollActive(false);
    };
  });

  $effect(() => {
    if (connectionState.status !== "connected" && holdingRegisterState.pollActive) {
      setHoldingRegisterPollActive(false);
    }
  });

  const connected = $derived(connectionState.status === "connected");

  let readPanelOpen = $state(false);
  let rangeStart = $state(holdingRegisterState.startAddress);
  let rangeCount = $state(holdingRegisterState.registerCount);
  let rangeApplyPending = $state(false);
  const RANGE_APPLY_MIN_SPINNER_MS = 250;
  const HOLDING_READ_CHUNK_MAX = 125;
  const HOLDING_WRITE_CHUNK_MAX = 120;

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

  const filtered = $derived(getFilteredHoldingRegisters());
  const readPlan = $derived(
    buildRequestPlan(holdingRegisterState.entries.map((entry) => entry.address), HOLDING_READ_CHUNK_MAX, 250),
  );
  const LARGE_DATASET_THRESHOLD = 5000;
  const VIRTUAL_ROW_HEIGHT = 34;
  const VIRTUAL_OVERSCAN = 10;
  const CARD_VIRTUAL_THRESHOLD = 200;
  const CARD_ROW_HEIGHT = 230;
  const CARD_MIN_WIDTH = 220;
  let tableScrollTop = $state(0);
  let tableViewportHeight = $state(460);
  let tableBodyEl: HTMLDivElement | null = $state(null);
  let cardScrollTop = $state(0);
  let cardViewportHeight = $state(520);
  let cardViewportWidth = $state(900);
  let cardBodyEl: HTMLDivElement | null = $state(null);
  let tableBodyMaxHeight = $state(680);

  function refreshTableBodyMaxHeight(): void {
    if (typeof window === "undefined") return;

    const usingTableView =
      holdingRegisterState.view === "table"
      || (holdingRegisterState.view === "cards" && filtered.length >= LARGE_DATASET_THRESHOLD);
    const targetEl = usingTableView ? tableBodyEl : cardBodyEl;
    if (!targetEl) return;

    const mainContent = document.querySelector(".main-content") as HTMLElement | null;
    const bodyRect = targetEl.getBoundingClientRect();
    const containerBottom = mainContent?.getBoundingClientRect().bottom ?? window.innerHeight;
    const reservedBottomGap = 28;
    const availableHeight = Math.floor(containerBottom - bodyRect.top - reservedBottomGap);
    const viewportCap = Math.min(680, Math.floor(window.innerHeight * 0.62));
    const next = Math.max(180, Math.min(viewportCap, availableHeight));
    tableBodyMaxHeight = next;
  }

  $effect(() => {
    if (typeof window === "undefined") return;

    refreshTableBodyMaxHeight();

    const mainContent = document.querySelector(".main-content") as HTMLElement | null;
    const resizeObserver = new ResizeObserver(() => {
      refreshTableBodyMaxHeight();
    });

    if (tableBodyEl) {
      resizeObserver.observe(tableBodyEl);
    }
    if (cardBodyEl) {
      resizeObserver.observe(cardBodyEl);
    }
    if (mainContent) {
      resizeObserver.observe(mainContent);
    }

    window.addEventListener("resize", refreshTableBodyMaxHeight);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", refreshTableBodyMaxHeight);
    };
  });

  $effect(() => {
    readPanelOpen;
    filterPanelOpen;
    showVirtualTable;

    if (typeof window === "undefined") return;

    // Wait for layout to settle after panel open/close before measuring.
    const raf1 = window.requestAnimationFrame(() => {
      const raf2 = window.requestAnimationFrame(() => {
        refreshTableBodyMaxHeight();
      });
      return () => window.cancelAnimationFrame(raf2);
    });

    return () => {
      window.cancelAnimationFrame(raf1);
    };
  });

  const forceTableForLargeData = $derived(
    holdingRegisterState.view === "cards" && filtered.length >= LARGE_DATASET_THRESHOLD,
  );
  const showVirtualTable = $derived(
    holdingRegisterState.view === "table" || forceTableForLargeData,
  );
  const virtualEnabled = $derived(filtered.length >= 400);
  const virtualStart = $derived(
    virtualEnabled
      ? Math.max(0, Math.floor(tableScrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN)
      : 0,
  );
  const visibleRowCount = $derived(
    Math.max(1, Math.ceil(tableViewportHeight / VIRTUAL_ROW_HEIGHT)),
  );
  const virtualEnd = $derived(
    virtualEnabled
      ? Math.min(filtered.length, virtualStart + visibleRowCount + VIRTUAL_OVERSCAN * 2)
      : filtered.length,
  );
  const visibleRows = $derived(
    virtualEnabled ? filtered.slice(virtualStart, virtualEnd) : filtered,
  );
  const topSpacerHeight = $derived(virtualEnabled ? virtualStart * VIRTUAL_ROW_HEIGHT : 0);
  const bottomSpacerHeight = $derived(
    virtualEnabled ? Math.max(0, (filtered.length - virtualEnd) * VIRTUAL_ROW_HEIGHT) : 0,
  );
  const cardVirtualEnabled = $derived(filtered.length >= CARD_VIRTUAL_THRESHOLD);
  const cardColumns = $derived(
    Math.max(1, Math.floor(Math.max(1, cardViewportWidth) / CARD_MIN_WIDTH)),
  );
  const cardTotalRows = $derived(Math.max(1, Math.ceil(filtered.length / cardColumns)));
  const cardStartRow = $derived(
    cardVirtualEnabled
      ? Math.max(0, Math.floor(cardScrollTop / CARD_ROW_HEIGHT) - VIRTUAL_OVERSCAN)
      : 0,
  );
  const cardVisibleRowCount = $derived(
    Math.max(1, Math.ceil(cardViewportHeight / CARD_ROW_HEIGHT)),
  );
  const cardEndRow = $derived(
    cardVirtualEnabled
      ? Math.min(cardTotalRows, cardStartRow + cardVisibleRowCount + VIRTUAL_OVERSCAN * 2)
      : cardTotalRows,
  );
  const cardStartIndex = $derived(cardStartRow * cardColumns);
  const cardEndIndex = $derived(
    cardVirtualEnabled ? Math.min(filtered.length, cardEndRow * cardColumns) : filtered.length,
  );
  const visibleCards = $derived(
    cardVirtualEnabled ? filtered.slice(cardStartIndex, cardEndIndex) : filtered,
  );
  const cardTopSpacerHeight = $derived(
    cardVirtualEnabled ? cardStartRow * CARD_ROW_HEIGHT : 0,
  );
  const cardBottomSpacerHeight = $derived(
    cardVirtualEnabled ? Math.max(0, (cardTotalRows - cardEndRow) * CARD_ROW_HEIGHT) : 0,
  );
  const nonZeroCount = $derived(holdingRegisterState.entries.filter((e) => e.slaveValue !== 0).length);
  const zeroCount = $derived(holdingRegisterState.entries.filter((e) => e.slaveValue === 0).length);
  const pendingWriteCount = $derived(
    holdingRegisterState.entries.filter((e) => e.desiredValue !== e.slaveValue).length,
  );
  const writePlan = $derived(
    buildRequestPlan(
      holdingRegisterState.entries
        .filter((entry) => entry.desiredValue !== entry.slaveValue)
        .map((entry) => entry.address),
      HOLDING_WRITE_CHUNK_MAX,
      4,
    ),
  );
  const anyAddressFilterActive = $derived(holdingRegisterState.addressFilter !== "all");
  const anyFilterActive = $derived(
    holdingRegisterState.filter !== "all" || holdingRegisterState.addressFilter !== "all",
  );
  const failedWriteCount = $derived(
    holdingRegisterState.entries.filter((e) => e.desiredValue !== e.slaveValue && e.writeError !== null).length,
  );

  let editingAddress: number | null = $state(null);
  let editLabelVal = $state("");
  let addAddressInput = $state("");
  let filterPanelOpen = $state(false);
  let addressRangeStart = $state(holdingRegisterState.addressRangeStart);
  let addressRangeEnd = $state(holdingRegisterState.addressRangeEnd);
  let addressListInput = $state(holdingRegisterState.addressList.join(","));

  const pollIntervals: { ms: number; label: string }[] = [
    { ms: 500, label: "500 ms" },
    { ms: 1000, label: "1 s" },
    { ms: 2000, label: "2 s" },
    { ms: 5000, label: "5 s" },
  ];

  const practicalMinPollIntervalMs = $derived(
    holdingRegisterState.entries.length >= 5000
      ? 5000
      : holdingRegisterState.entries.length >= 2000
        ? 2000
        : holdingRegisterState.entries.length >= 512
          ? 1000
          : 500,
  );

  const practicalMinPollLabel = $derived(
    practicalMinPollIntervalMs >= 1000
      ? `${practicalMinPollIntervalMs / 1000} s`
      : `${practicalMinPollIntervalMs} ms`,
  );

  const pollMaxCount = $derived(getGlobalPollingMaxAddressCount());
  const pollDisabledByCount = $derived(holdingRegisterState.entries.length > pollMaxCount);

  function beginEdit(address: number, current: string): void {
    editingAddress = address;
    editLabelVal = current;
  }

  function commitEdit(): void {
    if (editingAddress !== null) {
      setHoldingRegisterLabel(editingAddress, editLabelVal.trim());
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

  function handleManualReadAllHoldingRegisters(): void {
    if (holdingRegisterState.pollActive) {
      notifyWarning("Polling is already in progress. Stop polling to use manual refresh.");
      return;
    }

    // Keep table/card visuals stable during manual refresh.
    void readAllHoldingRegisters({ markPending: false });
  }

  async function handleApplyRange(): Promise<void> {
    if (rangeApplyPending) return;
    rangeApplyPending = true;
    try {
      // Let users see local processing state before applying changes.
      await new Promise<void>((resolve) => setTimeout(resolve, RANGE_APPLY_MIN_SPINNER_MS));
      addHoldingRegisterRange(rangeStart, rangeCount);
      rangeStart = holdingRegisterState.startAddress;
      rangeCount = holdingRegisterState.registerCount;
      addAddressInput = "";
    } finally {
      rangeApplyPending = false;
    }
  }

  function tryAddAddress(): void {
    const parsed = Number(addAddressInput.trim());
    if (!Number.isFinite(parsed)) return;
    const ok = addExclusiveHoldingRegister(parsed);
    if (ok) {
      addAddressInput = "";
    }
  }

  function suggestRandomAddress(): void {
    const picked = generateRandomExclusiveHoldingRegisterAddress();
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

  function addrFmt(n: number): string {
    return formatAddressWithSettings(n);
  }

  function valueFmt(n: number): string {
    return formatWordValueWithSettings(n);
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
    setHoldingRegisterAddressRange(addressRangeStart, addressRangeEnd);
    addressRangeStart = holdingRegisterState.addressRangeStart;
    addressRangeEnd = holdingRegisterState.addressRangeEnd;
  }

  function applyAddressListFilter(): void {
    setHoldingRegisterAddressList(parseAddressListInput(addressListInput));
    addressListInput = holdingRegisterState.addressList.join(",");
  }

  function onAddressFilterModeChange(mode: HoldingRegisterAddressFilter): void {
    setHoldingRegisterAddressFilter(mode);
    if (mode === "required-range" || mode === "non-required-range") {
      applyAddressRangeFilter();
    }
    if (mode === "required-list" || mode === "not-required-list") {
      applyAddressListFilter();
    }
  }
</script>

<div class="holding-registers-page">
  {#if connectionState.status === "disconnected"}
    <div class="disconnected-banner" role="alert">
      <span class="banner-icon">⚠</span>
      <span class="banner-text">Not connected — go to <strong>Connection</strong> and connect to a device before using holding-register operations.</span>
    </div>
  {/if}

  <SectionHeader
    title="Holding Registers"
    subtitle="FC 03 Read · FC 06 Write Single · FC 16 Write Multiple"
  >
    {#snippet actions()}
      <div class="poll-controls">
        <select
          class="ctrl-select has-tip"
          value={holdingRegisterState.pollInterval}
          onchange={(e) => setHoldingRegisterPollInterval(Math.max(Number(e.currentTarget.value), practicalMinPollIntervalMs))}
          data-tip="Poll interval"
          disabled={pollDisabledByCount}
        >
          {#each pollIntervals as pi}
            <option value={pi.ms} disabled={pi.ms < practicalMinPollIntervalMs}>{pi.label}</option>
          {/each}
        </select>
        <button
          class="ctrl-btn poll-btn has-tip"
          class:active={holdingRegisterState.pollActive}
          data-tip={pollDisabledByCount ? "Polling disabled when list has more than 125 registers" : holdingRegisterState.pollActive ? "Stop polling" : "Start polling"}
          type="button"
          disabled={!connected || pollDisabledByCount}
          onclick={() => setHoldingRegisterPollActive(!holdingRegisterState.pollActive)}
        >
          {#if holdingRegisterState.pollActive}
            <Timer size={14} />
            <span>Polling</span>
          {:else}
            <Play size={14} />
            <span>Poll</span>
          {/if}
        </button>
        <button class="ctrl-btn icon-only has-tip" data-tip="Read once" type="button" disabled={!connected}
          onclick={handleManualReadAllHoldingRegisters}>
          <RefreshCw size={14} />
        </button>
        {#if practicalMinPollIntervalMs > 500}
          <span class="pending-chip has-tip" data-tip="Auto-limited for practical polling at current dataset size">
            Min poll: {practicalMinPollLabel}
          </span>
        {/if}
        {#if pollDisabledByCount}
          <span class="pending-chip has-tip" data-tip={`Polling is limited to at most ${pollMaxCount} holding registers`}>
            Poll disabled: list &gt; {pollMaxCount}
          </span>
        {/if}
        {#if holdingRegisterState.entries.length > 0}
          <span class="plan-chip has-tip" data-tip="Estimated FC03 frames and cycle time per read-all run">
            Read {readPlan.frames}f ~{readPlan.cycleMs}ms
          </span>
        {/if}
      </div>

      <div class="divider-v"></div>

      <div class="view-toggle">
        <button
          class="ctrl-btn icon-only"
          class:active={holdingRegisterState.view === "table"}
          title="Table view"
          type="button"
          onclick={() => setHoldingRegisterView("table")}
        >
          <Table2 size={15} />
        </button>
        <button
          class="ctrl-btn icon-only"
          class:active={holdingRegisterState.view === "cards"}
          title="Card view"
          type="button"
          onclick={() => setHoldingRegisterView("cards")}
        >
          <LayoutGrid size={15} />
        </button>
      </div>

    {/snippet}
  </SectionHeader>

  <div class="toolbar">
    <div class="toolbar-left">
      <div class="filter-tabs">
        <button
          class="filter-tab"
          class:active={holdingRegisterState.filter === "all"}
          type="button"
          onclick={() => setHoldingRegisterFilter("all")}
        >All <span class="count">{holdingRegisterState.entries.length}</span></button>
        <button
          class="filter-tab"
          class:active={holdingRegisterState.filter === "non-zero"}
          type="button"
          onclick={() => setHoldingRegisterFilter("non-zero")}
        >Non-zero <span class="count on">{nonZeroCount}</span></button>
        <button
          class="filter-tab"
          class:active={holdingRegisterState.filter === "zero"}
          type="button"
          onclick={() => setHoldingRegisterFilter("zero")}
        >Zero <span class="count off">{zeroCount}</span></button>
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
      {#if filtered.length >= LARGE_DATASET_THRESHOLD}
        <span class="pending-chip" title="Large dataset can reduce UI responsiveness">
          Large set: {filtered.length}
        </span>
      {/if}
      {#if pendingWriteCount > 0}
        <span class="pending-chip" title="Estimated FC16 frames and cycle time for pending writes">
          Write plan: {writePlan.frames}f ~{writePlan.cycleMs}ms
        </span>
        <button
          class="pending-chip pending-chip-action"
          type="button"
          disabled={!connected}
          onclick={() => { void writePendingHoldingRegisters(); }}
          title={connected ? "Write all pending registers" : "Connect to device first"}
        >
          Pending write: {pendingWriteCount}
          {#if failedWriteCount > 0}
            <span class="pending-chip-failed">Failed: {failedWriteCount}</span>
          {/if}
        </button>
      {/if}
      <button
        class="ctrl-btn"
        type="button"
        onclick={() => { setAllHoldingRegisterDesiredFromRead(); }}
        title="Copy all current read values into desired values"
      >
        <span>Read → Desired</span>
      </button>

      <button
        class="ctrl-btn"
        class:active={readPanelOpen}
        type="button"
        onclick={() => { readPanelOpen = !readPanelOpen; }}
        title="Add registers"
      >
        <SlidersHorizontal size={13} />
        <span>Add Registers</span>
        {#if readPanelOpen}<ChevronUp size={12} />{:else}<ChevronDown size={12} />{/if}
      </button>
    </div>
  </div>

  {#if filterPanelOpen}
    <div class="address-filter-row">
      <div class="address-filter-title">Address Filter</div>
      <select
        class="address-filter-select"
        value={holdingRegisterState.addressFilter}
        onchange={(e) => onAddressFilterModeChange(e.currentTarget.value as HoldingRegisterAddressFilter)}
        title="Address filter mode"
      >
        <option value="all">All addresses</option>
        <option value="required-range">Required range</option>
        <option value="non-required-range">Non-required range</option>
        <option value="required-list">Required list</option>
        <option value="not-required-list">Not-required list</option>
      </select>

      {#if holdingRegisterState.addressFilter === "required-range" || holdingRegisterState.addressFilter === "non-required-range"}
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

      {#if holdingRegisterState.addressFilter === "required-list" || holdingRegisterState.addressFilter === "not-required-list"}
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
          onclick={() => setHoldingRegisterAddressFilter("all")}
          title="Clear address filter"
        >
          <span>Clear Address Filter</span>
        </button>
      {/if}
    </div>
  {/if}

  {#if readPanelOpen}
    <PanelFrame>
      {#snippet children()}
        <div class="sub-panel">
          <div class="sub-title">Add Registers</div>

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
              <button class="btn btn-sm btn-apply" type="button" onclick={suggestRandomAddress} title="Generate random free address">
                Random
              </button>
              <button class="btn btn-sm btn-apply" type="button" onclick={tryAddAddress}>Add</button>
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
              <button class="btn btn-sm btn-clear" type="button" onclick={removeAllHoldingRegisters}>
                Clear Added Registers
              </button>
            </div>
          </div>
        </div>
      {/snippet}
    </PanelFrame>
  {/if}

  <PanelFrame>
    {#snippet children()}
      {#if filtered.length === 0}
        <div class="empty">No holding registers match the current filter.</div>
      {:else if showVirtualTable}
        <div class="register-table">
          <div class="rt-header">
            <span>Label</span>
            <span>Status</span>
            <span>Addr</span>
            <span>Read</span>
            <span>Desired</span>
            <span>Operation</span>
            <span>Delete</span>
          </div>
          <div
            class="rt-body"
            onscroll={(e) => { tableScrollTop = e.currentTarget.scrollTop; }}
            onwheel={handleScrollChain}
            bind:clientHeight={tableViewportHeight}
            bind:this={tableBodyEl}
            style:max-height={`${tableBodyMaxHeight}px`}
          >
            {#if topSpacerHeight > 0}
              <div class="rt-spacer" style={`height: ${topSpacerHeight}px;`}></div>
            {/if}

            {#each visibleRows as entry, rowIndex (entry.address)}
              <div
                class="selectable-item"
                class:zebra-row={(virtualStart + rowIndex) % 2 === 1}
                class:selected-item={registerDetailsState.kind === "holding" && registerDetailsState.address === entry.address}
                role="button"
                tabindex="0"
                onclick={() => { selectRegisterDetails("holding", entry.address); }}
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
                    selectRegisterDetails("holding", entry.address);
                  }
                }}
              >
                <RegisterTableRow
                  {entry}
                  {connected}
                  {editingAddress}
                  {editLabelVal}
                  {addrFmt}
                  {valueFmt}
                  {beginEdit}
                  {commitEdit}
                  {cancelEdit}
                  {onLabelKeydown}
                  onEditLabelValChange={(next: string) => { editLabelVal = next; }}
                  onDesiredChange={(address: number, value: number) => setHoldingRegisterDesiredValue(address, value)}
                  onRead={(address: number) => { void readHoldingRegister(address); }}
                  onWrite={(address: number) => { void writeHoldingRegister(address); }}
                  onDelete={(address: number) => removeHoldingRegister(address)}
                />
              </div>
            {/each}

            {#if bottomSpacerHeight > 0}
              <div class="rt-spacer" style={`height: ${bottomSpacerHeight}px;`}></div>
            {/if}
          </div>
        </div>
      {:else}
        <div
          class="switch-virtual-scroll"
          onscroll={(e) => { cardScrollTop = e.currentTarget.scrollTop; }}
          onwheel={handleScrollChain}
          bind:clientHeight={cardViewportHeight}
          bind:clientWidth={cardViewportWidth}
          bind:this={cardBodyEl}
          style:max-height={`${tableBodyMaxHeight}px`}
        >
          {#if cardTopSpacerHeight > 0}
            <div class="switch-spacer" style={`height: ${cardTopSpacerHeight}px;`}></div>
          {/if}

          <div class="switch-grid">
            {#each visibleCards as entry (entry.address)}
              <div
                class="selectable-item"
                class:selected-item={registerDetailsState.kind === "holding" && registerDetailsState.address === entry.address}
                role="button"
                tabindex="0"
                onclick={() => { selectRegisterDetails("holding", entry.address); }}
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
                    selectRegisterDetails("holding", entry.address);
                  }
                }}
              >
                <RegisterCard
                  address={entry.address}
                  label={entry.label}
                  pending={entry.pending}
                  slaveValue={entry.slaveValue}
                  {valueFmt}
                  desiredValue={entry.desiredValue}
                  {connected}
                  cardDirty={entry.desiredValue !== entry.slaveValue || entry.readError !== null || entry.writeError !== null}
                  {editingAddress}
                  {editLabelVal}
                  {addrFmt}
                  onBeginEdit={beginEdit}
                  onCommitEdit={commitEdit}
                  onCancelEdit={cancelEdit}
                  {onLabelKeydown}
                  onEditLabelValChange={(next: string) => { editLabelVal = next; }}
                  onDesiredChange={(address: number, value: number) => setHoldingRegisterDesiredValue(address, value)}
                  onRead={(address: number) => { void readHoldingRegister(address); }}
                  onWrite={(address: number) => { void writeHoldingRegister(address); }}
                  onDelete={(address: number) => removeHoldingRegister(address)}
                  statusBadgeText={entry.readError ? "Not avail" : (entry.writeError ? "Not avail" : (entry.desiredValue !== entry.slaveValue ? "Unsynced" : null))}
                  statusBadgeTitle={entry.readError ?? entry.writeError ?? "Local value differs from device"}
                  statusBadgeVariant={entry.readError || entry.writeError ? "failed" : "pending"}
                />
              </div>
            {/each}
          </div>

          {#if cardBottomSpacerHeight > 0}
            <div class="switch-spacer" style={`height: ${cardBottomSpacerHeight}px;`}></div>
          {/if}
        </div>
      {/if}
    {/snippet}
  </PanelFrame>

</div>

<style>
  /* ── Page-unique: table column layout ───────────────────────────────────── */
  .rt-header {
    grid-template-columns: minmax(140px, 1fr) 92px 64px 88px 110px 182px 52px;
  }

  /* ── Page-unique: failed write badge ────────────────────────────────────── */
  .pending-chip-failed {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--c-danger) 16%, var(--c-surface-3));
    color: var(--c-danger);
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.03em;
  }
</style>
