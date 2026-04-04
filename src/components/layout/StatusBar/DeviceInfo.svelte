<svelte:options runes={true} />

<script lang="ts">
  import { connectionState } from "../../../state/connection.svelte";

  let { compact = false } = $props<{ compact?: boolean }>();

  const protocolLabel = $derived(
    connectionState.protocol === "tcp"
      ? "Modbus TCP"
      : connectionState.protocol === "serial-rtu"
        ? "Serial RTU"
        : "Serial ASCII",
  );

  const connectionInfo = $derived(
    connectionState.protocol === "tcp"
      ? `${connectionState.tcp.host}:${connectionState.tcp.port}`
      : connectionState.serial.port,
  );
</script>

{#if !compact}
  <div class="device-info">
    <span>{protocolLabel}</span>
    <span>{connectionInfo}</span>
    <span>Slave {connectionState.slaveId}</span>
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
