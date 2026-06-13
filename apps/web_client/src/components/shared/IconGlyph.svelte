<svelte:options runes={true} />

<script lang="ts">
  import {
    Activity,
    Cloud,
    Compass,
    Database,
    FileText,
    Layers,
    List,
    Plug,
    Settings2,
    Stethoscope,
    TrafficCone,
    ToggleLeft,
  } from "lucide-svelte";
  import type { TabIcon } from "../../state/navigation.svelte";

  let { icon, size = 18 } = $props<{ icon: TabIcon; size?: number }>();
</script>

{#if icon === "plug"}
  <Plug {size} />
{:else if icon === "toggle-left"}
  <ToggleLeft {size} />
{:else if icon === "list"}
  <List {size} />
{:else if icon === "database"}
  <Database {size} />
{:else if icon === "activity"}
  <Activity {size} />
{:else if icon === "file-text"}
  <FileText {size} />
{:else if icon === "layers"}
  <Layers {size} />
{:else if icon === "traffic"}
  <TrafficCone {size} />
{:else if icon === "stethoscope"}
  <Stethoscope {size} />
{:else if icon === "cloud"}
  <Cloud {size} />
{:else if icon === "compass"}
  <Compass {size} />
{:else}
  <Settings2 {size} />
{/if}
