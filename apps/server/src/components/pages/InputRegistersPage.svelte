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
    addExclusiveInputRegister,
    addInputRegisterRange,
    generateRandomExclusiveInputRegisterAddress,
    getFilteredInputRegisters,
    type InputRegisterAddressFilter,
    inputRegisterState,
    initInputRegisterState,
    readAllInputRegisters,
    readInputRegister,
    removeAllInputRegisters,
    removeInputRegister,
    setInputRegisterAddressFilter,
    setInputRegisterAddressList,
    setInputRegisterAddressRange,
    setInputRegisterFilter,
    setInputRegisterLabel,
    setInputRegisterPollActive,
    setInputRegisterPollInterval,
    setInputRegisterView,
  } from "../../state/input-registers.svelte";
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
  import InputRegisterTableRow from "../shared/InputRegisterTableRow.svelte";
  import InputRegisterCard from "../shared/InputRegisterCard.svelte";

  $effect(() => {
    untrack(() => initInputRegisterState());
    return () => {
      setInputRegisterPollActive(false);
    };
  });

  $effect(() => {
    if (connectionState.status !== "connected" && inputRegisterState.pollActive) {
      setInputRegisterPollActive(false);
    }
  });

  const connected = $derived(connectionState.status === "connected");

  let readPanelOpen = $state(false);
  let rangeStart = $state(inputRegisterState.startAddress);
  let rangeCount = $state(inputRegisterState.registerCount);
  let rangeApplyPending = $state(false);
  const RANGE_APPLY_MIN_SPINNER_MS = 250;
  const INPUT_READ_CHUNK_MAX = 125;

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

  const filtered = $derived(getFilteredInputRegisters());
  const readPlan = $derived(
    buildRequestPlan(inputRegisterState.entries.map((entry) => entry.address), INPUT_READ_CHUNK_MAX, 250),
  );
  const LARGE_DATASET_THRESHOLD = 5000;
  const VIRTUAL_ROW_HEIGHT = 34;
  const VIRTUAL_OVERSCAN = 10;
  const CARD_VIRTUAL_THRESHOLD = 200;
  const CARD_ROW_HEIGHT = 210;
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
      inputRegisterState.view === "table"
      || (inputRegisterState.view === "cards" && filtered.length >= LARGE_DATASET_THRESHOLD);
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

    if (tableBodyEl) resizeObserver.observe(tableBodyEl);
    if (cardBodyEl) resizeObserver.observe(cardBodyEl);
    if (mainContent) resizeObserver.observe(mainContent);

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
    inputRegisterState.view === "cards" && filtered.length >= LARGE_DATASET_THRESHOLD,
  );
  const showVirtualTable = $derived(
    inputRegisterState.view === "table" || forceTableForLargeData,
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
  const nonZeroCount = $derived(inputRegisterState.entries.filter((e) => e.value !== 0).length);
  const zeroCount = $derived(inputRegisterState.entries.filter((e) => e.value === 0).length);
  const anyAddressFilterActive = $derived(inputRegisterState.addressFilter !== "all");
  const anyFilterActive = $derived(
    inputRegisterState.filter !== "all" || inputRegisterState.addressFilter !== "all",
  );

  let editingAddress: number | null = $state(null);
  let editLabelVal = $state("");
  let addAddressInput = $state("");
  let filterPanelOpen = $state(false);
  let addressRangeStart = $state(inputRegisterState.addressRangeStart);
  let addressRangeEnd = $state(inputRegisterState.addressRangeEnd);
  let addressListInput = $state(inputRegisterState.addressList.join(","));

  const pollIntervals: { ms: number; label: string }[] = [
    { ms: 500, label: "500 ms" },
    { ms: 1000, label: "1 s" },
    { ms: 2000, label: "2 s" },
    { ms: 5000, label: "5 s" },
  ];

  const practicalMinPollIntervalMs = $derived(
    inputRegisterState.entries.length >= 5000
      ? 5000
      : inputRegisterState.entries.length >= 2000
        ? 2000
        : inputRegisterState.entries.length >= 512
          ? 1000
          : 500,
  );

  const practicalMinPollLabel = $derived(
    practicalMinPollIntervalMs >= 1000
      ? `${practicalMinPollIntervalMs / 1000} s`
      : `${practicalMinPollIntervalMs} ms`,
  );

  const pollMaxCount = $derived(getGlobalPollingMaxAddressCount());
  const pollDisabledByCount = $derived(inputRegisterState.entries.length > pollMaxCount);

  function beginEdit(address: number, current: string): void {
    editingAddress = address;
    editLabelVal = current;
  }

  function commitEdit(): void {
    if (editingAddress !== null) {
      setInputRegisterLabel(editingAddress, editLabelVal.trim());
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

  function handleManualReadAllInputRegisters(): void {
    if (inputRegisterState.pollActive) {
      notifyWarning("Polling is already in progress. Stop polling to use manual refresh.");
      return;
    }

    // Keep table/card visuals stable during manual refresh.
    void readAllInputRegisters({ markPending: false });
  }

  async function handleApplyRange(): Promise<void> {
    if (rangeApplyPending) return;
    rangeApplyPending = true;
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, RANGE_APPLY_MIN_SPINNER_MS));
      addInputRegisterRange(rangeStart, rangeCount);
      rangeStart = inputRegisterState.startAddress;
      rangeCount = inputRegisterState.registerCount;
      addAddressInput = "";
    } finally {
      rangeApplyPending = false;
    }
  }

  function tryAddAddress(): void {
    const parsed = Number(addAddressInput.trim());
    if (!Number.isFinite(parsed)) return;
    const ok = addExclusiveInputRegister(parsed);
    if (ok) {
      addAddressInput = "";
    }
  }

  function suggestRandomAddress(): void {
    const picked = generateRandomExclusiveInputRegisterAddress();
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
    setInputRegisterAddressRange(addressRangeStart, addressRangeEnd);
    addressRangeStart = inputRegisterState.addressRangeStart;
    addressRangeEnd = inputRegisterState.addressRangeEnd;
  }

  function applyAddressListFilter(): void {
    setInputRegisterAddressList(parseAddressListInput(addressListInput));
    addressListInput = inputRegisterState.addressList.join(",");
  }

  function onAddressFilterModeChange(mode: InputRegisterAddressFilter): void {
    setInputRegisterAddressFilter(mode);
    if (mode === "required-range" || mode === "non-required-range") {
      applyAddressRangeFilter();
    }
    if (mode === "required-list" || mode === "not-required-list") {
      applyAddressListFilter();
    }
  }
