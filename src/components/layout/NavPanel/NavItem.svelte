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
  class="nav-item"
  type="button"
  onclick={() => onSelect(tab.id)}
  title={`${tab.label} (${tab.feature})`}
>
  <IconGlyph icon={tab.icon} size={18} />
  <span>{tab.label}</span>
</button>

<style>
  .nav-item {
    width: 100%;
    display: grid;
    grid-template-columns: 20px 1fr;
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

  .nav-item:hover {
    border-color: var(--c-border-strong);
    color: var(--c-text-1);
    background: var(--c-surface-2);
  }

  .nav-item.active {
    border-color: color-mix(in srgb, var(--c-border-strong) 88%, var(--c-surface-3));
    background: color-mix(in srgb, var(--c-accent) 8%, var(--c-surface-2));
    color: var(--c-text-1);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-accent) 18%, transparent);
  }

  .nav-item.active :global(svg) {
    color: var(--c-accent);
  }

  .nav-item.collapsed {
    grid-template-columns: 1fr;
    justify-items: center;
    padding: 10px 6px;
  }

  .nav-item.collapsed span {
    display: none;
  }

  @media (max-width: 767px) {
    .nav-item {
      grid-template-columns: 1fr;
      justify-items: center;
      gap: 4px;
      border-radius: 8px;
      padding: 8px 4px;
      font-size: 0.7rem;
    }

    .nav-item span {
      display: block;
      line-height: 1;
    }
  }
</style>
