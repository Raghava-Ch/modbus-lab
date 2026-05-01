// Server: Holding Registers state — rule normalization, write→store_write_holding_reg
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  holdingRegisterState,
  applyHoldingRegisterRange,
  addHoldingRegisterRange,
  addExclusiveHoldingRegister,
  generateRandomExclusiveHoldingRegisterAddress,
  removeHoldingRegister,
  removeAllHoldingRegisters,
  setHoldingRegisterFilter,
  setHoldingRegisterView,
  setHoldingRegisterLabel,
  setHoldingRegisterDesiredValue,
  setHoldingRegisterAddressFilter,
  setHoldingRegisterAddressRange,
  setHoldingRegisterAddressList,
  writeHoldingRegister,
  setHoldingRegisterRule,
  clearAllHoldingRegisterRules,
  getFilteredHoldingRegisters,
} from "../state/holding-registers.svelte";
import type { HoldingRegisterEntry, HoldingRegRule } from "../state/holding-registers.svelte";

const mockedInvoke = vi.mocked(invoke);

function makeEntry(address: number, overrides: Partial<HoldingRegisterEntry> = {}): HoldingRegisterEntry {
  return {
    address,
    slaveValue: 0,
    desiredValue: 0,
    pending: false,
    readError: null,
    writeError: null,
    lastReadAt: null,
    lastWriteAt: null,
    label: "",
    origin: "custom",
    rule: { type: "none", intervalMs: 1000, minValue: 0, maxValue: 100, step: 1, periodMs: 4000 },
    ...overrides,
  };
}

function makeRule(overrides: Partial<HoldingRegRule> = {}): HoldingRegRule {
  return {
    type: "none",
    intervalMs: 1000,
    minValue: 0,
    maxValue: 100,
    step: 1,
    periodMs: 4000,
    ...overrides,
  };
}

function resetState() {
  clearAllHoldingRegisterRules();
  holdingRegisterState.entries = [];
  holdingRegisterState.view = "table";
  holdingRegisterState.filter = "all";
  holdingRegisterState.addressFilter = "all";
  holdingRegisterState.addressRangeStart = 0;
  holdingRegisterState.addressRangeEnd = 0;
  holdingRegisterState.addressList = [];
  holdingRegisterState.startAddress = 0;
  holdingRegisterState.registerCount = 16;
  vi.clearAllMocks();
  // Stub invoke to avoid errors from syncHoldingRegAddressesToBackend
  mockedInvoke.mockResolvedValue([]);
}

beforeEach(resetState);

// ── applyHoldingRegisterRange ─────────────────────────────────────────────────

describe("applyHoldingRegisterRange", () => {
  it("generates correct entries from start+count", () => {
    applyHoldingRegisterRange(10, 5);
    expect(holdingRegisterState.entries).toHaveLength(5);
    expect(holdingRegisterState.entries[0].address).toBe(10);
    expect(holdingRegisterState.entries[4].address).toBe(14);
  });

  it("clamps negative start to 0", () => {
    applyHoldingRegisterRange(-5, 4);
    expect(holdingRegisterState.startAddress).toBe(0);
  });

  it("clamps start above 65535 to 65535", () => {
    applyHoldingRegisterRange(70000, 1);
    expect(holdingRegisterState.startAddress).toBe(65535);
  });

  it("clamps count to minimum 1", () => {
    applyHoldingRegisterRange(0, 0);
    expect(holdingRegisterState.entries).toHaveLength(1);
  });

  it("clamps very large negative start to 0", () => {
    applyHoldingRegisterRange(-50000, 2);
    expect(holdingRegisterState.startAddress).toBe(0);
  });

  it("handles Infinity count", () => {
    applyHoldingRegisterRange(0, Infinity);
    expect(holdingRegisterState.entries.length).toBeGreaterThan(0);
  });

  it("all generated entries have origin 'range'", () => {
    applyHoldingRegisterRange(0, 5);
    expect(holdingRegisterState.entries.every((e) => e.origin === "range")).toBe(true);
  });

  it("preserves existing slaveValue/desiredValue for overlapping addresses", () => {
    applyHoldingRegisterRange(0, 4);
    holdingRegisterState.entries[1].slaveValue = 999;
    holdingRegisterState.entries[1].desiredValue = 999;
    applyHoldingRegisterRange(0, 4);
    expect(holdingRegisterState.entries[1].slaveValue).toBe(999);
    expect(holdingRegisterState.entries[1].desiredValue).toBe(999);
  });

  it("preserves label for overlapping addresses", () => {
    applyHoldingRegisterRange(0, 4);
    holdingRegisterState.entries[0].label = "tank level";
    applyHoldingRegisterRange(0, 4);
    expect(holdingRegisterState.entries[0].label).toBe("tank level");
  });

  it("preserves rule for overlapping addresses", () => {
    applyHoldingRegisterRange(0, 4);
    holdingRegisterState.entries[0].rule.type = "cycle";
    applyHoldingRegisterRange(0, 4);
    expect(holdingRegisterState.entries[0].rule.type).toBe("cycle");
  });
});

