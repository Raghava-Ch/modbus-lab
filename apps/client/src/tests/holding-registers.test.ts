// Holding Registers state — FC 03 (Read) · FC 06 (Write Single) · FC 16 (Write Multiple)
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
  setAllHoldingRegisterDesiredFromRead,
  setHoldingRegisterAddressFilter,
  setHoldingRegisterAddressRange,
  setHoldingRegisterAddressList,
  readHoldingRegister,
  writeHoldingRegister,
  writePendingHoldingRegisters,
  cancelHoldingRegisterRead,
  getFilteredHoldingRegisters,
  setHoldingRegisterPollInterval,
  setHoldingRegisterPollActive,
} from "../state/holding-registers.svelte";
import type { HoldingRegisterEntry } from "../state/holding-registers.svelte";
import { connectionState } from "../state/connection.svelte";

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
    ...overrides,
  };
}

function resetState() {
  holdingRegisterState.entries = [];
  holdingRegisterState.view = "table";
  holdingRegisterState.filter = "all";
  holdingRegisterState.addressFilter = "all";
  holdingRegisterState.addressRangeStart = 0;
  holdingRegisterState.addressRangeEnd = 0;
  holdingRegisterState.addressList = [];
  holdingRegisterState.startAddress = 0;
  holdingRegisterState.registerCount = 16;
  holdingRegisterState.readInProgress = false;
  holdingRegisterState.cancelReadRequested = false;
  holdingRegisterState.pollActive = false;
  holdingRegisterState.pollInterval = 1000;
  vi.clearAllMocks();
  connectionState.status = "connected";
}

beforeEach(resetState);

// ── applyHoldingRegisterRange ─────────────────────────────────────────────────

describe("applyHoldingRegisterRange", () => {
  it("generates the correct number of entries starting at the given address", () => {
    applyHoldingRegisterRange(10, 5);
    expect(holdingRegisterState.entries).toHaveLength(5);
    expect(holdingRegisterState.entries[0].address).toBe(10);
    expect(holdingRegisterState.entries[4].address).toBe(14);
  });

  it("clamps start address to 0 when negative", () => {
    applyHoldingRegisterRange(-5, 4);
    expect(holdingRegisterState.startAddress).toBe(0);
  });

  it("clamps start address to 65535 max", () => {
    applyHoldingRegisterRange(70000, 1);
    expect(holdingRegisterState.startAddress).toBe(65535);
    expect(holdingRegisterState.entries).toHaveLength(1);
  });

  it("clamps count to 1 minimum", () => {
    applyHoldingRegisterRange(0, 0);
    expect(holdingRegisterState.entries).toHaveLength(1);
  });

  it("floors fractional start address", () => {
    applyHoldingRegisterRange(5.9, 3);
    expect(holdingRegisterState.startAddress).toBe(5);
  });

  it("floors fractional count", () => {
    applyHoldingRegisterRange(0, 3.7);
    expect(holdingRegisterState.entries).toHaveLength(3);
  });

  it("clamps very large negative start to 0", () => {
    applyHoldingRegisterRange(-50000, 2);
    expect(holdingRegisterState.startAddress).toBe(0);
  });

  it("handles Infinity start address by clamping to max", () => {
    applyHoldingRegisterRange(Infinity, 1);
    expect(holdingRegisterState.startAddress).toBe(65535);
  });

  it("preserves slaveValue and desiredValue for addresses that remain in range", () => {
    applyHoldingRegisterRange(0, 4);
    holdingRegisterState.entries[0].slaveValue = 42;
    holdingRegisterState.entries[0].desiredValue = 42;
    applyHoldingRegisterRange(0, 4);
    expect(holdingRegisterState.entries[0].slaveValue).toBe(42);
    expect(holdingRegisterState.entries[0].desiredValue).toBe(42);
  });

  it("preserves label for addresses that remain in range", () => {
    applyHoldingRegisterRange(0, 4);
    holdingRegisterState.entries[1].label = "tank pressure";
    applyHoldingRegisterRange(0, 4);
    expect(holdingRegisterState.entries[1].label).toBe("tank pressure");
  });

  it("all generated entries have origin 'range'", () => {
    applyHoldingRegisterRange(10, 8);
    expect(holdingRegisterState.entries.every((e) => e.origin === "range")).toBe(true);
  });

  it("entries are always sorted ascending by address", () => {
    applyHoldingRegisterRange(5, 5);
    const addrs = holdingRegisterState.entries.map((e) => e.address);
    expect(addrs).toEqual([5, 6, 7, 8, 9]);
  });

  it("limits count so addresses don't exceed 65535", () => {
    applyHoldingRegisterRange(65534, 10);
    expect(holdingRegisterState.entries.every((e) => e.address <= 65535)).toBe(true);
  });

  it("stress: applies 1000-register range correctly", () => {
    applyHoldingRegisterRange(0, 1000);
    expect(holdingRegisterState.entries).toHaveLength(1000);
    expect(holdingRegisterState.entries[999].address).toBe(999);
  });
});

