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

export type EngineeringValue =
  | { Number: { value: number; raw: number } }
  | { Bool: boolean }
  | { Text: string };

// ---------------------------------------------------------------------------
// ASCII packing (one register = two bytes, MSB first)
// ---------------------------------------------------------------------------

export function packAsciiPair(text: string, offset: number): number {
  const code1 = text.charCodeAt(offset) || 0;
  const code2 = text.charCodeAt(offset + 1) || 0;
  return ((code1 & 0xFF) << 8) | (code2 & 0xFF);
}

export function readTextRegister(text: string, fieldRegs: number, regIndex: number): number {
  if (regIndex >= fieldRegs) {
    return 0;
  }
  return packAsciiPair(text, regIndex * 2);
}

export function decodeAsciiField(words: ArrayLike<number>): string {
  const bytes: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    bytes.push((w >> 8) & 0xFF);
    bytes.push(w & 0xFF);
  }
  // Strip trailing NUL/space.
  while (bytes.length > 0 && (bytes[bytes.length - 1] === 0 || bytes[bytes.length - 1] === 32)) {
    bytes.pop();
  }
  return String.fromCharCode(...bytes);
}

// ---------------------------------------------------------------------------
// Big-endian numeric decoders / encoders
// ---------------------------------------------------------------------------

const tempBuffer = new ArrayBuffer(8);
const tempView = new DataView(tempBuffer);

export function u32FromBeWords(hi: number, lo: number): number {
  return ((hi & 0xFFFF) << 16) | (lo & 0xFFFF);
}

export function u32ToBeWords(v: number): [number, number] {
  return [
    (v >>> 16) & 0xFFFF,
    v & 0xFFFF
  ];
}

export function i32FromBeWords(hi: number, lo: number): number {
  return (u32FromBeWords(hi, lo) << 0) >> 0; // force signed 32-bit
}

export function f32FromBeWords(hi: number, lo: number): number {
  tempView.setUint16(0, hi, false);
  tempView.setUint16(2, lo, false);
  return tempView.getFloat32(0, false);
}

export function f32ToBeWords(v: number): [number, number] {
  tempView.setFloat32(0, v, false);
  return [
    tempView.getUint16(0, false),
    tempView.getUint16(2, false)
  ];
}

export function u64FromBeWords(w: ArrayLike<number>): bigint {
  tempView.setUint16(0, w[0], false);
  tempView.setUint16(2, w[1], false);
  tempView.setUint16(4, w[2], false);
  tempView.setUint16(6, w[3], false);
  return tempView.getUint64(0, false);
}

export function u64ToBeWords(v: bigint): [number, number, number, number] {
  tempView.setUint64(0, v, false);
  return [
    tempView.getUint16(0, false),
    tempView.getUint16(2, false),
    tempView.getUint16(4, false),
    tempView.getUint16(6, false)
  ];
}

export function i64FromBeWords(w: ArrayLike<number>): bigint {
  tempView.setUint16(0, w[0], false);
  tempView.setUint16(2, w[1], false);
  tempView.setUint16(4, w[2], false);
  tempView.setUint16(6, w[3], false);
  return tempView.getInt64(0, false);
}

export function f64FromBeWords(w: ArrayLike<number>): number {
  tempView.setUint16(0, w[0], false);
  tempView.setUint16(2, w[1], false);
  tempView.setUint16(4, w[2], false);
  tempView.setUint16(6, w[3], false);
  return tempView.getFloat64(0, false);
}

export function f64ToBeWords(v: number): [number, number, number, number] {
  tempView.setFloat64(0, v, false);
  return [
    tempView.getUint16(0, false),
    tempView.getUint16(2, false),
    tempView.getUint16(4, false),
    tempView.getUint16(6, false)
  ];
}

// ---------------------------------------------------------------------------
// Scale helpers
// ---------------------------------------------------------------------------

export function applyScale(raw: number, num: number, den: number): number {
  const n = num;
  const d = den === 0 ? 1.0 : den;
  return raw * n / d;
}

export function invertScale(eng: number, num: number, den: number): number {
  const n = num === 0 ? 1.0 : num;
  const d = den;
  return eng * d / n;
}

// ---------------------------------------------------------------------------
// High-level point decode / encode for register-block points
// ---------------------------------------------------------------------------

