<svelte:options runes={true} />

<script lang="ts">
  import { untrack } from "svelte";
  import { navigationState } from "../../../state/navigation.svelte";
  import { clearRegisterDetails, registerDetailsState } from "../../../state/register-details.svelte";
  import {
    holdingRegisterState,
    readHoldingRegister,
    writeHoldingRegister,
    setHoldingRegisterDesiredValue,
  } from "../../../state/holding-registers.svelte";
  import { inputRegisterState, readInputRegister } from "../../../state/input-registers.svelte";
  import { formatAddressWithSettings } from "../../../state/settings.svelte";

  let { inline = false } = $props<{ inline?: boolean }>();

  const selectedHolding = $derived(
    registerDetailsState.kind === "holding" && registerDetailsState.address !== null
      ? holdingRegisterState.entries.find((e) => e.address === registerDetailsState.address) ?? null
      : null,
  );

  const selectedInput = $derived(
    registerDetailsState.kind === "input" && registerDetailsState.address !== null
      ? inputRegisterState.entries.find((e) => e.address === registerDetailsState.address) ?? null
      : null,
  );

  const selectedKind = $derived(registerDetailsState.kind);
  const selectedAddress = $derived(registerDetailsState.address);

  const visible = $derived(
    navigationState.activeTab === "holding-registers" || navigationState.activeTab === "input-registers",
  );

  /** Returns 16-element array, index 0 = bit 15 (MSB) */
  function getBits(value: number): boolean[] {
    const v = value & 0xffff;
    return Array.from({ length: 16 }, (_, i) => ((v >> (15 - i)) & 1) === 1);
  }

  function bitsToValue(bits: boolean[]): number {
    return bits.reduce((acc, bit, i) => acc | (bit ? 1 << (15 - i) : 0), 0);
  }

  function formatTimestamp(ms: number | null): string {
    if (!ms) return "—";
    const diff = Date.now() - ms;
    if (diff < 5000) return "just now";
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return new Date(ms).toLocaleTimeString();
  }

  function toggleDesiredBit(bitIndex: number): void {
    if (!selectedHolding) return;
    const bits = getBits(selectedHolding.desiredValue);
    bits[bitIndex] = !bits[bitIndex];
    setHoldingRegisterDesiredValue(selectedHolding.address, bitsToValue(bits));
  }

  async function handleRead(): Promise<void> {
    if (selectedKind === "holding" && selectedAddress !== null) {
      await readHoldingRegister(selectedAddress);
    } else if (selectedKind === "input" && selectedAddress !== null) {
      await readInputRegister(selectedAddress);
    }
  }

  async function handleWrite(): Promise<void> {
    if (selectedKind === "holding" && selectedAddress !== null) {
      await writeHoldingRegister(selectedAddress);
    }
  }

  let desiredRaw = $state("0");

  // Sync the input when the selected register ADDRESS changes (initial load).
  $effect(() => {
    const addr = selectedHolding?.address; // tracked — fires when selection changes
    const initVal = untrack(() => selectedHolding?.desiredValue ?? 0);
    desiredRaw = String(initVal);
    // suppress unused-variable warning
    void addr;
  });

  // Sync input when LEDs are clicked (user-initiated state change via toggleDesiredBit)
  $effect(() => {
    if (!selectedHolding) return;
    // Only sync if input and state are out of sync (LED was toggled)
    const stateValue = selectedHolding.desiredValue;
    const inputNum = parseInt(desiredRaw, 10);
    // Only overwrite if truly diverged (handle LED toggle)
    if (!Number.isFinite(inputNum) || inputNum !== stateValue) {
      desiredRaw = String(stateValue);
    }
  });

  function handleDesiredInput(e: Event): void {
    const target = e.currentTarget as HTMLInputElement;
    const raw = target.value;
    desiredRaw = raw;
    
    // Only update state if valid
    if (raw.trim() === "") return;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 65535 && selectedHolding) {
      setHoldingRegisterDesiredValue(selectedHolding.address, n);
    }
  }

  function handleDesiredKeydown(e: KeyboardEvent): void {
    if (!selectedHolding) return;

    if (e.key === "Enter") {
      commitDesired();
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      const current = parseInt(desiredRaw, 10) || 0;
      const next = Math.min(65535, current + 1);
      desiredRaw = String(next);
      setHoldingRegisterDesiredValue(selectedHolding.address, next);
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const current = parseInt(desiredRaw, 10) || 0;
      const next = Math.max(0, current - 1);
      desiredRaw = String(next);
      setHoldingRegisterDesiredValue(selectedHolding.address, next);
      return;
    }
  }

  function commitDesired(): void {
    if (!selectedHolding) return;
    const n = parseInt(desiredRaw, 10);
    if (Number.isFinite(n) && n >= 0 && n <= 65535) {
      setHoldingRegisterDesiredValue(selectedHolding.address, n);
    } else {
      desiredRaw = String(selectedHolding.desiredValue);
    }
  }

  $effect(() => {
    if (registerDetailsState.kind === "holding" && selectedHolding === null) clearRegisterDetails();
    if (registerDetailsState.kind === "input" && selectedInput === null) clearRegisterDetails();
  });
