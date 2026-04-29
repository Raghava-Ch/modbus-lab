<svelte:options runes={true} />

<script lang="ts">
  import { Settings2, Repeat, Pencil, Check, X } from "lucide-svelte";
  import ToggleSwitch from "./ToggleSwitch.svelte";

  type TableEntry = {
    address: number;
    slaveValue: boolean;
    desiredValue: boolean;
    pending: boolean;
    writeError: string | null;
    label: string;
  };

  type CoilRule = {
    type: "none" | "auto-toggle";
    intervalMs: number;
  };

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
    entry,
    editingAddress,
    editLabelVal,
    addrFmt,
    beginEdit,
    commitEdit,
    cancelEdit,
    onLabelKeydown,
    onEditLabelValChange,
    onToggle,
    onDelete,
    rule,
    onRuleChange,
  } = $props<{
    entry: TableEntry;
    editingAddress: number | null;
    editLabelVal: string;
    addrFmt: (n: number) => string;
    beginEdit: (address: number, current: string) => void;
    commitEdit: () => void;
    cancelEdit: () => void;
    onLabelKeydown: (e: KeyboardEvent) => void;
    onEditLabelValChange: (next: string) => void;
    onToggle: ((address: number) => void) | undefined;
    onDelete: (address: number) => void;
    rule: CoilRule;
    onRuleChange: (rule: CoilRule) => void;
  }>();

  let ruleOpen = $state(false);
  let editRuleType = $state<"none" | "auto-toggle">("none");
  let editIntervalMs = $state(1000);
  let ruleBtnEl: HTMLButtonElement | null = $state(null);
  let popoverTop = $state(0);
  let popoverLeft = $state(0);

  function openRule(): void {
    editRuleType = rule.type;
    editIntervalMs = rule.intervalMs;
    if (ruleBtnEl) {
      const rect = ruleBtnEl.getBoundingClientRect();
      popoverTop = rect.bottom + 4;
      popoverLeft = rect.left;
    }
    ruleOpen = true;
  }

  function applyRule(): void {
    onRuleChange({ type: editRuleType, intervalMs: editIntervalMs });
    ruleOpen = false;
  }

  function fmtInterval(ms: number): string {
    return ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`;
  }
</script>

<div
  class="rt-row"
  class:row-on={entry.slaveValue}
  class:row-pending={entry.pending}
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

  <span class="addr-cell">{addrFmt(entry.address)}</span>

  <span class="switch-cell">
    <ToggleSwitch
      checked={entry.desiredValue}
      size="sm"
      title={entry.desiredValue ? "ON" : "OFF"}
      onToggle={() => onToggle?.(entry.address)}
    />
  </span>

  <span class="rule-cell">
    <div class="rule-wrap">
      <button
        bind:this={ruleBtnEl}
        class="rule-btn has-tip"
        class:rule-active={rule.type !== "none"}
        type="button"
        onclick={openRule}
        data-tip={rule.type === "none" ? "Set automation rule" : `Auto-toggle every ${fmtInterval(rule.intervalMs)}`}
      >
        {#if rule.type === "auto-toggle"}
          <Repeat size={11} />
          <span class="rule-label">{fmtInterval(rule.intervalMs)}</span>
        {:else}
          <Settings2 size={11} />
          <span class="rule-label-dim">Rule</span>
        {/if}
      </button>

      {#if ruleOpen}
        <div class="rule-popover" style="top:{popoverTop}px;left:{popoverLeft}px;" role="dialog" aria-label="Automation rule">
          <div class="rule-pop-title">Automation Rule</div>
          <div class="rule-pop-types">
            <label class="rule-radio">
              <input
                type="radio"
                name="rule-type-{entry.address}"
                value="none"
                checked={editRuleType === "none"}
                onchange={() => { editRuleType = "none"; }}
              />
              None
            </label>
            <label class="rule-radio">
              <input
                type="radio"
                name="rule-type-{entry.address}"
                value="auto-toggle"
                checked={editRuleType === "auto-toggle"}
                onchange={() => { editRuleType = "auto-toggle"; }}
              />
              Auto-toggle
            </label>
          </div>
          {#if editRuleType === "auto-toggle"}
            <div class="rule-pop-interval">
              <span class="rule-pop-interval-label">Every</span>
              <select
                class="rule-interval-select"
                value={editIntervalMs}
                onchange={(e) => { editIntervalMs = Number(e.currentTarget.value); }}
              >
                {#each INTERVAL_OPTIONS as opt}
                  <option value={opt.ms}>{opt.label}</option>
                {/each}
              </select>
            </div>
          {/if}
          <div class="rule-pop-actions">
            <button class="rule-pop-apply" type="button" onclick={applyRule}>Apply</button>
            <button class="rule-pop-cancel" type="button" onclick={() => { ruleOpen = false; }}>Cancel</button>
          </div>
        </div>
      {/if}
    </div>
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
    /* label | addr | switch | rule | delete */
    grid-template-columns: minmax(140px, 1fr) 65px 60px 160px 44px;
    min-width: 460px;
  }

  /* Explicit column placement so cells never shift if any are conditionally absent */
  .rt-row :global(.label-cell)  { grid-column: 1; }
  .rt-row :global(.addr-cell)   { grid-column: 2; }
  .rt-row :global(.switch-cell) { grid-column: 3; }
  .rt-row .rule-cell            { grid-column: 4; }
  .rt-row :global(.delete-cell) { grid-column: 5; }

  /* ── Rule cell ── */
  .rule-cell {
    display: flex;
    align-items: center;
    position: relative;
  }

  .rule-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  .rule-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--c-border);
    border-radius: 6px;
    background: var(--c-surface-2);
    color: var(--c-text-2);
    font: inherit;
    font-size: 0.66rem;
    cursor: pointer;
    white-space: nowrap;
    transition: all 120ms ease;
  }

  .rule-btn:hover {
    border-color: var(--c-border-strong);
    color: var(--c-text-1);
  }

  .rule-btn.rule-active {
    border-color: color-mix(in srgb, var(--c-accent) 40%, var(--c-border));
    background: color-mix(in srgb, var(--c-accent) 10%, var(--c-surface-2));
    color: var(--c-accent);
  }

  .rule-label {
    font-family: monospace;
    font-size: 0.68rem;
  }

  .rule-label-dim {
    font-size: 0.66rem;
    opacity: 0.55;
  }

  /* ── Rule popover ── */
  .rule-popover {
    position: fixed;
    z-index: 9999;
    min-width: 172px;
    padding: 10px 12px 8px;
    border: 1px solid var(--c-border-strong);
    border-radius: 8px;
    background: var(--c-surface-1);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28);
  }

  .rule-pop-title {
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--c-text-2);
    margin-bottom: 8px;
  }

  .rule-pop-types {
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin-bottom: 8px;
  }

  .rule-radio {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.75rem;
    color: var(--c-text-1);
    cursor: pointer;
  }

  .rule-radio input[type="radio"] {
    accent-color: var(--c-accent);
    cursor: pointer;
  }

  .rule-pop-interval {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 8px;
  }

  .rule-pop-interval-label {
    font-size: 0.72rem;
    color: var(--c-text-2);
    flex-shrink: 0;
  }

  .rule-interval-select {
    height: 26px;
    padding: 0 6px;
    border: 1px solid var(--c-border);
    border-radius: 5px;
    background: var(--c-surface-2);
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
    flex: 1;
  }

  .rule-pop-actions {
    display: flex;
    gap: 6px;
  }

  .rule-pop-apply,
  .rule-pop-cancel {
    flex: 1;
    height: 24px;
    padding: 0 8px;
    border-radius: 5px;
    font: inherit;
    font-size: 0.71rem;
    cursor: pointer;
    transition: all 120ms ease;
  }

  .rule-pop-apply {
    border: 1px solid color-mix(in srgb, var(--c-accent) 35%, var(--c-border));
    background: color-mix(in srgb, var(--c-accent) 14%, var(--c-surface-2));
    color: var(--c-accent);
  }

  .rule-pop-apply:hover {
    border-color: var(--c-accent);
    color: var(--c-text-1);
  }

  .rule-pop-cancel {
    border: 1px solid var(--c-border);
    background: var(--c-surface-2);
    color: var(--c-text-2);
  }

  .rule-pop-cancel:hover {
    border-color: var(--c-border-strong);
    color: var(--c-text-1);
  }
</style>