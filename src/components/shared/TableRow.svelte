<svelte:options runes={true} />

<script lang="ts">
  import { RefreshCw, Zap, Pencil, Check, X } from "lucide-svelte";
  import ToggleSwitch from "./ToggleSwitch.svelte";

  type TableEntry = {
    address: number;
    slaveValue: boolean;
    desiredValue: boolean;
    pending: boolean;
    writeError: string | null;
    label: string;
  };

  let {
    entry,
    connected,
    editingAddress,
    editLabelVal,
    addrFmt,
    beginEdit,
    commitEdit,
    cancelEdit,
    onLabelKeydown,
    onEditLabelValChange,
    onToggle,
    onRead,
    onWrite,
    onDelete,
    showStatusColumn = false,
  } = $props<{
    entry: TableEntry;
    connected: boolean;
    editingAddress: number | null;
    editLabelVal: string;
    addrFmt: (n: number) => string;
    beginEdit: (address: number, current: string) => void;
    commitEdit: () => void;
    cancelEdit: () => void;
    onLabelKeydown: (e: KeyboardEvent) => void;
    onEditLabelValChange: (next: string) => void;
    onToggle: ((address: number) => void) | undefined;
    onRead: (address: number) => void;
    onWrite: ((address: number) => void) | undefined ;
    onDelete: (address: number) => void;
    showStatusColumn?: boolean;
  }>();
</script>

<div
  class="ct-row"
  class:row-on={entry.slaveValue}
  class:row-pending={entry.pending}
  class:row-dirty={entry.desiredValue !== entry.slaveValue || entry.writeError !== null}
  class:ct-row-no-pending={!(onToggle != undefined) && !showStatusColumn}
  class:ct-row-no-switch={!(onToggle != undefined)}
>
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
        {entry.label || "—"}
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

  {#if onToggle != undefined || showStatusColumn}
    <span class="pending-cell">
      {#if entry.writeError || entry.desiredValue !== entry.slaveValue || entry.pending}
        {#if entry.writeError}
            <span class="dirty-indicator failed-indicator has-tip" data-tip={entry.writeError}>Not avail</span>
        {:else if entry.pending}
          <span class="dirty-indicator has-tip" data-tip="Read in progress">Reading</span>
        {:else}
            <span class="dirty-indicator has-tip" data-tip="Local value differs from device">Unsynced</span>
        {/if}
      {/if}
    </span>
  {/if}

  <span class="addr-cell">{addrFmt(entry.address)}</span>

  <span class="value-cell">
    {#if entry.pending}
      <span class="badge pending-badge">…</span>
    {:else}
      <span class="badge" class:badge-live-on={entry.slaveValue} class:badge-live-off={!entry.slaveValue}>
        {entry.slaveValue ? "ON" : "OFF"}
      </span>
    {/if}
  </span>

  {#if onToggle != undefined}
    <span class="switch-cell">
      <ToggleSwitch
        checked={entry.desiredValue}
        size="sm"
        title={entry.desiredValue ? "Desired ON" : "Desired OFF"}
        onToggle={() => onToggle(entry.address)}
      />
    </span>
  {/if}

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
    {#if onWrite != undefined}
      <button
        class="write-mini has-tip"
        type="button"
        disabled={!connected}
        onclick={() => onWrite(entry.address)}
        data-tip={connected ? (entry.desiredValue ? "Write ON" : "Write OFF") : "Connect to device first"}
      >
        <Zap size={11} />
        Write
      </button>
    {/if}
  </span>

  <span class="delete-cell">
    <button
      class="delete-mini has-tip"
      type="button"
      onclick={() => onDelete(entry.address)}
      data-tip="Delete coil"
    >
      <X size={11} />
    </button>
  </span>
</div>

<style>
  .ct-row {
    display: grid;
    grid-template-columns: minmax(140px, 1fr) 92px 64px 88px 60px 182px 52px;
    align-items: center;
    gap: 0;
    min-width: 700px;
    border-bottom: 1px solid color-mix(in srgb, var(--c-border) 40%, transparent);
    min-height: 34px;
    transition: background 100ms;
  }

  .ct-row.ct-row-no-pending {
    grid-template-columns: minmax(140px, 1fr) 64px 88px 60px 182px 52px;
    min-width: 608px;
  }

  .ct-row.ct-row-no-switch {
    grid-template-columns: minmax(140px, 1fr) 92px 64px 88px 182px 52px;
    min-width: 640px;
  }

  .ct-row.ct-row-no-pending.ct-row-no-switch {
    grid-template-columns: minmax(140px, 1fr) 64px 88px 108px 52px;
    min-width: 474px;
  }

  .ct-row > span {
    padding: 0 4px;
  }

  .ct-row:last-child {
    border-bottom: none;
  }

  .ct-row:nth-child(even) {
    background: color-mix(in srgb, var(--c-surface-2) 52%, transparent);
  }

  .ct-row.row-on:nth-child(even) {
    background: color-mix(in srgb, var(--c-ok) 6%, var(--c-surface-2));
  }

  .ct-row:hover {
    background: color-mix(in srgb, var(--c-surface-3) 52%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-border) 52%, transparent);
  }

  .ct-row.row-on {
    background: color-mix(in srgb, var(--c-ok) 4%, transparent);
  }

  .ct-row.row-dirty {
    box-shadow: inset 3px 0 0 0 color-mix(in srgb, var(--c-warn) 60%, transparent);
  }

  .ct-row.row-pending {
    opacity: 0.7;
  }

  .addr-cell {
    font-family: monospace;
    font-size: 0.75rem;
    color: var(--c-text-2);
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

  .ct-row:hover .edit-trigger {
    opacity: 1;
  }

  .value-cell,
  .pending-cell,
  .switch-cell,
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

  .pending-badge {
    background: color-mix(in srgb, var(--c-warn) 18%, var(--c-surface-3));
    color: var(--c-warn);
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