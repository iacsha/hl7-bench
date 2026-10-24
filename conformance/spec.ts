/**
 * conformance/spec.ts -- one spec that uses every piece of the vocabulary an
 * engine has to honour, and the messages that exercise it.
 *
 *   HL7_BENCH_TRANSFORM=conformance/spec.ts bun bridgelink-check.ts
 *
 * SYNTHETIC-DEMO-SPEC. Every name, number and code here is invented.
 *
 * WHY IT EXISTS
 *
 * A site spec proves the features that site happens to use. The day a second
 * site needs `fold`, nobody has ever run `fold` in that engine, and the first
 * receiver to see it is the test. This spec is the opposite: it is written to
 * the vocabulary, not to an interface, so a backend that cannot run all of it
 * finds out here.
 *
 * The cases live in this file rather than in `messages\`, because messages\ is
 * the active SITE spec's golden folder and the pre-push hook refuses a new .hl7
 * on purpose. They are built field by field (`seg()` below) so a field number
 * in a comment and a field number on the wire cannot drift apart.
 *
 * `bundle` lives in conformance/bundle.ts: it refuses wholeSegment, and this
 * spec seeds its IN1 repeat.
 */

import {
  copy, literal, firstOf, lookup, counter, event, pickRepeat, fromFirst, fromWhere, sameAs,
  blank, passthrough, constant,
  date8, truncate, upper, stripDelims, stripChars, defaultTo, prefix,
  highest, continuation,
  type Spec,
} from "../spec";

