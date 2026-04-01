export type ValueViewFormat = "dec" | "hex";
export type LogTimeFormat = "24h" | "12h";
export type LogTimePrecision = "s" | "ms";
export type ForcedLayoutMode = "auto" | "desktop" | "mobile";

export interface FeatureDefaults {
  startAddress: number;
  count: number;
  view: "table" | "cards" | "switch";
}

export interface AppSettings {
  rememberLastFeatureState: boolean;
  valueViewFormat: ValueViewFormat;
  forcedLayoutMode: ForcedLayoutMode;
  polling: {
    defaultIntervalMs: number;
    maxAddressCountForPolling: number;
  };
  logs: {
    timeFormat: LogTimeFormat;
    timePrecision: LogTimePrecision;
    maxRetainedEntries: number;
  };
  defaults: {
    coils: FeatureDefaults;
    discreteInputs: FeatureDefaults;
    holdingRegisters: FeatureDefaults;
    inputRegisters: FeatureDefaults;
  };
}

const SETTINGS_KEY = "modbux.settings.v1";

export const DEFAULT_SETTINGS: AppSettings = {
  rememberLastFeatureState: true,
  valueViewFormat: "dec",
  forcedLayoutMode: "auto",
  polling: {
    defaultIntervalMs: 1000,
    maxAddressCountForPolling: 125,
  },
  logs: {
    timeFormat: "24h",
    timePrecision: "s",
    maxRetainedEntries: 4000,
  },
  defaults: {
    coils: { startAddress: 0, count: 16, view: "table" },
    discreteInputs: { startAddress: 0, count: 8, view: "table" },
    holdingRegisters: { startAddress: 0, count: 16, view: "table" },
    inputRegisters: { startAddress: 0, count: 16, view: "table" },
  },
};

function cloneDefaults(): AppSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings;
}

function normalizeFeatureDefaults(value: unknown, fallback: FeatureDefaults): FeatureDefaults {
  const v = (value ?? {}) as Partial<FeatureDefaults>;
  const view = v.view === "table" || v.view === "cards" || v.view === "switch" ? v.view : fallback.view;
  const startAddress = Number.isFinite(v.startAddress) ? Math.max(0, Math.floor(v.startAddress as number)) : fallback.startAddress;
  const count = Number.isFinite(v.count) ? Math.max(1, Math.floor(v.count as number)) : fallback.count;
  return { startAddress, count, view };
}

function normalizeSettings(raw: unknown): AppSettings {
  const base = cloneDefaults();
  const incoming = (raw ?? {}) as Partial<AppSettings>;

  base.rememberLastFeatureState = incoming.rememberLastFeatureState ?? base.rememberLastFeatureState;
  base.valueViewFormat =
    incoming.valueViewFormat === "dec" || incoming.valueViewFormat === "hex"
      ? incoming.valueViewFormat
      : base.valueViewFormat;
  base.forcedLayoutMode =
    incoming.forcedLayoutMode === "auto" || incoming.forcedLayoutMode === "desktop" || incoming.forcedLayoutMode === "mobile"
      ? incoming.forcedLayoutMode
      : base.forcedLayoutMode;

  const polling: Partial<AppSettings["polling"]> = incoming.polling ?? {};
  base.polling.defaultIntervalMs = Number.isFinite(polling.defaultIntervalMs)
    ? Math.max(250, Math.floor(polling.defaultIntervalMs as number))
    : base.polling.defaultIntervalMs;
  base.polling.maxAddressCountForPolling = Number.isFinite(polling.maxAddressCountForPolling)
    ? Math.max(1, Math.floor(polling.maxAddressCountForPolling as number))
    : base.polling.maxAddressCountForPolling;

  const logs: Partial<AppSettings["logs"]> = incoming.logs ?? {};
  base.logs.timeFormat = logs.timeFormat === "12h" || logs.timeFormat === "24h" ? logs.timeFormat : base.logs.timeFormat;
  base.logs.timePrecision = logs.timePrecision === "ms" || logs.timePrecision === "s" ? logs.timePrecision : base.logs.timePrecision;
  base.logs.maxRetainedEntries = Number.isFinite(logs.maxRetainedEntries)
    ? Math.max(200, Math.floor(logs.maxRetainedEntries as number))
    : base.logs.maxRetainedEntries;

  const defaults: Partial<AppSettings["defaults"]> = incoming.defaults ?? {};
  base.defaults.coils = normalizeFeatureDefaults(defaults.coils, base.defaults.coils);
  base.defaults.discreteInputs = normalizeFeatureDefaults(defaults.discreteInputs, base.defaults.discreteInputs);
  base.defaults.holdingRegisters = normalizeFeatureDefaults(defaults.holdingRegisters, base.defaults.holdingRegisters);
  base.defaults.inputRegisters = normalizeFeatureDefaults(defaults.inputRegisters, base.defaults.inputRegisters);

  return base;
}

