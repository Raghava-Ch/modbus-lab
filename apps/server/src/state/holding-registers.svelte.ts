import { invoke } from "@tauri-apps/api/core";
import { addLog } from "./logs.svelte";
import { notifyWarning } from "./notifications.svelte";
import { getSettingsSnapshot } from "./settings.svelte";
import { connectionState } from "./connection.svelte";
import { recordFifoLinkedSourceSample, registerFifoSnapshotSourceReader } from "./fifo.svelte";

export type HoldingRegisterView = "table" | "cards";
export type HoldingRegisterFilter = "all" | "non-zero" | "zero";
export type HoldingRegisterOrigin = "range" | "custom";

export type HoldingRegRule = {
  type: "none" | "cycle" | "sine" | "sawtooth" | "triangle";
  intervalMs: number;
  minValue: number;
  maxValue: number;
  step: number;
  periodMs: number;
};
export type HoldingRegisterAddressFilter =
  | "all"
  | "required-range"
  | "non-required-range"
  | "required-list"
  | "not-required-list";

export interface HoldingRegisterEntry {
  address: number;
  slaveValue: number;
  desiredValue: number;
  pending: boolean;
  readError: string | null;
  writeError: string | null;
  lastReadAt: number | null;
  lastWriteAt: number | null;
  label: string;
  origin: HoldingRegisterOrigin;
  rule: HoldingRegRule;
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

function warnLocal(message: string): void {
  addLog("warn", message);
  notifyWarning(message);
}

function defaultHoldingRegRule(): HoldingRegRule {
  return {
    type: "none",
    intervalMs: 1000,
    minValue: 0,
    maxValue: 100,
    step: 1,
    periodMs: 4000,
  };
}

const HOLDING_VIEW_KEY = "Modbus-Lab.holdingView";
const HOLDING_MAX_COUNT = 65536;
const HOLDING_ADDRESS_MIN = 0;
const HOLDING_ADDRESS_MAX = HOLDING_MAX_COUNT - 1;
const IBUS_RESERVED_HR_START = 9000;
const IBUS_RESERVED_HR_END = 9999;
const HOLDING_PERF_WARN_THRESHOLD = 5000;
const HOLDING_UI_SYNC_INTERVAL_MS = 400;
let largeDatasetWarned = false;
let uiSyncTimer: ReturnType<typeof setInterval> | null = null;
let uiSyncInFlight = false;

function isIbusModeEnabled(): boolean {
  return getSettingsSnapshot().ibus.enabled;
}

function isIbusReservedHoldingAddress(address: number): boolean {
  return address >= IBUS_RESERVED_HR_START && address <= IBUS_RESERVED_HR_END;
}

function filterIbusReservedHoldingEntries(entries: HoldingRegisterEntry[]): HoldingRegisterEntry[] {
  if (!isIbusModeEnabled()) return entries;
  const blocked = entries.filter((entry) => isIbusReservedHoldingAddress(entry.address)).length;
  if (blocked > 0) {
    warnLocal(
      `iBus mode reserves HR ${IBUS_RESERVED_HR_START}-${IBUS_RESERVED_HR_END}. Blocked ${blocked} holding register${blocked === 1 ? "" : "s"}.`,
    );
  }
  return entries.filter((entry) => !isIbusReservedHoldingAddress(entry.address));
}

type StoreReadU16Entry = {
  address: number;
  value: number;
};

function normalizeU16(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(65535, Math.floor(value)));
}

function normalizeRule(rule: HoldingRegRule): HoldingRegRule {
  const minValue = normalizeU16(rule.minValue, 0);
  const maxValue = normalizeU16(rule.maxValue, 100);
  const lo = Math.min(minValue, maxValue);
  const hi = Math.max(minValue, maxValue);
  return {
    type: rule.type,
    intervalMs: Math.max(100, Math.floor(rule.intervalMs)),
    minValue: lo,
    maxValue: hi,
    step: Math.max(1, normalizeU16(rule.step, 1)),
    periodMs: Math.max(200, Math.floor(rule.periodMs)),
  };
}

