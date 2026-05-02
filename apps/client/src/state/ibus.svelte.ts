import { invoke } from "@tauri-apps/api/core";
import { connectionState } from "./connection.svelte";
import { addExclusiveCoil, coilState } from "./coils.svelte";
import { addExclusiveDiscreteInput, discreteInputState } from "./discrete-inputs.svelte";
import { addExclusiveHoldingRegister, holdingRegisterState } from "./holding-registers.svelte";
import { addExclusiveInputRegister, inputRegisterState } from "./input-registers.svelte";

export type IbusBlockType = "HoldingRegister" | "InputRegister" | "Coil" | "DiscreteInput";
export type IbusDataType =
  | "Int16"
  | "UInt16"
  | "Int32"
  | "UInt32"
  | "Float32"
  | "Ascii"
  | "Bool"
  | "Int64"
  | "Float64";

export interface IbusIdentity {
  deviceName: string;
  vendor: string;
  model: string;
  firmware: string;
}

export interface IbusManifestEntry {
  blockType: IbusBlockType;
  startAddress: number;
  length: number;
  name: string;
}

export interface IbusPointDesc {
  address: number;
  blockType: IbusBlockType;
  dataType: IbusDataType;
  scaleNum: number;
  scaleDen: number;
  unitCode: number;
  flags: number;
  name: string;
  description: string;
}

export interface IbusDescriptor {
  identity: IbusIdentity;
  manifest: IbusManifestEntry[];
  points: IbusPointDesc[];
  manifestAddr: number;
}

export interface IbusConstants {
  signatureWord: number;
  versionWord: number;
  regionStart: number;
  regionEnd: number;
  manifestBaseMin: number;
  manifestEntryRegs: number;
  pointDescRegs: number;
  identityRegs: number;
}

export interface ConformanceFinding {
  id: string;
  level: "Pass" | "Fail" | "Warn";
  title: string;
  message: string;
}

export type EngineeringValue =
  | { Number: { value: number; raw: number } }
  | { Bool: boolean }
  | { Text: string };

export interface PointReading {
  point: IbusPointDesc;
  value: EngineeringValue | null;
  error: string | null;
}

interface IbusClientState {
  descriptor: IbusDescriptor | null;
  signature: number | null;
  version: number | null;
  conformance: ConformanceFinding[];
  readings: PointReading[];
  busy: boolean;
  lastError: string | null;
  lastProbedAt: number | null;
}

export const ibusState = $state<IbusClientState>({
  descriptor: null,
  signature: null,
  version: null,
  conformance: [],
  readings: [],
  busy: false,
  lastError: null,
  lastProbedAt: null,
});

interface BackendReadHoldingRegistersResponse {
  registers: Array<{ address: number; value: number }>;
}

interface BackendReadInputRegistersResponse {
  registers: Array<{ address: number; value: number }>;
}

interface BackendReadCoilsResponse {
  coils: Array<{ address: number; value: boolean }>;
}

interface BackendReadDiscreteInputsResponse {
  inputs: Array<{ address: number; value: boolean }>;
}

const MAX_REGS_PER_READ = 125;

function parseInvokeError(err: unknown): string {
  if (typeof err === "string") {
    try {
      const parsed = JSON.parse(err) as { message?: string; details?: string };
      if (typeof parsed.details === "string" && parsed.details.trim().length > 0) {
        return `${parsed.message ?? "Unknown error"} (${parsed.details})`;
      }
      return parsed.message ?? err;
    } catch {
      return err;
    }
  }

  if (typeof err === "object" && err !== null) {
    const maybe = err as { message?: unknown; details?: unknown; error?: unknown };
    if (typeof maybe.details === "string" && maybe.details.trim().length > 0) {
      return `${String(maybe.message ?? "Unknown error")} (${maybe.details})`;
    }
    if (typeof maybe.message === "string" && maybe.message.trim().length > 0) {
      return maybe.message;
    }
    if (typeof maybe.error === "string" && maybe.error.trim().length > 0) {
      return maybe.error;
    }
  }

  return "Unknown error";
}

async function readHr(start: number, qty: number): Promise<number[]> {
  if (qty <= 0) return [];

  const values: number[] = [];
  let offset = 0;

  while (offset < qty) {
    const chunkQty = Math.min(MAX_REGS_PER_READ, qty - offset);
    const resp = await invoke<BackendReadHoldingRegistersResponse>("read_holding_registers", {
      request: { startAddress: start + offset, quantity: chunkQty },
    });
    // Sort by address to be safe.
    const sorted = [...resp.registers].sort((a, b) => a.address - b.address);
    values.push(...sorted.map((r) => r.value));
    offset += chunkQty;
  }

  return values;
}

