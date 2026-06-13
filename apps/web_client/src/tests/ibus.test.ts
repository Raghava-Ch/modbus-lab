import { describe, it, expect } from "vitest";
import {
  packAsciiPair,
  decodeAsciiField,
  f32FromBeWords,
  f32ToBeWords,
  f64FromBeWords,
  f64ToBeWords,
  applyScale,
  invertScale,
  decodeRegisterPoint,
  encodeRegisterPoint,
} from "../lib/ibus/codec";
import {
  parseIdentity,
  parseManifest,
  parsePoints,
  parseDescriptor,
  SIGNATURE_WORD,
  VERSION_WORD,
} from "../lib/ibus/parser";
import { runConformance } from "../lib/ibus/conformance";

describe("iBus Codec / Pack ASCII Helpers", () => {
  it("packAsciiPair packs two chars into big-endian u16", () => {
    expect(packAsciiPair("AB", 0)).toBe(0x4142); // 'A' = 0x41, 'B' = 0x42
    expect(packAsciiPair("A", 0)).toBe(0x4100);
    expect(packAsciiPair("", 0)).toBe(0x0000);
  });

  it("decodeAsciiField strips trailing spaces and NULs", () => {
    const words = [0x4142, 0x4320, 0x0000]; // "ABC " + NUL
    expect(decodeAsciiField(words)).toBe("ABC");
  });
});

describe("iBus Codec / Big-endian Float Helpers", () => {
  it("Float32 conversions roundtrip", () => {
    const val = 123.456;
    const [hi, lo] = f32ToBeWords(val);
    const decoded = f32FromBeWords(hi, lo);
    expect(decoded).toBeCloseTo(val, 5);
  });

  it("Float64 conversions roundtrip", () => {
    const val = -987.654321;
    const words = f64ToBeWords(val);
    const decoded = f64FromBeWords(words);
    expect(decoded).toBe(val);
  });
});

describe("iBus Codec / Scale Helpers", () => {
  it("applies and inverts scale correctly", () => {
    expect(applyScale(100, 1, 10)).toBe(10);
    expect(applyScale(15, 3, 2)).toBe(22.5);
    expect(applyScale(100, 1, 0)).toBe(100); // 0 denominator falls back to 1.0

    expect(invertScale(10, 1, 10)).toBe(100);
    expect(invertScale(22.5, 3, 2)).toBe(15);
  });
});

describe("iBus Codec / Register Point I/O", () => {
  it("decodes Int16 point", () => {
    const point = decodeRegisterPoint("Int16", 1, 10, [150]);
    expect(point).toEqual({
      Number: { value: 15, raw: 150 },
    });
  });

  it("encodes Int16 point", () => {
    const words = encodeRegisterPoint("Int16", 1, 10, {
      Number: { value: 15, raw: 0 },
    });
    expect(words).toEqual([150]);
  });

  it("decodes Float32 point", () => {
    const val = 12.34;
    const [hi, lo] = f32ToBeWords(val * 100);
    const point = decodeRegisterPoint("Float32", 1, 100, [hi, lo]);
    expect(point).toEqual({
      Number: { value: expect.closeTo(val, 5), raw: expect.closeTo(val * 100, 5) },
    });
  });

  it("decodes Ascii point", () => {
    const words = [0x5465, 0x7374]; // "Test"
    const point = decodeRegisterPoint("Ascii", 4, 1, words);
    expect(point).toEqual({
      Text: "Test",
    });
  });

  it("encodes Ascii point", () => {
    const words = encodeRegisterPoint("Ascii", 4, 1, { Text: "Test" });
    expect(words).toEqual([0x5465, 0x7374]);
  });

  it("decodes Bool point", () => {
    expect(decodeRegisterPoint("Bool", 1, 1, [1])).toEqual({ Bool: true });
    expect(decodeRegisterPoint("Bool", 1, 1, [0])).toEqual({ Bool: false });
  });

  it("encodes Bool point", () => {
    expect(encodeRegisterPoint("Bool", 1, 1, { Bool: true })).toEqual([1]);
    expect(encodeRegisterPoint("Bool", 1, 1, { Bool: false })).toEqual([0]);
  });
});

