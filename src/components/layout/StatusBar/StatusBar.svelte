<svelte:options runes={true} />

<script lang="ts">
  import {
    layoutState,
    toggleMobileLog,
    toggleStatusCompact,
  } from "../../../state/layout.svelte";
  import ConnectionBadge from "./ConnectionBadge.svelte";
  import DeviceInfo from "./DeviceInfo.svelte";
  import StatusBarActions from "./StatusBarActions.svelte";

  let { onShowAbout } = $props<{
    onShowAbout?: () => void;
  }>();
</script>

<header class="status-bar">
  <div class="left">
    <h1>Modbus Lab</h1>
    <ConnectionBadge />
  </div>

  <div class="center">
    <DeviceInfo compact={layoutState.statusCompact} />
  </div>

  <StatusBarActions
    statusCompact={layoutState.statusCompact}
    onToggleStatus={toggleStatusCompact}
    onToggleMobileLog={toggleMobileLog}
    onShowAbout={onShowAbout}
  />
</header>

<style>
  .status-bar {
    grid-area: status;
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid var(--c-border);
    padding: 4px 10px;
    min-height: 32px;
    background: color-mix(in srgb, var(--c-surface-1) 86%, var(--c-surface-2));
  }

  .left {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  h1 {
    margin: 0;
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
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
