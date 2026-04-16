<svelte:options runes={true} />

<script lang="ts">
  import { RefreshCw, Zap, Pencil, Check, X } from "lucide-svelte";

  export type RegisterRowEntry = {
    address: number;
    slaveValue: number;
    desiredValue: number;
    pending: boolean;
    readError: string | null;
    writeError: string | null;
    label: string;
  };

  let {
    entry,
    connected,
    editingAddress,
    editLabelVal,
    addrFmt,
    valueFmt,
    beginEdit,
    commitEdit,
    cancelEdit,
    onLabelKeydown,
    onEditLabelValChange,
    onDesiredChange,
    onRead,
    onWrite,
    onDelete,
  } = $props<{
    entry: RegisterRowEntry;
    connected: boolean;
    editingAddress: number | null;
    editLabelVal: string;
    addrFmt: (n: number) => string;
    valueFmt: (n: number) => string;
    beginEdit: (address: number, current: string) => void;
    commitEdit: () => void;
    cancelEdit: () => void;
    onLabelKeydown: (e: KeyboardEvent) => void;
    onEditLabelValChange: (next: string) => void;
    onDesiredChange: (address: number, value: number) => void;
    onRead: (address: number) => void;
    onWrite: (address: number) => void;
    onDelete: (address: number) => void;
  }>();
</script>

<div class="rt-row" class:row-pending={entry.pending}>
  <span class="label-cell">
    {#if editingAddress === entry.address}
      <input
        class="label-input"
        type="text"
        value={editLabelVal}
        oninput={(e) => { onEditLabelValChange(e.currentTarget.value); }}
        onblur={commitEdit}
        onkeydown={onLabelKeydown}
      />
      <button class="icon-micro has-tip" type="button" onclick={commitEdit} data-tip="Save">
        <Check size={11} />
      </button>
      <button class="icon-micro has-tip" type="button" onclick={cancelEdit} data-tip="Cancel">
        <X size={11} />
      </button>
    {:else}
      <span
        class="cell-label has-tip"
        class:label-empty={!entry.label}
        role="button"
        tabindex="0"
        onclick={() => beginEdit(entry.address, entry.label)}
        onkeydown={(e) => { if (e.key === "Enter") beginEdit(entry.address, entry.label); }}
        data-tip="Click to edit label"
      >
        {entry.label || "-"}
      </span>
      <button
        class="icon-micro edit-trigger has-tip"
        type="button"
        onclick={() => beginEdit(entry.address, entry.label)}
        data-tip="Edit label"
      >
        <Pencil size={10} />
      </button>
    {/if}
  </span>

  <span class="pending-cell">
    {#if entry.readError || entry.writeError || entry.desiredValue !== entry.slaveValue}
      {#if entry.readError}
        <span class="dirty-indicator failed-indicator has-tip" data-tip={entry.readError}>Not avail</span>
      {:else if entry.writeError}
        <span class="dirty-indicator failed-indicator has-tip" data-tip={entry.writeError}>Not avail</span>
      {:else}
        <span class="dirty-indicator has-tip" data-tip="Local value differs from device">Unsynced</span>
      {/if}
    {/if}
  </span>

  <span class="addr-cell">{addrFmt(entry.address)}</span>
  <span class="value-cell">{valueFmt(entry.slaveValue)}</span>

  <span class="desired-cell">
    <input
      class="value-input"
      type="number"
      min="0"
      max="65535"
      value={entry.desiredValue}
      oninput={(e) => onDesiredChange(entry.address, Number(e.currentTarget.value))}
    />
  </span>

  <span class="operation-cell">
    <button
      class="read-mini has-tip"
      type="button"
      disabled={!connected}
      onclick={() => onRead(entry.address)}
      data-tip={connected ? "Read from device" : "Connect to device first"}
    >
      <RefreshCw size={11} />
      Read
    </button>
    <button
      class="write-mini has-tip"
      type="button"
      disabled={!connected}
      onclick={() => onWrite(entry.address)}
      data-tip={connected ? "Write register" : "Connect to device first"}
    >
      <Zap size={11} />
      Write
    </button>
  </span>

  <span class="delete-cell">
    <button class="delete-mini has-tip" type="button" onclick={() => onDelete(entry.address)} data-tip="Delete register">
      <X size={11} />
    </button>
  </span>
</div>

<style>
  .rt-row {
    display: grid;
    grid-template-columns: minmax(140px, 1fr) 92px 64px 88px 110px 182px 52px;
    align-items: center;
    gap: 0;
    min-width: 730px;
    border-bottom: 1px solid color-mix(in srgb, var(--c-border) 40%, transparent);
    min-height: 34px;
    transition: background 100ms;
  }

  .rt-row > span {
    padding: 0 4px;
  }

  .rt-row:last-child {
    border-bottom: none;
  }

  .rt-row:nth-child(even) {
    background: color-mix(in srgb, var(--c-surface-2) 52%, transparent);
  }

  .rt-row:hover {
    background: color-mix(in srgb, var(--c-surface-3) 52%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-border) 52%, transparent);
  }

  .rt-row.row-pending {
    opacity: 0.78;
  }

  .addr-cell {
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--c-text-2);
  }

  .value-cell {
    font-family: monospace;
    font-size: 0.76rem;
    color: var(--c-text-1);
  }

  .label-cell {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .cell-label {
    font-size: 0.78rem;
    color: var(--c-text-1);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: right;
    white-space: nowrap;
    flex: 1;
    min-width: 0;
  }

  .cell-label.label-empty {
    color: var(--c-text-2);
    opacity: 0.45;
    font-style: italic;
  }

  .label-input,
  .value-input {
    min-width: 0;
    height: 24px;
    padding: 0 6px;
    border: 1px solid var(--c-border);
    border-radius: 4px;
    background: var(--c-surface-2);
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.75rem;
    outline: none;
  }

  .label-input {
    flex: 1;
  }

  .value-input {
    width: 100%;
    text-align: right;
    font-family: monospace;
  }

  .value-input:focus,
  .label-input:focus {
    border-color: var(--c-accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--c-accent) 14%, transparent);
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

  .edit-trigger {
    opacity: 0;
    transition: opacity 100ms;
  }

  .rt-row:hover .edit-trigger {
    opacity: 1;
  }

  .pending-cell,
  .desired-cell,
  .delete-cell {
    display: flex;
    align-items: center;
  }

  .operation-cell {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: nowrap;
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
</style>
