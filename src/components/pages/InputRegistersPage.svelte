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

  const filtered = $derived(getFilteredInputRegisters());
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
    const next = Math.max(180, Math.floor(containerBottom - bodyRect.top - reservedBottomGap));
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
  {#if !connected}
    <div class="disconnected-banner" role="alert">
      <span class="banner-icon">⚠</span>
      <span class="banner-text">Not connected — go to <strong>Connection</strong> and connect to a device before using input-register operations.</span>
    </div>
  {/if}

  <SectionHeader
    title="Input Registers"
    subtitle="FC 04 Read · Read-only"
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
        <button
          class="ctrl-btn has-tip"
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
                  statusBadgeText={entry.readError ? "Not avail" : null}
                  statusBadgeTitle={entry.readError ?? undefined}
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
  .input-registers-page {
    display: grid;
    gap: 10px;
  }

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

  .selectable-item {
    border-radius: 8px;
  }

  .selectable-item.zebra-row :global(.rt-row) {
    background: color-mix(in srgb, var(--c-surface-2) 52%, transparent);
  }

  .selected-item {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-accent) 62%, transparent);
    background: color-mix(in srgb, var(--c-accent) 8%, transparent);
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

  .ctrl-btn.notice {
    border-color: color-mix(in srgb, var(--c-warn) 58%, var(--c-border));
    background: color-mix(in srgb, var(--c-warn) 14%, var(--c-surface-2));
    color: var(--c-text-1);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-warn) 24%, transparent);
  }

  .active-filter-pill {
    display: inline-flex;
    align-items: center;
    height: 16px;
    padding: 0 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--c-warn) 20%, var(--c-surface-3));
    color: var(--c-warn);
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.03em;
  }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  .toolbar-left {
    display: flex;
    align-items: center;
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

  .count.on  { color: var(--c-ok); background: color-mix(in srgb, var(--c-ok) 15%, var(--c-surface-3)); }
  .count.off { color: var(--c-text-2); }

  .toolbar-actions {
    display: flex;
    align-items: center;
    gap: 3px;
  }

  .address-filter-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 8px;
    border: 1px solid var(--c-border);
    border-radius: 8px;
    background: var(--c-surface-2);
  }

  .address-filter-title {
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--c-text-2);
    margin-right: 4px;
  }

  .address-filter-select,
  .address-filter-input,
  .address-filter-list-input {
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--c-border);
    border-radius: 6px;
    background: var(--c-surface-2);
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.72rem;
  }

  .address-filter-input {
    width: 96px;
  }

  .address-filter-list-input {
    min-width: 220px;
    width: min(380px, 100%);
  }

  .pending-chip {
    display: inline-flex;
    align-items: center;
    height: 24px;
    padding: 0 8px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--c-warn) 32%, var(--c-border));
    background: color-mix(in srgb, var(--c-warn) 10%, var(--c-surface-2));
    color: var(--c-warn);
    font-size: 0.66rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }

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

  input[type="number"],
  select {
    height: 30px;
    padding: 0 8px;
    border: 1px solid var(--c-border);
    border-radius: 6px;
    background: var(--c-surface-2);
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.75rem;
  }

  input[type="number"]:focus,
  select:focus {
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

  .custom-address-input {
    width: 120px;
  }

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

  .btn-apply:hover {
    border-color: var(--c-border-strong);
  }

  .btn-processing {
    opacity: 0.78;
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

  .register-table {
    display: grid;
    gap: 0;
  }

  .rt-body {
    max-height: min(62vh, 680px);
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
  }

  .rt-spacer {
    width: 100%;
  }

  .rt-header {
    display: grid;
    grid-template-columns: minmax(140px, 1fr) 92px 64px 88px 100px 52px;
    align-items: center;
    gap: 0;
    font-size: 0.63rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--c-text-2);
    padding: 0 4px 6px;
    border-bottom: 1px solid var(--c-border);
  }

  .rt-header > span {
    padding: 0 4px;
  }

  .switch-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
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

    .toolbar-left {
      justify-content: space-between;
    }

    .toolbar-actions {
      justify-content: space-between;
    }

    .address-filter-row {
      align-items: stretch;
    }

    .address-filter-select,
    .address-filter-input,
    .address-filter-list-input {
      width: 100%;
    }

    .switch-grid {
      grid-template-columns: 1fr;
      justify-content: stretch;
    }
  }

  .empty {
    padding: 32px 0;
    text-align: center;
    color: var(--c-text-2);
    font-size: 0.82rem;
    font-style: italic;
  }

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

