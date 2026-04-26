<svelte:options runes={true} />

<script lang="ts">
  import { RefreshCw, Zap, Pencil, Check, X } from "lucide-svelte";

  let {
    address,
    label,
    pending,
    slaveValue,
    desiredValue,
    connected,
    cardDirty = false,
    editingAddress,
    editLabelVal,
    addrFmt,
    valueFmt,
    onBeginEdit,
    onCommitEdit,
    onCancelEdit,
    onLabelKeydown,
    onEditLabelValChange,
    onDesiredChange,
    onRead,
    onWrite,
    onDelete,
  } = $props<{
    address: number;
    label: string;
    pending: boolean;
    slaveValue: number;
    desiredValue: number;
    connected: boolean;
    cardDirty?: boolean;
    editingAddress: number | null;
    editLabelVal: string;
    addrFmt: (n: number) => string;
    valueFmt: (n: number) => string;
    onBeginEdit: (address: number, current: string) => void;
    onCommitEdit: () => void;
    onCancelEdit: () => void;
    onLabelKeydown: (e: KeyboardEvent) => void;
    onEditLabelValChange: (next: string) => void;
    onDesiredChange: (address: number, value: number) => void;
    onRead: (address: number) => void;
    onWrite: (address: number) => void;
    onDelete: (address: number) => void;
  }>();
</script>

<div class="register-card" class:card-pending={pending} class:card-dirty={cardDirty}>
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
  </div>

  <div class="values-row">
    <div class="value-box">
      <div class="value-label">Read</div>
      <div class="value-number">{valueFmt(slaveValue)}</div>
    </div>
    <div class="value-box">
      <div class="value-label">Desired</div>
      <input
        class="value-input"
        type="number"
        min="0"
        max="65535"
        value={desiredValue}
        oninput={(e) => onDesiredChange(address, Number(e.currentTarget.value))}
      />
    </div>
  </div>

  <div class="card-actions">
    <button class="read-mini has-tip" type="button" disabled={!connected} onclick={() => onRead(address)} data-tip={connected ? "Read from device" : "Connect to device first"}>
      <RefreshCw size={11} />
      Read
    </button>
    <button class="write-mini has-tip" type="button" disabled={!connected} onclick={() => onWrite(address)} data-tip={connected ? "Write register" : "Connect to device first"}>
      <Zap size={11} />
      Write
    </button>
  </div>
</div>

<style>
  /* ── Unique: 2-col values grid + desired input ── */
  .values-row {
    width: 100%;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .value-input {
    height: 26px;
    padding: 0 8px;
    border: 1px solid var(--c-border);
    border-radius: 6px;
    background: var(--c-surface-2);
    color: var(--c-text-1);
    font: inherit;
    font-family: monospace;
    font-size: 0.76rem;
  }

  .value-input:focus {
    outline: none;
    border-color: var(--c-accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--c-accent) 14%, transparent);
  }

  .card-actions {
    margin-top: 2px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    align-items: center;
    gap: 6px;
    width: 100%;
  }
</style>
