<svelte:options runes={true} />

<script lang="ts">
  import { RefreshCw, Pencil, Check, X, Settings2, Clock3, ChevronDown } from "lucide-svelte";
  import ToggleSwitch from "./ToggleSwitch.svelte";

  export type SwitchCardRule = { type: "none" | "auto-toggle"; intervalMs: number };

  const INTERVAL_OPTIONS = [
    { ms: 100,   label: "100 ms" },
    { ms: 250,   label: "250 ms" },
    { ms: 500,   label: "500 ms" },
    { ms: 1000,  label: "1 s" },
    { ms: 2000,  label: "2 s" },
    { ms: 5000,  label: "5 s" },
    { ms: 10000, label: "10 s" },
  ];

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
    showStateChip = true,
    rule = undefined as SwitchCardRule | undefined,
    onRuleChange = undefined as ((rule: SwitchCardRule) => void) | undefined,
    readButtonTitle,
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
    onRead?: (address: number) => void;
    onWrite?: (address: number) => void;
    onDelete: (address: number) => void;
    showStateChip?: boolean;
    rule?: SwitchCardRule;
    onRuleChange?: (rule: SwitchCardRule) => void;
    readButtonTitle?: string;
    deleteButtonTitle?: string;
  }>();

  const effectiveReadTitle = $derived(readButtonTitle ?? (connected ? "Read from device" : "Connect to device first"));

  const hasRuleControls = $derived(rule !== undefined && onRuleChange !== undefined);

  function handleRuleTypeChange(nextType: "none" | "auto-toggle"): void {
    if (!rule || !onRuleChange) return;
    onRuleChange({
      type: nextType,
      intervalMs: rule.intervalMs,
    });
  }

  function handleRuleIntervalChange(nextIntervalMs: number): void {
    if (!rule || !onRuleChange) return;
    onRuleChange({
      type: rule.type,
      intervalMs: nextIntervalMs,
    });
  }
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

  {#if showStateChip}
  <div class="card-status-row">
    <span class="badge" class:badge-live-on={readValue} class:badge-live-off={!readValue}>
      {readValue ? "ON" : "OFF"}
    </span>
  </div>
  {/if}

  {#if hasRuleControls && rule}
    <div class="card-rule">
      <div class="card-rule-controls">
        <label class="rule-select-wrap has-tip" data-tip="Rule mode">
          <span class="rule-select-icon" aria-hidden="true"><Settings2 size={12} /></span>
          <select
            class="rule-type-select"
            value={rule.type}
            onchange={(e) => handleRuleTypeChange(e.currentTarget.value as "none" | "auto-toggle")}
          >
            <option value="none">None</option>
            <option value="auto-toggle">Auto-toggle</option>
          </select>
          <span class="rule-select-caret" aria-hidden="true"><ChevronDown size={12} /></span>
        </label>

        <label
          class="rule-select-wrap has-tip"
          data-tip={rule.type === "auto-toggle" ? "Auto-toggle interval" : "Select Auto-toggle to enable interval"}
        >
          <span class="rule-select-icon" aria-hidden="true"><Clock3 size={12} /></span>
          <select
            class="rule-interval-select"
            value={rule.intervalMs}
            disabled={rule.type !== "auto-toggle"}
            title={rule.type === "auto-toggle" ? "Auto-toggle interval" : "Select Auto-toggle to enable interval"}
            onchange={(e) => handleRuleIntervalChange(Number(e.currentTarget.value))}
          >
            {#each INTERVAL_OPTIONS as opt}
              <option value={opt.ms}>{opt.label}</option>
            {/each}
          </select>
          <span class="rule-select-caret" aria-hidden="true"><ChevronDown size={12} /></span>
        </label>
      </div>
    </div>
  {/if}

  <div class="card-actions" class:card-actions-two={onToggle != undefined && onRead != undefined}>
    {#if onRead != undefined}
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
    {/if}

    {#if onWrite != undefined}
      <button
        class="write-mini has-tip"
        type="button"
        disabled={!connected}
        onclick={() => onWrite?.(address)}
        data-tip={connected ? "Write value" : "Connect to device first"}
      >
        <Check size={11} />
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
  .card-meta {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .card-status-row {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    min-height: 28px;
  }

  .card-rule {
    width: 100%;
    margin-top: 4px;
    display: grid;
    gap: 6px;
  }

  .card-rule-controls {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }

  .rule-select-wrap {
    position: relative;
    display: flex;
    align-items: center;
    width: 100%;
  }

  .card-rule-controls select {
    appearance: none;
    -webkit-appearance: none;
    width: 100%;
    height: 24px;
    border: 1px solid var(--c-border);
    border-radius: 6px;
    background: var(--c-surface-2);
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.67rem;
    padding: 0 24px 0 24px;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }

  .card-rule-controls select:focus {
    outline: none;
    border-color: var(--c-accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--c-accent) 16%, transparent);
  }

  .card-rule-controls .rule-type-select:only-child {
    grid-column: 1 / -1;
  }

  .rule-select-icon,
  .rule-select-caret {
    position: absolute;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--c-text-3);
    pointer-events: none;
  }

  .rule-select-icon {
    left: 7px;
  }

  .rule-select-caret {
    right: 7px;
  }

  .card-rule-controls select:disabled {
    opacity: 0.6;
    cursor: not-allowed;
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