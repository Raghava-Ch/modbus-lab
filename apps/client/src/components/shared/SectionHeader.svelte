<svelte:options runes={true} />

<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    subtitle,
    actions,
  } = $props<{
    title: string;
    subtitle?: string;
    actions?: Snippet;
  }>();
</script>

<header class="section-header">
  <div>
    <h2>{title}</h2>
    {#if subtitle}
      <p>{subtitle}</p>
    {/if}
  </div>

  {#if actions}
    <div class="actions">{@render actions()}</div>
  {/if}
</header>

<style>
  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  h2 {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 600;
  }

  p {
    margin: 2px 0 0;
    color: var(--c-text-2);
    font-size: 0.82rem;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
</style>
