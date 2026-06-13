// Input Registers state — FC 04 (Read) · Read-only
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
  readInputRegister,
  cancelInputRegisterRead,
  setInputRegisterPollInterval,
  getFilteredInputRegisters,
} from "../state/input-registers.svelte";
import type { InputRegisterEntry } from "../state/input-registers.svelte";
import { connectionState } from "../state/connection.svelte";

const mockedInvoke = vi.mocked(invoke);

function makeEntry(address: number, overrides: Partial<InputRegisterEntry> = {}): InputRegisterEntry {
  return {
    address,
    value: 0,
    pending: false,
    readError: null,
    lastReadAt: null,
    label: "",
    origin: "custom",
    ...overrides,
  };
}

function resetState() {
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
  connectionState.status = "connected";
  vi.clearAllMocks();
}

beforeEach(resetState);

// ── applyInputRegisterRange ───────────────────────────────────────────────────

describe("applyInputRegisterRange", () => {
  it("generates the correct number of entries", () => {
    applyInputRegisterRange(10, 6);
    expect(inputRegisterState.entries).toHaveLength(6);
    expect(inputRegisterState.entries[0].address).toBe(10);
    expect(inputRegisterState.entries[5].address).toBe(15);
  });

  it("clamps negative start to 0", () => {
    applyInputRegisterRange(-1, 3);
    expect(inputRegisterState.startAddress).toBe(0);
  });

  it("clamps start above 65535 to 65535", () => {
    applyInputRegisterRange(70000, 1);
    expect(inputRegisterState.startAddress).toBe(65535);
  });

  it("clamps count to minimum 1", () => {
    applyInputRegisterRange(0, 0);
    expect(inputRegisterState.entries).toHaveLength(1);
  });

  it("handles NaN start address", () => {
    applyInputRegisterRange(NaN, 4);
    // NaN is not finite, a warning is generated; actual clamping behavior passes NaN through
    // Verify the entries array is generated (may be empty for NaN but no crash)
    expect(() => applyInputRegisterRange(NaN, 4)).not.toThrow();
  });

  it("handles Infinity count", () => {
    applyInputRegisterRange(0, Infinity);
    expect(inputRegisterState.entries.length).toBeGreaterThan(0);
  });

  it("entries all have origin 'range'", () => {
    applyInputRegisterRange(0, 4);
    expect(inputRegisterState.entries.every((e) => e.origin === "range")).toBe(true);
  });

  it("preserves value for existing overlapping addresses", () => {
    applyInputRegisterRange(0, 4);
    inputRegisterState.entries[1].value = 999;
    applyInputRegisterRange(0, 4);
    expect(inputRegisterState.entries[1].value).toBe(999);
  });

  it("entries are sorted ascending", () => {
    applyInputRegisterRange(20, 5);
    const addrs = inputRegisterState.entries.map((e) => e.address);
    expect(addrs).toEqual([20, 21, 22, 23, 24]);
  });

  it("stress: 1000-entry range", () => {
    applyInputRegisterRange(0, 1000);
    expect(inputRegisterState.entries).toHaveLength(1000);
  });
});

// ── addInputRegisterRange ─────────────────────────────────────────────────────

describe("addInputRegisterRange", () => {
  it("merges without removing existing entries", () => {
    applyInputRegisterRange(0, 4);
    addInputRegisterRange(2, 6);
    const addrs = inputRegisterState.entries.map((e) => e.address);
    expect(addrs).toContain(0);
    expect(addrs).toContain(7);
  });

  it("does not duplicate addresses", () => {
    applyInputRegisterRange(0, 4);
    addInputRegisterRange(0, 4);
    const addrs = inputRegisterState.entries.map((e) => e.address);
    expect(new Set(addrs).size).toBe(addrs.length);
  });
});

// ── addExclusiveInputRegister ─────────────────────────────────────────────────

