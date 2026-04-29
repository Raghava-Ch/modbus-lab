// Discrete Inputs state — FC 02 (Read) · Read-only
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  discreteInputState,
  applyDiscreteInputRange,
  addDiscreteInputRange,
  addExclusiveDiscreteInput,
  generateRandomExclusiveDiscreteInputAddress,
  removeDiscreteInput,
  removeAllDiscreteInputs,
  setDiscreteInputFilter,
  setDiscreteInputView,
  setDiscreteInputLabel,
  getFilteredDiscreteInputs,
} from "../state/discrete-inputs.svelte";
import type { DiscreteInputEntry } from "../state/discrete-inputs.svelte";

function makeEntry(address: number, overrides: Partial<DiscreteInputEntry> = {}): DiscreteInputEntry {
  return {
    address,
    value: false,
    pending: false,
    readError: null,
    label: "",
    origin: "custom",
    ...overrides,
  };
}

function resetState() {
  discreteInputState.entries = [];
  discreteInputState.view = "table";
  discreteInputState.startAddress = 0;
  discreteInputState.inputCount = 8;
  discreteInputState.filter = "all";
  discreteInputState.pollActive = false;
  discreteInputState.pollInterval = 1000;
  vi.clearAllMocks();
}

beforeEach(resetState);

// ── applyDiscreteInputRange ───────────────────────────────────────────────────

describe("applyDiscreteInputRange", () => {
  it("generates entries starting at the given address", () => {
    applyDiscreteInputRange(5, 4);
    expect(discreteInputState.entries).toHaveLength(4);
    expect(discreteInputState.entries[0].address).toBe(5);
    expect(discreteInputState.entries[3].address).toBe(8);
  });

  it("clamps negative start to 0", () => {
    applyDiscreteInputRange(-10, 3);
    expect(discreteInputState.startAddress).toBe(0);
    expect(discreteInputState.entries.every((e) => e.address >= 0)).toBe(true);
  });

  it("clamps start above 65535 to 65535", () => {
    applyDiscreteInputRange(70000, 1);
    expect(discreteInputState.startAddress).toBe(65535);
  });

  it("clamps count to minimum 1", () => {
    applyDiscreteInputRange(0, 0);
    expect(discreteInputState.entries).toHaveLength(1);
  });

  it("clamps Infinity start to max 65535", () => {
    applyDiscreteInputRange(Infinity, 1);
    expect(discreteInputState.startAddress).toBe(65535);
  });

  it("generates entries for normal range", () => {
    applyDiscreteInputRange(0, 8);
    expect(discreteInputState.entries).toHaveLength(8);
  });

  it("entries have origin 'range'", () => {
    applyDiscreteInputRange(0, 5);
    expect(discreteInputState.entries.every((e) => e.origin === "range")).toBe(true);
  });

  it("preserves value for overlapping addresses", () => {
    applyDiscreteInputRange(0, 4);
    discreteInputState.entries[0].value = true;
    applyDiscreteInputRange(0, 4);
    expect(discreteInputState.entries[0].value).toBe(true);
  });

  it("preserves label for overlapping addresses", () => {
    applyDiscreteInputRange(0, 4);
    discreteInputState.entries[2].label = "door sensor";
    applyDiscreteInputRange(0, 4);
    expect(discreteInputState.entries[2].label).toBe("door sensor");
  });

  it("entries are sorted ascending by address", () => {
    applyDiscreteInputRange(10, 5);
    const addrs = discreteInputState.entries.map((e) => e.address);
    expect(addrs).toEqual([10, 11, 12, 13, 14]);
  });

  it("limits count so addresses don't exceed 65535", () => {
    applyDiscreteInputRange(65534, 10);
    expect(discreteInputState.entries.every((e) => e.address <= 65535)).toBe(true);
  });

  it("stress: 500-entry range", () => {
    applyDiscreteInputRange(100, 500);
    expect(discreteInputState.entries).toHaveLength(500);
    expect(discreteInputState.entries[499].address).toBe(599);
  });
});

// ── addDiscreteInputRange ─────────────────────────────────────────────────────

describe("addDiscreteInputRange", () => {
  it("merges new addresses without removing existing ones", () => {
    applyDiscreteInputRange(0, 4);
    addDiscreteInputRange(2, 6);
    const addrs = discreteInputState.entries.map((e) => e.address);
    expect(addrs).toContain(0);
    expect(addrs).toContain(7);
  });

  it("does not create duplicates", () => {
    applyDiscreteInputRange(0, 4);
    addDiscreteInputRange(0, 4);
    const addrs = discreteInputState.entries.map((e) => e.address);
    expect(new Set(addrs).size).toBe(addrs.length);
  });
});

// ── addExclusiveDiscreteInput ─────────────────────────────────────────────────

