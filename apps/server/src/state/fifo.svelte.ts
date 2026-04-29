import { invoke } from "@tauri-apps/api/core";
import { addLog } from "./logs.svelte";

export interface FifoQueueEntry {
  address: number;
  fifoCount: number;
  values: number[];
  pending: boolean;
  error: string | null;
  lastReadAt: number | null;
}

export type FifoSnapshotSource = "holding-register" | "input-register";
export type FifoSnapshotTrigger = "on-change" | "interval" | "hybrid";

export interface FifoSnapshotLink {
  id: string;
  source: FifoSnapshotSource;
  sourceAddress: number;
  fifoAddress: number;
  trigger: FifoSnapshotTrigger;
  intervalMs: number;
  enabled: boolean;
  lastValue: number | null;
  lastSampleAt: number | null;
  droppedSamples: number;
}

type FifoSnapshotSourceReader = (address: number) => number | null;

interface BackendReadFifoQueueResponse {
  address: number;
  fifoCount: number;
  values: number[];
}

const FIFO_ADDRESSES_KEY = "Modbus-Lab.fifo.addresses";
const FIFO_ACTIVE_ADDRESS_KEY = "Modbus-Lab.fifo.activeAddress";
const FIFO_LINKS_KEY = "Modbus-Lab.fifo.snapshotLinks";
const FIFO_ADDRESS_MIN = 0;
const FIFO_ADDRESS_MAX = 65535;
const FIFO_QUEUE_MAX_VALUES = 31;
const FIFO_INTERVAL_MIN_MS = 200;
const FIFO_INTERVAL_MAX_MS = 60000;

let snapshotTickTimer: ReturnType<typeof setInterval> | null = null;
let snapshotTickRunning = false;

const snapshotSourceReaders: Record<FifoSnapshotSource, FifoSnapshotSourceReader | null> = {
  "holding-register": null,
  "input-register": null,
};

function clampAddress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(FIFO_ADDRESS_MIN, Math.min(FIFO_ADDRESS_MAX, Math.floor(value)));
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

function clampIntervalMs(value: number): number {
  if (!Number.isFinite(value)) return 1000;
  return Math.max(FIFO_INTERVAL_MIN_MS, Math.min(FIFO_INTERVAL_MAX_MS, Math.floor(value)));
}

