<svelte:options runes={true} />

<script lang="ts">
  import { Bot, ChevronUp, ListChecks, Logs, Play } from "lucide-svelte";
  import IconButton from "../../shared/IconButton.svelte";

  let {
    demoEnabled,
    demoRunning,
    statusCompact,
    onToggleDemo,
    onRunDemo,
    onToggleStatus,
    onToggleMobileLog,
  } = $props<{
    demoEnabled: boolean;
    demoRunning: boolean;
    statusCompact: boolean;
    onToggleDemo: () => void;
    onRunDemo: () => void;
    onToggleStatus: () => void;
    onToggleMobileLog: () => void;
  }>();
</script>

<div class="status-actions">
  <IconButton label="Toggle demo mode" title="Toggle demo mode" active={demoEnabled} onclick={onToggleDemo}>
    {#snippet children()}
      <Bot size={16} />
    {/snippet}
  </IconButton>

  <IconButton label="Run demo script" title="Run demo script" active={demoRunning} onclick={onRunDemo}>
    {#snippet children()}
      <Play size={16} />
    {/snippet}
  </IconButton>

  <IconButton
    label="Collapse status details"
    title="Collapse status details"
    active={statusCompact}
    onclick={onToggleStatus}
  >
    {#snippet children()}
      <ListChecks size={16} />
    {/snippet}
  </IconButton>

  <div class="mobile-only">
    <IconButton label="Toggle logs" title="Toggle logs" onclick={onToggleMobileLog}>
      {#snippet children()}
        <Logs size={16} />
      {/snippet}
    </IconButton>
  </div>

  <span class="demo-chip">
    <ChevronUp size={14} />
    Demo
  </span>
</div>

<style>
  .status-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .demo-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.74rem;
    padding: 4px 8px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--c-accent) 25%, var(--c-surface-2));
    border: 1px solid var(--c-border);
  }

  .mobile-only {
    display: none;
  }

  @media (max-width: 767px) {
    .mobile-only {
      display: inline-flex;
    }

    .demo-chip {
      display: none;
    }
  }
</style>
