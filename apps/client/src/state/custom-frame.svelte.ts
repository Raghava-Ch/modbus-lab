import { invoke } from "@tauri-apps/api/core";
import { connectionState } from "./connection.svelte";
import { addLog } from "./logs.svelte";
import { notifyError, notifyInfo, notifyWarning } from "./notifications.svelte";

export type CustomFrameMode = "function-payload" | "raw-bytes";
export type CustomFramePresetId = "fc01-read-coils" | "fc03-read-holding" | "fc05-write-coil-on" | "fc06-write-register";

export interface CustomFramePreset {
  id: CustomFramePresetId;
  label: string;
  description: string;
  mode: CustomFrameMode;
  functionCode: number;
  payloadHex: string;
  rawHex: string;
}

export const customFramePresets: CustomFramePreset[] = [
  {
    id: "fc01-read-coils",
    label: "FC01 Read Coils",
    description: "Read 8 coils from address 0x0000",
    mode: "function-payload",
    functionCode: 0x01,
    payloadHex: "00000008",
    rawHex: "0100000008",
  },
  {
    id: "fc03-read-holding",
    label: "FC03 Read Holding Registers",
    description: "Read 2 registers from address 0x0000",
    mode: "function-payload",
    functionCode: 0x03,
    payloadHex: "00000002",
    rawHex: "0300000002",
  },
  {
    id: "fc05-write-coil-on",
    label: "FC05 Write Single Coil ON",
    description: "Write coil 0x0001 to ON (0xFF00)",
    mode: "function-payload",
    functionCode: 0x05,
    payloadHex: "0001FF00",
    rawHex: "050001FF00",
  },
  {
    id: "fc06-write-register",
    label: "FC06 Write Single Register",
    description: "Write register 0x0001 with value 0x000A",
    mode: "function-payload",
    functionCode: 0x06,
    payloadHex: "0001000A",
    rawHex: "060001000A",
  },
];

export interface CustomFrameResponse {
  mode: CustomFrameMode;
  functionCode: number;
  functionName: string;
  requestHex: string;
  responseHex: string;
  responseAscii?: string | null;
  requestSummary: string;
  responseSummary: string;
}

export const customFrameState = $state({
  mode: "function-payload" as CustomFrameMode,
  functionCode: 3,
  payloadHex: "00000001",
  rawHex: "0300000001",
  pending: false,
  error: "",
  warnings: [] as string[],
  response: null as CustomFrameResponse | null,
});

function refreshWarnings(): void {
  customFrameState.warnings = collectWarnings(
    customFrameState.mode,
    customFrameState.functionCode,
    customFrameState.payloadHex,
    customFrameState.rawHex,
  );
}

function parseInvokeError(err: unknown): string {
  if (typeof err === "string") {
    try {
      const parsed = JSON.parse(err) as { message?: string; details?: string };
      const msg = parsed.message ?? err;
      return parsed.details ? `${msg}: ${parsed.details}` : msg;
    } catch {
      return err;
    }
  }

  if (typeof err === "object" && err !== null) {
    const e = err as { message?: unknown; details?: unknown };
    const msg = e.message != null ? String(e.message) : "Unknown error";
    return e.details != null ? `${msg}: ${String(e.details)}` : msg;
  }

  return "Unknown error";
}

function hexByteCount(input: string): number {
  const count = Array.from(input).filter((ch) => /[0-9a-fA-F]/.test(ch)).length;
  return Math.floor(count / 2);
}

function collectWarnings(mode: CustomFrameMode, functionCode: number, payloadHex: string, rawHex: string): string[] {
  const warnings: string[] = [];

  if (mode === "function-payload") {
    if (functionCode === 0 || functionCode >= 0x80) {
      warnings.push(`Unusual function code 0x${functionCode.toString(16).padStart(2, "0").toUpperCase()}. Device may reject it.`);
    }

    const payloadBytes = hexByteCount(payloadHex);
    if (payloadBytes > 252) {
      warnings.push(`Large payload (${payloadBytes} bytes). Typical Modbus PDU payload limit is 252 bytes.`);
    }
  } else {
    const rawBytes = hexByteCount(rawHex);
    if (rawBytes === 0) {
      warnings.push("Raw bytes are empty. First byte should be function code.");
    } else if (rawBytes > 253) {
      warnings.push(`Large raw frame (${rawBytes} bytes). Device may reject oversized requests.`);
    }
  }

  return warnings;
}

export function setCustomFrameMode(mode: CustomFrameMode): void {
  customFrameState.mode = mode;
  refreshWarnings();
}

export function setCustomFunctionCode(value: number): void {
  customFrameState.functionCode = Math.max(0, Math.min(255, Math.floor(value || 0)));
  refreshWarnings();
}

export function setCustomPayloadHex(value: string): void {
  customFrameState.payloadHex = value;
  refreshWarnings();
}

export function setCustomRawHex(value: string): void {
  customFrameState.rawHex = value;
  refreshWarnings();
}

export function applyCustomFramePreset(presetId: CustomFramePresetId): void {
  const preset = customFramePresets.find((item) => item.id === presetId);
  if (!preset) {
    return;
  }

  customFrameState.mode = preset.mode;
  customFrameState.functionCode = preset.functionCode;
  customFrameState.payloadHex = preset.payloadHex;
  customFrameState.rawHex = preset.rawHex;
  customFrameState.error = "";
  refreshWarnings();
  addLog("info", `[CUSTOM-FRAME] preset applied ${preset.label}`);
}

export function clearCustomFrameResult(): void {
  customFrameState.response = null;
  customFrameState.error = "";
}

export async function sendCustomFrame(): Promise<void> {
  if (connectionState.status !== "connected") {
    const msg = "Connect to a device before sending custom frames.";
    customFrameState.error = msg;
    notifyWarning(msg);
    return;
  }

  customFrameState.pending = true;
  customFrameState.error = "";

  const warnings = collectWarnings(
    customFrameState.mode,
    customFrameState.functionCode,
    customFrameState.payloadHex,
    customFrameState.rawHex,
  );
  customFrameState.warnings = warnings;
  if (warnings.length > 0) {
    addLog("warn", `[CUSTOM-FRAME] ${warnings.join(" | ")}`);
  }

  try {
    const response = await invoke<CustomFrameResponse>("send_custom_frame", {
      request: {
        mode: customFrameState.mode,
        functionCode: customFrameState.mode === "function-payload" ? customFrameState.functionCode : undefined,
        payloadHex: customFrameState.mode === "function-payload" ? customFrameState.payloadHex : undefined,
        rawHex: customFrameState.mode === "raw-bytes" ? customFrameState.rawHex : undefined,
      },
    });

    customFrameState.response = response;
    addLog("info", `[CUSTOM-FRAME] send ok fc=0x${response.functionCode.toString(16).padStart(2, "0").toUpperCase()} rsp=${response.responseHex}`);
    notifyInfo("Custom frame sent successfully.");
  } catch (err) {
    const details = parseInvokeError(err);
    customFrameState.error = details;
    addLog("error", `[CUSTOM-FRAME] send err msg=${details}`);
    notifyError(`Custom frame failed: ${details}`);
  } finally {
    customFrameState.pending = false;
  }
}
