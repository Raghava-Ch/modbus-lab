<svelte:options runes={true} />

<script lang="ts">
  import type { LogEntry as Entry } from "../../../state/logs.svelte";
  import LogRow from "./LogRow.svelte";

  let { entries, onopen } = $props<{ entries: Entry[]; onopen?: (entry: Entry) => void }>();

  // Estimated row height: padding 6px top + 6px bottom + ~17px text + 1px border = ~30px.
  // Slight inaccuracy only affects spacer sizes, never correctness or interactivity.
  const ROW_H = 32;
  // Extra rows rendered above and below the visible window to absorb fast scrolling.
  const OVERSCAN = 8;

  let listEl = $state<HTMLElement | null>(null);
  let scrollTop = $state(0);
  let containerH = $state(300);
  // When true, viewport snaps to the bottom whenever new entries arrive.
  let pinned = $state(true);

  const totalH = $derived(entries.length * ROW_H);
  const startIdx = $derived(Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN));
  const endIdx = $derived(
    Math.min(entries.length, Math.ceil((scrollTop + containerH) / ROW_H) + OVERSCAN),
  );
  const visible = $derived(entries.slice(startIdx, endIdx));
  const topPad = $derived(startIdx * ROW_H);
  const bottomPad = $derived(Math.max(0, totalH - endIdx * ROW_H));

  function handleScroll(e: Event): void {
    const el = e.currentTarget as HTMLElement;
    scrollTop = el.scrollTop;
    // Treat as pinned when within 2 rows of the very bottom.
    pinned = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_H * 2;
  }

  // Auto-scroll to bottom whenever entries grow and the viewport is pinned.
  $effect(() => {
    void entries.length;
    if (pinned && listEl) {
      listEl.scrollTop = listEl.scrollHeight;
    }
  });

  // Keep containerH in sync with the panel's user-resizable height.
  $effect(() => {
    if (!listEl) return;
    containerH = listEl.clientHeight;
    const ro = new ResizeObserver(() => {
      containerH = listEl!.clientHeight;
    });
    ro.observe(listEl);
    return () => ro.disconnect();
  });
</script>

<div class="log-list" bind:this={listEl} onscroll={handleScroll}>
  {#if entries.length === 0}
    <p class="empty">No log events yet.</p>
  {:else}
    {#if topPad > 0}
      <div aria-hidden="true" style:height="{topPad}px"></div>
    {/if}
    {#each visible as entry (entry.id)}
      <LogRow {entry} {onopen} />
    {/each}
    {#if bottomPad > 0}
      <div aria-hidden="true" style:height="{bottomPad}px"></div>
    {/if}
  {/if}
</div>

<style>
  .log-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .empty {
    margin: 0;
    color: var(--c-text-2);
    font-size: 0.8rem;
    padding: 12px;
  }
</style>

