import { invoke } from "@tauri-apps/api/core";
import { addLog } from "./logs.svelte";
import { notifyWarning } from "./notifications.svelte";
import { connectionState } from "./connection.svelte";
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
const DISCRETE_INPUT_MAX_COUNT = 65536; // Modbus spec: 16-bit address space
const MODBUS_ADDRESS_MIN = 0;
const MODBUS_ADDRESS_MAX = DISCRETE_INPUT_MAX_COUNT - 1; // 0x0000-0xFFFF

export interface DiscreteInputEntry {
  address: number;
  value: boolean;
  pending: boolean;
  readError: string | null;
  label: string;
  origin: DiscreteInputOrigin;
}

interface BackendReadDiscreteInputsResponse {
  inputs: Array<{ address: number; value: boolean }>;
  startAddress: number;
  quantity: number;
}

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

function generateInputs(startAddress: number, count: number): DiscreteInputEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    address: startAddress + i,
    value: false,
    pending: false,
    readError: null,
    label: "",
    origin: "range",
  }));
}

function getDiscreteAcceptedAddressRange(): { min: number; max: number } {
  if (discreteInputState.entries.length === 0) {
    return { min: MODBUS_ADDRESS_MIN, max: MODBUS_ADDRESS_MAX };
  }

  const addresses = discreteInputState.entries.map((entry) => entry.address);
  const currentMin = Math.min(...addresses);
  const currentMax = Math.max(...addresses);

  return {
    min: Math.max(MODBUS_ADDRESS_MIN, currentMax - (DISCRETE_INPUT_MAX_COUNT - 1)),
    max: Math.min(MODBUS_ADDRESS_MAX, currentMin + (DISCRETE_INPUT_MAX_COUNT - 1)),
  };
}

export const discreteInputState = $state({
  view: "table" as DiscreteInputView,
  entries: [] as DiscreteInputEntry[],
  startAddress: 0,
  inputCount: 8,
  filter: "all" as DiscreteInputFilter,
  addressFilter: "all" as DiscreteInputAddressFilter,
  addressRangeStart: 0,
  addressRangeEnd: 0,
  addressList: [] as number[],
  pollActive: false,
  pollInterval: 1000,
});

let pollTimer: ReturnType<typeof setInterval> | null = null;
let readAllInFlight = false;
let readAllQueuedRuns = 0;
const READ_ALL_QUEUE_DEPTH_MAX = 6;

export function initDiscreteInputState(): void {
  const settings = getSettingsSnapshot();

  if (!settings.rememberLastFeatureState || discreteInputState.entries.length === 0) {
    const nextView = settings.defaults.discreteInputs.view;
    discreteInputState.view = nextView === "switch" ? "switch" : "table";
    applyDiscreteInputRange(settings.defaults.discreteInputs.startAddress, settings.defaults.discreteInputs.count);
  }

  setDiscreteInputPollInterval(settings.polling.defaultIntervalMs);
}

