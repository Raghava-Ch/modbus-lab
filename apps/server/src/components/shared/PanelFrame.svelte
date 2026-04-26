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
    border: 1px solid var(--c-border-strong);
    /* background: var(--c-surface-1); */
    box-shadow: rgb(0, 0, 0) 0px 0px 9px 3px, var(--c-border) 0px 0px 8px 3px;
    border-radius: 12px;
    overflow: hidden;
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
