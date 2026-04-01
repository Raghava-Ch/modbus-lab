<svelte:options runes={true} />

<script lang="ts">
  import { RefreshCw, Pencil, Check, X } from "lucide-svelte";

  export type InputRegisterRowEntry = {
    address: number;
    value: number;
    pending: boolean;
    readError: string | null;
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
    onRead,
    onDelete,
  } = $props<{
    entry: InputRegisterRowEntry;
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
    onRead: (address: number) => void;
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
      <button class="icon-micro" type="button" onclick={commitEdit} title="Save">
        <Check size={11} />
      </button>
      <button class="icon-micro" type="button" onclick={cancelEdit} title="Cancel">
        <X size={11} />
      </button>
    {:else}
      <span
        class="cell-label"
        class:label-empty={!entry.label}
        role="button"
        tabindex="0"
        onclick={() => beginEdit(entry.address, entry.label)}
        onkeydown={(e) => { if (e.key === "Enter") beginEdit(entry.address, entry.label); }}
        title="Click to edit label"
      >
        {entry.label || "-"}
      </span>
      <button
        class="icon-micro edit-trigger"
        type="button"
        onclick={() => beginEdit(entry.address, entry.label)}
        title="Edit label"
      >
        <Pencil size={10} />
      </button>
    {/if}
  </span>

  <span class="pending-cell">
    {#if entry.readError}
      <span class="dirty-indicator failed-indicator" title={entry.readError}>Not avail</span>
    {/if}
  </span>

  <span class="addr-cell">{addrFmt(entry.address)}</span>

  <span class="value-cell">{valueFmt(entry.value)}</span>

  <span class="operation-cell">
    <button
      class="read-mini"
      type="button"
      disabled={!connected}
      onclick={() => onRead(entry.address)}
      title={connected ? "Read from device" : "Connect to device first"}
    >
      <RefreshCw size={11} />
      Read
    </button>
  </span>

  <span class="delete-cell">
    <button class="delete-mini" type="button" onclick={() => onDelete(entry.address)} title="Delete register">
      <X size={11} />
    </button>
  </span>
</div>

<style>
  .rt-row {
    display: grid;
    grid-template-columns: minmax(140px, 1fr) 92px 64px 88px 100px 52px;
    align-items: center;
    gap: 0;
    min-width: 560px;
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
    opacity: 0.55;
  }

  .label-input {
    flex: 1;
    min-width: 0;
    height: 24px;
    padding: 0 6px;
    border: 1px solid var(--c-accent);
    border-radius: 4px;
    background: var(--c-surface-2);
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.75rem;
    outline: none;
  }

  .icon-micro {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--c-text-2);
    padding: 0;
    cursor: pointer;
    flex-shrink: 0;
  }

  .icon-micro:hover {
    color: var(--c-text-1);
    background: var(--c-surface-3);
  }

  .edit-trigger {
    opacity: 0;
  }

  .label-cell:hover .edit-trigger {
    opacity: 1;
  }

  .pending-cell {
    display: flex;
    align-items: center;
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

  .operation-cell {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .delete-cell {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .read-mini {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 22px;
    padding: 0 7px;
    border: 1px solid var(--c-border);
    border-radius: 5px;
    background: var(--c-surface-2);
    color: var(--c-text-2);
    font: inherit;
    font-size: 0.66rem;
    cursor: pointer;
    transition: all 120ms ease;
  }

  .read-mini:hover:not(:disabled) {
    border-color: var(--c-border-strong);
    color: var(--c-text-1);
  }

  .read-mini:disabled {
    opacity: 0.45;
    cursor: not-allowed;
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
    cursor: pointer;
    font: inherit;
    transition: all 120ms ease;
  }

  .delete-mini:hover {
    border-color: var(--c-error);
    color: var(--c-text-1);
  }
</style>
