// Coils state — FC 01 (Read) · FC 05 (Write Single) · FC 15 (Write Multiple)

import { invoke } from "@tauri-apps/api/core";
import { addLog } from "./logs.svelte";

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


const COIL_VIEW_KEY = "modbux.coilView";

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
  entries: generateCoils(0, 16) as CoilEntry[],
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

// ── Init ──────────────────────────────────────────────────────────────────────

export function initCoilState(): void {
  const savedView = localStorage.getItem(COIL_VIEW_KEY);
  if (savedView === "switch" || savedView === "table") {
    coilState.view = savedView;
  }
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
    addLog("traffic", `Coil ${address} → ${response.value ? "ON" : "OFF"} ✓`);
  } catch (err) {
    const e = coilState.entries.find((e2) => e2.address === address);
    const message = parseInvokeError(err);
    if (e) {
      e.pending = false;
      e.writeError = message;
    }
    addLog("error", `Write coil ${address} failed: ${message}`);
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
      if (!e.pending || e.desiredValue === e.slaveValue) {
        e.desiredValue = coilVal.value;
      }
      if (e.desiredValue === e.slaveValue) {
        e.writeError = null;
      }
      e.pending = false;
    } else if (e) {
      e.pending = false;
    }
    addLog("traffic", `Coil ${address} read → ${coilVal?.value ? "ON" : "OFF"}`);
  } catch (err) {
    const e = coilState.entries.find((e2) => e2.address === address);
    if (e) e.pending = false;
    addLog("error", `Read coil ${address} failed: ${parseInvokeError(err)}`);
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
      addLog(
        "traffic",
        `Batch write: ${response.writtenCount}/${response.totalCount} coil${response.totalCount === 1 ? "" : "s"} ✓`
      );
    } else {
      const failedAddresses = response.failures.map((failure) => failure.address).join(", ");
      const failureCodes = [...new Set(response.failures.map((failure) => failure.code))].join(", ");
      addLog(
        "warn",
        `Batch partial failure: ${response.writtenCount}/${response.totalCount} succeeded; failed coil${response.failures.length === 1 ? "" : "s"} ${failedAddresses}; exception code${failureCodes.includes(",") ? "s" : ""}: ${failureCodes}`
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
    addLog("error", `Batch write failed: ${message}`);
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
  void writeAddressMap(initialMap);

  autoToggleTimer = setInterval(() => {
    const targets = getTargetAddresses();
    invertAddresses(targets);
    const invertMap = new Map(targets.map((addr) => {
      const entry = coilState.entries.find((e) => e.address === addr);
      return [addr, entry?.desiredValue ?? false] as [number, boolean];
    }));
    void writeAddressMap(invertMap);
  }, coilState.massAutoInterval);
}

export function stopAutoToggle(): void {
  if (autoToggleTimer) {
    clearInterval(autoToggleTimer);
    autoToggleTimer = null;
  }
  coilState.massAutoActive = false;
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

export function addExclusiveCoil(address: number): boolean {
  if (!Number.isFinite(address)) return false;
  const normalized = Math.floor(address);
  if (normalized < 0 || normalized > 65535) return false;
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
  const used = new Set(coilState.entries.map((e) => e.address));
  const pool: number[] = [];

  // Pick from current range neighborhood first, then broaden.
  for (let addr = coilState.startAddress; addr < coilState.startAddress + coilState.coilCount + 256; addr++) {
    if (addr >= 0 && addr <= 65535 && !used.has(addr)) {
      pool.push(addr);
    }
  }

  if (pool.length === 0) {
    for (let addr = 0; addr <= 65535; addr++) {
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

export function removeAllCustomCoils(): void {
  coilState.entries = coilState.entries.filter((e) => e.origin !== "custom");
}

// ── Poll ──────────────────────────────────────────────────────────────────────

export async function readAllCoils(): Promise<void> {
  if (coilState.entries.length === 0) return;

  const addresses = coilState.entries.map((e) => e.address);
  const startAddress = Math.min(...addresses);
  const endAddress = Math.max(...addresses);
  const quantity = endAddress - startAddress + 1;

  if (quantity > 2000) {
    addLog("warn", `Coil range too large (${quantity} > 2000). Narrow the address range.`);
    return;
  }

  try {
    const response = await invoke<BackendReadCoilsResponse>("read_coils", {
      request: { startAddress, quantity },
    });

    for (const coilVal of response.coils) {
      const entry = coilState.entries.find((e) => e.address === coilVal.address);
      if (entry && !entry.pending) {
        entry.slaveValue = coilVal.value;
        if (entry.desiredValue === entry.slaveValue || !entry.pending) {
          entry.desiredValue = coilVal.value;
        }
        if (entry.desiredValue === entry.slaveValue) {
          entry.writeError = null;
        }
      }
    }
    addLog("traffic", `FC01 read ${quantity} coil${quantity === 1 ? "" : "s"} from ${startAddress}`);
  } catch (err) {
    addLog("error", `Read coils failed: ${parseInvokeError(err)}`);
  }
}

export function setPollActive(active: boolean): void {
  coilState.pollActive = active;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (active) {
    void readAllCoils();
    pollTimer = setInterval(() => { void readAllCoils(); }, coilState.pollInterval);
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

  coilState.startAddress = startAddress;
  coilState.coilCount = count;

  // Keep custom-added coils while rebuilding base range entries.
  const customEntries = coilState.entries.filter((e) => e.origin === "custom");
  const rangeEntries = generateCoils(startAddress, count).map((entry) => {
    const existing = coilState.entries.find((e) => e.address === entry.address);
    if (!existing) return entry;
    return {
      ...entry,
      slaveValue: existing.slaveValue,
      desiredValue: existing.desiredValue,
      writeError: existing.writeError,
      label: existing.label,
      pending: existing.pending,
      origin: "range" as const,
    };
  });

  upsertAndSortEntries([...rangeEntries, ...customEntries]);

  // Reset mass-write range to match new entries
  coilState.massFrom = startAddress;
  coilState.massTo = startAddress + count - 1;
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
