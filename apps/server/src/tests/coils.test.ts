import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  coilState,
  setCoilFilter,
  setCoilView,
  toggleCoilValue,
  setCoilValue,
  syncAllSlaveToDesired,
  setCoilLabel,
  addExclusiveCoil,
  removeCoil,
  removeAllCoils,
  getFilteredCoils,
  writeCoil,
  readCoil,
  buildMassPreview,
} from "../state/coils.svelte";
import type { CoilEntry } from "../state/coils.svelte";

const mockedInvoke = vi.mocked(invoke);

function makeEntry(address: number, overrides: Partial<CoilEntry> = {}): CoilEntry {
  return {
    address,
    slaveValue: false,
    desiredValue: false,
    pending: false,
    writeError: null,
    label: "",
    origin: "custom",
    ...overrides,
  };
}

function resetCoilState() {
  coilState.entries = [];
  coilState.view = "table";
  coilState.filter = "all";
  coilState.massFrom = 0;
  coilState.massTo = 15;
  coilState.massPattern = "alternating";
  coilState.massMode = "once";
  vi.clearAllMocks();
}

beforeEach(resetCoilState);

// ── Filter ────────────────────────────────────────────────────────────────────

describe("setCoilFilter / getFilteredCoils", () => {
  beforeEach(() => {
    coilState.entries = [
      makeEntry(0, { slaveValue: true }),
      makeEntry(1, { slaveValue: false }),
      makeEntry(2, { slaveValue: true }),
    ];
  });

  it("filter 'all' returns every entry", () => {
    setCoilFilter("all");
    expect(getFilteredCoils()).toHaveLength(3);
  });

  it("filter 'on' returns only entries with slaveValue true", () => {
    setCoilFilter("on");
    const result = getFilteredCoils();
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.slaveValue)).toBe(true);
  });

  it("filter 'off' returns only entries with slaveValue false", () => {
    setCoilFilter("off");
    const result = getFilteredCoils();
    expect(result).toHaveLength(1);
    expect(result[0].address).toBe(1);
  });
});

// ── View ──────────────────────────────────────────────────────────────────────

describe("setCoilView", () => {
  it("updates the view state", () => {
    setCoilView("switch");
    expect(coilState.view).toBe("switch");
  });

  it("persists the view in localStorage", () => {
    setCoilView("switch");
    expect(localStorage.getItem("Modbus-Lab.coilView")).toBe("switch");
    setCoilView("table");
    expect(localStorage.getItem("Modbus-Lab.coilView")).toBe("table");
  });
});

// ── Toggle & set value ────────────────────────────────────────────────────────

describe("toggleCoilValue", () => {
  beforeEach(() => {
    coilState.entries = [makeEntry(5, { desiredValue: false, writeError: "old error" })];
  });

  it("flips desiredValue from false to true", () => {
    toggleCoilValue(5);
    expect(coilState.entries[0].desiredValue).toBe(true);
  });

  it("flips desiredValue from true to false", () => {
    coilState.entries[0].desiredValue = true;
    toggleCoilValue(5);
    expect(coilState.entries[0].desiredValue).toBe(false);
  });

  it("clears writeError", () => {
    toggleCoilValue(5);
    expect(coilState.entries[0].writeError).toBeNull();
  });

  it("does nothing for an unknown address", () => {
    const before = { ...coilState.entries[0] };
    toggleCoilValue(99);
    expect(coilState.entries[0].desiredValue).toBe(before.desiredValue);
  });
});

describe("setCoilValue", () => {
  beforeEach(() => {
    coilState.entries = [makeEntry(10, { writeError: "stale" })];
  });

  it("sets desiredValue to true", () => {
    setCoilValue(10, true);
    expect(coilState.entries[0].desiredValue).toBe(true);
  });

  it("sets desiredValue to false", () => {
    coilState.entries[0].desiredValue = true;
    setCoilValue(10, false);
    expect(coilState.entries[0].desiredValue).toBe(false);
  });

  it("clears writeError", () => {
    setCoilValue(10, true);
    expect(coilState.entries[0].writeError).toBeNull();
  });
});

// ── syncAllSlaveToDesired ─────────────────────────────────────────────────────

