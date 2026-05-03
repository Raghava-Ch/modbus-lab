import type { EngineeringValue, IbusPointDesc } from "./types";
import { unitSymbol } from "./units";

/** Format an engineering value for display, applying point precision + unit. */
export function formatEngineeringValue(
  value: EngineeringValue | null,
  point: IbusPointDesc,
): string {
  if (!value) return "—";
  if ("Number" in value) {
    const decimals = decimalsFor(point);
    const sym = unitSymbol(point.unitCode);
    const formatted = value.Number.value.toFixed(decimals);
    return sym ? `${formatted} ${sym}` : formatted;
  }
  if ("Bool" in value) return value.Bool ? "ON" : "OFF";
  if ("Text" in value) return value.Text;
  return "?";
}

export function decimalsFor(point: IbusPointDesc): number {
  if (point.scaleDen <= 1) return 0;
  return Math.max(0, Math.round(Math.log10(point.scaleDen)));
}

export function pointFlagLabel(point: IbusPointDesc): string {
  const parts: string[] = [];
  if (point.flags & 0x0001) parts.push("W");
  if (point.flags & 0x0004) parts.push("P");
  return parts.length > 0 ? parts.join("/") : "—";
}

export function blockTypeShort(bt: string): string {
  switch (bt) {
    case "HoldingRegister":
      return "HR";
    case "InputRegister":
      return "IR";
    case "Coil":
      return "Coil";
    case "DiscreteInput":
      return "DI";
    default:
      return bt;
  }
}
