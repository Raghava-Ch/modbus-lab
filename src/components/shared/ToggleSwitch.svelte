<svelte:options runes={true} />

<script lang="ts">
  type ToggleSwitchSize = "sm" | "md";

  let {
    checked = false,
    disabled = false,
    size = "md" as ToggleSwitchSize,
    title,
    onToggle,
  } = $props<{
    checked?: boolean;
    disabled?: boolean;
    size?: ToggleSwitchSize;
    title?: string;
    onToggle?: () => void;
  }>();

  function handleClick(): void {
    if (disabled) return;
    onToggle?.();
  }
</script>

<button
  class="toggle-switch has-tip"
  class:checked
  class:disabled
  class:size-sm={size === "sm"}
  class:size-md={size === "md"}
  type="button"
  data-tip={title}
  aria-pressed={checked}
  aria-label={title}
  disabled={disabled}
  onclick={handleClick}
>
  <span class="thumb"></span>
</button>

<style>
  .toggle-switch {
    --track-width: 46px;
    --track-height: 26px;
    --track-radius: 13px;
    --track-padding: 3px;
    --thumb-size: 18px;
    --thumb-shift: 20px;
    position: relative;
    width: var(--track-width);
    height: var(--track-height);
    padding: 0;
    border: 1px solid var(--c-border);
    border-radius: var(--track-radius);
    background: var(--c-surface-3);
    cursor: pointer;
    transition: background 180ms, border-color 180ms, opacity 120ms;
    flex-shrink: 0;
  }

  .toggle-switch.size-sm {
    --track-width: 32px;
    --track-height: 17px;
    --track-radius: 9px;
    --track-padding: 2px;
    --thumb-size: 11px;
    --thumb-shift: 15px;
  }

  .toggle-switch.checked {
    background: color-mix(in srgb, var(--c-ok) 35%, var(--c-surface-2));
    border-color: var(--c-ok);
  }

  .toggle-switch.disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .thumb {
    position: absolute;
    top: var(--track-padding);
    left: var(--track-padding);
    width: var(--thumb-size);
    height: var(--thumb-size);
    border-radius: 50%;
    background: var(--c-text-2);
    transition: transform 180ms, background 180ms;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
  }

  .toggle-switch.checked .thumb {
    transform: translateX(var(--thumb-shift));
    background: var(--c-ok);
  }
</style>
