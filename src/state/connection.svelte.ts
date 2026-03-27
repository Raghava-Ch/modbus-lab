export type ConnectionStatus = "disconnected" | "connecting" | "connected";
export type ModbusProtocol = "tcp" | "serial-rtu" | "serial-ascii";
export type SerialParity = "none" | "even" | "odd";

export interface TcpSettings {
  host: string;
  port: number;
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
  slaveId: number;
  tcp: TcpSettings;
  serial: SerialSettings;
}

export const connectionState = $state<ConnectionConfig>({
  status: "disconnected",
  protocol: "tcp",
  slaveId: 1,
  tcp: {
    host: "192.168.1.20",
    port: 502,
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

export function setProtocol(protocol: ModbusProtocol): void {
  connectionState.protocol = protocol;
}

export function setSlaveId(slaveId: number): void {
  connectionState.slaveId = Math.max(1, Math.min(247, slaveId));
}

export function updateTcpSettings(updates: Partial<TcpSettings>): void {
  connectionState.tcp = { ...connectionState.tcp, ...updates };
}

export function updateSerialSettings(updates: Partial<SerialSettings>): void {
  connectionState.serial = { ...connectionState.serial, ...updates };
}
