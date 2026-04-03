import { invoke } from "@tauri-apps/api/core";
import { addLog } from "./logs.svelte";
import { notifyWarning } from "./notifications.svelte";
import { connectionState } from "./connection.svelte";

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

function warnLocal(message: string): void {
  addLog("warn", message);
  notifyWarning(message);
}

function ensureSerialOnly(feature: string): boolean {
  if (connectionState.protocol !== "tcp") return true;

  warnLocal(`${feature} is serial-line only. Switch protocol to Serial RTU or Serial ASCII in Connection.`);
  return false;
}

function hexFromBytes(bytes: number[] | Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ")
    .toUpperCase();
}

function tryAscii(bytes: number[] | Uint8Array): string {
  const text = Array.from(bytes)
    .map((byte) => (byte >= 0x20 && byte <= 0x7e) || byte === 0x09 || byte === 0x0a || byte === 0x0d ? String.fromCharCode(byte) : "")
    .join("")
    .trim();

  return text;
}

function bitsFromByte(b: number): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (let i = 0; i < 8; i++) out[`bit${i}`] = !!(b & (1 << i));
  return out;
}

function parseExceptionStatusByte(status: number) {
  return {
    status,
    bits: bitsFromByte(status),
    // Device-specific meanings vary; provide bit map as human-readable starting point.
    notes: "Bits shown as bit0..bit7. Consult device documentation for semantic meanings.",
  };
}

function parseDiagnosticSubfunction(subfunction: number, data: number[]) {
  const echoedSubfunction = data.length >= 2 ? ((data[0] << 8) | data[1]) : subfunction;
  const payload = data.slice(2);

  if (echoedSubfunction === 0) {
    return {
      subfunction: echoedSubfunction,
      meaning: "Return Query Data",
      payloadHex: hexFromBytes(payload),
      payloadText: tryAscii(payload),
    };
  }

  return {
    subfunction: echoedSubfunction,
    payloadHex: hexFromBytes(payload),
    payloadText: tryAscii(payload),
  };
}

function parseComEventCounterRaw(status: number, eventCount: number) {
  return {
    status,
    eventCount,
    highByte: (status >> 8) & 0xff,
    lowByte: status & 0xff,
    bits: bitsFromByte(status & 0xff),
  };
}

function parseComEventEntryRaw(data: number[]) {
  return { length: data.length, hex: hexFromBytes(data), ascii: tryAscii(data) };
}

function parseServerIdResponse(data: number[]) {
  const byteCount = data[0] ?? 0;
  const serverId = data[1] ?? null;
  const runIndicator = data[2] ?? null;
  const additionalData = data.slice(3, 3 + Math.max(0, byteCount - 2));

  return {
    byteCount,
    serverId,
    runIndicator,
    isRunning: runIndicator === 0xff,
    additionalDataHex: hexFromBytes(additionalData),
    additionalDataText: tryAscii(additionalData),
  };
}

const DEVICE_ID_OBJECT_NAMES: Record<number, string> = {
  0: "VendorName",
  1: "ProductCode",
  2: "MajorMinorRevision",
  3: "VendorUrl",
  4: "ProductName",
  5: "ModelName",
  6: "UserApplicationName",
};

function parseDeviceIdentificationResponse(resp: { conformity?: number; objects: Array<{ id: number; value: string }> }) {
  return {
    conformity: resp.conformity,
    objects: resp.objects.map((o) => ({ id: o.id, name: DEVICE_ID_OBJECT_NAMES[o.id] ?? `object_${o.id}`, value: o.value })),
  };
}

export interface DiagnosticsParsed {
  rawHex: string;
  ascii: string;
  parsed?: Record<string, unknown> | Array<Record<string, unknown>>;
}

