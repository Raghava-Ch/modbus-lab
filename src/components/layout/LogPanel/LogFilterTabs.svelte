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
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
  }

  button {
    border: 1px solid var(--c-border);
    border-radius: 6px;
    height: 24px;
    padding: 0 8px;
    background: color-mix(in srgb, var(--c-surface-1) 72%, var(--c-surface-2));
    color: var(--c-text-2);
    font-size: 0.62rem;
    letter-spacing: 0.01em;
  }

  button:hover {
    border-color: var(--c-border-strong);
    color: var(--c-text-1);
  }

  button.active {
    border-color: color-mix(in srgb, var(--c-border-strong) 88%, var(--c-surface-3));
    color: var(--c-text-1);
    background: color-mix(in srgb, var(--c-accent) 12%, var(--c-surface-2));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-accent) 18%, transparent);
  }
</style>
