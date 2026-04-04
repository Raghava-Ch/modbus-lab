// Input Registers state — FC 04 (Read) · Read-only

import { invoke } from "@tauri-apps/api/core";
import { addLog } from "./logs.svelte";
import { notifyWarning } from "./notifications.svelte";
import {
  getGlobalPollingMaxAddressCount,
  getSettingsSnapshot,
  isPollingAllowedForCount,
} from "./settings.svelte";

export type InputRegisterView = "table" | "cards";
export type InputRegisterFilter = "all" | "non-zero" | "zero";
export type InputRegisterOrigin = "range" | "custom";
export type InputRegisterAddressFilter =
  | "all"
  | "required-range"
  | "non-required-range"
  | "required-list"
  | "not-required-list";

export interface InputRegisterEntry {
  address: number;
  value: number;
  pending: boolean;
  readError: string | null;
  lastReadAt: number | null;
  label: string;
  origin: InputRegisterOrigin;
}

interface BackendReadInputRegistersResponse {
  registers: Array<{ address: number; value: number }>;
  startAddress: number;
  quantity: number;
}

interface AddressSection {
  start: number;
  quantity: number;
}

function parseInvokeError(err: unknown): string {
  if (typeof err === "string") {
    try {
      const parsed = JSON.parse(err) as { message?: string };
      return parsed.message ?? err;
    } catch {
      return err;
    }
  }
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return "Unknown error";
}

function warnLocal(message: string): void {
  addLog("warn", message);
  notifyWarning(message);
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

const INPUT_VIEW_KEY = "Modbus-Lab.inputRegView";
const INPUT_MAX_COUNT = 65536;
const INPUT_ADDRESS_MIN = 0;
const INPUT_ADDRESS_MAX = INPUT_MAX_COUNT - 1;
const INPUT_READ_CHUNK_MAX = 125;
const INPUT_PERF_WARN_THRESHOLD = 5000;
let largeDatasetWarned = false;
let pollClampWarnedForInterval: number | null = null;

function getPracticalInputPollIntervalMs(count: number): number {
  if (count >= 5000) return 5000;
  if (count >= 2000) return 2000;
  if (count >= 512) return 1000;
  return 500;
}

function enforcePracticalInputPollInterval(): void {
  const practicalMin = getPracticalInputPollIntervalMs(inputRegisterState.entries.length);
  if (inputRegisterState.pollInterval < practicalMin) {
    inputRegisterState.pollInterval = practicalMin;
    if (pollClampWarnedForInterval !== practicalMin) {
      warnLocal(
        `Polling interval auto-adjusted to ${practicalMin} ms for ${inputRegisterState.entries.length} registers to keep updates practical.`,
      );
      pollClampWarnedForInterval = practicalMin;
    }
  } else if (pollClampWarnedForInterval !== null && inputRegisterState.pollInterval >= practicalMin) {
    pollClampWarnedForInterval = null;
  }
}

function warnLargeDatasetConsequences(count: number): void {
  if (count >= INPUT_PERF_WARN_THRESHOLD) {
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

function generateRegisters(startAddress: number, count: number): InputRegisterEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    address: startAddress + i,
    value: 0,
    pending: false,
    readError: null,
    lastReadAt: null,
    label: "",
    origin: "range" as InputRegisterOrigin,
  }));
}

export const inputRegisterState = $state({
  view: "table" as InputRegisterView,
  filter: "all" as InputRegisterFilter,
  addressFilter: "all" as InputRegisterAddressFilter,
  addressRangeStart: 0,
  addressRangeEnd: 0,
  addressList: [] as number[],
  entries: [] as InputRegisterEntry[],
  startAddress: 0,
  registerCount: 16,
  readInProgress: false,
  cancelReadRequested: false,
  pollActive: false,
  pollInterval: 1000,
});

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollReadInFlight = false;

