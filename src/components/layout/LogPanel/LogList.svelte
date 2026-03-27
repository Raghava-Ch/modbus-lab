<svelte:options runes={true} />

<script lang="ts">
  import type { LogEntry as Entry } from "../../../state/logs.svelte";
  import LogRow from "./LogRow.svelte";

  let { entries } = $props<{ entries: Entry[] }>();
  let listEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    entries.length;
    if (listEl) {
      listEl.scrollTop = listEl.scrollHeight;
    }
  });
</script>

<div class="log-list" bind:this={listEl}>
  {#if entries.length === 0}
    <p class="empty">No log events yet.</p>
  {:else}
    {#each entries as entry (entry.id)}
      <LogRow {entry} />
    {/each}
  {/if}
</div>

<style>
  .log-list {
    overflow: auto;
    min-height: 0;
  }

  .empty {
    margin: 0;
    color: var(--c-text-2);
    font-size: 0.8rem;
    padding: 12px;
  }
</style>
