import { invoke } from "@tauri-apps/api/core";
import { coilState } from "./coils.svelte";
import { discreteInputState } from "./discrete-inputs.svelte";
import { holdingRegisterState } from "./holding-registers.svelte";
import { inputRegisterState } from "./input-registers.svelte";

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

export interface OverlapWarning {
  address: number;
  kind: string;
}

export interface ApplyResult {
  manifestAddr: number;
  pointAddr: number;
  overlaps: OverlapWarning[];
}

interface IbusState {
  descriptor: IbusDescriptor;
  installed: boolean;
  lastApply: ApplyResult | null;
  lastError: string | null;
  busy: boolean;
}

export function emptyDescriptor(): IbusDescriptor {
  return {
    identity: { deviceName: "ModbusLab Server", vendor: "Modbus Lab", model: "SrvSim", firmware: "0.04" },
    manifest: [],
    points: [],
    manifestAddr: 9040,
  };
}

export function sampleDescriptor(): IbusDescriptor {
  return {
    identity: {
      deviceName: "ModbusLab Server",
      vendor: "Modbus Lab",
      model: "SrvSim",
      firmware: "0.04",
    },
    manifestAddr: 9040,
    manifest: [
      { blockType: "HoldingRegister", startAddress: 0, length: 4, name: "Setpts" },
      { blockType: "InputRegister", startAddress: 0, length: 2, name: "Temps" },
      { blockType: "Coil", startAddress: 0, length: 2, name: "Modes" },
      { blockType: "DiscreteInput", startAddress: 0, length: 1, name: "Status" },
    ],
    points: [
      {
        address: 0,
        blockType: "HoldingRegister",
        dataType: "Int16",
        scaleNum: 1,
        scaleDen: 10,
        unitCode: 0x2f,
        flags: 0x0001,
        name: "HeatSetpt",
        description: "Heat",
      },
      {
        address: 1,
        blockType: "HoldingRegister",
        dataType: "Int16",
        scaleNum: 1,
        scaleDen: 10,
        unitCode: 0x2f,
        flags: 0x0001,
        name: "CoolSetpt",
        description: "Cool",
      },
      {
        address: 0,
        blockType: "InputRegister",
        dataType: "Int16",
        scaleNum: 1,
        scaleDen: 10,
        unitCode: 0x2f,
        flags: 0,
        name: "RoomTemp",
        description: "RoomTemp",
      },
      {
        address: 1,
        blockType: "InputRegister",
        dataType: "Int16",
        scaleNum: 1,
        scaleDen: 1,
        unitCode: 0x62,
        flags: 0,
        name: "RoomHum",
        description: "RoomHum",
      },
      {
        address: 0,
        blockType: "Coil",
        dataType: "Bool",
        scaleNum: 0,
        scaleDen: 1,
        unitCode: 0x70,
        flags: 0x0001,
        name: "FanOn",
        description: "Fan",
      },
      {
        address: 0,
        blockType: "DiscreteInput",
        dataType: "Bool",
        scaleNum: 0,
        scaleDen: 1,
        unitCode: 0x70,
        flags: 0,
        name: "Occupied",
        description: "Occ",
      },
    ],
  };
}

export const ibusState = $state<IbusState>({
  descriptor: emptyDescriptor(),
  installed: false,
  lastApply: null,
  lastError: null,
  busy: false,
});

export function setDescriptor(next: IbusDescriptor): void {
  ibusState.descriptor = next;
}

export async function loadCurrentDescriptor(): Promise<void> {
  ibusState.busy = true;
  try {
    const current = await invoke<IbusDescriptor | null>("ibus_get_descriptor");
    if (current) {
      ibusState.descriptor = current;
      ibusState.installed = true;
    } else {
      ibusState.installed = false;
    }
    ibusState.lastError = null;
  } catch (err) {
    ibusState.lastError = String(err);
  } finally {
    ibusState.busy = false;
  }
}

export async function applyDescriptor(): Promise<ApplyResult | null> {
  ibusState.busy = true;
  ibusState.lastError = null;
  try {
    const result = await invoke<ApplyResult>("ibus_set_descriptor", {
      request: { descriptor: ibusState.descriptor },
    });
    ibusState.lastApply = result;
    ibusState.installed = true;
    return result;
  } catch (err) {
    ibusState.lastError = String(err);
    return null;
  } finally {
    ibusState.busy = false;
  }
}

export async function clearDescriptor(): Promise<void> {
  ibusState.busy = true;
  try {
    await invoke("ibus_clear");
    ibusState.installed = false;
    ibusState.lastApply = null;
    ibusState.lastError = null;
  } catch (err) {
    ibusState.lastError = String(err);
  } finally {
    ibusState.busy = false;
  }
}

export async function exportDescriptorJson(): Promise<string | null> {
  try {
    return await invoke<string>("ibus_export_descriptor");
  } catch (err) {
    ibusState.lastError = String(err);
    return null;
  }
}