</script>

<div class="rdp" class:inline-mode={inline}>
  {#if !visible}
    <p class="rdp-empty">Details are available on Holding Registers and Input Registers pages.</p>
  {:else if selectedKind === "holding" && selectedHolding}
    {@const h = selectedHolding}
    {@const statusOk = !h.writeError && h.desiredValue === h.slaveValue}
    {@const statusUnsynced = !h.writeError && h.desiredValue !== h.slaveValue}

    <header class="rdp-head">
      <span class="type-badge hr-badge">HR</span>
      <span class="addr-text">{formatAddressWithSettings(h.address)}</span>
      {#if h.label}<span class="reg-label">{h.label}</span>{/if}
      <div class="spacer"></div>
      <span
        class="status-pill"
        class:ok={statusOk}
        class:warn={statusUnsynced}
        class:err={!!h.writeError}
      >{h.writeError ?? (statusUnsynced ? "Unsynced" : "OK")}</span>
      <button class="close-btn" type="button" onclick={clearRegisterDetails} aria-label="Clear selection">✕</button>
    </header>

    <div class="rdp-body">
      <!-- READ -->
      <div class="reg-block">
        <div class="block-header">
          <span class="block-title">Read</span>
          <span class="num-primary">{h.slaveValue}</span>
          <span class="num-hex">0x{h.slaveValue.toString(16).toUpperCase().padStart(4, "0")}</span>
        </div>
        <div class="bit-strip read-strip" role="group" aria-label="Read value bits">
          {#each [0, 1, 2, 3] as nibble}
            <div class="nibble">
              {#each [0, 1, 2, 3] as b}
                {@const idx = nibble * 4 + b}
                {@const on = getBits(h.slaveValue)[idx]}
                <div class="bit-led" class:on>
                  <div class="led-dot"></div>
                  <span class="bit-num">{15 - idx}</span>
                </div>
              {/each}
            </div>
          {/each}
        </div>
      </div>

      <div class="block-divider"></div>

      <!-- DESIRED -->
      <div class="reg-block">
        <div class="block-header">
          <span class="block-title">Desired</span>
          <div class="num-input-wrapper">
            <input
              class="num-input"
              type="text"
              inputmode="numeric"
              placeholder="0"
              value={desiredRaw}
              oninput={handleDesiredInput}
              onblur={commitDesired}
              onkeydown={handleDesiredKeydown}
              spellcheck="false"
            />
            <div class="num-spinners">
              <button
                class="spinner-btn spinner-up has-tip"
                type="button"
                aria-label="Increment"
                data-tip="Increment (↑)"
                onclick={() => {
                  if (selectedHolding) {
                    const current = parseInt(desiredRaw, 10) || 0;
                    const next = Math.min(65535, current + 1);
                    desiredRaw = String(next);
                    setHoldingRegisterDesiredValue(selectedHolding.address, next);
                  }
                }}
              >▲</button>
              <button
                class="spinner-btn spinner-down has-tip"
                type="button"
                aria-label="Decrement"
                data-tip="Decrement (↓)"
                onclick={() => {
                  if (selectedHolding) {
                    const current = parseInt(desiredRaw, 10) || 0;
                    const next = Math.max(0, current - 1);
                    desiredRaw = String(next);
                    setHoldingRegisterDesiredValue(selectedHolding.address, next);
                  }
                }}
              >▼</button>
            </div>
          </div>
          <span class="num-hex">0x{h.desiredValue.toString(16).toUpperCase().padStart(4, "0")}</span>
        </div>
        <div class="bit-strip desired-strip" role="group" aria-label="Desired bits — click to toggle">
          {#each [0, 1, 2, 3] as nibble}
            <div class="nibble">
              {#each [0, 1, 2, 3] as b}
                {@const idx = nibble * 4 + b}
                {@const on = getBits(h.desiredValue)[idx]}
                <button
                  class="bit-led clickable has-tip"
                  class:on
                  type="button"
                  aria-label="Toggle bit {15 - idx}"
                  data-tip="Toggle bit {15 - idx}"
                  onclick={() => toggleDesiredBit(idx)}
                >
                  <div class="led-dot"></div>
                  <span class="bit-num">{15 - idx}</span>
                </button>
              {/each}
            </div>
          {/each}
        </div>
      </div>
    </div>

    <footer class="rdp-foot">
      <div class="meta-items">
        <span class="meta-item">
          <span class="mk">Last Read</span>
          <span class="mv">{formatTimestamp(h.lastReadAt)}</span>
        </span>
        <span class="meta-item">
          <span class="mk">Last Write</span>
          <span class="mv">{formatTimestamp(h.lastWriteAt)}</span>
        </span>
      </div>
      <div class="act-row">
        <button class="act-btn read-btn" type="button" onclick={handleRead} disabled={h.pending}>
          {h.pending ? "…" : "Read FC03"}
        </button>
        <button class="act-btn write-btn" type="button" onclick={handleWrite} disabled={h.pending}>
          Write FC06
        </button>
      </div>
    </footer>

  {:else if selectedKind === "input" && selectedInput}
    {@const inp = selectedInput}

    <header class="rdp-head">
      <span class="type-badge ir-badge">IR</span>
      <span class="addr-text">{formatAddressWithSettings(inp.address)}</span>
      {#if inp.label}<span class="reg-label">{inp.label}</span>{/if}
      <div class="spacer"></div>
      <span class="status-pill" class:ok={!inp.readError} class:err={!!inp.readError}>
        {inp.readError ?? "OK"}
      </span>
      <button class="close-btn" type="button" onclick={clearRegisterDetails} aria-label="Clear selection">✕</button>
    </header>

    <div class="rdp-body single-block">
      <div class="reg-block">
        <div class="block-header">
          <span class="block-title">Value</span>
          <span class="num-primary">{inp.value}</span>
          <span class="num-hex">0x{inp.value.toString(16).toUpperCase().padStart(4, "0")}</span>
        </div>
        <div class="bit-strip read-strip" role="group" aria-label="Value bits">
          {#each [0, 1, 2, 3] as nibble}
            <div class="nibble">
              {#each [0, 1, 2, 3] as b}
                {@const idx = nibble * 4 + b}
                {@const on = getBits(inp.value)[idx]}
                <div class="bit-led" class:on>
                  <div class="led-dot"></div>
                  <span class="bit-num">{15 - idx}</span>
                </div>
              {/each}
            </div>
          {/each}
        </div>
      </div>
    </div>

    <footer class="rdp-foot">
      <div class="meta-items">
        <span class="meta-item">
          <span class="mk">Last Read</span>
          <span class="mv">{formatTimestamp(inp.lastReadAt)}</span>
        </span>
      </div>
      <div class="act-row">
        <button class="act-btn read-btn" type="button" onclick={handleRead} disabled={inp.pending}>
          {inp.pending ? "…" : "Read FC04"}
        </button>
      </div>
    </footer>

  {:else}
    <p class="rdp-empty">Select a table row or card to inspect a register.</p>
  {/if}
</div>

<style>
  .rdp {
    display: flex;
    flex-direction: column;
    flex: 1;
    height: 100%;
    min-width: 0;
    overflow: hidden;
    background: transparent;
  }

  /* ── Header ─────────────────────────────────────── */
  .rdp-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-bottom: 1px solid var(--c-border);
    flex-shrink: 0;
    height: 32px;
  }

  .type-badge {
    font-size: 0.55rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 2px 5px;
    border-radius: 3px;
  }
  .hr-badge {
    background: color-mix(in srgb, var(--c-accent) 18%, transparent);
    color: var(--c-accent);
  }
  .ir-badge {
    background: color-mix(in srgb, var(--c-ok) 18%, transparent);
    color: var(--c-ok);
  }

  .addr-text {
    font-size: 0.75rem;
    font-weight: 700;
    font-family: monospace;
    color: var(--c-text-1);
  }

  .reg-label {
    font-size: 0.65rem;
    color: var(--c-text-2);
  }

  .spacer {
    flex: 1;
  }

  .status-pill {
    font-size: 0.55rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    padding: 2px 6px;
    border-radius: 8px;
    border: 1px solid transparent;
  }
  .status-pill.ok {
    background: color-mix(in srgb, var(--c-ok) 12%, transparent);
    color: var(--c-ok);
    border-color: color-mix(in srgb, var(--c-ok) 30%, transparent);
  }
  .status-pill.warn {
    background: color-mix(in srgb, var(--c-warn) 12%, transparent);
    color: var(--c-warn);
    border-color: color-mix(in srgb, var(--c-warn) 30%, transparent);
  }
  .status-pill.err {
    background: color-mix(in srgb, var(--c-error) 12%, transparent);
    color: var(--c-error);
    border-color: color-mix(in srgb, var(--c-error) 30%, transparent);
  }

  .close-btn {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 3px;
    background: transparent;
    color: var(--c-text-2);
    font-size: 0.65rem;
    padding: 0;
    flex-shrink: 0;
  }
  .close-btn:hover {
    background: var(--c-surface-2);
    color: var(--c-text-1);
  }

  /* ── Body ────────────────────────────────────────── */
  .rdp-body {
    display: flex;
    flex-direction: row;
    gap: 0;
    padding: 10px 14px;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    align-items: flex-start;
  }

  .reg-block {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }

  .block-divider {
    width: 1px;
    align-self: stretch;
    background: var(--c-border);
    margin: 0 16px;
    flex-shrink: 0;
  }

  /* ── Value header row ───────────────────────────── */
  .block-header {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }

  .block-title {
    font-size: 0.62rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--c-text-2);
    min-width: 46px;
  }

  .num-primary {
    font-size: 1.4rem;
    font-weight: 700;
    font-family: monospace;
    color: var(--c-text-1);
    line-height: 1;
  }

  .num-input-wrapper {
    display: flex;
    align-items: stretch;
    border-radius: 5px;
    overflow: hidden;
    border: 1.5px solid var(--c-border);
    background: color-mix(in srgb, var(--c-surface-3) 60%, var(--c-accent) 8%);
    transition: border-color 100ms ease, background 100ms ease;
  }

  .num-input-wrapper:hover {
    border-color: color-mix(in srgb, var(--c-border-strong) 80%, var(--c-border));
    background: color-mix(in srgb, var(--c-surface-3) 75%, var(--c-accent) 12%);
  }

  .num-input-wrapper:focus-within {
    border-color: var(--c-accent);
    background: color-mix(in srgb, var(--c-surface-2) 70%, var(--c-accent) 14%);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--c-accent) 20%, transparent);
  }

  .num-input {
    flex: 1;
    min-width: 50px;
    height: 30px;
    padding: 0 6px;
    border: none;
    background: transparent;
    color: var(--c-text-1);
    font-family: monospace;
    font-size: 1.2rem;
    font-weight: 700;
    line-height: 1;
    text-align: right;
    cursor: text;
  }

  .num-input:focus {
    outline: none;
  }

  .num-spinners {
    display: flex;
    flex-direction: column;
    border-left: 1px solid color-mix(in srgb, var(--c-border) 50%, transparent);
  }

  .spinner-btn {
    flex: 1;
    width: 20px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--c-text-2);
    font-size: 0.6rem;
    cursor: pointer;
    transition: color 80ms, background 80ms;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .spinner-btn:hover {
    color: var(--c-text-1);
    background: color-mix(in srgb, var(--c-surface-2) 50%, transparent);
  }

  .spinner-btn:active {
    background: color-mix(in srgb, var(--c-accent) 18%, transparent);
  }

  .spinner-up {
    border-bottom: 1px solid color-mix(in srgb, var(--c-border) 30%, transparent);
  }

  /* ── Bit strip ──────────────────────────────────── */
  .bit-strip {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .nibble {
    display: flex;
    gap: 5px;
  }

  .bit-led {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    background: none;
    border: 0;
    padding: 0;
    cursor: default;
    font: inherit;
  }

  .bit-led.clickable {
    cursor: pointer;
  }
  .bit-led.clickable:hover .led-dot {
    border-color: color-mix(in srgb, var(--c-warn) 80%, transparent);
    transform: scale(1.15);
  }
  .bit-led.clickable:active .led-dot {
    transform: scale(0.92);
  }

  .led-dot {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--c-surface-3);
    border: 1.5px solid color-mix(in srgb, var(--c-border) 70%, transparent);
    transition:
      background 80ms,
      box-shadow 80ms,
      transform 60ms,
      border-color 80ms;
  }

  /* Read LED — green when ON */
  .read-strip .bit-led.on .led-dot {
    background: var(--c-ok);
    border-color: color-mix(in srgb, var(--c-ok) 60%, transparent);
    box-shadow: 0 0 6px color-mix(in srgb, var(--c-ok) 55%, transparent);
  }

  /* Desired LED — amber when ON */
  .desired-strip .bit-led.on .led-dot {
    background: var(--c-warn);
    border-color: color-mix(in srgb, var(--c-warn) 60%, transparent);
    box-shadow: 0 0 6px color-mix(in srgb, var(--c-warn) 55%, transparent);
  }

  .bit-num {
    font-size: 0.5rem;
    color: var(--c-text-2);
    font-family: monospace;
    line-height: 1;
    opacity: 0.7;
  }

  /* ── Footer ─────────────────────────────────────── */
  .rdp-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 2px 10px 3px;
    border-top: 1px solid var(--c-border);
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .meta-items {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }

  .meta-item {
    display: flex;
    gap: 4px;
    align-items: center;
    font-size: 0.62rem;
  }
  .mk {
    color: var(--c-text-2);
  }
  .mv {
    color: var(--c-text-1);
    font-family: monospace;
  }

  .act-row {
    display: flex;
    gap: 5px;
  }

  .act-btn {
    height: 26px;
    padding: 0 11px;
    border-radius: 5px;
    font-size: 0.7rem;
    font-weight: 600;
    font: inherit;
    font-size: 0.7rem;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--c-border);
    transition: background 80ms;
  }

  .read-btn {
    background: var(--c-surface-2);
    color: var(--c-text-1);
  }
  .read-btn:hover:not(:disabled) {
    background: var(--c-surface-3);
  }

  .write-btn {
    background: color-mix(in srgb, var(--c-accent) 14%, transparent);
    color: var(--c-accent);
    border-color: color-mix(in srgb, var(--c-accent) 35%, transparent);
  }
  .write-btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--c-accent) 24%, transparent);
  }

  .act-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* ── Empty states ────────────────────────────────── */
  .rdp-empty {
    padding: 14px 12px;
    font-size: 0.72rem;
    color: var(--c-text-2);
    margin: 0;
  }

  /* ── Responsive ─────────────────────────────────── */
  @media (max-width: 680px) {
    .rdp-body {
      flex-direction: column;
      overflow-y: auto;
    }
    .block-divider {
      width: auto;
      height: 1px;
      margin: 4px 0 8px;
    }
    .rdp-foot {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>
