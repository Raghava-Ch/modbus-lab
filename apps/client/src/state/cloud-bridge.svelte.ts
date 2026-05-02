// Frontend state for the MQTT cloud bridge.
//
// All state is in-memory. Nothing is written to localStorage / disk —
// every app launch is a fresh start (free-tier scope).

export type BridgeDirection = "publish" | "subscribe" | "bidirectional";
export type ModbusArea = "coil" | "discreteInput" | "holdingRegister" | "inputRegister";

export interface BrokerConfig {
  host: string;
  port: number;
  clientId: string;
  username: string;
  password: string;
  keepAliveSecs: number;
  useTls: boolean;
}

export interface MappingDefinition {
  id: string;
  name: string;
  direction: BridgeDirection;
  area: ModbusArea;
  address: number;
  topic: string;
  qos: 0 | 1 | 2;
  retain: boolean;
  publishIntervalMs: number;
}

export interface BridgeStatus {
  running: boolean;
  connected: boolean;
  mappingCount: number;
  lastError: string | null;
  brokerHost: string | null;
}

export interface BridgeLogEntry {
  id: number;
  timestamp: number;
  level: "info" | "warn" | "error" | "traffic";
  message: string;
}

export interface CloudBridgeStateShape {
  broker: BrokerConfig;
  mappings: MappingDefinition[];
  status: BridgeStatus;
  log: BridgeLogEntry[];
}

const DEFAULT_BROKER: BrokerConfig = {
  host: "",
  port: 1883,
  clientId: "modbus-lab-1",
  username: "",
  password: "",
  keepAliveSecs: 30,
  useTls: false,
};

const DEFAULT_STATUS: BridgeStatus = {
  running: false,
  connected: false,
  mappingCount: 0,
  lastError: null,
  brokerHost: null,
};

/** Maximum log lines kept in the cloud-bridge in-memory ring buffer. */
export const MAX_LOG_ENTRIES = 500;

export const cloudBridgeState = $state<CloudBridgeStateShape>({
  broker: { ...DEFAULT_BROKER },
  mappings: [],
  status: { ...DEFAULT_STATUS },
  log: [],
});

let nextLogId = 1;
let nextMappingSeq = 1;

export function generateMappingId(): string {
  // Lightweight non-crypto id; fine because mappings are not persisted.
  const seq = nextMappingSeq++;
  const rand = Math.floor(Math.random() * 1_000_000).toString(36);
  return `m-${seq.toString(36)}-${rand}`;
}

export function setBrokerField<K extends keyof BrokerConfig>(
  key: K,
  value: BrokerConfig[K],
): void {
  cloudBridgeState.broker[key] = value;
}

export function addMapping(partial?: Partial<MappingDefinition>): MappingDefinition {
  const mapping: MappingDefinition = {
    id: generateMappingId(),
    name: partial?.name ?? `mapping-${cloudBridgeState.mappings.length + 1}`,
    direction: partial?.direction ?? "publish",
    area: partial?.area ?? "holdingRegister",
    address: clampAddress(partial?.address ?? 0),
    topic:
      partial?.topic ??
      "modbus-lab/{client_id}/{area}/{address}",
    qos: partial?.qos ?? 0,
    retain: partial?.retain ?? false,
    publishIntervalMs: clampInterval(partial?.publishIntervalMs ?? 1000),
  };
  cloudBridgeState.mappings.push(mapping);
  return mapping;
}

export function removeMapping(id: string): void {
  cloudBridgeState.mappings = cloudBridgeState.mappings.filter((m) => m.id !== id);
}

export function updateMapping(id: string, patch: Partial<MappingDefinition>): void {
  const idx = cloudBridgeState.mappings.findIndex((m) => m.id === id);
  if (idx === -1) return;
  const current = cloudBridgeState.mappings[idx];
  cloudBridgeState.mappings[idx] = {
    ...current,
    ...patch,
    address: patch.address !== undefined ? clampAddress(patch.address) : current.address,
    publishIntervalMs:
      patch.publishIntervalMs !== undefined
        ? clampInterval(patch.publishIntervalMs)
        : current.publishIntervalMs,
  };
}

export function setBridgeStatus(next: Partial<BridgeStatus>): void {
  Object.assign(cloudBridgeState.status, next);
}

export function appendBridgeLog(entry: Omit<BridgeLogEntry, "id" | "timestamp"> & {
  timestamp?: number;
}): void {
  cloudBridgeState.log.push({
    id: nextLogId++,
    timestamp: entry.timestamp ?? Date.now(),
    level: entry.level,
    message: entry.message,
  });
  if (cloudBridgeState.log.length > MAX_LOG_ENTRIES) {
    cloudBridgeState.log.splice(0, cloudBridgeState.log.length - MAX_LOG_ENTRIES);
  }
}

export function clearBridgeLog(): void {
  cloudBridgeState.log = [];
}

export function resetCloudBridgeState(): void {
  cloudBridgeState.broker = { ...DEFAULT_BROKER };
  cloudBridgeState.mappings = [];
  cloudBridgeState.status = { ...DEFAULT_STATUS };
  cloudBridgeState.log = [];
  nextMappingSeq = 1;
}

export function clampAddress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(65535, Math.floor(value)));
}

export function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return 1000;
  return Math.max(100, Math.min(3_600_000, Math.floor(value)));
}

export function clampPort(value: number): number {
  if (!Number.isFinite(value)) return 1883;
  return Math.max(1, Math.min(65535, Math.floor(value)));
}

export function clampKeepAlive(value: number): number {
  if (!Number.isFinite(value)) return 30;
  return Math.max(1, Math.min(3600, Math.floor(value)));
}

/**
 * Build the request payload that matches the Tauri backend
 * `StartBridgeRequest` shape (camelCase ↔ camelCase, but `ModbusArea`
 * variants need backend-friendly names: `coil` / `discreteInput` /
 * `holdingRegister` / `inputRegister`, which already match here).
 */
export function buildStartRequest(): {
  broker: {
    host: string;
    port: number;
    clientId: string;
    username: string | null;
    password: string | null;
    keepAliveSecs: number;
    useTls: boolean;
  };
  mappings: Array<{
    id: string;
    name: string;
    direction: BridgeDirection;
    area: ModbusArea;
    address: number;
    topic: string;
    qos: number;
    retain: boolean;
    publishIntervalMs: number;
  }>;
} {
  const b = cloudBridgeState.broker;
  return {
    broker: {
      host: b.host.trim(),
      port: clampPort(b.port),
      clientId: b.clientId.trim(),
      username: b.username.trim() ? b.username : null,
      password: b.password ? b.password : null,
      keepAliveSecs: clampKeepAlive(b.keepAliveSecs),
      useTls: b.useTls,
    },
    mappings: cloudBridgeState.mappings.map((m) => ({
      id: m.id,
      name: m.name,
      direction: m.direction,
      area: m.area,
      address: clampAddress(m.address),
      topic: m.topic,
      qos: m.qos,
      retain: m.retain,
      publishIntervalMs: clampInterval(m.publishIntervalMs),
    })),
  };
}
