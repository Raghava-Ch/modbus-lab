import { request_serial_port, WasmSerialModbusClient, WasmModbusClient, WasmTcpTransport, WasmSerialTransport } from "modbus-rs-wasm";
import type {
  IModbusAdapter,
  CommandAck,
  SerialConnectRequest,
  WebSocketConnectRequest,
  BackendReadCoilsResponse,
  BackendReadDiscreteInputsResponse,
  BackendReadHoldingRegistersResponse,
  BackendReadInputRegistersResponse,
  BackendWriteCoilResponse,
  BackendWriteHoldingRegisterResponse,
  BackendWriteMassCoilsResponse,
  BackendWriteMassHoldingRegistersResponse,
} from "./IModbusAdapter";
import { addLog } from "../../state/logs.svelte";

function unpackBooleans(packed: Uint8Array, quantity: number): boolean[] {
  const result: boolean[] = [];
  for (let i = 0; i < quantity; i++) {
    const byteIndex = Math.floor(i / 8);
    const bitIndex = i % 8;
    result.push(((packed[byteIndex] >> bitIndex) & 1) === 1);
  }
  return result;
}

function packBooleans(values: boolean[]): Uint8Array {
  const byteLength = Math.ceil(values.length / 8);
  const packed = new Uint8Array(byteLength);
  for (let i = 0; i < values.length; i++) {
    if (values[i]) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = i % 8;
      packed[byteIndex] |= (1 << bitIndex);
    }
  }
  return packed;
}

export class WebModbusAdapter implements IModbusAdapter {
  private client: WasmSerialModbusClient | WasmModbusClient | null = null;
  private transport: WasmSerialTransport | WasmTcpTransport | null = null;