describe("syncAllSlaveToDesired", () => {
  it("resets desiredValue to match slaveValue", () => {
    coilState.entries = [makeEntry(0, { slaveValue: true, desiredValue: false })];
    syncAllSlaveToDesired();
    expect(coilState.entries[0].desiredValue).toBe(true);
  });

  it("clears writeError on all entries", () => {
    coilState.entries = [makeEntry(0, { writeError: "err" }), makeEntry(1, { writeError: "err2" })];
    syncAllSlaveToDesired();
    expect(coilState.entries.every((e) => e.writeError === null)).toBe(true);
  });

  it("returns count of entries that had a mismatch or error", () => {
    coilState.entries = [
      makeEntry(0, { slaveValue: true, desiredValue: false }),  // mismatch
      makeEntry(1, { slaveValue: false, desiredValue: false }), // match
      makeEntry(2, { slaveValue: false, writeError: "err" }),   // error
    ];
    const count = syncAllSlaveToDesired();
    expect(count).toBe(2);
  });

  it("returns 0 when all entries already match", () => {
    coilState.entries = [makeEntry(0), makeEntry(1)];
    expect(syncAllSlaveToDesired()).toBe(0);
  });
});

// ── Labels ────────────────────────────────────────────────────────────────────

describe("setCoilLabel", () => {
  it("sets a label on a known address", () => {
    coilState.entries = [makeEntry(7)];
    setCoilLabel(7, "pump");
    expect(coilState.entries[0].label).toBe("pump");
  });

  it("does nothing for an unknown address", () => {
    coilState.entries = [makeEntry(7)];
    setCoilLabel(99, "nothing");
    expect(coilState.entries[0].label).toBe("");
  });
});

// ── addExclusiveCoil ──────────────────────────────────────────────────────────

describe("addExclusiveCoil", () => {
  it("adds a new coil entry and returns true", () => {
    expect(addExclusiveCoil(42)).toBe(true);
    expect(coilState.entries).toHaveLength(1);
    expect(coilState.entries[0].address).toBe(42);
  });

  it("returns false for a duplicate address", () => {
    addExclusiveCoil(42);
    expect(addExclusiveCoil(42)).toBe(false);
    expect(coilState.entries).toHaveLength(1);
  });

  it("rejects negative addresses", () => {
    expect(addExclusiveCoil(-1)).toBe(false);
    expect(coilState.entries).toHaveLength(0);
  });

  it("rejects addresses above 65535", () => {
    expect(addExclusiveCoil(65536)).toBe(false);
    expect(coilState.entries).toHaveLength(0);
  });

  it("accepts boundary values 0 and 65535", () => {
    expect(addExclusiveCoil(0)).toBe(true);
    expect(addExclusiveCoil(65535)).toBe(true);
    expect(coilState.entries).toHaveLength(2);
  });

  it("floors fractional addresses", () => {
    addExclusiveCoil(10.9);
    expect(coilState.entries[0].address).toBe(10);
  });

  it("keeps entries sorted ascending by address", () => {
    addExclusiveCoil(30);
    addExclusiveCoil(10);
    addExclusiveCoil(20);
    const addrs = coilState.entries.map((e) => e.address);
    expect(addrs).toEqual([10, 20, 30]);
  });

  it("marks the added entry as custom origin", () => {
    addExclusiveCoil(5);
    expect(coilState.entries[0].origin).toBe("custom");
  });
});

// ── removeCoil / removeAllCoils ───────────────────────────────────────────────

describe("removeCoil", () => {
  it("removes the entry with the given address", () => {
    coilState.entries = [makeEntry(1), makeEntry(2), makeEntry(3)];
    removeCoil(2);
    expect(coilState.entries.map((e) => e.address)).toEqual([1, 3]);
  });

  it("does nothing for an unknown address", () => {
    coilState.entries = [makeEntry(5)];
    removeCoil(99);
    expect(coilState.entries).toHaveLength(1);
  });
});

describe("removeAllCoils", () => {
  it("empties the entries array", () => {
    coilState.entries = [makeEntry(1), makeEntry(2)];
    removeAllCoils();
    expect(coilState.entries).toHaveLength(0);
  });
});

// ── writeCoil ─────────────────────────────────────────────────────────────────

