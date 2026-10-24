/**
 * conformance/hl7-to-xml.ts -- an HL7 ADT delivered as an XML document.
 *
 *   HL7_BENCH_TRANSFORM=conformance/hl7-to-xml.ts bun bridgelink-check.ts
 *
 * SYNTHETIC-DEMO-SPEC. Every name, number and code here is invented.
 *
 * HL7 paths on the read side, XML paths on the write side: the gate's syntax
 * says what the spec reads, the block ids say what it writes.
 */

import {
  copy, literal, lookup, counter, event, pickRepeat, fromWhere,
  passthrough, date8, upper, stripDelims, highest, continuation,
  type Spec,
} from "../spec";

export const spec: Spec = {
  name: "HL7 to XML Conformance",
  description: "Synthetic: an ADT reshaped into an XML registration document.",
  gate: { path: "MSH-9.2", permit: { A01: "ADMIT", A08: "UPDATE" } },
  bridgelink: { channelName: "hl7-bench hl7 to xml", log: "warn" },
  iris: { sourceDocType: "2.5:ADT_A01", targetDocType: "2.5:ADT_A01" },
  tables: { Sex: { M: "male", F: "female" } },
  blocks: [
    {
      id: "/Registration/Header",
      rows: [
        { target: "/Registration/Header/@event", from: event() },
        { target: "/Registration/Header/Control", from: copy("MSH-10") },
        { target: "/Registration/Header/Sent", from: copy("MSH-7"), via: [date8()] },
      ],
    },
    {
      id: "/Registration/Patient",
      rows: [
        { target: "/Registration/Patient/@mrn", from: copy("PID-3.1"), required: true },
        { target: "/Registration/Patient/Name/Family", from: copy("PID-5.1"), via: [upper()] },
        { target: "/Registration/Patient/Name/Given", from: copy("PID-5.2") },
        // The whole composite as one XML value, separators and all.
        { target: "/Registration/Patient/Address", from: copy("PID-11") },
        { target: "/Registration/Patient/Sex", from: lookup("Sex", "PID-8", passthrough()) },
        { target: "/Registration/Patient/Npi", from: pickRepeat("PV1-7", 7, "NPI", 1) },
        { target: "/Registration/Patient/Note", from: literal("a<b & c"), via: [stripDelims()] },
      ],
    },
    {
      id: "/Registration/Contacts/Contact",
      repeat: { over: "NK1", skipWhenEmpty: "NK1-2", max: 2 },
      rows: [
        { target: "/Registration/Contacts/Contact/@seq", from: counter() },
        { target: "/Registration/Contacts/Contact/Name", from: copy("NK1-2.1") },
        { target: "/Registration/Contacts/Contact/Relation", from: copy("NK1-3") },
      ],
    },
    {
      id: "/Registration/Spouse",
      rows: [{ target: "/Registration/Spouse", from: fromWhere("NK1", "NK1-3", "SPO", "NK1-2.2") }],
    },
    {
      id: "/Registration/Report/Line",
      repeat: { over: "OBX", select: highest("OBX-17"), fold: continuation("OBX-5") },
      rows: [
        { target: "/Registration/Report/Line/@n", from: counter() },
        { target: "/Registration/Report/Line", from: copy("OBX-5") },
      ],
    },
  ],
};

const seg = (id: string, fields: Record<number, string>) => {
  const top = Math.max(0, ...Object.keys(fields).map(Number));
  const parts = [id];
  for (let i = 1; i <= top; i++) parts.push(fields[i] ?? "");
  return parts.join("|");
};
const msh = (event: string) => `MSH|^~\\&|SRC|FAC|RCV|RFAC|20261024101500||ADT^${event}|C77|T|2.5`;
const join = (...s: string[]) => s.join("\r") + "\r";

export const cases = [
  {
    name: "h2x-full",
    input: join(
      msh("A01"),
      seg("PID", { 1: "1", 3: "MRN9^^^MR", 5: "o'neil^sean", 8: "M", 11: "1 Main St^^Rochester^NY^14624" }),
      seg("PV1", { 1: "1", 7: "1234^WHO^DOC^^^^MT~5550001^SMITH^ANNE^^^^NPI" }),
      seg("NK1", { 1: "1", 3: "BRO" }),
      seg("NK1", { 1: "2", 2: "ROE^JANE", 3: "SPO" }),
      seg("NK1", { 1: "3", 2: "POE^ED & CO", 3: "FTH" }),
      seg("NK1", { 1: "4", 2: "LAST^ONE", 3: "SON" }),
      seg("OBX", { 1: "1", 2: "TX", 5: "draft", 17: "1" }),
      seg("OBX", { 1: "2", 2: "TX", 5: "Lungs are", 17: "2" }),
      seg("OBX", { 1: "3", 2: "TX", 5: " clear <today>.", 17: "2" }),
    ),
  },
  { name: "h2x-sparse", input: join(msh("A08"), seg("PID", { 1: "1", 3: "MRN2", 5: "SOLO" })) },
  { name: "h2x-reject", reject: true, input: join(msh("A03"), seg("PID", { 1: "1" })) },
];
