// Server: Settings state — persistence, normalization, formatters
import { describe, it, expect, beforeEach } from "vitest";
import {
  settingsState,
  resetSettingsToDefaults,
  setRememberLastFeatureState,
  setValueViewFormat,
  setForcedLayoutMode,
  setGlobalPollingDefaultInterval,
  setGlobalPollingMaxAddressCount,
  setTcpHeartbeatEnabled,
  setTcpHeartbeatIdleAfterMs,
  setLogTimeFormat,
  setLogTimePrecision,
  setMaxRetainedLogEntries,
  setFeatureDefaults,
  getSettingsSnapshot,
  getGlobalPollingMaxAddressCount,
  isPollingAllowedForCount,
  formatAddressWithSettings,
  formatWordValueWithSettings,
  enforceLogRetention,
  DEFAULT_SETTINGS,
} from "../state/settings.svelte";

function resetSettings() {
  resetSettingsToDefaults();
  localStorage.clear();
}

beforeEach(resetSettings);

// ── resetSettingsToDefaults ───────────────────────────────────────────────────

describe("resetSettingsToDefaults", () => {
  it("restores all settings to DEFAULT_SETTINGS values", () => {
    setValueViewFormat("hex");
    setGlobalPollingDefaultInterval(5000);
    resetSettingsToDefaults();
    expect(settingsState.valueViewFormat).toBe(DEFAULT_SETTINGS.valueViewFormat);
    expect(settingsState.polling.defaultIntervalMs).toBe(DEFAULT_SETTINGS.polling.defaultIntervalMs);
  });
});

// ── setRememberLastFeatureState ───────────────────────────────────────────────

describe("setRememberLastFeatureState", () => {
  it("sets to false", () => {
    setRememberLastFeatureState(false);
    expect(settingsState.rememberLastFeatureState).toBe(false);
  });

  it("sets to true", () => {
    setRememberLastFeatureState(false);
    setRememberLastFeatureState(true);
    expect(settingsState.rememberLastFeatureState).toBe(true);
  });
});

// ── setValueViewFormat ────────────────────────────────────────────────────────

describe("setValueViewFormat", () => {
  it("sets 'hex'", () => {
    setValueViewFormat("hex");
    expect(settingsState.valueViewFormat).toBe("hex");
  });

  it("sets 'dec'", () => {
    setValueViewFormat("hex");
    setValueViewFormat("dec");
    expect(settingsState.valueViewFormat).toBe("dec");
  });
});

// ── setForcedLayoutMode ───────────────────────────────────────────────────────

describe("setForcedLayoutMode", () => {
  it("sets 'desktop'", () => {
    setForcedLayoutMode("desktop");
    expect(settingsState.forcedLayoutMode).toBe("desktop");
  });

  it("sets 'mobile'", () => {
    setForcedLayoutMode("mobile");
    expect(settingsState.forcedLayoutMode).toBe("mobile");
  });

  it("sets 'auto'", () => {
    setForcedLayoutMode("mobile");
    setForcedLayoutMode("auto");
    expect(settingsState.forcedLayoutMode).toBe("auto");
  });
});

// ── setGlobalPollingDefaultInterval ──────────────────────────────────────────

describe("setGlobalPollingDefaultInterval", () => {
  it("sets a valid interval", () => {
    setGlobalPollingDefaultInterval(2000);
    expect(settingsState.polling.defaultIntervalMs).toBe(2000);
  });

  it("clamps to minimum 250", () => {
    setGlobalPollingDefaultInterval(50);
    expect(settingsState.polling.defaultIntervalMs).toBe(250);
  });

  it("floors fractional value", () => {
    setGlobalPollingDefaultInterval(1500.9);
    expect(settingsState.polling.defaultIntervalMs).toBe(1500);
  });
});

// ── setGlobalPollingMaxAddressCount ───────────────────────────────────────────

