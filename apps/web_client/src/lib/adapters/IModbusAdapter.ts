export interface CommandAck {
  ok: boolean;
  message: string;
  status: {
    status: string;
    details?: string;
  };
}

export interface SerialConnectRequest {
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: string; // "none" | "even" | "odd"
  slaveId: number;
  timeoutMs?: number;
  retries?: number;
  mode: "rtu" | "ascii";
}

export interface WebSocketConnectRequest {
  wsUrl: string;
  slaveId: number;
  responseTimeoutMs?: number;
}

export interface BackendReadCoilsResponse {
  coils: Array<{ address: number; value: boolean }>;
  startAddress: number;
  quantity: number;
}

export interface BackendReadDiscreteInputsResponse {
  inputs: Array<{ address: number; value: boolean }>;
  startAddress: number;
  quantity: number;
}

export interface BackendReadHoldingRegistersResponse {
  registers: Array<{ address: number; value: number }>;
  startAddress: number;
  quantity: number;
}

export interface BackendReadInputRegistersResponse {
  registers: Array<{ address: number; value: number }>;
  startAddress: number;
  quantity: number;
}

export interface BackendWriteCoilResponse {
  address: number;
  value: boolean;
}

export interface BackendWriteHoldingRegisterResponse {
  address: number;
  value: number;
}

export interface BackendWriteMassCoilsResponse {
  writtenCount: number;
  totalCount: number;
  failures: Array<{ address: number; code: string; message: string }>;
}

export interface BackendWriteMassHoldingRegistersResponse {
  writtenCount: number;
  totalCount: number;
  failures: Array<{ address: number; code: string; message: string }>;
}

export interface IModbusAdapter {
  /** Connect to a Modbus TCP server via WebSocket proxy */
  connectTcp(request: WebSocketConnectRequest): Promise<CommandAck>;
  
  /** Connect to a Modbus Serial device (RTU/ASCII) */
  connectSerial(request: SerialConnectRequest): Promise<CommandAck>;
  
  /** Disconnect the current connection */
  disconnect(): Promise<CommandAck>;
  
  /** Check if the adapter is currently connected */
  isConnected(): boolean;

  // Phase 2 I/O methods
  readCoils(startAddress: number, quantity: number): Promise<BackendReadCoilsResponse>;
  writeCoil(address: number, value: boolean): Promise<BackendWriteCoilResponse>;
  writeCoilsBatch(coils: Array<{ address: number; value: boolean }>): Promise<BackendWriteMassCoilsResponse>;
  readDiscreteInputs(startAddress: number, quantity: number): Promise<BackendReadDiscreteInputsResponse>;
  readHoldingRegisters(startAddress: number, quantity: number): Promise<BackendReadHoldingRegistersResponse>;
  writeHoldingRegister(address: number, value: number): Promise<BackendWriteHoldingRegisterResponse>;
  writeHoldingRegistersBatch(registers: Array<{ address: number; value: number }>): Promise<BackendWriteMassHoldingRegistersResponse>;
  readInputRegisters(startAddress: number, quantity: number): Promise<BackendReadInputRegistersResponse>;
  readFifoQueue(address: number): Promise<Uint16Array>;
}
