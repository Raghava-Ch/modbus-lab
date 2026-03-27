export type ConnectionStatus = "disconnected" | "connecting" | "connected";

export const connectionState = $state({
  status: "disconnected" as ConnectionStatus,
  protocol: "Modbus TCP",
  address: "192.168.1.20",
  port: 502,
  slaveId: 1,
});

export function setConnectionStatus(status: ConnectionStatus): void {
  connectionState.status = status;
}
