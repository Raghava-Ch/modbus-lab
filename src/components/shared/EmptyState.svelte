<svelte:options runes={true} />

<script lang="ts">
  let {
    title = "Coming Soon",
    message = "This tab is prepared for next phase implementation.",
  } = $props<{ title?: string; message?: string }>();
</script>

<div class="empty-state">
  <h3>{title}</h3>
  <p>{message}</p>
</div>

<style>
  .empty-state {
    min-height: 180px;
    border: 1px dashed var(--c-border);
    border-radius: 12px;
    background: var(--c-surface-2);
    display: grid;
    place-items: center;
    text-align: center;
    padding: 18px;
  }

  h3 {
    margin: 0;
    font-size: 1rem;
  }

  p {
    margin: 8px 0 0;
    color: var(--c-text-2);
    max-width: 56ch;
  }
</style>
