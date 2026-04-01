export type ConnectionStatus = "disconnected" | "connecting" | "reconnecting" | "connected";
export type ModbusProtocol = "tcp" | "serial-rtu" | "serial-ascii";
export type SerialParity = "none" | "even" | "odd";
export type RetryBackoffStrategy = "fixed" | "linear" | "exponential";
export type RetryJitterStrategy = "none" | "full" | "equal";

export interface TcpSettings {
  host: string;
  port: number;
  connectionTimeoutMs: number;
  responseTimeoutMs: number;
  retryAttempts: number;
  retryBackoffStrategy: RetryBackoffStrategy;
  retryJitterStrategy: RetryJitterStrategy;
}

export interface SerialSettings {
  port: string;
  baudRate: number;
  dataBits: 5 | 6 | 7 | 8;
  stopBits: 1 | 2;
  parity: SerialParity;
}

export interface ConnectionConfig {
  status: ConnectionStatus;
  protocol: ModbusProtocol;
  backendStatus: string;
  backendDetails: string;
  slaveId: number;
  tcp: TcpSettings;
  serial: SerialSettings;
}

export const connectionState = $state<ConnectionConfig>({
  status: "disconnected",
  protocol: "tcp",
  backendStatus: "disconnected",
  backendDetails: "",
  slaveId: 1,
  tcp: {
    host: "192.168.55.200",
    port: 502,
    connectionTimeoutMs: 2000,
    responseTimeoutMs: 2000,
    retryAttempts: 2,
    retryBackoffStrategy: "fixed",
    retryJitterStrategy: "none",
  },
  serial: {
    port: "/dev/ttyUSB0",
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
  },
});

export function setConnectionStatus(status: ConnectionStatus): void {
  connectionState.status = status;
}

export function applyBackendConnectionStatus(status: string, details?: string): void {
  connectionState.backendStatus = status;
  connectionState.backendDetails = details ?? "";

  const normalized = status.toLowerCase();
  if (normalized === "connecting") {
    connectionState.status = "connecting";
    return;
  }

  if (normalized === "reconnecting") {
    connectionState.status = "reconnecting";
    return;
  }

  if (normalized.startsWith("connected")) {
    connectionState.status = "connected";
    return;
  }

  connectionState.status = "disconnected";
}

export function setProtocol(protocol: ModbusProtocol): void {
  connectionState.protocol = protocol;
}

export function setSlaveId(slaveId: number): void {
  connectionState.slaveId = Math.max(1, Math.min(247, slaveId));
}

export function updateTcpSettings(updates: Partial<TcpSettings>): void {
  const next: TcpSettings = { ...connectionState.tcp, ...updates };

  next.port = clampInteger(next.port, 1, 65535);
  next.connectionTimeoutMs = clampInteger(next.connectionTimeoutMs, 100, 600000);
  next.responseTimeoutMs = clampInteger(next.responseTimeoutMs, 100, 600000);
  next.retryAttempts = clampInteger(next.retryAttempts, 0, 10);

  connectionState.tcp = next;
}

export function updateSerialSettings(updates: Partial<SerialSettings>): void {
  connectionState.serial = { ...connectionState.serial, ...updates };
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}