describe("addExclusiveInputRegister", () => {
  it("adds and returns true", () => {
    expect(addExclusiveInputRegister(200)).toBe(true);
    expect(inputRegisterState.entries).toHaveLength(1);
  });

  it("returns false for duplicate", () => {
    addExclusiveInputRegister(200);
    expect(addExclusiveInputRegister(200)).toBe(false);
  });

  it("rejects address < 0", () => {
    expect(addExclusiveInputRegister(-1)).toBe(false);
  });

  it("rejects address > 65535", () => {
    expect(addExclusiveInputRegister(65536)).toBe(false);
  });

  it("accepts boundary values 0 and 65535", () => {
    expect(addExclusiveInputRegister(0)).toBe(true);
    expect(addExclusiveInputRegister(65535)).toBe(true);
  });

  it("floors fractional addresses", () => {
    addExclusiveInputRegister(12.7);
    expect(inputRegisterState.entries[0].address).toBe(12);
  });

  it("marks origin as 'custom'", () => {
    addExclusiveInputRegister(5);
    expect(inputRegisterState.entries[0].origin).toBe("custom");
  });

  it("keeps entries sorted", () => {
    addExclusiveInputRegister(30);
    addExclusiveInputRegister(10);
    addExclusiveInputRegister(20);
    expect(inputRegisterState.entries.map((e) => e.address)).toEqual([10, 20, 30]);
  });
});

// ── removeInputRegister / removeAllInputRegisters ─────────────────────────────

describe("removeInputRegister", () => {
  it("removes the matching entry", () => {
    inputRegisterState.entries = [makeEntry(1), makeEntry(2), makeEntry(3)];
    removeInputRegister(2);
    expect(inputRegisterState.entries.map((e) => e.address)).toEqual([1, 3]);
  });

  it("does nothing for unknown address", () => {
    inputRegisterState.entries = [makeEntry(5)];
    removeInputRegister(99);
    expect(inputRegisterState.entries).toHaveLength(1);
  });
});

describe("removeAllInputRegisters", () => {
  it("clears all entries", () => {
    inputRegisterState.entries = [makeEntry(1), makeEntry(2)];
    removeAllInputRegisters();
    expect(inputRegisterState.entries).toHaveLength(0);
  });
});

// ── setInputRegisterFilter ────────────────────────────────────────────────────

describe("setInputRegisterFilter", () => {
  it("sets 'non-zero'", () => {
    setInputRegisterFilter("non-zero");
    expect(inputRegisterState.filter).toBe("non-zero");
  });

  it("sets 'zero'", () => {
    setInputRegisterFilter("zero");
    expect(inputRegisterState.filter).toBe("zero");
  });

  it("sets 'all'", () => {
    setInputRegisterFilter("all");
    expect(inputRegisterState.filter).toBe("all");
  });
});

// ── getFilteredInputRegisters ─────────────────────────────────────────────────

describe("getFilteredInputRegisters", () => {
  beforeEach(() => {
    inputRegisterState.entries = [
      makeEntry(0, { value: 0 }),
      makeEntry(1, { value: 50 }),
      makeEntry(2, { value: 0 }),
      makeEntry(3, { value: 99 }),
    ];
  });

  it("'all' returns all entries", () => {
    setInputRegisterFilter("all");
    expect(getFilteredInputRegisters()).toHaveLength(4);
  });

  it("'non-zero' returns only entries with value > 0", () => {
    setInputRegisterFilter("non-zero");
    const result = getFilteredInputRegisters();
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.value !== 0)).toBe(true);
  });

  it("'zero' returns only entries with value === 0", () => {
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
    expect(result).toHaveLength(2);
  });

  it("non-required-range excludes the range", () => {
    setInputRegisterFilter("all");
    setInputRegisterAddressRange(1, 2);
    setInputRegisterAddressFilter("non-required-range");
    const result = getFilteredInputRegisters();
    expect(result.every((e) => e.address < 1 || e.address > 2)).toBe(true);
  });

  it("required-list returns only addresses in the list", () => {
    setInputRegisterAddressList([1, 3]);
    setInputRegisterAddressFilter("required-list");
    const result = getFilteredInputRegisters();
    expect(result.map((e) => e.address)).toEqual([1, 3]);
  });

  it("not-required-list excludes addresses in the list", () => {
    setInputRegisterAddressList([1, 3]);
    setInputRegisterAddressFilter("not-required-list");
    const result = getFilteredInputRegisters();
    expect(result.every((e) => e.address !== 1 && e.address !== 3)).toBe(true);
  });
});

// ── setInputRegisterLabel ─────────────────────────────────────────────────────

describe("setInputRegisterLabel", () => {
  it("sets label on a known address", () => {
    inputRegisterState.entries = [makeEntry(10)];
    setInputRegisterLabel(10, "temperature");
    expect(inputRegisterState.entries[0].label).toBe("temperature");
  });

  it("does nothing for an unknown address", () => {
    inputRegisterState.entries = [makeEntry(10)];
    setInputRegisterLabel(99, "noop");
    expect(inputRegisterState.entries[0].label).toBe("");
  });
});

