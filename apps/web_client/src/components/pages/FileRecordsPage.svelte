<svelte:options runes={true} />

<script lang="ts">
  import { untrack } from "svelte";
  import {
    ChevronDown,
    ChevronUp,
    Copy,
    Download,
    Play,
    Plus,
    RefreshCw,
    Timer,
    Trash2,
    Upload,
  } from "lucide-svelte";
  import PageShell from "./PageShell.svelte";
  import PanelFrame from "../shared/PanelFrame.svelte";
  import SectionHeader from "../shared/SectionHeader.svelte";
  import { connectionState } from "../../state/connection.svelte";
  import {
    addFileRecordSegment,
    applyFileRecordExecution,
    clearFileRecordResult,
    clearFileRecordSegments,
    deleteFileRecordScenario,
    executeFileRecord,
    executeFileRecordSegment,
    exportCurrentFileRecordScenario,
    fileRecordState,
    importFileRecordScenarioJson,
    initFileRecordState,
    loadFileRecordScenario,
    removeFileRecordSegment,
    saveFileRecordScenario,
    setFileRecordMode,
    setFileRecordPollActive,
    setFileRecordPollInterval,
    setFileRecordSegmentNumber,
    setFileRecordSegmentWriteValues,
    teardownFileRecordState,
    duplicateFileRecordSegment,
  } from "../../state/file-records.svelte";

  const connected = $derived(connectionState.status === "connected");
  const activeExecution = $derived(fileRecordState.lastExecution);
  const isReadMode = $derived(fileRecordState.mode === "read");
  const pollIntervals: { value: number; label: string }[] = [
    { value: 500, label: "500 ms" },
    { value: 1000, label: "1 s" },
    { value: 2000, label: "2 s" },
    { value: 5000, label: "5 s" },
  ];

  let scenarioName = $state("");
  let scenarioJson = $state("");
  let scenarioPanelOpen = $state(false);
  let scenarioFileInput = $state<HTMLInputElement>();

  $effect(() => {
    untrack(() => {
      initFileRecordState();
    });

    return () => {
      teardownFileRecordState();
    };
  });

  function wordHex(value: number): string {
    return `0x${(value & 0xFFFF).toString(16).toUpperCase().padStart(4, "0")}`;
  }

  function handleExportScenario(): void {
    try {
      const content = exportCurrentFileRecordScenario();
      scenarioJson = content;
      const blob = new Blob([content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `modbus-scenario-${scenarioName.trim() || "untitled"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Failed to export scenario:", error);
    }
  }

  function handleImportScenario(): void {
    importFileRecordScenarioJson(scenarioJson);
  }

  function handleImportScenarioFile(event: Event): void {
    const target = event.target as HTMLInputElement;
    if (target.files && target.files[0]) {
      const file = target.files[0];
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target?.result as string;
        scenarioJson = text;
        importFileRecordScenarioJson(text);
        try {
          const parsed = JSON.parse(text);
          if (parsed?.scenario?.name) {
            scenarioName = parsed.scenario.name;
          }
        } catch {
          // ignore
        }
        target.value = "";
      };
      reader.readAsText(file);
    }
  }

  function handleSaveScenario(): void {
    saveFileRecordScenario(scenarioName);
  }

  function handleLoadScenario(name: string): void {
    loadFileRecordScenario(name);
    scenarioName = name;
  }

  function handleDeleteScenario(name: string): void {
    deleteFileRecordScenario(name);
    if (scenarioName === name) {
      scenarioName = "";
    }
  }

  function copyHex(text: string): void {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    void navigator.clipboard.writeText(text);
  }
</script>

<PageShell title="File Records" feature="FC 20/21 read-write" icon="file-text">
  {#snippet children()}
    {#if connectionState.status === "disconnected"}
      <div class="disconnected-banner" role="alert">
        <span class="banner-icon">⚠</span>
        <span class="banner-text">Not connected — go to <strong>Connection</strong> and connect to a device before using file-record operations.</span>
      </div>
    {/if}

    <section class="file-records-section">
      <SectionHeader title="Request Builder" subtitle={isReadMode ? "FC20 Read File Record" : "FC21 Write File Record"}>
        {#snippet actions()}
          <div class="mode-toggle" role="tablist" aria-label="File record mode">
            <button
              class="ctrl-btn"
              class:active={fileRecordState.mode === "read"}
              type="button"
              role="tab"
              aria-selected={fileRecordState.mode === "read"}
              onclick={() => setFileRecordMode("read")}
            >
              Read (FC20)
            </button>
            <button
              class="ctrl-btn"
              class:active={fileRecordState.mode === "write"}
              type="button"
              role="tab"
              aria-selected={fileRecordState.mode === "write"}
              onclick={() => setFileRecordMode("write")}
            >
              Write (FC21)
            </button>
          </div>
        {/snippet}
      </SectionHeader>

      <PanelFrame>
        {#snippet children()}
          <div class="builder-actions">
            <button class="ctrl-btn" type="button" onclick={addFileRecordSegment}>
              <Plus size={13} />
              <span>Add Segment</span>
            </button>
            <button class="ctrl-btn" type="button" onclick={clearFileRecordSegments}>
              <Trash2 size={13} />
              <span>Reset Segments</span>
            </button>

            {#if isReadMode}
              <select
                class="ctrl-select"
                value={fileRecordState.pollInterval}
                onchange={(e) => setFileRecordPollInterval(Number(e.currentTarget.value))}
                title="Poll interval"
              >
                {#each pollIntervals as item (item.value)}
                  <option value={item.value}>{item.label}</option>
                {/each}
              </select>
              <button
                class="ctrl-btn"
                class:active={fileRecordState.pollActive}
                type="button"
                disabled={!connected}
                onclick={() => setFileRecordPollActive(!fileRecordState.pollActive)}
              >
                {#if fileRecordState.pollActive}
                  <Timer size={13} />
                  <span>Polling</span>
                {:else}
                  <Play size={13} />
                  <span>Poll</span>
                {/if}
              </button>
            {/if}

            <button
              class="ctrl-btn"
              type="button"
              disabled={!connected || fileRecordState.pending}
              onclick={() => void executeFileRecord()}
            >
              <RefreshCw size={13} />
              <span>{fileRecordState.pending ? "Running..." : "Execute"}</span>
            </button>

            <button class="ctrl-btn" type="button" onclick={clearFileRecordResult} disabled={fileRecordState.pending}>
              Clear Result
            </button>
          </div>

          {#if fileRecordState.warnings.length > 0}
            <ul class="warnings">
              {#each fileRecordState.warnings as warning, idx (`warn-${idx}`)}
                <li>{warning}</li>
              {/each}
            </ul>
          {/if}

          {#if fileRecordState.error}
            <div class="error-note" role="alert">{fileRecordState.error}</div>
          {/if}

          <div class="segment-list" role="list" aria-label="File record segments">
            {#each fileRecordState.segments as segment, idx (segment.id)}
              <article class="segment-card" role="listitem">
                <header class="segment-head">
                  <strong>Segment {idx + 1}</strong>
                  <div class="segment-head-actions">
                    <button
                      class="ctrl-btn"
                      type="button"
                      title={fileRecordState.mode === "read" ? "Read only this segment" : "Write only this segment"}
                      disabled={!connected || fileRecordState.pending}
                      onclick={() => void executeFileRecordSegment(segment.id)}
                    >
                      <Play size={13} />
                      <span>Run</span>
                    </button>
                    <button class="ctrl-btn icon-only" type="button" title="Duplicate segment" onclick={() => duplicateFileRecordSegment(segment.id)}>
                      <Copy size={13} />
                    </button>
                    <button class="ctrl-btn icon-only" type="button" title="Remove segment" onclick={() => removeFileRecordSegment(segment.id)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </header>

                <div class="segment-grid">
                  <label>
                    File Number
                    <input
                      type="number"
                      min="0"
                      max="65535"
                      value={segment.fileNumber}
                      oninput={(e) => setFileRecordSegmentNumber(segment.id, "fileNumber", Number(e.currentTarget.value))}
                    />
                  </label>

                  <label>
                    Record Number
                    <input
                      type="number"
                      min="0"
                      max="65535"
                      value={segment.recordNumber}
                      oninput={(e) => setFileRecordSegmentNumber(segment.id, "recordNumber", Number(e.currentTarget.value))}
                    />
                  </label>

                  <label>
                    Word Count
                    <input
                      type="number"
                      min="1"
                      max="120"
                      value={segment.wordCount}
                      oninput={(e) => setFileRecordSegmentNumber(segment.id, "wordCount", Number(e.currentTarget.value))}
                    />
                  </label>

                  {#if fileRecordState.mode === "write"}
                    <label class="wide">
                      Values (decimal or hex, e.g. 10, 0x000A)
                      <textarea
                        rows="2"
                        value={segment.writeValuesText}
                        oninput={(e) => setFileRecordSegmentWriteValues(segment.id, e.currentTarget.value)}
                        placeholder="1, 2, 3"
                      ></textarea>
                    </label>
                  {/if}
                </div>
              </article>
            {/each}
          </div>
        {/snippet}
      </PanelFrame>
    </section>

    <section class="file-records-section">
      <SectionHeader title="Scenarios" subtitle="Save, load, import, and export request sets">
        {#snippet actions()}
          <button class="ctrl-btn" type="button" onclick={() => { scenarioPanelOpen = !scenarioPanelOpen; }}>
            <span>Scenario Tools</span>
            {#if scenarioPanelOpen}<ChevronUp size={12} />{:else}<ChevronDown size={12} />{/if}
          </button>
        {/snippet}
      </SectionHeader>

      {#if scenarioPanelOpen}
        <PanelFrame>
          {#snippet children()}
            <div class="scenario-tools">
              <div class="scenario-save-row">
                <input
                  class="scenario-name"
                  type="text"
                  value={scenarioName}
                  placeholder="Scenario name"
                  oninput={(e) => { scenarioName = e.currentTarget.value; }}
                />
                <button class="ctrl-btn" type="button" onclick={handleSaveScenario}>Save</button>
                <button class="ctrl-btn" type="button" onclick={handleExportScenario}>
                  <Download size={13} />
                  <span>Export JSON</span>
                </button>
                <button class="ctrl-btn" type="button" onclick={() => scenarioFileInput?.click()}>
                  <Upload size={13} />
                  <span>Import JSON File</span>
                </button>
                <button class="ctrl-btn" type="button" onclick={handleImportScenario}>
                  Parse Pasted JSON
                </button>
                <input
                  type="file"
                  accept=".json"
                  bind:this={scenarioFileInput}
                  onchange={handleImportScenarioFile}
                  style="display: none;"
                />
              </div>

              <div class="scenario-list" role="list" aria-label="Saved scenarios">
                {#if fileRecordState.scenarios.length === 0}
                  <span class="subtle">No saved scenarios yet.</span>
                {:else}
                  {#each fileRecordState.scenarios as scenario (scenario.name)}
                    <div class="scenario-chip" role="listitem">
                      <span>{scenario.name}</span>
                      <div class="scenario-chip-actions">
                        <button class="ctrl-btn" type="button" onclick={() => handleLoadScenario(scenario.name)}>Load</button>
                        <button class="ctrl-btn" type="button" onclick={() => handleDeleteScenario(scenario.name)}>Delete</button>
                      </div>
                    </div>
                  {/each}
                {/if}
              </div>

              <textarea
                class="scenario-json"
                rows="6"
                value={scenarioJson}
                oninput={(e) => { scenarioJson = e.currentTarget.value; }}
                placeholder="Scenario JSON"
              ></textarea>
            </div>
          {/snippet}
        </PanelFrame>
      {/if}
    </section>

    <section class="file-records-section">
      <SectionHeader title="Result" subtitle="Parsed segments and raw bytes" />
      <PanelFrame>
        {#snippet children()}
          {#if !activeExecution}
            <p class="subtle">No execution yet.</p>
          {:else}
            <div class="execution-meta">
              <span class="meta-pill">{activeExecution.mode === "read" ? "FC20" : "FC21"}</span>
              <span class="meta-pill">{activeExecution.mode.toUpperCase()}</span>
              <span class="meta-pill">{activeExecution.durationMs} ms</span>
              <span class="meta-pill">{new Date(activeExecution.startedAt).toLocaleTimeString()}</span>
            </div>

            <div class="result-grid">
              <div>
                <div class="result-label">Request Summary</div>
                <div class="result-text">{activeExecution.requestSummary}</div>
              </div>
              <div>
                <div class="result-label">Response Summary</div>
                <div class="result-text">{activeExecution.responseSummary}</div>
              </div>
              <div>
                <div class="result-label">Request Hex</div>
                <div class="hex-box">{activeExecution.requestHex}</div>
                <button class="ctrl-btn tiny" type="button" onclick={() => copyHex(activeExecution.requestHex)}>Copy</button>
              </div>
              <div>
                <div class="result-label">Response Hex</div>
                <div class="hex-box">{activeExecution.responseHex}</div>
                <button class="ctrl-btn tiny" type="button" onclick={() => copyHex(activeExecution.responseHex)}>Copy</button>
              </div>
            </div>

            <div class="parsed-list" role="list" aria-label="Parsed segment values">
              {#if activeExecution.parsedSegments.length === 0}
                <p class="subtle">No parsed segment data in response.</p>
              {:else}
                {#each activeExecution.parsedSegments as parsed (parsed.index)}
                  <div class="parsed-item" role="listitem">
                    <strong>
                      Segment {parsed.index + 1}: F{parsed.fileNumber} / R{parsed.recordNumber}
                    </strong>
                    <span class="subtle">ref=0x{parsed.referenceType.toString(16).toUpperCase().padStart(2, "0")}, words={parsed.wordCount}</span>
                    <div class="word-chips">
                      {#each parsed.values as value, valueIndex (`${parsed.index}:${valueIndex}`)}
                        <span class="word-chip">{value} ({wordHex(value)})</span>
                      {/each}
                    </div>
                  </div>
                {/each}
              {/if}
            </div>
          {/if}
        {/snippet}
      </PanelFrame>
    </section>

    <section class="file-records-section">
      <SectionHeader title="Execution History" subtitle="Recent FC20/FC21 runs" />
      <PanelFrame>
        {#snippet children()}
          {#if fileRecordState.history.length === 0}
            <p class="subtle">No history yet.</p>
          {:else}
            <div class="history-list" role="list" aria-label="Execution history">
              {#each fileRecordState.history as item (item.id)}
                <div role="listitem">
                  <button class="history-item" type="button" onclick={() => applyFileRecordExecution(item.id)}>
                    <span class="mono">{new Date(item.startedAt).toLocaleTimeString()}</span>
                    <span>{item.mode === "read" ? "FC20" : "FC21"} {item.mode.toUpperCase()}</span>
                    <span>{item.durationMs} ms</span>
                    <span>{item.parsedSegments.length} segments</span>
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        {/snippet}
      </PanelFrame>
    </section>
  {/snippet}
</PageShell>

<style>
  .file-records-section {
    display: grid;
    gap: 10px;
    margin-bottom: 8px;
  }

  .disconnected-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--c-warn, #f0a500) 35%, var(--c-border));
    background: color-mix(in srgb, var(--c-warn, #f0a500) 8%, var(--c-surface-2));
    color: var(--c-text-1);
    margin-bottom: 12px;
    font-size: 0.8rem;
  }

  .banner-icon {
    flex-shrink: 0;
    font-size: 1rem;
    line-height: 1;
    font-weight: 700;
  }

  .builder-actions,
  .mode-toggle {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  .ctrl-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--c-border) 78%, transparent);
    background: color-mix(in srgb, var(--c-surface-2) 82%, transparent);
    color: var(--c-text-1);
    font-size: 0.76rem;
    font-weight: 600;
    cursor: pointer;
  }

  .ctrl-btn.active {
    border-color: color-mix(in srgb, var(--c-accent) 58%, var(--c-border));
    background: color-mix(in srgb, var(--c-accent) 12%, var(--c-surface-2));
  }

  .ctrl-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .ctrl-btn.icon-only {
    width: 30px;
    height: 30px;
    padding: 0;
  }

  .ctrl-btn.tiny {
    margin-top: 6px;
    font-size: 0.7rem;
    padding: 4px 8px;
  }

  .ctrl-select,
  .segment-grid input,
  .segment-grid textarea,
  .scenario-name,
  .scenario-json {
    border-radius: 8px;
    border: 1px solid var(--c-border);
    background: color-mix(in srgb, var(--c-surface-2) 82%, transparent);
    color: var(--c-text-1);
    padding: 7px 9px;
    font-size: 0.78rem;
    font: inherit;
  }

  .segment-list,
  .parsed-list,
  .scenario-list {
    display: grid;
    gap: 8px;
    margin-top: 10px;
  }

  .history-list {
    display: grid;
    gap: 8px;
    margin-top: 10px;
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    align-items: stretch;
  }

  .segment-card,
  .parsed-item,
  .scenario-chip {
    border: 1px solid color-mix(in srgb, var(--c-border) 70%, transparent);
    border-radius: 10px;
    padding: 10px;
    background: color-mix(in srgb, var(--c-surface-2) 52%, transparent);
  }

  .segment-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .segment-head-actions {
    display: inline-flex;
    gap: 6px;
  }

  .segment-grid {
    display: grid;
    gap: 8px;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  }

  .segment-grid label {
    display: grid;
    gap: 5px;
    font-size: 0.72rem;
    color: var(--c-text-2);
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .segment-grid .wide {
    grid-column: 1 / -1;
  }

  .segment-grid textarea,
  .scenario-json {
    resize: vertical;
    min-height: 70px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  }

  .warnings {
    margin: 10px 0 0;
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--c-warn) 35%, var(--c-border));
    background: color-mix(in srgb, var(--c-warn) 8%, var(--c-surface-2));
    color: var(--c-text-1);
    font-size: 0.76rem;
  }

  .error-note {
    margin-top: 10px;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--c-error) 35%, var(--c-border));
    background: color-mix(in srgb, var(--c-error) 10%, var(--c-surface-2));
    color: var(--c-text-1);
    font-size: 0.78rem;
  }

  .execution-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
  }

  .meta-pill {
    border: 1px solid color-mix(in srgb, var(--c-border) 72%, transparent);
    border-radius: 999px;
    padding: 3px 8px;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .result-grid {
    display: grid;
    gap: 10px;
  }

  .result-label {
    font-size: 0.72rem;
    color: var(--c-text-2);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .result-text {
    margin-top: 4px;
    color: var(--c-text-1);
    font-size: 0.8rem;
  }

  .hex-box,
  .mono {
    margin-top: 4px;
    padding: 8px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, var(--c-border) 72%, transparent);
    background: color-mix(in srgb, var(--c-surface-2) 74%, transparent);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 0.74rem;
    overflow-wrap: anywhere;
  }

  .subtle {
    margin: 0;
    color: var(--c-text-2);
    font-size: 0.78rem;
  }

  .word-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }

  .word-chip {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, var(--c-border) 72%, transparent);
    padding: 3px 8px;
    font-size: 0.72rem;
    color: var(--c-text-1);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    background: color-mix(in srgb, var(--c-surface-3) 64%, transparent);
  }

  .history-item {
    border: 1px solid color-mix(in srgb, var(--c-border) 70%, transparent);
    border-radius: 10px;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--c-surface-2) 52%, transparent);
    color: var(--c-text-1);
    text-align: left;
    cursor: pointer;
    display: grid;
    gap: 2px;
    font-size: 0.76rem;
    width: 100%;
    height: 100%;
    align-content: start;
  }

  .scenario-tools {
    display: grid;
    gap: 10px;
  }

  .scenario-save-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  .scenario-name {
    min-width: 180px;
  }

  .scenario-chip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .scenario-chip-actions {
    display: inline-flex;
    gap: 6px;
  }

  @media (max-width: 760px) {
    .scenario-chip {
      flex-direction: column;
      align-items: flex-start;
    }
  }
</style>
