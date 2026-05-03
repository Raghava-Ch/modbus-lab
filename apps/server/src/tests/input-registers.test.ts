// Server: Input Registers state — rule normalization, write→store_set_input_reg
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  inputRegisterState,
  applyInputRegisterRange,
  addInputRegisterRange,
  addExclusiveInputRegister,
  generateRandomExclusiveInputRegisterAddress,
  removeInputRegister,
  removeAllInputRegisters,
  setInputRegisterFilter,
  setInputRegisterView,
  setInputRegisterLabel,
  setInputRegisterAddressFilter,
  setInputRegisterAddressRange,
  setInputRegisterAddressList,
  setInputRegisterRule,
  clearAllInputRegisterRules,
  getFilteredInputRegisters,
} from "../state/input-registers.svelte";
import type { InputRegisterEntry, InputRegRule } from "../state/input-registers.svelte";

const mockedInvoke = vi.mocked(invoke);

function makeEntry(address: number, overrides: Partial<InputRegisterEntry> = {}): InputRegisterEntry {
  return {
    address,
    value: 0,
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

function makeRule(overrides: Partial<InputRegRule> = {}): InputRegRule {
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
  clearAllInputRegisterRules();
  inputRegisterState.entries = [];
  inputRegisterState.view = "table";
  inputRegisterState.filter = "all";
  inputRegisterState.addressFilter = "all";
  inputRegisterState.addressRangeStart = 0;
  inputRegisterState.addressRangeEnd = 0;
  inputRegisterState.addressList = [];
  inputRegisterState.startAddress = 0;
  inputRegisterState.registerCount = 16;
  inputRegisterState.readInProgress = false;
  inputRegisterState.cancelReadRequested = false;
  inputRegisterState.pollActive = false;
  inputRegisterState.pollInterval = 1000;
  vi.clearAllMocks();
  mockedInvoke.mockResolvedValue([]);
}

beforeEach(resetState);

// ── applyInputRegisterRange ───────────────────────────────────────────────────

describe("applyInputRegisterRange", () => {
  it("generates correct entries from start+count", () => {
    applyInputRegisterRange(10, 5);
    expect(inputRegisterState.entries).toHaveLength(5);
    expect(inputRegisterState.entries[0].address).toBe(10);
    expect(inputRegisterState.entries[4].address).toBe(14);
  });

  it("clamps negative start to 0", () => {
    applyInputRegisterRange(-5, 3);
    expect(inputRegisterState.startAddress).toBe(0);
  });

  it("clamps count to minimum 1", () => {
    applyInputRegisterRange(0, 0);
    expect(inputRegisterState.entries).toHaveLength(1);
  });

  it("replaces existing entries", () => {
    applyInputRegisterRange(0, 4);
    applyInputRegisterRange(20, 2);
    expect(inputRegisterState.entries).toHaveLength(2);
    expect(inputRegisterState.entries[0].address).toBe(20);
  });

  it("entries have origin 'range'", () => {
    applyInputRegisterRange(0, 3);
    expect(inputRegisterState.entries.every((e) => e.origin === "range")).toBe(true);
  });
});

// ── addInputRegisterRange ─────────────────────────────────────────────────────

describe("addInputRegisterRange", () => {
  it("merges new addresses into existing entries without duplicates", () => {
    inputRegisterState.entries = [makeEntry(0), makeEntry(1)];
    addInputRegisterRange(1, 3);
    const addresses = inputRegisterState.entries.map((e) => e.address);
    expect(addresses).toContain(0);
    expect(addresses).toContain(1);
    expect(addresses).toContain(2);
    expect(addresses).toContain(3);
    const uniqueAddresses = new Set(addresses);
    expect(uniqueAddresses.size).toBe(addresses.length);
  });
});

// ── addExclusiveInputRegister ─────────────────────────────────────────────────

describe("addExclusiveInputRegister", () => {
  it("adds a new entry for an unused address", () => {
    const result = addExclusiveInputRegister(42);
    expect(result).toBe(true);
    expect(inputRegisterState.entries.some((e) => e.address === 42)).toBe(true);
  });

  it("does not add a duplicate address", () => {
    addExclusiveInputRegister(10);
    const result = addExclusiveInputRegister(10);
    expect(result).toBe(false);
    expect(inputRegisterState.entries.filter((e) => e.address === 10)).toHaveLength(1);
  });

  it("new entry has origin 'custom'", () => {
    addExclusiveInputRegister(5);
    expect(inputRegisterState.entries.find((e) => e.address === 5)?.origin).toBe("custom");
  });
});

// ── removeInputRegister / removeAllInputRegisters ─────────────────────────────

describe("removeInputRegister", () => {
  it("removes the entry for the given address", () => {
    inputRegisterState.entries = [makeEntry(10), makeEntry(20)];
    removeInputRegister(10);
    expect(inputRegisterState.entries.some((e) => e.address === 10)).toBe(false);
    expect(inputRegisterState.entries).toHaveLength(1);
  });

  it("does nothing for an unknown address", () => {
    inputRegisterState.entries = [makeEntry(10)];
    removeInputRegister(99);
    expect(inputRegisterState.entries).toHaveLength(1);
  });
});

describe("removeAllInputRegisters", () => {
  it("clears all entries", () => {
    inputRegisterState.entries = [makeEntry(1), makeEntry(2), makeEntry(3)];
    removeAllInputRegisters();
    expect(inputRegisterState.entries).toHaveLength(0);
  });
});

// ── setInputRegisterRule / normalizeRule ──────────────────────────────────────

describe("setInputRegisterRule — normalizeRule", () => {
  it("normalizes minValue > maxValue by swapping them", () => {
    inputRegisterState.entries = [makeEntry(10)];
    setInputRegisterRule(10, makeRule({ minValue: 200, maxValue: 50 }));
    expect(inputRegisterState.entries[0].rule.minValue).toBe(50);
    expect(inputRegisterState.entries[0].rule.maxValue).toBe(200);
  });

  it("clamps intervalMs to minimum 100", () => {
    inputRegisterState.entries = [makeEntry(10)];
    setInputRegisterRule(10, makeRule({ intervalMs: 10 }));
    expect(inputRegisterState.entries[0].rule.intervalMs).toBeGreaterThanOrEqual(100);
  });

  it("clamps periodMs to minimum 200", () => {
    inputRegisterState.entries = [makeEntry(10)];
    setInputRegisterRule(10, makeRule({ periodMs: 50 }));
    expect(inputRegisterState.entries[0].rule.periodMs).toBeGreaterThanOrEqual(200);
  });

  it("clamps step to minimum 1", () => {
    inputRegisterState.entries = [makeEntry(10)];
    setInputRegisterRule(10, makeRule({ step: 0 }));
    expect(inputRegisterState.entries[0].rule.step).toBe(1);
  });

  it("does nothing for an unknown address", () => {
    inputRegisterState.entries = [makeEntry(10)];
    setInputRegisterRule(99, makeRule({ type: "cycle" }));
    expect(inputRegisterState.entries[0].rule.type).toBe("none");
  });

  it("sets type 'cycle'", () => {
    inputRegisterState.entries = [makeEntry(10)];
    setInputRegisterRule(10, makeRule({ type: "cycle" }));
    expect(inputRegisterState.entries[0].rule.type).toBe("cycle");
  });

  it("sets type 'sawtooth'", () => {
    inputRegisterState.entries = [makeEntry(10)];
    setInputRegisterRule(10, makeRule({ type: "sawtooth" }));
    expect(inputRegisterState.entries[0].rule.type).toBe("sawtooth");
  });

  it("sets type 'triangle'", () => {
    inputRegisterState.entries = [makeEntry(10)];
    setInputRegisterRule(10, makeRule({ type: "triangle" }));
    expect(inputRegisterState.entries[0].rule.type).toBe("triangle");
  });

  it("sets type 'sine'", () => {
    inputRegisterState.entries = [makeEntry(10)];
    setInputRegisterRule(10, makeRule({ type: "sine" }));
    expect(inputRegisterState.entries[0].rule.type).toBe("sine");
  });

  it("sets type 'sequential'", () => {
    inputRegisterState.entries = [makeEntry(10)];
    setInputRegisterRule(10, makeRule({ type: "sequential" }));
    expect(inputRegisterState.entries[0].rule.type).toBe("sequential");
  });

  it("sets type 'linear-ramp'", () => {
    inputRegisterState.entries = [makeEntry(10)];
    setInputRegisterRule(10, makeRule({ type: "linear-ramp" }));
    expect(inputRegisterState.entries[0].rule.type).toBe("linear-ramp");
  });

  it("sets type 'random-uniform'", () => {
    inputRegisterState.entries = [makeEntry(10)];
    setInputRegisterRule(10, makeRule({ type: "random-uniform" }));
    expect(inputRegisterState.entries[0].rule.type).toBe("random-uniform");
  });
});

// ── clearAllInputRegisterRules ────────────────────────────────────────────────

describe("clearAllInputRegisterRules", () => {
  it("clears all rule timers without throwing", () => {
    inputRegisterState.entries = [makeEntry(0), makeEntry(1)];
    setInputRegisterRule(0, makeRule({ type: "cycle" }));
    setInputRegisterRule(1, makeRule({ type: "sawtooth" }));
    expect(() => clearAllInputRegisterRules()).not.toThrow();
  });

  it("clears sequential, linear-ramp, and random-uniform timers without throwing", () => {
    inputRegisterState.entries = [makeEntry(0), makeEntry(1), makeEntry(2)];
    setInputRegisterRule(0, makeRule({ type: "sequential" }));
    setInputRegisterRule(1, makeRule({ type: "linear-ramp" }));
    setInputRegisterRule(2, makeRule({ type: "random-uniform" }));
    expect(() => clearAllInputRegisterRules()).not.toThrow();
  });
});

// ── getFilteredInputRegisters ─────────────────────────────────────────────────

describe("getFilteredInputRegisters", () => {
  beforeEach(() => {
    inputRegisterState.entries = [
      makeEntry(0, { value: 0 }),
      makeEntry(1, { value: 50 }),
      makeEntry(2, { value: 0 }),
      makeEntry(3, { value: 300 }),
    ];
  });

  it("'all' returns all entries", () => {
    setInputRegisterFilter("all");
    expect(getFilteredInputRegisters()).toHaveLength(4);
  });

  it("'non-zero' returns only non-zero values", () => {
    setInputRegisterFilter("non-zero");
    const result = getFilteredInputRegisters();
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.value !== 0)).toBe(true);
  });

  it("'zero' returns only zero values", () => {
    setInputRegisterFilter("zero");
    const result = getFilteredInputRegisters();
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.value === 0)).toBe(true);
  });

  it("required-range address filter narrows result", () => {
    setInputRegisterFilter("all");
    setInputRegisterAddressRange(1, 2);
    setInputRegisterAddressFilter("required-range");
    const result = getFilteredInputRegisters();
    expect(result.every((e) => e.address >= 1 && e.address <= 2)).toBe(true);
  });

  it("required-list returns only listed addresses", () => {
    setInputRegisterAddressList([0, 3]);
    setInputRegisterAddressFilter("required-list");
    const result = getFilteredInputRegisters();
    expect(result.map((e) => e.address)).toEqual([0, 3]);
  });
});

