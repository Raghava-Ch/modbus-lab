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
    coilState,
    initCoilState,
    setCoilView,
    setCoilFilter,
    toggleCoilValue,
    setCoilValue,
    syncAllSlaveToDesired,
    readCoil,
    readAllCoils,
    writeCoil,
    writePendingCoils,
    setCoilLabel,
    executeMassWrite,
    startAutoToggle,
    stopAutoToggle,
    setMassAutoInterval,
    setPollActive,
    setPollInterval,
    addCoilRange,
    addExclusiveCoil,
    generateRandomExclusiveCoilAddress,
    removeCoil,
    removeAllCoils,
    getFilteredCoils,
    buildMassPreview,
    type MassWritePattern,
    type WriteMode,
  } from "../../state/coils.svelte";
  import { connectionState } from "../../state/connection.svelte";
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
   untrack(() => initCoilState());
    return () => {
      stopAutoToggle();
      setPollActive(false);
    };
  });

  // Stop polling automatically when connection drops
  $effect(() => {
    if (connectionState.status !== "connected" && coilState.pollActive) {
      setPollActive(false);
    }
  });

  const connected = $derived(connectionState.status === "connected");

  // ── Local panel open/close state ────────────────────────────────────────────
  let readPanelOpen = $state(false);
  let writePanelOpen = $state(false);

  // ── Address range inputs (local; committed on Apply) ────────────────────────
  let rangeStart = $state(coilState.startAddress);
  let rangeCount = $state(coilState.coilCount);
  let rangeApplyPending = $state(false);
  const RANGE_APPLY_MIN_SPINNER_MS = 250;
  const COIL_READ_CHUNK_MAX = 2000;
  const COIL_WRITE_CHUNK_MAX = 1968;
  const FRAME_ESTIMATE_MS = 22;

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

  function buildRequestPlan(addresses: number[], chunkMax: number): { frames: number; cycleMs: number } {
    const sections = buildAddressSections(addresses);
    const frames = sections.reduce((total, section) => total + Math.max(1, Math.ceil(section.quantity / chunkMax)), 0);
    return { frames, cycleMs: frames * FRAME_ESTIMATE_MS };
  }

  // ── Filtered coil list ──────────────────────────────────────────────────────
  const filtered = $derived(getFilteredCoils());
  const readPlan = $derived(
    buildRequestPlan(coilState.entries.map((entry) => entry.address), COIL_READ_CHUNK_MAX),
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
  const massWritePlan = $derived(
    buildRequestPlan(
      coilState.entries
        .filter((entry) => {
          const start = Math.min(coilState.massFrom, coilState.massTo);
          const end = Math.max(coilState.massFrom, coilState.massTo);
          return entry.address >= start && entry.address <= end;
        })
        .map((entry) => entry.address),
      COIL_WRITE_CHUNK_MAX,
    ),
  );
  const onCount = $derived(coilState.entries.filter((e) => e.slaveValue).length);
  const offCount = $derived(coilState.entries.filter((e) => !e.slaveValue).length);
  const pendingWriteCount = $derived(
    coilState.entries.filter((e) => e.desiredValue !== e.slaveValue).length,
  );
  const failedWriteCount = $derived(
    coilState.entries.filter((e) => e.desiredValue !== e.slaveValue && e.writeError !== null).length,
  );
  const pollMaxCount = $derived(getGlobalPollingMaxAddressCount());
  const pollDisabledByCount = $derived(!isPollingAllowedForCount(coilState.entries.length));

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

  function handleManualReadAllCoils(): void {
    if (coilState.pollActive) {
      notifyWarning("Polling is already in progress. Stop polling to use manual refresh.");
      return;
    }

    void readAllCoils();
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
    const parsed = Number(singleWriteAddressInput.trim());
    if (!Number.isFinite(parsed)) return;
    const addr = Math.floor(parsed);
    if (addr < 0 || addr > 65535) return;

    addExclusiveCoil(addr);
    setCoilValue(addr, singleWriteDesired);
    await writeCoil(addr);
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
    title="Coils"
    subtitle="FC 01 Read · FC 05 Write Single · FC 15 Write Multiple"
  >
    {#snippet actions()}
      <!-- Poll controls -->
      <div class="poll-controls">
        <select
          class="ctrl-select has-tip"
          value={coilState.pollInterval}
          onchange={(e) => setPollInterval(Number(e.currentTarget.value))}
          data-tip="Poll interval"
        >
          {#each pollIntervals as pi}
            <option value={pi.ms}>{pi.label}</option>
          {/each}
        </select>
        <button
          class="ctrl-btn has-tip"
          class:active={coilState.pollActive}
          data-tip={pollDisabledByCount ? "Polling disabled for large lists" : coilState.pollActive ? "Stop polling" : "Start polling"}
          type="button"
          disabled={!connected || pollDisabledByCount}
          onclick={() => setPollActive(!coilState.pollActive)}
        >
          {#if coilState.pollActive}
            <Timer size={14} />
            <span>Polling</span>
          {:else}
            <Play size={14} />
            <span>Poll</span>
          {/if}
        </button>
        <button class="ctrl-btn icon-only has-tip" data-tip="Read once" type="button" disabled={!connected}
          onclick={handleManualReadAllCoils}>
          <RefreshCw size={14} />
        </button>
        {#if pollDisabledByCount}
          <span class="pending-chip has-tip" data-tip="Global polling max reached">
            Poll disabled: list &gt; {pollMaxCount}
          </span>
        {/if}
        <span class="pending-chip has-tip" data-tip="Estimated FC01 frames and cycle time per read-all run">
          Read plan: {readPlan.frames}f ~{readPlan.cycleMs}ms
        </span>
      </div>

      <div class="divider-v"></div>

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

    <div class="toolbar-actions">
      <button
        class="ctrl-btn has-tip"
        type="button"
        onclick={() => { syncAllSlaveToDesired(); }}
        data-tip="Copy all actual device states into desired states"
      >
        <span>Actual → Desired</span>
      </button>

      {#if pendingWriteCount > 0}
        <button
          class="pending-chip pending-chip-action has-tip"
          type="button"
          disabled={!connected}
          onclick={() => { void writePendingCoils(); }}
          data-tip={connected ? "Write all pending coils" : "Connect to device first"}
        >
          Pending write: {pendingWriteCount}
          {#if failedWriteCount > 0}
            <span class="pending-chip-failed">Failed: {failedWriteCount}</span>
          {/if}
        </button>
      {/if}

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
        data-tip="Write operations"
      >
        <Wand size={13} />
        <span>Write</span>
        {#if coilState.massAutoActive}<span class="auto-badge">AUTO</span>{/if}
        {#if writePanelOpen}<ChevronUp size={12} />{:else}<ChevronDown size={12} />{/if}
      </button>
    </div>
  </div>

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
            <div class="sub-title">Single Write</div>

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
                <div class="mini-field-label">Value</div>
                <div class="single-write-toggle">
                  <ToggleSwitch
                    checked={singleWriteDesired}
                    size="sm"
                    title={singleWriteDesired ? "Desired ON" : "Desired OFF"}
                    onToggle={() => { singleWriteDesired = !singleWriteDesired; }}
                  />
                </div>
              </div>

              <button class="btn btn-sm btn-write" type="button" disabled={!connected} onclick={() => { void executeSingleWrite(); }}>
                <Zap size={12} />
                Write
              </button>
            </div>
          </div>
        {/snippet}
      </PanelFrame>

      <PanelFrame>
        {#snippet children()}
          <div class="write-panel">
            <div class="sub-title">Mass Write</div>

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

          <div class="preview-line">
            <span class="preview-label">Planner:</span>
            <span class="preview-text">{massWritePlan.frames} frame{massWritePlan.frames === 1 ? "" : "s"} ~{massWritePlan.cycleMs}ms</span>
          </div>

          <!-- Mode selector -->
          <div class="mode-row">
            <div class="mode-label">Mode</div>
            <div class="seg-group">
              <button
                class="seg-btn"
                class:active={coilState.massMode === "once"}
                type="button"
                onclick={() => { coilState.massMode = "once" as WriteMode; stopAutoToggle(); }}
              >
                <Zap size={12} /> One-shot
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
              <button class="btn btn-write" type="button" disabled={!connected} onclick={() => { void executeMassWrite(); }}>
                <Wand size={14} />
                Write {Math.abs(coilState.massTo - coilState.massFrom) + 1} Coils
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
                  Stop Auto
                </button>
              {:else}
                <button class="btn btn-write" type="button" disabled={!connected} onclick={startAutoToggle}>
                  <Play size={14} />
                  Start Auto
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
            <span>Status</span>
            <span>Addr</span>
            <span>Read Value</span>
            <span>Switch</span>
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

            {#each visibleTableEntries as entry (entry.address)}
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
                onToggle={(address: number) => toggleCoilValue(address)}
                onRead={(address: number) => { void readCoil(address); }}
                onWrite={(address: number) => { void writeCoil(address); }}
                onDelete={(address: number) => removeCoil(address)}
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
              <SwitchCard
                address={entry.address}
                label={entry.label}
                pending={entry.pending}
                readValue={entry.slaveValue}
                toggleValue={entry.desiredValue}
                {connected}
                cardDirty={entry.desiredValue !== entry.slaveValue || entry.writeError !== null}
                {editingAddress}
                {editLabelVal}
                {addrFmt}
                onBeginEdit={beginEdit}
                onCommitEdit={commitEdit}
                onCancelEdit={cancelEdit}
                {onLabelKeydown}
                onEditLabelValChange={(next: string) => { editLabelVal = next; }}
                onToggle={(address: number) => toggleCoilValue(address)}
                onRead={(address: number) => { void readCoil(address); }}
                onWrite={(address: number) => { void writeCoil(address); }}
                onDelete={(address: number) => removeCoil(address)}
                statusBadgeText={entry.writeError ? "Not avail" : (entry.desiredValue !== entry.slaveValue ? "Unsynced" : null)}
                statusBadgeTitle={entry.writeError ?? "Local value differs from device"}
                statusBadgeVariant={entry.writeError ? "failed" : "pending"}
                writeButtonTitle={connected ? (entry.desiredValue ? "Write ON" : "Write OFF") : "Connect to device first"}
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

  .auto-badge {
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    background: color-mix(in srgb, var(--c-warn) 20%, transparent);
    color: var(--c-warn);
    border-radius: 4px;
    padding: 1px 4px;
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

  .pending-chip-action {
    cursor: pointer;
    transition: all 120ms ease;
  }

  .pending-chip-action:hover {
    border-color: color-mix(in srgb, var(--c-warn) 55%, var(--c-border));
    background: color-mix(in srgb, var(--c-warn) 16%, var(--c-surface-2));
    color: var(--c-text-1);
  }

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

  /* ── Sub-panels (range + write) ──────────────────────────────────────────── */
  .sub-panel,
  .write-panel {
    display: grid;
    gap: 10px;
  }

  .write-sections {
    display: grid;
    gap: 8px;
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

  .mini-field-label {
    font-size: 0.68rem;
    font-weight: 500;
    color: var(--c-text-1);
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }

  .sub-title {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--c-text-1);
  }

  .sub-row,
  .addr-row,
  .auto-row {
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

  /* Patterns grid */
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

  /* Preview line */
  .preview-line {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.73rem;
    font-family: monospace;
  }

  .preview-label { color: var(--c-text-2); flex-shrink: 0; font-family: inherit; }
  .preview-text  { color: var(--c-text-1); word-break: break-all; }

  /* Mode row */
  .mode-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .custom-address-input {
    width: 120px;
  }

  .single-write-toggle {
    margin-top: 1px;
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

  .seg-btn.active {
    background: color-mix(in srgb, var(--c-accent) 12%, var(--c-surface-2));
    color: var(--c-text-1);
  }

  .seg-btn.active :global(svg) { color: var(--c-accent); }

  /* Action row */
  .action-row {
    display: flex;
    gap: 6px;
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
    grid-template-columns: minmax(140px, 1fr) 92px 64px 88px 60px 182px 52px;
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

  .single-write-toggle {
    display: inline-flex;
    align-items: center;
    height: 30px;
  }

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
