/**
 * emit/channel.test.ts -- what is true of the channel file whatever the engine
 * does with it. Whether the engine accepts it is bridgelink-check.ts's claim,
 * made against a server: the 4.5.0 file imported into 26.9.0, deployed and
 * transformed, and the MLLP pair deployed (2026-10-24).
 */

import { expect, test, describe } from "bun:test";
import { emitChannel, channelId, xml } from "./channel";
import { validate, literal, type Spec } from "../spec";

const base = (over: Partial<Spec> = {}): Spec => ({
  name: "Test Interface",
  gate: { path: "MSH-9.2", permit: { A01: "A28" } },
  bridgelink: { channelName: "Test Channel" },
  iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3.1:ADT_A05" },
  blocks: [{ id: "MSH", rows: [{ target: "MSH-3", from: literal("A<B & 'C'") }] }],
  ...over,
});

describe("the channel file", () => {
  test("the same name gives the same id, so a re-import updates one channel", () => {
    expect(channelId("ADT out")).toBe(channelId("ADT out"));
    expect(channelId("ADT out")).not.toBe(channelId("ADT in"));
    expect(channelId("ADT out")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test("the scripts are escaped, so a '<' in the step cannot end the element", () => {
    const out = emitChannel(base(), { id: "x" });
    expect(out).toContain("A&lt;B &amp; ");
    expect(out).not.toContain("A<B");
    expect(xml("<&>")).toBe("&lt;&amp;&gt;");
  });

  test("the filter and the step are both inside, and the data type is HL7 v2", () => {
    const out = emitChannel(base(), { id: "x" });
    expect(out).toContain("<name>hl7-bench gate</name>");
    expect(out).toContain("<name>hl7-bench transform</name>");
    expect(out).toContain("<inboundDataType>HL7V2</inboundDataType>");
  });

  test("no connector facts means Channel Reader in and Channel Writer to none", () => {
    const out = emitChannel(base(), { id: "x" });
    expect(out).toContain("<transportName>Channel Reader</transportName>");
    expect(out).toContain("<transportName>Channel Writer</transportName>");
  });

  test("a listener and a receiver mean MLLP both ways", () => {
    const out = emitChannel(base(), { id: "x", listenPort: 6661, sendTo: { host: "recv.example", port: 7001 } });
    expect(out).toContain("<transportName>TCP Listener</transportName>");
    expect(out).toContain("<port>6661</port>");
    expect(out).toContain("<remoteAddress>recv.example</remoteAddress>");
    expect(out).toContain("<remotePort>7001</remotePort>");
  });

  test("an upstream gate leaves the filter empty rather than rejecting everything", () => {
    const out = emitChannel(base({ gate: { path: "MSH-9.2", permit: { A01: "A28" }, enabled: false, upstream: "router" } }), { id: "x" });
    expect(out).not.toContain("hl7-bench gate");
  });

  test("a port the engine cannot bind is refused before the import", () => {
    const bad = base({ bridgelink: { channelName: "T", listenPort: 70000, sendTo: { host: "", port: 0 } } });
    const problems = validate(bad, "bridgelink").join("\n");
    expect(problems).toContain("listenPort 70000");
    expect(problems).toContain("sendTo.host is empty");
    expect(problems).toContain("sendTo.port 0");
  });
});