async function writeHoldingRegisterValue(address: number, value: number): Promise<void> {
  const entry = holdingRegisterState.entries.find((e) => e.address === address);
  if (!entry) return;
  if (entry.pending) return;

  const normalized = normalizeU16(value, entry.desiredValue);
  entry.pending = true;
  entry.writeError = null;
  try {
    const previousSlaveValue = entry.slaveValue;
    await invoke("store_write_holding_reg", { address, value: normalized });
    entry.slaveValue = normalized;
    entry.pending = false;
    entry.writeError = null;
    entry.lastWriteAt = Date.now();
    if (previousSlaveValue !== normalized) {
      void recordFifoLinkedSourceSample("holding-register", address, normalized);
    }
  } catch (err) {
    entry.pending = false;
    const message = parseInvokeError(err);
    entry.writeError = message;
  }
}

async function runHoldingRegisterUiSyncTick(): Promise<void> {
  if (connectionState.listenerStatus !== "running") return;
  if (uiSyncInFlight) return;
  const addresses = holdingRegisterState.entries.map((e) => e.address);
  if (addresses.length === 0) return;

  uiSyncInFlight = true;
  try {
    const rows = await invoke<StoreReadU16Entry[]>("store_read_holding_regs", { addresses });
    const valueByAddress = new Map(rows.map((row) => [row.address, row.value]));
    const now = Date.now();
    for (const entry of holdingRegisterState.entries) {
      if (entry.pending) continue;
      const nextValue = valueByAddress.get(entry.address);
      if (nextValue === undefined) continue;
      const preserveDesired = entry.desiredValue !== entry.slaveValue;
      const previousSlaveValue = entry.slaveValue;
      const normalized = normalizeU16(nextValue, entry.slaveValue);
      entry.slaveValue = normalized;
      if (!preserveDesired) {
        entry.desiredValue = normalized;
      }
      entry.lastReadAt = now;
      entry.readError = null;
      if (previousSlaveValue !== normalized) {
        void recordFifoLinkedSourceSample("holding-register", entry.address, normalized);
      }
    }
  } catch (err) {
    const msg = parseInvokeError(err);
    for (const entry of holdingRegisterState.entries) {
      entry.readError = msg;
    }
  } finally {
    uiSyncInFlight = false;
  }
}

function startHoldingRegisterUiSync(): void {
  if (uiSyncTimer) {
    clearInterval(uiSyncTimer);
    uiSyncTimer = null;
  }

  void runHoldingRegisterUiSyncTick();
  uiSyncTimer = setInterval(() => {
    void runHoldingRegisterUiSyncTick();
  }, HOLDING_UI_SYNC_INTERVAL_MS);
}

export function stopHoldingRegisterUiSync(): void {
  if (!uiSyncTimer) return;
  clearInterval(uiSyncTimer);
  uiSyncTimer = null;
}

function warnLargeDatasetConsequences(count: number): void {
  if (count >= HOLDING_PERF_WARN_THRESHOLD) {
    if (!largeDatasetWarned) {
      warnLocal(
        `Large range selected (${count} registers). Consequence: UI can feel slow due to rendering and large payload updates. Use table view, increase poll interval, or narrow the range for smoother behavior.`,
      );
      largeDatasetWarned = true;
    }
    return;
  }

  largeDatasetWarned = false;
}

function generateRegisters(startAddress: number, count: number): HoldingRegisterEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    address: startAddress + i,
    slaveValue: 0,
    desiredValue: 0,
    pending: false,
    readError: null,
    writeError: null,
    lastReadAt: null,
    lastWriteAt: null,
    label: "",
    origin: "range",
    rule: defaultHoldingRegRule(),
  }));
}

export const holdingRegisterState = $state({
  view: "table" as HoldingRegisterView,
  filter: "all" as HoldingRegisterFilter,
  addressFilter: "all" as HoldingRegisterAddressFilter,
  addressRangeStart: 0,
  addressRangeEnd: 0,
  addressList: [] as number[],
  entries: [] as HoldingRegisterEntry[],
  startAddress: 0,
  registerCount: 16,
});

registerFifoSnapshotSourceReader("holding-register", (address) => {
  const entry = holdingRegisterState.entries.find((item) => item.address === address);
  return entry ? (entry.slaveValue & 0xFFFF) : null;
});

