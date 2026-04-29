<svelte:options runes={true} />

<script lang="ts">
  import type { TabDef } from "../../../state/navigation.svelte";
  import NavItem from "./NavItem.svelte";

  let {
    tabs,
    activeTab,
    collapsed,
    onSelect,
  } = $props<{
    tabs: TabDef[];
    activeTab: TabDef["id"];
    collapsed: boolean;
    onSelect: (id: TabDef["id"]) => void;
  }>();
</script>

<div class="nav-section">
  {#each tabs as tab (tab.id)}
    <NavItem tab={tab} active={activeTab === tab.id} {collapsed} {onSelect} />
  {/each}
</div>

<style>
  .nav-section {
    display: grid;
    gap: 6px;
  }
</style>
