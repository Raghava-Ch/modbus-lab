<svelte:options runes={true} />

<script lang="ts">
  import { connectionState } from "../../../state/connection.svelte";

  let { compact = false } = $props<{ compact?: boolean }>();

  const protocolLabel = $derived(
    connectionState.protocol === "tcp"
      ? "TCP"
      : connectionState.protocol === "serial-rtu"
        ? "Serial RTU"
        : "Serial ASCII",
  );

  const bindTarget = $derived(
    connectionState.protocol === "tcp"
      ? `${connectionState.tcp.host}:${connectionState.tcp.port}`
      : connectionState.serial.port || "(not set)",
  );
</script>

{#if !compact}
  <div class="device-info">
    <span>{connectionState.listenerStatus === "running" ? "Listener Running" : "Listener Stopped"}</span>
    <span>{protocolLabel}</span>
    <span>{bindTarget}</span>
    <span>Unit {connectionState.slaveId}</span>
    <span>{connectionState.runtime.activeClients} clients</span>
  </div>
{/if}

<style>
  .device-info {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--c-text-2);
    font-size: 0.62rem;
  }

  .device-info span {
    display: inline-flex;
    align-items: center;
    height: 22px;
    border: 1px solid color-mix(in srgb, var(--c-border) 70%, transparent);
    border-radius: 999px;
    padding: 0 7px;
    background: color-mix(in srgb, var(--c-surface-1) 72%, var(--c-surface-2));
  }
</style>
