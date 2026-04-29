// Diagnostics state — serial-only guards, FC07/08/11/12/17/43 parse helpers
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  diagnosticsState,
  readExceptionStatus,
  runDiagnostic,
  getComEventCounter,
  getComEventLog,
  reportServerId,
  readDeviceIdentification,
  cancelDiagnosticsRead,
  setDiagnosticsPollInterval,
} from "../state/diagnostics.svelte";
import { connectionState } from "../state/connection.svelte";

const mockedInvoke = vi.mocked(invoke);

function resetState() {
  diagnosticsState.readInProgress = false;
  diagnosticsState.cancelRequested = false;
  diagnosticsState.pollActive = false;
  diagnosticsState.pollInterval = 1000;
  diagnosticsState.exceptionStatus = null;
  diagnosticsState.lastDiagnostic = null;
  diagnosticsState.comEventCounter = null;
  diagnosticsState.comEventLog = [];
  diagnosticsState.serverId = null;
  diagnosticsState.deviceIdentification = null;
  connectionState.protocol = "serial-rtu"; // default to serial for serial-only tests
  vi.clearAllMocks();
}

beforeEach(resetState);

// ── Serial-only guard ─────────────────────────────────────────────────────────

describe("serial-only guard (FC07, FC08, FC11, FC12, FC17)", () => {
  beforeEach(() => {
    connectionState.protocol = "tcp"; // TCP should be rejected for serial-only operations
  });

  it("readExceptionStatus does not invoke when protocol is TCP", async () => {
    await readExceptionStatus();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("runDiagnostic does not invoke when protocol is TCP", async () => {
    await runDiagnostic(0, "0000");
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("getComEventCounter does not invoke when protocol is TCP", async () => {
    await getComEventCounter();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("getComEventLog does not invoke when protocol is TCP", async () => {
    await getComEventLog();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("reportServerId does not invoke when protocol is TCP", async () => {
    await reportServerId();
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});

// ── readExceptionStatus ───────────────────────────────────────────────────────

describe("readExceptionStatus", () => {
  it("calls invoke('read_exception_status') and stores parsed result", async () => {
    mockedInvoke.mockResolvedValueOnce({ status: 0b10100001 });

    await readExceptionStatus();

    expect(mockedInvoke).toHaveBeenCalledWith("read_exception_status");
    expect(diagnosticsState.exceptionStatus).not.toBeNull();
    expect(diagnosticsState.exceptionStatus?.rawHex).toBeTruthy();
    expect(diagnosticsState.exceptionStatus?.parsed).toBeDefined();
  });

  it("stores bit map in parsed output", async () => {
    mockedInvoke.mockResolvedValueOnce({ status: 0xFF });

    await readExceptionStatus();

    const parsed = diagnosticsState.exceptionStatus?.parsed as Record<string, unknown>;
    expect(parsed?.status).toBe(0xFF);
    const bits = parsed?.bits as Record<string, boolean>;
    for (let i = 0; i < 8; i++) {
      expect(bits?.[`bit${i}`]).toBe(true);
    }
  });

  it("clears readInProgress after success", async () => {
    mockedInvoke.mockResolvedValueOnce({ status: 0 });
    await readExceptionStatus();
    expect(diagnosticsState.readInProgress).toBe(false);
  });

  it("clears readInProgress after error", async () => {
    mockedInvoke.mockRejectedValueOnce(JSON.stringify({ message: "Serial error", details: "" }));
    await readExceptionStatus();
    expect(diagnosticsState.readInProgress).toBe(false);
  });
});

// ── runDiagnostic ─────────────────────────────────────────────────────────────

describe("runDiagnostic", () => {
  it("calls invoke('diagnostic') with correct subfunction and data", async () => {
    mockedInvoke.mockResolvedValueOnce({ data: [0x00, 0x00, 0xAB, 0xCD] });

    await runDiagnostic(0, "ABCD");

    expect(mockedInvoke).toHaveBeenCalledWith("diagnostic", {
      request: { subfunction: 0, data: [0xAB, 0xCD] },
    });
  });

  it("parses subfunction 0 as 'Return Query Data'", async () => {
    mockedInvoke.mockResolvedValueOnce({ data: [0x00, 0x00, 0x11, 0x22] });

    await runDiagnostic(0, "1122");

    const parsed = diagnosticsState.lastDiagnostic?.parsed as Record<string, unknown>;
    expect(parsed?.meaning).toBe("Return Query Data");
  });

  it("stores rawHex of the response", async () => {
    mockedInvoke.mockResolvedValueOnce({ data: [0xDE, 0xAD] });

    await runDiagnostic(1, "");

    expect(diagnosticsState.lastDiagnostic?.rawHex).toBe("DE AD");
  });

  it("handles empty payload hex gracefully", async () => {
    mockedInvoke.mockResolvedValueOnce({ data: [] });

    await runDiagnostic(5, "");

    expect(mockedInvoke).toHaveBeenCalledWith("diagnostic", {
      request: { subfunction: 5, data: [] },
    });
  });

  it("clears readInProgress after error", async () => {
    mockedInvoke.mockRejectedValueOnce(JSON.stringify({ message: "Timeout", details: "" }));
    await runDiagnostic(0, "");
    expect(diagnosticsState.readInProgress).toBe(false);
  });
});

// ── getComEventCounter ────────────────────────────────────────────────────────

describe("getComEventCounter", () => {
  it("calls invoke('get_com_event_counter') and parses result", async () => {
    mockedInvoke.mockResolvedValueOnce({ status: 0xFFFF, eventCount: 42 });

    await getComEventCounter();

    expect(mockedInvoke).toHaveBeenCalledWith("get_com_event_counter");
    const parsed = diagnosticsState.comEventCounter?.parsed as Record<string, unknown>;
    expect(parsed?.eventCount).toBe(42);
    expect(parsed?.status).toBe(0xFFFF);
  });

  it("clears readInProgress after success", async () => {
    mockedInvoke.mockResolvedValueOnce({ status: 0, eventCount: 0 });
    await getComEventCounter();
    expect(diagnosticsState.readInProgress).toBe(false);
  });

  it("clears readInProgress after failure", async () => {
    mockedInvoke.mockRejectedValueOnce("Serial timeout");
    await getComEventCounter();
    expect(diagnosticsState.readInProgress).toBe(false);
  });
});

// ── getComEventLog ────────────────────────────────────────────────────────────

describe("getComEventLog", () => {
  it("calls invoke('get_com_event_log') and populates comEventLog", async () => {
    mockedInvoke.mockResolvedValueOnce({
      entries: [
        { data: [0x01, 0x02] },
        { data: [0x03] },
      ],
    });

    await getComEventLog();

    expect(diagnosticsState.comEventLog).toHaveLength(2);
    expect(diagnosticsState.comEventLog[0].rawHex).toBe("01 02");
    expect(diagnosticsState.comEventLog[1].rawHex).toBe("03");
  });

  it("passes start and count parameters", async () => {
    mockedInvoke.mockResolvedValueOnce({ entries: [] });

    await getComEventLog(5, 20);

    expect(mockedInvoke).toHaveBeenCalledWith("get_com_event_log", {
      request: { start: 5, count: 20 },
    });
  });

  it("uses default start=0 count=100 when not specified", async () => {
    mockedInvoke.mockResolvedValueOnce({ entries: [] });

    await getComEventLog();

    expect(mockedInvoke).toHaveBeenCalledWith("get_com_event_log", {
      request: { start: 0, count: 100 },
    });
  });
});

// ── reportServerId ────────────────────────────────────────────────────────────

describe("reportServerId", () => {
  it("calls invoke('report_server_id') and stores parsed result", async () => {
    mockedInvoke.mockResolvedValueOnce({ data: [0x02, 0x01, 0xFF, 0xAB] });

    await reportServerId();

    expect(mockedInvoke).toHaveBeenCalledWith("report_server_id");
    expect(diagnosticsState.serverId).not.toBeNull();
    const parsed = diagnosticsState.serverId?.parsed as Record<string, unknown>;
    expect(parsed?.serverId).toBe(0x01);
    expect(parsed?.isRunning).toBe(true); // runIndicator=0xFF
  });

  it("marks isRunning=false when runIndicator is not 0xFF", async () => {
    mockedInvoke.mockResolvedValueOnce({ data: [0x02, 0x01, 0x00] });

    await reportServerId();

    const parsed = diagnosticsState.serverId?.parsed as Record<string, unknown>;
    expect(parsed?.isRunning).toBe(false);
  });
});

// ── readDeviceIdentification ──────────────────────────────────────────────────

describe("readDeviceIdentification", () => {
  it("calls invoke('read_device_identification') and stores result", async () => {
    mockedInvoke.mockResolvedValueOnce({
      conformity: 1,
      objects: [
        { id: 0, value: "ACME Corp" },
        { id: 1, value: "Model-X" },
        { id: 2, value: "1.0.0" },
      ],
    });

    await readDeviceIdentification(1);

    expect(mockedInvoke).toHaveBeenCalledWith("read_device_identification", {
      request: { level: 1, objectId: 0 },
    });
    expect(diagnosticsState.deviceIdentification).not.toBeNull();
    const parsed = diagnosticsState.deviceIdentification?.parsed as Record<string, unknown>;
    const objects = parsed?.objects as Array<{ name: string; value: string }>;
    expect(objects.find((o) => o.name === "VendorName")?.value).toBe("ACME Corp");
  });

  it("clamps level to 1–4 range", async () => {
    mockedInvoke.mockResolvedValueOnce({ conformity: 1, objects: [] });

    await readDeviceIdentification(99);

    expect(mockedInvoke).toHaveBeenCalledWith("read_device_identification", {
      request: { level: 4, objectId: 0 },
    });
  });

  it("clamps level below 1 to 1", async () => {
    mockedInvoke.mockResolvedValueOnce({ conformity: 1, objects: [] });

    await readDeviceIdentification(0);

    expect(mockedInvoke).toHaveBeenCalledWith("read_device_identification", {
      request: { level: 1, objectId: 0 },
    });
  });

  it("is NOT serial-only (works with TCP)", async () => {
    connectionState.protocol = "tcp";
    mockedInvoke.mockResolvedValueOnce({ conformity: 1, objects: [] });

    await readDeviceIdentification(1);

    expect(mockedInvoke).toHaveBeenCalled();
  });

  it("clears readInProgress after error", async () => {
    mockedInvoke.mockRejectedValueOnce("Connection error");
    await readDeviceIdentification(1);
    expect(diagnosticsState.readInProgress).toBe(false);
  });
});

// ── cancelDiagnosticsRead ─────────────────────────────────────────────────────

describe("cancelDiagnosticsRead", () => {
  it("sets cancelRequested=true when a read is in progress", () => {
    diagnosticsState.readInProgress = true;
    cancelDiagnosticsRead();
    expect(diagnosticsState.cancelRequested).toBe(true);
  });

  it("does nothing when no read is in progress", () => {
    diagnosticsState.readInProgress = false;
    cancelDiagnosticsRead();
    expect(diagnosticsState.cancelRequested).toBe(false);
  });
});

// ── setDiagnosticsPollInterval ────────────────────────────────────────────────

describe("setDiagnosticsPollInterval", () => {
  it("sets a valid interval", () => {
    setDiagnosticsPollInterval(2000);
    expect(diagnosticsState.pollInterval).toBe(2000);
  });

  it("clamps to minimum 100 ms", () => {
    setDiagnosticsPollInterval(50);
    expect(diagnosticsState.pollInterval).toBe(100);
  });

  it("floors fractional value", () => {
    setDiagnosticsPollInterval(1500.9);
    expect(diagnosticsState.pollInterval).toBe(1500);
  });
});
