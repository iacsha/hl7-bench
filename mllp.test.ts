/**
 * mllp.test.ts -- the framing, and one loopback round trip. The claim that a
 * channel's own listener and sender work is bridgelink-check.ts --mllp's,
 * made against an engine: all 18 conformance cases agreed over the wire on
 * BridgeLink 26.9.0 (2026-10-24).
 */

import { expect, test, describe } from "bun:test";
import { frame, unframe, ack, send, receiver } from "./mllp";

describe("MLLP", () => {
  test("a frame is VT, the message, FS CR", () => {
    expect(frame("MSH|x")).toBe("\x0bMSH|x\x1c\x0d");
  });

  test("unframe takes every complete frame and keeps the partial one", () => {
    const { messages, rest } = unframe(frame("A") + frame("B") + "\x0bpart");
    expect(messages).toEqual(["A", "B"]);
    expect(rest).toBe("\x0bpart");
  });

  test("the ACK carries the received control id", () => {
    expect(ack("MSH|^~\\&|S|F|R|RF|20261024||ADT^A01|CTL9|P|2.5\rPID|1")).toContain("MSA|AA|CTL9");
  });

  test("a send gets the receiver's ACK, and the receiver gets the message", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const rx = receiver(port);
    try {
      const msg = "MSH|^~\\&|S|F|R|RF|20261024||ADT^A01|LOOP1|P|2.5\rPID|1\r";
      const reply = await send("127.0.0.1", port, msg, 3000);
      expect(reply).toContain("MSA|AA|LOOP1");
      expect(await rx.next(1000)).toBe(msg);
      expect(await rx.next(100)).toBeNull();
    } finally {
      rx.close();
    }
  });
});