// ── generateRandomExclusiveInputRegisterAddress ───────────────────────────────

describe("generateRandomExclusiveInputRegisterAddress", () => {
  it("returns an address not already in entries", () => {
    inputRegisterState.entries = [makeEntry(0), makeEntry(1)];
    const addr = generateRandomExclusiveInputRegisterAddress();
    expect(addr).not.toBeNull();
    expect(inputRegisterState.entries.some((e) => e.address === addr)).toBe(false);
  });

  it("returns null when all 65536 addresses are taken", () => {
    inputRegisterState.entries = Array.from({ length: 65536 }, (_, i) => makeEntry(i));
    expect(generateRandomExclusiveInputRegisterAddress()).toBeNull();
  });
});

// ── View & filters ────────────────────────────────────────────────────────────

describe("setInputRegisterView", () => {
  it("sets 'cards' and persists in localStorage", () => {
    setInputRegisterView("cards");
    expect(inputRegisterState.view).toBe("cards");
    expect(localStorage.getItem("Modbus-Lab.inputRegView")).toBe("cards");
  });
});

describe("setInputRegisterAddressRange", () => {
  it("swaps inverted range", () => {
    setInputRegisterAddressRange(50, 10);
    expect(inputRegisterState.addressRangeStart).toBe(10);
    expect(inputRegisterState.addressRangeEnd).toBe(50);
  });

  it("clamps to 0..65535", () => {
    setInputRegisterAddressRange(-10, 99999);
    expect(inputRegisterState.addressRangeStart).toBe(0);
    expect(inputRegisterState.addressRangeEnd).toBe(65535);
  });
});

