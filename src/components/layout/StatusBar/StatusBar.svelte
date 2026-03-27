<svelte:options runes={true} />

<script lang="ts">
  import { demoState, runDemoScript, toggleDemoMode } from "../../../state/demo.svelte";
  import {
    layoutState,
    toggleMobileLog,
    toggleStatusCompact,
  } from "../../../state/layout.svelte";
  import ConnectionBadge from "./ConnectionBadge.svelte";
  import DeviceInfo from "./DeviceInfo.svelte";
  import StatusActions from "./StatusActions.svelte";
</script>

<header class="status-bar">
  <div class="left">
    <h1>ModBux</h1>
    <ConnectionBadge />
  </div>

  <div class="center">
    <DeviceInfo compact={layoutState.statusCompact} />
  </div>

  <StatusActions
    demoEnabled={demoState.enabled}
    demoRunning={demoState.running}
    statusCompact={layoutState.statusCompact}
    onToggleDemo={toggleDemoMode}
    onRunDemo={runDemoScript}
    onToggleStatus={toggleStatusCompact}
    onToggleMobileLog={toggleMobileLog}
  />
</header>

<style>
  .status-bar {
    grid-area: status;
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 10px;
    border-bottom: 1px solid var(--c-border);
    padding: 8px 12px;
    background: var(--c-surface-1);
  }

  .left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  h1 {
    margin: 0;
    font-size: 0.95rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    color: var(--c-text-1);
  }

  .center {
    display: flex;
    justify-content: center;
  }

  @media (max-width: 767px) {
    .status-bar {
      grid-template-columns: 1fr auto;
      gap: 8px;
    }

    .center {
      display: none;
    }
  }
</style>