export function initInputRegisterState(): void {
  const settings = getSettingsSnapshot();

  if (!settings.rememberLastFeatureState) {
    inputRegisterState.view = settings.defaults.inputRegisters.view === "cards" ? "cards" : "table";
    applyInputRegisterRange(settings.defaults.inputRegisters.startAddress, settings.defaults.inputRegisters.count);
  } else {
    const savedView = localStorage.getItem(INPUT_VIEW_KEY);
    if (savedView === "table" || savedView === "cards") {
      inputRegisterState.view = savedView;
    }
    if (inputRegisterState.entries.length === 0) {
      applyInputRegisterRange(settings.defaults.inputRegisters.startAddress, settings.defaults.inputRegisters.count);
    }
  }

  setInputRegisterPollInterval(settings.polling.defaultIntervalMs);
}

export function setInputRegisterView(view: InputRegisterView): void {
  inputRegisterState.view = view;
  localStorage.setItem(INPUT_VIEW_KEY, view);
}

export function setInputRegisterFilter(filter: InputRegisterFilter): void {
  inputRegisterState.filter = filter;
}

export function setInputRegisterAddressFilter(filter: InputRegisterAddressFilter): void {
  inputRegisterState.addressFilter = filter;
}

export function setInputRegisterAddressRange(startAddress: number, endAddress: number): void {
  const start = Math.max(INPUT_ADDRESS_MIN, Math.min(INPUT_ADDRESS_MAX, Math.floor(startAddress)));
  const end = Math.max(INPUT_ADDRESS_MIN, Math.min(INPUT_ADDRESS_MAX, Math.floor(endAddress)));
  inputRegisterState.addressRangeStart = Math.min(start, end);
  inputRegisterState.addressRangeEnd = Math.max(start, end);
}

export function setInputRegisterAddressList(addresses: number[]): void {
  const normalized = addresses
    .map((a) => Math.floor(a))
    .filter((a) => Number.isFinite(a) && a >= INPUT_ADDRESS_MIN && a <= INPUT_ADDRESS_MAX);
  inputRegisterState.addressList = [...new Set(normalized)].sort((a, b) => a - b);
}

export function setInputRegisterLabel(address: number, label: string): void {
  const entry = inputRegisterState.entries.find((e) => e.address === address);
  if (!entry) return;
  entry.label = label;
}

export async function readInputRegister(address: number): Promise<void> {
  const entry = inputRegisterState.entries.find((e) => e.address === address);
  if (!entry) return;
  entry.pending = true;

  try {
    const response = await invoke<BackendReadInputRegistersResponse>("read_input_registers", {
      request: { startAddress: address, quantity: 1 },
    });
    const reg = response.registers.find((r) => r.address === address);
    if (reg) {
      entry.value = reg.value;
      entry.readError = null;
      entry.lastReadAt = Date.now();
    }
  } catch (err) {
    addLog("error", `fc04.read err addr=${address} msg=${parseInvokeError(err)}`);
  } finally {
    entry.pending = false;
  }
}

async function readInputRange(
  startAddress: number,
  quantity: number,
): Promise<BackendReadInputRegistersResponse> {
  return invoke<BackendReadInputRegistersResponse>("read_input_registers", {
    request: { startAddress, quantity },
  });
}

