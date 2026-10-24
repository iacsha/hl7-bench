/**
 * conformance/bundle.ts -- segments that travel together: IN1 with its IN2.
 *
 *   HL7_BENCH_TRANSFORM=conformance/bundle.ts bun bridgelink-check.ts
 *
 * SYNTHETIC-DEMO-SPEC. Every name, number and code here is invented.
 *
 * Kept apart from conformance/spec.ts because a bundle refuses wholeSegment,
 * and that spec seeds its IN1 repeat. Four coverages: with an IN2, without,
 * skipped, and with again, so a companion read or written against the wrong
 * occurrence shows up as a shifted line.
 */

import { copy, literal, counter, event, type Spec } from "../spec";

export const spec: Spec = {
  name: "Bundle Conformance",
  description: "Synthetic: IN1 with its IN2, one bundle per coverage.",
  gate: { path: "MSH-9.2", permit: { A01: "A01" } },
  bridgelink: { channelName: "hl7-bench bundle", log: "warn" },
  iris: { sourceDocType: "2.5:ADT_A01", targetDocType: "2.5:ADT_A01" },
  blocks: [
    { id: "MSH", rows: [{ target: "MSH-3", from: literal("BENCH") }, { target: "MSH-9.1", from: literal("ADT") }, { target: "MSH-9.2", from: event() }] },
    { id: "PID", rows: [{ target: "PID-3", from: copy("PID-3.1") }] },
    {
      id: "IN1",
      group: "IN1grp",
      bundle: ["IN2"],
      repeat: { over: "IN1", skipWhenEmpty: "IN1-2" },
      rows: [
        { target: "IN1-1", from: counter() },
        { target: "IN1-2", from: copy("IN1-2") },
        // A companion read inside the loop: THIS coverage's IN2, or empty.
        { target: "IN1-16", from: copy("IN2-2") },
        { target: "IN2-1", from: copy("IN2-1") },
        { target: "IN2-2", from: copy("IN2-2") },
        { target: "IN2-3", from: copy("IN1-2") },
      ],
    },
    { id: "PV1", rows: [{ target: "PV1-2", from: copy("PV1-2") }] },
  ],
};

const join = (...s: string[]) => s.join("\r") + "\r";

export const cases = [
  {
    name: "bundle-four",
    input: join(
      "MSH|^~\\&|SRC|FAC|RCV|RFAC|20261024||ADT^A01|B1|T|2.5",
      "PID|1||MRN1",
      "IN1|1|PLANA",
      "IN2|EMP1|SELF-A",
      "IN1|2|PLANB",
      "IN1|3|",
      "IN2|EMP3|SKIPPED",
      "IN1|4|PLAND",
      "IN2|EMP4|SELF-D",
      "PV1|1|I",
    ),
  },
  { name: "bundle-none", input: join("MSH|^~\\&|SRC|FAC|RCV|RFAC|20261024||ADT^A01|B2|T|2.5", "PID|1||MRN2", "PV1|1|O") },
];
