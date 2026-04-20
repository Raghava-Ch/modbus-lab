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
  /* ── switch-card: ON state (unique to coil/discrete) ── */
  .switch-card {
    width: 100%;
    box-sizing: border-box;
  }

  .switch-card.card-on {
    border-color: color-mix(in srgb, var(--c-ok) 45%, var(--c-border));
    background: color-mix(in srgb, var(--c-ok) 7%, var(--c-surface-1));
  }

  .card-label-edit {
    opacity: 0.8;
  }

  /* ── switch-card layout (status row + toggle + actions) ── */
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

  @media (max-width: 760px) {
    .switch-card {
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