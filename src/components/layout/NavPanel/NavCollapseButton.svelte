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
    class="nav-toggle"
    type="button"
    title={collapsed ? "Expand navigation" : "Collapse navigation"}
    aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
    onclick={onToggle}
  >
    {#if collapsed}
      <ChevronsRight size={16} />
    {:else}
      <ChevronsLeft size={16} />
      <span>Collapse</span>
    {/if}
  </button>
</div>

<style>
  .nav-collapse-btn {
    display: none;
    padding: 8px;
  }

  .nav-toggle {
    width: 100%;
    display: grid;
    grid-template-columns: 16px 1fr;
    align-items: center;
    gap: 10px;
    border: 1px solid transparent;
    border-radius: 10px;
    background: transparent;
    color: var(--c-text-2);
    padding: 10px 12px;
    text-align: left;
    transition: border-color 140ms ease, background 140ms ease, color 140ms ease;
  }

  .nav-toggle:hover {
    border-color: var(--c-border-strong);
    color: var(--c-text-1);
    background: var(--c-surface-2);
  }

  .nav-toggle.collapsed {
    grid-template-columns: 1fr;
    justify-items: center;
    padding: 10px 6px;
  }

  @media (min-width: 768px) {
    .nav-collapse-btn {
      display: block;
    }
  }
</style>
