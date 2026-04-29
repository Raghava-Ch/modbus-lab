// Server: Discrete Inputs state — toggle, write→store_set_discrete_input, mass patterns
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  discreteInputState,
  applyDiscreteInputAddressRange,
  addDiscreteInputRange,
  addExclusiveDiscreteInput,
  generateRandomExclusiveDiscreteInputAddress,
  removeDiscreteInput,
  removeAllDiscreteInputs,
  toggleDiscreteInputValue,
  setDiscreteInputValue,
  syncAllSlaveToDesired,
  writeDiscreteInput,
  writePendingDiscreteInputs,
  setDiscreteInputFilter,
  setDiscreteInputView,
  setDiscreteInputLabel,
  setDiscreteInputAddressFilter,
  setDiscreteInputAddressRange,
  setDiscreteInputAddressList,
  executeMassWrite,
  buildMassPreview,
  getFilteredDiscreteInputs,
  clearAllDiscreteInputRules,
} from "../state/discrete-inputs.svelte";
import type { DiscreteInputEntry } from "../state/discrete-inputs.svelte";

const mockedInvoke = vi.mocked(invoke);

function makeEntry(address: number, overrides: Partial<DiscreteInputEntry> = {}): DiscreteInputEntry {
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

function resetState() {
  clearAllDiscreteInputRules();
  discreteInputState.entries = [];
  discreteInputState.view = "table";
  discreteInputState.filter = "all";
  discreteInputState.addressFilter = "all";
  discreteInputState.addressRangeStart = 0;
  discreteInputState.addressRangeEnd = 0;
  discreteInputState.addressList = [];
  discreteInputState.startAddress = 0;
  discreteInputState.inputCount = 16;
  discreteInputState.pollActive = false;
  discreteInputState.massAutoActive = false;
  vi.clearAllMocks();
  // Stub invoke for store_sync calls
  mockedInvoke.mockResolvedValue([]);
}

beforeEach(resetState);

// ── applyDiscreteInputAddressRange ────────────────────────────────────────────

describe("applyDiscreteInputAddressRange", () => {
  it("generates entries starting at the given address", () => {
    applyDiscreteInputAddressRange(5, 4);
    expect(discreteInputState.entries).toHaveLength(4);
    expect(discreteInputState.entries[0].address).toBe(5);
    expect(discreteInputState.entries[3].address).toBe(8);
  });

  it("clamps negative start to 0", () => {
    applyDiscreteInputAddressRange(-10, 3);
    expect(discreteInputState.startAddress).toBe(0);
  });

  it("clamps start above 65535 to 65535", () => {
    applyDiscreteInputAddressRange(70000, 1);
    expect(discreteInputState.startAddress).toBe(65535);
  });

  it("clamps count to minimum 1", () => {
    applyDiscreteInputAddressRange(0, 0);
    expect(discreteInputState.entries).toHaveLength(1);
  });

  it("clamps very large negative start to 0", () => {
    applyDiscreteInputAddressRange(-50000, 3);
    expect(discreteInputState.startAddress).toBe(0);
  });

  it("preserves slaveValue for overlapping addresses", () => {
    applyDiscreteInputAddressRange(0, 4);
    discreteInputState.entries[1].slaveValue = true;
    applyDiscreteInputAddressRange(0, 4);
    expect(discreteInputState.entries[1].slaveValue).toBe(true);
  });

  it("preserves label for overlapping addresses", () => {
    applyDiscreteInputAddressRange(0, 4);
    discreteInputState.entries[0].label = "door sensor";
    applyDiscreteInputAddressRange(0, 4);
    expect(discreteInputState.entries[0].label).toBe("door sensor");
  });

  it("calls store_sync_discrete_input_addresses", () => {
    applyDiscreteInputAddressRange(0, 4);
    expect(mockedInvoke).toHaveBeenCalledWith(
      "store_sync_discrete_input_addresses",
      expect.objectContaining({ addresses: expect.any(Array) }),
    );
  });

  it("stress: 500-entry range", () => {
    applyDiscreteInputAddressRange(100, 500);
    expect(discreteInputState.entries).toHaveLength(500);
    expect(discreteInputState.entries[499].address).toBe(599);
  });
});

// ── addDiscreteInputRange ─────────────────────────────────────────────────────

describe("addDiscreteInputRange", () => {
  it("merges without removing existing entries", () => {
    applyDiscreteInputAddressRange(0, 4);
    addDiscreteInputRange(2, 6);
    const addrs = discreteInputState.entries.map((e) => e.address);
    expect(addrs).toContain(0);
    expect(addrs).toContain(7);
  });

  it("does not duplicate addresses", () => {
    applyDiscreteInputAddressRange(0, 4);
    addDiscreteInputRange(0, 4);
    const addrs = discreteInputState.entries.map((e) => e.address);
    expect(new Set(addrs).size).toBe(addrs.length);
  });
});

// ── addExclusiveDiscreteInput ─────────────────────────────────────────────────

describe("addExclusiveDiscreteInput", () => {
  it("adds and returns true", () => {
    expect(addExclusiveDiscreteInput(50)).toBe(true);
    expect(discreteInputState.entries).toHaveLength(1);
  });

  it("returns false for duplicate address", () => {
    addExclusiveDiscreteInput(50);
    expect(addExclusiveDiscreteInput(50)).toBe(false);
  });

  it("calls store_set_discrete_input on new address", () => {
    addExclusiveDiscreteInput(30);
    expect(mockedInvoke).toHaveBeenCalledWith("store_set_discrete_input", { address: 30, value: false });
  });

  it("rejects address < 0", () => {
    expect(addExclusiveDiscreteInput(-1)).toBe(false);
  });

  it("rejects address > 65535", () => {
    expect(addExclusiveDiscreteInput(65536)).toBe(false);
  });

  it("floors fractional addresses", () => {
    addExclusiveDiscreteInput(5.9);
    expect(discreteInputState.entries[0].address).toBe(5);
  });

  it("marks origin as 'custom'", () => {
    addExclusiveDiscreteInput(10);
    expect(discreteInputState.entries[0].origin).toBe("custom");
  });
});

// ── removeDiscreteInput / removeAllDiscreteInputs ─────────────────────────────

describe("removeDiscreteInput", () => {
  it("removes the matching entry and calls store_remove_discrete_input", () => {
    discreteInputState.entries = [makeEntry(1), makeEntry(2), makeEntry(3)];
    removeDiscreteInput(2);
    expect(discreteInputState.entries.map((e) => e.address)).toEqual([1, 3]);
    expect(mockedInvoke).toHaveBeenCalledWith("store_remove_discrete_input", { address: 2 });
  });

  it("does nothing for an unknown address", () => {
    discreteInputState.entries = [makeEntry(5)];
    removeDiscreteInput(99);
    expect(discreteInputState.entries).toHaveLength(1);
  });
});

describe("removeAllDiscreteInputs", () => {
  it("clears entries and calls store_clear_discrete_inputs", () => {
    discreteInputState.entries = [makeEntry(1), makeEntry(2)];
    removeAllDiscreteInputs();
    expect(discreteInputState.entries).toHaveLength(0);
    expect(mockedInvoke).toHaveBeenCalledWith("store_clear_discrete_inputs", {});
  });
});

// ── toggleDiscreteInputValue ──────────────────────────────────────────────────

describe("toggleDiscreteInputValue", () => {
  it("toggles false→true", () => {
    discreteInputState.entries = [makeEntry(5, { desiredValue: false })];
    toggleDiscreteInputValue(5);
    expect(discreteInputState.entries[0].desiredValue).toBe(true);
  });

  it("toggles true→false", () => {
    discreteInputState.entries = [makeEntry(5, { desiredValue: true })];
    toggleDiscreteInputValue(5);
    expect(discreteInputState.entries[0].desiredValue).toBe(false);
  });

  it("clears writeError on toggle", () => {
    discreteInputState.entries = [makeEntry(5, { writeError: "old error" })];
    toggleDiscreteInputValue(5);
    expect(discreteInputState.entries[0].writeError).toBeNull();
  });

  it("does nothing for an unknown address", () => {
    discreteInputState.entries = [makeEntry(5)];
    toggleDiscreteInputValue(99);
    expect(discreteInputState.entries[0].desiredValue).toBe(false);
  });
});

// ── setDiscreteInputValue ─────────────────────────────────────────────────────

describe("setDiscreteInputValue", () => {
  it("sets the desired value", () => {
    discreteInputState.entries = [makeEntry(5)];
    setDiscreteInputValue(5, true);
    expect(discreteInputState.entries[0].desiredValue).toBe(true);
  });

  it("clears writeError", () => {
    discreteInputState.entries = [makeEntry(5, { writeError: "stale" })];
    setDiscreteInputValue(5, false);
    expect(discreteInputState.entries[0].writeError).toBeNull();
  });

  it("does nothing for an unknown address", () => {
    discreteInputState.entries = [makeEntry(5)];
    setDiscreteInputValue(99, true);
    expect(discreteInputState.entries[0].desiredValue).toBe(false);
  });
});

// ── syncAllSlaveToDesired ─────────────────────────────────────────────────────

describe("syncAllSlaveToDesired", () => {
  it("syncs all desiredValues to slaveValues", () => {
    discreteInputState.entries = [
      makeEntry(0, { slaveValue: true, desiredValue: false }),
      makeEntry(1, { slaveValue: false, desiredValue: true }),
    ];
    syncAllSlaveToDesired();
    expect(discreteInputState.entries[0].desiredValue).toBe(true);
    expect(discreteInputState.entries[1].desiredValue).toBe(false);
  });

  it("returns count of entries that had a mismatch or error", () => {
    discreteInputState.entries = [
      makeEntry(0, { slaveValue: true, desiredValue: false }), // mismatch
      makeEntry(1, { slaveValue: false, desiredValue: false }), // match
      makeEntry(2, { writeError: "err" }),                      // error
    ];
    expect(syncAllSlaveToDesired()).toBe(2);
  });

  it("returns 0 when all entries already match", () => {
    discreteInputState.entries = [makeEntry(0), makeEntry(1)];
    expect(syncAllSlaveToDesired()).toBe(0);
  });
});

// ── writeDiscreteInput ────────────────────────────────────────────────────────

describe("writeDiscreteInput", () => {
  it("calls invoke('store_set_discrete_input') with address and desiredValue", async () => {
    discreteInputState.entries = [makeEntry(10, { desiredValue: true })];
    mockedInvoke.mockResolvedValueOnce(undefined);

    await writeDiscreteInput(10);

    expect(mockedInvoke).toHaveBeenCalledWith("store_set_discrete_input", { address: 10, value: true });
  });

  it("updates slaveValue and clears pending on success", async () => {
    discreteInputState.entries = [makeEntry(10, { desiredValue: true })];
    mockedInvoke.mockResolvedValueOnce(undefined);

    await writeDiscreteInput(10);

    expect(discreteInputState.entries[0].slaveValue).toBe(true);
    expect(discreteInputState.entries[0].pending).toBe(false);
    expect(discreteInputState.entries[0].writeError).toBeNull();
  });

  it("sets writeError and clears pending on failure", async () => {
    discreteInputState.entries = [makeEntry(10)];
    mockedInvoke.mockRejectedValueOnce(JSON.stringify({ message: "Store error", details: "addr out of range" }));

    await writeDiscreteInput(10);

    expect(discreteInputState.entries[0].writeError).toBe("Store error (addr out of range)");
    expect(discreteInputState.entries[0].pending).toBe(false);
  });

  it("does nothing for an unknown address", async () => {
    discreteInputState.entries = [makeEntry(5)];
    await writeDiscreteInput(99);
    expect(mockedInvoke).not.toHaveBeenCalledWith("store_set_discrete_input", expect.any(Object));
  });
});

// ── writePendingDiscreteInputs ────────────────────────────────────────────────

describe("writePendingDiscreteInputs", () => {
  it("returns 0 when no entries have a pending diff", async () => {
    discreteInputState.entries = [makeEntry(0)]; // slaveValue=false == desiredValue=false
    const count = await writePendingDiscreteInputs();
    expect(count).toBe(0);
    expect(mockedInvoke).not.toHaveBeenCalledWith("store_set_discrete_input", expect.any(Object));
  });

  it("sends store_set_discrete_input for each pending entry", async () => {
    discreteInputState.entries = [
      makeEntry(0, { slaveValue: false, desiredValue: true }),
      makeEntry(1, { slaveValue: false, desiredValue: true }),
    ];
    mockedInvoke.mockResolvedValue(undefined);

    const count = await writePendingDiscreteInputs();
    expect(count).toBe(2);
    expect(mockedInvoke).toHaveBeenCalledWith("store_set_discrete_input", { address: 0, value: true });
    expect(mockedInvoke).toHaveBeenCalledWith("store_set_discrete_input", { address: 1, value: true });
  });

  it("attributes per-address failures and records writeError", async () => {
    discreteInputState.entries = [
      makeEntry(0, { slaveValue: false, desiredValue: true }),
      makeEntry(1, { slaveValue: false, desiredValue: true }),
    ];
    mockedInvoke
      .mockResolvedValueOnce(undefined) // address 0 succeeds
      .mockRejectedValueOnce("Store write failed"); // address 1 fails

    await writePendingDiscreteInputs();

    expect(discreteInputState.entries[0].slaveValue).toBe(true);
    expect(discreteInputState.entries[0].writeError).toBeNull();
    expect(discreteInputState.entries[1].writeError).toBeTruthy();
    expect(discreteInputState.entries[1].slaveValue).toBe(false);
  });

  // Stress: 100 entries pending
  it("stress: handles 100-entry pending batch without error", async () => {
    discreteInputState.entries = Array.from({ length: 100 }, (_, i) =>
      makeEntry(i, { slaveValue: false, desiredValue: true }),
    );
    mockedInvoke.mockResolvedValue(undefined);

    const count = await writePendingDiscreteInputs();
    expect(count).toBe(100);
  });
});

// ── executeMassWrite ──────────────────────────────────────────────────────────

describe("executeMassWrite", () => {
  it("does not invoke when no entries fall in mass range", async () => {
    discreteInputState.entries = [];
    discreteInputState.massFrom = 0;
    discreteInputState.massTo = 15;
    discreteInputState.massPattern = "all-on";
    await executeMassWrite();
    expect(mockedInvoke).not.toHaveBeenCalledWith("store_set_discrete_input", expect.any(Object));
  });

  it("all-on sets all targets to desired=true", async () => {
    discreteInputState.entries = Array.from({ length: 8 }, (_, i) => makeEntry(i));
    discreteInputState.massFrom = 0;
    discreteInputState.massTo = 7;
    discreteInputState.massPattern = "all-on";
    mockedInvoke.mockResolvedValue(undefined);

    await executeMassWrite();

    expect(discreteInputState.entries.every((e) => e.slaveValue === true)).toBe(true);
  });

  it("all-off sets all targets to desired=false", async () => {
    discreteInputState.entries = Array.from({ length: 4 }, (_, i) => makeEntry(i, { slaveValue: true, desiredValue: true }));
    discreteInputState.massFrom = 0;
    discreteInputState.massTo = 3;
    discreteInputState.massPattern = "all-off";
    mockedInvoke.mockResolvedValue(undefined);

    await executeMassWrite();

    expect(discreteInputState.entries.every((e) => e.slaveValue === false)).toBe(true);
  });

  it("handles partial backend failures gracefully", async () => {
    discreteInputState.entries = Array.from({ length: 4 }, (_, i) => makeEntry(i));
    discreteInputState.massFrom = 0;
    discreteInputState.massTo = 3;
    discreteInputState.massPattern = "all-on";
    mockedInvoke
      .mockResolvedValueOnce(undefined)   // addr 0 ok
      .mockResolvedValueOnce(undefined)   // addr 1 ok
      .mockRejectedValueOnce("Store err") // addr 2 fails
      .mockResolvedValueOnce(undefined);  // addr 3 ok

    await executeMassWrite();

    expect(discreteInputState.entries[0].slaveValue).toBe(true);
    expect(discreteInputState.entries[2].writeError).toBeTruthy();
    expect(discreteInputState.entries[3].slaveValue).toBe(true);
  });

  it("stress: all-on for 200 entries completes without error", async () => {
    discreteInputState.entries = Array.from({ length: 200 }, (_, i) => makeEntry(i));
    discreteInputState.massFrom = 0;
    discreteInputState.massTo = 199;
    discreteInputState.massPattern = "all-on";
    mockedInvoke.mockResolvedValue(undefined);

    await executeMassWrite();
    expect(mockedInvoke).toHaveBeenCalledTimes(200);
  });
});

// ── buildMassPreview ──────────────────────────────────────────────────────────

describe("buildMassPreview", () => {
  beforeEach(() => {
    discreteInputState.entries = Array.from({ length: 6 }, (_, i) => makeEntry(i));
    discreteInputState.massFrom = 0;
    discreteInputState.massTo = 5;
  });

  it("all-on produces '1 1 1 1 1 1'", () => {
    discreteInputState.massPattern = "all-on";
    expect(buildMassPreview()).toBe("6 coils: 1 1 1 1 1 1");
  });

  it("all-off produces '0 0 0 0 0 0'", () => {
    discreteInputState.massPattern = "all-off";
    expect(buildMassPreview()).toBe("6 coils: 0 0 0 0 0 0");
  });

  it("alternating produces '1 0 1 0 1 0'", () => {
    discreteInputState.massPattern = "alternating";
    expect(buildMassPreview()).toBe("6 coils: 1 0 1 0 1 0");
  });

  it("alternating-inv produces '0 1 0 1 0 1'", () => {
    discreteInputState.massPattern = "alternating-inv";
    expect(buildMassPreview()).toBe("6 coils: 0 1 0 1 0 1");
  });

  it("every-third produces '1 0 0 1 0 0'", () => {
    discreteInputState.massPattern = "every-third";
    expect(buildMassPreview()).toBe("6 coils: 1 0 0 1 0 0");
  });

  it("random produces '?' placeholders", () => {
    discreteInputState.massPattern = "random";
    expect(buildMassPreview()).toBe("6 coils: ? ? ? ? ? ?");
  });

  it("singular 'coil' form for single entry", () => {
    discreteInputState.entries = [makeEntry(5)];
    discreteInputState.massFrom = 5;
    discreteInputState.massTo = 5;
    discreteInputState.massPattern = "all-on";
    expect(buildMassPreview()).toBe("1 coil: 1");
  });

  it("returns '—' when no targets in range", () => {
    discreteInputState.entries = [];
    expect(buildMassPreview()).toBe("—");
  });
});

// ── getFilteredDiscreteInputs ─────────────────────────────────────────────────

describe("getFilteredDiscreteInputs", () => {
  beforeEach(() => {
    discreteInputState.entries = [
      makeEntry(0, { slaveValue: false }),
      makeEntry(1, { slaveValue: true }),
      makeEntry(2, { slaveValue: false }),
      makeEntry(3, { slaveValue: true }),
    ];
  });

  it("'all' returns all entries", () => {
    setDiscreteInputFilter("all");
    expect(getFilteredDiscreteInputs()).toHaveLength(4);
  });

  it("'on' returns only entries with slaveValue=true", () => {
    setDiscreteInputFilter("on");
    const result = getFilteredDiscreteInputs();
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.slaveValue)).toBe(true);
  });

  it("'off' returns only entries with slaveValue=false", () => {
    setDiscreteInputFilter("off");
    const result = getFilteredDiscreteInputs();
    expect(result).toHaveLength(2);
    expect(result.every((e) => !e.slaveValue)).toBe(true);
  });

  it("required-range address filter narrows result", () => {
    setDiscreteInputFilter("all");
    setDiscreteInputAddressRange(1, 2);
    setDiscreteInputAddressFilter("required-range");
    const result = getFilteredDiscreteInputs();
    expect(result.every((e) => e.address >= 1 && e.address <= 2)).toBe(true);
  });

  it("required-list returns only listed addresses", () => {
    setDiscreteInputAddressList([1, 3]);
    setDiscreteInputAddressFilter("required-list");
    const result = getFilteredDiscreteInputs();
    expect(result.map((e) => e.address)).toEqual([1, 3]);
  });
});