export async function readAllInputRegisters(options?: { markPending?: boolean }): Promise<void> {
  if (inputRegisterState.entries.length === 0) return;
  if (inputRegisterState.readInProgress) return;

  inputRegisterState.readInProgress = true;
  inputRegisterState.cancelReadRequested = false;

  const markPending = options?.markPending ?? true;

  const sections = buildAddressSections(inputRegisterState.entries.map((e) => e.address));
  if (sections.length === 0) return;

  if (markPending) {
    addLog(
      "info",
      `fc04.read plan total=${inputRegisterState.entries.length} sections=${sections.length} ops=${estimateReadOps(sections, INPUT_READ_CHUNK_MAX)} chunkMax=${INPUT_READ_CHUNK_MAX} sample=${formatSectionPreview(sections)}`,
    );
  }

  const startAddress = sections[0].start;
  const quantity = inputRegisterState.entries.length;
  const endAddress = sections[sections.length - 1].start + sections[sections.length - 1].quantity - 1;

  if (markPending) {
    for (const entry of inputRegisterState.entries) {
      entry.pending = true;
    }
  }

  try {
    const entryByAddress = new Map<number, InputRegisterEntry>(
      inputRegisterState.entries.map((entry) => [entry.address, entry]),
    );

    let okCount = 0;
    let missingCount = 0;
    const failedRanges: Array<{ start: number; end: number; quantity: number }> = [];

    for (const section of sections) {
      if (inputRegisterState.cancelReadRequested) break;

      if (section.quantity === 1) {
        try {
          const response = await readInputRange(section.start, 1);
          const single = response.registers.find((reg) => reg.address === section.start);
          const entry = entryByAddress.get(section.start);
          if (entry) {
            if (single) {
              entry.value = single.value;
              entry.readError = null;
              entry.lastReadAt = Date.now();
              okCount += 1;
            } else {
              entry.readError = "Address not available";
              missingCount += 1;
            }
            if (markPending) entry.pending = false;
          }
        } catch {
          const entry = entryByAddress.get(section.start);
          if (entry) {
            entry.readError = "Address not available";
            if (markPending) entry.pending = false;
          }
          failedRanges.push({ start: section.start, end: section.start, quantity: 1 });
          missingCount += 1;
        }
        continue;
      }

      const sectionEnd = section.start + section.quantity - 1;
      for (let chunkStart = section.start; chunkStart <= sectionEnd; chunkStart += INPUT_READ_CHUNK_MAX) {
        if (inputRegisterState.cancelReadRequested) break;

        const chunkQty = Math.min(INPUT_READ_CHUNK_MAX, sectionEnd - chunkStart + 1);
        const chunkEnd = chunkStart + chunkQty - 1;
        try {
          const response = await readInputRange(chunkStart, chunkQty);
          const valueMap = new Map<number, number>(response.registers.map((reg) => [reg.address, reg.value]));

          for (let address = chunkStart; address <= chunkEnd; address += 1) {
            const entry = entryByAddress.get(address);
            if (!entry) continue;
            if (valueMap.has(address)) {
              entry.value = valueMap.get(address) ?? entry.value;
              entry.readError = null;
              entry.lastReadAt = Date.now();
              okCount += 1;
            } else {
              entry.readError = "Address not available";
              missingCount += 1;
            }
            if (markPending) entry.pending = false;
          }
        } catch {
          failedRanges.push({ start: chunkStart, end: chunkEnd, quantity: chunkQty });
          for (let address = chunkStart; address <= chunkEnd; address += 1) {
            const entry = entryByAddress.get(address);
            if (!entry) continue;
            entry.readError = "Address not available";
            missingCount += 1;
            if (markPending) entry.pending = false;
          }
        }
      }
    }

    if (inputRegisterState.cancelReadRequested) {
      if (markPending) {
        for (const entry of inputRegisterState.entries) entry.pending = false;
      }
      addLog("warn", `fc04.read cancel start=${startAddress} qty=${quantity} end=${endAddress}`);
      return;
    }

    if (okCount > 0) {
      addLog("info", `fc04.read ok total=${inputRegisterState.entries.length} ok=${okCount} sections=${sections.length}`);
    }

    if (missingCount > 0 && markPending) {
      if (failedRanges.length > 0) {
        const preview = failedRanges
          .slice(0, 3)
          .map((range) => `[${range.start}..${range.end}]`)
          .join(", ");
        addLog(
          "warn",
          `fc04.read fail ranges=${failedRanges.length} sample=${preview}${failedRanges.length > 3 ? ",..." : ""}`,
        );
      }
      addLog("warn", `fc04.read miss count=${missingCount}`);
    }
  } catch (err) {
    if (markPending) {
      for (const entry of inputRegisterState.entries) entry.pending = false;
    }
    addLog("error", `fc04.read err msg=${parseInvokeError(err)}`);
  } finally {
    inputRegisterState.readInProgress = false;
    inputRegisterState.cancelReadRequested = false;
  }
}

export function cancelInputRegisterRead(): void {
  if (!inputRegisterState.readInProgress) return;
  inputRegisterState.cancelReadRequested = true;
  if (inputRegisterState.pollActive) {
    setInputRegisterPollActive(false);
  }
}