export function decodeRegisterPoint(
  dataType: IbusDataType,
  scaleNum: number,
  scaleDen: number,
  words: ArrayLike<number>
): EngineeringValue {
  function need(words: ArrayLike<number>, n: number) {
    if (words.length !== n) {
      throw new Error(`expected ${n} register words, got ${words.length}`);
    }
  }

  switch (dataType) {
    case "Int16": {
      need(words, 1);
      const raw = (words[0] << 16) >> 16; // force signed 16-bit
      return {
        Number: {
          value: applyScale(raw, scaleNum, scaleDen),
          raw,
        },
      };
    }
    case "UInt16": {
      need(words, 1);
      const raw = words[0];
      return {
        Number: {
          value: applyScale(raw, scaleNum, scaleDen),
          raw,
        },
      };
    }
    case "Int32": {
      need(words, 2);
      const raw = i32FromBeWords(words[0], words[1]);
      return {
        Number: {
          value: applyScale(raw, scaleNum, scaleDen),
          raw,
        },
      };
    }
    case "UInt32": {
      need(words, 2);
      const raw = u32FromBeWords(words[0], words[1]);
      return {
        Number: {
          value: applyScale(raw, scaleNum, scaleDen),
          raw,
        },
      };
    }
    case "Float32": {
      need(words, 2);
      const raw = f32FromBeWords(words[0], words[1]);
      return {
        Number: {
          value: applyScale(raw, scaleNum, scaleDen),
          raw,
        },
      };
    }
    case "Int64": {
      need(words, 4);
      const rawVal = i64FromBeWords(words);
      // JS numbers are double precision floats (safe integer up to 2^53 - 1).
      // Converting to Number can lose precision for extremely large 64-bit ints, but matches Rust casting f64.
      const raw = Number(rawVal);
      return {
        Number: {
          value: applyScale(raw, scaleNum, scaleDen),
          raw,
        },
      };
    }
    case "Float64": {
      need(words, 4);
      const raw = f64FromBeWords(words);
      return {
        Number: {
          value: applyScale(raw, scaleNum, scaleDen),
          raw,
        },
      };
    }
    case "Ascii": {
      if (scaleNum <= 0) {
        throw new Error("ASCII point requires positive char length in scaleNum");
      }
      const chars = scaleNum;
      const regs = Math.floor((chars + 1) / 2);
      need(words, regs);
      return { Text: decodeAsciiField(words) };
    }
    case "Bool": {
      need(words, 1);
      return { Bool: words[0] !== 0 };
    }
    default:
      throw new Error(`unsupported or invalid data type: ${dataType}`);
  }
}

export function encodeRegisterPoint(
  dataType: IbusDataType,
  scaleNum: number,
  scaleDen: number,
  value: EngineeringValue
): number[] {
  let raw: number;

  if (dataType === "Bool") {
    if ("Bool" in value) {
      return [value.Bool ? 1 : 0];
    }
    throw new Error("expected Bool value");
  }

  if (dataType === "Ascii") {
    if ("Text" in value) {
      const s = value.Text;
      if (scaleNum <= 0) {
        throw new Error("ASCII point requires positive char length in scaleNum");
      }
      const chars = scaleNum;
      const regs = Math.floor((chars + 1) / 2);
      const out: number[] = [];
      for (let i = 0; i < regs; i++) {
        out.push(packAsciiPair(s, i * 2));
      }
      return out;
    }
    throw new Error("expected Text value");
  }

  if ("Number" in value) {
    raw = invertScale(value.Number.value, scaleNum, scaleDen);
  } else {
    throw new Error("expected Number value");
  }

  switch (dataType) {
    case "Int16": {
      const rounded = Math.round(raw);
      // Clamp to signed 16-bit
      const val = Math.max(-32768, Math.min(32767, rounded));
      return [val & 0xFFFF];
    }
    case "UInt16": {
      const rounded = Math.round(raw);
      // Clamp to unsigned 16-bit
      const val = Math.max(0, Math.min(65535, rounded));
      return [val & 0xFFFF];
    }
    case "Int32": {
      const rounded = Math.round(raw);
      const val = Math.max(-2147483648, Math.min(2147483647, rounded));
      return u32ToBeWords(val >>> 0);
    }
    case "UInt32": {
      const rounded = Math.round(raw);
      const val = Math.max(0, Math.min(4294967295, rounded));
      return u32ToBeWords(val);
    }
    case "Float32": {
      return f32ToBeWords(raw);
    }
    case "Int64": {
      const rounded = Math.round(raw);
      // Clamp to signed 64-bit range
      const bigVal = BigInt(rounded);
      return u64ToBeWords(bigVal);
    }
    case "Float64": {
      return f64ToBeWords(raw);
    }
    default:
      throw new Error(`unsupported or invalid data type: ${dataType}`);
  }
}