// ── addHoldingRegisterRange ───────────────────────────────────────────────────

describe("addHoldingRegisterRange", () => {
  it("merges without removing existing entries", () => {
    applyHoldingRegisterRange(0, 4);
    addHoldingRegisterRange(2, 6);
    const addrs = holdingRegisterState.entries.map((e) => e.address);
    expect(addrs).toContain(0);
    expect(addrs).toContain(7);
  });

  it("does not duplicate addresses", () => {
    applyHoldingRegisterRange(0, 4);
    addHoldingRegisterRange(0, 4);
    const addrs = holdingRegisterState.entries.map((e) => e.address);
    expect(new Set(addrs).size).toBe(addrs.length);
  });
});

// ── addExclusiveHoldingRegister ───────────────────────────────────────────────

describe("addExclusiveHoldingRegister", () => {
  it("adds a new register and returns true", () => {
    expect(addExclusiveHoldingRegister(100)).toBe(true);
    expect(holdingRegisterState.entries).toHaveLength(1);
  });

  it("calls store_write_holding_reg on add", () => {
    addExclusiveHoldingRegister(50);
    expect(mockedInvoke).toHaveBeenCalledWith("store_write_holding_reg", { address: 50, value: 0 });
  });

  it("returns false for duplicate address", () => {
    addExclusiveHoldingRegister(100);
    mockedInvoke.mockClear();
    expect(addExclusiveHoldingRegister(100)).toBe(false);
    expect(mockedInvoke).not.toHaveBeenCalledWith("store_write_holding_reg", expect.any(Object));
  });

  it("rejects address < 0", () => {
    expect(addExclusiveHoldingRegister(-1)).toBe(false);
  });

  it("rejects address > 65535", () => {
    expect(addExclusiveHoldingRegister(65536)).toBe(false);
  });

  it("floors fractional addresses", () => {
    addExclusiveHoldingRegister(7.8);
    expect(holdingRegisterState.entries[0].address).toBe(7);
  });

  it("marks the entry as custom origin", () => {
    addExclusiveHoldingRegister(5);
    expect(holdingRegisterState.entries[0].origin).toBe("custom");
  });

  it("keeps entries sorted", () => {
    addExclusiveHoldingRegister(50);
    addExclusiveHoldingRegister(20);
    addExclusiveHoldingRegister(80);
    expect(holdingRegisterState.entries.map((e) => e.address)).toEqual([20, 50, 80]);
  });
});

// ── removeHoldingRegister / removeAllHoldingRegisters ─────────────────────────

describe("removeHoldingRegister", () => {
  it("removes the matching entry and calls store_remove_holding_reg", () => {
    holdingRegisterState.entries = [makeEntry(1), makeEntry(2), makeEntry(3)];
    removeHoldingRegister(2);
    expect(holdingRegisterState.entries.map((e) => e.address)).toEqual([1, 3]);
    expect(mockedInvoke).toHaveBeenCalledWith("store_remove_holding_reg", { address: 2 });
  });

  it("does nothing for an unknown address", () => {
    holdingRegisterState.entries = [makeEntry(5)];
    removeHoldingRegister(99);
    expect(holdingRegisterState.entries).toHaveLength(1);
  });
});