export function initHoldingRegisterState(): void {
  const settings = getSettingsSnapshot();

  if (!settings.rememberLastFeatureState) {
    holdingRegisterState.view = settings.defaults.holdingRegisters.view === "cards" ? "cards" : "table";
    applyHoldingRegisterRange(
      settings.defaults.holdingRegisters.startAddress,
      settings.defaults.holdingRegisters.count,
    );
  } else {
    const savedView = localStorage.getItem(HOLDING_VIEW_KEY);
    if (savedView === "table" || savedView === "cards") {
      holdingRegisterState.view = savedView;
    }
    if (holdingRegisterState.entries.length === 0) {
      applyHoldingRegisterRange(
        settings.defaults.holdingRegisters.startAddress,
        settings.defaults.holdingRegisters.count,
      );
    }
  }

  const sanitized = filterIbusReservedHoldingEntries(holdingRegisterState.entries);
  if (sanitized.length !== holdingRegisterState.entries.length) {
    holdingRegisterState.entries = [...sanitized].sort((a, b) => a.address - b.address);
    syncHoldingRegAddressesToBackend();
  }

  startHoldingRegisterUiSync();
}

export function setHoldingRegisterView(view: HoldingRegisterView): void {
  holdingRegisterState.view = view;
  localStorage.setItem(HOLDING_VIEW_KEY, view);
}

export function setHoldingRegisterFilter(filter: HoldingRegisterFilter): void {
  holdingRegisterState.filter = filter;
}

export function setHoldingRegisterAddressFilter(filter: HoldingRegisterAddressFilter): void {
  holdingRegisterState.addressFilter = filter;
}

export function setHoldingRegisterAddressRange(startAddress: number, endAddress: number): void {
  const start = Math.max(HOLDING_ADDRESS_MIN, Math.min(HOLDING_ADDRESS_MAX, Math.floor(startAddress)));
  const end = Math.max(HOLDING_ADDRESS_MIN, Math.min(HOLDING_ADDRESS_MAX, Math.floor(endAddress)));

  holdingRegisterState.addressRangeStart = Math.min(start, end);
  holdingRegisterState.addressRangeEnd = Math.max(start, end);
}

export function setHoldingRegisterAddressList(addresses: number[]): void {
  const normalized = addresses
    .map((a) => Math.floor(a))
    .filter((a) => Number.isFinite(a) && a >= HOLDING_ADDRESS_MIN && a <= HOLDING_ADDRESS_MAX);

  holdingRegisterState.addressList = [...new Set(normalized)].sort((a, b) => a - b);
}

export function setHoldingRegisterLabel(address: number, label: string): void {
  const entry = holdingRegisterState.entries.find((e) => e.address === address);
  if (!entry) return;
  entry.label = label;
}

export function setHoldingRegisterDesiredValue(address: number, value: number): void {
  const entry = holdingRegisterState.entries.find((e) => e.address === address);
  if (!entry) return;
  const previous = entry.desiredValue;
  const normalized = normalizeU16(value, entry.desiredValue);
  entry.desiredValue = normalized;
  entry.writeError = null;
  if (previous !== normalized) {
    addLog("info", `HR.store.set ok addr=${address} val=${normalized}`);
  }
}

export async function writeHoldingRegister(address: number): Promise<void> {
  const entry = holdingRegisterState.entries.find((e) => e.address === address);
  if (!entry) return;
  await writeHoldingRegisterValue(address, entry.desiredValue);
}