describe("addExclusiveDiscreteInput", () => {
  it("adds a new entry and returns true", () => {
    expect(addExclusiveDiscreteInput(50)).toBe(true);
    expect(discreteInputState.entries).toHaveLength(1);
    expect(discreteInputState.entries[0].address).toBe(50);
  });

  it("returns true for a duplicate address (idempotent)", () => {
    // The client implementation returns true even for existing addresses
    addExclusiveDiscreteInput(50);
    expect(addExclusiveDiscreteInput(50)).toBe(true);
    expect(discreteInputState.entries).toHaveLength(1);
  });

  it("rejects addresses below 0", () => {
    expect(addExclusiveDiscreteInput(-1)).toBe(false);
  });

  it("rejects addresses above 65535", () => {
    expect(addExclusiveDiscreteInput(65536)).toBe(false);
  });

  it("accepts boundary values 0 and 65535", () => {
    expect(addExclusiveDiscreteInput(0)).toBe(true);
    expect(addExclusiveDiscreteInput(65535)).toBe(true);
  });

  it("floors fractional addresses", () => {
    addExclusiveDiscreteInput(5.8);
    expect(discreteInputState.entries[0].address).toBe(5);
  });

  it("marks added entry as custom origin", () => {
    addExclusiveDiscreteInput(10);
    expect(discreteInputState.entries[0].origin).toBe("custom");
  });

  it("keeps entries sorted after addition", () => {
    addExclusiveDiscreteInput(40);
    addExclusiveDiscreteInput(10);
    addExclusiveDiscreteInput(25);
    const addrs = discreteInputState.entries.map((e) => e.address);
    expect(addrs).toEqual([10, 25, 40]);
  });
});

// ── removeDiscreteInput / removeAllDiscreteInputs ─────────────────────────────

describe("removeDiscreteInput", () => {
  it("removes the entry at the given address", () => {
    discreteInputState.entries = [makeEntry(1), makeEntry(2), makeEntry(3)];
    removeDiscreteInput(2);
    expect(discreteInputState.entries.map((e) => e.address)).toEqual([1, 3]);
  });

  it("does nothing for an unknown address", () => {
    discreteInputState.entries = [makeEntry(5)];
    removeDiscreteInput(99);
    expect(discreteInputState.entries).toHaveLength(1);
  });
});

describe("removeAllDiscreteInputs", () => {
  it("empties the entries array", () => {
    discreteInputState.entries = [makeEntry(1), makeEntry(2)];
    removeAllDiscreteInputs();
    expect(discreteInputState.entries).toHaveLength(0);
  });

  it("is idempotent when already empty", () => {
    removeAllDiscreteInputs();
    expect(discreteInputState.entries).toHaveLength(0);
  });
});

// ── setDiscreteInputFilter ────────────────────────────────────────────────────

describe("setDiscreteInputFilter", () => {
  it("sets filter to 'on'", () => {
    setDiscreteInputFilter("on");
    expect(discreteInputState.filter).toBe("on");
  });

  it("sets filter to 'off'", () => {
    setDiscreteInputFilter("off");
    expect(discreteInputState.filter).toBe("off");
  });

  it("sets filter to 'all'", () => {
    setDiscreteInputFilter("all");
    expect(discreteInputState.filter).toBe("all");
  });
});

// ── getFilteredDiscreteInputs ─────────────────────────────────────────────────

describe("getFilteredDiscreteInputs", () => {
  beforeEach(() => {
    discreteInputState.entries = [
      makeEntry(0, { value: false }),
      makeEntry(1, { value: true }),
      makeEntry(2, { value: false }),
      makeEntry(3, { value: true }),
    ];
  });

  it("'all' returns all entries", () => {
    setDiscreteInputFilter("all");
    expect(getFilteredDiscreteInputs()).toHaveLength(4);
  });

  it("'on' returns only entries with value=true", () => {
    setDiscreteInputFilter("on");
    const result = getFilteredDiscreteInputs();
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.value)).toBe(true);
  });

  it("'off' returns only entries with value=false", () => {
    setDiscreteInputFilter("off");
    const result = getFilteredDiscreteInputs();
    expect(result).toHaveLength(2);
    expect(result.every((e) => !e.value)).toBe(true);
  });
});

// ── setDiscreteInputView ──────────────────────────────────────────────────────

describe("setDiscreteInputView", () => {
  it("sets view to 'switch'", () => {
    setDiscreteInputView("switch");
    expect(discreteInputState.view).toBe("switch");
  });

  it("sets view to 'table'", () => {
    setDiscreteInputView("switch");
    setDiscreteInputView("table");
    expect(discreteInputState.view).toBe("table");
  });
});

// ── setDiscreteInputLabel ─────────────────────────────────────────────────────

describe("setDiscreteInputLabel", () => {
  it("sets label on a known address", () => {
    discreteInputState.entries = [makeEntry(8)];
    setDiscreteInputLabel(8, "proximity sensor");
    expect(discreteInputState.entries[0].label).toBe("proximity sensor");
  });

  it("does nothing for an unknown address", () => {
    discreteInputState.entries = [makeEntry(8)];
    setDiscreteInputLabel(99, "noop");
    expect(discreteInputState.entries[0].label).toBe("");
  });
});

// ── generateRandomExclusiveDiscreteInputAddress ───────────────────────────────

describe("generateRandomExclusiveDiscreteInputAddress", () => {
  it("returns an address not already in the entries", () => {
    discreteInputState.entries = [makeEntry(0), makeEntry(1), makeEntry(2)];
    const addr = generateRandomExclusiveDiscreteInputAddress();
    expect(addr).not.toBeNull();
    expect(discreteInputState.entries.some((e) => e.address === addr)).toBe(false);
  });
});

// ── Stress: rapid add / remove cycle ─────────────────────────────────────────

describe("stress: rapid add/remove cycle", () => {
  it("handles 300 exclusive add + remove ops without state corruption", () => {
    for (let i = 0; i < 300; i++) {
      addExclusiveDiscreteInput(i);
    }
    expect(discreteInputState.entries).toHaveLength(300);

    for (let i = 0; i < 150; i++) {
      removeDiscreteInput(i);
    }
    expect(discreteInputState.entries).toHaveLength(150);
    expect(discreteInputState.entries.every((e) => e.address >= 150)).toBe(true);
  });
});