export const diagnosticsState = $state({
  readInProgress: false,
  cancelRequested: false,
  pollActive: false,
  pollInterval: 1000,

  exceptionStatus: null as DiagnosticsParsed | null,
  lastDiagnostic: null as DiagnosticsParsed | null,
  comEventCounter: null as DiagnosticsParsed | null,
  comEventLog: [] as DiagnosticsParsed[],
  serverId: null as DiagnosticsParsed | null,
  deviceIdentification: null as DiagnosticsParsed | null,
});

export function initDiagnosticsState(): void {
  // Placeholder: restore settings if needed in future
  diagnosticsState.pollInterval = 1000;
}

export async function readExceptionStatus(): Promise<void> {
  if (!ensureSerialOnly("Exception Status (FC07)")) return;

  diagnosticsState.readInProgress = true;
  diagnosticsState.cancelRequested = false;

  try {
    addLog("info", `fc07.read start`);
    const response = await invoke<{ status: number }>("read_exception_status");
    const bytes = [response.status & 0xff];
    diagnosticsState.exceptionStatus = {
      rawHex: hexFromBytes(bytes),
      ascii: tryAscii(bytes),
      parsed: parseExceptionStatusByte(response.status),
    };
    addLog("info", `fc07.read ok status=${response.status}`);
  } catch (err) {
    addLog("error", `fc07.read err msg=${parseInvokeError(err)}`);
    warnLocal(`Exception Status read failed: ${parseInvokeError(err)}`);
  } finally {
    diagnosticsState.readInProgress = false;
    diagnosticsState.cancelRequested = false;
  }
}

export async function runDiagnostic(subfunction: number, payloadHex?: string): Promise<void> {
  if (!ensureSerialOnly("Diagnostics (FC08)")) return;

  diagnosticsState.readInProgress = true;
  diagnosticsState.cancelRequested = false;

  try {
    const data: number[] = [];
    if (payloadHex) {
      const cleaned = payloadHex.replace(/[^0-9a-fA-F]/g, "");
      for (let i = 0; i < cleaned.length; i += 2) {
        const byte = cleaned.substring(i, i + 2);
        if (byte.length === 2) data.push(parseInt(byte, 16));
      }
    }

    addLog("info", `fc08.run sub=${subfunction} payload=${hexFromBytes(data)}`);
    const response = await invoke<{ data: number[] }>("diagnostic", { request: { subfunction, data } });
    diagnosticsState.lastDiagnostic = {
      rawHex: hexFromBytes(response.data),
      ascii: tryAscii(response.data),
      parsed: parseDiagnosticSubfunction(subfunction, response.data),
    };
    addLog("info", `fc08.run ok sub=${subfunction} len=${response.data.length}`);
  } catch (err) {
    addLog("error", `fc08.run err sub=${subfunction} msg=${parseInvokeError(err)}`);
    warnLocal(`Diagnostic run failed: ${parseInvokeError(err)}`);
  } finally {
    diagnosticsState.readInProgress = false;
    diagnosticsState.cancelRequested = false;
  }
}

export async function getComEventCounter(): Promise<void> {
  if (!ensureSerialOnly("Get Com Event Counter (FC11)")) return;

  diagnosticsState.readInProgress = true;
  diagnosticsState.cancelRequested = false;
  try {
    addLog("info", `fc11.read start`);
    const response = await invoke<{ status: number; eventCount: number }>("get_com_event_counter");
    const bytes = [
      (response.status >> 8) & 0xff,
      response.status & 0xff,
      (response.eventCount >> 8) & 0xff,
      response.eventCount & 0xff,
    ];
    diagnosticsState.comEventCounter = {
      rawHex: hexFromBytes(bytes),
      ascii: tryAscii(bytes),
      parsed: parseComEventCounterRaw(response.status, response.eventCount),
    };
    addLog("info", `fc11.read ok count=${response.eventCount}`);
  } catch (err) {
    addLog("error", `fc11.read err msg=${parseInvokeError(err)}`);
    warnLocal(`Get Com Event Counter failed: ${parseInvokeError(err)}`);
  } finally {
    diagnosticsState.readInProgress = false;
    diagnosticsState.cancelRequested = false;
  }
}

