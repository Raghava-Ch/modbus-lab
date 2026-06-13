import { connectionState } from "./connection.svelte";

export interface HealthEventPayload {
  level?: "info" | "warn" | "error" | "traffic";
  topic?: string;
  message?: string;
}

interface DeviceHealthMetrics {
  key: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  timeoutCount: number;
  retryBudgetConsumed: number;
  reconnectCount: number;
  rttSamplesMs: number[];
  exceptionHistogram: Record<string, number>;
  lastUpdatedAt: number;
}

export interface DeviceHealthSnapshot {
  key: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  timeoutRate: number;
  retryRate: number;
  reconnectCount: number;
  latestRttMs: number | null;
  medianRttMs: number | null;
  p95RttMs: number | null;
  qualityScore: number;
  qualityBand: "good" | "fair" | "poor";
  exceptionHistogram: Array<{ code: string; count: number }>;
  tuningHints: string[];
}

const RTT_SAMPLE_LIMIT = 300;

export const connectionHealthState = $state({
  byDevice: {} as Record<string, DeviceHealthMetrics>,
});

function currentDeviceKey(): string {
  const slave = connectionState.slaveId;
  if (connectionState.protocol === "tcp") {
    return `tcp|${connectionState.tcp.host}:${connectionState.tcp.port}|slave=${slave}`;
  }

  const parity = connectionState.serial.parity === "none"
    ? "N"
    : connectionState.serial.parity === "even"
      ? "E"
      : "O";
  return `${connectionState.protocol}|${connectionState.serial.port}@${connectionState.serial.baudRate}-${connectionState.serial.dataBits}${parity}${connectionState.serial.stopBits}|slave=${slave}`;
}

function getOrCreateCurrentMetrics(): DeviceHealthMetrics {
  const key = currentDeviceKey();
  const existing = connectionHealthState.byDevice[key];
  if (existing) {
    return existing;
  }

  const created: DeviceHealthMetrics = {
    key,
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    timeoutCount: 0,
    retryBudgetConsumed: 0,
    reconnectCount: 0,
    rttSamplesMs: [],
    exceptionHistogram: {},
    lastUpdatedAt: Date.now(),
  };

  connectionHealthState.byDevice = {
    ...connectionHealthState.byDevice,
    [key]: created,
  };
  return created;
}