async function readIr(start: number, qty: number): Promise<number[]> {
  if (qty <= 0) return [];

  const values: number[] = [];
  let offset = 0;

  while (offset < qty) {
    const chunkQty = Math.min(MAX_REGS_PER_READ, qty - offset);
    const resp = await invoke<BackendReadInputRegistersResponse>("read_input_registers", {
      request: { startAddress: start + offset, quantity: chunkQty },
    });
    const sorted = [...resp.registers].sort((a, b) => a.address - b.address);
    values.push(...sorted.map((r) => r.value));
    offset += chunkQty;
  }

  return values;
}

async function readCoil(addr: number): Promise<boolean> {
  const resp = await invoke<BackendReadCoilsResponse>("read_coils", {
    request: { startAddress: addr, quantity: 1 },
  });
  return resp.coils[0]?.value ?? false;
}

async function readDi(addr: number): Promise<boolean> {
  const resp = await invoke<BackendReadDiscreteInputsResponse>("read_discrete_inputs", {
    request: { startAddress: addr, quantity: 1 },
  });
  return resp.inputs[0]?.value ?? false;
}

function pointWordCount(point: IbusPointDesc): number {
  switch (point.dataType) {
    case "Int16":
    case "UInt16":
      return 1;
    case "Int32":
    case "UInt32":
    case "Float32":
      return 2;
    case "Int64":
    case "Float64":
      return 4;
    case "Ascii":
      return Math.max(1, Math.floor((point.scaleNum + 1) / 2));
    case "Bool":
      return 1;
  }
}

function inRange(addr: number, start: number, end: number): boolean {
  return addr >= start && addr <= end;
}

function verifyUnusedRegionReadsZero(
  regionStart: number,
  regionWords: number[],
  manifestAddr: number,
  manifestRegs: number,
  pointAddr: number,
  pointRegs: number,
): boolean {
  const identityStart = 9000;
  const identityEnd = 9039;
  const manifestStart = manifestAddr;
  const manifestEnd = manifestRegs > 0 ? manifestAddr + manifestRegs - 1 : manifestAddr - 1;
  const pointStart = pointAddr;
  const pointEnd = pointRegs > 0 ? pointAddr + pointRegs - 1 : pointAddr - 1;

  for (let i = 0; i < regionWords.length; i += 1) {
    const addr = regionStart + i;
    const used =
      inRange(addr, identityStart, identityEnd)
      || (manifestRegs > 0 && inRange(addr, manifestStart, manifestEnd))
      || (pointRegs > 0 && inRange(addr, pointStart, pointEnd));

    if (!used && (regionWords[i] ?? 0) !== 0) {
      return false;
    }
  }

  return true;
}

export async function probeDevice(): Promise<void> {
  if (connectionState.status !== "connected") {
    ibusState.lastError = "Not connected.";
    return;
  }
  ibusState.busy = true;
  ibusState.lastError = null;
  try {
    const constants = await invoke<IbusConstants>("ibus_constants");

    // 1. Identity block: HR 9000..9039
    const identityWords = await readHr(constants.regionStart, constants.identityRegs);
    ibusState.signature = identityWords[0] ?? null;
    ibusState.version = identityWords[1] ?? null;

    interface IdentityHeader {
      pointCount: number;
      manifestCount: number;
      manifestAddr: number;
      pointAddr: number;
    }

    const identityResult = await invoke<{ identity: IbusIdentity; header: IdentityHeader }>(
      "ibus_parse_identity",
      { request: { words: identityWords } },
    );

    // 2. Manifest table
    const manifestRegs = identityResult.header.manifestCount * constants.manifestEntryRegs;
    const manifestWords = manifestRegs > 0
      ? await readHr(identityResult.header.manifestAddr, manifestRegs)
      : [];
    const manifest = manifestRegs > 0
      ? await invoke<IbusManifestEntry[]>("ibus_parse_manifest", {
          request: { words: manifestWords, count: identityResult.header.manifestCount },
        })
      : [];

    // 3. Point descriptors
    const pointRegs = identityResult.header.pointCount * constants.pointDescRegs;
    const pointWords = pointRegs > 0
      ? await readHr(identityResult.header.pointAddr, pointRegs)
      : [];
    const points = pointRegs > 0
      ? await invoke<IbusPointDesc[]>("ibus_parse_points", {
          request: { words: pointWords, count: identityResult.header.pointCount },
        })
      : [];

    const descriptor: IbusDescriptor = {
      identity: identityResult.identity,
      manifest,
      points,
      manifestAddr: identityResult.header.manifestAddr,
    };
    ibusState.descriptor = descriptor;
    ibusState.lastProbedAt = Date.now();

    // 4. Optional conformance probe: verify unused HR in 9000..9999 read as 0.
    const regionQty = constants.regionEnd - constants.regionStart + 1;
    const regionWords = await readHr(constants.regionStart, regionQty);
    const unusedRangeReadsZero = verifyUnusedRegionReadsZero(
      constants.regionStart,
      regionWords,
      identityResult.header.manifestAddr,
      manifestRegs,
      identityResult.header.pointAddr,
      pointRegs,
    );

    // 5. Conformance
    const findings = await invoke<ConformanceFinding[]>("ibus_run_conformance", {
      request: {
        signature: ibusState.signature ?? 0,
        version: ibusState.version ?? 0,
        descriptor,
        unusedRangeReadsZero,
      },
    });
    ibusState.conformance = findings;

    ibusState.readings = points.map((p) => ({ point: p, value: null, error: null }));
  } catch (err) {
    ibusState.lastError = parseInvokeError(err);
  } finally {
    ibusState.busy = false;
  }
}

