<svelte:options runes={true} />

<script lang="ts">
  import { X } from "lucide-svelte";
  import { dismissNotification, notificationState } from "../../state/notifications.svelte";
</script>

<div class="notice-stack" aria-live="polite" aria-atomic="true">
  {#each notificationState.entries as entry (entry.id)}
    <div class={`notice notice-${entry.level}`} role="status">
      <div class="notice-message">{entry.message}</div>
      <button
        type="button"
        class="notice-close"
        aria-label="Dismiss notification"
        onclick={() => dismissNotification(entry.id)}
      >
        <X size={14} />
      </button>
    </div>
  {/each}
</div>

<style>
  .notice-stack {
    position: fixed;
    right: 14px;
    top: 56px;
    display: grid;
    gap: 8px;
    width: min(460px, calc(100vw - 28px));
    z-index: 80;
    pointer-events: none;
  }

  .notice {
    pointer-events: auto;
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: start;
    gap: 10px;
    border: 1px solid var(--c-border);
    border-left-width: 3px;
    border-radius: 10px;
    padding: 10px 10px 10px 12px;
    background: color-mix(in srgb, var(--c-surface-1) 92%, black);
    color: var(--c-text-1);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.28);
    animation: notice-in 130ms ease-out;
  }

  .notice-warn {
    border-left-color: #f0b429;
  }

  .notice-error {
    border-left-color: #ff6b6b;
  }

  .notice-info {
    border-left-color: var(--c-accent);
  }

  .notice-message {
    font-size: 0.92rem;
    line-height: 1.3;
  }

  .notice-close {
    width: 24px;
    height: 24px;
    border-radius: 7px;
    border: 1px solid var(--c-border);
    background: transparent;
    color: var(--c-text-2);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  .notice-close:hover {
    color: var(--c-text-1);
    border-color: color-mix(in srgb, var(--c-accent) 50%, var(--c-border));
  }

  @keyframes notice-in {
    from {
      opacity: 0;
      transform: translateY(-6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (max-width: 767px) {
    .notice-stack {
      top: 50px;
      right: 10px;
      width: calc(100vw - 20px);
    }
  }
</style>
