<svelte:options runes={true} />

<script lang="ts">
  import type { LogEntry } from "../../../state/logs.svelte";
  import { formatLogTimestamp } from "../../../state/settings.svelte";

  let { entry, onopen } = $props<{ entry: LogEntry; onopen?: (entry: LogEntry) => void }>();

  // For traffic rows, condense the verbose adu=... message down to a compact
  // summary: direction + function name + raw frame bytes. The full message is
  // still kept on the entry and shown in the detail modal on double-click.
  function trafficCompact(message: string): string {
    // Strip [TOPIC] prefix added by AppShell (e.g. "[NETWORK] "), then grab first token
    const withoutTopic = message.replace(/^\[.*?\]\s*/, "");
    const dirLabel = withoutTopic.match(/^(\S+)/)?.[1] ?? "tcp";
    // FC human name from e.g. fc=0x03(ReadHoldingRegisters)
    const fcName = message.match(/\bfc=\S+\(([^)]+)\)/)?.[1] ?? "";
    // Reason for invalid frames (e.g. reason=short)
    const reason = message.match(/\breason=(\S+)/)?.[1] ?? "";
    // Raw bytes — use * so empty bytes= still gives "" instead of no-match
    const bytesRaw = (message.match(/\bbytes=([0-9A-F ]*)$/i)?.[1] ?? "").trim();
    const parts: string[] = [dirLabel];
    if (fcName) parts.push(fcName);
    else if (reason) parts.push(`invalid(${reason})`);
    if (bytesRaw) parts.push(`[${bytesRaw}]`);
    return parts.join("  ");
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

  const displayMessage = $derived(
    entry.level === "traffic" ? trafficCompact(entry.message) : entry.message,
  );
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="log-row"
  class:clickable={!!onopen}
  class:has-tip={!!onopen}
  onclick={handleClick}
  onkeydown={handleKeyDown}
  role={onopen ? "button" : undefined}
  tabindex={onopen ? 0 : undefined}
  data-tip={onopen ? "Double-click to open details" : undefined}
  aria-label={onopen ? "Double-click to open details" : undefined}
>
  <span class="time">{formatLogTimestamp(entry.timestamp)}</span>
  <span class={`level ${entry.level}`}>{entry.level.toUpperCase()}</span>
  <span class="message">{displayMessage}</span>
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
</style>