describe("setGlobalPollingMaxAddressCount", () => {
  it("sets a valid count", () => {
    setGlobalPollingMaxAddressCount(200);
    expect(settingsState.polling.maxAddressCountForPolling).toBe(200);
  });

  it("clamps to minimum 1", () => {
    setGlobalPollingMaxAddressCount(0);
    expect(settingsState.polling.maxAddressCountForPolling).toBe(1);
  });
});

// ── getGlobalPollingMaxAddressCount / isPollingAllowedForCount ────────────────

describe("getGlobalPollingMaxAddressCount / isPollingAllowedForCount", () => {
  it("returns current max", () => {
    setGlobalPollingMaxAddressCount(50);
    expect(getGlobalPollingMaxAddressCount()).toBe(50);
  });

  it("isPollingAllowedForCount true when count ≤ max", () => {
    setGlobalPollingMaxAddressCount(100);
    expect(isPollingAllowedForCount(100)).toBe(true);
  });

  it("isPollingAllowedForCount false when count > max", () => {
    setGlobalPollingMaxAddressCount(100);
    expect(isPollingAllowedForCount(101)).toBe(false);
  });
});

// ── setTcpHeartbeat ───────────────────────────────────────────────────────────

describe("setTcpHeartbeatEnabled", () => {
  it("sets to false", () => {
    setTcpHeartbeatEnabled(false);
    expect(settingsState.tcpHealth.heartbeatEnabled).toBe(false);
  });

  it("sets to true", () => {
    setTcpHeartbeatEnabled(false);
    setTcpHeartbeatEnabled(true);
    expect(settingsState.tcpHealth.heartbeatEnabled).toBe(true);
  });
});

describe("setTcpHeartbeatIdleAfterMs", () => {
  it("sets a valid idle timeout", () => {
    setTcpHeartbeatIdleAfterMs(10000);
    expect(settingsState.tcpHealth.heartbeatIdleAfterMs).toBe(10000);
  });

  it("clamps to minimum 1000", () => {
    setTcpHeartbeatIdleAfterMs(100);
    expect(settingsState.tcpHealth.heartbeatIdleAfterMs).toBe(1000);
  });
});

// ── setLogTimeFormat / setLogTimePrecision ────────────────────────────────────

describe("setLogTimeFormat", () => {
  it("sets '12h'", () => {
    setLogTimeFormat("12h");
    expect(settingsState.logs.timeFormat).toBe("12h");
  });

  it("sets '24h'", () => {
    setLogTimeFormat("12h");
    setLogTimeFormat("24h");
    expect(settingsState.logs.timeFormat).toBe("24h");
  });
});

describe("setLogTimePrecision", () => {
  it("sets 'ms'", () => {
    setLogTimePrecision("ms");
    expect(settingsState.logs.timePrecision).toBe("ms");
  });

  it("sets 's'", () => {
    setLogTimePrecision("ms");
    setLogTimePrecision("s");
    expect(settingsState.logs.timePrecision).toBe("s");
  });
});

// ── setMaxRetainedLogEntries ──────────────────────────────────────────────────

describe("setMaxRetainedLogEntries", () => {
  it("sets a valid count", () => {
    setMaxRetainedLogEntries(2000);
    expect(settingsState.logs.maxRetainedEntries).toBe(2000);
  });

  it("clamps to minimum 200", () => {
    setMaxRetainedLogEntries(50);
    expect(settingsState.logs.maxRetainedEntries).toBe(200);
  });
});

// ── setFeatureDefaults ────────────────────────────────────────────────────────

