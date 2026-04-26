<svelte:options runes={true} />
<script lang="ts">
  import { untrack } from "svelte";
  import {
    Table2,
    LayoutGrid,
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
    coilState,
    initCoilState,
    setCoilView,
    setCoilFilter,
    setCoilAddressFilter,
    setCoilAddressRange,
    setCoilAddressList,
    toggleCoilValue,
    setCoilValue,
    writeCoil,
    setCoilLabel,
    executeMassWrite,
    startAutoToggle,
    stopAutoToggle,
    setMassAutoInterval,
    addCoilRange,
    addExclusiveCoil,
    generateRandomExclusiveCoilAddress,
    removeCoil,
    removeAllCoils,
    getFilteredCoils,
    buildMassPreview,
    getCoilRule,
    setCoilRule,
    clearAllRules,
    type CoilAddressFilter,
    type CoilRuleType,
    type MassWritePattern,
    type WriteMode,
  } from "../../state/coils.svelte";
  import { connectionState } from "../../state/connection.svelte";
  import { formatAddressWithSettings } from "../../state/settings.svelte";
  import { notifyWarning } from "../../state/notifications.svelte";
  import SectionHeader from "../shared/SectionHeader.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";
  import ToggleSwitch from "../shared/ToggleSwitch.svelte";
  import TableRow from "../shared/TableRow.svelte";
  import SwitchCard from "../shared/SwitchCard.svelte";

  // ── Init & cleanup ──────────────────────────────────────────────────────────
  $effect(() => {
    untrack(() => initCoilState());
    return () => {
      stopAutoToggle();
      clearAllRules();
    };
  });

  // On the server all operations target the local Rust data store which is
  // always available — no TCP connection required to read/write values.
  const connected = $derived(true);

  // ── Local panel open/close state ────────────────────────────────────────────
  let readPanelOpen = $state(false);
  let writePanelOpen = $state(false);

  // ── Address range inputs (local; committed on Apply) ────────────────────────
  let rangeStart = $state(coilState.startAddress);
  let rangeCount = $state(coilState.coilCount);
  let rangeApplyPending = $state(false);
  const RANGE_APPLY_MIN_SPINNER_MS = 250;

  // ── Filtered coil list ──────────────────────────────────────────────────────
  const filtered = $derived(getFilteredCoils());
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

    const targetEl = coilState.view === "table" ? tableBodyEl : switchScrollEl;
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
    writePanelOpen;
    coilState.view;
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

  const massPreview = $derived(buildMassPreview());
  const onCount = $derived(coilState.entries.filter((e) => e.slaveValue).length);
  const offCount = $derived(coilState.entries.filter((e) => !e.slaveValue).length);
  const anyAddressFilterActive = $derived(coilState.addressFilter !== "all");
  const anyFilterActive = $derived(coilState.filter !== "all" || coilState.addressFilter !== "all");

  // ── Inline label editing ────────────────────────────────────────────────────
  let editingAddress: number | null = $state(null);
  let selectedCoilAddress: number | null = $state(null);
  let editLabelVal = $state("");
  let addAddressInput = $state("");
  let singleWriteAddressInput = $state("");
  let singleWriteDesired = $state(false);
  let singleRuleType = $state<CoilRuleType>("none");
  let singleRuleIntervalMs = $state(1000);
  let filterPanelOpen = $state(false);
  let addressRangeStart = $state(coilState.addressRangeStart);
  let addressRangeEnd = $state(coilState.addressRangeEnd);
  let addressListInput = $state(coilState.addressList.join(","));

  function parseSingleCoilAddress(raw: string): number | null {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
    if (parsed < 0 || parsed > 65535) return null;
    return parsed;
  }

  const singleCoilAddress = $derived(parseSingleCoilAddress(singleWriteAddressInput));

  function beginEdit(address: number, current: string): void {
    editingAddress = address;
    editLabelVal = current;
  }

  function commitEdit(): void {
    if (editingAddress !== null) {
      setCoilLabel(editingAddress, editLabelVal.trim());
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
      addCoilRange(rangeStart, rangeCount);
      rangeStart = coilState.startAddress;
      rangeCount = coilState.coilCount;
      addAddressInput = "";
    } finally {
      rangeApplyPending = false;
    }
  }

  function tryAddAddress(): void {
    const parsed = Number(addAddressInput.trim());
    if (!Number.isFinite(parsed)) return;
    const ok = addExclusiveCoil(parsed);
    if (ok) {
      addAddressInput = "";
    }
  }

  function suggestRandomAddress(): void {
    const picked = generateRandomExclusiveCoilAddress();
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

  async function executeSingleWrite(): Promise<void> {
    if (singleCoilAddress === null) return;
    const addr = singleCoilAddress;

    addExclusiveCoil(addr);
    setCoilValue(addr, singleWriteDesired);
    await writeCoil(addr);
  }

  function applySingleRule(): void {
    if (singleCoilAddress === null) return;
    addExclusiveCoil(singleCoilAddress);
    setCoilRule(singleCoilAddress, {
      type: singleRuleType,
      intervalMs: singleRuleIntervalMs,
    });
  }

  const patterns: { id: MassWritePattern; label: string; sub: string }[] = [
    { id: "all-on",        label: "All ON",       sub: "1 1 1 1…" },
    { id: "all-off",       label: "All OFF",      sub: "0 0 0 0…" },
    { id: "alternating",   label: "Alt ↑↓",       sub: "1 0 1 0…" },
    { id: "alternating-inv", label: "Alt ↓↑",     sub: "0 1 0 1…" },
    { id: "every-third",   label: "Every 3rd",    sub: "1 0 0 1…" },
    { id: "random",        label: "Random",       sub: "? ? ? ?…" },
  ];

  const autoIntervals: { ms: number; label: string }[] = [
    { ms: 250,  label: "250 ms" },
    { ms: 500,  label: "500 ms" },
    { ms: 1000, label: "1 s"    },
    { ms: 2000, label: "2 s"    },
    { ms: 5000, label: "5 s"    },
    { ms: 10000, label: "10 s"  },
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
    setCoilAddressRange(addressRangeStart, addressRangeEnd);
    addressRangeStart = coilState.addressRangeStart;
    addressRangeEnd = coilState.addressRangeEnd;
  }

  function applyAddressListFilter(): void {
    setCoilAddressList(parseAddressListInput(addressListInput));
    addressListInput = coilState.addressList.join(",");
  }

  function onAddressFilterModeChange(mode: CoilAddressFilter): void {
    setCoilAddressFilter(mode);
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
    title="Coils"
    subtitle="Server-hosted coils (FC 01/05/15) — clients read and write these values"
  >
    {#snippet actions()}
      <!-- View toggle -->
      <div class="view-toggle">
        <button
          class="ctrl-btn icon-only has-tip"
          class:active={coilState.view === "table"}
          data-tip="Table view"
          type="button"
          onclick={() => setCoilView("table")}
        >
          <Table2 size={15} />
        </button>
        <button
          class="ctrl-btn icon-only has-tip"
          class:active={coilState.view === "switch"}
          data-tip="Switch view"
          type="button"
          onclick={() => setCoilView("switch")}
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
          class:active={coilState.filter === "all"}
          type="button"
          onclick={() => setCoilFilter("all")}
        >All <span class="count">{coilState.entries.length}</span></button>
        <button
          class="filter-tab"
          class:active={coilState.filter === "on"}
          type="button"
          onclick={() => setCoilFilter("on")}
        >ON <span class="count on">{onCount}</span></button>
        <button
          class="filter-tab"
          class:active={coilState.filter === "off"}
          type="button"
          onclick={() => setCoilFilter("off")}
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
        <span>Add Coils</span>
        {#if readPanelOpen}<ChevronUp size={12} />{:else}<ChevronDown size={12} />{/if}
      </button>
      <button
        class="ctrl-btn has-tip"
        class:active={writePanelOpen || coilState.massAutoActive}
        type="button"
        onclick={() => { writePanelOpen = !writePanelOpen; }}
        data-tip="Coil rules"
      >
        <Wand size={13} />
        <span>Rules</span>
        {#if coilState.massAutoActive}<span class="auto-badge">AUTO</span>{/if}
        {#if writePanelOpen}<ChevronUp size={12} />{:else}<ChevronDown size={12} />{/if}
      </button>
    </div>
  </div>

  {#if filterPanelOpen}
    <div class="address-filter-row">
      <div class="address-filter-title">Address Filter</div>
      <select
        class="address-filter-select"
        value={coilState.addressFilter}
        onchange={(e) => onAddressFilterModeChange(e.currentTarget.value as CoilAddressFilter)}
        title="Address filter mode"
      >
        <option value="all">All addresses</option>
        <option value="required-range">Required range</option>
        <option value="non-required-range">Non-required range</option>
        <option value="required-list">Required list</option>
        <option value="not-required-list">Not-required list</option>
      </select>

      {#if coilState.addressFilter === "required-range" || coilState.addressFilter === "non-required-range"}
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

      {#if coilState.addressFilter === "required-list" || coilState.addressFilter === "not-required-list"}
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
          onclick={() => setCoilAddressFilter("all")}
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
          <div class="sub-title">Add Coils</div>

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
              <button class="btn btn-sm btn-clear" type="button" onclick={removeAllCoils}>
                Remove All Coils
              </button>
            </div>
          </div>
        </div>
      {/snippet}
    </PanelFrame>
  {/if}

  <!-- ── Write Panels ──────────────────────────────────────────────────────── -->
  {#if writePanelOpen}
    <div class="write-sections">
      <PanelFrame>
        {#snippet children()}
          <div class="write-panel">
            <div class="sub-title">Single Coil Rule</div>

            <div class="sub-row">
              <div class="form-group">
                <label for="single-write-address">Address</label>
                <input
                  id="single-write-address"
                  class="custom-address-input"
                  type="number"
                  min="0"
                  max="65535"
                  placeholder="Type address"
                  value={singleWriteAddressInput}
                  oninput={(e) => { singleWriteAddressInput = e.currentTarget.value; }}
                  onkeydown={(e) => { if (e.key === "Enter") executeSingleWrite(); }}
                />
              </div>

              <div class="form-group">
                <label for="single-rule-type">Rule</label>
                <select
                  id="single-rule-type"
                  value={singleRuleType}
                  onchange={(e) => { singleRuleType = e.currentTarget.value as CoilRuleType; }}
                >
                  <option value="none">None</option>
                  <option value="auto-toggle">Auto-toggle</option>
                </select>
              </div>

              <div class="form-group">
                <label for="single-rule-interval">Interval</label>
                <select
                  id="single-rule-interval"
                  value={singleRuleIntervalMs}
                  disabled={singleRuleType !== "auto-toggle"}
                  onchange={(e) => { singleRuleIntervalMs = Number(e.currentTarget.value); }}
                >
                  {#each autoIntervals as ai}
                    <option value={ai.ms}>{ai.label}</option>
                  {/each}
                </select>
              </div>

              <div class="form-group">
                <div class="mini-field-label">State</div>
                <div class="single-write-toggle">
                  <ToggleSwitch
                    checked={singleWriteDesired}
                    size="sm"
                    title={singleWriteDesired ? "Desired ON" : "Desired OFF"}
                    onToggle={() => { singleWriteDesired = !singleWriteDesired; }}
                  />
                </div>
              </div>

              <button
                class="btn btn-sm btn-write"
                type="button"
                disabled={singleCoilAddress === null}
                title={singleCoilAddress === null ? "Enter a valid address (0-65535)" : "Apply value"}
                onclick={() => { void executeSingleWrite(); }}
              >
                <Zap size={12} />
                Apply
              </button>

              <button
                class="btn btn-sm btn-apply"
                type="button"
                disabled={singleCoilAddress === null}
                title={singleCoilAddress === null ? "Enter a valid address (0-65535)" : "Apply rule"}
                onclick={applySingleRule}
              >
                <Wand size={12} />
                Set Rule
              </button>
            </div>
          </div>
        {/snippet}
      </PanelFrame>

      <PanelFrame>
        {#snippet children()}
          <div class="write-panel">
            <div class="sub-title">Batch Coil Rules</div>

          <!-- Pattern selector -->
          <div class="patterns-grid">
            {#each patterns as p}
              <button
                class="pattern-btn"
                class:active={coilState.massPattern === p.id}
                type="button"
                onclick={() => { coilState.massPattern = p.id as MassWritePattern; }}
              >
                <span class="p-label">{p.label}</span>
                <span class="p-sub">{p.sub}</span>
              </button>
            {/each}
          </div>

          <!-- Address range -->
          <div class="addr-row">
            <div class="form-group">
              <label for="mass-from">From</label>
              <input
                id="mass-from"
                type="number"
                min={coilState.startAddress}
                max={coilState.startAddress + coilState.coilCount - 1}
                value={coilState.massFrom}
                oninput={(e) => { coilState.massFrom = Number(e.currentTarget.value); }}
              />
            </div>
            <div class="form-group">
              <label for="mass-to">To</label>
              <input
                id="mass-to"
                type="number"
                min={coilState.startAddress}
                max={coilState.startAddress + coilState.coilCount - 1}
                value={coilState.massTo}
                oninput={(e) => { coilState.massTo = Number(e.currentTarget.value); }}
              />
            </div>
          </div>

          <!-- Preview -->
          <div class="preview-line">
            <span class="preview-label">Preview:</span>
            <span class="preview-text">{massPreview}</span>
          </div>

          <!-- Mode selector -->
          <div class="mode-row">
            <div class="mode-label">Rule Mode</div>
            <div class="seg-group">
              <button
                class="seg-btn"
                class:active={coilState.massMode === "once"}
                type="button"
                onclick={() => { coilState.massMode = "once" as WriteMode; stopAutoToggle(); }}
              >
                <Zap size={12} /> Apply Once
              </button>
              <button
                class="seg-btn"
                class:active={coilState.massMode === "auto-toggle"}
                type="button"
                onclick={() => { coilState.massMode = "auto-toggle" as WriteMode; }}
              >
                <Repeat size={12} /> Auto-toggle
              </button>
            </div>
          </div>

          <!-- One-shot action -->
          {#if coilState.massMode === "once"}
            <div class="action-row">
              <button class="btn btn-write" type="button" onclick={() => { void executeMassWrite(); }}>
                <Wand size={14} />
                Apply to {Math.abs(coilState.massTo - coilState.massFrom) + 1} Coils
              </button>
            </div>
          {/if}

          <!-- Auto-toggle config -->
          {#if coilState.massMode === "auto-toggle"}
            <div class="auto-row">
              <div class="form-group">
                <label for="auto-interval">Interval</label>
                <select
                  id="auto-interval"
                  value={coilState.massAutoInterval}
                  onchange={(e) => setMassAutoInterval(Number(e.currentTarget.value))}
                >
                  {#each autoIntervals as ai}
                    <option value={ai.ms}>{ai.label}</option>
                  {/each}
                </select>
              </div>
              {#if coilState.massAutoActive}
                <button class="btn btn-stop" type="button" onclick={stopAutoToggle}>
                  <Timer size={14} />
                  Stop Rule
                </button>
              {:else}
                <button class="btn btn-write" type="button" onclick={startAutoToggle}>
                  <Play size={14} />
                  Start Rule
                </button>
              {/if}
            </div>
          {/if}

          </div>
        {/snippet}
      </PanelFrame>
    </div>
  {/if}

  <!-- ── Main coil display ──────────────────────────────────────────────────── -->
  <PanelFrame>
    {#snippet children()}
      {#if filtered.length === 0}
        <div class="empty">No coils match the current filter.</div>
      {:else if coilState.view === "table"}
        <!-- TABLE view -->
        <div class="coil-table">
          <div class="ct-header">
            <span>Label</span>
            <span>Addr</span>
            <span>Switch</span>
            <span>Rule</span>
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
                class:selected-item={selectedCoilAddress === entry.address}
                role="button"
                tabindex="0"
                onclick={() => { selectedCoilAddress = entry.address; }}
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
                    selectedCoilAddress = entry.address;
                  }
                }}
              >
                <TableRow
                  {entry}
                  {connected}
                  {editingAddress}
                  {editLabelVal}
                  {addrFmt}
                  {beginEdit}
                  {commitEdit}
                  {cancelEdit}
                  {onLabelKeydown}
                  onEditLabelValChange={(next: string) => { editLabelVal = next; }}
                  onToggle={(address: number) => { toggleCoilValue(address); void writeCoil(address); }}
                  rule={getCoilRule(entry.address)}
                  onRuleChange={(rule) => setCoilRule(entry.address, rule)}
                  onDelete={(address: number) => removeCoil(address)}
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
                class:selected-item={selectedCoilAddress === entry.address}
                role="button"
                tabindex="0"
                onclick={() => { selectedCoilAddress = entry.address; }}
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
                    selectedCoilAddress = entry.address;
                  }
                }}
              >
                <SwitchCard
                  address={entry.address}
                  label={entry.label}
                  pending={entry.pending}
                  readValue={entry.slaveValue}
                  toggleValue={entry.desiredValue}
                  {connected}
                  showStateChip={false}
                  cardDirty={entry.desiredValue !== entry.slaveValue || entry.writeError !== null}
                  {editingAddress}
                  {editLabelVal}
                  {addrFmt}
                  onBeginEdit={beginEdit}
                  onCommitEdit={commitEdit}
                  onCancelEdit={cancelEdit}
                  {onLabelKeydown}
                  onEditLabelValChange={(next: string) => { editLabelVal = next; }}
                  onToggle={(address: number) => { toggleCoilValue(address); void writeCoil(address); }}
                  rule={getCoilRule(entry.address)}
                  onRuleChange={(rule) => setCoilRule(entry.address, rule)}
                  onDelete={(address: number) => removeCoil(address)}
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
  /* ── Page-unique: auto-toggle badge ─────────────────────────────────────── */
  .auto-badge {
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    background: color-mix(in srgb, var(--c-warn) 20%, transparent);
    color: var(--c-warn);
    border-radius: 4px;
    padding: 1px 4px;
  }

  /* ── Page-unique: write panel ────────────────────────────────────────────── */
  .write-panel {
    display: grid;
    gap: 10px;
  }

  .write-sections {
    display: grid;
    gap: 8px;
  }

  .addr-row,
  .auto-row {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }

  .mini-field-label {
    font-size: 0.68rem;
    font-weight: 500;
    color: var(--c-text-1);
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }

  /* ── Page-unique: mass write patterns ───────────────────────────────────── */
  .patterns-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
    gap: 5px;
  }

  .pattern-btn {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 7px 10px;
    border: 1px solid var(--c-border);
    border-radius: 7px;
    background: var(--c-surface-2);
    color: var(--c-text-2);
    font: inherit;
    cursor: pointer;
    transition: all 140ms ease;
  }

  .pattern-btn:hover { border-color: var(--c-border-strong); color: var(--c-text-1); }

  .pattern-btn.active {
    border-color: color-mix(in srgb, var(--c-border-strong) 88%, var(--c-surface-3));
    background: color-mix(in srgb, var(--c-accent) 10%, var(--c-surface-2));
    color: var(--c-text-1);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-accent) 20%, transparent);
  }

  .p-label { font-size: 0.75rem; font-weight: 500; }
  .p-sub   { font-size: 0.62rem; opacity: 0.55; font-family: monospace; }

  /* ── Page-unique: mass write preview ────────────────────────────────────── */
  .preview-line {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.73rem;
    font-family: monospace;
  }

  .preview-label { color: var(--c-text-2); flex-shrink: 0; font-family: inherit; }
  .preview-text  { color: var(--c-text-1); word-break: break-all; }

  /* ── Page-unique: write mode controls ───────────────────────────────────── */
  .mode-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .mode-label {
    font-size: 0.68rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--c-text-2);
    flex-shrink: 0;
  }

  .seg-group {
    display: flex;
    gap: 0;
    border: 1px solid var(--c-border);
    border-radius: 6px;
    overflow: hidden;
  }

  .seg-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 27px;
    padding: 0 10px;
    border: none;
    border-right: 1px solid var(--c-border);
    background: var(--c-surface-2);
    color: var(--c-text-2);
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
    transition: all 140ms ease;
  }

  .seg-btn:last-child { border-right: none; }
  .seg-btn:hover { background: var(--c-surface-3); color: var(--c-text-1); }
  .seg-btn.active { background: color-mix(in srgb, var(--c-accent) 12%, var(--c-surface-2)); color: var(--c-text-1); }

  .single-write-toggle {
    display: inline-flex;
    align-items: center;
    height: 30px;
  }

  .action-row {
    display: flex;
    gap: 6px;
  }

  /* ── Page-unique: write / stop buttons ──────────────────────────────────── */
  .btn-write {
    border: 1px solid color-mix(in srgb, var(--c-accent) 30%, var(--c-border));
    background: color-mix(in srgb, var(--c-accent) 15%, var(--c-surface-2));
    color: var(--c-accent);
  }
  .btn-write:hover {
    border-color: var(--c-accent);
    background: color-mix(in srgb, var(--c-accent) 25%, var(--c-surface-2));
    color: var(--c-text-1);
  }

  .btn-stop {
    border: 1px solid color-mix(in srgb, var(--c-error) 30%, var(--c-border));
    background: color-mix(in srgb, var(--c-error) 12%, var(--c-surface-2));
    color: var(--c-error);
  }
  .btn-stop:hover {
    border-color: var(--c-error);
    background: color-mix(in srgb, var(--c-error) 22%, var(--c-surface-2));
    color: var(--c-text-1);
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

  /* ── Page-unique: table column layout ───────────────────────────────────── */
  .ct-header {
    /* label | addr | switch | rule | delete */
    grid-template-columns: minmax(140px, 1fr) 65px 60px 160px 44px;
  }
</style>
