// Shared iBus v1.1 frontend types — string-tagged enums match the camelCase
// JSON the Rust ibus-core crate emits via serde.

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

export type EngineeringValue =
  | { Number: { value: number; raw: number } }
  | { Bool: boolean }
  | { Text: string };

export const IBUS_FLAG_WRITABLE = 0x0001;
export const IBUS_FLAG_PERSISTENT = 0x0004;

export function isWritable(point: IbusPointDesc): boolean {
  return (point.flags & IBUS_FLAG_WRITABLE) !== 0;
}

export function isPersistent(point: IbusPointDesc): boolean {
  return (point.flags & IBUS_FLAG_PERSISTENT) !== 0;
}
