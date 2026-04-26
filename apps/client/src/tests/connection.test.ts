import { describe, it, expect, beforeEach } from "vitest";
import {
  connectionState,
  applyBackendConnectionStatus,
  setSlaveId,
  setProtocol,
  updateTcpSettings,
  updateSerialSettings,
} from "../state/connection.svelte";
import type { TcpSettings } from "../state/connection.svelte";

const DEFAULT_TCP: TcpSettings = {
  host: "192.168.55.200",
  port: 502,
  connectionTimeoutMs: 2000,
  responseTimeoutMs: 2000,
  retryAttempts: 2,
  retryBackoffStrategy: "fixed",
  retryJitterStrategy: "none",
};

function resetState() {
  connectionState.status = "disconnected";
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
}

describe("applyBackendConnectionStatus", () => {
  beforeEach(resetState);

  it("sets status to connecting", () => {
    applyBackendConnectionStatus("connecting");
    expect(connectionState.status).toBe("connecting");
  });

  it("sets status to reconnecting", () => {
    applyBackendConnectionStatus("reconnecting");
    expect(connectionState.status).toBe("reconnecting");
  });

  it("sets status to connected on 'connected' prefix", () => {
    applyBackendConnectionStatus("connected:tcp:192.168.1.1:502");
    expect(connectionState.status).toBe("connected");
  });

  it("sets status to connected on exact 'connected'", () => {
    applyBackendConnectionStatus("connected");
    expect(connectionState.status).toBe("connected");
  });

  it("sets status to disconnected on unknown status", () => {
    applyBackendConnectionStatus("error");
    expect(connectionState.status).toBe("disconnected");
  });

  it("sets status to disconnected on empty string", () => {
    applyBackendConnectionStatus("");
    expect(connectionState.status).toBe("disconnected");
  });

  it("stores backendDetails when provided", () => {
    applyBackendConnectionStatus("connecting", "attempting tcp...");
    expect(connectionState.backendDetails).toBe("attempting tcp...");
  });

  it("stores empty string when details omitted", () => {
    applyBackendConnectionStatus("connected");
    expect(connectionState.backendDetails).toBe("");
  });

  it("stores the raw backend status string", () => {
    applyBackendConnectionStatus("connected:tcp:10.0.0.1:502");
    expect(connectionState.backendStatus).toBe("connected:tcp:10.0.0.1:502");
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

  it("clamps negative to 1", () => {
    setSlaveId(-5);
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

  it("switches to serial-ascii", () => {
    setProtocol("serial-ascii");
    expect(connectionState.protocol).toBe("serial-ascii");
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
    updateTcpSettings({ host: "10.0.0.1" });
    expect(connectionState.tcp.host).toBe("10.0.0.1");
  });

  it("clamps port 0 to 1", () => {
    updateTcpSettings({ port: 0 });
    expect(connectionState.tcp.port).toBe(1);
  });

  it("clamps port above 65535 to 65535", () => {
    updateTcpSettings({ port: 99999 });
    expect(connectionState.tcp.port).toBe(65535);
  });

  it("clamps retryAttempts below 0 to 0", () => {
    updateTcpSettings({ retryAttempts: -1 });
    expect(connectionState.tcp.retryAttempts).toBe(0);
  });

  it("clamps retryAttempts above 10 to 10", () => {
    updateTcpSettings({ retryAttempts: 50 });
    expect(connectionState.tcp.retryAttempts).toBe(10);
  });

  it("rounds non-integer port to nearest integer", () => {
    updateTcpSettings({ port: 502.7 });
    expect(connectionState.tcp.port).toBe(503);
  });

  it("preserves unchanged fields on partial update", () => {
    updateTcpSettings({ host: "localhost" });
    expect(connectionState.tcp.port).toBe(502);
    expect(connectionState.tcp.retryAttempts).toBe(2);
  });

  it("clamps connectionTimeoutMs to 100–600000", () => {
    updateTcpSettings({ connectionTimeoutMs: 50 });
    expect(connectionState.tcp.connectionTimeoutMs).toBe(100);
    updateTcpSettings({ connectionTimeoutMs: 700000 });
    expect(connectionState.tcp.connectionTimeoutMs).toBe(600000);
  });
});

describe("updateSerialSettings", () => {
  beforeEach(resetState);

  it("updates baud rate", () => {
    updateSerialSettings({ baudRate: 115200 });
    expect(connectionState.serial.baudRate).toBe(115200);
  });

  it("updates parity", () => {
    updateSerialSettings({ parity: "even" });
    expect(connectionState.serial.parity).toBe("even");
  });

  it("preserves other serial fields", () => {
    updateSerialSettings({ baudRate: 19200 });
    expect(connectionState.serial.dataBits).toBe(8);
    expect(connectionState.serial.parity).toBe("none");
  });
});
