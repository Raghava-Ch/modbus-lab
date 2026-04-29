// Coils state — FC 01 (Read) · FC 05 (Write Single) · FC 15 (Write Multiple)

import { invoke } from "@tauri-apps/api/core";
import { addLog } from "./logs.svelte";
import { notifyWarning } from "./notifications.svelte";
import { connectionState } from "./connection.svelte";
import {
  getGlobalPollingMaxAddressCount,
  getSettingsSnapshot,
  isPollingAllowedForCount,
} from "./settings.svelte";

export type CoilView = "table" | "switch";
export type CoilFilter = "all" | "on" | "off";
export type CoilOrigin = "range" | "custom";
export type MassWritePattern =
  | "all-on"
  | "all-off"
  | "alternating"
  | "alternating-inv"
  | "every-third"
  | "random";
export type WriteMode = "once" | "auto-toggle";

export interface CoilEntry {
  address: number;
  slaveValue: boolean;
  desiredValue: boolean;
  pending: boolean;
  writeError: string | null;
  label: string;
  origin: CoilOrigin;
}

interface BackendReadCoilsResponse {
  coils: Array<{ address: number; value: boolean }>;
  startAddress: number;
  quantity: number;
}

interface BackendWriteCoilResponse {
  address: number;
  value: boolean;
}

interface BackendWriteMassCoilsResponse {
  writtenCount: number;
  totalCount: number;
  failures: Array<{ address: number; code: string; message: string }>;
}

function parseInvokeError(err: unknown): string {
  if (typeof err === "string") {
    try {
      const parsed = JSON.parse(err) as { message?: string; details?: string };
      if (typeof parsed.details === "string" && parsed.details.trim().length > 0) {
        return `${parsed.message ?? "Unknown error"} (${parsed.details})`;
      }
      return parsed.message ?? err;
    } catch {
      return err;
    }
  }
  if (typeof err === "object" && err !== null && "message" in err) {
    const maybe = err as { message: unknown; details?: unknown };
    if (typeof maybe.details === "string" && maybe.details.trim().length > 0) {
      return `${String(maybe.message)} (${maybe.details})`;
    }
    return String(maybe.message);
  }
  return "Unknown error";
}

function isTransientTransportError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("too many requests")
    || lower.includes("expected responses buffer is full")
    || lower.includes("timeout")
    || lower.includes("timed out")
    || lower.includes("not connected")
    || lower.includes("reconnecting")
    || lower.includes("broken pipe")
    || lower.includes("connection reset")
    || lower.includes("transport")
    || lower.includes("send failed")
    || lower.includes("io error")
    || lower.includes("connection closed")
  );
}

function warnLocal(message: string): void {
  addLog("warn", message);
  notifyWarning(message);
}


const COIL_VIEW_KEY = "Modbus-Lab.coilView";
const COIL_MAX_COUNT = 65536; // Modbus spec: 16-bit address space
const MODBUS_ADDRESS_MIN = 0;
const MODBUS_ADDRESS_MAX = COIL_MAX_COUNT - 1; // 0x0000-0xFFFF

interface AddressSection {
  start: number;
  quantity: number;
}

function buildAddressSections(addresses: number[]): AddressSection[] {
  if (addresses.length === 0) return [];

  const uniqueSorted = [...new Set(addresses)].sort((a, b) => a - b);
  const sections: AddressSection[] = [];

  let sectionStart = uniqueSorted[0];
  let prev = uniqueSorted[0];

  for (let i = 1; i < uniqueSorted.length; i += 1) {
    const current = uniqueSorted[i];
    if (current === prev + 1) {
      prev = current;
      continue;
    }

    sections.push({ start: sectionStart, quantity: prev - sectionStart + 1 });
    sectionStart = current;
    prev = current;
  }

  sections.push({ start: sectionStart, quantity: prev - sectionStart + 1 });
  return sections;
}

function formatSectionPreview(sections: AddressSection[], max = 4): string {
  if (sections.length === 0) return "-";
  const preview = sections
    .slice(0, max)
    .map((section) => `[${section.start}..${section.start + section.quantity - 1}]`)
    .join(",");
  return sections.length > max ? `${preview},...` : preview;
}

function estimateReadOps(sections: AddressSection[], chunkMax: number): number {
  return sections.reduce((total, section) => total + Math.max(1, Math.ceil(section.quantity / chunkMax)), 0);
}

