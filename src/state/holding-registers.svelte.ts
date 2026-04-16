import { invoke } from "@tauri-apps/api/core";
import { addLog } from "./logs.svelte";
import { notifyWarning } from "./notifications.svelte";
import {
  getGlobalPollingMaxAddressCount,
  getSettingsSnapshot,
  isPollingAllowedForCount,
} from "./settings.svelte";

export type HoldingRegisterView = "table" | "cards";
export type HoldingRegisterFilter = "all" | "non-zero" | "zero";
export type HoldingRegisterOrigin = "range" | "custom";
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
}

interface BackendReadHoldingRegistersResponse {
  registers: Array<{ address: number; value: number }>;
  startAddress: number;
  quantity: number;
}

interface BackendWriteHoldingRegisterResponse {
  address: number;
  value: number;
}

interface BackendWriteMassHoldingRegistersResponse {
  writtenCount: number;
  totalCount: number;
  failures: Array<{ address: number; code: string; message: string }>;
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

const HOLDING_VIEW_KEY = "Modbus-Lab.holdingView";
const HOLDING_MAX_COUNT = 65536;
const HOLDING_ADDRESS_MIN = 0;
const HOLDING_ADDRESS_MAX = HOLDING_MAX_COUNT - 1;
const HOLDING_READ_CHUNK_MAX = 125;
const HOLDING_WRITE_BATCH_CHUNK_MAX = 120;
const HOLDING_PERF_WARN_THRESHOLD = 5000;
let largeDatasetWarned = false;
let pollClampWarnedForInterval: number | null = null;

function getPracticalHoldingPollIntervalMs(count: number): number {
  if (count >= 5000) return 5000;
  if (count >= 2000) return 2000;
  if (count >= 512) return 1000;
  return 500;
}

function enforcePracticalHoldingPollInterval(): void {
  const practicalMin = getPracticalHoldingPollIntervalMs(holdingRegisterState.entries.length);
  if (holdingRegisterState.pollInterval < practicalMin) {
    holdingRegisterState.pollInterval = practicalMin;
    if (pollClampWarnedForInterval !== practicalMin) {
      warnLocal(
        `Polling interval auto-adjusted to ${practicalMin} ms for ${holdingRegisterState.entries.length} registers to keep updates practical.`,
      );
      pollClampWarnedForInterval = practicalMin;
    }
  } else if (pollClampWarnedForInterval !== null && holdingRegisterState.pollInterval >= practicalMin) {
    pollClampWarnedForInterval = null;
  }
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
  readInProgress: false,
  cancelReadRequested: false,
  pollActive: false,
  pollInterval: 1000,
});

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollReadInFlight = false;

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

  setHoldingRegisterPollInterval(settings.polling.defaultIntervalMs);
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
  const normalized = Math.max(0, Math.min(65535, Math.floor(value)));
  entry.desiredValue = normalized;
  entry.writeError = null;
}

export function setAllHoldingRegisterDesiredFromRead(): number {
  let changed = 0;
  for (const entry of holdingRegisterState.entries) {
    if (entry.desiredValue !== entry.slaveValue || entry.writeError !== null) {
      changed += 1;
    }
    entry.desiredValue = entry.slaveValue;
    entry.writeError = null;
  }
  return changed;
}

export async function readHoldingRegister(address: number): Promise<void> {
  const entry = holdingRegisterState.entries.find((e) => e.address === address);
  if (!entry) return;
  entry.pending = true;

  try {
    const response = await invoke<BackendReadHoldingRegistersResponse>("read_holding_registers", {
      request: { startAddress: address, quantity: 1 },
    });

    const reg = response.registers.find((r) => r.address === address);
    if (reg) {
      entry.slaveValue = reg.value;
      // Successful read means address is available; clear stale availability error.
      entry.readError = null;
      entry.writeError = null;
      entry.lastReadAt = Date.now();
    } else {
      entry.readError = "Address not available";
    }
  } catch (err) {
    entry.readError = "Address not available";
    addLog("error", `fc03.read err addr=${address} msg=${parseInvokeError(err)}`);
  } finally {
    entry.pending = false;
  }
}

async function readHoldingRange(
  startAddress: number,
  quantity: number,
): Promise<BackendReadHoldingRegistersResponse> {
  return invoke<BackendReadHoldingRegistersResponse>("read_holding_registers", {
    request: { startAddress, quantity },
  });
}