describe("setInputRegisterAddressList", () => {
  it("deduplicates and sorts", () => {
    setInputRegisterAddressList([30, 10, 10, 20]);
    expect(inputRegisterState.addressList).toEqual([10, 20, 30]);
  });

  it("filters out-of-range values", () => {
    setInputRegisterAddressList([-1, 0, 65535, 65536]);
    expect(inputRegisterState.addressList).toEqual([0, 65535]);
  });
});

describe("setInputRegisterLabel", () => {
  it("sets label on a known address", () => {
    inputRegisterState.entries = [makeEntry(10)];
    setInputRegisterLabel(10, "temperature sensor");
    expect(inputRegisterState.entries[0].label).toBe("temperature sensor");
  });

  it("does nothing for an unknown address", () => {
    inputRegisterState.entries = [makeEntry(10)];
    setInputRegisterLabel(99, "noop");
    expect(inputRegisterState.entries[0].label).toBe("");
  });
});

// ── Stress: rapid add/remove cycle ───────────────────────────────────────────

describe("stress: rapid addExclusiveInputRegister / remove cycle", () => {
  it("handles 200 add + 100 remove operations without state corruption", () => {
    for (let i = 0; i < 200; i++) {
      addExclusiveInputRegister(i);
    }
    expect(inputRegisterState.entries).toHaveLength(200);

    for (let i = 0; i < 100; i++) {
      removeInputRegister(i);
    }
    expect(inputRegisterState.entries).toHaveLength(100);
    expect(inputRegisterState.entries.every((e) => e.address >= 100)).toBe(true);
  });
});