describe("removeAllHoldingRegisters", () => {
  it("clears entries and calls store_clear_holding_regs", () => {
    holdingRegisterState.entries = [makeEntry(1), makeEntry(2)];
    removeAllHoldingRegisters();
    expect(holdingRegisterState.entries).toHaveLength(0);
    expect(mockedInvoke).toHaveBeenCalledWith("store_clear_holding_regs", {});
  });
});

// ── writeHoldingRegister ──────────────────────────────────────────────────────

describe("writeHoldingRegister", () => {
  it("calls invoke('store_write_holding_reg') with address and desiredValue", async () => {
    holdingRegisterState.entries = [makeEntry(7, { desiredValue: 1024 })];
    mockedInvoke.mockResolvedValueOnce(undefined);

    await writeHoldingRegister(7);

    expect(mockedInvoke).toHaveBeenCalledWith("store_write_holding_reg", { address: 7, value: 1024 });
  });

  it("updates slaveValue on success", async () => {
    holdingRegisterState.entries = [makeEntry(7, { desiredValue: 512 })];
    mockedInvoke.mockResolvedValueOnce(undefined);

    await writeHoldingRegister(7);

    expect(holdingRegisterState.entries[0].slaveValue).toBe(512);
    expect(holdingRegisterState.entries[0].pending).toBe(false);
    expect(holdingRegisterState.entries[0].writeError).toBeNull();
  });

  it("sets writeError on failure", async () => {
    holdingRegisterState.entries = [makeEntry(7, { desiredValue: 100 })];
    mockedInvoke.mockRejectedValueOnce(JSON.stringify({ message: "Bus error", details: "ILLEGAL_DATA_ADDRESS" }));

    await writeHoldingRegister(7);

    expect(holdingRegisterState.entries[0].writeError).toBe("Bus error (ILLEGAL_DATA_ADDRESS)");
    expect(holdingRegisterState.entries[0].pending).toBe(false);
  });

  it("does nothing for an unknown address", async () => {
    holdingRegisterState.entries = [makeEntry(5)];
    await writeHoldingRegister(99);
    expect(mockedInvoke).not.toHaveBeenCalledWith("store_write_holding_reg", expect.any(Object));
  });

  it("skips write when pending=true", async () => {
    holdingRegisterState.entries = [makeEntry(7, { pending: true })];
    await writeHoldingRegister(7);
    expect(mockedInvoke).not.toHaveBeenCalledWith("store_write_holding_reg", expect.any(Object));
  });
});

// ── setHoldingRegisterDesiredValue ────────────────────────────────────────────

describe("setHoldingRegisterDesiredValue", () => {
  it("sets a valid value", () => {
    holdingRegisterState.entries = [makeEntry(5)];
    setHoldingRegisterDesiredValue(5, 1234);
    expect(holdingRegisterState.entries[0].desiredValue).toBe(1234);
  });

  it("clamps to 0 for negative input", () => {
    holdingRegisterState.entries = [makeEntry(5)];
    setHoldingRegisterDesiredValue(5, -10);
    expect(holdingRegisterState.entries[0].desiredValue).toBe(0);
  });

  it("clamps to 65535 for over-range input", () => {
    holdingRegisterState.entries = [makeEntry(5)];
    setHoldingRegisterDesiredValue(5, 99999);
    expect(holdingRegisterState.entries[0].desiredValue).toBe(65535);
  });

  it("clears writeError", () => {
    holdingRegisterState.entries = [makeEntry(5, { writeError: "stale" })];
    setHoldingRegisterDesiredValue(5, 10);
    expect(holdingRegisterState.entries[0].writeError).toBeNull();
  });
});

// ── setHoldingRegisterRule / normalizeRule ────────────────────────────────────

