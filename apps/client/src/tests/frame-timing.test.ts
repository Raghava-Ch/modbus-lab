import { describe, it, expect } from "vitest";
import { estimateFrameMs } from "../lib/frame-timing";

describe("estimateFrameMs — TCP", () => {
  it("returns at least 5 ms", () => {
    expect(estimateFrameMs(50, "tcp", 9600, 8, "none", 1, 1000)).toBeGreaterThanOrEqual(5);
  });

  it("scales with responseTimeoutMs", () => {
    const slow = estimateFrameMs(50, "tcp", 9600, 8, "none", 1, 5000);
    const fast = estimateFrameMs(50, "tcp", 9600, 8, "none", 1, 100);
    expect(slow).toBeGreaterThan(fast);
  });

  it("ignores baud rate and payload size", () => {
    const r1 = estimateFrameMs(10, "tcp", 9600, 8, "none", 1, 2000);
    const r2 = estimateFrameMs(250, "tcp", 115200, 8, "even", 2, 2000);
    expect(r1).toBe(r2);
  });
});

describe("estimateFrameMs — serial RTU", () => {
  it("returns at least 1 ms", () => {
    expect(estimateFrameMs(50, "serial-rtu", 9600, 8, "none", 1, 1000)).toBeGreaterThanOrEqual(1);
  });

  it("higher baud rate gives lower frame time", () => {
    const slow = estimateFrameMs(50, "serial-rtu", 9600, 8, "none", 1, 2000);
    const fast = estimateFrameMs(50, "serial-rtu", 115200, 8, "none", 1, 2000);
    expect(fast).toBeLessThan(slow);
  });

  it("parity bit increases frame time", () => {
    const noParity = estimateFrameMs(50, "serial-rtu", 9600, 8, "none", 1, 2000);
    const withParity = estimateFrameMs(50, "serial-rtu", 9600, 8, "even", 1, 2000);
    expect(withParity).toBeGreaterThan(noParity);
  });

  it("caps inter-frame silence at baud rates above 19200", () => {
    const below = estimateFrameMs(50, "serial-rtu", 9600, 8, "none", 1, 2000);
    const above = estimateFrameMs(50, "serial-rtu", 38400, 8, "none", 1, 2000);
    expect(above).toBeLessThan(below);
  });

  it("larger payload increases frame time", () => {
    const small = estimateFrameMs(4, "serial-rtu", 9600, 8, "none", 1, 2000);
    const large = estimateFrameMs(250, "serial-rtu", 9600, 8, "none", 1, 2000);
    expect(large).toBeGreaterThan(small);
  });

  it("two stop bits adds more time than one", () => {
    const one = estimateFrameMs(50, "serial-rtu", 9600, 8, "none", 1, 2000);
    const two = estimateFrameMs(50, "serial-rtu", 9600, 8, "none", 2, 2000);
    expect(two).toBeGreaterThan(one);
  });
});

describe("estimateFrameMs — serial ASCII", () => {
  it("ASCII is slower than RTU at the same baud rate", () => {
    const rtu = estimateFrameMs(50, "serial-rtu", 9600, 8, "none", 1, 2000);
    const ascii = estimateFrameMs(50, "serial-ascii", 9600, 8, "none", 1, 2000);
    expect(ascii).toBeGreaterThan(rtu);
  });
});
