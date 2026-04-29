import { describe, it, expect, beforeEach } from "vitest";
import {
  connectionState,
  applyBackendConnectionStatus,
  setConnectionStatus,
  setSlaveId,
  setProtocol,
  updateTcpSettings,
  updateSerialSettings,
  setListenerClients,
  setListenerUptime,
} from "../state/connection.svelte";
import type { TcpSettings, ListenerClientSession } from "../state/connection.svelte";

const DEFAULT_TCP: TcpSettings = {
  host: "0.0.0.0",
  port: 502,
  responseTimeoutMs: 2000,
};

function resetState() {
  connectionState.status = "disconnected";
  connectionState.listenerStatus = "idle";
  connectionState.protocol = "tcp";
  connectionState.backendStatus = "disconnected";
  connectionState.backendDetails = "";
  connectionState.slaveId = 1;
  connectionState.tcp = { ...DEFAULT_TCP };
  connectionState.serial = {
    port: "",
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
  };
  connectionState.runtime = {
    activeClients: 0,
    uptimeMs: 0,
    lastError: "",
    startedAtMs: null,
  };
  connectionState.sessions = [];
}

describe("setConnectionStatus", () => {
  beforeEach(resetState);

  it("'connected' sets status=connected and listenerStatus=running", () => {
    setConnectionStatus("connected");
    expect(connectionState.status).toBe("connected");
    expect(connectionState.listenerStatus).toBe("running");
  });

  it("'connected' records startedAtMs if not already set", () => {
    const before = Date.now();
    setConnectionStatus("connected");
    expect(connectionState.runtime.startedAtMs).toBeGreaterThanOrEqual(before);
  });

  it("'connected' does NOT overwrite an existing startedAtMs", () => {
    connectionState.runtime.startedAtMs = 12345;
    setConnectionStatus("connected");
    expect(connectionState.runtime.startedAtMs).toBe(12345);
  });

  it("'connecting' sets status=connecting and listenerStatus=starting", () => {
    setConnectionStatus("connecting");
    expect(connectionState.status).toBe("connecting");
    expect(connectionState.listenerStatus).toBe("starting");
  });

  it("'reconnecting' sets listenerStatus=error", () => {
    setConnectionStatus("reconnecting");
    expect(connectionState.listenerStatus).toBe("error");
  });

  it("'disconnected' sets listenerStatus=idle and clears startedAtMs", () => {
    connectionState.runtime.startedAtMs = 99999;
    setConnectionStatus("disconnected");
    expect(connectionState.listenerStatus).toBe("idle");
    expect(connectionState.runtime.startedAtMs).toBeNull();
    expect(connectionState.runtime.uptimeMs).toBe(0);
  });
});

describe("applyBackendConnectionStatus", () => {
  beforeEach(resetState);

  it("'starting' → connecting", () => {
    applyBackendConnectionStatus("starting");
    expect(connectionState.status).toBe("connecting");
    expect(connectionState.listenerStatus).toBe("starting");
  });

  it("'connecting' → connecting", () => {
    applyBackendConnectionStatus("connecting");
    expect(connectionState.status).toBe("connecting");
  });

  it("'running' → connected + running", () => {
    applyBackendConnectionStatus("running");
    expect(connectionState.status).toBe("connected");
    expect(connectionState.listenerStatus).toBe("running");
  });

  it("'connected:tcp:...' → connected", () => {
    applyBackendConnectionStatus("connected:tcp:0.0.0.0:502");
    expect(connectionState.status).toBe("connected");
  });

  it("'error' → reconnecting + error listenerStatus + stores lastError", () => {
    applyBackendConnectionStatus("error", "bind failed");
    expect(connectionState.status).toBe("reconnecting");
    expect(connectionState.listenerStatus).toBe("error");
    expect(connectionState.runtime.lastError).toBe("bind failed");
  });

  it("'reconnecting' → reconnecting + error listenerStatus", () => {
    applyBackendConnectionStatus("reconnecting", "lost");
    expect(connectionState.status).toBe("reconnecting");
    expect(connectionState.listenerStatus).toBe("error");
    expect(connectionState.runtime.lastError).toBe("lost");
  });

  it("unknown status → disconnected", () => {
    applyBackendConnectionStatus("stopped");
    expect(connectionState.status).toBe("disconnected");
  });

  it("stores backendStatus and backendDetails", () => {
    applyBackendConnectionStatus("running", "tcp 0.0.0.0:502");
    expect(connectionState.backendStatus).toBe("running");
    expect(connectionState.backendDetails).toBe("tcp 0.0.0.0:502");
  });

  it("backendDetails defaults to empty string", () => {
    applyBackendConnectionStatus("running");
    expect(connectionState.backendDetails).toBe("");
  });
});