// ── View & label ──────────────────────────────────────────────────────────────

describe("setDiscreteInputView", () => {
  it("sets 'switch' and persists in localStorage", () => {
    setDiscreteInputView("switch");
    expect(discreteInputState.view).toBe("switch");
    expect(localStorage.getItem("Modbus-Lab.coilView")).toBe("switch");
  });
});

describe("setDiscreteInputLabel", () => {
  it("sets label on known address", () => {
    discreteInputState.entries = [makeEntry(5)];
    setDiscreteInputLabel(5, "motion sensor");
    expect(discreteInputState.entries[0].label).toBe("motion sensor");
  });

  it("does nothing for unknown address", () => {
    discreteInputState.entries = [makeEntry(5)];
    setDiscreteInputLabel(99, "noop");
    expect(discreteInputState.entries[0].label).toBe("");
  });
});

// ── generateRandomExclusiveDiscreteInputAddress ───────────────────────────────

describe("generateRandomExclusiveDiscreteInputAddress", () => {
  it("returns an address not in current entries", () => {
    discreteInputState.entries = [makeEntry(0), makeEntry(1)];
    const addr = generateRandomExclusiveDiscreteInputAddress();
    expect(addr).not.toBeNull();
    expect(discreteInputState.entries.some((e) => e.address === addr)).toBe(false);
  });
});

// ── Stress: rapid add/remove ──────────────────────────────────────────────────

describe("stress: rapid add/remove cycle", () => {
  it("handles 200 add + 100 remove operations without state corruption", () => {
    for (let i = 0; i < 200; i++) {
      addExclusiveDiscreteInput(i);
    }
    expect(discreteInputState.entries).toHaveLength(200);

    for (let i = 0; i < 100; i++) {
      removeDiscreteInput(i);
    }
    expect(discreteInputState.entries).toHaveLength(100);
    expect(discreteInputState.entries.every((e) => e.address >= 100)).toBe(true);
  });
});
