<svelte:options runes={true} />

<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    label,
    title = label,
    onclick,
    active = false,
    compact = false,
    tooltip = true,
    children,
  } = $props<{
    label: string;
    title?: string;
    onclick: () => void;
    active?: boolean;
    compact?: boolean;
    tooltip?: boolean;
    children?: Snippet;
  }>();
</script>

<button
  class:active
  class:compact
  class:has-tip={tooltip}
  class="icon-btn"
  type="button"
  data-tip={tooltip ? title : undefined}
  aria-label={label}
  {onclick}
>
  {@render children?.()}
</button>

<style>
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

  .icon-btn.active {
    border-color: color-mix(in srgb, var(--c-border-strong) 88%, var(--c-surface-3));
    background: color-mix(in srgb, var(--c-accent) 8%, var(--c-surface-2));
    color: var(--c-text-1);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-accent) 18%, transparent);
  }

  .icon-btn.active :global(svg) {
    color: var(--c-accent);
  }

  .icon-btn.compact {
    height: 24px;
    min-width: 24px;
    width: 24px;
    border-radius: 6px;
  }
</style>
