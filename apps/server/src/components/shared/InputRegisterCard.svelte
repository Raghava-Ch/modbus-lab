<svelte:options runes={true} />

<script lang="ts">
  import { Settings2, Repeat, Clock3, SlidersHorizontal, Pencil, Check, X } from "lucide-svelte";
  import type { InputRegRule } from "../../state/input-registers.svelte";
  import { RULE_INTERVAL_OPTIONS } from "../../state/input-registers.svelte";

  let {
    address,
    label,
    pending,
    desiredValue,
    cardDirty = false,
    rule,
    editingAddress,
    editLabelVal,
    addrFmt,
    onBeginEdit,
    onCommitEdit,
    onCancelEdit,
    onLabelKeydown,
    onEditLabelValChange,
    onDesiredChange,
    onWrite,
    onRuleChange,
    onDelete,
  } = $props<{
    address: number;
    label: string;
    pending: boolean;
    desiredValue: number;
    cardDirty?: boolean;
    rule: InputRegRule;
    editingAddress: number | null;
    editLabelVal: string;
    addrFmt: (n: number) => string;
    onBeginEdit: (address: number, current: string) => void;
    onCommitEdit: () => void;
    onCancelEdit: () => void;
    onLabelKeydown: (e: KeyboardEvent) => void;
    onEditLabelValChange: (next: string) => void;
    onDesiredChange: (address: number, value: number) => void;
    onWrite: (address: number) => void;
    onRuleChange: (address: number, nextRule: InputRegRule) => void;
    onDelete: (address: number) => void;
  }>();

  const SINE_PERIOD_OPTIONS: { ms: number; label: string }[] = RULE_INTERVAL_OPTIONS.map((opt) => ({
    ms: opt.ms * 2,
    label: `${opt.label} x2`,
  }));

  let ruleOpen = $state(false);
  let ruleBtnEl: HTMLButtonElement | null = $state(null);
  let popoverTop = $state(0);
  let popoverLeft = $state(0);
  let editRuleType = $state<InputRegRule["type"]>("none");
  let editIntervalMs = $state(1000);
  let editMinValue = $state(0);
  let editMaxValue = $state(100);
  let editStep = $state(1);
  let editPeriodMs = $state(4000);

  function fmtInterval(ms: number): string {
    return ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`;
  }

  function isWaveRule(type: InputRegRule["type"]): boolean {
    return type !== "none";
  }

  function ruleSummary(ruleValue: InputRegRule): string {
    if (ruleValue.type === "none") return "No rule";
    if (ruleValue.type === "cycle") return `${ruleValue.minValue}/${ruleValue.maxValue} @ ${fmtInterval(ruleValue.intervalMs)}`;
    if (ruleValue.type === "sine") return `${ruleValue.minValue}-${ruleValue.maxValue} p:${fmtInterval(ruleValue.periodMs)}`;
    if (ruleValue.type === "sawtooth") return `step ${ruleValue.step} @ ${fmtInterval(ruleValue.intervalMs)}`;
    return `step ${ruleValue.step} @ ${fmtInterval(ruleValue.intervalMs)}`;
  }

  function openRule(): void {
    editRuleType = rule.type;
    editIntervalMs = rule.intervalMs;
    editMinValue = rule.minValue;
    editMaxValue = rule.maxValue;
    editStep = rule.step;
    editPeriodMs = rule.periodMs;
    ruleOpen = !ruleOpen;
    if (ruleOpen && ruleBtnEl) {
      const rect = ruleBtnEl.getBoundingClientRect();
      popoverTop = rect.bottom + 4;
      popoverLeft = rect.left;
    }
  }

  function clampU16(raw: number, fallback: number): number {
    if (!Number.isFinite(raw)) return fallback;
    return Math.max(0, Math.min(65535, Math.floor(raw)));
  }

  function applyRule(): void {
    const rawMin = clampU16(editMinValue, rule.minValue);
    const rawMax = clampU16(editMaxValue, rule.maxValue);

    const nextRule: InputRegRule = {
      type: editRuleType,
      intervalMs: Math.max(100, Math.floor(editIntervalMs)),
      minValue: Math.min(rawMin, rawMax),
      maxValue: Math.max(rawMin, rawMax),
      step: Math.max(1, Math.floor(editStep)),
      periodMs: Math.max(200, Math.floor(editPeriodMs)),
    };

    onRuleChange(address, nextRule);
    ruleOpen = false;
  }

  function handleValueInput(raw: string): void {
    onDesiredChange(address, Number(raw));
    onWrite(address);
  }
</script>

<svelte:window
  onclick={(e) => {
    if (ruleOpen && ruleBtnEl && !ruleBtnEl.contains(e.target as Node)) {
      const pop = document.querySelector(`.card-rule-pop-${address}`);
      if (pop && !pop.contains(e.target as Node)) {
        ruleOpen = false;
      }
    }
  }}
/>

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
    <div class="card-value-inline">
      <input
        class="value-input"
        type="number"
        min="0"
        max="65535"
        value={desiredValue}
        oninput={(e) => handleValueInput(e.currentTarget.value)}
      />
    </div>
  </div>

  <div class="card-rule">
    <button
      bind:this={ruleBtnEl}
      class="rule-btn has-tip"
      class:rule-active={rule.type !== "none"}
      type="button"
      onclick={openRule}
      data-tip="Configure generator rule"
    >
      {#if isWaveRule(rule.type)}
        <Repeat size={11} />
        <span class="rule-label">{rule.type}</span>
      {:else}
        <Settings2 size={11} />
        <span class="rule-label-dim">Rule</span>
      {/if}
    </button>

    <div class="rule-detail" title={ruleSummary(rule)}>
      {#if rule.type === "none"}
        <span class="rule-chip">
          <Settings2 size={10} />
          none
        </span>
      {:else}
        <span class="rule-chip">
          <Clock3 size={10} />
          {fmtInterval(rule.intervalMs)}
        </span>
        <span class="rule-chip">
          <SlidersHorizontal size={10} />
          {rule.minValue}-{rule.maxValue}
        </span>
        {#if rule.type === "sawtooth" || rule.type === "triangle"}
          <span class="rule-chip">st {rule.step}</span>
        {/if}
        {#if rule.type === "sine"}
          <span class="rule-chip rule-chip-period">p {fmtInterval(rule.periodMs)}</span>
        {/if}
      {/if}
    </div>

    {#if ruleOpen}
      <div
        class="rule-popover card-rule-pop-{address}"
        style="top:{popoverTop}px;left:{popoverLeft}px;"
        role="dialog"
        aria-label="Generator rule"
      >
        <div class="rule-pop-grid">
          <label class="rule-pop-field">
            <span class="rule-pop-label">Type</span>
            <select value={editRuleType} onchange={(e) => { editRuleType = e.currentTarget.value as InputRegRule["type"]; }}>
              <option value="none">None</option>
              <option value="cycle">Cycle</option>
              <option value="sine">Sine wave</option>
              <option value="sawtooth">Sawtooth wave</option>
              <option value="triangle">Triangle wave</option>
            </select>
          </label>

          <label class="rule-pop-field">
            <span class="rule-pop-label">Every</span>
            <select value={editIntervalMs} disabled={editRuleType === "none"} onchange={(e) => { editIntervalMs = Number(e.currentTarget.value); }}>
              {#each RULE_INTERVAL_OPTIONS as opt}
                <option value={opt.ms}>{opt.label}</option>
              {/each}
            </select>
          </label>

          {#if editRuleType !== "none"}
            <label class="rule-pop-field">
              <span class="rule-pop-label">Min</span>
              <input type="number" min="0" max="65535" value={editMinValue} oninput={(e) => { editMinValue = Number(e.currentTarget.value); }} />
            </label>

            <label class="rule-pop-field">
              <span class="rule-pop-label">Max</span>
              <input type="number" min="0" max="65535" value={editMaxValue} oninput={(e) => { editMaxValue = Number(e.currentTarget.value); }} />
            </label>
          {/if}

          {#if editRuleType === "sawtooth" || editRuleType === "triangle"}
            <label class="rule-pop-field rule-pop-span2">
              <span class="rule-pop-label">Step</span>
              <input type="number" min="1" max="65535" value={editStep} oninput={(e) => { editStep = Number(e.currentTarget.value); }} />
            </label>
          {/if}

          {#if editRuleType === "sine"}
            <label class="rule-pop-field rule-pop-span2">
              <span class="rule-pop-label">Period</span>
              <select value={editPeriodMs} onchange={(e) => { editPeriodMs = Number(e.currentTarget.value); }}>
                {#each SINE_PERIOD_OPTIONS as opt}
                  <option value={opt.ms}>{opt.label}</option>
                {/each}
              </select>
            </label>
          {/if}
        </div>

        <div class="rule-pop-actions">
          <button class="rule-pop-apply" type="button" onclick={applyRule}>Apply</button>
          <button class="rule-pop-cancel" type="button" onclick={() => { ruleOpen = false; }}>Cancel</button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .card-meta {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .card-value-inline {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .value-input {
    height: 26px;
    padding: 0 8px;
    width: 118px;
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

  .card-rule {
    width: 100%;
    margin-top: 6px;
    display: flex;
    align-items: center;
    min-height: 22px;
    gap: 6px;
    position: relative;
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
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.66rem;
    cursor: pointer;
    white-space: nowrap;
    transition: border-color 120ms ease, box-shadow 120ms ease, background 120ms ease;
  }

  .rule-btn:hover {
    border-color: var(--c-border-strong);
    background: color-mix(in srgb, var(--c-surface-2) 88%, var(--c-surface-1));
  }

  .rule-btn.rule-active {
    border-color: var(--c-border-strong);
    background: color-mix(in srgb, var(--c-surface-2) 92%, var(--c-accent));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-accent) 22%, transparent);
  }

  .rule-label {
    font-family: monospace;
    font-size: 0.68rem;
  }

  .rule-label-dim {
    font-size: 0.66rem;
    opacity: 0.55;
  }

  .rule-detail {
    min-width: 0;
    flex: 1;
    display: flex;
    justify-content: flex-end;
    gap: 4px;
    color: var(--c-text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    align-items: center;
  }

  .rule-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    max-width: 120px;
    height: 18px;
    padding: 0 5px;
    border: 1px solid color-mix(in srgb, var(--c-border) 65%, transparent);
    border-radius: 999px;
    background: color-mix(in srgb, var(--c-surface-2) 90%, transparent);
    font-size: 0.6rem;
    letter-spacing: 0.02em;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .rule-chip-period {
    max-width: none;
    min-width: 56px;
    justify-content: center;
    flex: 0 0 auto;
  }

  .rule-popover {
    position: fixed;
    z-index: 9999;
    min-width: 212px;
    padding: 10px;
    border: 1px solid var(--c-border-strong);
    border-radius: 6px;
    background: var(--c-surface-1);
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.32);
  }

  .rule-pop-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }

  .rule-pop-field {
    display: grid;
    gap: 3px;
  }

  .rule-pop-span2 {
    grid-column: 1 / -1;
  }

  .rule-pop-label {
    font-size: 0.62rem;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--c-text-2);
  }

  .rule-pop-field select,
  .rule-pop-field input {
    width: 100%;
    height: 24px;
    border: 1px solid var(--c-border);
    border-radius: 5px;
    background: var(--c-surface-2);
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.67rem;
    padding: 0 8px;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }

  .rule-pop-field input {
    font-family: monospace;
    text-align: right;
  }

  .rule-pop-field select:focus,
  .rule-pop-field input:focus {
    outline: none;
    border-color: var(--c-accent);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--c-accent) 16%, transparent);
  }

  .rule-pop-field select:disabled,
  .rule-pop-field input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .rule-pop-actions {
    margin-top: 8px;
    display: flex;
    gap: 6px;
  }

  .rule-pop-apply,
  .rule-pop-cancel {
    flex: 1;
    height: 24px;
    border-radius: 5px;
    font: inherit;
    font-size: 0.68rem;
    cursor: pointer;
  }

  .rule-pop-apply {
    border: 1px solid color-mix(in srgb, var(--c-accent) 35%, var(--c-border));
    background: color-mix(in srgb, var(--c-accent) 14%, var(--c-surface-2));
    color: var(--c-accent);
  }

  .rule-pop-cancel {
    border: 1px solid var(--c-border);
    background: var(--c-surface-2);
    color: var(--c-text-2);
  }
</style>