function generateCoils(startAddress: number, count: number): CoilEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    address: startAddress + i,
    slaveValue: false,
    desiredValue: false,
    pending: false,
    writeError: null,
    label: "",
    origin: "range",
  }));
}

export const coilState = $state({
  view: "table" as CoilView,
  filter: "all" as CoilFilter,
  entries: [] as CoilEntry[],
  startAddress: 0,
  coilCount: 16,
  // Poll
  pollActive: false,
  pollInterval: 1000,
  // Mass write config
  massFrom: 0,
  massTo: 15,
  massPattern: "alternating" as MassWritePattern,
  massMode: "once" as WriteMode,
  massAutoInterval: 1000,
  massAutoActive: false,
});

// Timer handles — not reactive, managed manually
let autoToggleTimer: ReturnType<typeof setInterval> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let readAllInFlight = false;
let readAllQueuedRuns = 0;
const READ_ALL_QUEUE_DEPTH_MAX = 6;
let autoToggleWriteInFlight = false;

// ── Init ──────────────────────────────────────────────────────────────────────

export function initCoilState(): void {
  const settings = getSettingsSnapshot();

  if (!settings.rememberLastFeatureState) {
    coilState.view = settings.defaults.coils.view === "switch" ? "switch" : "table";
    applyAddressRange(settings.defaults.coils.startAddress, settings.defaults.coils.count);
  } else {
    const savedView = localStorage.getItem(COIL_VIEW_KEY);
    if (savedView === "switch" || savedView === "table") {
      coilState.view = savedView;
    }
    if (coilState.entries.length === 0) {
      applyAddressRange(settings.defaults.coils.startAddress, settings.defaults.coils.count);
    }
  }

  setPollInterval(settings.polling.defaultIntervalMs);
}

// ── View & Filter ─────────────────────────────────────────────────────────────

export function setCoilView(view: CoilView): void {
  coilState.view = view;
  localStorage.setItem(COIL_VIEW_KEY, view);
}

export function setCoilFilter(filter: CoilFilter): void {
  coilState.filter = filter;
}

// ── Single coil ───────────────────────────────────────────────────────────────

export function toggleCoilValue(address: number): void {
  const entry = coilState.entries.find((e) => e.address === address);
  if (!entry) return;
  entry.desiredValue = !entry.desiredValue;
  entry.writeError = null;
}

export function setCoilValue(address: number, value: boolean): void {
  const entry = coilState.entries.find((e) => e.address === address);
  if (!entry) return;
  entry.desiredValue = value;
  entry.writeError = null;
}

export function syncAllSlaveToDesired(): number {
  let changed = 0;
  for (const entry of coilState.entries) {
    if (entry.desiredValue !== entry.slaveValue || entry.writeError !== null) {
      changed += 1;
    }
    entry.desiredValue = entry.slaveValue;
    entry.writeError = null;
  }
  return changed;
}

export async function writeCoil(address: number): Promise<void> {
  const entry = coilState.entries.find((e) => e.address === address);
  if (!entry) return;
  const valueToWrite = entry.desiredValue;
  entry.pending = true;
  entry.writeError = null;
  try {
    const response = await invoke<BackendWriteCoilResponse>("write_coil", {
      request: { address, value: valueToWrite },
    });
    const e = coilState.entries.find((e2) => e2.address === address);
    if (e) {
      e.slaveValue = response.value;
      e.pending = false;
      e.writeError = null;
    }
    addLog("info", `fc05.write ok addr=${address} val=${response.value ? 1 : 0}`);
  } catch (err) {
    const e = coilState.entries.find((e2) => e2.address === address);
    const message = parseInvokeError(err);
    if (e) {
      e.pending = false;
      e.writeError = message;
    }
    addLog("error", `fc05.write err addr=${address} msg=${message}`);
  }
}

export async function writePendingCoils(): Promise<number> {
  const pending = coilState.entries.filter((e) => e.desiredValue !== e.slaveValue);
  if (pending.length === 0) return 0;
  const valueMap = new Map<number, boolean>(pending.map((entry) => [entry.address, entry.desiredValue]));
  const response = await writeAddressMap(valueMap);
  return response?.writtenCount ?? 0;
}