function makeSnapshotLinkId(): string {
  return `link-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function normalizeSnapshotLink(raw: Partial<FifoSnapshotLink>): FifoSnapshotLink | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw.source;
  if (source !== "holding-register" && source !== "input-register") return null;

  return {
    id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : makeSnapshotLinkId(),
    source,
    sourceAddress: clampAddress(Number(raw.sourceAddress ?? 0)),
    fifoAddress: clampAddress(Number(raw.fifoAddress ?? 0)),
    trigger: raw.trigger === "interval" || raw.trigger === "hybrid" ? raw.trigger : "on-change",
    intervalMs: clampIntervalMs(Number(raw.intervalMs ?? 1000)),
    enabled: raw.enabled !== false,
    lastValue: typeof raw.lastValue === "number" ? (Number(raw.lastValue) & 0xFFFF) : null,
    lastSampleAt: typeof raw.lastSampleAt === "number" ? raw.lastSampleAt : null,
    droppedSamples: Number.isFinite(Number(raw.droppedSamples)) ? Math.max(0, Math.floor(Number(raw.droppedSamples))) : 0,
  };
}

function loadStoredSnapshotLinks(): FifoSnapshotLink[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(FIFO_LINKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => normalizeSnapshotLink(item as Partial<FifoSnapshotLink>))
      .filter((item): item is FifoSnapshotLink => item !== null);
  } catch {
    return [];
  }
}

function persistSnapshotLinks(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(FIFO_LINKS_KEY, JSON.stringify(fifoState.snapshotLinks));
}

function loadStoredAddresses(): number[] {
  if (typeof localStorage === "undefined") return [0];
  try {
    const raw = localStorage.getItem(FIFO_ADDRESSES_KEY);
    if (!raw) return [0];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [0];
    const normalized = parsed
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .map((value) => clampAddress(value));
    const unique = [...new Set(normalized)].sort((a, b) => a - b);
    return unique.length > 0 ? unique : [0];
  } catch {
    return [0];
  }
}

function loadStoredActiveAddress(addresses: number[]): number {
  if (typeof localStorage === "undefined") return addresses[0] ?? 0;
  const raw = localStorage.getItem(FIFO_ACTIVE_ADDRESS_KEY);
  const parsed = Number(raw);
  const next = Number.isFinite(parsed) ? clampAddress(parsed) : addresses[0] ?? 0;
  return addresses.includes(next) ? next : (addresses[0] ?? 0);
}

function persistAddresses(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(FIFO_ADDRESSES_KEY, JSON.stringify(fifoState.addresses));
}

function persistActiveAddress(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(FIFO_ACTIVE_ADDRESS_KEY, String(fifoState.activeAddress));
}

function ensureEntry(address: number): FifoQueueEntry {
  let existing = fifoState.entries.find((entry) => entry.address === address);
  if (!existing) {
    existing = {
      address,
      fifoCount: 0,
      values: [],
      pending: false,
      error: null,
      lastReadAt: null,
    };
    fifoState.entries = [...fifoState.entries, existing].sort((a, b) => a.address - b.address);
  }
  return existing;
}

const initialAddresses = loadStoredAddresses();
const initialSnapshotLinks = loadStoredSnapshotLinks();

export const fifoState = $state({
  addresses: initialAddresses,
  activeAddress: loadStoredActiveAddress(initialAddresses),
  entries: initialAddresses.map((address) => ({
    address,
    fifoCount: 0,
    values: [] as number[],
    pending: false,
    error: null as string | null,
    lastReadAt: null as number | null,
  })),
  writeInProgress: false,
  snapshotLinks: initialSnapshotLinks,
});

function ensureSnapshotTimer(): void {
  if (snapshotTickTimer) return;
  snapshotTickTimer = setInterval(() => {
    void runSnapshotTick();
  }, 250);
}

async function appendSampleToFifoAddress(fifoAddress: number, value: number): Promise<boolean> {
  if (fifoState.writeInProgress) {
    return false;
  }

  const normalizedAddress = clampAddress(fifoAddress);
  const normalizedValue = Number(value) & 0xFFFF;
  const entry = ensureEntry(normalizedAddress);

  fifoState.writeInProgress = true;
  entry.error = null;
  try {
    const response = await invoke<BackendReadFifoQueueResponse>("store_append_fifo_queue_value", {
      address: normalizedAddress,
      value: normalizedValue,
    });
    entry.fifoCount = response.fifoCount;
    entry.values = Array.isArray(response.values) ? response.values.map((item) => Number(item) & 0xFFFF) : [];
    entry.lastReadAt = Date.now();
    return true;
  } catch (err) {
    const message = parseInvokeError(err);
    entry.error = message;
    addLog("warn", `fifo.store append err addr=${normalizedAddress} msg=${message}`);
    return false;
  } finally {
    fifoState.writeInProgress = false;
  }
}

async function runSnapshotTick(): Promise<void> {
  if (snapshotTickRunning) return;
  snapshotTickRunning = true;

  try {
    const now = Date.now();
    for (const link of fifoState.snapshotLinks) {
      if (!link.enabled) continue;
      if (link.trigger !== "interval" && link.trigger !== "hybrid") continue;

      const elapsed = link.lastSampleAt == null ? Number.POSITIVE_INFINITY : now - link.lastSampleAt;
      if (elapsed < link.intervalMs) continue;

      const reader = snapshotSourceReaders[link.source];
      if (!reader) continue;
      const value = reader(link.sourceAddress);
      if (value == null) continue;

      const ok = await appendSampleToFifoAddress(link.fifoAddress, value);
      if (ok) {
        link.lastValue = value & 0xFFFF;
        link.lastSampleAt = now;
      } else {
        link.droppedSamples += 1;
      }
    }
  } finally {
    snapshotTickRunning = false;
  }
}

export function initFifoState(): void {
  if (fifoState.addresses.length === 0) {
    fifoState.addresses = [0];
  }
  if (!fifoState.addresses.includes(fifoState.activeAddress)) {
    fifoState.activeAddress = fifoState.addresses[0] ?? 0;
  }
  for (const address of fifoState.addresses) {
    ensureEntry(address);
  }
  for (const link of fifoState.snapshotLinks) {
    ensureEntry(link.fifoAddress);
    if (!fifoState.addresses.includes(link.fifoAddress)) {
      fifoState.addresses = [...fifoState.addresses, link.fifoAddress].sort((a, b) => a - b);
    }
  }
  persistAddresses();
  ensureSnapshotTimer();
  void refreshAllFifoQueues();
}

export function registerFifoSnapshotSourceReader(source: FifoSnapshotSource, reader: FifoSnapshotSourceReader): void {
  snapshotSourceReaders[source] = reader;
}

export async function recordFifoLinkedSourceSample(
  source: FifoSnapshotSource,
  sourceAddress: number,
  value: number,
): Promise<void> {
  const normalizedAddress = clampAddress(sourceAddress);
  const normalizedValue = Number(value) & 0xFFFF;
  const now = Date.now();

  for (const link of fifoState.snapshotLinks) {
    if (!link.enabled) continue;
    if (link.source !== source || link.sourceAddress !== normalizedAddress) continue;
    if (link.trigger !== "on-change" && link.trigger !== "hybrid") continue;

    if (link.lastValue === normalizedValue && link.trigger === "on-change") {
      continue;
    }

    const ok = await appendSampleToFifoAddress(link.fifoAddress, normalizedValue);
    if (ok) {
      link.lastValue = normalizedValue;
      link.lastSampleAt = now;
    } else {
      link.droppedSamples += 1;
    }
  }
}

export function addFifoSnapshotLink(input: {
  source: FifoSnapshotSource;
  sourceAddress: number;
  fifoAddress: number;
  trigger: FifoSnapshotTrigger;
  intervalMs?: number;
}): void {
  const normalized: FifoSnapshotLink = {
    id: makeSnapshotLinkId(),
    source: input.source,
    sourceAddress: clampAddress(input.sourceAddress),
    fifoAddress: clampAddress(input.fifoAddress),
    trigger: input.trigger,
    intervalMs: clampIntervalMs(Number(input.intervalMs ?? 1000)),
    enabled: true,
    lastValue: null,
    lastSampleAt: null,
    droppedSamples: 0,
  };

  const duplicate = fifoState.snapshotLinks.some((link) =>
    link.source === normalized.source
    && link.sourceAddress === normalized.sourceAddress
    && link.fifoAddress === normalized.fifoAddress
    && link.trigger === normalized.trigger,
  );
  if (duplicate) return;

  fifoState.snapshotLinks = [...fifoState.snapshotLinks, normalized];
  if (!fifoState.addresses.includes(normalized.fifoAddress)) {
    fifoState.addresses = [...fifoState.addresses, normalized.fifoAddress].sort((a, b) => a - b);
    ensureEntry(normalized.fifoAddress);
    persistAddresses();
  }
  persistSnapshotLinks();
}

export function removeFifoSnapshotLink(id: string): void {
  fifoState.snapshotLinks = fifoState.snapshotLinks.filter((link) => link.id !== id);
  persistSnapshotLinks();
}

export function setFifoSnapshotLinkEnabled(id: string, enabled: boolean): void {
  const link = fifoState.snapshotLinks.find((item) => item.id === id);
  if (!link) return;
  link.enabled = enabled;
  persistSnapshotLinks();
}

export function setFifoSnapshotLinkInterval(id: string, intervalMs: number): void {
  const link = fifoState.snapshotLinks.find((item) => item.id === id);
  if (!link) return;
  link.intervalMs = clampIntervalMs(intervalMs);
  persistSnapshotLinks();
}

export function setActiveFifoAddress(address: number): void {
  const normalized = clampAddress(address);
  if (!fifoState.addresses.includes(normalized)) return;
  fifoState.activeAddress = normalized;
  persistActiveAddress();
}

export function addFifoAddress(address: number): boolean {
  const normalized = clampAddress(address);
  if (fifoState.addresses.includes(normalized)) {
    return false;
  }

  fifoState.addresses = [...fifoState.addresses, normalized].sort((a, b) => a - b);
  ensureEntry(normalized);
  fifoState.activeAddress = normalized;
  persistAddresses();
  persistActiveAddress();
  void readFifoAddress(normalized);
  return true;
}

export function removeFifoAddress(address: number): void {
  const normalized = clampAddress(address);
  if (!fifoState.addresses.includes(normalized)) return;

  fifoState.addresses = fifoState.addresses.filter((candidate) => candidate !== normalized);
  fifoState.entries = fifoState.entries.filter((entry) => entry.address !== normalized);
  const nextLinks = fifoState.snapshotLinks.filter((link) => link.fifoAddress !== normalized);
  if (nextLinks.length !== fifoState.snapshotLinks.length) {
    fifoState.snapshotLinks = nextLinks;
    persistSnapshotLinks();
  }

  if (fifoState.addresses.length === 0) {
    fifoState.addresses = [0];
    fifoState.activeAddress = 0;
    ensureEntry(0);
  } else if (fifoState.activeAddress === normalized) {
    fifoState.activeAddress = fifoState.addresses[0];
  }

  persistAddresses();
  persistActiveAddress();
  void refreshAllFifoQueues();
}

export function getActiveFifoEntry(): FifoQueueEntry | null {
  return fifoState.entries.find((entry) => entry.address === fifoState.activeAddress) ?? null;
}

export async function readFifoAddress(address: number): Promise<void> {
  const normalized = clampAddress(address);
  const entry = ensureEntry(normalized);

  if (entry.pending) return;

  entry.pending = true;
  entry.error = null;

  try {
    const response = await invoke<BackendReadFifoQueueResponse>("store_read_fifo_queue", {
      address: normalized,
    });

    entry.fifoCount = response.fifoCount;
    entry.values = Array.isArray(response.values) ? response.values.map((value) => Number(value) & 0xFFFF) : [];
    entry.lastReadAt = Date.now();
    entry.error = null;
  } catch (err) {
    const message = parseInvokeError(err);
    entry.error = message;
    addLog("warn", `fifo.read err addr=${normalized} msg=${message}`);
  } finally {
    entry.pending = false;
  }
}

export async function refreshAllFifoQueues(): Promise<void> {
  for (const address of fifoState.addresses) {
    await readFifoAddress(address);
  }
}

export async function setFifoAddressQueue(address: number, values: number[]): Promise<void> {
  const normalized = clampAddress(address);
  const entry = ensureEntry(normalized);

  if (fifoState.writeInProgress) return;
  fifoState.writeInProgress = true;
  entry.error = null;

  try {
    const response = await invoke<BackendReadFifoQueueResponse>("store_set_fifo_queue", {
      address: normalized,
      values: values.map((value) => Number(value) & 0xFFFF),
    });

    entry.fifoCount = response.fifoCount;
    entry.values = Array.isArray(response.values) ? response.values.map((value) => Number(value) & 0xFFFF) : [];
    entry.lastReadAt = Date.now();
    addLog("info", `fifo.store set ok addr=${normalized} count=${entry.values.length}`);
  } catch (err) {
    const message = parseInvokeError(err);
    entry.error = message;
    addLog("warn", `fifo.store set err addr=${normalized} msg=${message}`);
  } finally {
    fifoState.writeInProgress = false;
  }
}

export async function clearFifoAddressQueue(address: number): Promise<void> {
  const normalized = clampAddress(address);
  const entry = ensureEntry(normalized);

  if (fifoState.writeInProgress) return;
  fifoState.writeInProgress = true;
  entry.error = null;

  try {
    await invoke<BackendReadFifoQueueResponse>("store_clear_fifo_queue", {
      address: normalized,
    });

    entry.fifoCount = 0;
    entry.values = [];
    entry.lastReadAt = Date.now();
    addLog("info", `fifo.store clear ok addr=${normalized}`);
  } catch (err) {
    const message = parseInvokeError(err);
    entry.error = message;
    addLog("warn", `fifo.store clear err addr=${normalized} msg=${message}`);
  } finally {
    fifoState.writeInProgress = false;
  }
}
