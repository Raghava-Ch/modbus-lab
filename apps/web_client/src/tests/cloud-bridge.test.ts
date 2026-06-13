import { describe, it, expect, beforeEach } from "vitest";
import {
  addMapping,
  appendBridgeLog,
  buildStartRequest,
  clampAddress,
  clampInterval,
  clampKeepAlive,
  clampPort,
  cloudBridgeState,
  clearBridgeLog,
  MAX_LOG_ENTRIES,
  removeMapping,
  resetCloudBridgeState,
  setBridgeStatus,
  setBrokerField,
  updateMapping,
} from "../state/cloud-bridge.svelte";

beforeEach(() => {
  resetCloudBridgeState();
});

describe("cloud-bridge clamping helpers", () => {
  it("clampAddress floors and bounds 0..65535", () => {
    expect(clampAddress(-5)).toBe(0);
    expect(clampAddress(123.7)).toBe(123);
    expect(clampAddress(70000)).toBe(65535);
    expect(clampAddress(Number.NaN)).toBe(0);
  });

  it("clampInterval enforces 100..3_600_000ms", () => {
    expect(clampInterval(0)).toBe(100);
    expect(clampInterval(50)).toBe(100);
    expect(clampInterval(2000)).toBe(2000);
    expect(clampInterval(10_000_000)).toBe(3_600_000);
    expect(clampInterval(Number.NaN)).toBe(1000);
  });

  it("clampPort enforces 1..65535", () => {
    expect(clampPort(0)).toBe(1);
    expect(clampPort(70_000)).toBe(65535);
    expect(clampPort(8883)).toBe(8883);
    expect(clampPort(Number.NaN)).toBe(1883);
  });

  it("clampKeepAlive enforces 1..3600s", () => {
    expect(clampKeepAlive(0)).toBe(1);
    expect(clampKeepAlive(99_999)).toBe(3600);
    expect(clampKeepAlive(45)).toBe(45);
  });
});

describe("cloud-bridge state lifecycle", () => {
  it("starts empty and unconnected", () => {
    expect(cloudBridgeState.mappings).toEqual([]);
    expect(cloudBridgeState.status.running).toBe(false);
    expect(cloudBridgeState.status.connected).toBe(false);
    expect(cloudBridgeState.broker.host).toBe("");
    expect(cloudBridgeState.broker.port).toBe(1883);
    expect(cloudBridgeState.broker.path).toBe("/mqtt");
  });

  it("setBrokerField updates a single broker field", () => {
    setBrokerField("host", "broker.example.com");
    setBrokerField("useTls", true);
    expect(cloudBridgeState.broker.host).toBe("broker.example.com");
    expect(cloudBridgeState.broker.useTls).toBe(true);
  });

  it("addMapping appends with sensible defaults and unique ids", () => {
    const a = addMapping();
    const b = addMapping();
    expect(cloudBridgeState.mappings).toHaveLength(2);
    expect(a.id).not.toBe(b.id);
    expect(a.direction).toBe("publish");
    expect(a.area).toBe("holdingRegister");
    expect(a.qos).toBe(0);
    expect(a.publishIntervalMs).toBe(1000);
    expect(a.topic).toContain("{client_id}");
  });

  it("addMapping respects partial overrides and clamps inputs", () => {
    const m = addMapping({
      name: "custom",
      direction: "subscribe",
      area: "coil",
      address: 70_000,
      publishIntervalMs: 10,
    });
    expect(m.name).toBe("custom");
    expect(m.direction).toBe("subscribe");
    expect(m.address).toBe(65535);
    expect(m.publishIntervalMs).toBe(100);
  });

  it("removeMapping removes by id", () => {
    const a = addMapping();
    const b = addMapping();
    removeMapping(a.id);
    expect(cloudBridgeState.mappings.map((m) => m.id)).toEqual([b.id]);
  });

  it("updateMapping patches and re-clamps numeric fields", () => {
    const m = addMapping();
    updateMapping(m.id, { address: -1, publishIntervalMs: 99, topic: "foo/bar" });
    const updated = cloudBridgeState.mappings[0];
    expect(updated.address).toBe(0);
    expect(updated.publishIntervalMs).toBe(100);
    expect(updated.topic).toBe("foo/bar");
  });

  it("updateMapping is a no-op for unknown ids", () => {
    const m = addMapping();
    updateMapping("does-not-exist", { name: "x" });
    expect(cloudBridgeState.mappings[0].name).toBe(m.name);
  });

  it("setBridgeStatus shallow-merges status fields", () => {
    setBridgeStatus({ running: true, mappingCount: 3 });
    expect(cloudBridgeState.status.running).toBe(true);
    expect(cloudBridgeState.status.mappingCount).toBe(3);
    expect(cloudBridgeState.status.connected).toBe(false);
  });
});

