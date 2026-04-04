<svelte:options runes={true} />

<script lang="ts">
  import { ListChecks, Logs } from "lucide-svelte";
  import IconButton from "../../shared/IconButton.svelte";

  let {
    statusCompact,
    onToggleStatus,
    onToggleMobileLog,
  } = $props<{
    statusCompact: boolean;
    onToggleStatus: () => void;
    onToggleMobileLog: () => void;
  }>();
</script>

<div class="status-actions">
  <IconButton
    label="Collapse status details"
    title="Collapse status details"
    active={statusCompact}
    compact={true}
    onclick={onToggleStatus}
  >
    {#snippet children()}
      <ListChecks size={13} />
    {/snippet}
  </IconButton>

  <div class="mobile-only">
    <IconButton label="Toggle logs" title="Toggle logs" compact={true} onclick={onToggleMobileLog}>
      {#snippet children()}
        <Logs size={13} />
      {/snippet}
    </IconButton>
  </div>
</div>

<style>
  .status-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .mobile-only {
    display: none;
  }

  @media (max-width: 767px) {
    .mobile-only {
      display: inline-flex;
    }
  }
</style>