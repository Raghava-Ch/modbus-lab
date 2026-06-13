import mqtt from "mqtt";
import { connectionState } from "./connection.svelte";
import { modbusAdapter } from "../lib/adapters/WebModbusAdapter";
import { addLog } from "./logs.svelte";

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
  path: string;
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
  path: "/mqtt",
};

const DEFAULT_STATUS: BridgeStatus = {
  running: false,
  connected: false,
  mappingCount: 0,
  lastError: null,
  brokerHost: null,
};

export const MAX_LOG_ENTRIES = 500;

export const cloudBridgeState = $state<CloudBridgeStateShape>({
  broker: { ...DEFAULT_BROKER },
  mappings: [],
  status: { ...DEFAULT_STATUS },
  log: [],
});

let nextLogId = 1;
let nextMappingSeq = 1;
let mqttClient: mqtt.MqttClient | null = null;
let publishTimers: Record<string, ReturnType<typeof setInterval>> = {};

export function generateMappingId(): string {
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
    topic: partial?.topic ?? "modbus-lab/{client_id}/{area}/{address}",
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
  stopCloudBridge();
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

export function buildStartRequest() {
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
      path: b.path.trim(),
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

function renderTopic(mapping: MappingDefinition): string {
  const b = cloudBridgeState.broker;
  const areaSegment = {
    coil: "coil",
    discreteInput: "discrete-input",
    holdingRegister: "holding-register",
    inputRegister: "input-register",
  }[mapping.area];

  return mapping.topic
    .replace("{client_id}", b.clientId.trim())
    .replace("{area}", areaSegment)
    .replace("{address}", String(mapping.address))
    .replace("{name}", mapping.name);
}

function startPublishing(mapping: MappingDefinition) {
  if (publishTimers[mapping.id]) {
    clearInterval(publishTimers[mapping.id]);
  }

  const interval = Math.max(100, mapping.publishIntervalMs || 1000);
  publishTimers[mapping.id] = setInterval(async () => {
    if (!mqttClient || !mqttClient.connected) return;
    if (connectionState.status !== "connected") {
      appendBridgeLog({
        level: "warn",
        message: `publish skipped name="${mapping.name}" topic=${renderTopic(mapping)} reason=Modbus not connected`,
      });
      addLog("warn", `[CLOUD-BRIDGE/${renderTopic(mapping)}] publish skipped reason=Modbus not connected`);
      return;
    }

    try {
      let value = "";
      const address = mapping.address;
      if (mapping.area === "coil") {
        const resp = await modbusAdapter.readCoils(address, 1);
        value = String(resp.coils[0]?.value ?? false);
      } else if (mapping.area === "discreteInput") {
        const resp = await modbusAdapter.readDiscreteInputs(address, 1);
        value = String(resp.inputs[0]?.value ?? false);
      } else if (mapping.area === "holdingRegister") {
        const resp = await modbusAdapter.readHoldingRegisters(address, 1);
        value = String(resp.registers[0]?.value ?? 0);
      } else {
        const resp = await modbusAdapter.readInputRegisters(address, 1);
        value = String(resp.registers[0]?.value ?? 0);
      }

      const topic = renderTopic(mapping);
      mqttClient.publish(topic, value, {
        qos: mapping.qos,
        retain: mapping.retain,
      });

      appendBridgeLog({
        level: "traffic",
        message: `publish ok topic=${topic} payload=${value} qos=${mapping.qos}`,
      });
      addLog("traffic", `[CLOUD-BRIDGE/${topic}] publish ok payload=${value} qos=${mapping.qos}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      appendBridgeLog({
        level: "error",
        message: `publish err topic=${renderTopic(mapping)} msg=${msg}`,
      });
      addLog("error", `[CLOUD-BRIDGE/${renderTopic(mapping)}] publish err msg=${msg}`);
    }
  }, interval);
}

async function handleIncomingMessage(topic: string, messageBuffer: Uint8Array) {
  const payloadStr = new TextDecoder().decode(messageBuffer).trim();

  const matchedMapping = cloudBridgeState.mappings.find((m) => {
    if (m.direction === "publish") return false;
    return renderTopic(m) === topic;
  });

  if (!matchedMapping) {
    appendBridgeLog({
      level: "warn",
      message: `incoming on unmapped topic=${topic}`,
    });
    addLog("warn", `[CLOUD-BRIDGE/${topic}] incoming on unmapped topic`);
    return;
  }

  if (connectionState.status !== "connected") {
    appendBridgeLog({
      level: "warn",
      message: `incoming topic=${topic} ignored: Modbus not connected`,
    });
    addLog("warn", `[CLOUD-BRIDGE/${topic}] incoming ignored: Modbus not connected`);
    return;
  }

  try {
    if (matchedMapping.area === "coil") {
      let value = false;
      const lower = payloadStr.toLowerCase();
      if (lower === "true" || lower === "1" || lower === "on") {
        value = true;
      } else if (lower === "false" || lower === "0" || lower === "off") {
        value = false;
      } else {
        appendBridgeLog({
          level: "warn",
          message: `incoming topic=${topic} payload "${payloadStr}" is not a boolean`,
        });
        addLog("warn", `[CLOUD-BRIDGE/${topic}] payload "${payloadStr}" is not a boolean`);
        return;
      }

      await modbusAdapter.writeCoil(matchedMapping.address, value);
      appendBridgeLog({
        level: "traffic",
        message: `fc05.write ok addr=${matchedMapping.address} value=${value} via topic=${topic}`,
      });
      addLog("traffic", `[CLOUD-BRIDGE/${topic}] fc05.write ok addr=${matchedMapping.address} value=${value}`);
    } else if (matchedMapping.area === "holdingRegister") {
      const value = parseInt(payloadStr, 10);
      if (isNaN(value) || value < 0 || value > 65535) {
        appendBridgeLog({
          level: "warn",
          message: `incoming topic=${topic} payload "${payloadStr}" is not a 16-bit unsigned integer`,
        });
        addLog("warn", `[CLOUD-BRIDGE/${topic}] payload "${payloadStr}" is not a 16-bit unsigned integer`);
        return;
      }

      await modbusAdapter.writeHoldingRegister(matchedMapping.address, value);
      appendBridgeLog({
        level: "traffic",
        message: `fc06.write ok addr=${matchedMapping.address} value=${value} via topic=${topic}`,
      });
      addLog("traffic", `[CLOUD-BRIDGE/${topic}] fc06.write ok addr=${matchedMapping.address} value=${value}`);
    } else {
      appendBridgeLog({
        level: "warn",
        message: `incoming topic=${topic} targets read-only area ${matchedMapping.area}`,
      });
      addLog("warn", `[CLOUD-BRIDGE/${topic}] targets read-only area ${matchedMapping.area}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendBridgeLog({
      level: "error",
      message: `write err for topic=${topic}: ${msg}`,
    });
    addLog("error", `[CLOUD-BRIDGE/${topic}] write err: ${msg}`);
  }
}

export function startCloudBridge(): void {
  if (cloudBridgeState.status.running) return;

  const b = cloudBridgeState.broker;
  if (!b.host.trim()) {
    throw new Error("Broker host is required");
  }
  if (!b.clientId.trim()) {
    throw new Error("Client ID is required");
  }

  let url = b.host.trim();
  if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    const proto = b.useTls ? "wss" : "ws";
    let hostClean = b.host.trim();
    if (hostClean.endsWith("/")) {
      hostClean = hostClean.slice(0, -1);
    }
    let pathClean = b.path.trim();
    if (pathClean && !pathClean.startsWith("/")) {
      pathClean = `/${pathClean}`;
    }
    url = `${proto}://${hostClean}:${b.port}${pathClean}`;
  }

  appendBridgeLog({ level: "info", message: `Connecting to WebSocket MQTT broker at ${url}...` });
  addLog("info", `[CLOUD-BRIDGE] Connecting to WebSocket MQTT broker at ${url}...`);

  setBridgeStatus({ running: true, connected: false, brokerHost: b.host });

  try {
    mqttClient = mqtt.connect(url, {
      clientId: b.clientId,
      username: b.username.trim() || undefined,
      password: b.password || undefined,
      keepalive: b.keepAliveSecs,
      reconnectPeriod: 2000,
    });

    mqttClient.on("reconnect", () => {
      appendBridgeLog({ level: "info", message: "broker reconnecting..." });
      addLog("info", "[CLOUD-BRIDGE] broker reconnecting...");
    });

    mqttClient.on("offline", () => {
      appendBridgeLog({ level: "warn", message: "broker went offline" });
      addLog("warn", "[CLOUD-BRIDGE] broker went offline");
    });

    mqttClient.on("connect", () => {
      setBridgeStatus({ connected: true, lastError: null, mappingCount: cloudBridgeState.mappings.length });
      appendBridgeLog({ level: "info", message: "broker connected" });
      addLog("info", "[CLOUD-BRIDGE] broker connected");

      for (const m of cloudBridgeState.mappings) {
        if (m.direction !== "publish") {
          const topic = renderTopic(m);
          mqttClient?.subscribe(topic, { qos: m.qos }, (err) => {
            if (err) {
              appendBridgeLog({
                level: "error",
                message: `subscribe failed topic=${topic} err=${err.message}`,
              });
              addLog("error", `[CLOUD-BRIDGE] subscribe failed topic=${topic} err=${err.message}`);
            } else {
              appendBridgeLog({
                level: "info",
                message: `subscribed topic=${topic} qos=${m.qos}`,
              });
              addLog("info", `[CLOUD-BRIDGE] subscribed topic=${topic} qos=${m.qos}`);
            }
          });
        }
      }
    });

    mqttClient.on("message", (topic, message) => {
      void handleIncomingMessage(topic, message);
    });

    mqttClient.on("close", () => {
      const wasConnected = cloudBridgeState.status.connected;
      if (wasConnected) {
        setBridgeStatus({ connected: false });
        appendBridgeLog({ level: "warn", message: "broker disconnected" });
        addLog("warn", "[CLOUD-BRIDGE] broker disconnected");
      }
    });

    mqttClient.on("error", (err) => {
      const msg = err.message || String(err);
      setBridgeStatus({ lastError: msg });
      appendBridgeLog({ level: "error", message: `broker error: ${msg}` });
      addLog("error", `[CLOUD-BRIDGE] broker error: ${msg}`);
    });

    for (const m of cloudBridgeState.mappings) {
      if (m.direction !== "subscribe") {
        startPublishing(m);
      }
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setBridgeStatus({ running: false, connected: false, lastError: msg });
    appendBridgeLog({ level: "error", message: `connection failed: ${msg}` });
    addLog("error", `[CLOUD-BRIDGE] connection failed: ${msg}`);
  }
}

export function stopCloudBridge(): void {
  if (!cloudBridgeState.status.running) return;

  for (const id of Object.keys(publishTimers)) {
    clearInterval(publishTimers[id]);
  }
  publishTimers = {};

  if (mqttClient) {
    mqttClient.end(true);
    mqttClient = null;
  }

  setBridgeStatus({ running: false, connected: false, lastError: null, brokerHost: null });
  appendBridgeLog({ level: "info", message: "broker stopped" });
  addLog("info", "[CLOUD-BRIDGE] broker stopped");
}