export async function importDescriptorJson(json: string): Promise<boolean> {
  try {
    const desc = await invoke<IbusDescriptor>("ibus_import_descriptor", { request: { json } });
    ibusState.descriptor = desc;
    ibusState.lastError = null;
    return true;
  } catch (err) {
    ibusState.lastError = String(err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Live derive: builds a descriptor from the current register-page entries
// ---------------------------------------------------------------------------

function truncate(s: string, len: number): string {
  return s.length > len ? s.slice(0, len) : s;
}

function buildManifestBlock(
  blockType: IbusBlockType,
  addresses: number[],
): IbusManifestEntry | null {
  if (addresses.length === 0) return null;
  const sorted = [...addresses].sort((a, b) => a - b);
  const name = truncate(
    blockType === "HoldingRegister"
      ? "Holding"
      : blockType === "InputRegister"
        ? "Input"
        : blockType === "DiscreteInput"
          ? "Discrete"
          : "Coil",
    8,
  );
  return {
    blockType,
    startAddress: sorted[0],
    length: sorted[sorted.length - 1] - sorted[0] + 1,
    name,
  };
}

function buildPoints(
  blockType: IbusBlockType,
  entries: { address: number; label: string }[],
  dataType: IbusDataType,
  flags: number,
): IbusPointDesc[] {
  return entries.map((e) => ({
    address: e.address,
    blockType,
    dataType,
    scaleNum: 1,
    scaleDen: 1,
    unitCode: 0x70, // dimensionless
    flags,
    name: truncate(e.label || String(e.address), 12),
    description: truncate(e.label || String(e.address), 10),
  }));
}

const MANIFEST_BASE_MIN = 9040;
const REGION_END_PLUS_ONE = 10000;
const MANIFEST_ENTRY_REGS = 7;
const POINT_DESC_REGS = 20;

function maxPointsForManifestCount(manifestCount: number): number {
  const remaining = REGION_END_PLUS_ONE - MANIFEST_BASE_MIN - manifestCount * MANIFEST_ENTRY_REGS;
  if (remaining <= 0) return 0;
  return Math.floor(remaining / POINT_DESC_REGS);
}

export function deriveDescriptorFromRegisters(): IbusDescriptor {
  const manifest: IbusManifestEntry[] = [];
  const points: IbusPointDesc[] = [];

  // Holding Registers — writable (flags 0x0001)
  const hr = holdingRegisterState.entries.map((e) => ({ address: e.address, label: e.label }));
  const hrBlock = buildManifestBlock("HoldingRegister", hr.map((e) => e.address));
  if (hrBlock) manifest.push(hrBlock);
  points.push(...buildPoints("HoldingRegister", hr, "UInt16", 0x0001));

  // Input Registers — read-only (flags 0x0000)
  const ir = inputRegisterState.entries.map((e) => ({ address: e.address, label: e.label }));
  const irBlock = buildManifestBlock("InputRegister", ir.map((e) => e.address));
  if (irBlock) manifest.push(irBlock);
  points.push(...buildPoints("InputRegister", ir, "UInt16", 0x0000));

  // Coils — writable bool (flags 0x0001)
  const coils = coilState.entries.map((e) => ({ address: e.address, label: e.label }));
  const coilBlock = buildManifestBlock("Coil", coils.map((e) => e.address));
  if (coilBlock) manifest.push(coilBlock);
  points.push(...buildPoints("Coil", coils, "Bool", 0x0001));

  // Discrete Inputs — read-only bool (flags 0x0000)
  const di = discreteInputState.entries.map((e) => ({ address: e.address, label: e.label }));
  const diBlock = buildManifestBlock("DiscreteInput", di.map((e) => e.address));
  if (diBlock) manifest.push(diBlock);
  points.push(...buildPoints("DiscreteInput", di, "Bool", 0x0000));

  // iBus table space is finite (HR 9000..9999). Live mode auto-trims point
  // descriptors to the max that can fit at manifest base 9040.
  const maxPoints = maxPointsForManifestCount(manifest.length);
  const fittedPoints = points.length > maxPoints ? points.slice(0, maxPoints) : points;

  return {
    identity: { ...ibusState.descriptor.identity },
    manifest,
    manifestAddr: Number.isFinite(ibusState.descriptor.manifestAddr)
      ? ibusState.descriptor.manifestAddr
      : MANIFEST_BASE_MIN,
    points: fittedPoints,
  };
}

// Module-level reactive derived state: eagerly tracks all register pages
// even when the iBus Live tab is not currently rendered.
const _derivedState = $state<{ desc: IbusDescriptor; droppedPoints: number }>({
  desc: emptyDescriptor(),
  droppedPoints: 0,
});

$effect.root(() => {
  $effect(() => {
    const manifestCount = (
      (holdingRegisterState.entries.length > 0 ? 1 : 0)
      + (inputRegisterState.entries.length > 0 ? 1 : 0)
      + (coilState.entries.length > 0 ? 1 : 0)
      + (discreteInputState.entries.length > 0 ? 1 : 0)
    );
    const totalLivePoints =
      holdingRegisterState.entries.length
      + inputRegisterState.entries.length
      + coilState.entries.length
      + discreteInputState.entries.length;

    _derivedState.desc = deriveDescriptorFromRegisters();
    _derivedState.droppedPoints = Math.max(0, totalLivePoints - _derivedState.desc.points.length);
  });
});

export function derivedDescriptor(): IbusDescriptor {
  return _derivedState.desc;
}

export function derivedDroppedPoints(): number {
  return _derivedState.droppedPoints;
}
