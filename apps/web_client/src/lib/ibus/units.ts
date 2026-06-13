export interface UnitDef {
  code: number;
  symbol: string;
  label: string;
}

export const UNITS: UnitDef[] = [
  { code: 0x05, symbol: "A", label: "Amperes" },
  { code: 0x08, symbol: "V", label: "Volts" },
  { code: 0x11, symbol: "Hz", label: "Hertz" },
  { code: 0x1F, symbol: "W", label: "Watts" },
  { code: 0x20, symbol: "kW", label: "Kilowatts" },
  { code: 0x27, symbol: "kWh", label: "Kilowatt-hours" },
  { code: 0x2F, symbol: "°C", label: "Degrees Celsius" },
  { code: 0x31, symbol: "%", label: "Percent" },
  { code: 0x3A, symbol: "m³/h", label: "Cubic meters per hour" },
  { code: 0x62, symbol: "%RH", label: "Percent relative humidity" },
  { code: 0x70, symbol: "", label: "No units" },
];

export function lookup(code: number): UnitDef | undefined {
  return UNITS.find((u) => u.code === code);
}

export function symbol(code: number): string {
  return lookup(code)?.symbol ?? "";
}

export function label(code: number): string {
  return lookup(code)?.label ?? "Unknown unit";
}
