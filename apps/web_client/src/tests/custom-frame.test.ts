// Custom Frame state — warnings, presets, mode/function/hex setters
import { describe, it, expect, beforeEach, vi } from "vitest";
import { modbusAdapter } from "../lib/adapters/WebModbusAdapter";
import {
  customFrameState,
  customFramePresets,
  setCustomFrameMode,
  setCustomFunctionCode,
  setCustomPayloadHex,
  setCustomRawHex,
  applyCustomFramePreset,
  clearCustomFrameResult,
  sendCustomFrame,
} from "../state/custom-frame.svelte";
import { connectionState } from "../state/connection.svelte";

vi.mock("../lib/adapters/WebModbusAdapter", () => ({
  modbusAdapter: {
    sendCustomFrame: vi.fn(),
  },
}));

function resetState() {
  customFrameState.mode = "function-payload";
  customFrameState.functionCode = 3;
  customFrameState.payloadHex = "00000001";
  customFrameState.rawHex = "0300000001";
  customFrameState.pending = false;
  customFrameState.error = "";
  customFrameState.warnings = [];
  customFrameState.response = null;
  connectionState.status = "connected";
  vi.clearAllMocks();
}

beforeEach(resetState);

// ── setCustomFrameMode ────────────────────────────────────────────────────────

describe("setCustomFrameMode", () => {
  it("switches to 'raw-bytes' mode", () => {
    setCustomFrameMode("raw-bytes");
    expect(customFrameState.mode).toBe("raw-bytes");
  });

  it("switches back to 'function-payload' mode", () => {
    setCustomFrameMode("raw-bytes");
    setCustomFrameMode("function-payload");
    expect(customFrameState.mode).toBe("function-payload");
  });
});

// ── setCustomFunctionCode ─────────────────────────────────────────────────────

describe("setCustomFunctionCode", () => {
  it("sets a standard function code", () => {
    setCustomFunctionCode(1);
    expect(customFrameState.functionCode).toBe(1);
  });

  it("clamps to 0 for negative input", () => {
    setCustomFunctionCode(-5);
    expect(customFrameState.functionCode).toBe(0);
  });

  it("clamps to 255 for over-range input", () => {
    setCustomFunctionCode(300);
    expect(customFrameState.functionCode).toBe(255);
  });

  it("floors fractional values", () => {
    setCustomFunctionCode(3.9);
    expect(customFrameState.functionCode).toBe(3);
  });

  it("adds a warning for unusual function codes (0x80+)", () => {
    setCustomFunctionCode(0x80);
    expect(customFrameState.warnings.some((w) => w.toLowerCase().includes("unusual"))).toBe(true);
  });

  it("adds a warning for function code 0", () => {
    setCustomFunctionCode(0);
    expect(customFrameState.warnings.some((w) => w.toLowerCase().includes("unusual"))).toBe(true);
  });

  it("clears warnings for a normal function code", () => {
    setCustomFunctionCode(0x80); // adds a warning
    setCustomFunctionCode(3);    // normal code
    expect(customFrameState.warnings).toHaveLength(0);
  });
});

// ── setCustomPayloadHex ───────────────────────────────────────────────────────

describe("setCustomPayloadHex", () => {
  it("updates payloadHex", () => {
    setCustomPayloadHex("AABBCC");
    expect(customFrameState.payloadHex).toBe("AABBCC");
  });

  it("adds a warning when payload exceeds 252 bytes (504 hex chars)", () => {
    const oversized = "AA".repeat(253);
    setCustomPayloadHex(oversized);
    expect(customFrameState.warnings.some((w) => w.includes("253"))).toBe(true);
  });

  it("no warning for exactly 252 bytes (504 hex chars)", () => {
    setCustomPayloadHex("AA".repeat(252));
    expect(customFrameState.warnings).toHaveLength(0);
  });
});

// ── setCustomRawHex ───────────────────────────────────────────────────────────

describe("setCustomRawHex", () => {
  it("updates rawHex", () => {
    setCustomRawHex("0100000008");
    expect(customFrameState.rawHex).toBe("0100000008");
  });

  it("adds warning for empty raw hex when mode is raw-bytes", () => {
    setCustomFrameMode("raw-bytes");
    setCustomRawHex("");
    expect(customFrameState.warnings.some((w) => w.toLowerCase().includes("empty"))).toBe(true);
  });

  it("adds warning for oversized raw frame (>253 bytes) in raw-bytes mode", () => {
    setCustomFrameMode("raw-bytes");
    setCustomRawHex("AA".repeat(254));
    expect(customFrameState.warnings.some((w) => w.includes("254"))).toBe(true);
  });
});