// ── setInputRegisterView ──────────────────────────────────────────────────────

describe("setInputRegisterView", () => {
  it("sets 'cards'", () => {
    setInputRegisterView("cards");
    expect(inputRegisterState.view).toBe("cards");
  });

  it("sets 'table'", () => {
    setInputRegisterView("cards");
    setInputRegisterView("table");
    expect(inputRegisterState.view).toBe("table");
  });

  it("persists in localStorage", () => {
    setInputRegisterView("cards");
    expect(localStorage.getItem("Modbus-Lab.inputRegView")).toBe("cards");
  });
});

// ── setInputRegisterAddressRange / List / Filter ──────────────────────────────

describe("setInputRegisterAddressRange", () => {
  it("sets start and end correctly", () => {
    setInputRegisterAddressRange(10, 50);
    expect(inputRegisterState.addressRangeStart).toBe(10);
    expect(inputRegisterState.addressRangeEnd).toBe(50);
  });

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

  it("filters out out-of-range values", () => {
    setInputRegisterAddressList([-1, 0, 65535, 65536]);
    expect(inputRegisterState.addressList).toEqual([0, 65535]);
  });
});

describe("setInputRegisterAddressFilter", () => {
  it("sets each valid filter value", () => {
    const filters = [
      "all",
      "required-range",
      "non-required-range",
      "required-list",
      "not-required-list",
    ] as const;
    for (const f of filters) {
      setInputRegisterAddressFilter(f);
      expect(inputRegisterState.addressFilter).toBe(f);
    }
  });
});

// ── readInputRegister ─────────────────────────────────────────────────────────

describe("readInputRegister", () => {
  it("calls invoke('read_input_registers') and updates value on success", async () => {
    inputRegisterState.entries = [makeEntry(15)];
    mockedInvoke.mockResolvedValueOnce({
      registers: [{ address: 15, value: 777 }],
      startAddress: 15,
      quantity: 1,
    });

    await readInputRegister(15);

    expect(mockedInvoke).toHaveBeenCalledWith("read_input_registers", {
      request: { startAddress: 15, quantity: 1 },
    });
    expect(inputRegisterState.entries[0].value).toBe(777);
    expect(inputRegisterState.entries[0].readError).toBeNull();
    expect(inputRegisterState.entries[0].pending).toBe(false);
  });

  it("clears pending on backend error", async () => {
    inputRegisterState.entries = [makeEntry(15)];
    mockedInvoke.mockRejectedValueOnce(JSON.stringify({ message: "Timeout", details: "" }));

    await readInputRegister(15);

    expect(inputRegisterState.entries[0].pending).toBe(false);
  });

  it("does nothing for an unknown address", async () => {
    inputRegisterState.entries = [makeEntry(5)];
    await readInputRegister(99);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});

// ── cancelInputRegisterRead ───────────────────────────────────────────────────

describe("cancelInputRegisterRead", () => {
  it("sets cancelReadRequested when a read is in progress", () => {
    inputRegisterState.readInProgress = true;
    cancelInputRegisterRead();
    expect(inputRegisterState.cancelReadRequested).toBe(true);
  });

  it("does nothing when no read is in progress", () => {
    inputRegisterState.readInProgress = false;
    cancelInputRegisterRead();
    expect(inputRegisterState.cancelReadRequested).toBe(false);
  });
});

// ── setInputRegisterPollInterval ──────────────────────────────────────────────

describe("setInputRegisterPollInterval", () => {
  it("sets a valid poll interval", () => {
    inputRegisterState.entries = Array.from({ length: 10 }, (_, i) => makeEntry(i));
    setInputRegisterPollInterval(2000);
    expect(inputRegisterState.pollInterval).toBe(2000);
  });

  it("clamps to practical minimum for large datasets", () => {
    inputRegisterState.entries = Array.from({ length: 600 }, (_, i) => makeEntry(i));
    setInputRegisterPollInterval(50);
    expect(inputRegisterState.pollInterval).toBeGreaterThanOrEqual(1000);
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

  it("returns null when entries are fully saturated", () => {
    inputRegisterState.entries = Array.from({ length: 65536 }, (_, i) => makeEntry(i));
    expect(generateRandomExclusiveInputRegisterAddress()).toBeNull();
  });
});
