<svelte:options runes={true} />

<script lang="ts">
  import { ArrowDownLeft, ArrowUpRight, CircleAlert } from "lucide-svelte";
  import type { LogEntry } from "./types";

  let {
    entry,
    onopen,
    formatTimestamp,
  } = $props<{
    entry: LogEntry;
    onopen?: (entry: LogEntry) => void;
    formatTimestamp: (ts: number) => string;
  }>();

  interface TrafficMeta {
    direction: "tx" | "rx" | "other";
    functionName: string;
    txn: string;
    invalidReason: string;
  }

  // Keep traffic rows compact; full frame details are available on double-click.
  function trafficMeta(message: string): TrafficMeta {
    const withoutTopic = message.replace(/^\[.*?\]\s*/, "");
    const dirLabel = withoutTopic.match(/^(\S+)/)?.[1] ?? "tcp";
    const direction: TrafficMeta["direction"] = dirLabel.includes(".tx")
      ? "tx"
      : dirLabel.includes(".rx")
        ? "rx"
        : "other";
    const txn = message.match(/\btxn=(\d+)/)?.[1] ?? "";
    const fcName = message.match(/\bfc=\S+\(([^)]+)\)/)?.[1] ?? "";
    const reason = message.match(/\breason=(\S+)/)?.[1] ?? "";

    return {
      direction,
      functionName: fcName || "Traffic",
      txn,
      invalidReason: reason,
    };
  }

  function openDetails(): void {
    onopen?.(entry);
  }

  function handleClick(event: MouseEvent): void {
    if (event.detail >= 2) {
      openDetails();
    }
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDetails();
    }
  }

  const compactTraffic = $derived(entry.level === "traffic" ? trafficMeta(entry.message) : null);
</script>

{#snippet rowContent()}
  <span class="time">{formatTimestamp(entry.timestamp)}</span>
  <span class={`level ${entry.level}`}>{entry.level.toUpperCase()}</span>
  {#if entry.level === "traffic" && compactTraffic}
    <span class="message traffic-compact">
      <span class={`traffic-chip dir ${compactTraffic.direction}`}>
        {#if compactTraffic.direction === "tx"}
          <ArrowUpRight size={12} />
          <span>TX</span>
        {:else if compactTraffic.direction === "rx"}
          <ArrowDownLeft size={12} />
          <span>RX</span>
        {:else}
          <CircleAlert size={12} />
          <span>Traffic</span>
        {/if}
      </span>

      <span class="traffic-chip fn">{compactTraffic.functionName}</span>

      {#if compactTraffic.txn}
        <span class="traffic-chip txn">#{compactTraffic.txn}</span>
      {/if}

      {#if compactTraffic.invalidReason}
        <span class="traffic-chip warn">{compactTraffic.invalidReason}</span>
      {/if}
    </span>
  {:else}
    <span class="message">{entry.message}</span>
  {/if}
{/snippet}

{#if onopen}
  <button
    class="log-row"
    class:clickable={true}
    class:has-tip={true}
    type="button"
    onclick={handleClick}
    onkeydown={handleKeyDown}
    data-tip="Double-click to open details"
    aria-label="Double-click to open details"
  >
    {@render rowContent()}
  </button>
{:else}
  <div class="log-row" class:clickable={false} class:has-tip={false}>
    {@render rowContent()}
  </div>
{/if}

<style>
  .log-row {
    display: grid;
    grid-template-columns: 86px 64px 1fr;
    gap: 8px;
    align-items: start;
    width: 100%;
    margin: 0;
    border: 0;
    background: transparent;
    text-align: left;
    font: inherit;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 0.75rem;
    color: var(--c-text-1);
    padding: 6px 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--c-border) 35%, transparent);
  }

  .log-row:focus-visible {
    outline: 1px solid color-mix(in srgb, var(--c-accent) 60%, var(--c-border));
    outline-offset: -1px;
  }

  .time {
    color: var(--c-text-2);
  }

  .level {
    text-align: center;
    border-radius: 6px;
    padding: 2px 0;
    border: 1px solid var(--c-border);
    color: var(--c-text-1);
    background: color-mix(in srgb, var(--c-surface-3) 72%, var(--c-surface-2));
  }

  .level.info {
    color: var(--c-accent);
    border-color: color-mix(in srgb, var(--c-accent) 30%, var(--c-border));
  }

  .level.warn {
    color: var(--c-warn);
    border-color: color-mix(in srgb, var(--c-warn) 30%, var(--c-border));
  }

  .level.error {
    color: var(--c-error);
    border-color: color-mix(in srgb, var(--c-error) 30%, var(--c-border));
  }

  .level.traffic {
    color: var(--c-text-1);
    border-color: color-mix(in srgb, var(--c-accent) 34%, var(--c-border));
    background: color-mix(in srgb, var(--c-accent) 10%, var(--c-surface-3));
  }

  .clickable {
    cursor: pointer;
  }

  .clickable:hover {
    background: color-mix(in srgb, var(--c-surface-3) 40%, transparent);
  }

  .message {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.45;
  }

  .traffic-compact {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    line-height: 1;
    white-space: normal;
  }

  .traffic-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 7px;
    border-radius: 999px;
    border: 1px solid var(--c-border);
    background: color-mix(in srgb, var(--c-surface-3) 62%, var(--c-surface-2));
    font-size: 0.68rem;
    color: var(--c-text-1);
  }

  .traffic-chip.dir.tx {
    border-color: color-mix(in srgb, var(--c-accent) 35%, var(--c-border));
  }

  .traffic-chip.dir.rx {
    border-color: color-mix(in srgb, var(--c-ok) 35%, var(--c-border));
  }

  .traffic-chip.txn {
    color: var(--c-text-2);
  }

  .traffic-chip.warn {
    color: var(--c-warn);
    border-color: color-mix(in srgb, var(--c-warn) 35%, var(--c-border));
  }
</style>
