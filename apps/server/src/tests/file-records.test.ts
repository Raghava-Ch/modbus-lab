import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { connectionState } from "../state/connection.svelte";
import {
  clearFileRecordResult,
  clearFileRecordSegments,
  executeFileRecord,
  fileRecordState,
  importFileRecordScenarioJson,
  initFileRecordState,
  saveFileRecordScenario,
  loadFileRecordScenario,
  setFileRecordMode,
  setFileRecordSegmentNumber,
  setFileRecordSegmentWriteValues,
  teardownFileRecordState,
} from "../state/file-records.svelte";

function resetFileRecordState(): void {
  teardownFileRecordState();
  clearFileRecordResult();
  clearFileRecordSegments();
  fileRecordState.mode = "read";
  fileRecordState.pending = false;
  fileRecordState.error = "";
  fileRecordState.history = [];
  fileRecordState.lastExecution = null;
  fileRecordState.scenarios = [];
  fileRecordState.selectedScenarioName = "";
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.clear();
  }
  if (typeof localStorage !== "undefined") {
    localStorage.clear();
  }
  initFileRecordState();
}

describe("file-records state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionState.status = "connected";
    resetFileRecordState();
  });

  it("executes FC20 read and parses returned values", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      functionCode: 0x14,
      requestHex: "0706000100000001",
      responseHex: "0403061234",
      requestSummary: "fc20 req",
      responseSummary: "fc20 rsp",
    });

    await executeFileRecord(false);

    expect(invoke).toHaveBeenCalledWith("store_read_file_records", {
      request: {
        payloadHex: "0706000100000001",
      },
    });

    expect(fileRecordState.error).toBe("");
    expect(fileRecordState.lastExecution).not.toBeNull();
    expect(fileRecordState.lastExecution?.functionCode).toBe(0x14);
    expect(fileRecordState.lastExecution?.parsedSegments.length).toBe(1);
    expect(fileRecordState.lastExecution?.parsedSegments[0].values).toEqual([0x1234]);
  });

  it("executes FC21 write and sends store_write_file_records command", async () => {
    setFileRecordMode("write");
    setFileRecordSegmentNumber(fileRecordState.segments[0].id, "wordCount", 1);
    setFileRecordSegmentWriteValues(fileRecordState.segments[0].id, "0x000A");

    vi.mocked(invoke).mockResolvedValueOnce({
      functionCode: 0x15,
      requestHex: "0906000100000001000A",
      responseHex: "0906000100000001000A",
      requestSummary: "fc21 req",
      responseSummary: "fc21 rsp",
    });

    await executeFileRecord(false);

    expect(invoke).toHaveBeenCalledWith("store_write_file_records", {
      request: {
        payloadHex: "0906000100000001000A",
      },
    });

    expect(fileRecordState.error).toBe("");
    expect(fileRecordState.lastExecution?.functionCode).toBe(0x15);
    expect(fileRecordState.lastExecution?.parsedSegments[0].values).toEqual([0x000A]);
  });

  it("fails fast when write values do not match word count", async () => {
    setFileRecordMode("write");
    setFileRecordSegmentNumber(fileRecordState.segments[0].id, "wordCount", 2);
    setFileRecordSegmentWriteValues(fileRecordState.segments[0].id, "1");

    await executeFileRecord(false);

    expect(invoke).not.toHaveBeenCalled();
    expect(fileRecordState.error).toContain("expects 2 values, got 1");
  });

  it("imports, saves, and loads scenarios", () => {
    importFileRecordScenarioJson(JSON.stringify({
      scenario: {
        name: "WriteDemo",
        mode: "write",
        pollInterval: 1500,
        segments: [
          {
            fileNumber: 2,
            recordNumber: 3,
            wordCount: 1,
            writeValuesText: "42",
          },
        ],
      },
    }));

    expect(fileRecordState.mode).toBe("write");
    expect(fileRecordState.segments[0].fileNumber).toBe(2);

    saveFileRecordScenario("MyScenario");
    expect(fileRecordState.scenarios.length).toBe(1);

    clearFileRecordSegments();
    setFileRecordMode("read");

    loadFileRecordScenario("MyScenario");
    expect(fileRecordState.mode).toBe("write");
    expect(fileRecordState.segments[0].fileNumber).toBe(2);
    expect(fileRecordState.selectedScenarioName).toBe("MyScenario");
  });
});