</script>

<div class="input-registers-page">
  {#if connectionState.status === "disconnected"}
    <div class="disconnected-banner" role="alert">
      <span class="banner-icon">⚠</span>
      <span class="banner-text">Server not running — go to <strong>Listener</strong> and start the server to accept client connections.</span>
    </div>
  {/if}

  <SectionHeader
    title="Input Registers"
    subtitle="Server-hosted input registers (FC 04) — read-only, clients can monitor these values"
  >
    {#snippet actions()}
      <div class="poll-controls">
        <select
          class="ctrl-select has-tip"
          value={inputRegisterState.pollInterval}
          onchange={(e) => setInputRegisterPollInterval(Math.max(Number(e.currentTarget.value), practicalMinPollIntervalMs))}
          data-tip="Poll interval"
          disabled={pollDisabledByCount}
        >
          {#each pollIntervals as pi}
            <option value={pi.ms} disabled={pi.ms < practicalMinPollIntervalMs}>{pi.label}</option>
          {/each}
        </select>
        <button
          class="ctrl-btn poll-btn has-tip"
          class:active={inputRegisterState.pollActive}
          data-tip={pollDisabledByCount ? "Polling disabled when list has more than 125 registers" : inputRegisterState.pollActive ? "Stop polling" : "Start polling"}
          type="button"
          disabled={!connected || pollDisabledByCount}
          onclick={() => setInputRegisterPollActive(!inputRegisterState.pollActive)}
        >
          {#if inputRegisterState.pollActive}
            <Timer size={14} />
            <span>Polling</span>
          {:else}
            <Play size={14} />
            <span>Poll</span>
          {/if}
        </button>
        <button class="ctrl-btn icon-only has-tip" data-tip="Read once" type="button" disabled={!connected}
          onclick={handleManualReadAllInputRegisters}>
          <RefreshCw size={14} />
        </button>
        {#if practicalMinPollIntervalMs > 500}
          <span class="pending-chip has-tip" data-tip="Auto-limited for practical polling at current dataset size">
            Min poll: {practicalMinPollLabel}
          </span>
        {/if}
        {#if pollDisabledByCount}
          <span class="pending-chip has-tip" data-tip={`Polling is limited to at most ${pollMaxCount} input registers`}>
            Poll disabled: list &gt; {pollMaxCount}
          </span>
        {/if}
        {#if inputRegisterState.entries.length > 0}
          <span class="plan-chip has-tip" data-tip="Estimated FC04 frames and cycle time per read-all run">
            Read {readPlan.frames}f ~{readPlan.cycleMs}ms
          </span>
        {/if}
      </div>

      <div class="divider-v"></div>

      <div class="view-toggle">
        <button
          class="ctrl-btn icon-only"
          class:active={inputRegisterState.view === "table"}
          title="Table view"
          type="button"
          onclick={() => setInputRegisterView("table")}
        >
          <Table2 size={15} />
        </button>
        <button
          class="ctrl-btn icon-only"
          class:active={inputRegisterState.view === "cards"}
          title="Card view"
          type="button"
          onclick={() => setInputRegisterView("cards")}
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
          class:active={inputRegisterState.filter === "all"}
          type="button"
          onclick={() => setInputRegisterFilter("all")}
        >All <span class="count">{inputRegisterState.entries.length}</span></button>
        <button
          class="filter-tab"
          class:active={inputRegisterState.filter === "non-zero"}
          type="button"
          onclick={() => setInputRegisterFilter("non-zero")}
        >Non-zero <span class="count on">{nonZeroCount}</span></button>
        <button
          class="filter-tab"
          class:active={inputRegisterState.filter === "zero"}
          type="button"
          onclick={() => setInputRegisterFilter("zero")}
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
        value={inputRegisterState.addressFilter}
        onchange={(e) => onAddressFilterModeChange(e.currentTarget.value as InputRegisterAddressFilter)}
        title="Address filter mode"
      >
        <option value="all">All addresses</option>
        <option value="required-range">Required range</option>
        <option value="non-required-range">Non-required range</option>
        <option value="required-list">Required list</option>
        <option value="not-required-list">Not-required list</option>
      </select>

      {#if inputRegisterState.addressFilter === "required-range" || inputRegisterState.addressFilter === "non-required-range"}
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

      {#if inputRegisterState.addressFilter === "required-list" || inputRegisterState.addressFilter === "not-required-list"}
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
          onclick={() => setInputRegisterAddressFilter("all")}
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
              <button class="btn btn-sm btn-clear" type="button" onclick={removeAllInputRegisters}>
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
        <div class="empty">No input registers match the current filter.</div>
      {:else if showVirtualTable}
        <div class="register-table">
          <div class="rt-header">
            <span>Label</span>
            <span>Status</span>
            <span>Addr</span>
            <span>Value</span>
            <span>Read</span>
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
                class:selected-item={registerDetailsState.kind === "input" && registerDetailsState.address === entry.address}
                role="button"
                tabindex="0"
                onclick={() => { selectRegisterDetails("input", entry.address); }}
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
                    selectRegisterDetails("input", entry.address);
                  }
                }}
              >
                <InputRegisterTableRow
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
                  onRead={(address: number) => { void readInputRegister(address); }}
                  onDelete={(address: number) => removeInputRegister(address)}
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
                class:selected-item={registerDetailsState.kind === "input" && registerDetailsState.address === entry.address}
                role="button"
                tabindex="0"
                onclick={() => { selectRegisterDetails("input", entry.address); }}
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
                    selectRegisterDetails("input", entry.address);
                  }
                }}
              >
                <InputRegisterCard
                  address={entry.address}
                  label={entry.label}
                  pending={entry.pending}
                  value={entry.value}
                  {valueFmt}
                  {connected}
                  {editingAddress}
                  {editLabelVal}
                  {addrFmt}
                  onBeginEdit={beginEdit}
                  onCommitEdit={commitEdit}
                  onCancelEdit={cancelEdit}
                  {onLabelKeydown}
                  onEditLabelValChange={(next: string) => { editLabelVal = next; }}
                  onRead={(address: number) => { void readInputRegister(address); }}
                  onDelete={(address: number) => removeInputRegister(address)}
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
    grid-template-columns: minmax(140px, 1fr) 92px 64px 88px 100px 52px;
  }
</style>

