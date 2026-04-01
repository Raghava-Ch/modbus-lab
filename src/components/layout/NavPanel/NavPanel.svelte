<svelte:options runes={true} />

<script lang="ts">
  import { layoutState, toggleNavCollapsed } from "../../../state/layout.svelte";
  import {
    navigationState,
    setActiveTab,
    tabDefs,
    type TabId,
  } from "../../../state/navigation.svelte";
  import NavCollapseButton from "./NavCollapseButton.svelte";
  import NavSection from "./NavSection.svelte";

  const mainTabs = tabDefs.filter((tab) => tab.group === "main");
  const settingsTabs = tabDefs.filter((tab) => tab.group === "settings");

  function handleSelect(tab: TabId): void {
    setActiveTab(tab);
  }
</script>

<aside class:collapsed={layoutState.navCollapsed} class="nav-panel">
  <NavCollapseButton collapsed={layoutState.navCollapsed} onToggle={toggleNavCollapsed} />

  <div class="main-nav">
    <NavSection
      tabs={mainTabs}
      activeTab={navigationState.activeTab}
      collapsed={layoutState.navCollapsed}
      onSelect={handleSelect}
    />
  </div>

  <div class="settings-nav">
    <NavSection
      tabs={settingsTabs}
      activeTab={navigationState.activeTab}
      collapsed={layoutState.navCollapsed}
      onSelect={handleSelect}
    />
  </div>
</aside>

<style>
  .nav-panel {
    grid-area: nav;
    display: grid;
    grid-template-rows: auto 1fr auto;
    border-right: 1px solid var(--c-border);
    background: var(--c-surface-1);
    width: var(--nav-width-open);
    transition: width 180ms ease;
    overflow: hidden;
  }

  .nav-panel.collapsed {
    width: var(--nav-width-collapsed);
  }

  .main-nav,
  .settings-nav {
    padding: 8px;
  }

  .settings-nav {
    border-top: 1px solid var(--c-border);
  }

  @media (max-width: 767px) {
    .nav-panel,
    .nav-panel.collapsed {
      width: auto;
      border-right: none;
      border-top: 1px solid var(--c-border);
      grid-template-rows: 1fr;
      display: flex;
      align-items: stretch;
      padding: 4px;
      gap: 4px;
      background: var(--c-surface-1);
      overflow: visible;
    }

    .main-nav,
    .settings-nav {
      padding: 0;
      border: 0;
    }

    .main-nav {
      flex: 1;
      min-width: 0;
    }
  }
</style>
