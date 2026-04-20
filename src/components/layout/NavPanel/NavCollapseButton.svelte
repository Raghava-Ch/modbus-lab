<svelte:options runes={true} />

<script lang="ts">
  import { ChevronsLeft, ChevronsRight } from "lucide-svelte";

  let {
    collapsed,
    onToggle,
  } = $props<{
    collapsed: boolean;
    onToggle: () => void;
  }>();
</script>

<div class="nav-collapse-btn">
  <button
    class:collapsed
    class="nav-toggle has-tip"
    type="button"
    data-tip={collapsed ? "Expand navigation" : "Collapse navigation"}
    aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
    onclick={onToggle}
  >
    {#if collapsed}
      <ChevronsRight size={16} />
    {:else}
      <ChevronsLeft size={16} />
    {/if}
  </button>
</div>

<style>
  .nav-collapse-btn {
    display: none;
    padding: 6px;
  }

  .nav-toggle {
    display: grid;
    grid-template-columns: 16px 1fr;
    align-items: center;
    border: 1px solid color-mix(in srgb, var(--c-border) 24%, transparent);
    border-radius: 6px;
    background: transparent;
    color: var(--c-text-2);
    padding: 7px 9px;
    text-align: left;
    font-size: 0.68rem;
    transition: border-color 120ms ease, background 120ms ease, color 120ms ease;
  }

  .nav-toggle:hover {
    border-color: var(--c-border-strong);
    color: var(--c-text-1);
    background: color-mix(in srgb, var(--c-surface-3) 34%, transparent);
  }

  .nav-toggle.collapsed {
    grid-template-columns: 1fr;
    justify-items: center;
    padding: 7px 4px;
  }

  @media (min-width: 768px) {
    .nav-collapse-btn {
      display: block;
    }
  }
</style>
