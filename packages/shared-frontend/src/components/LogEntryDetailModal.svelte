<svelte:options runes={true} />

<script lang="ts">
  import { X } from "lucide-svelte";

  export interface LogEntry {
    id: number;
    timestamp: number;
    level: string;
    message: string;
  }

  let { entry, onclose, formatTimestamp } = $props<{
    entry: LogEntry;
    onclose: () => void;
    formatTimestamp: (ts: number) => string;
  }>();

  interface ParsedField {
    key: string;
    value: string;
    label: string;
  }

  // Labels for well-known key= tokens that appear in traffic and other messages.
  const FIELD_LABELS: Record<string, string> = {
    txn: "Transaction ID",
    unit: "Unit / Slave ID",
    fc: "Function Code",
    kind: "Direction",
    mbap_len: "MBAP Declared Length",
    frame_len: "Frame Length",
    expected_len: "Expected Frame Length",
    start: "Start Address",
    qty: "Quantity",
    addr: "Address",
    val: "Value",
    value: "Value",
    byte_count: "Byte Count",
    sub: "Diagnostic Sub-function",
    mei: "MEI Type",
    exception: "Exception",
    reason: "Rejection Reason",
    frame_len_actual: "Actual Frame Length",
    protocol: "Protocol ID",
    declared_len: "Declared Length",
    pdu_len: "PDU Length",
    data_len: "Data Length",
    payload_len: "Payload Length",
    status: "Connection Status",
    details: "Details",
    host: "Host",
    port: "Port",
    baud: "Baud Rate",
    slave: "Slave ID",
    msg: "Error Message",
    err: "Error",
    start_address: "Start Address",
    end: "End Address",
    ok: "Successful Items",
    fail: "Failed Items",
    req: "Requested Count",
    total: "Total Items",
    sections: "Sections",
    miss: "Missing Count",
    cancel: "Cancelled",
    error_type: "Error Type",
    exception_code: "Exception Code",
  };

  // Direction-related strings embedded in the "adu=" segment.
  const ADU_TOKEN_LABELS: Record<string, string> = {
    txn: "Transaction ID",
    unit: "Unit / Slave ID",
    fc: "Function Code",
    kind: "Direction",
    mbap_len: "MBAP Declared Length",
    frame_len: "Frame Length",
    expected_len: "Expected Frame Length",
    start: "Start Address",
    qty: "Quantity",
    addr: "Address",
    value: "Value",
    byte_count: "Byte Count",
    sub: "Diagnostic Sub-function",
    data: "Data Word",
    mei: "MEI Type",
    exception: "Exception",
    reason: "Reason",
    pdu_len: "PDU Length",
    data_len: "Data Length",
    payload_len: "Payload Length",
    regs: "Register Values",
    bits: "Bit Values",
    values: "Values",
    and_mask: "AND Mask",
    or_mask: "OR Mask",
    read_addr: "Read Address",
    read_qty: "Read Quantity",
    write_addr: "Write Address",
    write_qty: "Write Quantity",
    fifo_ptr: "FIFO Pointer",
    fifo_count: "FIFO Count",
    event_count: "Event Count",
    exc_status: "Exception Status",
  };

  // Parses "key=value" token pairs from a message string.
  // Returns them in encounter order.  Handles values that contain
  // parenthesised suffixes (e.g. "0x03(ReadHoldingRegisters)").
  function parseKeyValues(text: string): ParsedField[] {
    const result: ParsedField[] = [];
    // Split on whitespace boundaries where the next token looks like key=...
    const tokens = text.split(/\s+(?=\S+=)/);
    for (const token of tokens) {
      const eq = token.indexOf("=");
      if (eq <= 0) continue;
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      if (!key || value === "") continue;
      const labelMap = { ...FIELD_LABELS, ...ADU_TOKEN_LABELS };
      const label = labelMap[key] ?? key;
      result.push({ key, value, label });
    }
    return result;
  }

  // For traffic messages the "adu=" segment is itself a nested key=value block.
  // We extract it and its inner fields as a group instead of treating the whole
  // message as a flat list.
  interface ParsedMessage {
    prefix: string; // e.g. "tcp.tx" before the first key
    topFields: ParsedField[]; // top-level key=value pairs except "adu"
    aduFields: ParsedField[]; // key=value pairs decoded from inside "adu=..."
    bytes: string | null; // value of "bytes=" if present
    isTraffic: boolean;
  }

  function parseTrafficMessage(msg: string): ParsedMessage {
    // Strip topic prefix added by AppShell, e.g. "[NETWORK] ".
    msg = msg.replace(/^\[.*?\]\s*/, "");

    // Extract the raw byte string — key may be "bytes=" (current format) or
    // "raw=" (earlier server build).  Both sit at the end of the message.
    let bytes: string | null = null;
    const bytesMatch = msg.match(/\b(?:bytes|raw)=([0-9A-F ]+)$/i);
    if (bytesMatch) {
      bytes = bytesMatch[1].trim() || null;
      msg = msg.slice(0, bytesMatch.index).trim();
    }

    // Extract prefix word (before first key=).
    const prefixMatch = msg.match(/^(\S+)\s+/);
    const prefix = prefixMatch ? prefixMatch[1] : "";
    const rest = prefixMatch ? msg.slice(prefixMatch[0].length) : msg;

    // Split out adu=... which is itself a nested key=value blob.
    // Current format:  srv.tx txn=N unit=N adu=txn=N unit=N fc=... kind=... ...
    // Older format:    srv.tx txn=N unit=N fc=... kind=... ... (flat, no adu= wrapper)
    // For the flat format we treat everything from fc= onward as the ADU section.
    const aduMarker = rest.indexOf("adu=");
    const fcMarker  = rest.search(/\bfc=/);
    let outer = rest;
    let aduFields: ParsedField[] = [];
    if (aduMarker >= 0) {
      outer    = rest.slice(0, aduMarker).trim();
      const aduText = rest.slice(aduMarker + 4).trim();
      aduFields = parseKeyValues(aduText);
    } else if (fcMarker >= 0) {
      // Flat format: split at the first fc= token.
      outer    = rest.slice(0, fcMarker).trim();
      aduFields = parseKeyValues(rest.slice(fcMarker));
    }

    const topFields = parseKeyValues(outer);

    return {
      prefix,
      topFields,
      aduFields,
      bytes,
      isTraffic: true,
    };
  }

  function parseGenericMessage(msg: string): ParsedField[] {
    return parseKeyValues(msg);
  }

  interface ByteGroup {
    label: string;
    bytes: string[];
    color: string;
  }

  // Splits a Modbus TCP ADU hex byte string into named field groups.
  function groupModbusTcpBytes(bytesStr: string): ByteGroup[] {
    const bytes = bytesStr.trim().split(/\s+/).filter(b => b.length > 0);
    if (bytes.length < 8) {
      return [{ label: "Frame", bytes, color: "var(--c-accent)" }];
    }
    const groups: ByteGroup[] = [
      { label: "TID", bytes: bytes.slice(0, 2), color: "var(--c-accent)" },
      { label: "PID",            bytes: bytes.slice(2, 4), color: "var(--c-accent)" },
      { label: "LEN",            bytes: bytes.slice(4, 6), color: "var(--c-text-2)" },
      { label: "UID",            bytes: bytes.slice(6, 7), color: "var(--c-warn)" },
      { label: "FC",             bytes: bytes.slice(7, 8), color: "var(--c-accent)" },
    ];
    if (bytes.length > 8) {
      groups.push({ label: "PDU Data", bytes: bytes.slice(8), color: "var(--c-text-2)" });
    }
    return groups;
  }

  const isTraffic = $derived(entry.level === "traffic");
  const parsed = $derived(
    isTraffic
      ? parseTrafficMessage(entry.message)
      : null,
  );
  const genericFields = $derived(
    !isTraffic ? parseGenericMessage(entry.message) : [],
  );

  function closeOnBackdrop(e: MouseEvent) {
    if (e.target === e.currentTarget) {
      onclose();
    }
  }

  function closeOnEscape(e: KeyboardEvent) {
    if (e.key === "Escape") {
      onclose();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="backdrop"
  role="dialog"
  aria-modal="true"
  aria-label="Log entry details"
  tabindex="-1"
  onclick={closeOnBackdrop}
  onkeydown={closeOnEscape}
>
  <div class="modal">
    <header class="modal-header">
      <div class="header-left">
        <span class="badge" class:info={entry.level === "info"} class:warn={entry.level === "warn"} class:error={entry.level === "error"} class:traffic={entry.level === "traffic"}>
          {entry.level.toUpperCase()}
        </span>
        <span class="timestamp">{formatTimestamp(entry.timestamp)}</span>
        <span class="entry-id">#{entry.id}</span>
      </div>
      <button class="close-btn" type="button" aria-label="Close" onclick={onclose}>
        <X size={15} />
      </button>
    </header>

    <div class="modal-body">
      {#if isTraffic && parsed}
        <!-- Traffic entries: structured ADU view -->
        <section class="section">
          <h3 class="section-title">Frame</h3>
          <div class="field-grid">
            <div class="field">
              <span class="field-key">Direction</span>
              <span class="field-value mono">{parsed.prefix}</span>
            </div>
            {#each parsed.topFields as f, i (`${f.key}-${i}`)}
              <div class="field">
                <span class="field-key">{f.label}</span>
                <span class="field-value mono">{f.value}</span>
              </div>
            {/each}
          </div>
        </section>

        {#if parsed.aduFields.length > 0}
          <section class="section">
            <h3 class="section-title">ADU Decode</h3>
            <div class="field-grid">
              {#each parsed.aduFields as f, i (`${f.key}-${i}`)}
                <div class="field">
                  <span class="field-key">{f.label}</span>
                  <span class="field-value mono">{f.value}</span>
                </div>
              {/each}
            </div>
          </section>
        {/if}

        {#if parsed.bytes}
          <section class="section">
            <h3 class="section-title">Raw Bytes</h3>
            <div class="byte-groups">
              {#each groupModbusTcpBytes(parsed.bytes) as group, gi (gi)}
                <div class="byte-group" style="--group-color: {group.color}; --group-label-ch: {group.label.length}">
                  <span class="byte-group-label">{group.label}</span>
                  {#each group.bytes as byte, bi (bi)}
                    <span class="byte">{byte}</span>
                  {/each}
                </div>
              {/each}
            </div>
          </section>
        {/if}
      {:else}
        <!-- Non-traffic entries: raw message + any key=value fields found -->
        <section class="section">
          <h3 class="section-title">Message</h3>
          <pre class="raw-message">{entry.message}</pre>
        </section>

        {#if genericFields.length > 1}
          <section class="section">
            <h3 class="section-title">Fields</h3>
            <div class="field-grid">
              {#each genericFields as f, i (`${f.key}-${i}`)}
                <div class="field">
                  <span class="field-key">{f.label}</span>
                  <span class="field-value mono">{f.value}</span>
                </div>
              {/each}
            </div>
          </section>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 200;
    padding: 24px;
  }

  .modal {
    background: var(--c-surface-1);
    border: 1px solid var(--c-border);
    border-radius: 10px;
    width: 100%;
    max-width: 720px;
    max-height: min(82dvh, 680px);
    display: flex;
    flex-direction: column;
    box-shadow: 0 24px 56px rgba(0, 0, 0, 0.55);
    overflow: hidden;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--c-border);
    flex-shrink: 0;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .badge {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.7rem;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 5px;
    border: 1px solid var(--c-border);
    background: color-mix(in srgb, var(--c-surface-3) 72%, var(--c-surface-2));
    flex-shrink: 0;
  }

  .badge.info {
    color: var(--c-accent);
    border-color: color-mix(in srgb, var(--c-accent) 32%, var(--c-border));
  }

  .badge.warn {
    color: var(--c-warn);
    border-color: color-mix(in srgb, var(--c-warn) 32%, var(--c-border));
  }

  .badge.error {
    color: var(--c-error);
    border-color: color-mix(in srgb, var(--c-error) 32%, var(--c-border));
  }

  .badge.traffic {
    color: var(--c-text-1);
    border-color: color-mix(in srgb, var(--c-accent) 34%, var(--c-border));
    background: color-mix(in srgb, var(--c-accent) 10%, var(--c-surface-3));
  }

  .timestamp {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.75rem;
    color: var(--c-text-2);
  }

  .entry-id {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.7rem;
    color: var(--c-text-2);
    opacity: 0.55;
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 6px;
    background: transparent;
    color: var(--c-text-2);
    flex-shrink: 0;
    transition: background 120ms, color 120ms;
  }

  .close-btn:hover {
    background: var(--c-surface-3);
    color: var(--c-text-1);
  }

  .modal-body {
    overflow-y: auto;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 18px;
    min-height: 0;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .section-title {
    margin: 0;
    font-size: 0.7rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--c-text-2);
    padding-bottom: 6px;
    border-bottom: 1px solid color-mix(in srgb, var(--c-border) 60%, transparent);
  }

  .field-grid {
    display: flex;
    flex-direction: column;
    gap: 0;
    border: 1px solid color-mix(in srgb, var(--c-border) 60%, transparent);
    border-radius: 6px;
    overflow: hidden;
  }

  .field {
    display: grid;
    grid-template-columns: 200px 1fr;
    gap: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--c-border) 40%, transparent);
  }

  .field:last-child {
    border-bottom: none;
  }

  .field-key {
    font-size: 0.73rem;
    color: var(--c-text-2);
    padding: 6px 10px;
    background: color-mix(in srgb, var(--c-surface-2) 60%, transparent);
    border-right: 1px solid color-mix(in srgb, var(--c-border) 40%, transparent);
    display: flex;
    align-items: center;
  }

  .field-value {
    font-size: 0.73rem;
    color: var(--c-text-1);
    padding: 6px 10px;
    display: flex;
    align-items: center;
    overflow-wrap: anywhere;
    word-break: break-all;
  }

  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .byte-groups {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .byte-group {
    position: relative;
    border: 1px solid color-mix(in srgb, var(--group-color) 45%, var(--c-border));
    border-radius: 6px;
    padding: 13px 6px 6px;
    min-width: calc(var(--group-label-ch, 4) * 0.9ch + 16px);
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    background: color-mix(in srgb, var(--group-color) 5%, var(--c-surface-2));
  }

  .byte-group-label {
    position: absolute;
    top: -7px;
    left: 6px;
    padding: 0 3px;
    background: var(--c-surface-1);
    font-size: 0.56rem;
    font-weight: 600;
    color: var(--group-color);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    line-height: 1;
    white-space: nowrap;
  }

  .byte {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.68rem;
    padding: 2px 5px;
    background: color-mix(in srgb, var(--group-color, var(--c-accent)) 10%, var(--c-surface-3));
    border: 1px solid color-mix(in srgb, var(--group-color, var(--c-accent)) 35%, var(--c-border));
    border-radius: 3px;
    color: var(--group-color, var(--c-accent));
    letter-spacing: 0.04em;
  }

  .raw-message {
    margin: 0;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.73rem;
    color: var(--c-text-1);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--c-surface-2);
    border: 1px solid color-mix(in srgb, var(--c-border) 60%, transparent);
    border-radius: 6px;
    padding: 10px;
    line-height: 1.5;
  }
</style>