export async function getComEventLog(start?: number, count?: number): Promise<void> {
  if (!ensureSerialOnly("Get Com Event Log (FC12)")) return;

  diagnosticsState.readInProgress = true;
  diagnosticsState.cancelRequested = false;
  try {
    addLog("info", `fc12.read start start=${String(start)} count=${String(count)}`);
    const response = await invoke<{ entries: Array<{ data: number[] }> }>("get_com_event_log", {
      request: { start: start ?? 0, count: count ?? 100 },
    });
    diagnosticsState.comEventLog = response.entries.map((e) => ({
      rawHex: hexFromBytes(e.data),
      ascii: tryAscii(e.data),
      parsed: parseComEventEntryRaw(e.data),
    }));
    addLog("info", `fc12.read ok entries=${diagnosticsState.comEventLog.length}`);
  } catch (err) {
    addLog("error", `fc12.read err msg=${parseInvokeError(err)}`);
    warnLocal(`Get Com Event Log failed: ${parseInvokeError(err)}`);
  } finally {
    diagnosticsState.readInProgress = false;
    diagnosticsState.cancelRequested = false;
  }
}

export async function reportServerId(): Promise<void> {
  if (!ensureSerialOnly("Report Server ID (FC17)")) return;

  diagnosticsState.readInProgress = true;
  diagnosticsState.cancelRequested = false;
  try {
    addLog("info", `fc17.read start`);
    const response = await invoke<{ data: number[] }>("report_server_id");
    diagnosticsState.serverId = {
      rawHex: hexFromBytes(response.data),
      ascii: tryAscii(response.data),
      parsed: parseServerIdResponse(response.data),
    };
    addLog("info", `fc17.read ok len=${response.data.length}`);
  } catch (err) {
    addLog("error", `fc17.read err msg=${parseInvokeError(err)}`);
    warnLocal(`Report Server ID failed: ${parseInvokeError(err)}`);
  } finally {
    diagnosticsState.readInProgress = false;
    diagnosticsState.cancelRequested = false;
  }
}

export async function readDeviceIdentification(level: number, objectId?: number): Promise<void> {
  diagnosticsState.readInProgress = true;
  diagnosticsState.cancelRequested = false;
  try {
    // ReadDeviceIdCode: 1=Basic, 2=Regular, 3=Extended, 4=Individual (requires objectId)
    const normalizedLevel = Math.max(1, Math.min(4, Math.floor(level)));
    const normalizedObjectId = Math.max(0, Math.min(255, Math.floor(objectId ?? 0)));

    addLog("info", `fc43.read start level=${normalizedLevel} object=${normalizedObjectId}`);
    const response = await invoke<{ conformity?: number; objects: Array<{ id: number; value: string }> }>(
      "read_device_identification",
      { request: { level: normalizedLevel, objectId: normalizedObjectId } },
    );

    diagnosticsState.deviceIdentification = {
      rawHex: "",
      ascii: "",
      parsed: parseDeviceIdentificationResponse(response),
    };
    addLog("info", `fc43.read ok objects=${response.objects.length}`);
  } catch (err) {
    addLog("error", `fc43.read err msg=${parseInvokeError(err)}`);
    warnLocal(`Read Device Identification failed: ${parseInvokeError(err)}`);
  } finally {
    diagnosticsState.readInProgress = false;
    diagnosticsState.cancelRequested = false;
  }
}

export function cancelDiagnosticsRead(): void {
  if (!diagnosticsState.readInProgress) return;
  diagnosticsState.cancelRequested = true;
  if (diagnosticsState.pollActive) diagnosticsState.pollActive = false;
}

export function setDiagnosticsPollInterval(ms: number): void {
  diagnosticsState.pollInterval = Math.max(100, Math.floor(ms));
}

export function setDiagnosticsPollActive(active: boolean): void {
  diagnosticsState.pollActive = active;
}
