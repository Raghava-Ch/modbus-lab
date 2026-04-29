export type ConnectionStatus = "disconnected" | "connecting" | "reconnecting" | "connected";
export type ListenerStatus = "idle" | "starting" | "running" | "error";
export type ModbusProtocol = "tcp" | "serial-rtu" | "serial-ascii";
export type SerialParity = "none" | "even" | "odd";

export interface TcpSettings {
  host: string;
  port: number;
  responseTimeoutMs: number;
}

export interface SerialSettings {
  port: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: SerialParity;
}

export interface ListenerRuntime {
  activeClients: number;
  uptimeMs: number;
  lastError: string;
  startedAtMs: number | null;
}

export interface ListenerClientSession {
  id: string;
  endpoint: string;
  connectedAtMs: number;
}

export interface ConnectionConfig {
  // Compatibility status used by existing region pages.
  status: ConnectionStatus;
  // Listener lifecycle status used by new server UX.
  listenerStatus: ListenerStatus;
  protocol: ModbusProtocol;
  backendStatus: string;
  backendDetails: string;
  slaveId: number;
  tcp: TcpSettings;
  serial: SerialSettings;
  runtime: ListenerRuntime;
  sessions: ListenerClientSession[];
}

export const connectionState = $state<ConnectionConfig>({
  status: "disconnected",
  listenerStatus: "idle",
  protocol: "tcp",
  backendStatus: "disconnected",
  backendDetails: "",
  slaveId: 1,
  tcp: {
    host: "0.0.0.0",
    port: 502,
    responseTimeoutMs: 2000,
  },
  serial: {
    port: "",
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
  },
  runtime: {
    activeClients: 0,
    uptimeMs: 0,
    lastError: "",
    startedAtMs: null,
  },
  sessions: [],
});

export function setConnectionStatus(status: ConnectionStatus): void {
  connectionState.status = status;
  if (status === "connected") {
    connectionState.listenerStatus = "running";
    if (!connectionState.runtime.startedAtMs) {
      connectionState.runtime.startedAtMs = Date.now();
    }
    return;
  }

  if (status === "connecting") {
    connectionState.listenerStatus = "starting";
    return;
  }

  if (status === "reconnecting") {
    connectionState.listenerStatus = "error";
    return;
  }

  connectionState.listenerStatus = "idle";
  connectionState.runtime.startedAtMs = null;
  connectionState.runtime.uptimeMs = 0;
}

export function applyBackendConnectionStatus(status: string, details?: string): void {
  connectionState.backendStatus = status;
  connectionState.backendDetails = details ?? "";

  const normalized = status.toLowerCase();
  if (normalized === "starting" || normalized === "connecting") {
    setConnectionStatus("connecting");
    return;
  }

  if (normalized === "error" || normalized === "reconnecting") {
    connectionState.status = "reconnecting";
    connectionState.listenerStatus = "error";
    connectionState.runtime.lastError = details ?? "Listener error";
    return;
  }

  if (normalized === "running" || normalized.startsWith("connected")) {
    setConnectionStatus("connected");
    connectionState.runtime.lastError = "";
    return;
  }

  setConnectionStatus("disconnected");
}

export function setProtocol(protocol: ModbusProtocol): void {
  connectionState.protocol = protocol;
}

export function setSlaveId(slaveId: number): void {
  connectionState.slaveId = clampInteger(slaveId, 1, 247);
}

export function updateTcpSettings(updates: Partial<TcpSettings>): void {
  const next: TcpSettings = { ...connectionState.tcp, ...updates };
  next.port = clampInteger(next.port, 1, 65535);
  next.responseTimeoutMs = clampInteger(next.responseTimeoutMs, 100, 600000);
  connectionState.tcp = next;
}

export function updateSerialSettings(updates: Partial<SerialSettings>): void {
  const next: SerialSettings = { ...connectionState.serial, ...updates };
  next.baudRate = clampInteger(next.baudRate, 1200, 921600);
  next.dataBits = clampInteger(next.dataBits, 5, 8) as 5 | 6 | 7 | 8;
  next.stopBits = clampInteger(next.stopBits, 1, 2) as 1 | 2;
  connectionState.serial = next;
}

export function setListenerClients(sessions: ListenerClientSession[]): void {
  connectionState.sessions = sessions;
  connectionState.runtime.activeClients = sessions.length;
}

export function setListenerUptime(uptimeMs: number): void {
  connectionState.runtime.uptimeMs = Math.max(0, Math.round(uptimeMs));
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}
