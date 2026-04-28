<svelte:options runes={true} />

<script lang="ts">
  import { Settings2, Repeat, Pencil, Check, X } from "lucide-svelte";
  import { acquireBodyScrollLock } from "../../lib/scroll-lock";
  import type { InputRegRule } from "../../state/input-registers.svelte";
  import { RULE_INTERVAL_OPTIONS } from "../../state/input-registers.svelte";

  export type InputRegisterRowEntry = {
    address: number;
    value: number;
    desiredValue: number;
    pending: boolean;
    readError: string | null;
    writeError: string | null;
    label: string;
    rule: InputRegRule;
  };

  let {
    entry,
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
    onWrite,
    onRuleChange,
    onDelete,
  } = $props<{
    entry: InputRegisterRowEntry;
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
    onWrite: (address: number) => void;
    onRuleChange: (address: number, rule: InputRegRule) => void;
    onDelete: (address: number) => void;
  }>();

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

  const RULE_PRESETS: { key: string; label: string; intervalMs: number; periodMs: number; step: number }[] = [
    { key: "fast", label: "Fast", intervalMs: 500, periodMs: 2000, step: 8 },
    { key: "normal", label: "Normal", intervalMs: 1000, periodMs: 4000, step: 4 },
    { key: "safe", label: "Safe", intervalMs: 2000, periodMs: 10000, step: 2 },
  ];

  const selectedPresetKey = $derived.by(() => {
    const matched = RULE_PRESETS.find(
      (preset) => (
        preset.intervalMs === editIntervalMs
        && preset.periodMs === editPeriodMs
        && preset.step === editStep
      ),
    );
    return matched?.key ?? null;
  });

  function fmtInterval(ms: number): string {
    return ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`;
  }

  function ruleSummary(rule: InputRegRule): string {
    if (rule.type === "cycle") return `Cycle ${rule.minValue}/${rule.maxValue}`;
    if (rule.type === "sine") return `Sine ${rule.minValue}-${rule.maxValue}`;
    if (rule.type === "sawtooth") return `Saw ${rule.minValue}-${rule.maxValue}`;
    if (rule.type === "triangle") return `Triangle ${rule.minValue}-${rule.maxValue}`;
    return "Set value rule";
  }

  function isWaveRule(type: InputRegRule["type"]): boolean {
    return type !== "none";
  }

  function applyPreset(presetKey: string): void {
    const preset = RULE_PRESETS.find((item) => item.key === presetKey);
    if (!preset) return;
    editIntervalMs = preset.intervalMs;
    editPeriodMs = preset.periodMs;
    editStep = preset.step;
  }

  function openRule(): void {
    editRuleType = entry.rule.type;
    editIntervalMs = entry.rule.intervalMs;
    editMinValue = entry.rule.minValue;
    editMaxValue = entry.rule.maxValue;
    editStep = Math.max(1, entry.rule.step);
    editPeriodMs = Math.max(200, entry.rule.periodMs);
    ruleOpen = !ruleOpen;
    if (ruleOpen && ruleBtnEl) {
      const rect = ruleBtnEl.getBoundingClientRect();
      popoverTop = rect.bottom + 4;
      popoverLeft = rect.left;
    }
  }

  function applyRule(): void {
    const normalizedMin = Math.max(0, Math.min(65535, Math.floor(editMinValue)));
    const normalizedMax = Math.max(0, Math.min(65535, Math.floor(editMaxValue)));
    const nextRule: InputRegRule = {
      type: editRuleType,
      intervalMs: Math.max(200, Math.floor(editIntervalMs)),
      minValue: Math.min(normalizedMin, normalizedMax),
      maxValue: Math.max(normalizedMin, normalizedMax),
      step: Math.max(1, Math.floor(editStep)),
      periodMs: Math.max(200, Math.floor(editPeriodMs)),
    };

    onRuleChange(entry.address, nextRule);
    ruleOpen = false;
  }

  function handleDesiredInput(raw: string): void {
    onDesiredChange(entry.address, Number(raw));
    onWrite(entry.address);
  }

  $effect(() => {
    if (!ruleOpen) return;

    const releaseScrollLock = acquireBodyScrollLock();
    return () => {
      releaseScrollLock();
    };
  });
</script>

<svelte:window
  onclick={(e) => {
    if (ruleOpen && ruleBtnEl && !ruleBtnEl.contains(e.target as Node)) {
      const pop = document.querySelector(`.rule-pop-${entry.address}`);
      if (pop && !pop.contains(e.target as Node)) {
        ruleOpen = false;
      }
    }
  }}
/>

<div class="rt-row">
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

  <span class="addr-cell">{addrFmt(entry.address)}</span>

  <span class="desired-cell">
    <input
      class="value-input"
      type="number"
      min="0"
      max="65535"
      value={entry.desiredValue}
      oninput={(e) => handleDesiredInput(e.currentTarget.value)}
    />
  </span>

  <span class="rule-cell">
    <div class="rule-wrap">
      <button
        bind:this={ruleBtnEl}
        class="rule-btn has-tip"
        class:rule-active={entry.rule.type !== "none"}
        type="button"
        onclick={openRule}
        data-tip={ruleSummary(entry.rule)}
      >
        {#if isWaveRule(entry.rule.type)}
          <Repeat size={11} />
          <span class="rule-label">{entry.rule.type}</span>
        {:else}
          <Settings2 size={11} />
          <span class="rule-label-dim">Rule</span>
        {/if}
      </button>

      {#if ruleOpen}
        <div
          class="rule-popover rule-pop-{entry.address}"
          style="top:{popoverTop}px;left:{popoverLeft}px;"
          role="dialog"
          aria-label="Write rule"
        >
          <div class="rule-pop-title">Generator Rule</div>
          <div class="rule-pop-presets">
            {#each RULE_PRESETS as preset}
              <button
                class="rule-preset-btn"
                class:active={selectedPresetKey === preset.key}
                type="button"
                onclick={() => applyPreset(preset.key)}
              >
                {preset.label}
              </button>
            {/each}
          </div>
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
                value="cycle"
                checked={editRuleType === "cycle"}
                onchange={() => { editRuleType = "cycle"; }}
              />
              Cycle
            </label>
            <label class="rule-radio">
              <input
                type="radio"
                name="rule-type-{entry.address}"
                value="sine"
                checked={editRuleType === "sine"}
                onchange={() => { editRuleType = "sine"; }}
              />
              Sine wave
            </label>
            <label class="rule-radio">
              <input
                type="radio"
                name="rule-type-{entry.address}"
                value="sawtooth"
                checked={editRuleType === "sawtooth"}
                onchange={() => { editRuleType = "sawtooth"; }}
              />
              Sawtooth wave
            </label>
            <label class="rule-radio">
              <input
                type="radio"
                name="rule-type-{entry.address}"
                value="triangle"
                checked={editRuleType === "triangle"}
                onchange={() => { editRuleType = "triangle"; }}
              />
              Triangle wave
            </label>
          </div>
          {#if isWaveRule(editRuleType)}
            <div class="rule-pop-interval">
              <span class="rule-pop-interval-label">Every</span>
              <select
                class="rule-interval-select"
                value={editIntervalMs}
                onchange={(e) => { editIntervalMs = Number(e.currentTarget.value); }}
              >
                {#each RULE_INTERVAL_OPTIONS as opt}
                  <option value={opt.ms}>{opt.label}</option>
                {/each}
              </select>
            </div>
          {/if}
          {#if isWaveRule(editRuleType)}
            <div class="rule-pop-interval">
              <span class="rule-pop-interval-label">Min</span>
              <input
                class="rule-range-input"
                type="number"
                min="0"
                max="65535"
                value={editMinValue}
                oninput={(e) => { editMinValue = Number(e.currentTarget.value); }}
              />
            </div>
            <div class="rule-pop-interval">
              <span class="rule-pop-interval-label">Max</span>
              <input
                class="rule-range-input"
                type="number"
                min="0"
                max="65535"
                value={editMaxValue}
                oninput={(e) => { editMaxValue = Number(e.currentTarget.value); }}
              />
            </div>
          {/if}
          {#if editRuleType === "sawtooth" || editRuleType === "triangle"}
            <div class="rule-pop-interval">
              <span class="rule-pop-interval-label">Step</span>
              <input
                class="rule-range-input"
                type="number"
                min="1"
                max="65535"
                value={editStep}
                oninput={(e) => { editStep = Number(e.currentTarget.value); }}
              />
            </div>
          {/if}
          {#if editRuleType === "sine"}
            <div class="rule-pop-interval">
              <span class="rule-pop-interval-label">Period</span>
              <select
                class="rule-interval-select"
                value={editPeriodMs}
                onchange={(e) => { editPeriodMs = Number(e.currentTarget.value); }}
              >
                {#each RULE_INTERVAL_OPTIONS as opt}
                  <option value={opt.ms * 2}>{opt.label} x2</option>
                {/each}
              </select>
            </div>
          {/if}
          <div class="rule-pop-actions">
            <button class="rule-pop-apply" type="button" onclick={applyRule}>Apply</button>
            <button class="rule-pop-cancel" type="button" onclick={() => { ruleOpen = false; }}>Cancel</button>
            {#if entry.rule.type !== "none"}
              <button
                class="rule-pop-reset"
                type="button"
                onclick={() => {
                  onRuleChange(entry.address, {
                    type: "none",
                    intervalMs: entry.rule.intervalMs,
                    minValue: entry.rule.minValue,
                    maxValue: entry.rule.maxValue,
                    step: entry.rule.step,
                    periodMs: entry.rule.periodMs,
                  });
                  ruleOpen = false;
                }}
              >
                Disable
              </button>
            {/if}
          </div>
          <div class="rule-pop-foot">Tick: {fmtInterval(editIntervalMs)}</div>
        </div>
      {/if}
    </div>
  </span>

  <span class="delete-cell">
    <button class="delete-mini has-tip" type="button" onclick={() => onDelete(entry.address)} data-tip="Delete register">
      <X size={11} />
    </button>
  </span>
</div>

<style>
  .rt-row {
    /* label | addr | desired | rule | delete */
    grid-template-columns: minmax(140px, 1fr) 64px 110px 160px 52px;
    min-width: 520px;
  }

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

  .rule-pop-presets {
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
  }

  .rule-preset-btn {
    flex: 1;
    height: 22px;
    border: 1px solid var(--c-border);
    border-radius: 5px;
    background: var(--c-surface-2);
    color: var(--c-text-2);
    font: inherit;
    font-size: 0.67rem;
    cursor: pointer;
  }

  .rule-preset-btn:hover {
    border-color: var(--c-border-strong);
    color: var(--c-text-1);
  }

  .rule-preset-btn.active {
    border-color: color-mix(in srgb, var(--c-accent) 45%, var(--c-border));
    background: color-mix(in srgb, var(--c-accent) 14%, var(--c-surface-2));
    color: var(--c-accent);
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

  .rule-range-input {
    height: 26px;
    width: 100%;
    padding: 0 6px;
    border: 1px solid var(--c-border);
    border-radius: 5px;
    background: var(--c-surface-2);
    color: var(--c-text-1);
    font: inherit;
    font-size: 0.72rem;
  }

  .rule-pop-foot {
    margin-top: 6px;
    font-size: 0.65rem;
    color: var(--c-text-3, var(--c-text-2));
    opacity: 0.6;
  }

  .rule-pop-actions {
    display: flex;
    gap: 6px;
  }

  .rule-pop-apply,
  .rule-pop-cancel,
  .rule-pop-reset {
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

  .rule-pop-reset {
    border: 1px solid color-mix(in srgb, var(--c-danger, #e06c6c) 30%, var(--c-border));
    background: var(--c-surface-2);
    color: var(--c-danger, #e06c6c);
  }

  .rule-pop-reset:hover {
    border-color: var(--c-danger, #e06c6c);
  }
</style>