describe("setHoldingRegisterRule — normalizeRule", () => {
  it("normalizes minValue > maxValue by swapping them", () => {
    holdingRegisterState.entries = [makeEntry(10)];
    setHoldingRegisterRule(10, makeRule({ minValue: 200, maxValue: 50 }));
    expect(holdingRegisterState.entries[0].rule.minValue).toBe(50);
    expect(holdingRegisterState.entries[0].rule.maxValue).toBe(200);
  });

  it("clamps intervalMs to minimum 100", () => {
    holdingRegisterState.entries = [makeEntry(10)];
    setHoldingRegisterRule(10, makeRule({ intervalMs: 10 }));
    expect(holdingRegisterState.entries[0].rule.intervalMs).toBeGreaterThanOrEqual(100);
  });

  it("clamps periodMs to minimum 200", () => {
    holdingRegisterState.entries = [makeEntry(10)];
    setHoldingRegisterRule(10, makeRule({ periodMs: 50 }));
    expect(holdingRegisterState.entries[0].rule.periodMs).toBeGreaterThanOrEqual(200);
  });

  it("clamps step to minimum 1", () => {
    holdingRegisterState.entries = [makeEntry(10)];
    setHoldingRegisterRule(10, makeRule({ step: 0 }));
    expect(holdingRegisterState.entries[0].rule.step).toBe(1);
  });

  it("does nothing for an unknown address", () => {
    holdingRegisterState.entries = [makeEntry(10)];
    setHoldingRegisterRule(99, makeRule({ type: "cycle" }));
    expect(holdingRegisterState.entries[0].rule.type).toBe("none");
  });

  it("sets type 'cycle'", () => {
    holdingRegisterState.entries = [makeEntry(10)];
    setHoldingRegisterRule(10, makeRule({ type: "cycle" }));
    expect(holdingRegisterState.entries[0].rule.type).toBe("cycle");
  });

  it("sets type 'sawtooth'", () => {
    holdingRegisterState.entries = [makeEntry(10)];
    setHoldingRegisterRule(10, makeRule({ type: "sawtooth" }));
    expect(holdingRegisterState.entries[0].rule.type).toBe("sawtooth");
  });

  it("sets type 'triangle'", () => {
    holdingRegisterState.entries = [makeEntry(10)];
    setHoldingRegisterRule(10, makeRule({ type: "triangle" }));
    expect(holdingRegisterState.entries[0].rule.type).toBe("triangle");
  });

  it("sets type 'sine'", () => {
    holdingRegisterState.entries = [makeEntry(10)];
    setHoldingRegisterRule(10, makeRule({ type: "sine" }));
    expect(holdingRegisterState.entries[0].rule.type).toBe("sine");
  });
});

// ── clearAllHoldingRegisterRules ──────────────────────────────────────────────

describe("clearAllHoldingRegisterRules", () => {
  it("clears all rule timers without throwing", () => {
    holdingRegisterState.entries = [makeEntry(0), makeEntry(1)];
    setHoldingRegisterRule(0, makeRule({ type: "cycle" }));
    setHoldingRegisterRule(1, makeRule({ type: "sawtooth" }));
    expect(() => clearAllHoldingRegisterRules()).not.toThrow();
  });
});

// ── getFilteredHoldingRegisters ───────────────────────────────────────────────

describe("getFilteredHoldingRegisters", () => {
  beforeEach(() => {
    holdingRegisterState.entries = [
      makeEntry(0, { slaveValue: 0 }),
      makeEntry(1, { slaveValue: 50 }),
      makeEntry(2, { slaveValue: 0 }),
      makeEntry(3, { slaveValue: 300 }),
    ];
  });

  it("'all' returns all entries", () => {
    setHoldingRegisterFilter("all");
    expect(getFilteredHoldingRegisters()).toHaveLength(4);
  });

  it("'non-zero' returns only non-zero slave values", () => {
    setHoldingRegisterFilter("non-zero");
    const result = getFilteredHoldingRegisters();
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.slaveValue !== 0)).toBe(true);
  });

  it("'zero' returns only zero slave values", () => {
    setHoldingRegisterFilter("zero");
    const result = getFilteredHoldingRegisters();
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.slaveValue === 0)).toBe(true);
  });

  it("required-range address filter narrows result", () => {
    setHoldingRegisterFilter("all");
    setHoldingRegisterAddressRange(1, 2);
    setHoldingRegisterAddressFilter("required-range");
    const result = getFilteredHoldingRegisters();
    expect(result.every((e) => e.address >= 1 && e.address <= 2)).toBe(true);
  });

  it("required-list returns only listed addresses", () => {
    setHoldingRegisterAddressList([0, 3]);
    setHoldingRegisterAddressFilter("required-list");
    const result = getFilteredHoldingRegisters();
    expect(result.map((e) => e.address)).toEqual([0, 3]);
  });
});