export function applyHoldingRegisterRange(startAddress: number, count: number): void {
  const requestedStart = Math.floor(startAddress);
  const requestedCount = Math.floor(count);

  const start = Math.max(HOLDING_ADDRESS_MIN, Math.min(HOLDING_ADDRESS_MAX, requestedStart));
  const maxCountFromStart = Math.min(HOLDING_MAX_COUNT, HOLDING_ADDRESS_MAX - start + 1);
  const qty = Math.max(1, Math.min(maxCountFromStart, requestedCount));

  if (!Number.isFinite(startAddress) || requestedStart !== start) {
    warnLocal(`Address is invalid. Accepted start range is ${HOLDING_ADDRESS_MIN}-${HOLDING_ADDRESS_MAX}. Applied ${start}.`);
  }
  if (!Number.isFinite(count) || requestedCount !== qty) {
    warnLocal(`Address is invalid. Accepted count range is 1-${maxCountFromStart} for start ${start}. Applied ${qty}.`);
  }

  holdingRegisterState.startAddress = start;
  holdingRegisterState.registerCount = qty;

  const next = generateRegisters(start, qty);
  const existing = new Map(holdingRegisterState.entries.map((entry) => [entry.address, entry]));

  for (const entry of next) {
    const prev = existing.get(entry.address);
    if (prev) {
      entry.slaveValue = prev.slaveValue;
      entry.desiredValue = prev.desiredValue;
      entry.pending = false;
      entry.writeError = prev.writeError;
      entry.lastReadAt = prev.lastReadAt;
      entry.lastWriteAt = prev.lastWriteAt;
      entry.label = prev.label;
      entry.origin = prev.origin;
      entry.rule = prev.rule;
    }
  }

  const customCandidates = holdingRegisterState.entries
    .filter((prev) => prev.origin === "custom" && !next.some((entry) => entry.address === prev.address))
    .sort((a, b) => a.address - b.address);

  const rangeEnd = start + qty - 1;
  const acceptedCustomMin = Math.max(HOLDING_ADDRESS_MIN, rangeEnd - (HOLDING_MAX_COUNT - 1));
  const acceptedCustomMax = Math.min(HOLDING_ADDRESS_MAX, start + (HOLDING_MAX_COUNT - 1));
  const keptCustom = customCandidates.filter(
    (entry) => entry.address >= acceptedCustomMin && entry.address <= acceptedCustomMax,
  );
  next.push(...keptCustom);

  const droppedCustom = customCandidates.length - keptCustom.length;
  if (droppedCustom > 0) {
    warnLocal(`Address is invalid. Accepted address range is ${acceptedCustomMin}-${acceptedCustomMax} for custom registers at this range; dropped ${droppedCustom} custom register${droppedCustom === 1 ? "" : "s"}.`);
  }

  const sanitized = filterIbusReservedHoldingEntries(next);
  sanitized.sort((a, b) => a.address - b.address);
  holdingRegisterState.entries = sanitized;

  warnLargeDatasetConsequences(holdingRegisterState.entries.length);
  syncHoldingRegAddressesToBackend();
}

export function addHoldingRegisterRange(startAddress: number, count: number): void {
  const requestedStart = Math.floor(startAddress);
  const requestedCount = Math.floor(count);

  const start = Math.max(HOLDING_ADDRESS_MIN, Math.min(HOLDING_ADDRESS_MAX, requestedStart));
  const maxCountFromStart = Math.min(HOLDING_MAX_COUNT, HOLDING_ADDRESS_MAX - start + 1);
  const qty = Math.max(1, Math.min(maxCountFromStart, requestedCount));

  if (!Number.isFinite(startAddress) || requestedStart !== start) {
    warnLocal(`Address is invalid. Accepted start range is ${HOLDING_ADDRESS_MIN}-${HOLDING_ADDRESS_MAX}. Applied ${start}.`);
  }
  if (!Number.isFinite(count) || requestedCount !== qty) {
    warnLocal(`Address is invalid. Accepted count range is 1-${maxCountFromStart} for start ${start}. Applied ${qty}.`);
  }

  holdingRegisterState.startAddress = start;
  holdingRegisterState.registerCount = qty;

  const existingByAddress = new Map(holdingRegisterState.entries.map((entry) => [entry.address, entry]));

  for (const rangeEntry of generateRegisters(start, qty)) {
    if (existingByAddress.has(rangeEntry.address)) {
      continue;
    }

    existingByAddress.set(rangeEntry.address, {
      ...rangeEntry,
      origin: "range",
    });
  }

  const sanitized = filterIbusReservedHoldingEntries([...existingByAddress.values()]);
  holdingRegisterState.entries = sanitized.sort((a, b) => a.address - b.address);

  warnLargeDatasetConsequences(holdingRegisterState.entries.length);
  syncHoldingRegAddressesToBackend();
}

