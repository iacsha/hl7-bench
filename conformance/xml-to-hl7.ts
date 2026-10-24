/**
 * conformance/xml-to-hl7.ts -- an XML order delivered as HL7 v2.
 *
 *   HL7_BENCH_TRANSFORM=conformance/xml-to-hl7.ts bun bridgelink-check.ts
 *
 * SYNTHETIC-DEMO-SPEC. Every name, number and code here is invented.
 *
 * The HL7 side is built from the HL7 defaults, |^~\&, since an XML message has
 * no MSH to read delimiters from. A value carrying a delimiter splits the field
 * it lands in unless a step strips it, which is what stripDelims is for here.
 */

import {
  copy, literal, lookup, counter, event, fromWhere,
  constant, upper, stripDelims, prefix, date8,
  type Spec,
} from "../spec";

const C = "/Order/Contacts/Contact";

export const spec: Spec = {
  name: "XML to HL7 Conformance",
  description: "Synthetic: an XML order delivered as an ADT.",
  gate: { path: "/Order/Header/Type", permit: { NEW: "A04", UPD: "A08" } },
  bridgelink: { channelName: "hl7-bench xml to hl7", log: "warn" },
  iris: { sourceDocType: "2.5:ADT_A01", targetDocType: "2.5:ADT_A01" },
  tables: { Relation: { spouse: "SPO", father: "FTH" } },
  blocks: [
    {
      id: "MSH",
      rows: [
        { target: "MSH-3", from: literal("BENCH") },
        { target: "MSH-7", from: copy("/Order/Header/Sent") },
        { target: "MSH-9", from: event(), via: [prefix("ADT^")] },
        { target: "MSH-10", from: copy("/Order/@id") },
        { target: "MSH-11", from: literal("T") },
        { target: "MSH-12", from: literal("2.5") },
      ],
    },
    { id: "EVN", rows: [{ target: "EVN-1", from: event() }, { target: "EVN-2", from: copy("/Order/Header/Sent"), via: [date8()] }] },
    {
      id: "PID",
      rows: [
        { target: "PID-1", from: literal("1") },
        { target: "PID-3.1", from: copy("/Order/Patient/@mrn"), required: true },
        { target: "PID-5.1", from: copy("/Order/Patient/Name/Family"), via: [upper(), stripDelims()] },
        { target: "PID-5.2", from: copy("/Order/Patient/Name/Given"), via: [upper()] },
        { target: "PID-13", from: fromWhere(C, `${C}/@rel`, "spouse", `${C}/Phone`) },
      ],
    },
    {
      id: "NK1",
      repeat: { over: C, skipWhenEmpty: `${C}/Name` },
      rows: [
        { target: "NK1-1", from: counter() },
        { target: "NK1-2", from: copy(`${C}/Name`), via: [stripDelims()] },
        { target: "NK1-3", from: lookup("Relation", `${C}/@rel`, constant("OTH")) },
      ],
    },
  ],
};

export const cases = [
  {
    name: "x2h-full",
    input: `<Order id="ORD-1"><Header><Type>NEW</Type><Sent>20261024101500</Sent></Header>
  <Patient mrn="MRN5"><Name><Family>o'hara|x</Family><Given>kim</Given></Name></Patient>
  <Contacts>
    <Contact rel="spouse"><Name>Pat^Lee</Name><Phone>5550199</Phone></Contact>
    <Contact rel="cousin"><Name/></Contact>
    <Contact rel="father"><Name>Ed</Name></Contact>
    <Contact rel="aunt"><Name>Flo &amp; Co</Name></Contact>
  </Contacts></Order>`,
  },
  {
    name: "x2h-sparse",
    input: `<Order id="ORD-2"><Header><Type>UPD</Type></Header><Patient mrn="MRN6"><Name><Family>solo</Family></Name></Patient></Order>`,
  },
  { name: "x2h-reject", reject: true, input: `<Order><Header><Type>DEL</Type></Header></Order>` },
];
