// ASHRAE BACnet engineering unit codes — small subset used by iBus reference
// device descriptors. Mirrors `crates/ibus-core/src/units.rs`.

export interface UnitDef {
  code: number;
  symbol: string;
  label: string;
}

const UNIT_TABLE: UnitDef[] = [
  { code: 0x05, symbol: "A", label: "amperes" },
  { code: 0x08, symbol: "V", label: "volts" },
  { code: 0x11, symbol: "Hz", label: "hertz" },
  { code: 0x1f, symbol: "W", label: "watts" },
  { code: 0x20, symbol: "kW", label: "kilowatts" },
  { code: 0x27, symbol: "kWh", label: "kilowatt-hours" },
  { code: 0x2f, symbol: "°C", label: "degrees Celsius" },
  { code: 0x31, symbol: "%", label: "percent" },
  { code: 0x3a, symbol: "m³/h", label: "cubic metres per hour" },
  { code: 0x62, symbol: "%RH", label: "percent relative humidity" },
  { code: 0x70, symbol: "", label: "no units" },
];

const BY_CODE = new Map<number, UnitDef>(UNIT_TABLE.map((u) => [u.code, u]));

export function lookupUnit(code: number): UnitDef | undefined {
  return BY_CODE.get(code);
}

export function unitSymbol(code: number): string {
  return BY_CODE.get(code)?.symbol ?? `0x${code.toString(16).toUpperCase().padStart(2, "0")}`;
}

export function unitLabel(code: number): string {
  return BY_CODE.get(code)?.label ?? "Unknown unit";
}
