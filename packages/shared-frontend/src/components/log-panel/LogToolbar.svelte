<svelte:options runes={true} />

<script lang="ts">
  import { ChevronDown, ChevronUp, Download, Eraser } from "lucide-svelte";
  import type { LogExportScope, LogFilter, LogPanelView } from "./types";
  import LogFilterTabs from "./LogFilterTabs.svelte";

  let {
    collapsed,
    panelView,
    filter,
    totalCount,
    visibleCount,
    onFilter,
    onClear,
    onSave,
    onPanelView,
    onToggle,
  } = $props<{
    collapsed: boolean;
    panelView: LogPanelView;
    filter: LogFilter;
    totalCount: number;
    visibleCount: number;
    onFilter: (filter: LogFilter) => void;
    onClear: () => void;
    onSave: (scope: LogExportScope) => Promise<void> | void;
    onPanelView: (view: LogPanelView) => void;
    onToggle: () => void;
  }>();

  let saveScope = $state<LogExportScope>("filtered");
  let isSaving = $state(false);

  const saveDisabled = $derived(isSaving || (saveScope === "all" ? totalCount === 0 : visibleCount === 0));
  const filteredScopeLabel = $derived(
    filter === "all" ? `Filtered (${visibleCount})` : `Filtered ${filter.toUpperCase()} (${visibleCount})`,
  );

  async function handleSaveClick(): Promise<void> {
    isSaving = true;
    try {
      await onSave(saveScope);
    } finally {
      isSaving = false;
    }
  }
</script>

<header class="log-toolbar">
  <div class="toolbar-title">
    <div class="panel-tabs" role="tablist" aria-label="Bottom panel mode">
      <button
        class="tab-btn"
        class:active={panelView === "logs"}
        role="tab"
        aria-selected={panelView === "logs"}
        type="button"
        onclick={() => onPanelView("logs")}
      >Logs</button>
      <button
        class="tab-btn"
        class:active={panelView === "details"}
        role="tab"
        aria-selected={panelView === "details"}
        type="button"
        onclick={() => onPanelView("details")}
      >Details</button>
    </div>
  </div>

  {#if collapsed}
    <div class="toolbar-filters"></div>
    <div class="actions compact">
      <button class="icon-btn compact" type="button" aria-label="Expand panel" title="Expand panel" onclick={onToggle}>
        <ChevronUp size={13} />
      </button>
    </div>
  {:else}
    <div class="toolbar-filters"></div>

    <div class="actions">
      {#if panelView === "logs"}
        <div class="right-filters">
          <LogFilterTabs active={filter} onSelect={onFilter} />
        </div>

        <div class="export-group">
          <div class="export-controls">
            <div class="scope-toggle" role="group" aria-label="Select log export scope">
              <button
                class:active={saveScope === "filtered"}
                class="filtered-btn"
                type="button"
                onclick={() => (saveScope = "filtered")}
              >
                {filteredScopeLabel}
              </button>
              <button class:active={saveScope === "all"} type="button" onclick={() => (saveScope = "all")}>
                All ({totalCount})
              </button>
            </div>
          </div>

          <button class="save-btn" type="button" onclick={handleSaveClick} disabled={saveDisabled}>
            <Download size={12} />
            <span>Save</span>
          </button>
        </div>

        <button class="icon-btn compact" type="button" aria-label="Clear logs" title="Clear logs" onclick={onClear}>
          <Eraser size={13} />
        </button>
      {/if}

      <button class="icon-btn compact" type="button" aria-label="Collapse panel" title="Collapse panel" onclick={onToggle}>
        <ChevronDown size={13} />
      </button>
    </div>
  {/if}
</header>

<style>
  .log-toolbar {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    height: 32px;
    background: color-mix(in srgb, var(--c-surface-1) 86%, var(--c-surface-2));
  }

  .toolbar-title {
    min-width: 0;
    align-self: stretch;
    display: flex;
    align-items: stretch;
  }

  .toolbar-filters {
    min-width: 0;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 6px;
    justify-self: end;
  }

  .right-filters {
    display: flex;
    align-items: center;
  }

  .actions.compact {
    gap: 6px;
  }

  .panel-tabs {
    display: inline-flex;
    align-items: stretch;
    height: 100%;
    gap: 0;
  }

  .tab-btn {
    height: 100%;
    min-width: 66px;
    padding: 0 12px;
    border: 0;
    background: transparent;
    color: var(--c-text-2);
    font: inherit;
    font-size: 0.64rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    cursor: pointer;
    position: relative;
  }

  .tab-btn:last-child {
    border-right: 0;
  }

  .tab-btn:hover {
    color: var(--c-text-1);
    background: color-mix(in srgb, var(--c-surface-3) 34%, transparent);
  }

  .tab-btn.active {
    color: var(--c-text-1);
    background: linear-gradient(
      to bottom,
      transparent,
      color-mix(in srgb, var(--c-surface-3) 100%, transparent)
    );
  }

  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 32px;
    min-width: 32px;
    border: 1px solid var(--c-border);
    border-radius: 8px;
    background: var(--c-surface-2);
    color: var(--c-text-1);
    transition: background 140ms ease, border-color 140ms ease;
  }

  .icon-btn:hover {
    border-color: var(--c-border-strong);
    background: var(--c-surface-3);
  }

  .icon-btn.compact {
    height: 24px;
    min-width: 24px;
    width: 24px;
    border-radius: 6px;
  }

  .export-group {
    display: flex;
    align-items: center;
    gap: 0;
    border: 1px solid var(--c-border);
    border-radius: 3px;
    background: color-mix(in srgb, var(--c-surface-1) 70%, var(--c-surface-2));
    overflow: hidden;
  }

  .export-controls {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 3px 7px;
    border-right: 1px solid var(--c-border);
  }

  .filtered-btn {
    min-width: 120px;
  }

  .scope-toggle {
    display: inline-flex;
    align-items: center;
    border: 0;
    overflow: hidden;
  }

  .scope-toggle button {
    border: 1px solid transparent;
    height: 20px;
    padding: 0 6px;
    background: transparent;
    color: var(--c-text-2);
    font: inherit;
    font-size: 0.6rem;
    white-space: nowrap;
    cursor: pointer;
    transition: all 140ms ease;
  }

  .scope-toggle button:last-child {
    border: 1px solid transparent;
  }

  .scope-toggle button:hover {
    color: var(--c-text-1);
    border: 1px solid var(--c-border-strong);
  }

  .scope-toggle button.active {
    border-radius: 3px;
    color: var(--c-text-1);
    background: color-mix(in srgb, var(--c-accent) 8%, var(--c-surface-3));
  }

  .save-btn {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 22px;
    padding: 0 8px;
    border: 0;
    background: transparent;
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.62rem;
    white-space: nowrap;
    cursor: pointer;
    transition: all 140ms ease;
  }

  .save-btn :global(svg) {
    color: var(--c-accent);
  }

  .save-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--c-surface-3) 78%, var(--c-surface-2));
  }

  .save-btn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  @media (max-width: 767px) {
    .log-toolbar {
      grid-template-columns: 1fr;
      align-items: stretch;
    }

    .actions {
      justify-self: stretch;
      justify-content: space-between;
    }

    .actions,
    .export-group,
    .export-controls,
    .scope-toggle {
      flex-wrap: wrap;
    }
  }
</style>
