<svelte:options runes={true} />

<script lang="ts">
  import AppShell from "./components/layout/AppShell.svelte";
  import { addLog } from "./state/logs.svelte";

  let seeded = $state(false);

  $effect(() => {
    if (seeded) {
      return;
    }

    seeded = true;
    addLog("info", "Modbus Lab shell initialized.");
  });
</script>

<AppShell />