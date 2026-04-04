<svelte:options runes={true} />

<script lang="ts">
  import { connectionState } from "../../../state/connection.svelte";

  const label = $derived(
    connectionState.status === "connected"
      ? "Connected"
      : connectionState.status === "connecting"
        ? "Connecting"
        : "Disconnected",
  );
</script>

<div class={`badge ${connectionState.status}`}>
  <span class="dot" aria-hidden="true"></span>
  <span>{label}</span>
</div>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    border: 1px solid color-mix(in srgb, var(--c-border) 70%, transparent);
    border-radius: 999px;
    padding: 0 8px;
    font-size: 0.62rem;
    letter-spacing: 0.02em;
    color: var(--c-text-1);
    background: color-mix(in srgb, var(--c-surface-1) 72%, var(--c-surface-2));
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--c-warn);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--c-warn) 45%, transparent);
    animation: pulse 1.7s infinite;
  }

  .badge.connected .dot {
    background: var(--c-ok);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--c-ok) 45%, transparent);
  }

  .badge.disconnected .dot {
    background: var(--c-error);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--c-error) 45%, transparent);
  }

  @keyframes pulse {
    0% {
      box-shadow: 0 0 0 0 currentColor;
    }
    75% {
      box-shadow: 0 0 0 7px transparent;
    }
    100% {
      box-shadow: 0 0 0 0 transparent;
    }
  }
</style>