function parseRttMs(message: string): number | null {
  const m = message.match(/rttMs=(\d+)/i);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

function parseExceptionCode(message: string): string | null {
  const lower = message.toLowerCase();
  const explicit = lower.match(/exception(?:\s*code)?[=: ](0x[0-9a-f]+|\d+)/i);
  if (explicit?.[1]) {
    const raw = explicit[1].toUpperCase();
    if (raw.startsWith("0X")) return raw;
    return `0x${Number(raw).toString(16).toUpperCase().padStart(2, "0")}`;
  }

  if (lower.includes("illegal function")) return "0x01";
  if (lower.includes("illegal data address")) return "0x02";
  if (lower.includes("illegal data value")) return "0x03";
  if (lower.includes("slave device failure")) return "0x04";
  if (lower.includes("gateway path unavailable")) return "0x0A";
  if (lower.includes("gateway target device failed")) return "0x0B";
  return null;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function median(values: number[]): number | null {
  return percentile(values, 50);
}

function computeQualityBand(score: number): "good" | "fair" | "poor" {
  if (score >= 85) return "good";
  if (score >= 65) return "fair";
  return "poor";
}

function buildHints(snapshot: {
  timeoutRate: number;
  retryRate: number;
  p95RttMs: number | null;
  topExceptionCode: string | null;
}): string[] {
  const hints: string[] = [];

  if (snapshot.timeoutRate >= 0.1) {
    hints.push("Timeout rate is high. Increase response timeout and poll interval, then reduce address batch size.");
  }
  if (snapshot.retryRate >= 0.2) {
    hints.push("Retry pressure is elevated. Check link quality, then tune baud/timeout and retry policy.");
  }
  if ((snapshot.p95RttMs ?? 0) >= 300) {
    hints.push("RTT p95 is high. Reduce polling frequency or split large ranges into smaller chunks.");
  }

  if (snapshot.topExceptionCode === "0x02") {
    hints.push("Exception 0x02 dominates. Verify address map and register range boundaries.");
  } else if (snapshot.topExceptionCode === "0x03") {
    hints.push("Exception 0x03 dominates. Validate quantity/format and function code compatibility.");
  } else if (snapshot.topExceptionCode === "0x01") {
    hints.push("Exception 0x01 dominates. Device may not support requested function for this endpoint.");
  }

  if (hints.length === 0) {
    hints.push("Connection quality is stable. Keep current timeout/retry settings.");
  }

  return hints.slice(0, 3);
}

function isTrackedOperation(topic: string, message: string): boolean {
  const t = topic.toLowerCase();
  if (t === "coils" || t === "discrete-inputs" || t === "holding-registers" || t === "input-registers") {
    return message.includes("fc") && (message.includes(".read") || message.includes(".write"));
  }
  return false;
}

export function trackConnectionHealthEvent(payload: HealthEventPayload): void {
  const message = payload.message ?? "";
  const topic = payload.topic ?? "";

  const metrics = getOrCreateCurrentMetrics();
  metrics.lastUpdatedAt = Date.now();

  if (message.toLowerCase().includes("reconnect")) {
    metrics.reconnectCount += 1;
  }

  if (!isTrackedOperation(topic, message)) {
    return;
  }

  metrics.totalRequests += 1;

  const lower = message.toLowerCase();
  const ok = lower.includes(" ok ") || lower.includes(" ok");
  const timeout = lower.includes("timeout") || lower.includes("timed out");

  if (ok) {
    metrics.successfulRequests += 1;
  } else {
    metrics.failedRequests += 1;
  }

  if (timeout) {
    metrics.timeoutCount += 1;
    metrics.retryBudgetConsumed += connectionState.protocol === "tcp" ? connectionState.tcp.retryAttempts : 0;
  }

  const exception = parseExceptionCode(message);
  if (exception) {
    metrics.exceptionHistogram[exception] = (metrics.exceptionHistogram[exception] ?? 0) + 1;
  }

  const rttMs = parseRttMs(message);
  if (rttMs != null) {
    metrics.rttSamplesMs.push(rttMs);
    if (metrics.rttSamplesMs.length > RTT_SAMPLE_LIMIT) {
      metrics.rttSamplesMs.splice(0, metrics.rttSamplesMs.length - RTT_SAMPLE_LIMIT);
    }
  }
}

export function getCurrentDeviceHealthSnapshot(): DeviceHealthSnapshot {
  const metrics = getOrCreateCurrentMetrics();

  const timeoutRate = metrics.totalRequests > 0 ? metrics.timeoutCount / metrics.totalRequests : 0;
  const retryRate = metrics.totalRequests > 0 ? metrics.retryBudgetConsumed / Math.max(1, metrics.totalRequests) : 0;
  const latestRttMs = metrics.rttSamplesMs.length > 0 ? metrics.rttSamplesMs[metrics.rttSamplesMs.length - 1] : null;
  const medianRttMs = median(metrics.rttSamplesMs);
  const p95RttMs = percentile(metrics.rttSamplesMs, 95);

  const exceptionHistogram = Object.entries(metrics.exceptionHistogram)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);

  const topExceptionCode = exceptionHistogram.length > 0 ? exceptionHistogram[0].code : null;

  const timeoutPenalty = Math.min(40, timeoutRate * 100 * 1.2);
  const retryPenalty = Math.min(25, retryRate * 12);
  const rttPenalty = p95RttMs == null ? 0 : Math.min(20, Math.max(0, (p95RttMs - 80) / 12));
  const exceptionPenalty = Math.min(15, exceptionHistogram.reduce((sum, h) => sum + h.count, 0) * 0.5);

  const qualityScore = Math.max(0, Math.min(100, Math.round(100 - timeoutPenalty - retryPenalty - rttPenalty - exceptionPenalty)));

  const tuningHints = buildHints({ timeoutRate, retryRate, p95RttMs, topExceptionCode });

  return {
    key: metrics.key,
    totalRequests: metrics.totalRequests,
    successfulRequests: metrics.successfulRequests,
    failedRequests: metrics.failedRequests,
    timeoutRate,
    retryRate,
    reconnectCount: metrics.reconnectCount,
    latestRttMs,
    medianRttMs,
    p95RttMs,
    qualityScore,
    qualityBand: computeQualityBand(qualityScore),
    exceptionHistogram,
    tuningHints,
  };
}