export async function readAllHoldingRegisters(options?: { markPending?: boolean }): Promise<void> {
  if (holdingRegisterState.entries.length === 0) return;
  if (holdingRegisterState.readInProgress) return;

  holdingRegisterState.readInProgress = true;
  holdingRegisterState.cancelReadRequested = false;

  const markPending = options?.markPending ?? true;

  const sections = buildAddressSections(holdingRegisterState.entries.map((entry) => entry.address));
  if (sections.length === 0) {
    return;
  }

  if (markPending) {
    addLog(
      "info",
      `fc03.read plan total=${holdingRegisterState.entries.length} sections=${sections.length} ops=${estimateReadOps(sections, HOLDING_READ_CHUNK_MAX)} chunkMax=${HOLDING_READ_CHUNK_MAX} sample=${formatSectionPreview(sections)}`,
    );
  }

  const startAddress = sections[0].start;
  const quantity = holdingRegisterState.entries.length;
  const endAddress = sections[sections.length - 1].start + sections[sections.length - 1].quantity - 1;

  if (markPending) {
    for (const entry of holdingRegisterState.entries) {
      entry.pending = true;
    }
  }

  try {
    const entryByAddress = new Map<number, HoldingRegisterEntry>(
      holdingRegisterState.entries.map((entry) => [entry.address, entry]),
    );

    let okCount = 0;
    let missingCount = 0;
    const failedRanges: Array<{ start: number; end: number; quantity: number }> = [];

    for (const section of sections) {
      if (holdingRegisterState.cancelReadRequested) {
        break;
      }

      if (section.quantity === 1) {
        try {
          const response = await readHoldingRange(section.start, 1);
          const single = response.registers.find((reg) => reg.address === section.start);
          const entry = entryByAddress.get(section.start);
          if (entry) {
            if (single) {
              entry.slaveValue = single.value;
              entry.writeError = null;
              entry.lastReadAt = Date.now();
              okCount += 1;
            } else {
              entry.writeError = "Address not available";
              missingCount += 1;
            }
            if (markPending) {
              entry.pending = false;
            }
          }
        } catch {
          const entry = entryByAddress.get(section.start);
          if (entry) {
            entry.writeError = "Address not available";
            if (markPending) {
              entry.pending = false;
            }
          }
          failedRanges.push({ start: section.start, end: section.start, quantity: 1 });
          missingCount += 1;
        }
        continue;
      }

      const sectionEnd = section.start + section.quantity - 1;
      for (let chunkStart = section.start; chunkStart <= sectionEnd; chunkStart += HOLDING_READ_CHUNK_MAX) {
        if (holdingRegisterState.cancelReadRequested) {
          break;
        }

        const chunkQty = Math.min(HOLDING_READ_CHUNK_MAX, sectionEnd - chunkStart + 1);
        const chunkEnd = chunkStart + chunkQty - 1;
        try {
          const response = await readHoldingRange(chunkStart, chunkQty);
          const valueMap = new Map<number, number>(response.registers.map((reg) => [reg.address, reg.value]));

          for (let address = chunkStart; address <= chunkEnd; address += 1) {
            const entry = entryByAddress.get(address);
            if (!entry) continue;

            if (valueMap.has(address)) {
              entry.slaveValue = valueMap.get(address) ?? entry.slaveValue;
              entry.writeError = null;
              entry.lastReadAt = Date.now();
              okCount += 1;
            } else {
              entry.writeError = "Address not available";
              missingCount += 1;
            }

            if (markPending) {
              entry.pending = false;
            }
          }
        } catch {
          failedRanges.push({ start: chunkStart, end: chunkEnd, quantity: chunkQty });

          for (let address = chunkStart; address <= chunkEnd; address += 1) {
            const entry = entryByAddress.get(address);
            if (!entry) continue;
            entry.writeError = "Address not available";
            missingCount += 1;
            if (markPending) {
              entry.pending = false;
            }
          }
        }
      }
    }

    if (holdingRegisterState.cancelReadRequested) {
      if (markPending) {
        for (const entry of holdingRegisterState.entries) {
          entry.pending = false;
        }
      }
      addLog(
        "warn",
        `fc03.read cancel start=${startAddress} qty=${quantity} end=${endAddress}`,
      );
      return;
    }

    if (okCount > 0) {
      addLog("info", `fc03.read ok total=${holdingRegisterState.entries.length} ok=${okCount} sections=${sections.length}`);
    }

    if (missingCount > 0 && markPending) {
      if (failedRanges.length > 0) {
        const preview = failedRanges
          .slice(0, 3)
          .map((range) => `[${range.start}..${range.end}]`)
          .join(", ");
        addLog(
          "warn",
          `fc03.read fail ranges=${failedRanges.length} sample=${preview}${failedRanges.length > 3 ? ",..." : ""}`,
        );
      }
      addLog(
        "warn",
        `fc03.read miss count=${missingCount}`,
      );
    }
  } catch (err) {
    if (markPending) {
      for (const entry of holdingRegisterState.entries) {
        entry.pending = false;
      }
    }
    addLog("error", `fc03.read err msg=${parseInvokeError(err)}`);
  } finally {
    holdingRegisterState.readInProgress = false;
    holdingRegisterState.cancelReadRequested = false;
  }
}

