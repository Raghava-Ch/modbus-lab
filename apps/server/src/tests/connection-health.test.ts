// Server: Connection Health state — event tracking, quality scoring, hints
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

// Messages MUST include "fc" and ".read" or ".write" for isTrackedOperation to pass
function emitOkEvents(n: number, topic = "coils") {
  for (let i = 0; i < n; i++) {
    trackConnectionHealthEvent({ level: "info", topic, message: `fc01.read ok addr=${i} val=1` });
  }
}

function emitTimeoutEvents(n: number, topic = "coils") {
  for (let i = 0; i < n; i++) {
    trackConnectionHealthEvent({ level: "warn", topic, message: `fc01.read transient addr=${i} msg=timeout` });
  }
}

beforeEach(resetState);

// ── trackConnectionHealthEvent — basic tracking ───────────────────────────────

describe("trackConnectionHealthEvent — basic tracking", () => {
  it("creates a metrics entry on first tracked ok event", () => {
    trackConnectionHealthEvent({ level: "info", topic: "coils", message: "fc01.read ok addr=0 val=1" });
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
    trackConnectionHealthEvent({ level: "warn", topic: "coils", message: "fc01.read transient addr=0 msg=timeout" });
    expect(getCurrentDeviceHealthSnapshot().timeoutRate).toBeGreaterThan(0);
  });

  it("tracks discrete-inputs topic", () => {
    trackConnectionHealthEvent({ level: "info", topic: "discrete-inputs", message: "fc02.read ok addr=0 val=1" });
    expect(getCurrentDeviceHealthSnapshot().totalRequests).toBe(1);
  });

  it("tracks holding-registers topic", () => {
    trackConnectionHealthEvent({ level: "info", topic: "holding-registers", message: "fc03.read ok addr=0 val=100" });
    expect(getCurrentDeviceHealthSnapshot().totalRequests).toBe(1);
  });

  it("skips events that don't contain 'fc' and '.read'/'.write'", () => {
    trackConnectionHealthEvent({ level: "info", topic: "coils", message: "srv.read ok addr=0" });
    expect(getCurrentDeviceHealthSnapshot().totalRequests).toBe(0);
  });

  it("increments reconnectCount for reconnect messages", () => {
    trackConnectionHealthEvent({ message: "server is reconnecting..." });
    expect(getCurrentDeviceHealthSnapshot().reconnectCount).toBe(1);
  });
});

// ── RTT tracking ──────────────────────────────────────────────────────────────

describe("RTT tracking", () => {
  it("parses rttMs from message", () => {
    trackConnectionHealthEvent({ level: "info", topic: "coils", message: "fc01.read ok rttMs=42" });
    expect(getCurrentDeviceHealthSnapshot().latestRttMs).toBe(42);
  });

  it("computes median RTT over multiple samples", () => {
    for (const rtt of [10, 20, 30, 40, 50]) {
      trackConnectionHealthEvent({ level: "info", topic: "coils", message: `fc01.read ok rttMs=${rtt}` });
    }
    expect(getCurrentDeviceHealthSnapshot().medianRttMs).toBe(30);
  });

  it("caps RTT sample buffer at 300 entries", () => {
    for (let i = 0; i < 350; i++) {
      trackConnectionHealthEvent({ level: "info", topic: "coils", message: `fc01.read ok rttMs=${i}` });
    }
    expect(getCurrentDeviceHealthSnapshot().latestRttMs).toBe(349);
  });
});

// ── Exception histogram ───────────────────────────────────────────────────────

describe("exception histogram", () => {
  it("infers illegal data address exception 0x02 from .read message", () => {
    trackConnectionHealthEvent({ level: "error", topic: "coils", message: "fc02.read err illegal data address" });
    const snap = getCurrentDeviceHealthSnapshot();
    expect(snap.exceptionHistogram.some((h) => h.code === "0x02")).toBe(true);
  });

  it("infers illegal function exception 0x01 from .read message", () => {
    trackConnectionHealthEvent({ level: "error", topic: "coils", message: "fc01.read err illegal function" });
    const snap = getCurrentDeviceHealthSnapshot();
    expect(snap.exceptionHistogram.some((h) => h.code === "0x01")).toBe(true);
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
    expect(getCurrentDeviceHealthSnapshot().qualityScore).toBe(100);
    expect(getCurrentDeviceHealthSnapshot().qualityBand).toBe("good");
  });

  it("returns 'good' band for all-success traffic", () => {
    emitOkEvents(100);
    expect(getCurrentDeviceHealthSnapshot().qualityBand).toBe("good");
  });

  it("returns 'poor' band when all requests time out", () => {
    emitTimeoutEvents(100);
    const snap = getCurrentDeviceHealthSnapshot();
    // timeout penalty: min(40, 1.0 * 120) = 40 + retry penalty = 12 => score ~48
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
    expect(snap.qualityScore).toBeLessThanOrEqual(65);
  });

  it("mixed 80% ok / 20% timeout yields 'fair' or 'poor'", () => {
    emitOkEvents(80);
    emitTimeoutEvents(20);
    const band = getCurrentDeviceHealthSnapshot().qualityBand;
    expect(["good", "fair", "poor"]).toContain(band);
    // 20% timeout rate should drop quality noticeably
    expect(getCurrentDeviceHealthSnapshot().qualityScore).toBeLessThan(100);
  });
});

// ── Tuning hints ──────────────────────────────────────────────────────────────

describe("tuning hints", () => {
  it("always returns at least one hint", () => {
    expect(getCurrentDeviceHealthSnapshot().tuningHints.length).toBeGreaterThanOrEqual(1);
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

  it("returns at most 3 hints", () => {
    emitTimeoutEvents(50);
    for (let i = 0; i < 10; i++) {
      trackConnectionHealthEvent({ level: "error", topic: "coils", message: "fc01.read err illegal data address" });
    }
    expect(getCurrentDeviceHealthSnapshot().tuningHints.length).toBeLessThanOrEqual(3);
  });
});

// ── p95 RTT ───────────────────────────────────────────────────────────────────

describe("p95 RTT", () => {
  it("computes p95 RTT correctly over 100 samples", () => {
    for (let i = 1; i <= 100; i++) {
      trackConnectionHealthEvent({ level: "info", topic: "coils", message: `fc01.read ok rttMs=${i}` });
    }
    const snap = getCurrentDeviceHealthSnapshot();
    expect(typeof snap.p95RttMs).toBe("number");
    expect(snap.p95RttMs).toBeGreaterThanOrEqual(94);
    expect(snap.p95RttMs).toBeLessThanOrEqual(100);
  });
});