describe("iBus Parser", () => {
  it("parses valid identity, manifest, points, and descriptor", () => {
    // Identity words (40 registers)
    const identityWords = new Uint16Array(40);
    identityWords[0] = SIGNATURE_WORD; // HR 9000
    identityWords[1] = VERSION_WORD; // HR 9001
    identityWords[2] = 2; // point_count = 2
    identityWords[4] = 1; // manifest_count = 1
    // manifest_addr = 9040 (HR 9005 = 0, HR 9006 = 9040)
    identityWords[5] = 0;
    identityWords[6] = 9040;
    // point_addr = 9047 (HR 9007 = 0, HR 9008 = 9047)
    identityWords[7] = 0;
    identityWords[8] = 9047;

    // device name "TestDev" at index 10..17
    const deviceName = "TestDev";
    for (let i = 0; i < 4; i++) {
      identityWords[10 + i] = packAsciiPair(deviceName, i * 2);
    }

    const { identity, header } = parseIdentity(identityWords);
    expect(identity.deviceName).toBe("TestDev");
    expect(header.manifestCount).toBe(1);
    expect(header.pointCount).toBe(2);
    expect(header.manifestAddr).toBe(9040);
    expect(header.pointAddr).toBe(9047);

    // Manifest words (1 entry * 7 registers = 7 words)
    // entry 0: blockType=HoldingRegister(1), startAddress=1000, length=10, name="HRs"
    const manifestWords = new Uint16Array(7);
    manifestWords[0] = 1;
    manifestWords[1] = 1000;
    manifestWords[2] = 10;
    const name = "HRs";
    for (let i = 0; i < 2; i++) {
      manifestWords[3 + i] = packAsciiPair(name, i * 2);
    }

    const manifest = parseManifest(manifestWords, 1);
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toEqual({
      blockType: "HoldingRegister",
      startAddress: 1000,
      length: 10,
      name: "HRs",
    });

    // Points words (2 entries * 20 registers = 40 words)
    // entry 0: address=1000, blockType=HoldingRegister(1), dataType=Int16(1), scaleNum=1, scaleDen=10, name="temp", desc="sensor"
    const pointsWords = new Uint16Array(40);
    pointsWords[0] = 1000; // address
    pointsWords[1] = 1; // block_type = HoldingRegister
    pointsWords[2] = 1; // data_type = Int16
    pointsWords[3] = 1; // scale_num
    pointsWords[4] = 10; // scale_den
    pointsWords[5] = 0x2F; // unit_code = degC
    pointsWords[6] = 0x01; // flags = writable
    // name "temp" at 7..12
    const p1Name = "temp";
    for (let i = 0; i < 2; i++) {
      pointsWords[7 + i] = packAsciiPair(p1Name, i * 2);
    }
    // desc "sensor" at 13..17
    const p1Desc = "sensor";
    for (let i = 0; i < 3; i++) {
      pointsWords[13 + i] = packAsciiPair(p1Desc, i * 2);
    }

    // entry 1: address=1001, blockType=HoldingRegister(1), dataType=Bool(7), scaleNum=1, scaleDen=1, name="status", desc="relay"
    const base2 = 20;
    pointsWords[base2 + 0] = 1001; // address
    pointsWords[base2 + 1] = 1; // block_type = HoldingRegister
    pointsWords[base2 + 2] = 7; // data_type = Bool
    pointsWords[base2 + 3] = 1; // scale_num
    pointsWords[base2 + 4] = 1; // scale_den
    pointsWords[base2 + 5] = 0x70; // unit_code = none
    pointsWords[base2 + 6] = 0x01; // flags = writable
    // name "status" at 27..32
    const p2Name = "status";
    for (let i = 0; i < 3; i++) {
      pointsWords[base2 + 7 + i] = packAsciiPair(p2Name, i * 2);
    }

    const points = parsePoints(pointsWords, 2);
    expect(points).toHaveLength(2);
    expect(points[0].name).toBe("temp");
    expect(points[0].scaleDen).toBe(10);
    expect(points[1].name).toBe("status");
    expect(points[1].dataType).toBe("Bool");

    // Full descriptor
    const descriptor = parseDescriptor(identityWords, manifestWords, pointsWords);
    expect(descriptor.identity.deviceName).toBe("TestDev");
    expect(descriptor.manifestAddr).toBe(9040);
    expect(descriptor.manifest).toHaveLength(1);
    expect(descriptor.points).toHaveLength(2);
  });
});

describe("iBus Conformance Checks", () => {
  it("runs conformance checks and passes for valid descriptor", () => {
    const descriptor = {
      identity: {
        deviceName: "Test",
        vendor: "Test",
        model: "Test",
        firmware: "1.0",
      },
      manifest: [
        { blockType: "HoldingRegister" as const, startAddress: 1000, length: 10, name: "HR" },
      ],
      points: [
        {
          address: 1000,
          blockType: "HoldingRegister" as const,
          dataType: "Int16" as const,
          scaleNum: 1,
          scaleDen: 1,
          unitCode: 0,
          flags: 0,
          name: "temp",
          description: "temp sensor",
        },
      ],
      manifestAddr: 9040,
    };

    const findings = runConformance(SIGNATURE_WORD, VERSION_WORD, descriptor, true);
    expect(findings).toHaveLength(10);
    // All should be "Pass"
    for (const f of findings) {
      expect(f.level).toBe("Pass");
    }
  });

  it("reports failure when signature is incorrect", () => {
    const descriptor = {
      identity: { deviceName: "T", vendor: "T", model: "T", firmware: "1.0" },
      manifest: [],
      points: [],
      manifestAddr: 9040,
    };

    const findings = runConformance(0x1234, VERSION_WORD, descriptor, true);
    expect(findings[0].level).toBe("Fail");
    expect(findings[0].id).toBe(1);
  });
});
