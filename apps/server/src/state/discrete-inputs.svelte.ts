// Coils state — FC 01 (Read) · FC 05 (Write Single) · FC 15 (Write Multiple)

import { invoke } from "@tauri-apps/api/core";
import { addLog } from "./logs.svelte";
import { notifyWarning } from "./notifications.svelte";
import {
  getGlobalPollingMaxAddressCount,
  getSettingsSnapshot,
  isPollingAllowedForCount,
} from "./settings.svelte";

export type DiscreteInputView = "table" | "switch";
export type DiscreteInputFilter = "all" | "on" | "off";
export type DiscreteInputAddressFilter =
  | "all"
  | "required-range"
  | "non-required-range"
  | "required-list"
  | "not-required-list";
export type DiscreteInputOrigin = "range" | "custom";
export type MassWritePattern =
  | "all-on"
  | "all-off"
  | "alternating"
  | "alternating-inv"
  | "every-third"
  | "random";
export type WriteMode = "once" | "auto-toggle";

export type DiscreteInputRuleType = "none" | "auto-toggle";

export interface DiscreteInputRule {
  type: DiscreteInputRuleType;
  intervalMs: number;
}

export const DEFAULT_RULE: DiscreteInputRule = { type: "none", intervalMs: 1000 };

export interface DiscreteInputEntry {
  address: number;
  slaveValue: boolean;
  desiredValue: boolean;
  pending: boolean;
  writeError: string | null;
  label: string;
  origin: DiscreteInputOrigin;
}

interface StoreReadBoolEntry {
  address: number;
  value: boolean;
}

interface BackendWriteDiscreteInputResponse {
  address: number;
  value: boolean;
}

