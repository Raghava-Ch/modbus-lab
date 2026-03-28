// Coils state — FC 01 (Read) · FC 05 (Write Single) · FC 15 (Write Multiple)

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
  label: string;
  origin: CoilOrigin;
}

const COIL_VIEW_KEY = "modbux.coilView";

function generateCoils(startAddress: number, count: number): CoilEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    address: startAddress + i,
    slaveValue: false,
    desiredValue: false,
    pending: false,
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
}

export function setCoilValue(address: number, value: boolean): void {
  const entry = coilState.entries.find((e) => e.address === address);
  if (!entry) return;
  entry.desiredValue = value;
}

function commitWrite(addresses: number[]): void {
  for (const address of addresses) {
    const entry = coilState.entries.find((e) => e.address === address);
    if (entry) {
      entry.slaveValue = entry.desiredValue;
      entry.pending = false;
    }
  }
}

export function writeCoil(address: number): void {
  const entry = coilState.entries.find((e) => e.address === address);
  if (!entry) return;
  entry.pending = true;
  setTimeout(() => {
    commitWrite([address]);
  }, 400);
}

export function writePendingCoils(): number {
  const pendingAddresses = coilState.entries
    .filter((entry) => entry.desiredValue !== entry.slaveValue)
    .map((entry) => entry.address);

  if (pendingAddresses.length === 0) return 0;

  for (const address of pendingAddresses) {
    const entry = coilState.entries.find((e) => e.address === address);
    if (entry) entry.pending = true;
  }

  setTimeout(() => {
    commitWrite(pendingAddresses);
  }, 400);

  return pendingAddresses.length;
}

export function readCoil(address: number): void {
  const entry = coilState.entries.find((e) => e.address === address);
  if (!entry) return;
  entry.pending = true;
  setTimeout(() => {
    const e = coilState.entries.find((e2) => e2.address === address);
    if (e) e.pending = false;
  }, 300);
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

function applyPattern(pattern: MassWritePattern, addresses: number[]): void {
  let i = 0;
  for (const address of addresses) {
    const entry = coilState.entries.find((e) => e.address === address);
    if (!entry) continue;
    switch (pattern) {
      case "all-on":
        entry.desiredValue = true;
        break;
      case "all-off":
        entry.desiredValue = false;
        break;
      case "alternating":
        entry.desiredValue = i % 2 === 0;
        break;
      case "alternating-inv":
        entry.desiredValue = i % 2 !== 0;
        break;
      case "every-third":
        entry.desiredValue = i % 3 === 0;
        break;
      case "random":
        entry.desiredValue = Math.random() >= 0.5;
        break;
    }
    entry.pending = true;
    i++;
  }
  setTimeout(() => {
    commitWrite(addresses);
  }, 400);
}

function invertAddresses(addresses: number[]): void {
  for (const address of addresses) {
    const entry = coilState.entries.find((e) => e.address === address);
    if (entry) {
      entry.desiredValue = !entry.desiredValue;
    }
  }
}

// ── Mass write ────────────────────────────────────────────────────────────────

export function executeMassWrite(): void {
  const targets = getTargetAddresses();
  applyPattern(coilState.massPattern, targets);
}

export function startAutoToggle(): void {
  if (autoToggleTimer) clearInterval(autoToggleTimer);
  coilState.massAutoActive = true;
  const targets = getTargetAddresses();
  applyPattern(coilState.massPattern, targets);
  autoToggleTimer = setInterval(() => {
    const nextTargets = getTargetAddresses();
    invertAddresses(nextTargets);
    for (const address of nextTargets) {
      const entry = coilState.entries.find((e) => e.address === address);
      if (entry) entry.pending = true;
    }
    setTimeout(() => {
      commitWrite(nextTargets);
    }, 250);
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

export function setPollActive(active: boolean): void {
  coilState.pollActive = active;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (active) {
    // In real app: trigger Modbus FC01 read each interval
    pollTimer = setInterval(() => {}, coilState.pollInterval);
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