export function addExclusiveHoldingRegister(address: number): boolean {
  // Modbus limit: max 65536 holding registers address space
  if (holdingRegisterState.entries.length >= HOLDING_MAX_COUNT) {
    warnLocal(`Address is invalid. Accepted count range is 1-${HOLDING_MAX_COUNT}; already at ${HOLDING_MAX_COUNT}.`);
    return false;
  }

  const normalized = Math.floor(address);
  if (!Number.isFinite(normalized) || normalized < HOLDING_ADDRESS_MIN || normalized > HOLDING_ADDRESS_MAX) {
    warnLocal(`Address is invalid. Accepted address range is ${HOLDING_ADDRESS_MIN}-${HOLDING_ADDRESS_MAX}.`);
    return false;
  }

  if (isIbusModeEnabled() && isIbusReservedHoldingAddress(normalized)) {
    warnLocal(`iBus mode reserves HR ${IBUS_RESERVED_HR_START}-${IBUS_RESERVED_HR_END}. Address ${normalized} is blocked.`);
    return false;
  }

  if (holdingRegisterState.entries.some((e) => e.address === normalized)) {
    return false;
  }

  const customEntry: HoldingRegisterEntry = {
    address: normalized,
    slaveValue: 0,
    desiredValue: 0,
    pending: false,
    readError: null,
    writeError: null,
    lastReadAt: null,
    lastWriteAt: null,
    label: "",
    origin: "custom",
    rule: defaultHoldingRegRule(),
  };

  holdingRegisterState.entries = [...holdingRegisterState.entries, customEntry]
    .sort((a, b) => a.address - b.address);

  warnLargeDatasetConsequences(holdingRegisterState.entries.length);
  // Register the new address in the Rust data store
  void invoke("store_write_holding_reg", { address: normalized, value: 0 });

  return true;
}

export function generateRandomExclusiveHoldingRegisterAddress(): number | null {
  // Modbus limit: max 65536 holding registers address space
  if (holdingRegisterState.entries.length >= HOLDING_MAX_COUNT) {
    warnLocal(`Address is invalid. Accepted count range is 1-${HOLDING_MAX_COUNT}; already at ${HOLDING_MAX_COUNT}.`);
    return null;
  }

  if (holdingRegisterState.entries.length >= HOLDING_ADDRESS_MAX + 1) {
    return null;
  }

  const used = new Set(holdingRegisterState.entries.map((e) => e.address));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const addr = Math.floor(Math.random() * (HOLDING_ADDRESS_MAX + 1));
    if (isIbusModeEnabled() && isIbusReservedHoldingAddress(addr)) continue;
    if (!used.has(addr)) return addr;
  }

  for (let addr = HOLDING_ADDRESS_MIN; addr <= HOLDING_ADDRESS_MAX; addr += 1) {
    if (isIbusModeEnabled() && isIbusReservedHoldingAddress(addr)) continue;
    if (!used.has(addr)) return addr;
  }

  return null;
}

export function removeHoldingRegister(address: number): void {
  setHoldingRegisterRule(address, defaultHoldingRegRule());
  holdingRegisterState.entries = holdingRegisterState.entries.filter((entry) => entry.address !== address);
  void invoke("store_remove_holding_reg", { address });
}

export function removeAllHoldingRegisters(): void {
  clearAllHoldingRegisterRules();
  holdingRegisterState.entries = [];
  void invoke("store_clear_holding_regs", {});
}

export function syncHoldingRegAddressesToBackend(): void {
  const addresses = holdingRegisterState.entries.map((e) => e.address);
  void invoke("store_sync_holding_reg_addresses", { addresses });
  void runHoldingRegisterUiSyncTick();
}


const RULE_INTERVAL_OPTIONS: { ms: number; label: string }[] = [
  { ms: 500, label: "500 ms" },
  { ms: 1000, label: "1 s" },
  { ms: 2000, label: "2 s" },
  { ms: 5000, label: "5 s" },
  { ms: 10000, label: "10 s" },
  { ms: 30000, label: "30 s" },
];
export { RULE_INTERVAL_OPTIONS };

const ruleTimers = new Map<number, ReturnType<typeof setInterval>>();