export function setDiscreteInputView(view: DiscreteInputView): void {
  discreteInputState.view = view;
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

export function setDiscreteInputLabel(address: number, label: string): void {
  const entry = discreteInputState.entries.find((item) => item.address === address);
  if (!entry) return;
  entry.label = label;
}

export function applyDiscreteInputRange(startAddress: number, count: number): void {
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

  const next = generateInputs(start, qty);
  const existing = new Map(discreteInputState.entries.map((entry) => [entry.address, entry]));
  for (const entry of next) {
    const prev = existing.get(entry.address);
    if (prev) {
      entry.value = prev.value;
      entry.pending = false;
      entry.readError = prev.readError;
      entry.label = prev.label;
      entry.origin = prev.origin;
    }
  }

  // Keep custom addresses so "Add" behavior mirrors coils panel.
  for (const prev of discreteInputState.entries) {
    if (prev.origin === "custom" && !next.some((entry) => entry.address === prev.address)) {
      next.push({ ...prev });
    }
  }

  const rangeEnd = start + qty - 1;
  const acceptedCustomMin = Math.max(MODBUS_ADDRESS_MIN, rangeEnd - (DISCRETE_INPUT_MAX_COUNT - 1));
  const acceptedCustomMax = Math.min(MODBUS_ADDRESS_MAX, start + (DISCRETE_INPUT_MAX_COUNT - 1));
  const rangeSet = new Set(generateInputs(start, qty).map((entry) => entry.address));
  const rangeOnly = next.filter((entry) => rangeSet.has(entry.address));
  const customOnly = next
    .filter((entry) => entry.origin === "custom" && !rangeSet.has(entry.address))
    .sort((a, b) => a.address - b.address);
  const keptCustom = customOnly.filter(
    (entry) => entry.address >= acceptedCustomMin && entry.address <= acceptedCustomMax,
  );
  const droppedCustom = customOnly.length - keptCustom.length;
  next.length = 0;
  next.push(...rangeOnly, ...keptCustom);

  if (droppedCustom > 0) {
    warnLocal(`Address is invalid. Accepted address range is ${acceptedCustomMin}-${acceptedCustomMax} for custom inputs at this range; dropped ${droppedCustom} custom input${droppedCustom === 1 ? "" : "s"}.`);
  }

  next.sort((a, b) => a.address - b.address);
  discreteInputState.entries = next;
  syncDiscreteInputAddressesToBackend();
}

export function addDiscreteInputRange(startAddress: number, count: number): void {
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
  for (const newEntry of generateInputs(start, qty)) {
    if (!existingByAddress.has(newEntry.address)) {
      existingByAddress.set(newEntry.address, newEntry);
    }
  }

  discreteInputState.entries = [...existingByAddress.values()].sort((a, b) => a.address - b.address);
  syncDiscreteInputAddressesToBackend();
}

export function addExclusiveDiscreteInput(address: number): boolean {
  // Modbus limit: max 2000 discrete inputs per read
  if (discreteInputState.entries.length >= DISCRETE_INPUT_MAX_COUNT) {
    warnLocal(`Address is invalid. Accepted count range is 1-${DISCRETE_INPUT_MAX_COUNT}; already at ${DISCRETE_INPUT_MAX_COUNT}.`);
    return false;
  }

  const addr = Math.floor(address);
  if (!Number.isFinite(addr) || addr < MODBUS_ADDRESS_MIN || addr > MODBUS_ADDRESS_MAX) {
    warnLocal(`Address is invalid. Accepted address range is ${MODBUS_ADDRESS_MIN}-${MODBUS_ADDRESS_MAX}.`);
    return false;
  }

  const accepted = getDiscreteAcceptedAddressRange();
  if (addr < accepted.min || addr > accepted.max) {
    warnLocal(`Address is invalid. Accepted address range is ${accepted.min}-${accepted.max} to keep max span ${DISCRETE_INPUT_MAX_COUNT}.`);
    return false;
  }

  const existing = discreteInputState.entries.find((entry) => entry.address === addr);
  if (existing) {
    return true;
  }

  const next: DiscreteInputEntry[] = [
    ...discreteInputState.entries,
    {
      address: addr,
      value: false,
      pending: false,
      readError: null,
      label: "",
      origin: "custom",
    },
  ];

  discreteInputState.entries = next.sort((a, b) => a.address - b.address);
  void invoke("store_set_discrete_input", { address: addr, value: false });
  return true;
}

export function generateRandomExclusiveDiscreteInputAddress(): number | null {
  // Modbus limit: max 2000 discrete inputs per read
  if (discreteInputState.entries.length >= DISCRETE_INPUT_MAX_COUNT) {
    warnLocal(`Address is invalid. Accepted count range is 1-${DISCRETE_INPUT_MAX_COUNT}; already at ${DISCRETE_INPUT_MAX_COUNT}.`);
    return null;
  }

  if (discreteInputState.entries.length >= MODBUS_ADDRESS_MAX + 1) {
    return null;
  }

  const accepted = getDiscreteAcceptedAddressRange();

  for (let attempt = 0; attempt < 200; attempt += 1) {
    const addr = accepted.min + Math.floor(Math.random() * (accepted.max - accepted.min + 1));
    if (!discreteInputState.entries.some((entry) => entry.address === addr)) {
      return addr;
    }
  }

  for (let addr = accepted.min; addr <= accepted.max; addr += 1) {
    if (!discreteInputState.entries.some((entry) => entry.address === addr)) {
      return addr;
    }
  }

  return null;
}

export function removeDiscreteInput(address: number): void {
  discreteInputState.entries = discreteInputState.entries.filter((entry) => entry.address !== address);
  void invoke("store_remove_discrete_input", { address });
}

export function removeAllDiscreteInputs(): void {
  discreteInputState.entries = [];
  void invoke("store_clear_discrete_inputs", {});
}

export function syncDiscreteInputAddressesToBackend(): void {
  const addresses = discreteInputState.entries.map((e) => e.address);
  void invoke("store_sync_discrete_input_addresses", { addresses });
}

async function readRange(startAddress: number, quantity: number): Promise<BackendReadDiscreteInputsResponse> {
  return invoke<BackendReadDiscreteInputsResponse>("read_discrete_inputs", {
    request: { startAddress, quantity },
  });
}

async function readRangeAdaptive(startAddress: number, quantity: number): Promise<Map<number, boolean>> {
  const values = new Map<number, boolean>();

  function isModbusException(err: unknown): boolean {
    const msg = (typeof err === "string" ? err : (err as { message?: string })?.message ?? "").toLowerCase();
    return msg.includes("exception") || msg.includes("illegal") || msg.includes("slave device failure");
  }

  async function readChunk(start: number, qty: number): Promise<void> {
    try {
      const response = await readRange(start, qty);
      for (const input of response.inputs) {
        values.set(input.address, input.value);
      }
      return;
    } catch (err) {
      // A Modbus protocol exception is a definitive answer — don't bisect further.
      if (isModbusException(err)) {
        const reason = parseInvokeError(err);
        addLog("warn", `fc02.read exception addr=${start} qty=${qty} msg=${reason}`);
        return;
      }

      // Transport failure: re-throw so the outer section handler logs once and continues.
      // Bisecting here would only produce O(n) redundant failures for every address.
      const reason = parseInvokeError(err);
      if (isTransientTransportError(reason)) {
        throw err;
      }

      if (qty === 1) {
        addLog("warn", `fc02.read miss addr=${start} msg=${reason}`);
        return;
      }
    }

    const leftQty = Math.floor(qty / 2);
    const rightQty = qty - leftQty;
    await readChunk(start, leftQty);
    await readChunk(start + leftQty, rightQty);
  }

  await readChunk(startAddress, quantity);
  return values;
}

export function getFilteredDiscreteInputs(): DiscreteInputEntry[] {
  const valueFiltered = (() => {
    switch (discreteInputState.filter) {
      case "on":
        return discreteInputState.entries.filter((entry) => entry.value);
      case "off":
        return discreteInputState.entries.filter((entry) => !entry.value);
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

export async function readAllDiscreteInputs(options?: { trace?: boolean; markPending?: boolean; queueIfBusy?: boolean }): Promise<void> {
  if (discreteInputState.entries.length === 0) return;
  // Do not issue reads while the transport layer is recovering.
  if (connectionState.status === "reconnecting" || connectionState.status === "disconnected") return;

  const queueIfBusy = options?.queueIfBusy ?? true;
  if (readAllInFlight) {
    if (queueIfBusy && readAllQueuedRuns < READ_ALL_QUEUE_DEPTH_MAX) {
      readAllQueuedRuns += 1;
    }
    return;
  }

  readAllInFlight = true;

  const sections = buildAddressSections(discreteInputState.entries.map((entry) => entry.address));
  const trace = options?.trace ?? true;
  const markPending = options?.markPending ?? true;
  if (trace) {
    const singleSections = sections.filter((section) => section.quantity === 1).length;
    const adaptiveSections = sections.length - singleSections;
    addLog(
      "info",
      `fc02.read plan total=${discreteInputState.entries.length} sections=${sections.length} singles=${singleSections} adaptive=${adaptiveSections} sample=${formatSectionPreview(sections)}`,
    );
  }

  const entryByAddress = new Map<number, DiscreteInputEntry>(
    discreteInputState.entries.map((entry) => [entry.address, entry]),
  );

  for (const entry of discreteInputState.entries) {
    if (markPending) {
      entry.pending = true;
    }
  }

  try {
    let missingCount = 0;

    for (const section of sections) {
      try {
        if (section.quantity === 1) {
          const response = await readRange(section.start, 1);
          const input = response.inputs.find((item) => item.address === section.start);
          const entry = entryByAddress.get(section.start);
          if (entry) {
            if (input) {
              entry.value = input.value;
              entry.readError = null;
            } else {
              entry.readError = "Address not available";
              missingCount += 1;
            }
            if (markPending) {
              entry.pending = false;
            }
          }
          continue;
        }

        const valueMap = await readRangeAdaptive(section.start, section.quantity);
        const end = section.start + section.quantity - 1;
        for (let address = section.start; address <= end; address += 1) {
          const entry = entryByAddress.get(address);
          if (!entry) continue;
          if (valueMap.has(address)) {
            entry.value = valueMap.get(address) ?? false;
            entry.readError = null;
          } else {
            entry.readError = "Address not available";
            missingCount += 1;
          }
          if (markPending) {
            entry.pending = false;
          }
        }
      } catch (sectionErr) {
        const end = section.start + section.quantity - 1;
        const reason = parseInvokeError(sectionErr);
        if (isTransientTransportError(reason)) {
          for (let address = section.start; address <= end; address += 1) {
            const entry = entryByAddress.get(address);
            if (entry && markPending) {
              entry.pending = false;
            }
          }
          addLog(
            "warn",
            `fc02.read transient start=${section.start} qty=${section.quantity} end=${end} msg=${reason}`,
          );
          continue;
        }

        for (let address = section.start; address <= end; address += 1) {
          const entry = entryByAddress.get(address);
          if (entry) {
            if (markPending) {
              entry.pending = false;
            }
            entry.readError = "Address not available";
          }
        }
        addLog(
          "error",
          `fc02.read err start=${section.start} qty=${section.quantity} end=${end} msg=${reason}`,
        );
      }
    }

    const okCount = discreteInputState.entries.length - missingCount;
    if (okCount > 0) {
      addLog("info", `fc02.read ok total=${discreteInputState.entries.length} ok=${okCount} sections=${sections.length}`);
    }
    if (missingCount > 0) {
      addLog("warn", `fc02.read miss count=${missingCount}`);
    }
  } catch (err) {
    for (const entry of discreteInputState.entries) {
      if (markPending) {
        entry.pending = false;
      }
    }
    addLog("error", `fc02.read err msg=${parseInvokeError(err)}`);
  } finally {
    readAllInFlight = false;
    if (readAllQueuedRuns > 0) {
      readAllQueuedRuns -= 1;
      void readAllDiscreteInputs({ trace: false, markPending: false, queueIfBusy: false });
    }
  }
}

async function runDiscreteInputPollTick(): Promise<void> {
  await readAllDiscreteInputs({ trace: false, markPending: false, queueIfBusy: true });
}

export async function readDiscreteInput(address: number): Promise<void> {
  const entry = discreteInputState.entries.find((item) => item.address === address);
  if (!entry) return;

  entry.pending = true;
  try {
    const response = await readRange(address, 1);
    const input = response.inputs.find((item) => item.address === address);
    if (input) {
      entry.value = input.value;
      entry.readError = null;
    }
    addLog("info", `fc02.read ok addr=${address} val=${input?.value ? 1 : 0}`);
  } catch (err) {
    entry.readError = parseInvokeError(err);
    addLog("error", `fc02.read err addr=${address} msg=${entry.readError}`);
  } finally {
    entry.pending = false;
  }
}

export function setDiscreteInputPollInterval(ms: number): void {
  discreteInputState.pollInterval = Math.max(250, Math.floor(ms));
  if (discreteInputState.pollActive) {
    setDiscreteInputPollActive(true);
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
    void runDiscreteInputPollTick();
    pollTimer = setInterval(() => {
      void runDiscreteInputPollTick();
    }, discreteInputState.pollInterval);
  }
}
