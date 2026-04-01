<svelte:options runes={true} />

<script lang="ts">
  import type { LogEntry } from "../../../state/logs.svelte";
  import { formatLogTimestamp } from "../../../state/settings.svelte";

  let { entry } = $props<{ entry: LogEntry }>();
</script>

<div class="log-row">
  <span class="time">{formatLogTimestamp(entry.timestamp)}</span>
  <span class={`level ${entry.level}`}>{entry.level.toUpperCase()}</span>
  <span class="message" title={entry.message}>{entry.message}</span>
</div>

<style>
  .log-row {
    display: grid;
    grid-template-columns: 86px 64px 1fr;
    gap: 8px;
    align-items: start;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 0.75rem;
    color: var(--c-text-1);
    padding: 6px 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--c-border) 60%, transparent);
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

  .message {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.45;
  }
</style>
