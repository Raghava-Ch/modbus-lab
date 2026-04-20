<svelte:options runes={true} />

<script lang="ts">
  import { RefreshCw, Pencil, Check, X } from "lucide-svelte";

  let {
    address,
    label,
    pending,
    value,
    connected,
    editingAddress,
    editLabelVal,
    addrFmt,
    valueFmt,
    onBeginEdit,
    onCommitEdit,
    onCancelEdit,
    onLabelKeydown,
    onEditLabelValChange,
    onRead,
    onDelete,
    statusBadgeText = null,
    statusBadgeTitle = undefined,
  } = $props<{
    address: number;
    label: string;
    pending: boolean;
    value: number;
    connected: boolean;
    editingAddress: number | null;
    editLabelVal: string;
    addrFmt: (n: number) => string;
    valueFmt: (n: number) => string;
    onBeginEdit: (address: number, current: string) => void;
    onCommitEdit: () => void;
    onCancelEdit: () => void;
    onLabelKeydown: (e: KeyboardEvent) => void;
    onEditLabelValChange: (next: string) => void;
    onRead: (address: number) => void;
    onDelete: (address: number) => void;
    statusBadgeText?: string | null;
    statusBadgeTitle?: string;
  }>();
</script>

<div class="register-card" class:card-pending={pending}>
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
      <button class="icon-micro has-tip" type="button" onclick={onCommitEdit} data-tip="Save"><Check size={11} /></button>
      <button class="icon-micro has-tip" type="button" onclick={onCancelEdit} data-tip="Cancel"><X size={11} /></button>
    {:else}
      <button class="icon-micro card-label-edit has-tip" type="button" onclick={() => onBeginEdit(address, label)} data-tip="Edit label">
        <Pencil size={10} />
      </button>
      <div class="card-label" class:card-label-empty={!label}>{label || "-"}</div>
      <button class="delete-mini has-tip" type="button" onclick={() => onDelete(address)} data-tip="Delete register">
        <X size={11} />
      </button>
    {/if}
  </div>

  <div class="card-meta">
    <div class="card-addr">{addrFmt(address)}</div>
    <div class="card-inline-status-slot">
      {#if statusBadgeText}
        <span class="dirty-indicator card-inline-status failed-indicator has-tip" data-tip={statusBadgeTitle}>
          {statusBadgeText}
        </span>
      {/if}
    </div>
  </div>

  <div class="values-row">
    <div class="value-box">
      <div class="value-label">Value</div>
      <div class="value-number">{valueFmt(value)}</div>
    </div>
  </div>

  <div class="card-actions">
    <button
      class="read-mini has-tip"
      type="button"
      disabled={!connected}
      onclick={() => onRead(address)}
      data-tip={connected ? "Read from device" : "Connect to device first"}
    >
      <RefreshCw size={11} />
      Read
    </button>
  </div>
</div>

<style>
  /* ── Unique: 1-col values grid + full-width read button ── */
  .values-row {
    width: 100%;
    display: grid;
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .card-actions {
    margin-top: 2px;
    width: 100%;
  }

  .read-mini {
    width: 100%;
    justify-content: center;
  }
</style>