export async function readCoil(address: number): Promise<void> {
  const entry = coilState.entries.find((e) => e.address === address);
  if (!entry) return;
  entry.pending = true;
  try {
    const response = await invoke<BackendReadCoilsResponse>("read_coils", {
      request: { startAddress: address, quantity: 1 },
    });
    const coilVal = response.coils.find((c) => c.address === address);
    const e = coilState.entries.find((e2) => e2.address === address);
    if (e && coilVal !== undefined) {
      e.slaveValue = coilVal.value;
      // Successful read confirms availability; clear stale read/write error chip.
      e.writeError = null;
      e.pending = false;
    } else if (e) {
      e.pending = false;
    }
    addLog("info", `fc01.read ok addr=${address} val=${coilVal?.value ? 1 : 0}`);
  } catch (err) {
    const e = coilState.entries.find((e2) => e2.address === address);
    const reason = parseInvokeError(err);
    if (e) {
      e.pending = false;
      e.writeError = reason;
    }
    addLog("error", `fc01.read err addr=${address} msg=${reason}`);
  }
}

export function setCoilLabel(address: number, label: string): void {
  const entry = coilState.entries.find((e) => e.address === address);
  if (entry) entry.label = label;
}

// ── Pattern helpers ───────────────────────────────────────────────────────────

function getRangeAddresses(from: number, to: number): number[] {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const inRange: number[] = [];
  for (const entry of coilState.entries) {
    if (entry.address >= start && entry.address <= end) {
      inRange.push(entry.address);
    }
  }
  return inRange;
}

function getTargetAddresses(): number[] {
  return getRangeAddresses(coilState.massFrom, coilState.massTo);
}

function computePatternValues(pattern: MassWritePattern, addresses: number[]): Map<number, boolean> {
  const result = new Map<number, boolean>();
  let i = 0;
  for (const address of addresses) {
    let value: boolean;
    switch (pattern) {
      case "all-on":          value = true; break;
      case "all-off":         value = false; break;
      case "alternating":     value = i % 2 === 0; break;
      case "alternating-inv": value = i % 2 !== 0; break;
      case "every-third":     value = i % 3 === 0; break;
      case "random":          value = Math.random() >= 0.5; break;
      default:                value = false;
    }
    result.set(address, value);
    i++;
  }
  return result;
}

async function writeAddressMap(
  valueMap: Map<number, boolean>
): Promise<BackendWriteMassCoilsResponse | null> {
  if (valueMap.size === 0) return null;

  const planSections = buildAddressSections([...valueMap.keys()].sort((a, b) => a - b));
  addLog(
    "info",
    `fc15.write plan req=${valueMap.size} sections=${planSections.length} sample=${formatSectionPreview(planSections)}`,
  );

  // Set pending state immediately
  for (const [address, value] of valueMap) {
    const entry = coilState.entries.find((e) => e.address === address);
    if (entry) {
      entry.desiredValue = value;
      entry.pending = true;
      entry.writeError = null;
    }
  }

  // Convert to array for batch request
  const coils = Array.from(valueMap, ([address, value]) => ({ address, value }));

  try {
    const response = await invoke<BackendWriteMassCoilsResponse>("write_coils_batch", {
      request: { coils },
    });

    const failureMap = new Map(response.failures.map((failure) => [failure.address, failure]));

    // Update state based on per-address results
    for (const [address, value] of valueMap) {
      const e = coilState.entries.find((e2) => e2.address === address);
      if (e) {
        e.pending = false;
        const failure = failureMap.get(address);
        if (failure) {
          e.writeError = `${failure.code}: ${failure.message}`;
        } else {
          e.slaveValue = value;
          e.writeError = null;
        }
      }
    }

    if (response.failures.length === 0) {
      addLog("info", `fc15.write ok req=${response.totalCount} ok=${response.writtenCount} fail=0`);
    } else {
      const failedAddresses = response.failures.map((failure) => failure.address).join(", ");
      const failureCodes = [...new Set(response.failures.map((failure) => failure.code))].join(", ");
      addLog(
        "warn",
        `fc15.write partial req=${response.totalCount} ok=${response.writtenCount} fail=${response.failures.length} addrs=${failedAddresses} codes=${failureCodes}`
      );
    }

    return response;
  } catch (err) {
    // Clear pending on all entries on batch failure
    const message = parseInvokeError(err);
    for (const address of valueMap.keys()) {
      const e = coilState.entries.find((e2) => e2.address === address);
      if (e) {
        e.pending = false;
        e.writeError = message;
      }
    }
    addLog("error", `fc15.write err req=${valueMap.size} msg=${message}`);
    return null;
  }
}

