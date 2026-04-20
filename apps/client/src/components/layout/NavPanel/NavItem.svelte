<svelte:options runes={true} />

<script lang="ts">
  import IconGlyph from "../../shared/IconGlyph.svelte";
  import type { TabDef } from "../../../state/navigation.svelte";

  let {
    tab,
    active,
    collapsed,
    onSelect,
  } = $props<{
    tab: TabDef;
    active: boolean;
    collapsed: boolean;
    onSelect: (id: TabDef["id"]) => void;
  }>();
</script>

<button
  class:active
  class:collapsed
  class="nav-item has-tip"
  type="button"
  onclick={() => onSelect(tab.id)}
  data-tip={`${tab.label} (${tab.feature})`}
>
  <IconGlyph icon={tab.icon} size={16} />
  <span>{tab.label}</span>
</button>

<style>
  .nav-item {
    width: 100%;
    display: grid;
    grid-template-columns: 18px 1fr;
    align-items: center;
    gap: 8px;
    background: transparent;
    color: var(--c-text-2);
    padding: 7px 9px 7px 11px;
    text-align: left;
    font-size: 0.68rem;
    letter-spacing: 0.01em;
    border-radius: 6px 0 0 6px;
    border: none;
    border-left: 3px solid transparent;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }

  .nav-item:hover {
    color: var(--c-text-1);
    background: color-mix(in srgb, var(--c-surface-3) 40%, transparent);
    border-left-color: color-mix(in srgb, var(--c-border) 60%, transparent);
  }

  .nav-item.active {
    background: color-mix(in srgb, var(--c-surface-3) 60%, var(--c-surface-2));
    color: var(--c-text-1);
    border-left-color: var(--c-accent);
  }

  .nav-item.active :global(svg) {
    color: var(--c-accent);
  }

  .nav-item.collapsed {
    grid-template-columns: 1fr;
    justify-items: center;
    padding: 7px 4px;
    border-left: none;
    border-bottom: 2px solid transparent;
  }

  .nav-item.collapsed.active {
    border-bottom-color: var(--c-accent);
  }

  .nav-item.collapsed.active:hover {
    border-left: none;
  }

  .nav-item.collapsed span {
    display: none;
  }
</style>
