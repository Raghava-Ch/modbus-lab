<svelte:options runes={true} />

<script lang="ts">
  import AppShell from "./components/layout/AppShell.svelte";
  import LoadingSpinner from "./components/shared/LoadingSpinner.svelte";
  import { addLog } from "./state/logs.svelte";
  import { initializationState } from "./state/initialization.svelte";

  let seeded = $state(false);

  $effect(() => {
    if (seeded) {
      return;
    }

    seeded = true;
    addLog("info", "Modbus Lab shell initialized.");
  });
</script>

{#if initializationState.isInitialized}
  <AppShell />
{:else}
  <LoadingSpinner />
{/if}