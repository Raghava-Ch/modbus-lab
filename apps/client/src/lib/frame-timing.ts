/**
 * Estimates the round-trip time (ms) for a single Modbus frame based on the
 * current connection protocol and settings.
 *
 * Models:
 *  - TCP/IP  : small fixed LAN overhead + fraction of configured responseTimeoutMs
 *  - RTU     : byte transmission time from baud/framing + inter-frame silence + turnaround
 *  - ASCII   : same as RTU but each byte encodes as 2 hex chars → ~1.9× wire bytes
 *
 * @param responsePayloadBytes  Estimated payload bytes in the response PDU, excluding
 *                              Modbus ADU headers (addr, FC, byte-count) and trailer (CRC/LRC).
 *                              Typical values:
 *                                FC03/FC04 read-125-regs  → 250
 *                                FC01/FC02 read-2000-coils → 250
 *                                FC16/FC15 write response  →   4
 */
export function estimateFrameMs(
  responsePayloadBytes: number,
  protocol: string,
  baudRate: number,
  dataBits: number,
  parity: string,
  stopBits: number,
  responseTimeoutMs: number,
): number {
  if (protocol === "tcp") {
    // TCP/IP on a local LAN: network RTT ≈ 1–5 ms; device processing 2–15 ms.
    // Use 10 % of the configured response timeout as a "typical" turnaround,
    // floored at 5 ms so the estimate never goes absurdly low.
    return Math.max(5, Math.round(responseTimeoutMs * 0.1));
  }

  // ── Serial RTU / ASCII ──────────────────────────────────────────────────────
  // Character framing: 1 start bit + data bits + optional parity bit + stop bits
  const bitsPerChar = 1 + dataBits + (parity !== "none" ? 1 : 0) + stopBits;
  const charTimeMs = (bitsPerChar / baudRate) * 1000;

  // Modbus spec §2.5.1.1: inter-frame silence = 3.5 char times;
  // capped at 1.75 ms for baud rates above 19 200 (§2.5.1.1 note).
  const silenceMs = baudRate > 19200 ? 1.75 : 3.5 * charTimeMs;

  // RTU request ADU: addr(1) + FC(1) + start-addr(2) + quantity(2) + CRC(2) = 8 bytes
  const requestBytes = 8;

  // RTU response ADU: addr(1) + FC(1) + byte-count(1) + payload + CRC(2)
  const responseBytes = 3 + responsePayloadBytes + 2;

  let transmitMs = (requestBytes + responseBytes) * charTimeMs;

  // ASCII encoding doubles the wire bytes (2 hex chars per data byte) and adds
  // ':' start + CR/LF end + LRC, so multiply by ≈1.9 to get wire time.
  if (protocol === "serial-ascii") {
    transmitMs *= 1.9;
  }

  // Typical device turnaround: 2 ms (processing + RS-485 line-direction switch).
  const turnaroundMs = 2;

  return Math.max(1, Math.round(transmitMs + silenceMs * 2 + turnaroundMs));
}