describe("cloud-bridge log buffer", () => {
  it("appends and clears entries", () => {
    appendBridgeLog({ level: "info", message: "hello" });
    appendBridgeLog({ level: "traffic", message: "publish" });
    expect(cloudBridgeState.log).toHaveLength(2);
    expect(cloudBridgeState.log[0].id).not.toBe(cloudBridgeState.log[1].id);
    clearBridgeLog();
    expect(cloudBridgeState.log).toHaveLength(0);
  });

  it("evicts oldest entries past MAX_LOG_ENTRIES", () => {
    for (let i = 0; i < MAX_LOG_ENTRIES + 25; i++) {
      appendBridgeLog({ level: "info", message: `m${i}` });
    }
    expect(cloudBridgeState.log).toHaveLength(MAX_LOG_ENTRIES);
    // First retained entry should be from after the eviction point.
    expect(cloudBridgeState.log[0].message).toBe("m25");
    expect(cloudBridgeState.log[cloudBridgeState.log.length - 1].message).toBe(
      `m${MAX_LOG_ENTRIES + 24}`,
    );
  });
});

describe("cloud-bridge buildStartRequest", () => {
  it("emits a backend-shaped payload with normalized strings and clamped numbers", () => {
    setBrokerField("host", "  broker.test ");
    setBrokerField("clientId", " lab-1 ");
    setBrokerField("port", 70_000);
    setBrokerField("keepAliveSecs", 99_999);
    setBrokerField("username", "");
    setBrokerField("password", "");
    setBrokerField("path", " /mqtt ");

    addMapping({
      name: "n",
      direction: "publish",
      area: "holdingRegister",
      address: 100,
      topic: "t/{client_id}",
      qos: 2,
      retain: true,
      publishIntervalMs: 50,
    });

    const req = buildStartRequest();
    expect(req.broker.host).toBe("broker.test");
    expect(req.broker.clientId).toBe("lab-1");
    expect(req.broker.port).toBe(65535);
    expect(req.broker.keepAliveSecs).toBe(3600);
    expect(req.broker.username).toBeNull();
    expect(req.broker.password).toBeNull();
    expect(req.broker.path).toBe("/mqtt");

    expect(req.mappings).toHaveLength(1);
    const m = req.mappings[0];
    expect(m.address).toBe(100);
    expect(m.publishIntervalMs).toBe(100);
    expect(m.qos).toBe(2);
    expect(m.retain).toBe(true);
    expect(m.area).toBe("holdingRegister");
  });

  it("preserves non-empty credentials", () => {
    setBrokerField("host", "h");
    setBrokerField("username", "u");
    setBrokerField("password", "p");
    const req = buildStartRequest();
    expect(req.broker.username).toBe("u");
    expect(req.broker.password).toBe("p");
  });
});

describe("resetCloudBridgeState", () => {
  it("returns state to defaults", () => {
    setBrokerField("host", "x");
    addMapping();
    appendBridgeLog({ level: "warn", message: "z" });
    setBridgeStatus({ running: true });

    resetCloudBridgeState();

    expect(cloudBridgeState.broker.host).toBe("");
    expect(cloudBridgeState.mappings).toHaveLength(0);
    expect(cloudBridgeState.log).toHaveLength(0);
    expect(cloudBridgeState.status.running).toBe(false);
  });
});
