<svelte:options runes={true} />

<script lang="ts">
  import PageShell from "./PageShell.svelte";
  import SectionHeader from "../shared/SectionHeader.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";
  import { logState } from "../../state/logs.svelte";
  import { connectionState } from "../../state/connection.svelte";
  import { formatLogTimestamp } from "../../state/settings.svelte";

  const trafficLogs = $derived(
    logState.entries
      .filter((entry) => entry.level === "traffic")
      .slice(-150)
      .reverse(),
  );
</script>

<PageShell title="Traffic" feature="Request/error analytics" icon="stethoscope">
  {#snippet children()}
    {#if connectionState.status === "disconnected"}
      <div class="disconnected-banner" role="alert">
        <span class="banner-icon">⚠</span>
        <span class="banner-text">Server not running — go to <strong>Listener</strong> and start the server to accept client connections.</span>
      </div>
    {/if}

    <section class="traffic-section">
      <SectionHeader title="Traffic Logs" subtitle="Latest tx/rx protocol events (level: traffic)" />
      <PanelFrame>
        {#snippet children()}
          {#if trafficLogs.length === 0}
            <p class="empty-note">No traffic logs yet.</p>
          {:else}
            <div class="traffic-log-list" role="list">
              {#each trafficLogs as entry (entry.id)}
                <div class="traffic-log-row" role="listitem">
                  <span class="traffic-time">{formatLogTimestamp(entry.timestamp)}</span>
                  <span class="traffic-msg">{entry.message}</span>
                </div>
              {/each}
            </div>
          {/if}
        {/snippet}
      </PanelFrame>
    </section>
  {/snippet}
</PageShell>

<style>
  .traffic-section {
    display: grid;
    gap: 10px;
    margin-top: 6px;
    margin-bottom: 8px;
  }

  .disconnected-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--c-warn, #f0a500) 35%, var(--c-border));
    background: color-mix(in srgb, var(--c-warn, #f0a500) 8%, var(--c-surface-2));
    color: var(--c-text-1);
    margin-bottom: 12px;
    font-size: 0.8rem;
  }

  .banner-icon {
    flex-shrink: 0;
    font-size: 1rem;
    line-height: 1;
  }

  .banner-text strong {
    color: var(--c-accent);
  }

  .traffic-log-list {
    display: grid;
    gap: 5px;
    max-height: calc(100dvh - var(--log-panel-height, 220px) - 218px);
    min-height: 120px;
    overflow: auto;
    padding-right: 2px;
  }

  .traffic-log-row {
    display: grid;
    grid-template-columns: 100px 1fr;
    gap: 8px;
    padding: 6px 8px;
    border: 1px solid color-mix(in srgb, var(--c-border) 72%, transparent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--c-surface-2) 52%, transparent);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 0.74rem;
  }

  .traffic-time {
    color: var(--c-text-2);
  }

  .traffic-msg {
    color: var(--c-text-1);
    line-height: 1.35;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .empty-note {
    margin: 0;
    color: var(--c-text-2);
    font-size: 0.78rem;
  }

  @media (max-width: 720px) {
    .traffic-log-row {
      grid-template-columns: 1fr;
    }
  }
</style>
