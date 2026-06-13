import { decodeAsciiField, type IbusDataType } from "./codec";

export type IbusBlockType = "HoldingRegister" | "InputRegister" | "Coil" | "DiscreteInput";

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

export interface IdentityHeader {
  pointCount: number;
  manifestCount: number;
  manifestAddr: number;
  pointAddr: number;
}

// Constants
export const SIGNATURE_WORD = 0x4275;
export const VERSION_WORD = 0x0101;
export const VERSION_MAJOR = 0x01;
export const REGION_START = 9000;
export const REGION_END = 9999;
export const MANIFEST_BASE_MIN = 9040;
export const MANIFEST_ENTRY_REGS = 7;
export const POINT_DESC_REGS = 20;

function blockTypeFromU16(v: number): IbusBlockType {
  switch (v) {
    case 1:
      return "HoldingRegister";
    case 2:
      return "InputRegister";
    case 3:
      return "Coil";
    case 4:
      return "DiscreteInput";
    default:
      throw new Error(`invalid block_type: ${v}`);
  }
}

function dataTypeFromU16(v: number): IbusDataType {
  switch (v) {
    case 1:
      return "Int16";
    case 2:
      return "UInt16";
    case 3:
      return "Int32";
    case 4:
      return "UInt32";
    case 5:
      return "Float32";
    case 6:
      return "Ascii";
    case 7:
      return "Bool";
    case 8:
      return "Int64";
    case 9:
      return "Float64";
    default:
      throw new Error(`invalid data_type: ${v}`);
  }
}

export function parseIdentity(words: Uint16Array): { identity: IbusIdentity; header: IdentityHeader } {
  if (words.length < 40) {
    throw new Error(`identity block requires 40 words, got ${words.length}`);
  }
  if (words[0] !== SIGNATURE_WORD) {
    throw new Error(`HR 9000 signature mismatch: got 0x${words[0].toString(16).toUpperCase()}, expected 0x${SIGNATURE_WORD.toString(16).toUpperCase()}`);
  }
  const major = (words[1] >> 8) & 0xFF;
  if (major !== VERSION_MAJOR) {
    throw new Error(`unsupported iBus major version ${major}, this client supports ${VERSION_MAJOR}`);
  }

  const header: IdentityHeader = {
    pointCount: words[2],
    manifestCount: words[4],
    manifestAddr: ((words[5] << 16) | words[6]) >>> 0,
    pointAddr: ((words[7] << 16) | words[8]) >>> 0,
  };

  const identity: IbusIdentity = {
    deviceName: decodeAsciiField(words.slice(10, 18)),
    vendor: decodeAsciiField(words.slice(18, 22)),
    model: decodeAsciiField(words.slice(22, 26)),
    firmware: decodeAsciiField(words.slice(26, 28)),
  };

  return { identity, header };
}

export function parseManifest(words: Uint16Array, count: number): IbusManifestEntry[] {
  const need = count * MANIFEST_ENTRY_REGS;
  if (words.length < need) {
    throw new Error(`manifest words too short: need ${need}, got ${words.length}`);
  }

  const out: IbusManifestEntry[] = [];
  for (let i = 0; i < count; i++) {
    const base = i * MANIFEST_ENTRY_REGS;
    const blockType = blockTypeFromU16(words[base]);
    const name = decodeAsciiField(words.slice(base + 3, base + 7));
    out.push({
      blockType,
      startAddress: words[base + 1],
      length: words[base + 2],
      name,
    });
  }
  return out;
}

export function parsePoints(words: Uint16Array, count: number): IbusPointDesc[] {
  const need = count * POINT_DESC_REGS;
  if (words.length < need) {
    throw new Error(`point table words too short: need ${need}, got ${words.length}`);
  }

  const out: IbusPointDesc[] = [];
  for (let i = 0; i < count; i++) {
    const base = i * POINT_DESC_REGS;
    const blockType = blockTypeFromU16(words[base + 1]);
    const dataType = dataTypeFromU16(words[base + 2]);
    const name = decodeAsciiField(words.slice(base + 7, base + 13));
    const description = decodeAsciiField(words.slice(base + 13, base + 18));
    out.push({
      address: words[base],
      blockType,
      dataType,
      scaleNum: (words[base + 3] << 16) >> 16,
      scaleDen: (words[base + 4] << 16) >> 16,
      unitCode: words[base + 5],
      flags: words[base + 6],
      name,
      description,
    });
  }
  return out;
}

export function parseDescriptor(
  identityWords: Uint16Array,
  manifestWords: Uint16Array,
  pointsWords: Uint16Array
): IbusDescriptor {
  const { identity, header } = parseIdentity(identityWords);
  if (header.manifestAddr < MANIFEST_BASE_MIN || header.manifestAddr > REGION_END) {
    throw new Error(`manifest_addr ${header.manifestAddr} out of range ${MANIFEST_BASE_MIN}..=${REGION_END}`);
  }
  const manifest = parseManifest(manifestWords, header.manifestCount);
  const points = parsePoints(pointsWords, header.pointCount);
  return {
    identity,
    manifest,
    points,
    manifestAddr: header.manifestAddr,
  };
}