describe("setSlaveId", () => {
  beforeEach(resetState);

  it("sets a valid slave ID", () => {
    setSlaveId(10);
    expect(connectionState.slaveId).toBe(10);
  });

  it("clamps below 1 to 1", () => {
    setSlaveId(0);
    expect(connectionState.slaveId).toBe(1);
  });

  it("clamps above 247 to 247", () => {
    setSlaveId(300);
    expect(connectionState.slaveId).toBe(247);
  });

  it("accepts boundary value 1", () => {
    setSlaveId(1);
    expect(connectionState.slaveId).toBe(1);
  });

  it("accepts boundary value 247", () => {
    setSlaveId(247);
    expect(connectionState.slaveId).toBe(247);
  });
});

describe("setProtocol", () => {
  beforeEach(resetState);

  it("switches to serial-rtu", () => {
    setProtocol("serial-rtu");
    expect(connectionState.protocol).toBe("serial-rtu");
  });

  it("switches back to tcp", () => {
    setProtocol("serial-rtu");
    setProtocol("tcp");
    expect(connectionState.protocol).toBe("tcp");
  });
});

describe("updateTcpSettings", () => {
  beforeEach(resetState);

  it("updates host", () => {
    updateTcpSettings({ host: "127.0.0.1" });
    expect(connectionState.tcp.host).toBe("127.0.0.1");
  });

  it("clamps port 0 to 1", () => {
    updateTcpSettings({ port: 0 });
    expect(connectionState.tcp.port).toBe(1);
  });

  it("clamps port above 65535 to 65535", () => {
    updateTcpSettings({ port: 99999 });
    expect(connectionState.tcp.port).toBe(65535);
  });

  it("rounds non-integer port", () => {
    updateTcpSettings({ port: 502.6 });
    expect(connectionState.tcp.port).toBe(503);
  });

  it("clamps responseTimeoutMs to 100–600000", () => {
    updateTcpSettings({ responseTimeoutMs: 10 });
    expect(connectionState.tcp.responseTimeoutMs).toBe(100);
    updateTcpSettings({ responseTimeoutMs: 700000 });
    expect(connectionState.tcp.responseTimeoutMs).toBe(600000);
  });

  it("partial update preserves unchanged fields", () => {
    updateTcpSettings({ host: "192.168.1.1" });
    expect(connectionState.tcp.port).toBe(502);
    expect(connectionState.tcp.responseTimeoutMs).toBe(2000);
  });
});

describe("updateSerialSettings", () => {
  beforeEach(resetState);

  it("updates baud rate", () => {
    updateSerialSettings({ baudRate: 115200 });
    expect(connectionState.serial.baudRate).toBe(115200);
  });

  it("clamps baudRate below 1200 to 1200", () => {
    updateSerialSettings({ baudRate: 100 });
    expect(connectionState.serial.baudRate).toBe(1200);
  });

  it("clamps baudRate above 921600 to 921600", () => {
    updateSerialSettings({ baudRate: 2000000 });
    expect(connectionState.serial.baudRate).toBe(921600);
  });

  it("clamps dataBits to 5–8", () => {
    updateSerialSettings({ dataBits: 4 });
    expect(connectionState.serial.dataBits).toBe(5);
    updateSerialSettings({ dataBits: 9 });
    expect(connectionState.serial.dataBits).toBe(8);
  });

  it("clamps stopBits to 1–2", () => {
    updateSerialSettings({ stopBits: 0 });
    expect(connectionState.serial.stopBits).toBe(1);
    updateSerialSettings({ stopBits: 3 });
    expect(connectionState.serial.stopBits).toBe(2);
  });

  it("updates parity", () => {
    updateSerialSettings({ parity: "odd" });
    expect(connectionState.serial.parity).toBe("odd");
  });

  it("partial update preserves unchanged fields", () => {
    updateSerialSettings({ baudRate: 19200 });
    expect(connectionState.serial.dataBits).toBe(8);
    expect(connectionState.serial.parity).toBe("none");
  });
});

describe("setListenerClients", () => {
  beforeEach(resetState);

  const sessions: ListenerClientSession[] = [
    { id: "a", endpoint: "10.0.0.1:1234", connectedAtMs: 1000 },
    { id: "b", endpoint: "10.0.0.2:5678", connectedAtMs: 2000 },
  ];

  it("sets sessions array", () => {
    setListenerClients(sessions);
    expect(connectionState.sessions).toHaveLength(2);
    expect(connectionState.sessions[0].endpoint).toBe("10.0.0.1:1234");
  });

  it("updates activeClients count", () => {
    setListenerClients(sessions);
    expect(connectionState.runtime.activeClients).toBe(2);
  });

  it("clears sessions and resets count when passed empty array", () => {
    setListenerClients(sessions);
    setListenerClients([]);
    expect(connectionState.sessions).toHaveLength(0);
    expect(connectionState.runtime.activeClients).toBe(0);
  });
});

describe("setListenerUptime", () => {
  beforeEach(resetState);

  it("sets uptimeMs", () => {
    setListenerUptime(5000);
    expect(connectionState.runtime.uptimeMs).toBe(5000);
  });

  it("rounds to nearest integer", () => {
    setListenerUptime(1500.7);
    expect(connectionState.runtime.uptimeMs).toBe(1501);
  });

  it("clamps negative values to 0", () => {
    setListenerUptime(-100);
    expect(connectionState.runtime.uptimeMs).toBe(0);
  });
});