function invertAddresses(addresses: number[]): void {
  for (const address of addresses) {
    const entry = coilState.entries.find((e) => e.address === address);
    if (entry) {
      entry.desiredValue = !entry.desiredValue;
      entry.writeError = null;
    }
  }
}

// ── Mass write ────────────────────────────────────────────────────────────────

export async function executeMassWrite(): Promise<void> {
  const targets = getTargetAddresses();
  if (targets.length === 0) return;
  const valueMap = computePatternValues(coilState.massPattern, targets);
  await writeAddressMap(valueMap);
}

export function startAutoToggle(): void {
  if (autoToggleTimer) clearInterval(autoToggleTimer);
  coilState.massAutoActive = true;

  // First pass: apply the selected pattern immediately
  const initialTargets = getTargetAddresses();
  const initialMap = computePatternValues(coilState.massPattern, initialTargets);
  void (async () => {
    if (autoToggleWriteInFlight) return;
    autoToggleWriteInFlight = true;
    try {
      await writeAddressMap(initialMap);
    } finally {
      autoToggleWriteInFlight = false;
    }
  })();

  autoToggleTimer = setInterval(() => {
    if (connectionState.status === "reconnecting" || connectionState.status === "disconnected") {
      // Server is down — skip this tick; supervisor will restore the session.
      return;
    }
    if (autoToggleWriteInFlight) {
      return;
    }

    const targets = getTargetAddresses();
    invertAddresses(targets);
    const invertMap = new Map(targets.map((addr) => {
      const entry = coilState.entries.find((e) => e.address === addr);
      return [addr, entry?.desiredValue ?? false] as [number, boolean];
    }));

    void (async () => {
      autoToggleWriteInFlight = true;
      try {
        await writeAddressMap(invertMap);
      } finally {
        autoToggleWriteInFlight = false;
      }
    })();
  }, coilState.massAutoInterval);
}

export function stopAutoToggle(): void {
  if (autoToggleTimer) {
    clearInterval(autoToggleTimer);
    autoToggleTimer = null;
  }
  coilState.massAutoActive = false;
  autoToggleWriteInFlight = false;
}

export function setMassAutoInterval(ms: number): void {
  coilState.massAutoInterval = ms;
  if (coilState.massAutoActive) {
    startAutoToggle();
  }
}

function upsertAndSortEntries(next: CoilEntry[]): void {
  const map = new Map<number, CoilEntry>();
  for (const entry of next) {
    map.set(entry.address, entry);
  }
  coilState.entries = [...map.values()].sort((a, b) => a.address - b.address);
}

function getCoilAcceptedAddressRange(): { min: number; max: number } {
  if (coilState.entries.length === 0) {
    return { min: MODBUS_ADDRESS_MIN, max: MODBUS_ADDRESS_MAX };
  }

  const addresses = coilState.entries.map((e) => e.address);
  const currentMin = Math.min(...addresses);
  const currentMax = Math.max(...addresses);

  return {
    min: Math.max(MODBUS_ADDRESS_MIN, currentMax - (COIL_MAX_COUNT - 1)),
    max: Math.min(MODBUS_ADDRESS_MAX, currentMin + (COIL_MAX_COUNT - 1)),
  };
}

export function addExclusiveCoil(address: number): boolean {
  // Modbus limit: max 2000 coils per read
  if (coilState.entries.length >= COIL_MAX_COUNT) {
    warnLocal(`Address is invalid. Accepted count range is 1-${COIL_MAX_COUNT}; already at ${COIL_MAX_COUNT}.`);
    return false;
  }

  if (!Number.isFinite(address)) {
    warnLocal(`Address is invalid. Accepted address range is ${MODBUS_ADDRESS_MIN}-${MODBUS_ADDRESS_MAX}.`);
    return false;
  }
  const normalized = Math.floor(address);
  if (normalized < MODBUS_ADDRESS_MIN || normalized > MODBUS_ADDRESS_MAX) {
    warnLocal(`Address is invalid. Accepted address range is ${MODBUS_ADDRESS_MIN}-${MODBUS_ADDRESS_MAX}.`);
    return false;
  }

  const accepted = getCoilAcceptedAddressRange();
  if (normalized < accepted.min || normalized > accepted.max) {
    warnLocal(`Address is invalid. Accepted address range is ${accepted.min}-${accepted.max} to keep max span ${COIL_MAX_COUNT}.`);
    return false;
  }

  if (coilState.entries.some((e) => e.address === normalized)) return false;

  upsertAndSortEntries([
    ...coilState.entries,
    {
      address: normalized,
      slaveValue: false,
      desiredValue: false,
      pending: false,
      writeError: null,
      label: "",
      origin: "custom",
    },
  ]);
  return true;
}