describe("setFeatureDefaults", () => {
  it("updates coils default startAddress", () => {
    setFeatureDefaults("coils", { startAddress: 100 });
    expect(settingsState.defaults.coils.startAddress).toBe(100);
  });

  it("updates holdingRegisters default count", () => {
    setFeatureDefaults("holdingRegisters", { count: 32 });
    expect(settingsState.defaults.holdingRegisters.count).toBe(32);
  });

  it("updates discreteInputs default view", () => {
    setFeatureDefaults("discreteInputs", { view: "switch" });
    expect(settingsState.defaults.discreteInputs.view).toBe("switch");
  });

  it("does not affect other feature defaults", () => {
    const before = { ...settingsState.defaults.inputRegisters };
    setFeatureDefaults("coils", { startAddress: 200 });
    expect(settingsState.defaults.inputRegisters.startAddress).toBe(before.startAddress);
  });

  it("normalizes negative startAddress to 0", () => {
    setFeatureDefaults("coils", { startAddress: -10 });
    expect(settingsState.defaults.coils.startAddress).toBe(0);
  });

  it("normalizes count to 1 minimum", () => {
    setFeatureDefaults("coils", { count: 0 });
    expect(settingsState.defaults.coils.count).toBe(1);
  });
});

// ── getSettingsSnapshot ───────────────────────────────────────────────────────

describe("getSettingsSnapshot", () => {
  it("returns a deep copy that does not mutate state", () => {
    const snap = getSettingsSnapshot();
    (snap as Record<string, unknown>).valueViewFormat = "hex";
    expect(settingsState.valueViewFormat).toBe("dec");
  });

  it("normalizes unknown valueViewFormat to default", () => {
    (settingsState as Record<string, unknown>).valueViewFormat = "binary";
    const snap = getSettingsSnapshot();
    expect(snap.valueViewFormat).toBe("dec");
  });
});

// ── formatAddressWithSettings ─────────────────────────────────────────────────

describe("formatAddressWithSettings", () => {
  it("formats decimal 42 as '0042'", () => {
    setValueViewFormat("dec");
    expect(formatAddressWithSettings(42)).toBe("0042");
  });

  it("formats 255 as '0x00FF' in hex mode", () => {
    setValueViewFormat("hex");
    expect(formatAddressWithSettings(255)).toBe("0x00FF");
  });

  it("handles 65535 in hex mode", () => {
    setValueViewFormat("hex");
    expect(formatAddressWithSettings(65535)).toBe("0xFFFF");
  });

  it("handles 0 in hex mode", () => {
    setValueViewFormat("hex");
    expect(formatAddressWithSettings(0)).toBe("0x0000");
  });
});

// ── formatWordValueWithSettings ───────────────────────────────────────────────

describe("formatWordValueWithSettings", () => {
  it("formats 1234 as '1234' in dec mode", () => {
    setValueViewFormat("dec");
    expect(formatWordValueWithSettings(1234)).toBe("1234");
  });

  it("formats 0x1234 as '0x1234' in hex mode", () => {
    setValueViewFormat("hex");
    expect(formatWordValueWithSettings(0x1234)).toBe("0x1234");
  });

  it("clamps to 0 for negative", () => {
    setValueViewFormat("dec");
    expect(formatWordValueWithSettings(-1)).toBe("0");
  });

  it("clamps to 65535 for over-range", () => {
    setValueViewFormat("dec");
    expect(formatWordValueWithSettings(99999)).toBe("65535");
  });
});

// ── enforceLogRetention ───────────────────────────────────────────────────────

describe("enforceLogRetention", () => {
  it("returns original array if entries ≤ max", () => {
    setMaxRetainedLogEntries(4000);
    const entries = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    expect(enforceLogRetention(entries)).toHaveLength(100);
  });

  it("trims to last maxRetainedEntries when over the limit", () => {
    setMaxRetainedLogEntries(4000);
    const entries = Array.from({ length: 4100 }, (_, i) => ({ id: i }));
    const result = enforceLogRetention(entries);
    expect(result).toHaveLength(4000);
    expect(result[0].id).toBe(100);
    expect(result[3999].id).toBe(4099);
  });

  it("stress: correctly trims 10000 entries to 4000", () => {
    setMaxRetainedLogEntries(4000);
    const entries = Array.from({ length: 10000 }, (_, i) => ({ id: i }));
    const result = enforceLogRetention(entries);
    expect(result).toHaveLength(4000);
    expect(result[0].id).toBe(6000);
    expect(result[3999].id).toBe(9999);
  });
});