// ── applyCustomFramePreset ────────────────────────────────────────────────────

describe("applyCustomFramePreset", () => {
  it("applies the FC01 preset correctly", () => {
    applyCustomFramePreset("fc01-read-coils");
    const preset = customFramePresets.find((p) => p.id === "fc01-read-coils")!;
    expect(customFrameState.functionCode).toBe(preset.functionCode);
    expect(customFrameState.payloadHex).toBe(preset.payloadHex);
    expect(customFrameState.mode).toBe("function-payload");
  });

  it("applies the FC03 preset correctly", () => {
    applyCustomFramePreset("fc03-read-holding");
    expect(customFrameState.functionCode).toBe(0x03);
    expect(customFrameState.payloadHex).toBe("00000002");
  });

  it("applies the FC05 preset and clears error", () => {
    customFrameState.error = "old error";
    applyCustomFramePreset("fc05-write-coil-on");
    expect(customFrameState.error).toBe("");
    expect(customFrameState.functionCode).toBe(0x05);
  });

  it("applies the FC06 preset correctly", () => {
    applyCustomFramePreset("fc06-write-register");
    expect(customFrameState.functionCode).toBe(0x06);
    expect(customFrameState.payloadHex).toBe("0001000A");
  });

  it("does nothing for an unknown preset id", () => {
    const before = { ...customFrameState };
    // @ts-expect-error — intentional invalid preset
    applyCustomFramePreset("invalid-preset");
    expect(customFrameState.functionCode).toBe(before.functionCode);
  });
});

// ── clearCustomFrameResult ────────────────────────────────────────────────────

describe("clearCustomFrameResult", () => {
  it("clears response and error", () => {
    customFrameState.response = {
      mode: "function-payload",
      functionCode: 3,
      functionName: "Read Holding Registers",
      requestHex: "0300000001",
      responseHex: "03020001",
      requestSummary: "req",
      responseSummary: "resp",
    };
    customFrameState.error = "previous error";
    clearCustomFrameResult();
    expect(customFrameState.response).toBeNull();
    expect(customFrameState.error).toBe("");
  });
});

// ── sendCustomFrame ───────────────────────────────────────────────────────────

describe("sendCustomFrame", () => {
  it("sets error without invoking when not connected", async () => {
    connectionState.status = "disconnected";
    await sendCustomFrame();
    expect(modbusAdapter.sendCustomFrame).not.toHaveBeenCalled();
    expect(customFrameState.error).toBeTruthy();
  });

  it("calls modbusAdapter.sendCustomFrame when connected", async () => {
    vi.mocked(modbusAdapter.sendCustomFrame).mockResolvedValueOnce({
      mode: "function-payload",
      functionCode: 3,
      functionName: "Read Holding Registers",
      requestHex: "0300000001",
      responseHex: "03020001",
      requestSummary: "req",
      responseSummary: "resp",
    });

    await sendCustomFrame();

    expect(modbusAdapter.sendCustomFrame).toHaveBeenCalledWith(expect.any(Object));
  });

  it("stores the response on success", async () => {
    const mockResp = {
      mode: "function-payload",
      functionCode: 3,
      functionName: "Read Holding Registers",
      requestHex: "0300000001",
      responseHex: "03020001",
      requestSummary: "req",
      responseSummary: "resp",
    };
    vi.mocked(modbusAdapter.sendCustomFrame).mockResolvedValueOnce(mockResp);

    await sendCustomFrame();

    expect(customFrameState.response).not.toBeNull();
    expect(customFrameState.response?.functionCode).toBe(3);
    expect(customFrameState.pending).toBe(false);
  });

  it("stores error string on failure", async () => {
    vi.mocked(modbusAdapter.sendCustomFrame).mockRejectedValueOnce(new Error("Device unreachable"));

    await sendCustomFrame();

    expect(customFrameState.error).toBeTruthy();
    expect(customFrameState.pending).toBe(false);
    expect(customFrameState.response).toBeNull();
  });

  it("sets pending=true while invoke is in-flight and false after", async () => {
    const pendingStates: boolean[] = [];
    vi.mocked(modbusAdapter.sendCustomFrame).mockImplementationOnce(async () => {
      pendingStates.push(customFrameState.pending);
      return {
        mode: "function-payload",
        functionCode: 3,
        functionName: "FC03",
        requestHex: "",
        responseHex: "",
        requestSummary: "",
        responseSummary: "",
      };
    });

    await sendCustomFrame();

    expect(pendingStates[0]).toBe(true);
    expect(customFrameState.pending).toBe(false);
  });
});
