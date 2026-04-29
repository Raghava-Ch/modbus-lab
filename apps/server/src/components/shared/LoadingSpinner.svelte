<svelte:options runes={true} />

<script lang="ts">
  import { logState } from "../../state/logs.svelte";

  // Show last log entry if it's an initialization warning
  const lastInitWarning = $derived.by(() => {
    const lastEntry = logState.entries[logState.entries.length - 1];
    if (
      lastEntry &&
      lastEntry.level === "warn" &&
      (lastEntry.message.includes("Unable to") || lastEntry.message.includes("took longer"))
    ) {
      return lastEntry.message;
    }
    return null;
  });
</script>

<div class="spinner">
  <div class="spinner-ring"></div>
  <p class="spinner-text">Loading Modbus Lab...</p>
  {#if lastInitWarning}
    <p class="spinner-notice">{lastInitWarning}</p>
  {/if}
</div>

<style>
  .spinner {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    background: var(--c-bg);
    gap: 8px;
  }

  .spinner-text {
    margin-top: 20px;
    font-size: 14px;
    color: var(--c-text-2);
    letter-spacing: 0.5px;
  }

  .spinner-notice {
    margin-top: 12px;
    padding: 8px 12px;
    font-size: 12px;
    color: var(--c-warn);
    background: color-mix(in srgb, var(--c-warn) 12%, transparent);
    border-radius: 4px;
    border: 1px solid color-mix(in srgb, var(--c-warn) 30%, transparent);
    max-width: 350px;
    text-align: center;
  }

  .spinner-ring {
    display: inline-block;
    position: relative;
    width: 48px;
    height: 48px;
  }

  .spinner-ring::after {
    content: "";
    position: absolute;
    left: 7px;
    top: 7px;
    width: 34px;
    height: 34px;
    border: 3px solid var(--c-border);
    border-radius: 50%;
    border-color: var(--c-accent) transparent transparent transparent;
    animation: spinner-spin 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
  }

  @keyframes spinner-spin {
    0% {
      transform: rotate(0deg);
    }
    100% {
      transform: rotate(360deg);
    }
  }
</style>