// ── addHoldingRegisterRange ───────────────────────────────────────────────────

describe("addHoldingRegisterRange", () => {
  it("merges new addresses without removing existing ones", () => {
    applyHoldingRegisterRange(0, 4);
    addHoldingRegisterRange(2, 6);
    const addrs = holdingRegisterState.entries.map((e) => e.address);
    expect(addrs).toContain(0);
    expect(addrs).toContain(1);
    expect(addrs).toContain(7); // new end
  });

  it("does not duplicate addresses that already exist", () => {
    applyHoldingRegisterRange(0, 4);
    addHoldingRegisterRange(0, 4);
    const addrs = holdingRegisterState.entries.map((e) => e.address);
    expect(new Set(addrs).size).toBe(addrs.length);
  });

  it("keeps entries sorted", () => {
    applyHoldingRegisterRange(10, 3);
    addHoldingRegisterRange(0, 3);
    const addrs = holdingRegisterState.entries.map((e) => e.address);
    expect(addrs).toEqual([...addrs].sort((a, b) => a - b));
  });
});

// ── addExclusiveHoldingRegister ───────────────────────────────────────────────

describe("addExclusiveHoldingRegister", () => {
  it("adds a new register and returns true", () => {
    expect(addExclusiveHoldingRegister(100)).toBe(true);
    expect(holdingRegisterState.entries).toHaveLength(1);
    expect(holdingRegisterState.entries[0].address).toBe(100);
  });

  it("returns false for a duplicate address", () => {
    addExclusiveHoldingRegister(100);
    expect(addExclusiveHoldingRegister(100)).toBe(false);
    expect(holdingRegisterState.entries).toHaveLength(1);
  });

  it("rejects addresses below 0", () => {
    expect(addExclusiveHoldingRegister(-1)).toBe(false);
  });

  it("rejects addresses above 65535", () => {
    expect(addExclusiveHoldingRegister(65536)).toBe(false);
  });

  it("accepts boundary value 0", () => {
    expect(addExclusiveHoldingRegister(0)).toBe(true);
  });

  it("accepts boundary value 65535", () => {
    expect(addExclusiveHoldingRegister(65535)).toBe(true);
  });

  it("floors fractional addresses", () => {
    addExclusiveHoldingRegister(7.9);
    expect(holdingRegisterState.entries[0].address).toBe(7);
  });

  it("marks added entry as custom origin", () => {
    addExclusiveHoldingRegister(5);
    expect(holdingRegisterState.entries[0].origin).toBe("custom");
  });

  it("keeps entries sorted after addition", () => {
    addExclusiveHoldingRegister(50);
    addExclusiveHoldingRegister(20);
    addExclusiveHoldingRegister(80);
    const addrs = holdingRegisterState.entries.map((e) => e.address);
    expect(addrs).toEqual([20, 50, 80]);
  });
});

// ── removeHoldingRegister / removeAllHoldingRegisters ─────────────────────────

describe("removeHoldingRegister", () => {
  it("removes the entry at the given address", () => {
    holdingRegisterState.entries = [makeEntry(1), makeEntry(2), makeEntry(3)];
    removeHoldingRegister(2);
    expect(holdingRegisterState.entries.map((e) => e.address)).toEqual([1, 3]);
  });

  it("does nothing for an unknown address", () => {
    holdingRegisterState.entries = [makeEntry(5)];
    removeHoldingRegister(99);
    expect(holdingRegisterState.entries).toHaveLength(1);
  });
});