// ── generateRandomExclusiveHoldingRegisterAddress ─────────────────────────────

describe("generateRandomExclusiveHoldingRegisterAddress", () => {
  it("returns an address not already in entries", () => {
    holdingRegisterState.entries = [makeEntry(0), makeEntry(1)];
    const addr = generateRandomExclusiveHoldingRegisterAddress();
    expect(addr).not.toBeNull();
    expect(holdingRegisterState.entries.some((e) => e.address === addr)).toBe(false);
  });

  it("returns null when entries are fully saturated (65536 addresses)", () => {
    holdingRegisterState.entries = Array.from({ length: 65536 }, (_, i) => makeEntry(i));
    expect(generateRandomExclusiveHoldingRegisterAddress()).toBeNull();
  });
});

// ── View & filters ────────────────────────────────────────────────────────────

describe("setHoldingRegisterView", () => {
  it("sets 'cards' and persists in localStorage", () => {
    setHoldingRegisterView("cards");
    expect(holdingRegisterState.view).toBe("cards");
    expect(localStorage.getItem("Modbus-Lab.holdingView")).toBe("cards");
  });
});

describe("setHoldingRegisterAddressRange", () => {
  it("swaps inverted range", () => {
    setHoldingRegisterAddressRange(50, 10);
    expect(holdingRegisterState.addressRangeStart).toBe(10);
    expect(holdingRegisterState.addressRangeEnd).toBe(50);
  });

  it("clamps to 0..65535", () => {
    setHoldingRegisterAddressRange(-10, 99999);
    expect(holdingRegisterState.addressRangeStart).toBe(0);
    expect(holdingRegisterState.addressRangeEnd).toBe(65535);
  });
});

describe("setHoldingRegisterAddressList", () => {
  it("deduplicates and sorts", () => {
    setHoldingRegisterAddressList([30, 10, 10, 20]);
    expect(holdingRegisterState.addressList).toEqual([10, 20, 30]);
  });

  it("filters out-of-range values", () => {
    setHoldingRegisterAddressList([-1, 0, 65535, 65536]);
    expect(holdingRegisterState.addressList).toEqual([0, 65535]);
  });
});

describe("setHoldingRegisterLabel", () => {
  it("sets label on a known address", () => {
    holdingRegisterState.entries = [makeEntry(10)];
    setHoldingRegisterLabel(10, "flow sensor");
    expect(holdingRegisterState.entries[0].label).toBe("flow sensor");
  });

  it("does nothing for an unknown address", () => {
    holdingRegisterState.entries = [makeEntry(10)];
    setHoldingRegisterLabel(99, "noop");
    expect(holdingRegisterState.entries[0].label).toBe("");
  });
});

// ── Stress: rapid add/remove cycle ───────────────────────────────────────────

describe("stress: rapid addExclusiveHoldingRegister / remove cycle", () => {
  it("handles 200 add + 100 remove operations without state corruption", () => {
    for (let i = 0; i < 200; i++) {
      addExclusiveHoldingRegister(i);
    }
    expect(holdingRegisterState.entries).toHaveLength(200);

    for (let i = 0; i < 100; i++) {
      removeHoldingRegister(i);
    }
    expect(holdingRegisterState.entries).toHaveLength(100);
    expect(holdingRegisterState.entries.every((e) => e.address >= 100)).toBe(true);
  });
});
