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
    statusBadgeText = null,
    statusBadgeTitle = undefined,
    statusBadgeVariant = "pending" as "pending" | "failed",
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
    statusBadgeText?: string | null;
    statusBadgeTitle?: string;
    statusBadgeVariant?: "pending" | "failed";
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
    <div class="card-inline-status-slot">
      <span
        class="dirty-indicator card-inline-status has-tip"
        class:failed-indicator={statusBadgeVariant === "failed"}
        class:badge-hidden={!statusBadgeText}
        data-tip={statusBadgeText ? statusBadgeTitle : undefined}
      >{statusBadgeText ?? ""}</span>
    </div>
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
  .register-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    width: 100%;
    box-sizing: border-box;
    position: relative;
    padding: 12px 10px 10px;
    border: 1px solid color-mix(in srgb, var(--c-border-strong) 48%, var(--c-border));
    border-radius: 10px;
    background: var(--c-surface-2);
    transition: border-color 160ms ease, background-color 160ms ease, box-shadow 160ms ease, opacity 160ms ease;
    font: inherit;
    text-align: left;
  }

  .register-card:hover {
    border-color: var(--c-border-strong);
    background: var(--c-surface-3);
  }

  .register-card.card-dirty {
    border-color: color-mix(in srgb, var(--c-warn) 40%, var(--c-border));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-warn) 22%, transparent);
  }

  .register-card.card-pending {
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

  .card-label-empty {
    opacity: 0.45;
  }

  .values-row {
    width: 100%;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }

  .value-box {
    display: grid;
    gap: 3px;
  }

  .value-label {
    font-size: 0.64rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--c-text-2);
  }

  .value-number {
    height: 26px;
    display: inline-flex;
    align-items: center;
    padding: 0 8px;
    border: 1px solid var(--c-border);
    border-radius: 6px;
    background: var(--c-surface-3);
    color: var(--c-text-1);
    font-family: monospace;
    font-size: 0.76rem;
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

  .badge-hidden {
    visibility: hidden;
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
    justify-content: center;
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
    .register-card {
      width: 100%;
      align-items: stretch;
    }
  }
</style>
