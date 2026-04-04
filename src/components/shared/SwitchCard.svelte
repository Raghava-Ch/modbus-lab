<svelte:options runes={true} />

<script lang="ts">
  import { RefreshCw, Zap, Pencil, Check, X } from "lucide-svelte";
  import ToggleSwitch from "./ToggleSwitch.svelte";

  export type SwitchCardStatusVariant = "pending" | "failed";

  let {
    address,
    label,
    pending,
    readValue,
    toggleValue,
    connected,
    cardDirty = false,
    editingAddress,
    editLabelVal,
    addrFmt,
    onBeginEdit,
    onCommitEdit,
    onCancelEdit,
    onLabelKeydown,
    onEditLabelValChange,
    onToggle,
    onRead,
    onWrite,
    onDelete,
    statusBadgeText = null,
    statusBadgeTitle = undefined,
    statusBadgeVariant = "pending" as SwitchCardStatusVariant,
    readButtonTitle,
    writeButtonTitle,
    deleteButtonTitle = "Delete",
  } = $props<{
    address: number;
    label: string;
    pending: boolean;
    readValue: boolean;
    toggleValue: boolean;
    connected: boolean;
    cardDirty?: boolean;
    editingAddress: number | null;
    editLabelVal: string;
    addrFmt: (n: number) => string;
    onBeginEdit: (address: number, current: string) => void;
    onCommitEdit: () => void;
    onCancelEdit: () => void;
    onLabelKeydown: (e: KeyboardEvent) => void;
    onEditLabelValChange: (next: string) => void;
    onToggle: ((address: number) => void) | undefined;
    onRead: (address: number) => void;
    onWrite?: (address: number) => void;
    onDelete: (address: number) => void;
    statusBadgeText?: string | null;
    statusBadgeTitle?: string;
    statusBadgeVariant?: SwitchCardStatusVariant;
    readButtonTitle?: string;
    writeButtonTitle?: string;
    deleteButtonTitle?: string;
  }>();

  const effectiveReadTitle = $derived(readButtonTitle ?? (connected ? "Read from device" : "Connect to device first"));
  const effectiveWriteTitle = $derived(writeButtonTitle ?? (connected ? "Write value" : "Connect to device first"));
</script>

<div
  class="switch-card"
  class:card-on={readValue}
  class:card-pending={pending}
  class:card-dirty={cardDirty}