describe("removeAllHoldingRegisters", () => {
  it("empties the entries array", () => {
    holdingRegisterState.entries = [makeEntry(1), makeEntry(2)];
    removeAllHoldingRegisters();
    expect(holdingRegisterState.entries).toHaveLength(0);
  });

  it("is idempotent when already empty", () => {
    removeAllHoldingRegisters();
    expect(holdingRegisterState.entries).toHaveLength(0);
  });
});

// ── setHoldingRegisterView / setHoldingRegisterFilter ────────────────────────

describe("setHoldingRegisterView", () => {
  it("sets view to 'cards'", () => {
    setHoldingRegisterView("cards");
    expect(holdingRegisterState.view).toBe("cards");
  });

  it("persists view in localStorage", () => {
    setHoldingRegisterView("cards");
    expect(localStorage.getItem("Modbus-Lab.holdingView")).toBe("cards");
  });
});

describe("setHoldingRegisterFilter", () => {
  it("sets filter to 'non-zero'", () => {
    setHoldingRegisterFilter("non-zero");
    expect(holdingRegisterState.filter).toBe("non-zero");
  });

  it("sets filter to 'zero'", () => {
    setHoldingRegisterFilter("zero");
    expect(holdingRegisterState.filter).toBe("zero");
  });

  it("sets filter to 'all'", () => {
    setHoldingRegisterFilter("all");
    expect(holdingRegisterState.filter).toBe("all");
  });
});

// ── getFilteredHoldingRegisters ───────────────────────────────────────────────

describe("getFilteredHoldingRegisters", () => {
  beforeEach(() => {
    holdingRegisterState.entries = [
      makeEntry(0, { slaveValue: 0 }),
      makeEntry(1, { slaveValue: 100 }),
      makeEntry(2, { slaveValue: 0 }),
      makeEntry(3, { slaveValue: 200 }),
    ];
  });

  it("'all' returns all entries", () => {
    setHoldingRegisterFilter("all");
    expect(getFilteredHoldingRegisters()).toHaveLength(4);
  });

  it("'non-zero' returns only entries with slaveValue > 0", () => {
    setHoldingRegisterFilter("non-zero");
    const result = getFilteredHoldingRegisters();
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.slaveValue !== 0)).toBe(true);
  });

  it("'zero' returns only entries with slaveValue 0", () => {
    setHoldingRegisterFilter("zero");
    const result = getFilteredHoldingRegisters();
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.slaveValue === 0)).toBe(true);
  });
});

// ── setHoldingRegisterLabel ───────────────────────────────────────────────────

describe("setHoldingRegisterLabel", () => {
  it("sets label on a known address", () => {
    holdingRegisterState.entries = [makeEntry(10)];
    setHoldingRegisterLabel(10, "flow rate");
    expect(holdingRegisterState.entries[0].label).toBe("flow rate");
  });

  it("does nothing for an unknown address", () => {
    holdingRegisterState.entries = [makeEntry(10)];
    setHoldingRegisterLabel(99, "noop");
    expect(holdingRegisterState.entries[0].label).toBe("");
  });
});

// ── setHoldingRegisterDesiredValue ────────────────────────────────────────────

