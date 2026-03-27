<svelte:options runes={true} />

<script lang="ts">
  import type { LogFilter } from "../../../state/logs.svelte";

  let {
    active,
    onSelect,
  } = $props<{
    active: LogFilter;
    onSelect: (value: LogFilter) => void;
  }>();

  const filters: LogFilter[] = ["all", "traffic", "info", "warn", "error"];
</script>

<div class="filters">
  {#each filters as filter}
    <button
      class:active={active === filter}
      type="button"
      onclick={() => onSelect(filter)}
    >
      {filter.toUpperCase()}
    </button>
  {/each}
</div>

<style>
  .filters {
    display: flex;
    gap: 6px;
  }

  button {
    border: 1px solid var(--c-border);
    border-radius: 8px;
    padding: 4px 8px;
    background: var(--c-surface-2);
    color: var(--c-text-2);
    font-size: 0.72rem;
  }

  button:hover {
    border-color: var(--c-border-strong);
    color: var(--c-text-1);
  }

  button.active {
    border-color: color-mix(in srgb, var(--c-border-strong) 88%, var(--c-surface-3));
    color: var(--c-text-1);
    background: color-mix(in srgb, var(--c-accent) 8%, var(--c-surface-2));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-accent) 18%, transparent);
  }
</style>