  public async connectTcp(request: WebSocketConnectRequest): Promise<CommandAck> {

    addLog("info", `Connecting to WebSocket Modbus gateway at ${request.wsUrl}...`);

    try {
      const tick = 20;
      this.transport = new WasmTcpTransport(request.wsUrl, {
        responseTimeoutMs: request.responseTimeoutMs ?? 2000,
        retryAttempts: 2,
        tickIntervalMs: tick
      });
      this.client = this.transport.createClient({ unitId: request.slaveId });

      // Wait up to 2.5 seconds to establish connection
      const start = Date.now();
      const timeout = 2500;
      while (Date.now() - start < timeout) {
        if (this.client.is_connected()) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      if (!this.client.is_connected()) {
        throw new Error("Connection timed out. WebSocket proxy might be offline or unreachable.");
      }

      addLog("info", `Connected to WebSocket Modbus gateway.`);
      return {
        ok: true,
        message: "Connected to TCP gateway.",
        status: {
          status: "connectedTcp",
          details: `WebSocket Gateway (${request.wsUrl})`
        }
      };
    } catch (err) {
      if (this.client) {
        try {
          if (typeof (this.client as any).free === "function") {
            (this.client as any).free();
          }
        } catch {}
        this.client = null;
      }
      if (this.transport) {
        try {
          if (typeof (this.transport as any).close === "function") {
            (this.transport as any).close();
          }
          if (typeof (this.transport as any).free === "function") {
            (this.transport as any).free();
          }
        } catch {}
        this.transport = null;
      }
      addLog("error", `Failed to connect to TCP gateway: ${String(err)}`);
      return Promise.reject({
        code: "TCP_CONNECT_ERROR",
        message: "Failed to connect to Modbus TCP gateway via WebSocket.",
        details: String(err)
      });
    }
  }

  public async connectSerial(request: SerialConnectRequest): Promise<CommandAck> {

    addLog("info", `Connecting to Serial port using Web Serial...`);

    try {
      const portHandle = await request_serial_port();
      if (!portHandle.is_valid()) {
        throw new Error("Invalid serial port handle returned.");
      }

      const tick = 20; 
      
      this.transport = new WasmSerialTransport(portHandle, {
        mode: request.mode,
        baudRate: request.baudRate,
        dataBits: request.dataBits as 5 | 6 | 7 | 8,
        stopBits: request.stopBits as 1 | 2,
        parity: request.parity as "none" | "even" | "odd",
        responseTimeoutMs: request.timeoutMs ?? 3000,
        retryAttempts: request.retries ?? 1,
        tickIntervalMs: tick
      });
      this.client = this.transport.createClient({ unitId: request.slaveId });

      // Wait up to 1 second to ensure connection is established
      const start = Date.now();
      const timeout = 1000;
      while (Date.now() - start < timeout) {
        if (this.client.is_connected()) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      if (!this.client.is_connected()) {
        throw new Error("Web Serial port opened but client failed to establish connection.");
      }

      addLog("info", `Connected to Serial port.`);
      return {
        ok: true,
        message: "Connected to Serial port.",
        status: {
          status: request.mode === "rtu" ? "connectedSerialRtu" : "connectedSerialAscii",
          details: `Web Serial (${request.baudRate} ${request.parity.charAt(0).toUpperCase()}${request.dataBits}${request.stopBits})`
        }
      };
    } catch (err) {
      if (this.client) {
        try {
          if (typeof (this.client as any).free === "function") {
            (this.client as any).free();
          }
        } catch {}
        this.client = null;
      }
      if (this.transport) {
        try {
          if (typeof (this.transport as any).close === "function") {
            (this.transport as any).close();
          }
          if (typeof (this.transport as any).free === "function") {
            (this.transport as any).free();
          }
        } catch {}
        this.transport = null;
      }
      addLog("error", `Failed to connect to Serial port: ${String(err)}`);
      return Promise.reject({
        code: "SERIAL_CONNECT_ERROR",
        message: "Failed to connect to Serial port.",
        details: String(err)
      });
    }
  }

  public async disconnect(): Promise<CommandAck> {
    if (this.client) {
      try {
        if (typeof (this.client as any).free === "function") {
          (this.client as any).free();
        }
      } catch (e) {
        console.warn("Failed to free wasm client", e);
      }
      this.client = null;
    }

    if (this.transport) {
      try {
        if (typeof (this.transport as any).close === "function") {
          (this.transport as any).close();
        }
        if (typeof (this.transport as any).free === "function") {
          (this.transport as any).free();
        }
      } catch (e) {
        console.warn("Failed to close/free wasm transport", e);
      }
      this.transport = null;
    }

    addLog("info", "Disconnected from Modbus server/device.");
    return {
      ok: true,
      message: "Disconnected",
      status: {
        status: "disconnected"
      }
    };
  }

  public isConnected(): boolean {
    if (!this.client) return false;
    try {
      return this.client.is_connected();
    } catch (e) {
      return false;
    }
  }

  // Phase 2 I/O methods
  public async readCoils(startAddress: number, quantity: number): Promise<BackendReadCoilsResponse> {
    if (!this.client) throw new Error("Not connected");
    const packed = await this.client.read_coils(startAddress, quantity);
    const unpacked = unpackBooleans(packed, quantity);
    const coils = unpacked.map((val, i) => ({
      address: startAddress + i,
      value: val
    }));
    return {
      coils,
      startAddress,
      quantity
    };
  }

  public async writeCoil(address: number, value: boolean): Promise<BackendWriteCoilResponse> {
    if (!this.client) throw new Error("Not connected");
    const res = await this.client.write_single_coil(address, value);
    return {
      address: res.address ?? address,
      value: res.value ?? value
    };
  }

  public async writeCoilsBatch(coils: Array<{ address: number; value: boolean }>): Promise<BackendWriteMassCoilsResponse> {
    if (!this.client) throw new Error("Not connected");
    const sorted = [...coils].sort((a, b) => a.address - b.address);
    let writtenCount = 0;
    const failures: Array<{ address: number; code: string; message: string }> = [];

    // Group into contiguous sections
    const sections: Array<{ startAddress: number; values: boolean[] }> = [];
    if (sorted.length > 0) {
      let currentSection = { startAddress: sorted[0].address, values: [sorted[0].value] };
      for (let i = 1; i < sorted.length; i++) {
        const coil = sorted[i];
        const lastAddress = currentSection.startAddress + currentSection.values.length - 1;
        if (coil.address === lastAddress + 1) {
          currentSection.values.push(coil.value);
        } else {
          sections.push(currentSection);
          currentSection = { startAddress: coil.address, values: [coil.value] };
        }
      }
      sections.push(currentSection);
    }

    // Write each section
    for (const section of sections) {
      try {
        if (section.values.length === 1) {
          await this.client.write_single_coil(section.startAddress, section.values[0]);
          writtenCount += 1;
        } else {
          const packed = packBooleans(section.values);
          await this.client.write_multiple_coils(
            section.startAddress,
            section.values.length,
            packed
          );
          writtenCount += section.values.length;
        }
      } catch (err) {
        const msg = String(err);
        for (let j = 0; j < section.values.length; j++) {
          failures.push({
            address: section.startAddress + j,
            code: "WRITE_ERROR",
            message: msg
          });
        }
      }
    }

    return {
      writtenCount,
      totalCount: coils.length,
      failures
    };
  }

  public async readDiscreteInputs(startAddress: number, quantity: number): Promise<BackendReadDiscreteInputsResponse> {
    if (!this.client) throw new Error("Not connected");
    const packed = await this.client.read_discrete_inputs(startAddress, quantity);
    const unpacked = unpackBooleans(packed, quantity);
    const inputs = unpacked.map((val, i) => ({
      address: startAddress + i,
      value: val
    }));
    return {
      inputs,
      startAddress,
      quantity
    };
  }

  public async readHoldingRegisters(startAddress: number, quantity: number): Promise<BackendReadHoldingRegistersResponse> {
    if (!this.client) throw new Error("Not connected");
    const values = await this.client.read_holding_registers(startAddress, quantity);
    const registers: Array<{ address: number; value: number }> = [];
    for (let i = 0; i < values.length; i++) {
      registers.push({
        address: startAddress + i,
        value: values[i]
      });
    }
    return {
      registers,
      startAddress,
      quantity
    };
  }

  public async writeHoldingRegister(address: number, value: number): Promise<BackendWriteHoldingRegisterResponse> {
    if (!this.client) throw new Error("Not connected");
    const res = await this.client.write_single_register(address, value);
    return {
      address: res.address ?? address,
      value: res.value ?? value
    };
  }

  public async writeHoldingRegistersBatch(registers: Array<{ address: number; value: number }>): Promise<BackendWriteMassHoldingRegistersResponse> {
    if (!this.client) throw new Error("Not connected");
    const sorted = [...registers].sort((a, b) => a.address - b.address);
    let writtenCount = 0;
    const failures: Array<{ address: number; code: string; message: string }> = [];

    // Group into contiguous sections
    const sections: Array<{ startAddress: number; values: number[] }> = [];
    if (sorted.length > 0) {
      let currentSection = { startAddress: sorted[0].address, values: [sorted[0].value] };
      for (let i = 1; i < sorted.length; i++) {
        const reg = sorted[i];
        const lastAddress = currentSection.startAddress + currentSection.values.length - 1;
        if (reg.address === lastAddress + 1) {
          currentSection.values.push(reg.value);
        } else {
          sections.push(currentSection);
          currentSection = { startAddress: reg.address, values: [reg.value] };
        }
      }
      sections.push(currentSection);
    }

    // Write each section
    for (const section of sections) {
      try {
        if (section.values.length === 1) {
          await this.client.write_single_register(section.startAddress, section.values[0]);
          writtenCount += 1;
        } else {
          await this.client.write_multiple_registers(
            section.startAddress,
            section.values.length,
            new Uint16Array(section.values)
          );
          writtenCount += section.values.length;
        }
      } catch (err) {
        const msg = String(err);
        for (let j = 0; j < section.values.length; j++) {
          failures.push({
            address: section.startAddress + j,
            code: "WRITE_ERROR",
            message: msg
          });
        }
      }
    }

    return {
      writtenCount,
      totalCount: registers.length,
      failures
    };
  }

  public async readInputRegisters(startAddress: number, quantity: number): Promise<BackendReadInputRegistersResponse> {
    if (!this.client) throw new Error("Not connected");
    const values = await this.client.read_input_registers(startAddress, quantity);
    const registers: Array<{ address: number; value: number }> = [];
    for (let i = 0; i < values.length; i++) {
      registers.push({
        address: startAddress + i,
        value: values[i]
      });
    }
    return {
      registers,
      startAddress,
      quantity
    };
  }

  public async readFifoQueue(address: number): Promise<Uint16Array> {
    if (!this.client) throw new Error("Not connected");
    return await this.client.read_fifo_queue(address);
  }
}

export const modbusAdapter = new WebModbusAdapter();