export async function readAllPoints(): Promise<void> {
  if (!ibusState.descriptor) return;
  if (connectionState.status !== "connected") {
    ibusState.lastError = "Not connected.";
    return;
  }
  ibusState.busy = true;
  ibusState.lastError = null;
  try {
    const next: PointReading[] = [];
    for (const point of ibusState.descriptor.points) {
      try {
        let value: EngineeringValue;
        if (point.blockType === "Coil") {
          const b = await readCoil(point.address);
          value = { Bool: b };
        } else if (point.blockType === "DiscreteInput") {
          const b = await readDi(point.address);
          value = { Bool: b };
        } else {
          const wc = pointWordCount(point);
          const words =
            point.blockType === "HoldingRegister"
              ? await readHr(point.address, wc)
              : await readIr(point.address, wc);
          value = await invoke<EngineeringValue>("ibus_decode_point", {
            request: {
              dataType: dataTypeToU16(point.dataType),
              scaleNum: point.scaleNum,
              scaleDen: point.scaleDen,
              words,
            },
          });
        }
        next.push({ point, value, error: null });
      } catch (err) {
        next.push({ point, value: null, error: parseInvokeError(err) });
      }
    }
    ibusState.readings = next;
  } catch (err) {
    ibusState.lastError = parseInvokeError(err);
  } finally {
    ibusState.busy = false;
  }
}

function dataTypeToU16(dt: IbusDataType): number {
  switch (dt) {
    case "Int16":
      return 1;
    case "UInt16":
      return 2;
    case "Int32":
      return 3;
    case "UInt32":
      return 4;
    case "Float32":
      return 5;
    case "Ascii":
      return 6;
    case "Bool":
      return 7;
    case "Int64":
      return 8;
    case "Float64":
      return 9;
  }
}

export function clearIbusState(): void {
  ibusState.descriptor = null;
  ibusState.signature = null;
  ibusState.version = null;
  ibusState.conformance = [];
  ibusState.readings = [];
  ibusState.lastError = null;
  ibusState.lastProbedAt = null;
}

/**
 * Populate the client's register pages from the currently probed iBus descriptor.
 * Existing entries at the same address are left unchanged (label is only set when
 * the entry has no label yet). Returns the number of new entries added.
 */
export function applyDescriptorToRegisters(): number {
  if (!ibusState.descriptor) return 0;
  let added = 0;

  for (const point of ibusState.descriptor.points) {
    const label = point.name || String(point.address);

    if (point.blockType === "HoldingRegister") {
      if (addExclusiveHoldingRegister(point.address)) {
        const e = holdingRegisterState.entries.find((x) => x.address === point.address);
        if (e && !e.label) e.label = label;
        added++;
      }
    } else if (point.blockType === "InputRegister") {
      if (addExclusiveInputRegister(point.address)) {
        const e = inputRegisterState.entries.find((x) => x.address === point.address);
        if (e && !e.label) e.label = label;
        added++;
      }
    } else if (point.blockType === "Coil") {
      if (addExclusiveCoil(point.address)) {
        const e = coilState.entries.find((x) => x.address === point.address);
        if (e && !e.label) e.label = label;
        added++;
      }
    } else if (point.blockType === "DiscreteInput") {
      if (addExclusiveDiscreteInput(point.address)) {
        const e = discreteInputState.entries.find((x) => x.address === point.address);
        if (e && !e.label) e.label = label;
        added++;
      }
    }
  }

  return added;
}
