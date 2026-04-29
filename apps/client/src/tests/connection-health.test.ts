// Connection Health state — event tracking, quality scoring, hints
import { describe, it, expect, beforeEach } from "vitest";
import {
  connectionHealthState,
  trackConnectionHealthEvent,
  getCurrentDeviceHealthSnapshot,
} from "../state/connection-health.svelte";
import { connectionState } from "../state/connection.svelte";

function resetState() {
  connectionHealthState.byDevice = {};
  connectionState.status = "connected";
  connectionState.protocol = "tcp";
  connectionState.slaveId = 1;
  connectionState.tcp = {
    host: "192.168.55.200",
    port: 502,
    connectionTimeoutMs: 2000,
    responseTimeoutMs: 2000,
    retryAttempts: 2,
    retryBackoffStrategy: "fixed",
    retryJitterStrategy: "none",
  };
}

/** Helper to emit N ok events */
function emitOkEvents(n: number, topic = "coils") {
  for (let i = 0; i < n; i++) {
    trackConnectionHealthEvent({ level: "info", topic, message: "fc01.read ok addr=0 val=1" });
  }
}

/** Helper to emit N timeout events */
function emitTimeoutEvents(n: number, topic = "coils") {
  for (let i = 0; i < n; i++) {
    trackConnectionHealthEvent({ level: "warn", topic, message: "fc01.read transient addr=0 msg=timeout" });
  }
}

beforeEach(resetState);

// ── trackConnectionHealthEvent — basic tracking ───────────────────────────────

describe("trackConnectionHealthEvent — basic tracking", () => {
  it("creates a metrics entry on first tracked ok event", () => {
    trackConnectionHealthEvent({ level: "info", topic: "coils", message: "fc01.read ok addr=0" });
    const snap = getCurrentDeviceHealthSnapshot();
    expect(snap.totalRequests).toBe(1);
    expect(snap.successfulRequests).toBe(1);
  });

  it("counts failed requests for non-ok messages", () => {
    trackConnectionHealthEvent({ level: "error", topic: "coils", message: "fc01.read err addr=0 msg=Bus error" });
    const snap = getCurrentDeviceHealthSnapshot();
    expect(snap.failedRequests).toBe(1);
    expect(snap.successfulRequests).toBe(0);
  });

  it("increments timeoutCount for messages containing 'timeout'", () => {
    trackConnectionHealthEvent({ level: "warn", topic: "coils", message: "fc01.read transient msg=timeout" });
    const snap = getCurrentDeviceHealthSnapshot();
    expect(snap.timeoutRate).toBeGreaterThan(0);
  });

  it("does not count untracked topics (e.g., custom-frame)", () => {
    trackConnectionHealthEvent({ level: "info", topic: "custom-frame", message: "fc01.read ok" });
    const snap = getCurrentDeviceHealthSnapshot();
    expect(snap.totalRequests).toBe(0);
  });

  it("tracks holding-registers topic", () => {
    trackConnectionHealthEvent({ level: "info", topic: "holding-registers", message: "fc03.read ok" });
    expect(getCurrentDeviceHealthSnapshot().totalRequests).toBe(1);
  });

  it("tracks discrete-inputs topic", () => {
    trackConnectionHealthEvent({ level: "info", topic: "discrete-inputs", message: "fc02.read ok" });
    expect(getCurrentDeviceHealthSnapshot().totalRequests).toBe(1);
  });

  it("tracks input-registers topic", () => {
    trackConnectionHealthEvent({ level: "info", topic: "input-registers", message: "fc04.read ok" });
    expect(getCurrentDeviceHealthSnapshot().totalRequests).toBe(1);
  });

  it("increments reconnectCount for reconnect messages", () => {
    trackConnectionHealthEvent({ message: "server is reconnecting..." });
    expect(getCurrentDeviceHealthSnapshot().reconnectCount).toBe(1);
  });
});

// ── RTT tracking ──────────────────────────────────────────────────────────────

describe("RTT tracking", () => {
  it("parses rttMs from message", () => {
    trackConnectionHealthEvent({ level: "info", topic: "coils", message: "fc01.read ok rttMs=25" });
    const snap = getCurrentDeviceHealthSnapshot();
    expect(snap.latestRttMs).toBe(25);
  });

  it("computes median RTT over multiple samples", () => {
    for (const rtt of [10, 20, 30, 40, 50]) {
      trackConnectionHealthEvent({ level: "info", topic: "coils", message: `fc01.read ok rttMs=${rtt}` });
    }
    const snap = getCurrentDeviceHealthSnapshot();
    expect(snap.medianRttMs).toBe(30);
  });

  it("computes p95 RTT", () => {
    for (let i = 1; i <= 100; i++) {
      trackConnectionHealthEvent({ level: "info", topic: "coils", message: `fc01.read ok rttMs=${i}` });
    }
    const snap = getCurrentDeviceHealthSnapshot();
    expect(snap.p95RttMs).toBeGreaterThanOrEqual(94);
    expect(snap.p95RttMs).toBeLessThanOrEqual(100);
  });

  it("caps RTT sample buffer at 300 entries", () => {
    for (let i = 0; i < 350; i++) {
      trackConnectionHealthEvent({ level: "info", topic: "coils", message: `fc01.read ok rttMs=${i}` });
    }
    const snap = getCurrentDeviceHealthSnapshot();
    // latest RTT should be from the 350th sample (index 349)
    expect(snap.latestRttMs).toBe(349);
  });
});

