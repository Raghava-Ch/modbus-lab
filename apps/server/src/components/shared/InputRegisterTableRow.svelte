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
    {#if entry.readError}
      <span class="dirty-indicator failed-indicator has-tip" data-tip={entry.readError}>Not avail</span>
    {/if}
  </span>

  <span class="addr-cell">{addrFmt(entry.address)}</span>

  <span class="value-cell">{valueFmt(entry.value)}</span>

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
  </span>

  <span class="delete-cell">
    <button class="delete-mini has-tip" type="button" onclick={() => onDelete(entry.address)} data-tip="Delete register">
      <X size={11} />
    </button>
  </span>
</div>

<style>
  .rt-row {
    grid-template-columns: minmax(140px, 1fr) 92px 64px 88px 100px 52px;
    min-width: 560px;
  }
</style>