async function runInputRegisterPollTick(): Promise<void> {
  if (pollReadInFlight) return;
  pollReadInFlight = true;
  try {
    await readAllInputRegisters({ markPending: false });
  } finally {
    pollReadInFlight = false;
  }
}

export function applyInputRegisterRange(startAddress: number, count: number): void {
  const requestedStart = Math.floor(startAddress);
  const requestedCount = Math.floor(count);

  const start = Math.max(INPUT_ADDRESS_MIN, Math.min(INPUT_ADDRESS_MAX, requestedStart));
  const maxCountFromStart = Math.min(INPUT_MAX_COUNT, INPUT_ADDRESS_MAX - start + 1);
  const qty = Math.max(1, Math.min(maxCountFromStart, requestedCount));

  if (!Number.isFinite(startAddress) || requestedStart !== start) {
    warnLocal(`Address is invalid. Accepted start range is ${INPUT_ADDRESS_MIN}-${INPUT_ADDRESS_MAX}. Applied ${start}.`);
  }
  if (!Number.isFinite(count) || requestedCount !== qty) {
    warnLocal(`Address is invalid. Accepted count range is 1-${maxCountFromStart} for start ${start}. Applied ${qty}.`);
  }

  inputRegisterState.startAddress = start;
  inputRegisterState.registerCount = qty;

  const next = generateRegisters(start, qty);
  const existing = new Map(inputRegisterState.entries.map((entry) => [entry.address, entry]));

  for (const entry of next) {
    const prev = existing.get(entry.address);
    if (prev) {
      entry.value = prev.value;
      entry.pending = false;
      entry.readError = prev.readError;
      entry.lastReadAt = prev.lastReadAt;
      entry.label = prev.label;
      entry.origin = prev.origin;
    }
  }

  const customCandidates = inputRegisterState.entries
    .filter((prev) => prev.origin === "custom" && !next.some((entry) => entry.address === prev.address))
    .sort((a, b) => a.address - b.address);

  const rangeEnd = start + qty - 1;
  const acceptedCustomMin = Math.max(INPUT_ADDRESS_MIN, rangeEnd - (INPUT_MAX_COUNT - 1));
  const acceptedCustomMax = Math.min(INPUT_ADDRESS_MAX, start + (INPUT_MAX_COUNT - 1));
  const keptCustom = customCandidates.filter(
    (entry) => entry.address >= acceptedCustomMin && entry.address <= acceptedCustomMax,
  );
  next.push(...keptCustom);

  const droppedCustom = customCandidates.length - keptCustom.length;
  if (droppedCustom > 0) {
    warnLocal(`Address is invalid. Accepted address range is ${acceptedCustomMin}-${acceptedCustomMax} for custom registers at this range; dropped ${droppedCustom} custom register${droppedCustom === 1 ? "" : "s"}.`);
  }

  next.sort((a, b) => a.address - b.address);
  inputRegisterState.entries = next;

  const maxCount = getGlobalPollingMaxAddressCount();
  if (inputRegisterState.pollActive && inputRegisterState.entries.length > maxCount) {
    setInputRegisterPollActive(false);
    warnLocal(`Polling disabled for ranges larger than ${maxCount} input registers. Use Read once for bulk refresh.`);
  }

  warnLargeDatasetConsequences(inputRegisterState.entries.length);
  enforcePracticalInputPollInterval();
}

