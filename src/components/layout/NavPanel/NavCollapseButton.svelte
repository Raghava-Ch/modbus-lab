<svelte:options runes={true} />

<script lang="ts">
  import { PanelLeftClose, PanelLeftOpen } from "lucide-svelte";
  import IconButton from "../../shared/IconButton.svelte";

  let {
    collapsed,
    onToggle,
  } = $props<{
    collapsed: boolean;
    onToggle: () => void;
  }>();
</script>

<div class="nav-collapse-btn">
  <IconButton
    label="Toggle navigation"
    title="Toggle navigation"
    active={collapsed}
    onclick={onToggle}
  >
    {#snippet children()}
      {#if collapsed}
        <PanelLeftOpen size={16} />
      {:else}
        <PanelLeftClose size={16} />
      {/if}
    {/snippet}
  </IconButton>
</div>

<style>
  .nav-collapse-btn {
    display: none;
    padding: 8px;
  }

  @media (min-width: 768px) {
    .nav-collapse-btn {
      display: block;
    }
  }
</style>
