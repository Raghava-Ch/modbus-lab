<svelte:options runes={true} />

<script lang="ts">
  import PageShell from "./PageShell.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";
  import SectionHeader from "../shared/SectionHeader.svelte";
  import { connectionState } from "../../state/connection.svelte";
  import {
    applyCustomFramePreset,
    clearCustomFrameResult,
    customFramePresets,
    customFrameState,
    sendCustomFrame,
    setCustomFrameMode,
    setCustomFunctionCode,
    setCustomPayloadHex,
    setCustomRawHex,
  } from "../../state/custom-frame.svelte";

  const connected = $derived(connectionState.status === "connected");
  const response = $derived(customFrameState.response);

  const protocolHint = $derived.by(() => {
    if (connectionState.protocol === "tcp") {
      return "TCP mode: MBAP is generated automatically. Enter PDU only.";
    }

    if (connectionState.protocol === "serial-rtu") {
      return "Serial RTU mode: CRC is added/validated automatically. Enter PDU only.";
    }

    return "Serial ASCII mode: ASCII envelope and LRC are added/validated automatically. Enter PDU only.";
  });
</script>

<PageShell title="Custom Frame" feature="Raw Modbus PDU builder" icon="file-text">
  {#snippet children()}
    {#if !connected}
      <div class="disconnected-banner" role="alert">
        <span class="banner-icon">⚠</span>
        <span class="banner-text">Not connected — go to <strong>Connection</strong> and connect to a device before using custom-frame operations.</span>
      </div>
    {/if}

    <section>
      <SectionHeader title="Frame Builder" subtitle="Function + payload or raw bytes" />
      <PanelFrame>
        {#snippet children()}
          <div class="presets">
            {#each customFramePresets as preset (preset.id)}
              <button
                type="button"
                class="preset-btn"
                onclick={() => applyCustomFramePreset(preset.id)}
                disabled={customFrameState.pending}
                data-tip={preset.description}
                aria-label={preset.description}
              >
                {preset.label}
              </button>
            {/each}
          </div>

          <div class="controls">
            <label>
              Mode
              <select
                value={customFrameState.mode}
                onchange={(e) => setCustomFrameMode((e.currentTarget as HTMLSelectElement).value as "function-payload" | "raw-bytes")}
              >
                <option value="function-payload">Function code + payload</option>
                <option value="raw-bytes">Raw bytes (first byte = function)</option>
              </select>
            </label>

            {#if customFrameState.mode === "function-payload"}
              <label>
                Function code (0-255)
                <input
                  type="number"
                  min="0"
                  max="255"
                  value={customFrameState.functionCode}
                  onchange={(e) => setCustomFunctionCode(Number((e.currentTarget as HTMLInputElement).value))}
                />
              </label>

              <label class="wide">
                Payload hex
                <textarea
                  rows="3"
                  value={customFrameState.payloadHex}
                  placeholder="00000001"
                  oninput={(e) => setCustomPayloadHex((e.currentTarget as HTMLTextAreaElement).value)}
                ></textarea>
              </label>
            {:else}
              <label class="wide">
                Raw bytes hex
                <textarea
                  rows="3"
                  value={customFrameState.rawHex}
                  placeholder="0300000001"
                  oninput={(e) => setCustomRawHex((e.currentTarget as HTMLTextAreaElement).value)}
                ></textarea>
              </label>
            {/if}
          </div>

          <div class="hint" role="note">{protocolHint}</div>

          {#if customFrameState.warnings.length > 0}
            <ul class="warnings">
              {#each customFrameState.warnings as warning, i (`w-${i}`)}
                <li>{warning}</li>
              {/each}
            </ul>
          {/if}

          {#if customFrameState.error}
            <div class="error">{customFrameState.error}</div>
          {/if}

          <div class="actions">
            <button type="button" onclick={() => void sendCustomFrame()} disabled={!connected || customFrameState.pending}>
              {customFrameState.pending ? "Sending..." : "Send frame"}
            </button>
            <button type="button" class="ghost" onclick={clearCustomFrameResult} disabled={customFrameState.pending}>
              Clear result
            </button>
          </div>
        {/snippet}
      </PanelFrame>
    </section>

    {#if response}
      <section>
        <SectionHeader title="Response" subtitle="Raw and parsed summary" />
        <PanelFrame>
          {#snippet children()}
            <div class="result-grid">
              <div>
                <strong>Function</strong>
                <div class="mono">0x{response?.functionCode.toString(16).padStart(2, "0").toUpperCase()} ({response?.functionName})</div>
              </div>
              <div>
                <strong>Request bytes</strong>
                <div class="mono">{response?.requestHex || "(empty payload)"}</div>
              </div>
              <div>
                <strong>Response bytes</strong>
                <div class="mono">{response?.responseHex || "(empty response payload)"}</div>
              </div>
              <div>
                <strong>Request summary</strong>
                <div>{response?.requestSummary}</div>
              </div>
              <div>
                <strong>Response summary</strong>
                <div>{response?.responseSummary}</div>
              </div>
              {#if response?.responseAscii}
                <div>
                  <strong>ASCII</strong>
                  <div class="mono">{response?.responseAscii}</div>
                </div>
              {/if}
            </div>
          {/snippet}
        </PanelFrame>
      </section>
    {/if}
  {/snippet}
</PageShell>

<style>
  .disconnected-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border: 1px solid color-mix(in srgb, var(--c-warn, #f0a500) 35%, var(--c-border));
    border-radius: 8px;
    background: color-mix(in srgb, var(--c-warn, #f0a500) 8%, var(--c-surface-2));
    color: var(--c-text-1);
    font-size: 0.8rem;
    margin-bottom: 12px;
  }

  .banner-icon {
    flex-shrink: 0;
    font-size: 1rem;
    line-height: 1;
  }

  .banner-text strong {
    color: var(--c-accent);
  }

  .controls {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(2, minmax(180px, 1fr));
  }

  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
  }

  .preset-btn {
    border: 1px solid var(--c-border);
    border-radius: 7px;
    background: color-mix(in srgb, var(--c-surface-2) 86%, var(--c-surface-3));
    color: var(--c-text-1);
    padding: 6px 10px;
    font-size: 0.75rem;
    transition: background 120ms ease, border-color 120ms ease;
  }

  .preset-btn:hover {
    border-color: var(--c-border-strong);
    background: color-mix(in srgb, var(--c-accent) 10%, var(--c-surface-2));
  }

  .controls label {
    display: grid;
    gap: 6px;
    font-size: 0.82rem;
    color: var(--c-text-2);
  }

  .controls .wide {
    grid-column: 1 / -1;
  }

  .controls input,
  .controls select,
  .controls textarea {
    width: 100%;
    background: var(--c-surface-2);
    border: 1px solid var(--c-border);
    color: var(--c-text-1);
    border-radius: 6px;
    padding: 7px 9px;
    font: inherit;
  }

  .controls textarea {
    resize: vertical;
    min-height: 72px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .hint {
    margin-top: 10px;
    font-size: 0.78rem;
    color: var(--c-text-2);
  }

  .warnings {
    margin: 10px 0 0;
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--c-warn) 35%, var(--c-border));
    background: color-mix(in srgb, var(--c-warn) 8%, var(--c-surface-2));
    color: var(--c-text-1);
    font-size: 0.8rem;
  }

  .error {
    margin-top: 10px;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--c-error) 35%, var(--c-border));
    background: color-mix(in srgb, var(--c-error) 10%, var(--c-surface-2));
    color: var(--c-text-1);
    font-size: 0.8rem;
  }

  .actions {
    margin-top: 12px;
    display: flex;
    gap: 8px;
  }

  .actions button.ghost {
    background: transparent;
    border: 1px solid var(--c-border);
    color: var(--c-text-1);
  }

  .result-grid {
    display: grid;
    gap: 12px;
  }

  .mono {
    margin-top: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.78rem;
    line-height: 1.35;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  @media (max-width: 840px) {
    .controls {
      grid-template-columns: 1fr;
    }
  }
</style>