describe("writeCoil", () => {
  it("calls invoke('write_coil') with the address and desired value", async () => {
    coilState.entries = [makeEntry(3, { desiredValue: true })];
    mockedInvoke.mockResolvedValueOnce({ address: 3, value: true });

    await writeCoil(3);

    expect(mockedInvoke).toHaveBeenCalledWith("write_coil", {
      request: { address: 3, value: true },
    });
  });

  it("updates slaveValue on success and clears pending", async () => {
    coilState.entries = [makeEntry(3, { desiredValue: true })];
    mockedInvoke.mockResolvedValueOnce({ address: 3, value: true });

    await writeCoil(3);

    expect(coilState.entries[0].slaveValue).toBe(true);
    expect(coilState.entries[0].pending).toBe(false);
    expect(coilState.entries[0].writeError).toBeNull();
  });

  it("sets writeError and clears pending on failure", async () => {
    coilState.entries = [makeEntry(3)];
    mockedInvoke.mockRejectedValueOnce(JSON.stringify({ message: "Timeout", details: "" }));

    await writeCoil(3);

    expect(coilState.entries[0].writeError).toBeTruthy();
    expect(coilState.entries[0].pending).toBe(false);
  });

  it("does nothing for an unknown address", async () => {
    coilState.entries = [makeEntry(5)];
    await writeCoil(99);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});

// ── readCoil ──────────────────────────────────────────────────────────────────

describe("readCoil", () => {
  it("calls invoke('read_coils') with the address", async () => {
    coilState.entries = [makeEntry(7)];
    mockedInvoke.mockResolvedValueOnce({
      coils: [{ address: 7, value: true }],
      startAddress: 7,
      quantity: 1,
    });

    await readCoil(7);

    expect(mockedInvoke).toHaveBeenCalledWith("read_coils", {
      request: { startAddress: 7, quantity: 1 },
    });
  });

  it("updates slaveValue on success", async () => {
    coilState.entries = [makeEntry(7)];
    mockedInvoke.mockResolvedValueOnce({
      coils: [{ address: 7, value: true }],
      startAddress: 7,
      quantity: 1,
    });

    await readCoil(7);

    expect(coilState.entries[0].slaveValue).toBe(true);
    expect(coilState.entries[0].pending).toBe(false);
    expect(coilState.entries[0].writeError).toBeNull();
  });

  it("sets writeError including details on failure", async () => {
    coilState.entries = [makeEntry(7)];
    mockedInvoke.mockRejectedValueOnce(
      JSON.stringify({ message: "Slave exception", details: "ILLEGAL_DATA_ADDRESS" })
    );

    await readCoil(7);

    expect(coilState.entries[0].writeError).toBe("Slave exception (ILLEGAL_DATA_ADDRESS)");
  });

  it("sets writeError without details when details is empty", async () => {
    coilState.entries = [makeEntry(7)];
    mockedInvoke.mockRejectedValueOnce(
      JSON.stringify({ message: "Timeout", details: "" })
    );

    await readCoil(7);

    expect(coilState.entries[0].writeError).toBe("Timeout");
  });

  it("does nothing for an unknown address", async () => {
    coilState.entries = [makeEntry(5)];
    await readCoil(99);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});

// ── buildMassPreview ──────────────────────────────────────────────────────────

describe("buildMassPreview", () => {
  it("returns '—' when no entries fall in range", () => {
    coilState.entries = [];
    expect(buildMassPreview()).toBe("—");
  });

  it("returns a string starting with the coil count", () => {
    coilState.entries = Array.from({ length: 16 }, (_, i) => makeEntry(i));
    coilState.massFrom = 0;
    coilState.massTo = 15;
    coilState.massPattern = "all-on";
    expect(buildMassPreview()).toMatch(/^16 coils:/);
  });

  it("all-on produces only '1' bits", () => {
    coilState.entries = Array.from({ length: 8 }, (_, i) => makeEntry(i));
    coilState.massFrom = 0;
    coilState.massTo = 7;
    coilState.massPattern = "all-on";
    expect(buildMassPreview()).toBe("8 coils: 1 1 1 1 1 1 1 1");
  });

  it("all-off produces only '0' bits", () => {
    coilState.entries = Array.from({ length: 8 }, (_, i) => makeEntry(i));
    coilState.massFrom = 0;
    coilState.massTo = 7;
    coilState.massPattern = "all-off";
    expect(buildMassPreview()).toBe("8 coils: 0 0 0 0 0 0 0 0");
  });

  it("alternating produces '1 0' pattern", () => {
    coilState.entries = Array.from({ length: 4 }, (_, i) => makeEntry(i));
    coilState.massFrom = 0;
    coilState.massTo = 3;
    coilState.massPattern = "alternating";
    expect(buildMassPreview()).toBe("4 coils: 1 0 1 0");
  });

  it("alternating-inv produces '0 1' pattern", () => {
    coilState.entries = Array.from({ length: 4 }, (_, i) => makeEntry(i));
    coilState.massFrom = 0;
    coilState.massTo = 3;
    coilState.massPattern = "alternating-inv";
    expect(buildMassPreview()).toBe("4 coils: 0 1 0 1");
  });

  it("random produces '?' placeholders", () => {
    coilState.entries = Array.from({ length: 8 }, (_, i) => makeEntry(i));
    coilState.massFrom = 0;
    coilState.massTo = 7;
    coilState.massPattern = "random";
    expect(buildMassPreview()).toBe("8 coils: ? ? ? ? ? ? ? ?");
  });

  it("single coil uses singular 'coil' form", () => {
    coilState.entries = [makeEntry(5)];
    coilState.massFrom = 5;
    coilState.massTo = 5;
    coilState.massPattern = "all-on";
    expect(buildMassPreview()).toBe("1 coil: 1");
  });
});
