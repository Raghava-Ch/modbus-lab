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
  class="rt-row"
  class:row-on={entry.slaveValue}
  class:row-pending={entry.pending}
  class:row-no-pending={!(onToggle != undefined) && !showStatusColumn}
  class:row-no-switch={!(onToggle != undefined)}
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
  .rt-row {
    grid-template-columns: minmax(140px, 1fr) 92px 64px 88px 60px 182px 52px;
    min-width: 700px;
  }

  .rt-row.row-no-pending {
    grid-template-columns: minmax(140px, 1fr) 64px 88px 60px 182px 52px;
    min-width: 608px;
  }

  .rt-row.row-no-switch {
    grid-template-columns: minmax(140px, 1fr) 92px 64px 88px 182px 52px;
    min-width: 640px;
  }

  .rt-row.row-no-pending.row-no-switch {
    grid-template-columns: minmax(140px, 1fr) 64px 88px 108px 52px;
    min-width: 474px;
  }
</style>