<svelte:options runes={true} />

<script lang="ts">
  import { ChevronDown, ChevronUp, Download, Trash2 } from "lucide-svelte";
  import type { LogExportScope, LogFilter } from "../../../state/logs.svelte";
  import IconButton from "../../shared/IconButton.svelte";
  import LogFilterTabs from "./LogFilterTabs.svelte";

  let {
    collapsed,
    filter,
    totalCount,
    visibleCount,
    onFilter,
    onClear,
    onSave,
    onToggle,
  } = $props<{
    collapsed: boolean;
    filter: LogFilter;
    totalCount: number;
    visibleCount: number;
    onFilter: (filter: LogFilter) => void;
    onClear: () => void;
    onSave: (scope: LogExportScope) => void;
    onToggle: () => void;
  }>();

  let saveScope = $state<LogExportScope>("filtered");

  const saveDisabled = $derived(saveScope === "all" ? totalCount === 0 : visibleCount === 0);
</script>

<header class="log-toolbar">
  <strong>Log Panel</strong>

  <LogFilterTabs active={filter} onSelect={onFilter} />

  <div class="actions">
    <div class="export-controls">
      <span class="export-label">Export</span>

      <div class="scope-toggle" role="group" aria-label="Select log export scope">
        <button
          class:active={saveScope === "filtered"}
          type="button"
          onclick={() => (saveScope = "filtered")}
        >
          Selected ({visibleCount})
        </button>
        <button class:active={saveScope === "all"} type="button" onclick={() => (saveScope = "all")}>
          All ({totalCount})
        </button>
      </div>

      <button class="save-btn" type="button" onclick={() => onSave(saveScope)} disabled={saveDisabled}>
        <Download size={14} />
        <span>Save</span>
      </button>
    </div>

    <IconButton label="Clear logs" title="Clear logs" onclick={onClear}>
      {#snippet children()}
        <Trash2 size={16} />
      {/snippet}
    </IconButton>

    <IconButton label="Toggle log panel" title="Toggle log panel" active={collapsed} onclick={onToggle}>
      {#snippet children()}
        {#if collapsed}
          <ChevronUp size={16} />
        {:else}
          <ChevronDown size={16} />
        {/if}
      {/snippet}
    </IconButton>
  </div>
</header>

<style>
  .log-toolbar {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--c-border);
  }

  strong {
    font-size: 0.8rem;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .export-controls {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .export-label {
    color: var(--c-text-1);
    font-size: 0.74rem;
    letter-spacing: 0.02em;
  }

  .scope-toggle {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--c-border);
    border-radius: 8px;
    overflow: hidden;
  }

  .scope-toggle button {
    border: 0;
    border-right: 1px solid var(--c-border);
    padding: 6px 10px;
    background: var(--c-surface-2);
    color: var(--c-text-2);
    font: inherit;
    font-size: 0.75rem;
    white-space: nowrap;
  }

  .scope-toggle button:last-child {
    border-right: 0;
  }

  .scope-toggle button:hover {
    color: var(--c-text-1);
    background: color-mix(in srgb, var(--c-surface-3) 78%, var(--c-surface-2));
  }

  .scope-toggle button.active {
    color: var(--c-text-1);
    background: color-mix(in srgb, var(--c-accent) 8%, var(--c-surface-2));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-accent) 18%, transparent);
  }

  .save-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid color-mix(in srgb, var(--c-border-strong) 88%, var(--c-surface-3));
    border-radius: 8px;
    background: color-mix(in srgb, var(--c-accent) 8%, var(--c-surface-2));
    color: var(--c-text-1);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-accent) 18%, transparent);
  }

  .save-btn :global(svg) {
    color: var(--c-accent);
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

    .actions,
    .export-controls,
    .scope-toggle {
      flex-wrap: wrap;
    }
  }
</style>