function loadSettings(): AppSettings {
  if (typeof localStorage === "undefined") {
    return cloneDefaults();
  }

  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return cloneDefaults();
    }
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return cloneDefaults();
  }
}

function persist(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsState));
}

function applyForcedLayoutAttribute(): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-forced-layout", settingsState.forcedLayoutMode);
}

export const settingsState = $state(loadSettings());

export function initSettingsState(): void {
  const loaded = loadSettings();
  Object.assign(settingsState, loaded);
  applyForcedLayoutAttribute();
}

export function getSettingsSnapshot(): AppSettings {
  return normalizeSettings(settingsState);
}

export function resetSettingsToDefaults(): void {
  const next = cloneDefaults();
  Object.assign(settingsState, next);
  persist();
  applyForcedLayoutAttribute();
}

export function setRememberLastFeatureState(value: boolean): void {
  settingsState.rememberLastFeatureState = value;
  persist();
}

export function setValueViewFormat(format: ValueViewFormat): void {
  settingsState.valueViewFormat = format;
  persist();
}

export function setForcedLayoutMode(mode: ForcedLayoutMode): void {
  settingsState.forcedLayoutMode = mode;
  persist();
  applyForcedLayoutAttribute();
}

export function setGlobalPollingDefaultInterval(ms: number): void {
  settingsState.polling.defaultIntervalMs = Math.max(250, Math.floor(ms));
  persist();
}

export function setGlobalPollingMaxAddressCount(count: number): void {
  settingsState.polling.maxAddressCountForPolling = Math.max(1, Math.floor(count));
  persist();
}

export function setLogTimeFormat(format: LogTimeFormat): void {
  settingsState.logs.timeFormat = format;
  persist();
}

export function setLogTimePrecision(precision: LogTimePrecision): void {
  settingsState.logs.timePrecision = precision;
  persist();
}

export function setMaxRetainedLogEntries(count: number): void {
  settingsState.logs.maxRetainedEntries = Math.max(200, Math.floor(count));
  persist();
}

export function setFeatureDefaults(feature: keyof AppSettings["defaults"], patch: Partial<FeatureDefaults>): void {
  const current = settingsState.defaults[feature];
  settingsState.defaults[feature] = normalizeFeatureDefaults({ ...current, ...patch }, current);
  persist();
}

export function getGlobalPollingMaxAddressCount(): number {
  return Math.max(1, settingsState.polling.maxAddressCountForPolling);
}

export function isPollingAllowedForCount(count: number): boolean {
  return count <= getGlobalPollingMaxAddressCount();
}

export function formatAddressWithSettings(value: number): string {
  const normalized = Math.max(0, Math.floor(value));
  switch (settingsState.valueViewFormat) {
    case "hex":
      return `0x${normalized.toString(16).toUpperCase().padStart(4, "0")}`;
    default:
      return normalized.toString().padStart(4, "0");
  }
}

export function formatWordValueWithSettings(value: number): string {
  const normalized = Math.max(0, Math.min(65535, Math.floor(value)));
  switch (settingsState.valueViewFormat) {
    case "hex":
      return `0x${normalized.toString(16).toUpperCase().padStart(4, "0")}`;
    default:
      return String(normalized);
  }
}

export function formatLogTimestamp(value: number | string): string {
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  const withMs = settingsState.logs.timePrecision === "ms";
  const hour12 = settingsState.logs.timeFormat === "12h";

  if (Number.isNaN(date.getTime())) {
    return typeof value === "string" ? value : "--:--:--";
  }

  return date.toLocaleTimeString([], {
    hour12,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: withMs ? 3 : undefined,
  });
}

export function enforceLogRetention<T extends { id: number }>(entries: T[]): T[] {
  const max = Math.max(200, settingsState.logs.maxRetainedEntries);
  if (entries.length <= max) return entries;
  return entries.slice(entries.length - max);
}