export const spec: Spec = {
  name: "Engine Conformance",
  description: "Synthetic: every source, step, repeat stage and block option, for proving a backend.",

  gate: {
    path: "MSH-9.2",
    permit: { A01: "A01", A08: "A08" },
    require: [{ path: "MSH-11", equals: "T" }],
  },

  bridgelink: { channelName: "hl7-bench conformance", log: "warn" },

  iris: {
    className: "Bench.Conformance",
    sourceDocType: "2.5:ADT_A01",
    targetDocType: "2.5:ADT_A01",
    create: "new",
  },

  tables: {
    Sex: { M: "MALE", F: "FEMALE" },
    Race: { W: "WHITE" },
    Relation: { FTH: "FATHER", SPO: "SPOUSE" },
  },

  blocks: [
    {
      // Seeded, then overridden: the passthrough shape, plus a composite field
      // built whole by prefix.
      id: "MSH",
      wholeSegment: true,
      rows: [
        { target: "MSH-3", from: literal("BENCH") },
        { target: "MSH-9", from: event(), via: [prefix("ADT^")] },
      ],
    },
    {
      id: "EVN",
      rows: [
        { target: "EVN-1", from: event() },
        { target: "EVN-2", from: copy("EVN-2"), via: [date8()] },
      ],
    },
    {
      id: "PID",
      rows: [
        { target: "PID-1", from: literal("1") },
        { target: "PID-2", from: pickRepeat("PID-3", 5, "AN", 1) },
        { target: "PID-3", from: firstOf("PID-4.1", "PID-3.1"), required: true },
        { target: "PID-5.1", from: copy("PID-5.1"), via: [upper()], required: true },
        { target: "PID-5.2", from: copy("PID-5.2"), via: [upper()] },
        { target: "PID-6", from: copy("PID-6"), via: [stripChars("- ")] },
        { target: "PID-7", from: copy("PID-7"), via: [date8()] },
        { target: "PID-8", from: lookup("Sex", "PID-8", passthrough()) },
        { target: "PID-10", from: lookup("Race", "PID-10", constant("UNK")) },
        { target: "PID-11.1", from: copy("PID-11.1"), via: [truncate(6)] },
        { target: "PID-11.3", from: copy("PID-11.3"), via: [upper()] },
        { target: "PID-13", from: copy("PID-13"), via: [defaultTo("NONE")] },
        { target: "PID-16", from: lookup("Sex", "PID-16", blank()) },
        { target: "PID-19", from: literal("12^3|4"), via: [stripDelims()] },
      ],
    },
    {
      id: "PV1",
      rows: [
        { target: "PV1-1", from: literal("1") },
        { target: "PV1-2", from: copy("PV1-2") },
        { target: "PV1-7", from: pickRepeat("PV1-7", 7, "NPI", [1, 2, 3]) },
        { target: "PV1-19", from: copy("PV1-19"), required: true },
        { target: "PV1-44", from: copy("PV1-44"), via: [date8()] },
      ],
    },
    {
      // A guarded seed: absent in the source, absent in the output.
      id: "PV2",
      wholeSegment: true,
      rows: [{ target: "PV2-3.2", from: copy("PV2-3.2"), via: [upper()] }],
    },
    {
      id: "NK1",
      repeat: { over: "NK1", skipWhenEmpty: "NK1-2", skipValues: ["UNKNOWN"], max: 3 },
      rows: [
        { target: "NK1-1", from: counter() },
        { target: "NK1-2", from: copy("NK1-2") },
        { target: "NK1-3", from: copy("NK1-3") },
      ],
    },
    {
      // Reads that walk the whole message, and one that reads the target back.
      id: "ZRL",
      rows: [
        { target: "ZRL-1", from: fromWhere("NK1", "NK1-1", "4", "NK1-2.1") },
        { target: "ZRL-2", from: fromFirst("NK1", "NK1-2", "NK1-3") },
        { target: "ZRL-3", from: sameAs("PID-5") },
        // A lookup whose key has to be found before it can be translated.
        { target: "ZRL-4", from: lookup("Relation", fromWhere("NK1", "NK1-1", "4", "NK1-3"), constant("OTHER")) },
        // A composite written whole, then one of its components written on top.
        // Counted from the split value on the bench; the engine has to agree.
        { target: "ZRL-5", from: sameAs("PID-5") },
        { target: "ZRL-5.4", from: literal("JR") },
      ],
    },
    {
      // A seeded repeat: each occurrence seeds from its own source occurrence.
      id: "IN1",
      wholeSegment: true,
      repeat: { over: "IN1" },
      rows: [{ target: "IN1-1", from: counter() }],
    },
    {
      // Newest revision only, hard-wrapped lines joined back into paragraphs.
      id: "OBX",
      repeat: { over: "OBX", select: highest("OBX-17"), fold: continuation("OBX-5") },
      rows: [
        { target: "OBX-1", from: counter() },
        { target: "OBX-2", from: copy("OBX-2") },
        { target: "OBX-3", from: copy("OBX-3") },
        { target: "OBX-5", from: copy("OBX-5") },
        { target: "OBX-11", from: copy("OBX-11") },
      ],
    },
    {
      // One more OBX after the repeat, numbered on from it.
      id: "OBX",
      continuesNumbering: true,
      rows: [
        { target: "OBX-1", from: counter() },
        { target: "OBX-2", from: literal("CE") },
        { target: "OBX-3", from: literal("CPT") },
        { target: "OBX-5", from: literal("71045") },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/** A segment from field number to value. Field numbers as the spec writes them. */
function seg(id: string, fields: Record<number, string>, sep = "|"): string {
  const top = Math.max(0, ...Object.keys(fields).map(Number));
  const parts = [id];
  for (let i = 1; i <= top; i++) parts.push(fields[i] ?? "");
  return parts.join(sep);
}

/** MSH is numbered one off: MSH-1 is the separator itself. */
function msh(fields: Record<number, string>, sep = "|", enc = "^~\\&"): string {
  const shifted: Record<number, string> = {};
  for (const [k, v] of Object.entries(fields)) shifted[Number(k) - 1] = v;
  shifted[1] = enc;
  return seg("MSH", shifted, sep);
}

const join = (...segs: string[]) => segs.join("\r") + "\r";

const header = (event: string, pid = "T") =>
  msh({ 3: "SRC", 4: "FAC", 5: "RCV", 6: "RFAC", 7: "20261024101500", 9: `ADT^${event}`, 10: "C001", 11: pid, 12: "2.5" });

export const cases = [
  {
    name: "conf-full",
    input: join(
      header("A01"),
      seg("EVN", { 1: "A01", 2: "20261024101500" }),
      seg("PID", {
        1: "1",
        3: "MRN1^^^MR^MR~ALT9^^^AN^AN",
        5: "o'brien^mary^k",
        6: "SMITH-JONES",
        7: "19750301120000",
        8: "F",
        10: "W",
        11: "1234567 main st^^rochester^NY^14624",
        16: "X",
      }),
      seg("PV1", {
        1: "1",
        2: "O",
        7: "1234^WHO^DOC^^^^MT~5550001^SMITH^ANNE^^^^NPI",
        19: "V555",
        44: "20261024083000",
      }),
      seg("PV2", { 3: "^chest pain", 8: "20261025" }),
      seg("NK1", { 1: "1", 3: "SPO" }),
      seg("NK1", { 1: "2", 2: "ROE^JANE", 3: "SPO" }),
      seg("NK1", { 1: "3", 2: "UNKNOWN", 3: "BRO" }),
      seg("NK1", { 1: "4", 2: "POE^EDGAR", 3: "FTH" }),
      seg("NK1", { 1: "5", 2: "DOE^JIM", 3: "SON" }),
      seg("NK1", { 1: "6", 2: "LAST^ONE", 3: "DAU" }),
      seg("IN1", { 1: "9", 2: "PLANA", 36: "POL1" }),
      seg("IN1", { 1: "9", 2: "PLANB", 36: "POL2" }),
      seg("OBX", { 1: "1", 2: "TX", 3: "RPT", 5: "first draft", 11: "P", 17: "1" }),
      seg("OBX", { 1: "2", 2: "TX", 3: "RPT", 5: "Findings are", 11: "F", 17: "2" }),
      seg("OBX", { 1: "3", 2: "TX", 3: "RPT", 5: " unremarkable.", 11: "F", 17: "2" }),
      seg("OBX", { 1: "4", 2: "TX", 3: "RPT", 5: "Impression: normal.", 11: "F", 17: "2" }),
    ),
  },
  {
    // Everything optional is missing: no PV2, NK1 or OBX, one repetition of
    // PID-3, a name with no components (the E4X component trap), and an
    // unmapped sex code that passes through.
    name: "conf-sparse",
    input: join(
      header("A08"),
      seg("EVN", { 1: "A08" }),
      seg("PID", { 1: "1", 3: "MRN2^^^MR^MR", 5: "SINGLE", 8: "U" }),
      seg("PV1", { 1: "1", 2: "I", 19: "V777" }),
      seg("IN1", { 1: "1", 2: "SELF" }),
    ),
  },
  {
    // A sender declaring "#" as its component separator. Rare, legal, and the
    // reason the step reads its delimiters off MSH instead of assuming "^".
    name: "conf-delims",
    input: join(
      msh({ 3: "SRC", 4: "FAC", 7: "20261024", 9: "ADT#A01", 10: "C9", 11: "T", 12: "2.5" }, "|", "#~\\&"),
      seg("EVN", { 1: "A01" }),
      seg("PID", { 1: "1", 3: "MRN3###MR#MR", 5: "lee#ann", 8: "M" }),
      seg("PV1", { 1: "1", 2: "E", 19: "V3" }),
    ),
  },
  { name: "conf-reject-event", reject: true, input: join(header("A03"), seg("PID", { 1: "1" })) },
  { name: "conf-reject-require", reject: true, input: join(header("A01", "P"), seg("PID", { 1: "1" })) },
];
