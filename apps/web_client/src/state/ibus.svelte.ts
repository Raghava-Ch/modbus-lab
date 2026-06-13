import { connectionState } from "./connection.svelte";
import { addExclusiveCoil, coilState } from "./coils.svelte";
import { addExclusiveDiscreteInput, discreteInputState } from "./discrete-inputs.svelte";
import { addExclusiveHoldingRegister, holdingRegisterState } from "./holding-registers.svelte";
import { addExclusiveInputRegister, inputRegisterState } from "./input-registers.svelte";
import { modbusAdapter } from "../lib/adapters/WebModbusAdapter";
import { decodeRegisterPoint } from "../lib/ibus/codec";
import { runConformance } from "../lib/ibus/conformance";
import {
  parseIdentity,
  parseManifest,
  parsePoints,
  REGION_START,
  REGION_END,
  MANIFEST_ENTRY_REGS,
  POINT_DESC_REGS,
} from "../lib/ibus/parser";

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
  id: number;
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

const MAX_REGS_PER_READ = 125;

function parseAdapterError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

async function readHr(start: number, qty: number): Promise<number[]> {
  if (qty <= 0) return [];

  const values: number[] = [];
  let offset = 0;

  while (offset < qty) {
    const chunkQty = Math.min(MAX_REGS_PER_READ, qty - offset);
    const resp = await modbusAdapter.readHoldingRegisters(start + offset, chunkQty);
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
    const resp = await modbusAdapter.readInputRegisters(start + offset, chunkQty);
    const sorted = [...resp.registers].sort((a, b) => a.address - b.address);
    values.push(...sorted.map((r) => r.value));
    offset += chunkQty;
  }

  return values;
}

async function readCoil(addr: number): Promise<boolean> {
  const resp = await modbusAdapter.readCoils(addr, 1);
  return resp.coils[0]?.value ?? false;
}

async function readDi(addr: number): Promise<boolean> {
  const resp = await modbusAdapter.readDiscreteInputs(addr, 1);
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
    // 1. Identity block: HR 9000..9039
    const identityWords = await readHr(REGION_START, 40);
    const u16IdentityWords = new Uint16Array(identityWords);
    ibusState.signature = u16IdentityWords[0] ?? null;
    ibusState.version = u16IdentityWords[1] ?? null;

    const identityResult = parseIdentity(u16IdentityWords);

    // 2. Manifest table
    const manifestRegs = identityResult.header.manifestCount * MANIFEST_ENTRY_REGS;
    const manifestWords = manifestRegs > 0
      ? await readHr(identityResult.header.manifestAddr, manifestRegs)
      : [];
    const manifest = manifestRegs > 0
      ? parseManifest(new Uint16Array(manifestWords), identityResult.header.manifestCount) as IbusManifestEntry[]
      : [];

    // 3. Point descriptors
    const pointRegs = identityResult.header.pointCount * POINT_DESC_REGS;
    const pointWords = pointRegs > 0
      ? await readHr(identityResult.header.pointAddr, pointRegs)
      : [];
    const points = pointRegs > 0
      ? parsePoints(new Uint16Array(pointWords), identityResult.header.pointCount) as IbusPointDesc[]
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
    const regionQty = REGION_END - REGION_START + 1;
    const regionWords = await readHr(REGION_START, regionQty);
    const unusedRangeReadsZero = verifyUnusedRegionReadsZero(
      REGION_START,
      regionWords,
      identityResult.header.manifestAddr,
      manifestRegs,
      identityResult.header.pointAddr,
      pointRegs,
    );

    // 5. Conformance
    const findings = runConformance(
      ibusState.signature ?? 0,
      ibusState.version ?? 0,
      descriptor,
      unusedRangeReadsZero,
    );
    ibusState.conformance = findings;

    ibusState.readings = points.map((p) => ({ point: p, value: null, error: null }));
  } catch (err) {
    ibusState.lastError = parseAdapterError(err);
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
          value = decodeRegisterPoint(
            point.dataType,
            point.scaleNum,
            point.scaleDen,
            new Uint16Array(words),
          );
        }
        next.push({ point, value, error: null });
      } catch (err) {
        next.push({ point, value: null, error: parseAdapterError(err) });
      }
    }
    ibusState.readings = next;
  } catch (err) {
    ibusState.lastError = parseAdapterError(err);
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
