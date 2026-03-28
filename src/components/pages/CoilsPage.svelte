<svelte:options runes={true} />
<script lang="ts">
  import {
    Table2,
    LayoutGrid,
    RefreshCw,
    Play,
    SlidersHorizontal,
    Wand,
    ChevronDown,
    ChevronUp,
    Zap,
    Timer,
    Repeat,
    Pencil,
    Check,
    X,
  } from "lucide-svelte";
  import {
    coilState,
    initCoilState,
    setCoilView,
    setCoilFilter,
    toggleCoilValue,
    setCoilValue,
    readCoil,
    writeCoil,
    writePendingCoils,
    setCoilLabel,
    executeMassWrite,
    startAutoToggle,
    stopAutoToggle,
    setMassAutoInterval,
    setPollActive,
    setPollInterval,
    applyAddressRange,
    addExclusiveCoil,
    generateRandomExclusiveCoilAddress,
    removeCoil,
    removeAllCustomCoils,
    getFilteredCoils,
    buildMassPreview,
    type MassWritePattern,
    type WriteMode,
  } from "../../state/coils.svelte";
  import SectionHeader from "../shared/SectionHeader.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";

  // ── Init & cleanup ──────────────────────────────────────────────────────────
  $effect(() => {
    initCoilState();
    return () => {
      stopAutoToggle();
      setPollActive(false);
    };
  });

  // ── Local panel open/close state ────────────────────────────────────────────
  let readPanelOpen = $state(false);
  let writePanelOpen = $state(false);

  // ── Address range inputs (local; committed on Apply) ────────────────────────
  let rangeStart = $state(coilState.startAddress);
  let rangeCount = $state(coilState.coilCount);

  // ── Filtered coil list ──────────────────────────────────────────────────────
  const filtered = $derived(getFilteredCoils());
  const massPreview = $derived(buildMassPreview());
  const onCount = $derived(coilState.entries.filter((e) => e.slaveValue).length);
  const offCount = $derived(coilState.entries.filter((e) => !e.slaveValue).length);
  const pendingWriteCount = $derived(
    coilState.entries.filter((e) => e.desiredValue !== e.slaveValue).length,
  );

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

  // ── Helpers ─────────────────────────────────────────────────────────────────
  function handleApplyRange(): void {
    const s = Math.max(0, rangeStart);
    const c = Math.max(1, Math.min(256, rangeCount));
    applyAddressRange(s, c);
    rangeStart = coilState.startAddress;
    rangeCount = coilState.coilCount;
    addAddressInput = "";
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

  function executeSingleWrite(): void {
    const parsed = Number(singleWriteAddressInput.trim());
    if (!Number.isFinite(parsed)) return;
    const addr = Math.floor(parsed);
    if (addr < 0 || addr > 65535) return;

    addExclusiveCoil(addr);
    setCoilValue(addr, singleWriteDesired);
    writeCoil(addr);
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
    return n.toString().padStart(4, "0");
  }
</script>

<div class="coils-page">
  <!-- ── Header ─────────────────────────────────────────────────────────────── -->
  <SectionHeader
    title="Coils"
    subtitle="FC 01 Read · FC 05 Write Single · FC 15 Write Multiple"
  >
    {#snippet actions()}
      <!-- Poll controls -->
      <div class="poll-controls">
        <select
          class="ctrl-select"
          value={coilState.pollInterval}
          onchange={(e) => setPollInterval(Number(e.currentTarget.value))}
          title="Poll interval"
        >
          {#each pollIntervals as pi}
            <option value={pi.ms}>{pi.label}</option>
          {/each}
        </select>
        <button
          class="ctrl-btn"
          class:active={coilState.pollActive}
          title={coilState.pollActive ? "Stop polling" : "Start polling"}
          type="button"
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
        <button class="ctrl-btn icon-only" title="Read once" type="button">
          <RefreshCw size={14} />
        </button>
      </div>

      <div class="divider-v"></div>

      <!-- View toggle -->
      <div class="view-toggle">
        <button
          class="ctrl-btn icon-only"
          class:active={coilState.view === "table"}
          title="Table view"
          type="button"
          onclick={() => setCoilView("table")}
        >
          <Table2 size={15} />
        </button>
        <button
          class="ctrl-btn icon-only"
          class:active={coilState.view === "switch"}
          title="Switch view"
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
      {#if pendingWriteCount > 0}
        <button
          class="pending-chip pending-chip-action"
          type="button"
          onclick={() => writePendingCoils()}
          title="Write all pending coils"
        >
          Pending write: {pendingWriteCount}
        </button>
      {/if}

      <button
        class="ctrl-btn"
        class:active={readPanelOpen}
        type="button"
        onclick={() => { readPanelOpen = !readPanelOpen; }}
        title="Add coils"
      >
        <SlidersHorizontal size={13} />
        <span>Add Coils</span>
        {#if readPanelOpen}<ChevronUp size={12} />{:else}<ChevronDown size={12} />{/if}
      </button>
      <button
        class="ctrl-btn"
        class:active={writePanelOpen || coilState.massAutoActive}
        type="button"
        onclick={() => { writePanelOpen = !writePanelOpen; }}
        title="Write operations"
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
                class="btn btn-sm btn-apply"
                type="button"
                onclick={suggestRandomAddress}
                title="Generate random free address"
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
                max="9999"
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
                max="256"
                value={rangeCount}
                oninput={(e) => { rangeCount = Number(e.currentTarget.value); }}
              />
            </div>
            <button class="btn btn-sm btn-apply" type="button" onclick={handleApplyRange}>
              Apply
            </button>
          </div>
          </div>

          <div class="mini-section mini-section-danger">
            <div class="mini-title">Cleanup</div>
            <div class="sub-row">
              <button class="btn btn-sm btn-clear" type="button" onclick={removeAllCustomCoils}>
                Clear Added Coils
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
                <button
                  class="toggle-mini single-write-toggle"
                  class:on={singleWriteDesired}
                  type="button"
                  onclick={() => { singleWriteDesired = !singleWriteDesired; }}
                  title={singleWriteDesired ? "Desired ON" : "Desired OFF"}
                >
                  <span class="toggle-thumb"></span>
                </button>
              </div>

              <button class="btn btn-sm btn-write" type="button" onclick={executeSingleWrite}>
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
              <button class="btn btn-write" type="button" onclick={executeMassWrite}>
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
                <button class="btn btn-write" type="button" onclick={startAutoToggle}>
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
            <span>Pending</span>
            <span>Addr</span>
            <span>Read Value</span>
            <span>Switch</span>
            <span>Operation</span>
            <span>Delete</span>
          </div>
          {#each filtered as entry (entry.address)}
            <div
              class="ct-row"
              class:row-on={entry.slaveValue}
              class:row-pending={entry.pending}
              class:row-dirty={entry.desiredValue !== entry.slaveValue}
            >
              <!-- Label cell — inline editable -->
              <span class="label-cell">
                {#if editingAddress === entry.address}
                  <input
                    class="label-input"
                    type="text"
                    value={editLabelVal}
                    oninput={(e) => { editLabelVal = e.currentTarget.value; }}
                    onblur={commitEdit}
                    onkeydown={onLabelKeydown}
                  />
                  <button class="icon-micro" type="button" onclick={commitEdit} title="Save">
                    <Check size={11} />
                  </button>
                  <button class="icon-micro" type="button" onclick={cancelEdit} title="Cancel">
                    <X size={11} />
                  </button>
                {:else}
                  <span
                    class="label-text"
                    class:label-empty={!entry.label}
                    role="button"
                    tabindex="0"
                    onclick={() => beginEdit(entry.address, entry.label)}
                    onkeydown={(e) => { if (e.key === "Enter") beginEdit(entry.address, entry.label); }}
                    title="Click to edit label"
                  >
                    {entry.label || "—"}
                  </span>
                  <button
                    class="icon-micro edit-trigger"
                    type="button"
                    onclick={() => beginEdit(entry.address, entry.label)}
                    title="Edit label"
                  >
                    <Pencil size={10} />
                  </button>
                {/if}
              </span>

              <span class="pending-cell">
                {#if entry.desiredValue !== entry.slaveValue}
                  <span class="dirty-indicator" title="Needs write">Pending</span>
                {/if}
              </span>

              <span class="addr-cell">{addrFmt(entry.address)}</span>

              <span class="value-cell">
                {#if entry.pending}
                  <span class="badge pending-badge">…</span>
                {:else}
                  <span class="badge" class:badge-live-on={entry.slaveValue} class:badge-live-off={!entry.slaveValue}>
                    {entry.slaveValue ? "ON" : "OFF"}
                  </span>
                {/if}
              </span>

              <span class="switch-cell">
                <button
                  class="toggle-mini"
                  class:on={entry.desiredValue}
                  type="button"
                  onclick={() => toggleCoilValue(entry.address)}
                  title={entry.desiredValue ? "Desired ON" : "Desired OFF"}
                >
                  <span class="toggle-thumb"></span>
                </button>
              </span>

              <span class="operation-cell">
                <button
                  class="read-mini"
                  type="button"
                  onclick={() => readCoil(entry.address)}
                  title="Read from slave"
                >
                  <RefreshCw size={11} />
                  Read
                </button>
                <button
                  class="write-mini"
                  type="button"
                  onclick={() => writeCoil(entry.address)}
                  title={entry.desiredValue ? "Write ON" : "Write OFF"}
                >
                  <Zap size={11} />
                  Write
                </button>
              </span>

              <span class="delete-cell">
                <button
                  class="delete-mini"
                  type="button"
                  onclick={() => removeCoil(entry.address)}
                  title="Delete coil"
                >
                  <X size={11} />
                </button>
              </span>
            </div>
          {/each}
        </div>

      {:else}
        <!-- SWITCH view -->
        <div class="switch-grid">
          {#each filtered as entry (entry.address)}
            <div
              class="coil-card"
              class:card-on={entry.slaveValue}
              class:card-pending={entry.pending}
              class:card-dirty={entry.desiredValue !== entry.slaveValue}
            >
              {#if entry.desiredValue !== entry.slaveValue}
                <span class="dirty-indicator card-dirty-badge" title="Needs write">Pending</span>
              {/if}
              {#if entry.label}
                <div class="card-label-wrap">
                  {#if editingAddress === entry.address}
                    <input
                      class="card-label-input"
                      type="text"
                      value={editLabelVal}
                      oninput={(e) => { editLabelVal = e.currentTarget.value; }}
                      onblur={commitEdit}
                      onkeydown={onLabelKeydown}
                    />
                    <button class="icon-micro" type="button" onclick={commitEdit} title="Save">
                      <Check size={11} />
                    </button>
                    <button class="icon-micro" type="button" onclick={cancelEdit} title="Cancel">
                      <X size={11} />
                    </button>
                  {:else}
                    <div class="card-label">{entry.label}</div>
                    <button
                      class="icon-micro card-label-edit"
                      type="button"
                      onclick={() => beginEdit(entry.address, entry.label)}
                      title="Edit label"
                    >
                      <Pencil size={10} />
                    </button>
                  {/if}
                </div>
              {:else}
                <div class="card-label-wrap">
                  {#if editingAddress === entry.address}
                    <input
                      class="card-label-input"
                      type="text"
                      value={editLabelVal}
                      oninput={(e) => { editLabelVal = e.currentTarget.value; }}
                      onblur={commitEdit}
                      onkeydown={onLabelKeydown}
                    />
                    <button class="icon-micro" type="button" onclick={commitEdit} title="Save">
                      <Check size={11} />
                    </button>
                    <button class="icon-micro" type="button" onclick={cancelEdit} title="Cancel">
                      <X size={11} />
                    </button>
                  {:else}
                    <div class="card-label card-label-empty">—</div>
                    <button
                      class="icon-micro card-label-edit"
                      type="button"
                      onclick={() => beginEdit(entry.address, entry.label)}
                      title="Edit label"
                    >
                      <Pencil size={10} />
                    </button>
                  {/if}
                </div>
              {/if}
              <div class="card-addr">{addrFmt(entry.address)}</div>

              <div class="card-status">
                {#if entry.pending}
                  <span class="badge pending-badge">…</span>
                {:else}
                  <span class="badge" class:badge-live-on={entry.slaveValue} class:badge-live-off={!entry.slaveValue}>
                    {entry.slaveValue ? "ON" : "OFF"}
                  </span>
                {/if}
              </div>

              <div class="card-toggle-wrap">
                <button
                  class="toggle-track"
                  class:on={entry.desiredValue}
                  type="button"
                  onclick={() => toggleCoilValue(entry.address)}
                  title="Toggle value"
                >
                  <div class="toggle-thumb-lg"></div>
                </button>
              </div>

              <div class="card-actions">
                <button
                  class="read-mini"
                  type="button"
                  onclick={() => readCoil(entry.address)}
                  title="Read from slave"
                >
                  <RefreshCw size={11} />
                  Read
                </button>
                <button
                  class="write-mini"
                  type="button"
                  onclick={() => writeCoil(entry.address)}
                  title={entry.desiredValue ? "Write ON" : "Write OFF"}
                >
                  <Zap size={11} />
                  Write
                </button>
                <button
                  class="delete-mini"
                  type="button"
                  onclick={() => removeCoil(entry.address)}
                  title="Delete coil"
                >
                  <X size={11} />
                </button>
              </div>
            </div>
          {/each}
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
    height: 28px;
    padding: 0 22px 0 8px;
    border: 1px solid var(--c-border);
    border-radius: 6px;
    background: var(--c-surface-2);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%23c9cfda' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 6px center;
    appearance: none;
    color: var(--c-text-2);
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
  }

  .ctrl-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 28px;
    padding: 0 9px;
    border: 1px solid var(--c-border);
    border-radius: 6px;
    background: var(--c-surface-2);
    color: var(--c-text-2);
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
    transition: all 140ms ease;
    white-space: nowrap;
  }

  .ctrl-btn.icon-only {
    padding: 0 7px;
  }

  .ctrl-btn:hover {
    border-color: var(--c-border-strong);
    color: var(--c-text-1);
  }

  .ctrl-btn.active {
    border-color: color-mix(in srgb, var(--c-border-strong) 88%, var(--c-surface-3));
    background: color-mix(in srgb, var(--c-accent) 8%, var(--c-surface-2));
    color: var(--c-text-1);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-accent) 18%, transparent);
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
    gap: 8px;
  }

  .filter-tabs {
    display: flex;
    gap: 2px;
    background: var(--c-surface-2);
    border: 1px solid var(--c-border);
    border-radius: 8px;
    padding: 3px;
  }

  .filter-tab {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 24px;
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--c-text-2);
    font: inherit;
    font-size: 0.72rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 140ms ease;
  }

  .filter-tab:hover {
    color: var(--c-text-1);
  }

  .filter-tab.active {
    border-color: color-mix(in srgb, var(--c-border-strong) 88%, var(--c-surface-3));
    background: color-mix(in srgb, var(--c-accent) 8%, var(--c-surface-2));
    color: var(--c-text-1);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-accent) 18%, transparent);
  }

  .count {
    font-size: 0.65rem;
    color: var(--c-text-2);
    background: var(--c-surface-3);
    border-radius: 10px;
    padding: 1px 5px;
  }

  .count.on  { color: var(--c-ok);   background: color-mix(in srgb, var(--c-ok) 15%, var(--c-surface-3)); }
  .count.off { color: var(--c-text-2); }

  .toolbar-actions {
    display: flex;
    align-items: center;
    gap: 4px;
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
    overflow-x: auto;
  }

  .ct-header,
  .ct-row {
    display: grid;
    grid-template-columns: minmax(140px, 1fr) 92px 64px 88px 60px 182px 52px;
    align-items: center;
    gap: 0;
    min-width: 700px;
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

  .ct-header > span,
  .ct-row > span { padding: 0 4px; }

  .ct-row {
    border-bottom: 1px solid color-mix(in srgb, var(--c-border) 40%, transparent);
    min-height: 34px;
    transition: background 100ms;
  }

  .ct-row:last-child { border-bottom: none; }

  .ct-row:hover {
    background: color-mix(in srgb, var(--c-surface-3) 52%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-border) 52%, transparent);
  }

  .ct-row.row-on { background: color-mix(in srgb, var(--c-ok) 4%, transparent); }

  .ct-row.row-dirty {
    box-shadow: inset 3px 0 0 0 color-mix(in srgb, var(--c-warn) 60%, transparent);
  }

  .ct-row.row-pending { opacity: 0.7; }

  .addr-cell {
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--c-text-2);
  }

  /* Label cell */
  .label-cell {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .label-text {
    font-size: 0.78rem;
    color: var(--c-text-1);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .label-text.label-empty {
    color: var(--c-text-2);
    opacity: 0.45;
    font-style: italic;
  }

  .label-input {
    flex: 1;
    min-width: 0;
    height: 24px;
    padding: 0 6px;
    border: 1px solid var(--c-accent);
    border-radius: 4px;
    background: var(--c-surface-2);
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.75rem;
    outline: none;
  }

  .icon-micro {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--c-text-2);
    cursor: pointer;
    flex-shrink: 0;
    transition: color 100ms;
  }
  .icon-micro:hover { color: var(--c-text-1); }

  .edit-trigger { opacity: 0; transition: opacity 100ms; }
  .ct-row:hover .edit-trigger { opacity: 1; }

  /* Value badge */
  .value-cell { display: flex; align-items: center; }
  .pending-cell { display: flex; align-items: center; }
  .switch-cell { display: flex; align-items: center; }
  .operation-cell { display: flex; align-items: center; gap: 6px; }
  .operation-cell { flex-wrap: nowrap; }
  .delete-cell { display: flex; align-items: center; }

  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 18px;
    min-width: 34px;
    border-radius: 9px;
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .pending-badge { background: color-mix(in srgb, var(--c-warn) 18%, var(--c-surface-3)); color: var(--c-warn); }
  .badge-live-on  { background: color-mix(in srgb, var(--c-ok) 20%, var(--c-surface-3)); color: var(--c-ok); }
  .badge-live-off { background: color-mix(in srgb, var(--c-text-2) 12%, var(--c-surface-3)); color: var(--c-text-2); opacity: 0.8; }

  .dirty-indicator {
    display: inline-flex;
    align-items: center;
    height: 20px;
    padding: 0 7px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--c-warn) 36%, var(--c-border));
    background: color-mix(in srgb, var(--c-warn) 12%, var(--c-surface-2));
    color: var(--c-warn);
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .toggle-mini {
    position: relative;
    width: 32px;
    height: 17px;
    border-radius: 9px;
    border: 1px solid var(--c-border);
    background: var(--c-surface-3);
    cursor: pointer;
    transition: background 180ms, border-color 180ms;
    flex-shrink: 0;
  }

  .toggle-mini.on {
    background: color-mix(in srgb, var(--c-ok) 35%, var(--c-surface-2));
    border-color: var(--c-ok);
  }

  .toggle-mini .toggle-thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: var(--c-text-2);
    transition: transform 180ms, background 180ms;
  }

  .toggle-mini.on .toggle-thumb {
    transform: translateX(15px);
    background: var(--c-ok);
  }

  .write-mini {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 8px;
    border: 1px solid color-mix(in srgb, var(--c-accent) 30%, var(--c-border));
    border-radius: 6px;
    background: color-mix(in srgb, var(--c-accent) 12%, var(--c-surface-2));
    color: var(--c-accent);
    font: inherit;
    font-size: 0.66rem;
    cursor: pointer;
    white-space: nowrap;
    transition: all 120ms ease;
  }

  .write-mini:hover {
    border-color: var(--c-accent);
    color: var(--c-text-1);
  }

  .read-mini {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 8px;
    border: 1px solid color-mix(in srgb, var(--c-text-2) 30%, var(--c-border));
    border-radius: 6px;
    background: color-mix(in srgb, var(--c-text-2) 8%, var(--c-surface-2));
    color: var(--c-text-2);
    font: inherit;
    font-size: 0.66rem;
    cursor: pointer;
    white-space: nowrap;
    transition: all 120ms ease;
  }

  .read-mini:hover {
    border-color: var(--c-border-strong);
    color: var(--c-text-1);
  }

  .delete-mini {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: 1px solid color-mix(in srgb, var(--c-error) 30%, var(--c-border));
    border-radius: 6px;
    background: color-mix(in srgb, var(--c-error) 10%, var(--c-surface-2));
    color: var(--c-error);
    font: inherit;
    cursor: pointer;
    transition: all 120ms ease;
  }

  .delete-mini:hover {
    border-color: var(--c-error);
    color: var(--c-text-1);
  }

  /* ── Switch / card view ──────────────────────────────────────────────────── */
  .switch-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 160px));
    justify-content: start;
    gap: 7px;
  }

  .coil-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    position: relative;
    padding: 12px 10px 10px;
    border: 1px solid var(--c-border);
    border-radius: 10px;
    background: var(--c-surface-2);
    transition: all 160ms ease;
    font: inherit;
    text-align: left;
  }

  .coil-card:hover {
    border-color: var(--c-border-strong);
    background: var(--c-surface-3);
  }

  .coil-card.card-on {
    border-color: color-mix(in srgb, var(--c-ok) 45%, var(--c-border));
    background: color-mix(in srgb, var(--c-ok) 7%, var(--c-surface-1));
  }

  .coil-card.card-dirty {
    border-color: color-mix(in srgb, var(--c-warn) 40%, var(--c-border));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-warn) 22%, transparent);
  }

  .coil-card.card-pending { opacity: 0.65; }

  .card-addr {
    font-family: monospace;
    font-size: 0.7rem;
    color: var(--c-text-2);
    align-self: flex-start;
  }

  .card-label {
    font-size: 0.7rem;
    color: var(--c-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
    line-height: 24px;
  }

  .card-label-wrap {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    min-height: 24px;
  }

  .card-label-input {
    flex: 1;
    min-width: 0;
    height: 24px;
    padding: 0 6px;
    border: 1px solid var(--c-accent);
    border-radius: 4px;
    background: var(--c-surface-2);
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.72rem;
    outline: none;
  }

  .card-label-edit {
    opacity: 0.8;
  }

  .card-label-empty {
    opacity: 0.45;
  }

  .card-toggle-wrap {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    flex: 1;
    padding: 4px 0;
  }

  .toggle-track {
    position: relative;
    width: 46px;
    height: 26px;
    border-radius: 13px;
    border: 1px solid var(--c-border);
    background: var(--c-surface-3);
    padding: 0;
    cursor: pointer;
    transition: background 200ms, border-color 200ms;
  }

  .toggle-track.on {
    background: color-mix(in srgb, var(--c-ok) 35%, var(--c-surface-2));
    border-color: var(--c-ok);
  }

  .toggle-thumb-lg {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--c-text-2);
    transition: transform 200ms, background 200ms;
    box-shadow: 0 1px 3px rgba(0,0,0,.35);
  }

  .toggle-track.on .toggle-thumb-lg {
    transform: translateX(20px);
    background: var(--c-ok);
  }

  .card-status { margin-top: auto; }

  .card-actions {
    margin-top: 2px;
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    align-items: center;
    gap: 6px;
    width: 100%;
    flex-wrap: nowrap;
  }

  .card-actions .read-mini,
  .card-actions .write-mini {
    min-width: 0;
    justify-content: center;
    padding: 0 6px;
  }

  .card-dirty-badge {
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 1;
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

    .coil-card {
      width: 100%;
      align-items: stretch;
    }

    .card-toggle-wrap {
      justify-content: center;
    }

    .card-status {
      display: flex;
      justify-content: center;
    }

    .card-actions {
      grid-template-columns: 1fr 1fr auto;
    }

    .card-actions .write-mini,
    .card-actions .read-mini {
      width: 100%;
      justify-content: center;
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
</style>