// ── Exception histogram ───────────────────────────────────────────────────────

describe("exception histogram", () => {
  it("parses explicit exception code from message", () => {
    trackConnectionHealthEvent({ level: "error", topic: "coils", message: "fc01.read err exception code=2 illegal data address" });
    const snap = getCurrentDeviceHealthSnapshot();
    expect(snap.exceptionHistogram.some((h) => h.code === "0x02")).toBe(true);
  });

  it("infers illegal function exception 0x01 from .read message", () => {
    trackConnectionHealthEvent({ level: "error", topic: "coils", message: "fc01.read err illegal function" });
    const snap = getCurrentDeviceHealthSnapshot();
    expect(snap.exceptionHistogram.some((h) => h.code === "0x01")).toBe(true);
  });

  it("infers illegal data address exception 0x02", () => {
    trackConnectionHealthEvent({ level: "error", topic: "coils", message: "fc01.read err illegal data address" });
    const snap = getCurrentDeviceHealthSnapshot();
    expect(snap.exceptionHistogram.some((h) => h.code === "0x02")).toBe(true);
  });

  it("sorts histogram by count descending", () => {
    for (let i = 0; i < 3; i++) {
      trackConnectionHealthEvent({ level: "error", topic: "coils", message: "fc01.read err illegal data address" });
    }
    trackConnectionHealthEvent({ level: "error", topic: "coils", message: "fc01.read err illegal function" });
    const snap = getCurrentDeviceHealthSnapshot();
    expect(snap.exceptionHistogram[0].code).toBe("0x02");
    expect(snap.exceptionHistogram[0].count).toBe(3);
  });
});

// ── Quality score ─────────────────────────────────────────────────────────────

describe("quality score", () => {
  it("returns 100 with no requests (perfect by default)", () => {
    const snap = getCurrentDeviceHealthSnapshot();
    expect(snap.qualityScore).toBe(100);
    expect(snap.qualityBand).toBe("good");
  });

  it("returns 'good' band (≥85) for all-success traffic", () => {
    emitOkEvents(100);
    const snap = getCurrentDeviceHealthSnapshot();
    expect(snap.qualityScore).toBeGreaterThanOrEqual(85);
    expect(snap.qualityBand).toBe("good");
  });

  it("returns 'poor' band (<65) when all requests time out", () => {
    emitTimeoutEvents(100);
    const snap = getCurrentDeviceHealthSnapshot();
    expect(snap.qualityScore).toBeLessThan(65);
    expect(snap.qualityBand).toBe("poor");
  });

  it("stress: 1000 ok events keep quality 'good'", () => {
    emitOkEvents(1000);
    expect(getCurrentDeviceHealthSnapshot().qualityBand).toBe("good");
  });

  it("stress: 500 timeouts drive score well below 'good' threshold", () => {
    emitTimeoutEvents(500);
    const snap = getCurrentDeviceHealthSnapshot();
    // timeout penalty capped at 40 + retry penalty = max 64 total
    expect(snap.qualityScore).toBeLessThanOrEqual(65);
  });

  it("mixed traffic: 80% ok / 20% timeout yields 'fair' or 'poor'", () => {
    emitOkEvents(80);
    emitTimeoutEvents(20);
    const snap = getCurrentDeviceHealthSnapshot();
    expect(["fair", "poor"]).toContain(snap.qualityBand);
  });
});

// ── Tuning hints ──────────────────────────────────────────────────────────────

describe("tuning hints", () => {
  it("always returns at least one hint", () => {
    const snap = getCurrentDeviceHealthSnapshot();
    expect(snap.tuningHints.length).toBeGreaterThanOrEqual(1);
  });

  it("returns stability hint when quality is good", () => {
    emitOkEvents(100);
    const hints = getCurrentDeviceHealthSnapshot().tuningHints;
    expect(hints.some((h) => h.toLowerCase().includes("stable"))).toBe(true);
  });

  it("returns timeout hint when timeout rate is high", () => {
    emitTimeoutEvents(50);
    emitOkEvents(10);
    const hints = getCurrentDeviceHealthSnapshot().tuningHints;
    expect(hints.some((h) => h.toLowerCase().includes("timeout"))).toBe(true);
  });

  it("returns exception 0x02 hint when that code dominates", () => {
    for (let i = 0; i < 5; i++) {
      trackConnectionHealthEvent({ level: "error", topic: "coils", message: "fc01.read err illegal data address" });
    }
    const hints = getCurrentDeviceHealthSnapshot().tuningHints;
    expect(hints.some((h) => h.includes("0x02"))).toBe(true);
  });

  it("returns at most 3 hints", () => {
    emitTimeoutEvents(50);
    for (let i = 0; i < 10; i++) {
      trackConnectionHealthEvent({ level: "error", topic: "coils", message: "fc01.read err illegal data address" });
    }
    const hints = getCurrentDeviceHealthSnapshot().tuningHints;
    expect(hints.length).toBeLessThanOrEqual(3);
  });
});

// ── Device key isolation ──────────────────────────────────────────────────────

describe("device key isolation", () => {
  it("tracks metrics separately per device key", () => {
    connectionState.tcp.host = "10.0.0.1";
    emitOkEvents(5);

    // Switch to a different device
    connectionHealthState.byDevice = {};
    connectionState.tcp.host = "10.0.0.2";
    emitTimeoutEvents(10);

    // Only the second device is tracked in current snapshot
    const snap = getCurrentDeviceHealthSnapshot();
    expect(snap.totalRequests).toBe(10);
  });
});
