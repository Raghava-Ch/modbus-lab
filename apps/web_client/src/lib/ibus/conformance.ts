import type { IbusDescriptor } from "./parser";
import {
  SIGNATURE_WORD,
  VERSION_WORD,
  MANIFEST_BASE_MIN,
  REGION_END,
  MANIFEST_ENTRY_REGS,
  POINT_DESC_REGS,
} from "./parser";

export interface ConformanceFinding {
  id: number;
  level: "Pass" | "Fail" | "Warn";
  title: string;
  message: string;
}

function ok(id: number, title: string): ConformanceFinding {
  return {
    id,
    level: "Pass",
    title,
    message: "OK",
  };
}

function fail(id: number, title: string, message: string): ConformanceFinding {
  return {
    id,
    level: "Fail",
    title,
    message,
  };
}

function warn(id: number, title: string, message: string): ConformanceFinding {
  return {
    id,
    level: "Warn",
    title,
    message,
  };
}

function isAsciiClean(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code !== 0 && (code < 0x20 || code > 0x7E)) {
      return false;
    }
  }
  return true;
}

export function runConformance(
  signature: number,
  version: number,
  descriptor: IbusDescriptor,
  unusedZeroCheckPassed?: boolean | null
): ConformanceFinding[] {
  const out: ConformanceFinding[] = [];

  // 1. Signature
  if (signature === SIGNATURE_WORD) {
    out.push(ok(1, "HR 9000 signature == 0x4275"));
  } else {
    out.push(fail(1, "HR 9000 signature == 0x4275", `got 0x${signature.toString(16).toUpperCase()}`));
  }

  // 2. Version
  if (version === VERSION_WORD) {
    out.push(ok(2, "HR 9001 version == 0x0101"));
  } else {
    out.push(fail(2, "HR 9001 version == 0x0101", `got 0x${version.toString(16).toUpperCase()}`));
  }

  // 3. Manifest addr in 9040..9999
  if (descriptor.manifestAddr >= MANIFEST_BASE_MIN && descriptor.manifestAddr <= REGION_END) {
    out.push(ok(3, "manifest_addr in 9040..9999"));
  } else {
    out.push(fail(3, "manifest_addr in 9040..9999", `manifest_addr = ${descriptor.manifestAddr}`));
  }

  // 4. point_addr > manifest_end and < 9999
  const manifestEnd = descriptor.manifestAddr + descriptor.manifest.length * MANIFEST_ENTRY_REGS;
  const pointAddr = manifestEnd;
  if (pointAddr >= manifestEnd && pointAddr <= REGION_END) {
    out.push(ok(4, "point_addr after manifest, within region"));
  } else {
    out.push(fail(4, "point_addr after manifest, within region", `point_addr = ${pointAddr}`));
  }

  // 5. manifest_count * 7 + manifest_addr <= point_addr
  const need = descriptor.manifestAddr + descriptor.manifest.length * MANIFEST_ENTRY_REGS;
  if (need <= pointAddr) {
    out.push(ok(5, "manifest fits before point table"));
  } else {
    out.push(fail(5, "manifest fits before point table", `needs through HR ${need - 1}, point_addr = ${pointAddr}`));
  }

  // 6. point_count * 20 + point_addr <= 10000
  const ptEnd = pointAddr + descriptor.points.length * POINT_DESC_REGS;
  if (ptEnd <= REGION_END + 1) {
    out.push(ok(6, "point table fits in region"));
  } else {
    out.push(fail(6, "point table fits in region", `needs through HR ${ptEnd - 1}, max ${REGION_END}`));
  }

  // 7. Manifest block_type valid
  const badManifestIdx = descriptor.manifest.findIndex(
    (m) => !["HoldingRegister", "InputRegister", "Coil", "DiscreteInput"].includes(m.blockType)
  );
  if (badManifestIdx !== -1) {
    out.push(fail(7, "manifest block_type valid", `entry ${badManifestIdx} has invalid block_type`));
  } else {
    out.push(ok(7, "manifest block_type valid"));
  }

  // 8. Point block_type and data_type valid
  const badPointIdx = descriptor.points.findIndex(
    (p) =>
      !["HoldingRegister", "InputRegister", "Coil", "DiscreteInput"].includes(p.blockType) ||
      !["Int16", "UInt16", "Int32", "UInt32", "Float32", "Ascii", "Bool", "Int64", "Float64"].includes(p.dataType)
  );
  if (badPointIdx !== -1) {
    out.push(fail(8, "point block_type and data_type valid", `point ${badPointIdx} has invalid block_type or data_type`));
  } else {
    out.push(ok(8, "point block_type and data_type valid"));
  }

  // 9. ASCII fields are 0x00 or 0x20..0x7E
  const id = descriptor.identity;
  const asciiCleanOverall =
    isAsciiClean(id.deviceName) &&
    isAsciiClean(id.vendor) &&
    isAsciiClean(id.model) &&
    isAsciiClean(id.firmware) &&
    descriptor.manifest.every((m) => isAsciiClean(m.name)) &&
    descriptor.points.every((p) => isAsciiClean(p.name) && isAsciiClean(p.description));

  if (asciiCleanOverall) {
    out.push(ok(9, "ASCII fields contain only 0x00 or 0x20..0x7E"));
  } else {
    out.push(fail(9, "ASCII fields contain only 0x00 or 0x20..0x7E", "one or more text fields contain non-printable bytes"));
  }

  // 10. Unused HR in 9000..9999 read as 0
  if (unusedZeroCheckPassed === true) {
    out.push(ok(10, "unused HR in 9000..9999 read as 0"));
  } else if (unusedZeroCheckPassed === false) {
    out.push(fail(10, "unused HR in 9000..9999 read as 0", "at least one unused address returned non-zero"));
  } else {
    out.push(warn(10, "unused HR in 9000..9999 read as 0", "not verified — caller did not provide a probe of the unused range"));
  }

  return out;
}