>
  <div class="card-label-wrap">
    {#if editingAddress === address}
      <input
        class="card-label-input"
        type="text"
        value={editLabelVal}
        oninput={(e) => { onEditLabelValChange(e.currentTarget.value); }}
        onblur={onCommitEdit}
        onkeydown={onLabelKeydown}
      />
      <button class="icon-micro has-tip" type="button" onclick={onCommitEdit} data-tip="Save">
        <Check size={11} />
      </button>
      <button class="icon-micro has-tip" type="button" onclick={onCancelEdit} data-tip="Cancel">
        <X size={11} />
      </button>
    {:else}
    <button
      class="icon-micro card-label-edit has-tip"
      type="button"
      onclick={() => onBeginEdit(address, label)}
      data-tip="Edit label"
    >
      <Pencil size={10} />
    </button>
      <div class="card-label" class:card-label-empty={!label}>{label || "-"}</div>

      <button
      class="delete-mini has-tip"
      type="button"
      onclick={() => onDelete(address)}
      data-tip={deleteButtonTitle}
    >
      <X size={11} />
    </button>
    {/if}
  </div>

  <div class="card-meta">
    <div class="card-addr">{addrFmt(address)}</div>

    <div class="card-inline-status-slot">
      {#if statusBadgeText}
        <span
          class="dirty-indicator card-inline-status has-tip"
          class:failed-indicator={statusBadgeVariant === "failed"}
          data-tip={statusBadgeTitle}
        >
          {statusBadgeText}
        </span>
      {/if}
    </div>
  </div>

  <div class="card-status-row">
    <span class="badge" class:badge-live-on={readValue} class:badge-live-off={!readValue}>
      {readValue ? "ON" : "OFF"}
    </span>
    {#if onToggle != undefined}
    <div class="card-toggle-wrap">
      <ToggleSwitch
        checked={toggleValue}
        title="Toggle value"
        onToggle={() => onToggle?.(address)}
      />
    </div>
    {/if}
  </div>

  <div class="card-actions" class:card-actions-two={onToggle != undefined}>
    <button
      class="read-mini has-tip"
      type="button"
      disabled={!connected}
      onclick={() => onRead(address)}
      data-tip={effectiveReadTitle}
    >
      <RefreshCw size={11} />
      Read
    </button>

    {#if onToggle != undefined}
      <button
        class="write-mini has-tip"
        type="button"
        disabled={!connected}
        onclick={() => onWrite?.(address)}
        data-tip={effectiveWriteTitle}
      >
        <Zap size={11} />
        Write
      </button>
    {/if}
  </div>
</div>

<style>
  .switch-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    position: relative;
    padding: 12px 10px 10px;
    border: 1px solid color-mix(in srgb, var(--c-border-strong) 48%, var(--c-border));
    border-radius: 10px;
    background: var(--c-surface-2);
    transition: all 160ms ease;
    font: inherit;
    text-align: left;
  }

  .switch-card:hover {
    border-color: var(--c-border-strong);
    background: var(--c-surface-3);
  }

  .switch-card.card-on {
    border-color: color-mix(in srgb, var(--c-ok) 45%, var(--c-border));
    background: color-mix(in srgb, var(--c-ok) 7%, var(--c-surface-1));
  }

  .switch-card.card-dirty {
    border-color: color-mix(in srgb, var(--c-warn) 40%, var(--c-border));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-warn) 22%, transparent);
  }

  .switch-card.card-pending {
    opacity: 0.65;
  }

  .card-addr {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    font-family: monospace;
    font-size: 0.9rem;
    color: var(--c-text-2);
    text-align: left;
    line-height: 1;
  }

  .card-inline-status-slot {
    height: 25px;
  }

  .card-label {
    font-size: 0.8rem;
    color: var(--c-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
    line-height: 24px;
  }

  .card-label-wrap {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    min-height: 24px;
  }

  .card-label-input {
    flex: 1;
    min-width: 0;
    height: 24px;
    padding: 0 6px;
    border: 1px solid var(--c-accent);
    border-radius: 4px;
    background: var(--c-surface-2);
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.72rem;
    outline: none;
  }

  .card-label-edit {
    opacity: 0.8;
  }

  .card-label-empty {
    opacity: 0.45;
  }

  .card-status-row {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-height: 28px;
  }

  .card-toggle-wrap {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    min-height: auto;
  }

  .card-actions {
    margin-top: 2px;
    display: grid;
    grid-template-columns: 1fr;
    align-items: center;
    gap: 6px;
    width: 100%;
    flex-wrap: nowrap;
  }

  .card-actions.card-actions-two {
    grid-template-columns: 1fr 1fr;
  }

  .card-actions .read-mini,
  .card-actions .write-mini {
    min-width: auto;
    justify-content: center;
    padding: 6px;
  }

  .card-meta {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-height: 26px;
    border-top: 1px solid color-mix(in srgb, var(--c-border) 45%, transparent);
    padding-top: 6px;
  }

  .card-inline-status {
    height: 18px;
    padding: 0 6px;
    font-size: 0.6rem;
    letter-spacing: 0.03em;
    flex-shrink: 0;
  }

  .icon-micro {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--c-text-2);
    cursor: pointer;
    flex-shrink: 0;
    transition: color 100ms;
  }

  .icon-micro:hover {
    color: var(--c-text-1);
  }

  .badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 18px;
    min-width: 34px;
    border-radius: 9px;
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.04em;
  }

  .badge-live-on {
    background: color-mix(in srgb, var(--c-ok) 20%, var(--c-surface-3));
    color: var(--c-ok);
  }

  .badge-live-off {
    background: color-mix(in srgb, var(--c-text-2) 12%, var(--c-surface-3));
    color: var(--c-text-2);
    opacity: 0.8;
  }

  .dirty-indicator {
    display: inline-flex;
    align-items: center;
    height: 20px;
    padding: 0 7px;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--c-warn) 36%, var(--c-border));
    background: color-mix(in srgb, var(--c-warn) 12%, var(--c-surface-2));
    color: var(--c-warn);
    font-size: 0.62rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .failed-indicator {
    border-color: color-mix(in srgb, var(--c-error, #cf4b4b) 62%, var(--c-border));
    background: color-mix(in srgb, var(--c-error, #cf4b4b) 18%, var(--c-surface-2));
    color: color-mix(in srgb, var(--c-error, #cf4b4b) 90%, #8f1f1f);
  }

  .write-mini,
  .read-mini {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 8px;
    border-radius: 6px;
    font: inherit;
    font-size: 0.66rem;
    cursor: pointer;
    white-space: nowrap;
    transition: all 120ms ease;
  }

  .write-mini {
    border: 1px solid color-mix(in srgb, var(--c-accent) 30%, var(--c-border));
    background: color-mix(in srgb, var(--c-accent) 12%, var(--c-surface-2));
    color: var(--c-accent);
  }

  .write-mini:hover {
    border-color: var(--c-accent);
    color: var(--c-text-1);
  }

  .write-mini:disabled,
  .read-mini:disabled,
  .delete-mini:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .read-mini {
    border: 1px solid color-mix(in srgb, var(--c-text-2) 30%, var(--c-border));
    background: color-mix(in srgb, var(--c-text-2) 8%, var(--c-surface-2));
    color: var(--c-text-2);
  }

  .read-mini:hover {
    border-color: var(--c-border-strong);
    color: var(--c-text-1);
  }

  .delete-mini {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: 1px solid color-mix(in srgb, var(--c-error) 30%, var(--c-border));
    border-radius: 6px;
    background: color-mix(in srgb, var(--c-error) 10%, var(--c-surface-2));
    color: var(--c-error);
    font: inherit;
    cursor: pointer;
    transition: all 120ms ease;
  }

  .delete-mini:hover {
    border-color: var(--c-error);
    color: var(--c-text-1);
  }

  @media (max-width: 760px) {
    .switch-card {
      width: 100%;
      align-items: stretch;
    }

    .card-toggle-wrap {
      justify-content: center;
    }

    .card-actions {
      grid-template-columns: 1fr 1fr auto;
    }

    .card-actions .write-mini,
    .card-actions .read-mini {
      width: 100%;
      justify-content: center;
    }
  }
</style>