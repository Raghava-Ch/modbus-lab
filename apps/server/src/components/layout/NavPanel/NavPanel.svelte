<svelte:options runes={true} />

<script lang="ts">
  import { ChevronDown, ChevronUp, SlidersHorizontal } from "lucide-svelte";
  import { layoutState, toggleNavCollapsed } from "../../../state/layout.svelte";
  import {
    navigationState,
    setActiveTab,
    tabDefs,
    type TabId,
  } from "../../../state/navigation.svelte";
  import { settingsState } from "../../../state/settings.svelte";
  import NavCollapseButton from "./NavCollapseButton.svelte";
  import NavSection from "./NavSection.svelte";

  const mainTabs = $derived(
    tabDefs.filter((tab) => tab.group === "main" && (tab.id !== "ibus" || settingsState.ibus.enabled)),
  );
  const settingsTabs = tabDefs.filter((tab) => tab.group === "settings");
  const activeSettingsTab = $derived(settingsTabs.find((tab) => tab.id === navigationState.activeTab) ?? null);
  const activeMainTab = $derived(mainTabs.find((tab) => tab.id === navigationState.activeTab) ?? null);
  let settingsExpanded = $state(false);

  $effect(() => {
    if (layoutState.navCollapsed) {
      settingsExpanded = false;
      return;
    }

    if (activeMainTab) {
      settingsExpanded = false;
    }
  });

  function handleSelect(tab: TabId): void {
    setActiveTab(tab);
    const selected = tabDefs.find((item) => item.id === tab);
    if (selected?.group === "main") {
      settingsExpanded = false;
    }
  }

  function toggleSettingsExpanded(): void {
    settingsExpanded = !settingsExpanded;
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

  <div class="settings-nav" class:expanded={settingsExpanded}>
    <button
      class="settings-toggle"
      class:open={settingsExpanded}
      type="button"
      onclick={toggleSettingsExpanded}
      aria-expanded={settingsExpanded}
      aria-controls="server-settings-nav"
    >
      <span class="settings-toggle-main">
        <SlidersHorizontal size={15} />
        <span class="settings-toggle-label">Tools</span>
      </span>
      {#if !layoutState.navCollapsed && activeSettingsTab && !settingsExpanded}
        <span class="settings-active-label">{activeSettingsTab.label}</span>
      {/if}
      {#if !layoutState.navCollapsed}
        {#if settingsExpanded}
          <ChevronUp size={14} />
        {:else}
          <ChevronDown size={14} />
        {/if}
      {/if}
    </button>

    {#if !layoutState.navCollapsed && settingsExpanded}
      <div id="server-settings-nav" class="settings-section-wrap">
        <NavSection
          tabs={settingsTabs}
          activeTab={navigationState.activeTab}
          collapsed={layoutState.navCollapsed}
          onSelect={handleSelect}
        />
      </div>
    {/if}
  </div>
</aside>

<style>
  .nav-panel {
    grid-area: nav;
    display: grid;
    grid-template-rows: auto 1fr auto;
    background: color-mix(in srgb, var(--c-surface-1) 88%, var(--c-surface-2));
    width: var(--nav-width-open);
    transition: width 180ms ease;
    overflow: hidden;
  }

  .nav-panel.collapsed {
    width: var(--nav-width-collapsed);
  }

  .main-nav {
    padding: 6px 0 8px 0;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .settings-nav {
    border-top: 1px solid var(--c-border);
    background: color-mix(in srgb, var(--c-surface-1) 92%, transparent);
    padding: 6px 0 8px;
  }

  .settings-toggle {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px 8px 12px;
    border: none;
    background: transparent;
    color: var(--c-text-2);
    font: inherit;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }

  .settings-toggle:hover,
  .settings-toggle.open {
    background: color-mix(in srgb, var(--c-surface-3) 35%, transparent);
    color: var(--c-text-1);
  }

  .settings-toggle-main {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .settings-toggle-label {
    font-size: 0.68rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .settings-active-label {
    min-width: 0;
    margin-left: auto;
    font-size: 0.66rem;
    color: var(--c-text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .settings-section-wrap {
    padding-top: 4px;
  }

  .nav-panel.collapsed .settings-nav :global(.nav-item span) {
    display: none;
  }

  .nav-panel.collapsed .settings-nav {
    padding-bottom: 6px;
  }

  .nav-panel.collapsed .settings-toggle {
    justify-content: center;
    padding: 8px 4px;
  }

  .nav-panel.collapsed .settings-toggle-label,
  .nav-panel.collapsed .settings-active-label {
    display: none;
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

    .settings-toggle {
      height: 100%;
      border-radius: 8px;
      padding: 0 10px;
    }

    .settings-section-wrap {
      position: absolute;
      right: 8px;
      bottom: calc(100% + 8px);
      min-width: 220px;
      padding: 8px;
      border: 1px solid var(--c-border);
      border-radius: 10px;
      background: var(--c-surface-1);
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.28);
    }
  }
</style>
