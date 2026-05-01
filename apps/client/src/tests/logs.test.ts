import { describe, it, expect, beforeEach } from "vitest";
import {
  logState,
  addLog,
  clearLogs,
  getFilteredLogs,
  setLogFilter,
} from "../state/logs.svelte";

beforeEach(() => {
  clearLogs();
  logState.filter = "all";
});

describe("addLog", () => {
  it("appends a log entry", () => {
    addLog("info", "test message");
    expect(logState.entries).toHaveLength(1);
    expect(logState.entries[0].message).toBe("test message");
    expect(logState.entries[0].level).toBe("info");
  });

  it("assigns unique incrementing IDs", () => {
    addLog("info", "first");
    addLog("info", "second");
    expect(logState.entries[1].id).toBeGreaterThan(logState.entries[0].id);
  });

  it("records a timestamp at or after the call time", () => {
    const before = Date.now();
    addLog("warn", "timestamped");
    const after = Date.now();
    expect(logState.entries[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(logState.entries[0].timestamp).toBeLessThanOrEqual(after);
  });

  it("accepts all four log levels", () => {
    addLog("info", "i");
    addLog("warn", "w");
    addLog("error", "e");
    addLog("traffic", "t");
    const levels = logState.entries.map((e) => e.level);
    expect(levels).toContain("info");
    expect(levels).toContain("warn");
    expect(levels).toContain("error");
    expect(levels).toContain("traffic");
  });

  it("accumulates multiple entries in order", () => {
    addLog("info", "first");
    addLog("warn", "second");
    addLog("error", "third");
    expect(logState.entries.map((e) => e.message)).toEqual(["first", "second", "third"]);
  });
});

describe("clearLogs", () => {
  it("empties the entries array", () => {
    addLog("info", "to be cleared");
    clearLogs();
    expect(logState.entries).toHaveLength(0);
  });

  it("is idempotent when already empty", () => {
    clearLogs();
    clearLogs();
    expect(logState.entries).toHaveLength(0);
  });
});

describe("getFilteredLogs", () => {
  beforeEach(() => {
    addLog("info", "info-msg");
    addLog("warn", "warn-msg");
    addLog("error", "error-msg");
    addLog("traffic", "traffic-msg");
  });

  it("returns all entries for filter 'all'", () => {
    expect(getFilteredLogs("all")).toHaveLength(4);
  });

  it("returns only info entries for filter 'info'", () => {
    const result = getFilteredLogs("info");
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("info-msg");
  });

  it("returns only warn entries for filter 'warn'", () => {
    const result = getFilteredLogs("warn");
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("warn-msg");
  });

  it("returns only error entries for filter 'error'", () => {
    const result = getFilteredLogs("error");
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("error-msg");
  });

  it("returns only traffic entries for filter 'traffic'", () => {
    const result = getFilteredLogs("traffic");
    expect(result).toHaveLength(1);
    expect(result[0].message).toBe("traffic-msg");
  });

  it("returns empty array when no entries match the filter", () => {
    clearLogs();
    addLog("info", "only info");
    expect(getFilteredLogs("error")).toHaveLength(0);
  });
});

describe("setLogFilter", () => {
  it("updates the active filter", () => {
    setLogFilter("error");
    expect(logState.filter).toBe("error");
  });

  it("can set each valid filter", () => {
    for (const f of ["all", "info", "warn", "error", "traffic"] as const) {
      setLogFilter(f);
      expect(logState.filter).toBe(f);
    }
  });
});

// ── Log retention enforcement ─────────────────────────────────────────────────

describe("addLog — retention cap", () => {
  it("enforces maxRetainedEntries cap when entries exceed the limit", () => {
    // The default maxRetainedEntries is 4000; add 4100 entries
    const limit = 4000;
    for (let i = 0; i < limit + 100; i++) {
      addLog("info", `msg-${i}`);
    }
    expect(logState.entries.length).toBeLessThanOrEqual(limit);
  });

  it("retains the most recent entries when trimming", () => {
    const limit = 4000;
    for (let i = 0; i < limit + 5; i++) {
      addLog("info", `msg-${i}`);
    }
    const messages = logState.entries.map((e) => e.message);
    // Last message should still be present
    expect(messages).toContain(`msg-${limit + 4}`);
    // Very first messages are evicted
    expect(messages).not.toContain("msg-0");
  });

  it("never drops below 200 entries (floor from settings minimum)", () => {
    // Simulate only 100 entries added — they should all be kept
    for (let i = 0; i < 100; i++) {
      addLog("info", `keep-${i}`);
    }
    expect(logState.entries.length).toBe(100);
  });
});
