<svelte:options runes={true} />

<script lang="ts">
  import EmptyState from "../shared/EmptyState.svelte";
  import IconGlyph from "../shared/IconGlyph.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";
  import SectionHeader from "../shared/SectionHeader.svelte";
  import type { TabIcon } from "../../state/navigation.svelte";
  import type { Snippet } from "svelte";

  let {
    title,
    feature,
    icon,
    actions,
    children,
  } = $props<{
    title: string;
    feature: string;
    icon: TabIcon;
    actions?: Snippet;
    children?: Snippet;
  }>();
</script>

<div class="page-shell">
  <SectionHeader title={title} subtitle={feature}>
    {#snippet actions()}
      <span class="icon-wrap"><IconGlyph {icon} size={18} /></span>
    {/snippet}
  </SectionHeader>

  {#if children}
    {@render children()}
  {:else}
    <PanelFrame>
      {#snippet children()}
        <EmptyState message={`The ${title} workspace is ready. Implementation comes in the next phase.`} />
      {/snippet}
    </PanelFrame>
  {/if}
</div>

<style>
  .page-shell {
    display: grid;
    gap: 14px;
  }

  .icon-wrap {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--c-border);
    border-radius: 8px;
    background: var(--c-surface-2);
    width: 32px;
    height: 32px;
  }
</style>
