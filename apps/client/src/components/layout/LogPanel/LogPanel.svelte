<svelte:options runes={true} />

<script lang="ts">
  import {
    clearLogs,
    getFilteredLogs,
    logState,
    saveLogsToFile,
    setLogFilter,
    type LogExportScope,
  } from "../../../state/logs.svelte";
  import {
    layoutState,
    setLogHeight,
    setLogPanelView,
    toggleLogCollapsed,
  } from "../../../state/layout.svelte";
  import type { LogEntry } from "../../../state/logs.svelte";
  import LogList from "./LogList.svelte";
  import LogToolbar from "./LogToolbar.svelte";
  import RegisterDetailsPanel from "./RegisterDetailsPanel.svelte";
  import LogEntryDetailModal from "./LogEntryDetailModal.svelte";

  const filtered = $derived(getFilteredLogs(logState.filter));
  let selectedEntry = $state<LogEntry | null>(null);

  async function handleSave(scope: LogExportScope): Promise<void> {
    await saveLogsToFile(scope === "all" ? logState.entries : filtered, scope, logState.filter);
  }

  function handlePanelView(view: "logs" | "details"): void {
    setLogPanelView(view);
    if (layoutState.logCollapsed) {
      toggleLogCollapsed();
    }
  }

  function startResize(event: PointerEvent): void {
    if (layoutState.logCollapsed) {
      return;
    }

    const startY = event.clientY;
    const startHeight = layoutState.logHeight;

    const onMove = (moveEvent: PointerEvent): void => {
      const nextHeight = startHeight + (startY - moveEvent.clientY);
      setLogHeight(nextHeight);
    };

    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }
</script>

<section
  class:collapsed={layoutState.logCollapsed}
  class="log-panel"
  style:height={!layoutState.logCollapsed ? `${layoutState.logHeight}px` : undefined}
>
  <button
    class="resize-handle"
    type="button"
    aria-label="Resize log panel"
    onpointerdown={startResize}
  >
  </button>

  <LogToolbar
    collapsed={layoutState.logCollapsed}
    panelView={layoutState.logPanelView}
    filter={logState.filter}
    totalCount={logState.entries.length}
    visibleCount={filtered.length}
    onFilter={setLogFilter}
    onClear={clearLogs}
    onSave={handleSave}
    onPanelView={handlePanelView}
    onToggle={toggleLogCollapsed}
  />

  {#if !layoutState.logCollapsed}
    <div class="log-content">
      <div class="panel-view">
        {#if layoutState.logPanelView === "logs"}
          <LogList entries={filtered} onopen={(e) => (selectedEntry = e)} />
        {:else}
          <RegisterDetailsPanel inline={true} />
        {/if}
      </div>
    </div>
  {/if}

  {#if selectedEntry}
    <LogEntryDetailModal entry={selectedEntry} onclose={() => (selectedEntry = null)} />
  {/if}
</section>

<style>
  .log-panel {
    grid-area: logs;
    display: grid;
    grid-template-rows: 4px auto 1fr;
    border-top: 1px solid var(--c-border);
    background: var(--c-surface-1);
    min-height: 140px;
    max-height: 460px;
    transition: height 160ms ease;
  }

  .log-panel.collapsed {
    min-height: auto !important;
    max-height: 52px !important;
    grid-template-rows: auto;
  }

  .resize-handle {
    position: relative;
    width: 100%;
    height: 3px;
    border: 0;
    border-top: 1px solid color-mix(in srgb, var(--c-border) 65%, transparent);
    background: linear-gradient(
      to bottom,
      color-mix(in srgb, var(--c-surface-2) 65%, transparent),
      color-mix(in srgb, var(--c-surface-1) 85%, transparent)
    );
    cursor: ns-resize;
    padding: 0;
  }

  .log-panel.collapsed .resize-handle {
    display: none;
  }

  .log-content {
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel-view {
    flex: 1;
    min-height: 0;
    display: flex;
    overflow: hidden;
    background: var(--c-surface-3);
  }

  @media (max-width: 767px) {
    .log-panel {
      display: none;
    }
  }
</style>