function pickRandomAvailableCoilAddress(): number | null {
  // Modbus limit: max 2000 coils per read
  if (coilState.entries.length >= COIL_MAX_COUNT) {
    warnLocal(`Address is invalid. Accepted count range is 1-${COIL_MAX_COUNT}; already at ${COIL_MAX_COUNT}.`);
    return null;
  }

  const used = new Set(coilState.entries.map((e) => e.address));
  const accepted = getCoilAcceptedAddressRange();
  const pool: number[] = [];

  // Pick from current range neighborhood first, then broaden.
  const preferredMin = Math.max(accepted.min, coilState.startAddress);
  const preferredMax = Math.min(accepted.max, coilState.startAddress + coilState.coilCount + 255);
  for (let addr = preferredMin; addr <= preferredMax; addr++) {
    if (!used.has(addr)) {
      pool.push(addr);
    }
  }

  if (pool.length === 0) {
    for (let addr = accepted.min; addr <= accepted.max; addr++) {
      if (!used.has(addr)) pool.push(addr);
      if (pool.length >= 2048) break;
    }
  }

  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function generateRandomExclusiveCoilAddress(): number | null {
  return pickRandomAvailableCoilAddress();
}

export function addRandomExclusiveCoil(): number | null {
  const picked = pickRandomAvailableCoilAddress();
  if (picked === null) return null;
  addExclusiveCoil(picked);
  return picked;
}

export function removeCoil(address: number): void {
  coilState.entries = coilState.entries.filter((e) => e.address !== address);
}

export function removeAllCoils(): void {
  coilState.entries = [];
}

// ── Poll ──────────────────────────────────────────────────────────────────────

async function readAllCoilsOnce(trace: boolean): Promise<void> {
  if (coilState.entries.length === 0) return;

  const sections = buildAddressSections(coilState.entries.map((e) => e.address));
  if (trace) {
    addLog(
      "info",
      `fc01.read plan total=${coilState.entries.length} sections=${sections.length} ops=${estimateReadOps(sections, COIL_MAX_COUNT)} sample=${formatSectionPreview(sections)}`,
    );
  }

  const entryByAddress = new Map<number, CoilEntry>(coilState.entries.map((entry) => [entry.address, entry]));

  let okCount = 0;

  for (const section of sections) {
    try {
      if (section.quantity === 1) {
        const response = await invoke<BackendReadCoilsResponse>("read_coils", {
          request: { startAddress: section.start, quantity: 1 },
        });
        const single = response.coils.find((coilVal) => coilVal.address === section.start);
        const entry = entryByAddress.get(section.start);
        if (entry) {
          if (single) {
            entry.slaveValue = single.value;
            entry.writeError = null;
            okCount += 1;
          } else {
            entry.writeError = "Address not available";
          }
        }
        continue;
      }

      for (let chunkStart = section.start; chunkStart < section.start + section.quantity; chunkStart += COIL_MAX_COUNT) {
        const chunkQty = Math.min(COIL_MAX_COUNT, section.start + section.quantity - chunkStart);
        const response = await invoke<BackendReadCoilsResponse>("read_coils", {
          request: { startAddress: chunkStart, quantity: chunkQty },
        });

        for (const coilVal of response.coils) {
          const entry = entryByAddress.get(coilVal.address);
          if (!entry) continue;
          entry.slaveValue = coilVal.value;
          entry.writeError = null;
          okCount += 1;
        }

        const chunkEnd = chunkStart + chunkQty - 1;
        const seen = new Set(response.coils.map((coilVal) => coilVal.address));
        for (let address = chunkStart; address <= chunkEnd; address += 1) {
          const entry = entryByAddress.get(address);
          if (!entry) continue;
          if (!seen.has(address)) {
            entry.writeError = "Address not available";
          }
        }
      }
    } catch (err) {
      const reason = parseInvokeError(err);
      if (isTransientTransportError(reason)) {
        addLog(
          "warn",
          `fc01.read transient start=${section.start} qty=${section.quantity} msg=${reason}`,
        );
        continue;
      }

      const sectionEnd = section.start + section.quantity - 1;
      for (let address = section.start; address <= sectionEnd; address += 1) {
        const entry = entryByAddress.get(address);
        if (!entry) continue;
        entry.writeError = reason;
      }
      addLog(
        "error",
        `fc01.read err start=${section.start} qty=${section.quantity} end=${sectionEnd} msg=${reason}`,
      );
    }
  }

  if (okCount > 0) {
    addLog("info", `fc01.read ok total=${coilState.entries.length} ok=${okCount} sections=${sections.length}`);
  }
}

export async function readAllCoils(options?: { trace?: boolean; queueIfBusy?: boolean }): Promise<void> {
  // Do not issue reads while the transport layer is recovering — avoids
  // flooding the queue with requests that will all fail.
  if (connectionState.status === "reconnecting" || connectionState.status === "disconnected") return;
  const trace = options?.trace ?? true;
  const queueIfBusy = options?.queueIfBusy ?? true;

  if (readAllInFlight) {
    if (queueIfBusy && readAllQueuedRuns < READ_ALL_QUEUE_DEPTH_MAX) {
      readAllQueuedRuns += 1;
    }
    return;
  }

  while (true) {
    readAllInFlight = true;
    try {
      await readAllCoilsOnce(trace);
    } finally {
      readAllInFlight = false;
    }

    if (readAllQueuedRuns === 0) {
      break;
    }

    readAllQueuedRuns -= 1;
    // Clear any pending queue runs if connectivity was lost during the run.
    if (connectionState.status === "reconnecting" || connectionState.status === "disconnected") {
      readAllQueuedRuns = 0;
      break;
    }
  }
}

export function setPollActive(active: boolean): void {
  if (active && !isPollingAllowedForCount(coilState.entries.length)) {
    warnLocal(
      `Polling disabled for lists larger than ${getGlobalPollingMaxAddressCount()} addresses. Use Read once for bulk refresh.`,
    );
    coilState.pollActive = false;
    return;
  }

  coilState.pollActive = active;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (active) {
    void readAllCoils({ trace: false, queueIfBusy: true });
    pollTimer = setInterval(() => { void readAllCoils({ trace: false, queueIfBusy: true }); }, coilState.pollInterval);
  }
}

export function setPollInterval(ms: number): void {
  coilState.pollInterval = ms;
  if (coilState.pollActive) setPollActive(true); // restart with new interval
}

// ── Address range ─────────────────────────────────────────────────────────────

export function applyAddressRange(startAddress: number, count: number): void {
  // Stop active operations before changing range
  if (coilState.massAutoActive) stopAutoToggle();
  if (coilState.pollActive) setPollActive(false);

  const requestedStart = Math.floor(startAddress);
  const requestedCount = Math.floor(count);

  const start = Math.max(MODBUS_ADDRESS_MIN, Math.min(MODBUS_ADDRESS_MAX, requestedStart));
  const maxCountFromStart = Math.min(COIL_MAX_COUNT, MODBUS_ADDRESS_MAX - start + 1);
  const qty = Math.max(1, Math.min(maxCountFromStart, requestedCount));

  if (!Number.isFinite(startAddress) || requestedStart !== start) {
    warnLocal(`Address is invalid. Accepted start range is ${MODBUS_ADDRESS_MIN}-${MODBUS_ADDRESS_MAX}. Applied ${start}.`);
  }
  if (!Number.isFinite(count) || requestedCount !== qty) {
    warnLocal(`Address is invalid. Accepted count range is 1-${maxCountFromStart} for start ${start}. Applied ${qty}.`);
  }

  coilState.startAddress = start;
  coilState.coilCount = qty;

  // Keep custom-added coils while rebuilding base range entries.
  const customEntries = coilState.entries.filter((e) => e.origin === "custom");
  const rangeEntries = generateCoils(start, qty).map((entry) => {
    const existing = coilState.entries.find((e) => e.address === entry.address);
    if (!existing) return entry;
    return {
      ...entry,
      slaveValue: existing.slaveValue,
      desiredValue: existing.desiredValue,
      writeError: existing.writeError,
      label: existing.label,
      pending: existing.pending,
      origin: existing.origin,
    };
  });

  const customCandidates = customEntries
    .filter((e) => !rangeEntries.some((r) => r.address === e.address))
    .sort((a, b) => a.address - b.address);
  const rangeEnd = start + qty - 1;
  const acceptedCustomMin = Math.max(MODBUS_ADDRESS_MIN, rangeEnd - (COIL_MAX_COUNT - 1));
  const acceptedCustomMax = Math.min(MODBUS_ADDRESS_MAX, start + (COIL_MAX_COUNT - 1));
  const keptCustom = customCandidates.filter(
    (entry) => entry.address >= acceptedCustomMin && entry.address <= acceptedCustomMax,
  );

  upsertAndSortEntries([...rangeEntries, ...keptCustom]);

  const droppedCustom = customCandidates.length - keptCustom.length;
  if (droppedCustom > 0) {
    warnLocal(`Address is invalid. Accepted address range is ${acceptedCustomMin}-${acceptedCustomMax} for custom coils at this range; dropped ${droppedCustom} custom coil${droppedCustom === 1 ? "" : "s"}.`);
  }

  // Reset mass-write range to match new entries
  coilState.massFrom = start;
  coilState.massTo = start + qty - 1;
}

export function addCoilRange(startAddress: number, count: number): void {
  if (coilState.massAutoActive) stopAutoToggle();

  const requestedStart = Math.floor(startAddress);
  const requestedCount = Math.floor(count);

  const start = Math.max(MODBUS_ADDRESS_MIN, Math.min(MODBUS_ADDRESS_MAX, requestedStart));
  const maxCountFromStart = Math.min(COIL_MAX_COUNT, MODBUS_ADDRESS_MAX - start + 1);
  const qty = Math.max(1, Math.min(maxCountFromStart, requestedCount));

  if (!Number.isFinite(startAddress) || requestedStart !== start) {
    warnLocal(`Address is invalid. Accepted start range is ${MODBUS_ADDRESS_MIN}-${MODBUS_ADDRESS_MAX}. Applied ${start}.`);
  }
  if (!Number.isFinite(count) || requestedCount !== qty) {
    warnLocal(`Address is invalid. Accepted count range is 1-${maxCountFromStart} for start ${start}. Applied ${qty}.`);
  }

  coilState.startAddress = start;
  coilState.coilCount = qty;

  // Merge: only add addresses not already present
  const existingByAddress = new Map(coilState.entries.map((e) => [e.address, e]));
  for (const newEntry of generateCoils(start, qty)) {
    if (!existingByAddress.has(newEntry.address)) {
      existingByAddress.set(newEntry.address, newEntry);
    }
  }

  upsertAndSortEntries([...existingByAddress.values()]);
}

// ── Filtered view ─────────────────────────────────────────────────────────────

export function getFilteredCoils(): CoilEntry[] {
  switch (coilState.filter) {
    case "on":
      return coilState.entries.filter((e) => e.slaveValue);
    case "off":
      return coilState.entries.filter((e) => !e.slaveValue);
    default:
      return coilState.entries;
  }
}

/** Build a preview string for the current mass-write pattern & range */
export function buildMassPreview(): string {
  const targets = getTargetAddresses();
  const total = targets.length;
  if (total <= 0) return "—";

  const preview: string[] = [];
  const cap = Math.min(total, 20);
  for (let i = 0; i < cap; i++) {
    switch (coilState.massPattern) {
      case "all-on":
        preview.push("1");
        break;
      case "all-off":
        preview.push("0");
        break;
      case "alternating":
        preview.push(i % 2 === 0 ? "1" : "0");
        break;
      case "alternating-inv":
        preview.push(i % 2 !== 0 ? "1" : "0");
        break;
      case "every-third":
        preview.push(i % 3 === 0 ? "1" : "0");
        break;
      case "random":
        preview.push("?");
        break;
    }
  }
  if (total > 20) preview.push("…");
  return `${total} coil${total !== 1 ? "s" : ""}: ${preview.join(" ")}`;
}