describe("setHoldingRegisterDesiredValue", () => {
  it("sets a valid desired value", () => {
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

  it("floors fractional value", () => {
    holdingRegisterState.entries = [makeEntry(5)];
    setHoldingRegisterDesiredValue(5, 123.9);
    expect(holdingRegisterState.entries[0].desiredValue).toBe(123);
  });

  it("clears writeError on update", () => {
    holdingRegisterState.entries = [makeEntry(5, { writeError: "stale error" })];
    setHoldingRegisterDesiredValue(5, 10);
    expect(holdingRegisterState.entries[0].writeError).toBeNull();
  });

  it("does nothing for an unknown address", () => {
    holdingRegisterState.entries = [makeEntry(5)];
    setHoldingRegisterDesiredValue(99, 100);
    expect(holdingRegisterState.entries[0].desiredValue).toBe(0);
  });
});

// ── setAllHoldingRegisterDesiredFromRead ──────────────────────────────────────

describe("setAllHoldingRegisterDesiredFromRead", () => {
  it("syncs desiredValue to slaveValue for all entries", () => {
    holdingRegisterState.entries = [
      makeEntry(0, { slaveValue: 100, desiredValue: 0 }),
      makeEntry(1, { slaveValue: 200, desiredValue: 50 }),
    ];
    setAllHoldingRegisterDesiredFromRead();
    expect(holdingRegisterState.entries[0].desiredValue).toBe(100);
    expect(holdingRegisterState.entries[1].desiredValue).toBe(200);
  });

  it("clears writeError on all entries", () => {
    holdingRegisterState.entries = [
      makeEntry(0, { writeError: "err1" }),
      makeEntry(1, { writeError: "err2" }),
    ];
    setAllHoldingRegisterDesiredFromRead();
    expect(holdingRegisterState.entries.every((e) => e.writeError === null)).toBe(true);
  });

  it("returns count of entries that had a mismatch or error", () => {
    holdingRegisterState.entries = [
      makeEntry(0, { slaveValue: 100, desiredValue: 50 }), // mismatch
      makeEntry(1, { slaveValue: 0, desiredValue: 0 }),    // match
      makeEntry(2, { writeError: "err" }),                  // error
    ];
    const count = setAllHoldingRegisterDesiredFromRead();
    expect(count).toBe(2);
  });

  it("returns 0 when all entries already match", () => {
    holdingRegisterState.entries = [makeEntry(0), makeEntry(1)];
    expect(setAllHoldingRegisterDesiredFromRead()).toBe(0);
  });
});

// ── setHoldingRegisterAddressRange / List ─────────────────────────────────────

describe("setHoldingRegisterAddressRange", () => {
  it("sets normalized range start/end", () => {
    setHoldingRegisterAddressRange(10, 50);
    expect(holdingRegisterState.addressRangeStart).toBe(10);
    expect(holdingRegisterState.addressRangeEnd).toBe(50);
  });

  it("swaps start and end if given inverted range", () => {
    setHoldingRegisterAddressRange(50, 10);
    expect(holdingRegisterState.addressRangeStart).toBe(10);
    expect(holdingRegisterState.addressRangeEnd).toBe(50);
  });

  it("clamps to 0..65535", () => {
    setHoldingRegisterAddressRange(-5, 70000);
    expect(holdingRegisterState.addressRangeStart).toBe(0);
    expect(holdingRegisterState.addressRangeEnd).toBe(65535);
  });
});

describe("setHoldingRegisterAddressList", () => {
  it("stores deduplicated sorted list", () => {
    setHoldingRegisterAddressList([30, 10, 20, 10]);
    expect(holdingRegisterState.addressList).toEqual([10, 20, 30]);
  });

  it("filters out out-of-range addresses", () => {
    setHoldingRegisterAddressList([-1, 0, 65535, 65536]);
    expect(holdingRegisterState.addressList).toEqual([0, 65535]);
  });

  it("floors fractional addresses", () => {
    setHoldingRegisterAddressList([5.9, 10.1]);
    expect(holdingRegisterState.addressList).toEqual([5, 10]);
  });
});

// ── readHoldingRegister ───────────────────────────────────────────────────────

describe("readHoldingRegister", () => {
  it("calls invoke('read_holding_registers') with the address and qty 1", async () => {
    holdingRegisterState.entries = [makeEntry(20)];
    mockedInvoke.mockResolvedValueOnce({
      registers: [{ address: 20, value: 500 }],
      startAddress: 20,
      quantity: 1,
    });

    await readHoldingRegister(20);

    expect(mockedInvoke).toHaveBeenCalledWith("read_holding_registers", {
      request: { startAddress: 20, quantity: 1 },
    });
  });

  it("updates slaveValue, clears errors, sets lastReadAt on success", async () => {
    holdingRegisterState.entries = [makeEntry(20, { readError: "old" })];
    const before = Date.now();
    mockedInvoke.mockResolvedValueOnce({
      registers: [{ address: 20, value: 500 }],
      startAddress: 20,
      quantity: 1,
    });

    await readHoldingRegister(20);

    expect(holdingRegisterState.entries[0].slaveValue).toBe(500);
    expect(holdingRegisterState.entries[0].readError).toBeNull();
    expect(holdingRegisterState.entries[0].writeError).toBeNull();
    expect(holdingRegisterState.entries[0].lastReadAt).toBeGreaterThanOrEqual(before);
    expect(holdingRegisterState.entries[0].pending).toBe(false);
  });

  it("sets readError and clears pending on failure", async () => {
    holdingRegisterState.entries = [makeEntry(20)];
    mockedInvoke.mockRejectedValueOnce(JSON.stringify({ message: "Timeout", details: "" }));

    await readHoldingRegister(20);

    expect(holdingRegisterState.entries[0].readError).toBeTruthy();
    expect(holdingRegisterState.entries[0].pending).toBe(false);
  });

  it("does nothing for an unknown address", async () => {
    holdingRegisterState.entries = [makeEntry(5)];
    await readHoldingRegister(99);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("sets pending=true while the invoke is in-flight", () => {
    holdingRegisterState.entries = [makeEntry(20)];
    let capturedPending: boolean | undefined;
    mockedInvoke.mockImplementationOnce(async () => {
      capturedPending = holdingRegisterState.entries[0].pending;
      return { registers: [{ address: 20, value: 0 }], startAddress: 20, quantity: 1 };
    });
    return readHoldingRegister(20).then(() => {
      expect(capturedPending).toBe(true);
    });
  });
});

// ── writeHoldingRegister ──────────────────────────────────────────────────────

describe("writeHoldingRegister", () => {
  it("calls invoke('write_holding_register') with address and desiredValue", async () => {
    holdingRegisterState.entries = [makeEntry(7, { desiredValue: 1024 })];
    mockedInvoke.mockResolvedValueOnce({ address: 7, value: 1024 });

    await writeHoldingRegister(7);

    expect(mockedInvoke).toHaveBeenCalledWith("write_holding_register", {
      request: { address: 7, value: 1024 },
    });
  });

  it("updates slaveValue, clears errors, sets lastWriteAt on success", async () => {
    holdingRegisterState.entries = [makeEntry(7, { desiredValue: 1024 })];
    const before = Date.now();
    mockedInvoke.mockResolvedValueOnce({ address: 7, value: 1024 });

    await writeHoldingRegister(7);

    expect(holdingRegisterState.entries[0].slaveValue).toBe(1024);
    expect(holdingRegisterState.entries[0].writeError).toBeNull();
    expect(holdingRegisterState.entries[0].lastWriteAt).toBeGreaterThanOrEqual(before);
    expect(holdingRegisterState.entries[0].pending).toBe(false);
  });

  it("sets writeError on failure", async () => {
    holdingRegisterState.entries = [makeEntry(7)];
    mockedInvoke.mockRejectedValueOnce(JSON.stringify({ message: "Bus error", details: "ILLEGAL_DATA_ADDRESS" }));

    await writeHoldingRegister(7);

    expect(holdingRegisterState.entries[0].writeError).toBe("Bus error (ILLEGAL_DATA_ADDRESS)");
    expect(holdingRegisterState.entries[0].pending).toBe(false);
  });

  it("does nothing for an unknown address", async () => {
    holdingRegisterState.entries = [makeEntry(5)];
    await writeHoldingRegister(99);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});

// ── writePendingHoldingRegisters ──────────────────────────────────────────────

describe("writePendingHoldingRegisters", () => {
  it("returns 0 immediately when no entries have a pending diff", async () => {
    holdingRegisterState.entries = [makeEntry(0)]; // slaveValue=0 == desiredValue=0
    const count = await writePendingHoldingRegisters();
    expect(count).toBe(0);
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("sends a batch write for all differing entries", async () => {
    holdingRegisterState.entries = [
      makeEntry(0, { slaveValue: 0, desiredValue: 100 }),
      makeEntry(1, { slaveValue: 0, desiredValue: 200 }),
    ];
    mockedInvoke.mockResolvedValueOnce({ writtenCount: 2, totalCount: 2, failures: [] });

    const count = await writePendingHoldingRegisters();

    expect(count).toBe(2);
    expect(mockedInvoke).toHaveBeenCalledWith("write_holding_registers_batch", expect.objectContaining({
      request: expect.objectContaining({
        registers: expect.arrayContaining([
          { address: 0, value: 100 },
          { address: 1, value: 200 },
        ]),
      }),
    }));
  });

  it("attributes per-address failures and clears successful entries", async () => {
    holdingRegisterState.entries = [
      makeEntry(0, { slaveValue: 0, desiredValue: 100 }),
      makeEntry(1, { slaveValue: 0, desiredValue: 200 }),
    ];
    mockedInvoke.mockResolvedValueOnce({
      writtenCount: 1,
      totalCount: 2,
      failures: [{ address: 1, code: "0x02", message: "ILLEGAL_DATA_ADDRESS" }],
    });

    await writePendingHoldingRegisters();

    // address 0 succeeded
    expect(holdingRegisterState.entries[0].slaveValue).toBe(100);
    expect(holdingRegisterState.entries[0].writeError).toBeNull();
    // address 1 failed
    expect(holdingRegisterState.entries[1].writeError).toBeTruthy();
    expect(holdingRegisterState.entries[1].slaveValue).toBe(0);
  });

  // ── Stress: 200 entries in one batch ──────────────────────────────────────
  it("stress: handles 200-entry pending batch without error", async () => {
    holdingRegisterState.entries = Array.from({ length: 200 }, (_, i) =>
      makeEntry(i, { slaveValue: 0, desiredValue: i + 1 }),
    );
    mockedInvoke.mockResolvedValue({ writtenCount: 120, totalCount: 120, failures: [] });

    const count = await writePendingHoldingRegisters();

    expect(count).toBeGreaterThan(0);
    expect(mockedInvoke).toHaveBeenCalled();
  });
});

// ── cancelHoldingRegisterRead ─────────────────────────────────────────────────

describe("cancelHoldingRegisterRead", () => {
  it("sets cancelReadRequested=true when a read is in progress", () => {
    holdingRegisterState.readInProgress = true;
    cancelHoldingRegisterRead();
    expect(holdingRegisterState.cancelReadRequested).toBe(true);
  });

  it("does nothing when no read is in progress", () => {
    holdingRegisterState.readInProgress = false;
    cancelHoldingRegisterRead();
    expect(holdingRegisterState.cancelReadRequested).toBe(false);
  });
});

// ── setHoldingRegisterPollInterval ────────────────────────────────────────────

describe("setHoldingRegisterPollInterval", () => {
  it("sets the poll interval", () => {
    holdingRegisterState.entries = Array.from({ length: 10 }, (_, i) => makeEntry(i));
    setHoldingRegisterPollInterval(2000);
    expect(holdingRegisterState.pollInterval).toBe(2000);
  });

  it("clamps to practical minimum for large entry counts", () => {
    holdingRegisterState.entries = Array.from({ length: 600 }, (_, i) => makeEntry(i));
    // Practical min for 600 registers = 1000 ms
    setHoldingRegisterPollInterval(100);
    expect(holdingRegisterState.pollInterval).toBeGreaterThanOrEqual(1000);
  });
});

// ── generateRandomExclusiveHoldingRegisterAddress ────────────────────────────

describe("generateRandomExclusiveHoldingRegisterAddress", () => {
  it("returns an address not in current entries", () => {
    holdingRegisterState.entries = [makeEntry(0), makeEntry(1), makeEntry(2)];
    const addr = generateRandomExclusiveHoldingRegisterAddress();
    expect(addr).not.toBeNull();
    expect(holdingRegisterState.entries.some((e) => e.address === addr)).toBe(false);
  });

  it("returns null when entries are full (65536 addresses)", () => {
    // Simulate a full address space by having entries.length === HOLDING_MAX_COUNT
    holdingRegisterState.entries = Array.from({ length: 65536 }, (_, i) => makeEntry(i));
    const addr = generateRandomExclusiveHoldingRegisterAddress();
    expect(addr).toBeNull();
  });
});

// ── setHoldingRegisterAddressFilter ──────────────────────────────────────────

describe("setHoldingRegisterAddressFilter", () => {
  it("sets each valid address filter value", () => {
    const filters = [
      "all",
      "required-range",
      "non-required-range",
      "required-list",
      "not-required-list",
    ] as const;
    for (const f of filters) {
      setHoldingRegisterAddressFilter(f);
      expect(holdingRegisterState.addressFilter).toBe(f);
    }
  });
});