export function cancelHoldingRegisterRead(): void {
  if (!holdingRegisterState.readInProgress) return;
  holdingRegisterState.cancelReadRequested = true;

  if (holdingRegisterState.pollActive) {
    setHoldingRegisterPollActive(false);
  }
}

async function runHoldingRegisterPollTick(): Promise<void> {
  if (pollReadInFlight) return;
  pollReadInFlight = true;
  try {
    await readAllHoldingRegisters({ markPending: false });
  } finally {
    pollReadInFlight = false;
  }
}

export async function writeHoldingRegister(address: number): Promise<void> {
  const entry = holdingRegisterState.entries.find((e) => e.address === address);
  if (!entry) return;

  entry.pending = true;
  entry.writeError = null;

  try {
    const response = await invoke<BackendWriteHoldingRegisterResponse>("write_holding_register", {
      request: { address, value: entry.desiredValue },
    });

    entry.slaveValue = response.value;
    entry.pending = false;
    entry.writeError = null;
    entry.lastWriteAt = Date.now();
    addLog("info", `fc06.write ok addr=${address} val=${response.value}`);
  } catch (err) {
    entry.pending = false;
    entry.writeError = parseInvokeError(err);
    addLog("error", `fc06.write err addr=${address} msg=${entry.writeError}`);
  }
}

