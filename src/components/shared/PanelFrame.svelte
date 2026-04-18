<svelte:options runes={true} />

<script lang="ts">
  import type { Snippet } from "svelte";

  let { children, footer } = $props<{ children?: Snippet; footer?: Snippet }>();
</script>

<section class="panel-frame">
  <div class="body">{@render children?.()}</div>
  {#if footer}
    <footer class="footer">{@render footer()}</footer>
  {/if}
</section>

<style>
  .panel-frame {
    border: 1px solid var(--c-border);
    background: var(--c-surface-1);
    border-radius: 12px;
    overflow: visible;
  }

  .body {
    padding: 14px;
  }

  .footer {
    border-top: 1px solid var(--c-border);
    padding: 10px 14px;
    background: var(--c-surface-2);
  }
</style>
