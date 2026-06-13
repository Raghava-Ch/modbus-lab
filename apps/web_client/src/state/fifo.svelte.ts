import { addLog } from "./logs.svelte";
import { notifyWarning, notifyInfo } from "./notifications.svelte";
import { connectionState } from "./connection.svelte";
import { modbusAdapter } from "../lib/adapters/WebModbusAdapter";
import {
  getGlobalPollingMaxAddressCount,
  getSettingsSnapshot,
  isPollingAllowedForCount,
} from "./settings.svelte";

export interface FifoQueueEntry {
  address: number;
  fifoCount: number;
  values: number[];
  pending: boolean;
  error: string | null;
  lastReadAt: number | null;
}

interface BackendReadFifoQueueResponse {
  address: number;
  fifoCount: number;
  values: number[];
}

const FIFO_ADDRESSES_KEY = "Modbus-Lab.client.fifo.addresses";
const FIFO_ACTIVE_ADDRESS_KEY = "Modbus-Lab.client.fifo.activeAddress";
const FIFO_ADDRESS_MIN = 0;
const FIFO_ADDRESS_MAX = 65535;
const FIFO_POLL_INTERVAL_MIN = 200;
const FIFO_POLL_INTERVAL_MAX = 60000;

let pollTimer: ReturnType<typeof setInterval> | null = null;

function clampAddress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(FIFO_ADDRESS_MIN, Math.min(FIFO_ADDRESS_MAX, Math.floor(value)));
}

function clampPollInterval(value: number): number {
  if (!Number.isFinite(value)) return 1000;
  return Math.max(FIFO_POLL_INTERVAL_MIN, Math.min(FIFO_POLL_INTERVAL_MAX, Math.floor(value)));
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
  const normalized = Number.isFinite(parsed) ? clampAddress(parsed) : addresses[0] ?? 0;
  return addresses.includes(normalized) ? normalized : (addresses[0] ?? 0);
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

function restartPollTimer(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (!fifoState.pollActive) return;

  pollTimer = setInterval(() => {
    void refreshAllFifoQueues({ queueIfBusy: true });
  }, fifoState.pollInterval);
}

const initialAddresses = loadStoredAddresses();

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
  pollActive: false,
  pollInterval: 1000,
  readInProgress: false,
});

let readQueued = false;

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

  const settings = getSettingsSnapshot();
  setFifoPollInterval(settings.polling.defaultIntervalMs);
  void refreshAllFifoQueues();
}

export function teardownFifoState(): void {
  setFifoPollActive(false);
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

  if (fifoState.pollActive && !isPollingAllowedForCount(fifoState.addresses.length)) {
    setFifoPollActive(false);
    warnLocal(
      `FIFO polling disabled because ${fifoState.addresses.length} addresses exceeds global limit (${getGlobalPollingMaxAddressCount()}).`,
    );
  }

  void readFifoAddress(normalized);
  return true;
}

export function removeFifoAddress(address: number): void {
  const normalized = clampAddress(address);
  if (!fifoState.addresses.includes(normalized)) return;

  fifoState.addresses = fifoState.addresses.filter((candidate) => candidate !== normalized);
  fifoState.entries = fifoState.entries.filter((entry) => entry.address !== normalized);

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
  if (connectionState.status === "reconnecting" || connectionState.status === "disconnected") return;

  entry.pending = true;
  entry.error = null;

  try {
    const values = await modbusAdapter.readFifoQueue(normalized);

    entry.fifoCount = values.length;
    entry.values = Array.from(values);
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

export async function refreshAllFifoQueues(options?: { queueIfBusy?: boolean }): Promise<void> {
  const queueIfBusy = options?.queueIfBusy ?? true;

  if (fifoState.readInProgress) {
    if (queueIfBusy) {
      readQueued = true;
    }
    return;
  }

  if (connectionState.status === "reconnecting" || connectionState.status === "disconnected") {
    return;
  }

  fifoState.readInProgress = true;
  readQueued = false;

  try {
    for (const address of fifoState.addresses) {
      await readFifoAddress(address);
    }
  } finally {
    fifoState.readInProgress = false;
    if (readQueued) {
      readQueued = false;
      void refreshAllFifoQueues({ queueIfBusy: false });
    }
  }
}

export function setFifoPollActive(active: boolean): void {
  if (active && !isPollingAllowedForCount(fifoState.addresses.length)) {
    warnLocal(
      `FIFO polling requires at most ${getGlobalPollingMaxAddressCount()} addresses. Current: ${fifoState.addresses.length}.`,
    );
    fifoState.pollActive = false;
    restartPollTimer();
    return;
  }

  fifoState.pollActive = active;
  restartPollTimer();

  if (active) {
    void refreshAllFifoQueues({ queueIfBusy: false });
  }
}

export function setFifoPollInterval(intervalMs: number): void {
  fifoState.pollInterval = clampPollInterval(intervalMs);
  if (fifoState.pollActive) {
    restartPollTimer();
  }
}

export function exportFifoState(): string {
  const payload = {
    schema: "modbus-lab.fifo.v1",
    exportedAt: new Date().toISOString(),
    addresses: fifoState.addresses,
    activeAddress: fifoState.activeAddress,
  };
  return JSON.stringify(payload, null, 2);
}

export function importFifoStateJson(raw: string): void {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schema !== "modbus-lab.fifo.v1") {
      throw new Error("Invalid or unsupported FIFO configuration schema version.");
    }

    if (Array.isArray(parsed.addresses)) {
      let importedCount = 0;
      for (const addr of parsed.addresses) {
        const parsedAddr = Number(addr);
        if (Number.isFinite(parsedAddr)) {
          const normalized = clampAddress(parsedAddr);
          if (!fifoState.addresses.includes(normalized)) {
            fifoState.addresses = [...fifoState.addresses, normalized].sort((a, b) => a - b);
            ensureEntry(normalized);
            importedCount++;
          }
        }
      }
      
      if (Number.isFinite(parsed.activeAddress)) {
        const normalizedActive = clampAddress(parsed.activeAddress);
        if (fifoState.addresses.includes(normalizedActive)) {
          fifoState.activeAddress = normalizedActive;
          persistActiveAddress();
        }
      } else if (fifoState.addresses.length > 0) {
        fifoState.activeAddress = fifoState.addresses[0];
        persistActiveAddress();
      }

      persistAddresses();

      if (importedCount > 0) {
        notifyInfo(`Successfully imported ${importedCount} FIFO queue addresses.`);
        void refreshAllFifoQueues();
      } else {
        notifyInfo("No new FIFO queue addresses to import.");
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid FIFO JSON.";
    notifyWarning(`FIFO import failed: ${message}`);
  }
}