export async function writePendingHoldingRegisters(): Promise<number> {
  const pending = holdingRegisterState.entries.filter((e) => e.desiredValue !== e.slaveValue);
  if (pending.length === 0) return 0;

  const sections = buildAddressSections(pending.map((entry) => entry.address));
  const chunkCount = Math.ceil(pending.length / HOLDING_WRITE_BATCH_CHUNK_MAX);
  addLog(
    "info",
    `fc16.write plan req=${pending.length} chunks=${chunkCount} chunkMax=${HOLDING_WRITE_BATCH_CHUNK_MAX} sections=${sections.length} sample=${formatSectionPreview(sections)}`,
  );

  for (const entry of pending) {
    entry.pending = true;
    entry.writeError = null;
  }

  let writtenTotal = 0;
  let chunkFailureMessage: string | null = null;
  const failureMap = new Map<number, string>();

  // Use safe FC16-sized chunks to avoid oversized write payloads.
  for (let i = 0; i < pending.length; i += HOLDING_WRITE_BATCH_CHUNK_MAX) {
    const chunk = pending.slice(i, i + HOLDING_WRITE_BATCH_CHUNK_MAX);
    try {
      const response = await invoke<BackendWriteMassHoldingRegistersResponse>("write_holding_registers_batch", {
        request: {
          registers: chunk.map((entry) => ({
            address: entry.address,
            value: entry.desiredValue,
          })),
        },
      });

      writtenTotal += response.writtenCount;
      for (const failure of response.failures) {
        failureMap.set(failure.address, `${failure.code}: ${failure.message}`);
      }
    } catch (err) {
      const message = parseInvokeError(err);
      chunkFailureMessage = message;
      for (const entry of chunk) {
        failureMap.set(entry.address, message);
      }
    }
  }

  for (const entry of pending) {
    entry.pending = false;
    const failure = failureMap.get(entry.address);
    if (failure) {
      entry.writeError = failure;
    } else {
      entry.slaveValue = entry.desiredValue;
      entry.writeError = null;
      entry.lastWriteAt = Date.now();
    }
  }

  if (chunkFailureMessage) {
    addLog("error", `fc16.write err req=${pending.length} msg=${chunkFailureMessage}`);
  }

  if (pending.length > HOLDING_WRITE_BATCH_CHUNK_MAX) {
    addLog("info", `fc16.write ok req=${pending.length} ok=${writtenTotal} chunks=${chunkCount}`);
  }

  return writtenTotal;
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

  next.sort((a, b) => a.address - b.address);
  holdingRegisterState.entries = next;

  const maxCount = getGlobalPollingMaxAddressCount();
  if (holdingRegisterState.pollActive && holdingRegisterState.entries.length > maxCount) {
    setHoldingRegisterPollActive(false);
    warnLocal(
      `Polling disabled for ranges larger than ${maxCount} holding registers. Use Read once for bulk refresh.`,
    );
  }

  warnLargeDatasetConsequences(holdingRegisterState.entries.length);
  enforcePracticalHoldingPollInterval();
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

  holdingRegisterState.entries = [...existingByAddress.values()].sort((a, b) => a.address - b.address);

  const maxCount = getGlobalPollingMaxAddressCount();
  if (holdingRegisterState.pollActive && holdingRegisterState.entries.length > maxCount) {
    setHoldingRegisterPollActive(false);
    warnLocal(
      `Polling disabled for ranges larger than ${maxCount} holding registers. Use Read once for bulk refresh.`,
    );
  }

  warnLargeDatasetConsequences(holdingRegisterState.entries.length);
  enforcePracticalHoldingPollInterval();
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
  };

  holdingRegisterState.entries = [...holdingRegisterState.entries, customEntry]
    .sort((a, b) => a.address - b.address);

  const maxCount = getGlobalPollingMaxAddressCount();
  if (holdingRegisterState.pollActive && holdingRegisterState.entries.length > maxCount) {
    setHoldingRegisterPollActive(false);
    warnLocal(
      `Polling disabled for ranges larger than ${maxCount} holding registers. Use Read once for bulk refresh.`,
    );
  }

  warnLargeDatasetConsequences(holdingRegisterState.entries.length);
  enforcePracticalHoldingPollInterval();

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
    if (!used.has(addr)) return addr;
  }

  for (let addr = HOLDING_ADDRESS_MIN; addr <= HOLDING_ADDRESS_MAX; addr += 1) {
    if (!used.has(addr)) return addr;
  }

  return null;
}

export function removeHoldingRegister(address: number): void {
  holdingRegisterState.entries = holdingRegisterState.entries.filter((entry) => entry.address !== address);
}

export function removeAllHoldingRegisters(): void {
  holdingRegisterState.entries = [];
  if (holdingRegisterState.pollActive) {
    setHoldingRegisterPollActive(false);
  }
}

export function setHoldingRegisterPollInterval(ms: number): void {
  const practicalMin = getPracticalHoldingPollIntervalMs(holdingRegisterState.entries.length);
  const clamped = Math.max(practicalMin, Math.floor(ms));
  if (clamped !== Math.floor(ms)) {
    warnLocal(
      `Selected polling interval is too fast for ${holdingRegisterState.entries.length} registers. Minimum practical interval is ${practicalMin} ms.`,
    );
  }

  holdingRegisterState.pollInterval = clamped;
  if (holdingRegisterState.pollActive) {
    setHoldingRegisterPollActive(true);
  }
}

export function setHoldingRegisterPollActive(active: boolean): void {
  const maxCount = getGlobalPollingMaxAddressCount();
  if (active && !isPollingAllowedForCount(holdingRegisterState.entries.length)) {
    warnLocal(
      `Polling disabled for ranges larger than ${maxCount} holding registers. Use Read once for bulk refresh.`,
    );
    holdingRegisterState.pollActive = false;
    return;
  }

  holdingRegisterState.pollActive = active;

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (active) {
    void runHoldingRegisterPollTick();
    pollTimer = setInterval(() => {
      void runHoldingRegisterPollTick();
    }, holdingRegisterState.pollInterval);
  }
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
