<svelte:options runes={true} />

<script lang="ts">
  import { connectionState } from "../../../state/connection.svelte";

  let { compact = false } = $props<{ compact?: boolean }>();
</script>

{#if !compact}
  <div class="device-info">
    <span>{connectionState.protocol}</span>
    <span>{connectionState.address}:{connectionState.port}</span>
    <span>Slave {connectionState.slaveId}</span>
  </div>
{/if}

<style>
  .device-info {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--c-text-2);
    font-size: 0.8rem;
  }

  .device-info span {
    border: 1px solid var(--c-border);
    border-radius: 999px;
    padding: 3px 8px;
    background: var(--c-surface-2);
  }
</style>
