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
    padding: 7px 9px;
    text-align: left;
    font-size: 0.68rem;
    letter-spacing: 0.01em;
    transition: background 120ms ease, color 120ms ease;
  }

  .nav-item:hover {
    border-color: var(--c-border-strong);
    color: var(--c-text-1);
    background: color-mix(in srgb, var(--c-surface-3) 34%, transparent);
  }

  .nav-item.active {
    border-color: color-mix(in srgb, var(--c-border-strong) 88%, var(--c-surface-3));
    border-right: none;
    background: color-mix(in srgb, var(--c-surface-3) 56%, var(--c-surface-2));
    color: var(--c-text-1);
    box-shadow: inset 0 3px 0px rgba(0, 0, 0, 0.3);
  }
  .nav-item:hover,
  .nav-item.active {
    border-radius: 12px 0 0 12px;
  }

  .nav-item.active :global(svg) {
    color: var(--c-accent);
  }

  .nav-item.collapsed {
    grid-template-columns: 1fr;
    justify-items: center;
    padding: 7px 4px;
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