export function setHoldingRegisterRule(address: number, rule: HoldingRegRule): void {
  const entry = holdingRegisterState.entries.find((e) => e.address === address);
  if (!entry) return;

  const existing = ruleTimers.get(address);
  if (existing !== undefined) {
    clearInterval(existing);
    ruleTimers.delete(address);
  }

  entry.rule = normalizeRule(rule);

  if (entry.rule.type === "cycle") {
    let writeMinNext = false;
    const timer = setInterval(() => {
      const current = holdingRegisterState.entries.find((e) => e.address === address);
      if (!current || current.pending) return;

      const nextValue = writeMinNext ? current.rule.minValue : current.rule.maxValue;
      writeMinNext = !writeMinNext;
      current.desiredValue = nextValue;
      void writeHoldingRegisterValue(address, nextValue);
    }, Math.max(100, entry.rule.intervalMs));
    ruleTimers.set(address, timer);
  }

  if (entry.rule.type === "sawtooth") {
    const timer = setInterval(() => {
      const current = holdingRegisterState.entries.find((e) => e.address === address);
      if (!current || current.pending) return;

      const next = current.slaveValue + current.rule.step > current.rule.maxValue
        ? current.rule.minValue
        : current.slaveValue + current.rule.step;
      current.desiredValue = next;
      void writeHoldingRegisterValue(address, next);
    }, Math.max(100, entry.rule.intervalMs));
    ruleTimers.set(address, timer);
  }

  if (entry.rule.type === "triangle") {
    let direction: 1 | -1 = 1;
    const timer = setInterval(() => {
      const current = holdingRegisterState.entries.find((e) => e.address === address);
      if (!current || current.pending) return;

      let next = current.slaveValue + direction * current.rule.step;
      if (next >= current.rule.maxValue) {
        next = current.rule.maxValue;
        direction = -1;
      } else if (next <= current.rule.minValue) {
        next = current.rule.minValue;
        direction = 1;
      }

      current.desiredValue = next;
      void writeHoldingRegisterValue(address, next);
    }, Math.max(100, entry.rule.intervalMs));
    ruleTimers.set(address, timer);
  }

  if (entry.rule.type === "sine") {
    const startAt = Date.now();
    const timer = setInterval(() => {
      const current = holdingRegisterState.entries.find((e) => e.address === address);
      if (!current || current.pending) return;

      const elapsed = Date.now() - startAt;
      const phase = (elapsed % current.rule.periodMs) / current.rule.periodMs;
      const radians = phase * Math.PI * 2;
      const center = (current.rule.minValue + current.rule.maxValue) / 2;
      const amplitude = (current.rule.maxValue - current.rule.minValue) / 2;
      const nextValue = normalizeU16(Math.round(center + amplitude * Math.sin(radians)), current.slaveValue);
      current.desiredValue = nextValue;
      void writeHoldingRegisterValue(address, nextValue);
    }, Math.max(100, entry.rule.intervalMs));
    ruleTimers.set(address, timer);
  }
}

export function clearAllHoldingRegisterRules(): void {
  for (const timer of ruleTimers.values()) {
    clearInterval(timer);
  }
  ruleTimers.clear();
}

export function getFilteredHoldingRegisters(): HoldingRegisterEntry[] {
  const valueFiltered = (() => {
    switch (holdingRegisterState.filter) {
      case "non-zero":
        return holdingRegisterState.entries.filter((entry) => entry.slaveValue !== 0);
      case "zero":
        return holdingRegisterState.entries.filter((entry) => entry.slaveValue === 0);
      default:
        return holdingRegisterState.entries;
    }
  })();

  const rangeStart = Math.min(holdingRegisterState.addressRangeStart, holdingRegisterState.addressRangeEnd);
  const rangeEnd = Math.max(holdingRegisterState.addressRangeStart, holdingRegisterState.addressRangeEnd);
  const inRange = (address: number): boolean => address >= rangeStart && address <= rangeEnd;
  const listSet = new Set(holdingRegisterState.addressList);

  switch (holdingRegisterState.addressFilter) {
    case "required-range":
      return valueFiltered.filter((entry) => inRange(entry.address));
    case "non-required-range":
      return valueFiltered.filter((entry) => !inRange(entry.address));
    case "required-list":
      return valueFiltered.filter((entry) => listSet.has(entry.address));
    case "not-required-list":
      return valueFiltered.filter((entry) => !listSet.has(entry.address));
    default:
      return valueFiltered;
  }
}