interface BackendWriteMassDiscreteInputsResponse {
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

function warnLocal(message: string): void {
  addLog("warn", message);
  notifyWarning(message);
}


const DISCRETE_INPUT_VIEW_KEY = "Modbus-Lab.coilView";
const DISCRETE_INPUT_MAX_COUNT = 65536; // Modbus spec: 16-bit address space
const MODBUS_ADDRESS_MIN = 0;
const MODBUS_ADDRESS_MAX = DISCRETE_INPUT_MAX_COUNT - 1; // 0x0000-0xFFFF

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

function generateDiscreteInputs(startAddress: number, count: number): DiscreteInputEntry[] {
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

export const discreteInputState = $state({
  view: "table" as DiscreteInputView,
  filter: "all" as DiscreteInputFilter,
  addressFilter: "all" as DiscreteInputAddressFilter,
  addressRangeStart: 0,
  addressRangeEnd: 0,
  addressList: [] as number[],
  entries: [] as DiscreteInputEntry[],
  startAddress: 0,
  inputCount: 16,
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

// ── Per-address rule state ────────────────────────────────────────────────────
export const discreteInputRules = $state<Record<number, DiscreteInputRule>>({});
const ruleTimers = new Map<number, ReturnType<typeof setInterval>>();
let readAllInFlight = false;
let autoToggleWriteInFlight = false;

// ── Init ──────────────────────────────────────────────────────────────────────

export function initDiscreteInputState(): void {
  const settings = getSettingsSnapshot();

  if (!settings.rememberLastFeatureState) {
    discreteInputState.view = settings.defaults.discreteInputs.view === "switch" ? "switch" : "table";
    applyDiscreteInputAddressRange(settings.defaults.discreteInputs.startAddress, settings.defaults.discreteInputs.count);
  } else {
    const savedView = localStorage.getItem(DISCRETE_INPUT_VIEW_KEY);
    if (savedView === "switch" || savedView === "table") {
      discreteInputState.view = savedView;
    }
    if (discreteInputState.entries.length === 0) {
      applyDiscreteInputAddressRange(settings.defaults.discreteInputs.startAddress, settings.defaults.discreteInputs.count);
    }
  }

  setDiscreteInputPollInterval(settings.polling.defaultIntervalMs);
}

// ── View & Filter ─────────────────────────────────────────────────────────────

export function setDiscreteInputView(view: DiscreteInputView): void {
  discreteInputState.view = view;
  localStorage.setItem(DISCRETE_INPUT_VIEW_KEY, view);
}

export function setDiscreteInputFilter(filter: DiscreteInputFilter): void {
  discreteInputState.filter = filter;
}

export function setDiscreteInputAddressFilter(filter: DiscreteInputAddressFilter): void {
  discreteInputState.addressFilter = filter;
}

export function setDiscreteInputAddressRange(startAddress: number, endAddress: number): void {
  const start = Math.max(MODBUS_ADDRESS_MIN, Math.min(MODBUS_ADDRESS_MAX, Math.floor(startAddress)));
  const end = Math.max(MODBUS_ADDRESS_MIN, Math.min(MODBUS_ADDRESS_MAX, Math.floor(endAddress)));
  discreteInputState.addressRangeStart = Math.min(start, end);
  discreteInputState.addressRangeEnd = Math.max(start, end);
}

export function setDiscreteInputAddressList(addresses: number[]): void {
  const normalized = addresses
    .map((a) => Math.floor(a))
    .filter((a) => Number.isFinite(a) && a >= MODBUS_ADDRESS_MIN && a <= MODBUS_ADDRESS_MAX);
  discreteInputState.addressList = [...new Set(normalized)].sort((a, b) => a - b);
}

// ── Single coil ───────────────────────────────────────────────────────────────

export function toggleDiscreteInputValue(address: number): void {
  const entry = discreteInputState.entries.find((e) => e.address === address);
  if (!entry) return;
  entry.desiredValue = !entry.desiredValue;
  entry.writeError = null;
  addLog("info", `DI.store.set ok addr=${address} val=${entry.desiredValue ? 1 : 0}`);
}

export function setDiscreteInputValue(address: number, value: boolean): void {
  const entry = discreteInputState.entries.find((e) => e.address === address);
  if (!entry) return;
  const changed = entry.desiredValue !== value;
  entry.desiredValue = value;
  entry.writeError = null;
  if (changed) {
    addLog("info", `DI.store.set ok addr=${address} val=${value ? 1 : 0}`);
  }
}

export function syncAllSlaveToDesired(): number {
  let changed = 0;
  for (const entry of discreteInputState.entries) {
    if (entry.desiredValue !== entry.slaveValue || entry.writeError !== null) {
      changed += 1;
    }
    entry.desiredValue = entry.slaveValue;
    entry.writeError = null;
  }
  return changed;
}

export async function writeDiscreteInput(address: number): Promise<void> {
  const entry = discreteInputState.entries.find((e) => e.address === address);
  if (!entry) return;
  const valueToWrite = entry.desiredValue;
  entry.pending = true;
  entry.writeError = null;
  try {
    await invoke("store_set_discrete_input", { address, value: valueToWrite });
    const e = discreteInputState.entries.find((e2) => e2.address === address);
    if (e) {
      e.slaveValue = valueToWrite;
      e.pending = false;
      e.writeError = null;
    }
  } catch (err) {
    const e = discreteInputState.entries.find((e2) => e2.address === address);
    const message = parseInvokeError(err);
    if (e) {
      e.pending = false;
      e.writeError = message;
    }
  }
}

export async function writePendingDiscreteInputs(): Promise<number> {
  const pending = discreteInputState.entries.filter((e) => e.desiredValue !== e.slaveValue);
  if (pending.length === 0) return 0;
  const valueMap = new Map<number, boolean>(pending.map((entry) => [entry.address, entry.desiredValue]));
  const response = await writeAddressMap(valueMap);
  return response?.writtenCount ?? 0;
}

export async function readDiscreteInput(address: number): Promise<void> {
  const entry = discreteInputState.entries.find((e) => e.address === address);
  if (!entry) return;
  entry.pending = true;
  try {
    const results = await invoke<StoreReadBoolEntry[]>("store_read_discrete_inputs", { addresses: [address] });
    const e = discreteInputState.entries.find((e2) => e2.address === address);
    if (e) {
      const found = results.find((r) => r.address === address);
      if (found !== undefined) {
        e.slaveValue = found.value;
        e.writeError = null;
      }
      e.pending = false;
    }
    addLog("info", `store.read ok addr=${address} val=${results[0]?.value ? 1 : 0}`);
  } catch (err) {
    const e = discreteInputState.entries.find((e2) => e2.address === address);
    const reason = parseInvokeError(err);
    if (e) {
      e.pending = false;
      e.writeError = reason;
    }
    addLog("error", `store.read err addr=${address} msg=${reason}`);
  }
}

export function setDiscreteInputLabel(address: number, label: string): void {
  const entry = discreteInputState.entries.find((e) => e.address === address);
  if (entry) entry.label = label;
}

// ── Pattern helpers ───────────────────────────────────────────────────────────

function getRangeAddresses(from: number, to: number): number[] {
  const start = Math.min(from, to);
  const end = Math.max(from, to);
  const inRange: number[] = [];
  for (const entry of discreteInputState.entries) {
    if (entry.address >= start && entry.address <= end) {
      inRange.push(entry.address);
    }
  }
  return inRange;
}

function getTargetAddresses(): number[] {
  return getRangeAddresses(discreteInputState.massFrom, discreteInputState.massTo);
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
  valueMap: Map<number, boolean>,
  source: "ui" | "auto-toggle" = "ui",
): Promise<BackendWriteMassDiscreteInputsResponse | null> {
  if (valueMap.size === 0) return null;

  const sourceTag = source === "auto-toggle" ? "srv.auto" : "srv.ui";

  const planSections = buildAddressSections([...valueMap.keys()].sort((a, b) => a - b));
  addLog(
    "info",
    `${sourceTag} fc15.write plan req=${valueMap.size} sections=${planSections.length} sample=${formatSectionPreview(planSections)}`,
  );

  // Set pending state immediately
  for (const [address, value] of valueMap) {
    const entry = discreteInputState.entries.find((e) => e.address === address);
    if (entry) {
      entry.desiredValue = value;
      entry.pending = true;
      entry.writeError = null;
    }
  }

  // Convert to array for batch request
  const coils = Array.from(valueMap, ([address, value]) => ({ address, value }));

  try {
    // No batch command — use individual store_set_discrete_input calls
    const rawResults = await Promise.allSettled(
      coils.map(({ address: addr, value: val }) =>
        invoke("store_set_discrete_input", { address: addr, value: val })
      )
    );
    const batchFailures: Array<{ address: number; code: string; message: string }> = [];
    coils.forEach(({ address: addr }, i) => {
      if (rawResults[i].status === "rejected") {
        const msg = parseInvokeError((rawResults[i] as PromiseRejectedResult).reason);
        batchFailures.push({ address: addr, code: "store-error", message: msg });
      }
    });
    const response = { writtenCount: coils.length - batchFailures.length, totalCount: coils.length, failures: batchFailures };

    const failureMap = new Map(response.failures.map((failure) => [failure.address, failure]));

    // Update state based on per-address results
    for (const [address, value] of valueMap) {
      const e = discreteInputState.entries.find((e2) => e2.address === address);
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
      addLog("info", `${sourceTag} fc15.write ok req=${response.totalCount} ok=${response.writtenCount} fail=0`);
    } else {
      const failedAddresses = response.failures.map((failure) => failure.address).join(", ");
      const failureCodes = [...new Set(response.failures.map((failure) => failure.code))].join(", ");
      addLog(
        "warn",
        `${sourceTag} fc15.write partial req=${response.totalCount} ok=${response.writtenCount} fail=${response.failures.length} addrs=${failedAddresses} codes=${failureCodes}`
      );
    }

    return response;
  } catch (err) {
    // Clear pending on all entries on batch failure
    const message = parseInvokeError(err);
    for (const address of valueMap.keys()) {
      const e = discreteInputState.entries.find((e2) => e2.address === address);
      if (e) {
        e.pending = false;
        e.writeError = message;
      }
    }
    return null;
  }
}

function invertAddresses(addresses: number[]): void {
  for (const address of addresses) {
    const entry = discreteInputState.entries.find((e) => e.address === address);
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
  const valueMap = computePatternValues(discreteInputState.massPattern, targets);
  await writeAddressMap(valueMap);
}

export function startAutoToggle(): void {
  if (autoToggleTimer) clearInterval(autoToggleTimer);
  discreteInputState.massAutoActive = true;

  // First pass: apply the selected pattern immediately
  const initialTargets = getTargetAddresses();
  const initialMap = computePatternValues(discreteInputState.massPattern, initialTargets);
  void (async () => {
    if (autoToggleWriteInFlight) return;
    autoToggleWriteInFlight = true;
    try {
      await writeAddressMap(initialMap, "auto-toggle");
    } finally {
      autoToggleWriteInFlight = false;
    }
  })();

  autoToggleTimer = setInterval(() => {
    if (autoToggleWriteInFlight) {
      return;
    }

    const targets = getTargetAddresses();
    invertAddresses(targets);
    const invertMap = new Map(targets.map((addr) => {
      const entry = discreteInputState.entries.find((e) => e.address === addr);
      return [addr, entry?.desiredValue ?? false] as [number, boolean];
    }));

    void (async () => {
      autoToggleWriteInFlight = true;
      try {
        await writeAddressMap(invertMap, "auto-toggle");
      } finally {
        autoToggleWriteInFlight = false;
      }
    })();
  }, discreteInputState.massAutoInterval);
}

export function stopAutoToggle(): void {
  if (autoToggleTimer) {
    clearInterval(autoToggleTimer);
    autoToggleTimer = null;
  }
  discreteInputState.massAutoActive = false;
  autoToggleWriteInFlight = false;
}

export function setMassAutoInterval(ms: number): void {
  discreteInputState.massAutoInterval = ms;
  if (discreteInputState.massAutoActive) {
    startAutoToggle();
  }
}

function upsertAndSortEntries(next: DiscreteInputEntry[]): void {
  const map = new Map<number, DiscreteInputEntry>();
  for (const entry of next) {
    map.set(entry.address, entry);
  }
  discreteInputState.entries = [...map.values()].sort((a, b) => a.address - b.address);
}

function getDiscreteInputAcceptedAddressRange(): { min: number; max: number } {
  if (discreteInputState.entries.length === 0) {
    return { min: MODBUS_ADDRESS_MIN, max: MODBUS_ADDRESS_MAX };
  }

  const addresses = discreteInputState.entries.map((e) => e.address);
  const currentMin = Math.min(...addresses);
  const currentMax = Math.max(...addresses);

  return {
    min: Math.max(MODBUS_ADDRESS_MIN, currentMax - (DISCRETE_INPUT_MAX_COUNT - 1)),
    max: Math.min(MODBUS_ADDRESS_MAX, currentMin + (DISCRETE_INPUT_MAX_COUNT - 1)),
  };
}

export function addExclusiveDiscreteInput(address: number): boolean {
  // Modbus limit: max 2000 coils per read
  if (discreteInputState.entries.length >= DISCRETE_INPUT_MAX_COUNT) {
    warnLocal(`Address is invalid. Accepted count range is 1-${DISCRETE_INPUT_MAX_COUNT}; already at ${DISCRETE_INPUT_MAX_COUNT}.`);
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

  const accepted = getDiscreteInputAcceptedAddressRange();
  if (normalized < accepted.min || normalized > accepted.max) {
    warnLocal(`Address is invalid. Accepted address range is ${accepted.min}-${accepted.max} to keep max span ${DISCRETE_INPUT_MAX_COUNT}.`);
    return false;
  }

  if (discreteInputState.entries.some((e) => e.address === normalized)) return false;

  upsertAndSortEntries([
    ...discreteInputState.entries,
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
  // Register the new address in the Rust data store (value=false)
  void invoke("store_set_discrete_input", { address: normalized, value: false });
  return true;
}

function pickRandomAvailableDiscreteInputAddress(): number | null {
  // Modbus limit: max 2000 coils per read
  if (discreteInputState.entries.length >= DISCRETE_INPUT_MAX_COUNT) {
    warnLocal(`Address is invalid. Accepted count range is 1-${DISCRETE_INPUT_MAX_COUNT}; already at ${DISCRETE_INPUT_MAX_COUNT}.`);
    return null;
  }

  const used = new Set(discreteInputState.entries.map((e) => e.address));
  const accepted = getDiscreteInputAcceptedAddressRange();
  const pool: number[] = [];

  // Pick from current range neighborhood first, then broaden.
  const preferredMin = Math.max(accepted.min, discreteInputState.startAddress);
  const preferredMax = Math.min(accepted.max, discreteInputState.startAddress + discreteInputState.inputCount + 255);
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

export function generateRandomExclusiveDiscreteInputAddress(): number | null {
  return pickRandomAvailableDiscreteInputAddress();
}

export function addRandomExclusiveDiscreteInput(): number | null {
  const picked = pickRandomAvailableDiscreteInputAddress();
  if (picked === null) return null;
  addExclusiveDiscreteInput(picked);
  return picked;
}

export function removeDiscreteInput(address: number): void {
  stopRuleTimer(address);
  delete discreteInputRules[address];
  discreteInputState.entries = discreteInputState.entries.filter((e) => e.address !== address);
  void invoke("store_remove_discrete_input", { address });
}

export function removeAllDiscreteInputs(): void {
  clearAllDiscreteInputRules();
  discreteInputState.entries = [];
  void invoke("store_clear_discrete_inputs", {});
}

// ── Per-address rules ─────────────────────────────────────────────────────────

function stopRuleTimer(address: number): void {
  const timer = ruleTimers.get(address);
  if (timer !== undefined) {
    clearInterval(timer);
    ruleTimers.delete(address);
  }
}

export function getDiscreteInputRule(address: number): DiscreteInputRule {
  return discreteInputRules[address] ?? DEFAULT_RULE;
}

export function setDiscreteInputRule(address: number, rule: DiscreteInputRule): void {
  stopRuleTimer(address);
  if (rule.type === "none") {
    delete discreteInputRules[address];
  } else {
    discreteInputRules[address] = { ...rule };
    if (rule.type === "auto-toggle") {
      const timer = setInterval(() => {
        const entry = discreteInputState.entries.find((e) => e.address === address);
        if (!entry) {
          stopRuleTimer(address);
          delete discreteInputRules[address];
          return;
        }
        toggleDiscreteInputValue(address);
        void writeDiscreteInput(address);
      }, rule.intervalMs);
      ruleTimers.set(address, timer);
    }
  }
}

export function clearAllDiscreteInputRules(): void {
  for (const timer of ruleTimers.values()) {
    clearInterval(timer);
  }
  ruleTimers.clear();
  for (const key of Object.keys(discreteInputRules)) {
    delete discreteInputRules[Number(key)];
  }
}

// ── Poll ──────────────────────────────────────────────────────────────────────

export async function readAllDiscreteInputs(): Promise<void> {
  if (readAllInFlight) return;
  readAllInFlight = true;
  try {
    if (discreteInputState.entries.length === 0) return;
    const addresses = discreteInputState.entries.map((e) => e.address);
    const results = await invoke<StoreReadBoolEntry[]>("store_read_discrete_inputs", { addresses });
    const resultMap = new Map(results.map((r) => [r.address, r.value]));
    let okCount = 0;
    for (const entry of discreteInputState.entries) {
      if (resultMap.has(entry.address)) {
        entry.slaveValue = resultMap.get(entry.address) ?? entry.slaveValue;
        entry.writeError = null;
        okCount += 1;
      }
    }
    addLog("info", `store.read ok total=${discreteInputState.entries.length} ok=${okCount}`);
  } catch (err) {
    addLog("error", `store.read err msg=${parseInvokeError(err)}`);
  } finally {
    readAllInFlight = false;
  }
}
export function setDiscreteInputPollActive(active: boolean): void {
  if (active && !isPollingAllowedForCount(discreteInputState.entries.length)) {
    warnLocal(
      `Polling disabled for lists larger than ${getGlobalPollingMaxAddressCount()} addresses. Use Read once for bulk refresh.`,
    );
    discreteInputState.pollActive = false;
    return;
  }

  discreteInputState.pollActive = active;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (active) {
    void readAllDiscreteInputs();
    pollTimer = setInterval(() => { void readAllDiscreteInputs(); }, discreteInputState.pollInterval);
  }
}

export function setDiscreteInputPollInterval(ms: number): void {
  discreteInputState.pollInterval = ms;
  if (discreteInputState.pollActive) setDiscreteInputPollActive(true); // restart with new interval
}

// ── Address range ─────────────────────────────────────────────────────────────

export function applyDiscreteInputAddressRange(startAddress: number, count: number): void {
  // Stop active operations before changing range
  if (discreteInputState.massAutoActive) stopAutoToggle();
  if (discreteInputState.pollActive) setDiscreteInputPollActive(false);

  const requestedStart = Math.floor(startAddress);
  const requestedCount = Math.floor(count);

  const start = Math.max(MODBUS_ADDRESS_MIN, Math.min(MODBUS_ADDRESS_MAX, requestedStart));
  const maxCountFromStart = Math.min(DISCRETE_INPUT_MAX_COUNT, MODBUS_ADDRESS_MAX - start + 1);
  const qty = Math.max(1, Math.min(maxCountFromStart, requestedCount));

  if (!Number.isFinite(startAddress) || requestedStart !== start) {
    warnLocal(`Address is invalid. Accepted start range is ${MODBUS_ADDRESS_MIN}-${MODBUS_ADDRESS_MAX}. Applied ${start}.`);
  }
  if (!Number.isFinite(count) || requestedCount !== qty) {
    warnLocal(`Address is invalid. Accepted count range is 1-${maxCountFromStart} for start ${start}. Applied ${qty}.`);
  }

  discreteInputState.startAddress = start;
  discreteInputState.inputCount = qty;

  // Keep custom-added coils while rebuilding base range entries.
  const customEntries = discreteInputState.entries.filter((e) => e.origin === "custom");
  const rangeEntries = generateDiscreteInputs(start, qty).map((entry) => {
    const existing = discreteInputState.entries.find((e) => e.address === entry.address);
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
  const acceptedCustomMin = Math.max(MODBUS_ADDRESS_MIN, rangeEnd - (DISCRETE_INPUT_MAX_COUNT - 1));
  const acceptedCustomMax = Math.min(MODBUS_ADDRESS_MAX, start + (DISCRETE_INPUT_MAX_COUNT - 1));
  const keptCustom = customCandidates.filter(
    (entry) => entry.address >= acceptedCustomMin && entry.address <= acceptedCustomMax,
  );

  upsertAndSortEntries([...rangeEntries, ...keptCustom]);

  const droppedCustom = customCandidates.length - keptCustom.length;
  if (droppedCustom > 0) {
    warnLocal(`Address is invalid. Accepted address range is ${acceptedCustomMin}-${acceptedCustomMax} for custom coils at this range; dropped ${droppedCustom} custom coil${droppedCustom === 1 ? "" : "s"}.`);
  }

  // Reset mass-write range to match new entries
  discreteInputState.massFrom = start;
  discreteInputState.massTo = start + qty - 1;

  // Sync registered addresses in the Rust data store
  syncDiscreteInputAddressesToBackend();
}

export function addDiscreteInputRange(startAddress: number, count: number): void {
  if (discreteInputState.massAutoActive) stopAutoToggle();

  const requestedStart = Math.floor(startAddress);
  const requestedCount = Math.floor(count);

  const start = Math.max(MODBUS_ADDRESS_MIN, Math.min(MODBUS_ADDRESS_MAX, requestedStart));
  const maxCountFromStart = Math.min(DISCRETE_INPUT_MAX_COUNT, MODBUS_ADDRESS_MAX - start + 1);
  const qty = Math.max(1, Math.min(maxCountFromStart, requestedCount));

  if (!Number.isFinite(startAddress) || requestedStart !== start) {
    warnLocal(`Address is invalid. Accepted start range is ${MODBUS_ADDRESS_MIN}-${MODBUS_ADDRESS_MAX}. Applied ${start}.`);
  }
  if (!Number.isFinite(count) || requestedCount !== qty) {
    warnLocal(`Address is invalid. Accepted count range is 1-${maxCountFromStart} for start ${start}. Applied ${qty}.`);
  }

  discreteInputState.startAddress = start;
  discreteInputState.inputCount = qty;

  // Merge: only add addresses not already present
  const existingByAddress = new Map(discreteInputState.entries.map((e) => [e.address, e]));
  for (const newEntry of generateDiscreteInputs(start, qty)) {
    if (!existingByAddress.has(newEntry.address)) {
      existingByAddress.set(newEntry.address, newEntry);
    }
  }

  upsertAndSortEntries([...existingByAddress.values()]);
  // Sync registered addresses in the Rust data store
  syncDiscreteInputAddressesToBackend();
}

// ── Filtered view ─────────────────────────────────────────────────────────────

export function syncDiscreteInputAddressesToBackend(): void {
  const addresses = discreteInputState.entries.map((e) => e.address);
  void invoke("store_sync_discrete_input_addresses", { addresses });
}

export function getFilteredDiscreteInputs(): DiscreteInputEntry[] {
  const valueFiltered = (() => {
    switch (discreteInputState.filter) {
      case "on":
        return discreteInputState.entries.filter((entry) => entry.slaveValue);
      case "off":
        return discreteInputState.entries.filter((entry) => !entry.slaveValue);
      default:
        return discreteInputState.entries;
    }
  })();

  const rangeStart = Math.min(discreteInputState.addressRangeStart, discreteInputState.addressRangeEnd);
  const rangeEnd = Math.max(discreteInputState.addressRangeStart, discreteInputState.addressRangeEnd);
  const inRange = (address: number): boolean => address >= rangeStart && address <= rangeEnd;
  const listSet = new Set(discreteInputState.addressList);

  switch (discreteInputState.addressFilter) {
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

/** Build a preview string for the current mass-write pattern & range */
export function buildMassPreview(): string {
  const targets = getTargetAddresses();
  const total = targets.length;
  if (total <= 0) return "—";

  const preview: string[] = [];
  const cap = Math.min(total, 20);
  for (let i = 0; i < cap; i++) {
    switch (discreteInputState.massPattern) {
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