export function addExclusiveInputRegister(address: number): boolean {
  if (inputRegisterState.entries.length >= INPUT_MAX_COUNT) {
    warnLocal(`Address is invalid. Accepted count range is 1-${INPUT_MAX_COUNT}; already at ${INPUT_MAX_COUNT}.`);
    return false;
  }

  const normalized = Math.floor(address);
  if (!Number.isFinite(normalized) || normalized < INPUT_ADDRESS_MIN || normalized > INPUT_ADDRESS_MAX) {
    warnLocal(`Address is invalid. Accepted address range is ${INPUT_ADDRESS_MIN}-${INPUT_ADDRESS_MAX}.`);
    return false;
  }

  if (inputRegisterState.entries.some((e) => e.address === normalized)) {
    return false;
  }

  const customEntry: InputRegisterEntry = {
    address: normalized,
    value: 0,
    pending: false,
    readError: null,
    lastReadAt: null,
    label: "",
    origin: "custom",
  };

  inputRegisterState.entries = [...inputRegisterState.entries, customEntry].sort((a, b) => a.address - b.address);

  const maxCount = getGlobalPollingMaxAddressCount();
  if (inputRegisterState.pollActive && inputRegisterState.entries.length > maxCount) {
    setInputRegisterPollActive(false);
    warnLocal(`Polling disabled for ranges larger than ${maxCount} input registers. Use Read once for bulk refresh.`);
  }

  warnLargeDatasetConsequences(inputRegisterState.entries.length);
  enforcePracticalInputPollInterval();
  return true;
}

export function generateRandomExclusiveInputRegisterAddress(): number | null {
  if (inputRegisterState.entries.length >= INPUT_MAX_COUNT) {
    warnLocal(`Address is invalid. Accepted count range is 1-${INPUT_MAX_COUNT}; already at ${INPUT_MAX_COUNT}.`);
    return null;
  }

  if (inputRegisterState.entries.length >= INPUT_ADDRESS_MAX + 1) return null;

  const used = new Set(inputRegisterState.entries.map((e) => e.address));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const addr = Math.floor(Math.random() * (INPUT_ADDRESS_MAX + 1));
    if (!used.has(addr)) return addr;
  }
  for (let addr = INPUT_ADDRESS_MIN; addr <= INPUT_ADDRESS_MAX; addr += 1) {
    if (!used.has(addr)) return addr;
  }
  return null;
}

export function removeInputRegister(address: number): void {
  inputRegisterState.entries = inputRegisterState.entries.filter((entry) => entry.address !== address);
}

export function removeAllInputRegisters(): void {
  inputRegisterState.entries = [];
  if (inputRegisterState.pollActive) {
    setInputRegisterPollActive(false);
  }
}

export function setInputRegisterPollInterval(ms: number): void {
  const practicalMin = getPracticalInputPollIntervalMs(inputRegisterState.entries.length);
  const clamped = Math.max(practicalMin, Math.floor(ms));
  if (clamped !== Math.floor(ms)) {
    warnLocal(`Selected polling interval is too fast for ${inputRegisterState.entries.length} registers. Minimum practical interval is ${practicalMin} ms.`);
  }
  inputRegisterState.pollInterval = clamped;
  if (inputRegisterState.pollActive) {
    setInputRegisterPollActive(true);
  }
}

export function setInputRegisterPollActive(active: boolean): void {
  const maxCount = getGlobalPollingMaxAddressCount();
  if (active && !isPollingAllowedForCount(inputRegisterState.entries.length)) {
    warnLocal(`Polling disabled for ranges larger than ${maxCount} input registers. Use Read once for bulk refresh.`);
    inputRegisterState.pollActive = false;
    return;
  }

  inputRegisterState.pollActive = active;

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (active) {
    void runInputRegisterPollTick();
    pollTimer = setInterval(() => {
      void runInputRegisterPollTick();
    }, inputRegisterState.pollInterval);
  }
}

export function getFilteredInputRegisters(): InputRegisterEntry[] {
  const valueFiltered = (() => {
    switch (inputRegisterState.filter) {
      case "non-zero":
        return inputRegisterState.entries.filter((entry) => entry.value !== 0);
      case "zero":
        return inputRegisterState.entries.filter((entry) => entry.value === 0);
      default:
        return inputRegisterState.entries;
    }
  })();

  const rangeStart = Math.min(inputRegisterState.addressRangeStart, inputRegisterState.addressRangeEnd);
  const rangeEnd = Math.max(inputRegisterState.addressRangeStart, inputRegisterState.addressRangeEnd);
  const inRange = (address: number): boolean => address >= rangeStart && address <= rangeEnd;
  const listSet = new Set(inputRegisterState.addressList);

  switch (inputRegisterState.addressFilter) {
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
