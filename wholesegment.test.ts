// bun test
//
// `wholeSegment` is the one thing in this vocabulary that copies fields nobody
// wrote down, so the tests here are mostly about the ways that can be true in
// the bench and false in the engine. Five readers have to agree about it --
// run.ts, emit/iris.ts, emit/inline.ts, serialize.ts and trace.ts -- and the interesting
// failures are all silent ones: a segment delivered under the wrong id, a GUI
// save that drops the flag, a mapping document that claims a field list it does
// not have.

import { expect, test, describe } from "bun:test";

import { Message } from "./hl7";
import { runSpec } from "./run";
import { specToSource } from "./serialize";
import { emitIris, dtlSegment } from "./emit/iris";
import { emitProcess } from "./emit/process";
import { trace } from "./trace";
import { validate, copy, literal, type Spec } from "./spec";

const IN =
  "MSH|^~\\&|SENDING_APP|SENDING_FAC|RECEIVER|ATH|20260921120000||ADT^A01|MSG0001|P|2.3\r" +
  "EVN|A01|20260921120000\r" +
  "PID|1||MRN123^^^SENDING_APP||DOE^JANE^Q||19800102|F|||12 MAIN ST^^ROCHESTER^NY^14624|||||||SSN987|||\r" +
  "NK1|1|DOE^JOHN|SPO\r" +
  "NK1|2||CHD\r" +
  "PV1|1|I|3W^312^A||||1234^SMITH^ANN|||||||||||V0001\r";

const base = (blocks: Spec["blocks"]): Spec => ({
  name: "Seed Test",
  gate: { path: "MSH-9.2", permit: { A01: "A28" } },
  iris: {
    className: "Seed.Test.Dtl",
    sourceDocType: "2.3:ADT_A01",
    targetDocType: "2.3:ADT_A01",
  },
  blocks,
});

const msh = { id: "MSH", wholeSegment: true as const, rows: [] };

// ---------------------------------------------------------------------------

describe("the runner", () => {
  // The claim the whole feature rests on. If the fields nobody enumerated do
  // not come out the other side, nothing else here matters.
  test("carries fields no row names", () => {
    const spec = base([
      msh,
      { id: "PID", wholeSegment: true, rows: [{ target: "PID-9", from: literal("") }] },
    ]);
    const msg = new Message(IN);
    runSpec(spec, msg);

    // PID-11 is in no row. Under enumeration it would be gone.
    expect(msg.get("PID-11.1")).toBe("12 MAIN ST");
    expect(msg.get("PID-5.1")).toBe("DOE");
  });

  test("rows overwrite the seed rather than the other way round", () => {
    const spec = base([
      msh,
      {
        id: "PID",
        wholeSegment: true,
        rows: [
          { target: "PID-9", from: literal("") },
          { target: "PID-19", from: literal("") },
        ],
      },
    ]);
    const msg = new Message(IN);
    runSpec(spec, msg);
    expect(msg.get("PID-19")).toBe("");
    expect(msg.get("PID-3.1")).toBe("MRN123"); // untouched by a row, still there
  });

  // MSH numbers its fields one off from its own array, so a seed built by
  // reading fields back from outside the class gets MSH wrong. clone() is why
  // this passes; a rebuild through getField would shift every field by one.
  test("seeds MSH without shifting its fields", () => {
    const spec = base([{ ...msh, rows: [{ target: "MSH-5", from: literal("RECEIVER") }] }]);
    const msg = new Message(IN);
    runSpec(spec, msg);
    expect(msg.get("MSH-3")).toBe("SENDING_APP");
    expect(msg.get("MSH-5")).toBe("RECEIVER");
    expect(msg.get("MSH-9.1")).toBe("ADT");
    expect(msg.get("MSH-12")).toBe("2.3");
  });

  // Each delivered occurrence seeds from ITS OWN source occurrence. Seeding
  // every one from the first is the bug this asserts against, and it would look
  // like a message where every relative is the same person.
  test("a repeat seeds each occurrence from its own source", () => {
    const spec = base([
      msh,
      {
        id: "NK1",
        wholeSegment: true,
        repeat: { over: "NK1" },
        rows: [],
      },
    ]);
    const msg = new Message(IN);
    runSpec(spec, msg);
    const nk1 = msg.all("NK1");
    expect(nk1).toHaveLength(2);
    expect(nk1[0]!.get("NK1-3")).toBe("SPO");
    expect(nk1[1]!.get("NK1-3")).toBe("CHD");
  });

  test("skipWhenEmpty still applies to a seeded repeat", () => {
    const spec = base([
      msh,
      {
        id: "NK1",
        wholeSegment: true,
        repeat: { over: "NK1", skipWhenEmpty: "NK1-2" },
        rows: [],
      },
    ]);
    const msg = new Message(IN);
    runSpec(spec, msg);
    // The second NK1 carries no NK1-2, so it is not delivered.
    expect(msg.all("NK1")).toHaveLength(1);
    expect(msg.get("NK1-3")).toBe("SPO");
  });

  // A spec can seed a segment the message does not carry. It delivers NO
  // segment -- see the sparse-message block at the bottom of this file for
  // why, and for the measurements that changed this. The run still says so,
  // because losing a segment quietly is the thing being prevented.
  //
  // This test used to assert the opposite ("delivers empty") and passed,
  // against a bench that emitted a bare "PV2" and an engine that emitted a
  // segment with no id at all.
  test("a missing source segment delivers nothing, and is reported", () => {
    const spec = base([msh, { id: "PV2", wholeSegment: true, rows: [] }]);
    const msg = new Message(IN);
    const result = runSpec(spec, msg);
    expect(msg.all("PV2")).toHaveLength(0);
    expect(result.notes.some((n) => n.includes("PV2") && n.includes("no PV2"))).toBe(true);
  });

  test("a block without the flag is unchanged", () => {
    const spec = base([msh, { id: "PID", rows: [{ target: "PID-3", from: copy("PID-3") }] }]);
    const msg = new Message(IN);
    runSpec(spec, msg);
    expect(msg.get("PID-3.1")).toBe("MRN123");
    expect(msg.get("PID-11.1")).toBe(""); // enumeration drops what it does not name
  });
});

// ---------------------------------------------------------------------------

describe("validate", () => {
  // A cross-segment whole copy writes the SOURCE id into the first field, so
  // the receiver gets an NK1 labelled as a PID. Well formed, mislabelled, and
  // nothing in the engine objects.
  test("refuses a repeat whose over is a different segment", () => {
    const spec = base([
      msh,
      { id: "PID", wholeSegment: true, repeat: { over: "NK1" }, rows: [] },
    ]);
    expect(validate(spec).join("\n")).toContain("identity copy");
  });

  test("refuses a seed on a folding repeat", () => {
    const spec = base([
      msh,
      {
        id: "OBX",
        wholeSegment: true,
        repeat: { over: "OBX", fold: { kind: "continuation", path: "OBX-5", join: "" } },
        rows: [{ target: "OBX-5", from: copy("OBX-5") }],
      },
    ]);
    expect(validate(spec).join("\n")).toContain("repeat.fold");
  });

  // MSH-2 defines the delimiters the rest of the message is already encoded
  // with. Re-assigning it after the copy renames the separators without
  // re-encoding anything, which parses back wrong.
  test("refuses a row assigning MSH-2 on a seeded MSH", () => {
    const spec = base([{ ...msh, rows: [{ target: "MSH-2", from: literal("^~\\&") }] }]);
    expect(validate(spec).join("\n")).toContain("MSH-2");
  });

  // The continuation block has no source occurrence of its own, so the seed
  // reads the first one again. The delivered message then carries two copies of
  // the same segment under different set ids, which reads as real data.
  test("refuses a seed on a continuesNumbering block", () => {
    const spec = base([
      msh,
      { id: "NK1", repeat: { over: "NK1" }, rows: [] },
      { id: "NK1", wholeSegment: true, continuesNumbering: true, rows: [] },
    ]);
    expect(validate(spec).join("\n")).toContain("continuesNumbering");
  });

  test("permits the ordinary same-id seed", () => {
    const spec = base([msh, { id: "PID", wholeSegment: true, rows: [] }]);
    expect(validate(spec)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("dtlSegment", () => {
  test("top level", () => {
    expect(dtlSegment("PID")).toBe("{PID}");
  });

  test("a group from sourceGroups", () => {
    expect(dtlSegment("IN1", "", { IN1: "IN1grp" })).toBe("{IN1grp.IN1}");
  });

  // {NK1(k1).NK1} resolves to nothing and reports nothing. The id is already in
  // the prefix, so it must not be repeated.
  test("a bare segment prefix is not doubled", () => {
    expect(dtlSegment("NK1", "NK1(k1)")).toBe("{NK1(k1)}");
  });

  test("a group prefix nests", () => {
    expect(dtlSegment("IN1", "IN1grp(n1)")).toBe("{IN1grp(n1).IN1}");
  });
});

// ---------------------------------------------------------------------------

describe("the DTL", () => {
  test("emits a segment-to-segment assign above the rows", () => {
    const spec = base([
      msh,
      { id: "PID", wholeSegment: true, rows: [{ target: "PID-9", from: literal("") }] },
    ]);
    const dtl = emitIris(spec);
    expect(dtl).toContain(`<assign value='source.{PID}' property='target.{PID}' action='set' />`);

    // Order is load-bearing: a seed after its rows erases them.
    const seed = dtl.indexOf(`property='target.{PID}' action='set'`);
    const row = dtl.indexOf(`property='target.{PID:9}'`);
    expect(seed).toBeGreaterThan(-1);
    expect(row).toBeGreaterThan(seed);
  });

  test("a seeded repeat assigns by output ordinal, not source index", () => {
    const spec = base([
      msh,
      { id: "NK1", wholeSegment: true, repeat: { over: "NK1", skipWhenEmpty: "NK1-2" }, rows: [] },
    ]);
    const dtl = emitIris(spec);
    expect(dtl).toContain(`value='source.{NK1(k1)}'`);
    expect(dtl).toContain(`property='target.{NK1(n1)}'`);
  });

  test("a seeded grouped block addresses the group", () => {
    const spec = base([
      msh,
      { id: "IN1", group: "IN1grp", wholeSegment: true, rows: [] },
    ]);
    const dtl = emitIris(spec);
    expect(dtl).toContain(`property='target.{IN1grp(1).IN1}'`);
  });

  test("a block without the flag emits no seed", () => {
    const spec = base([msh, { id: "PID", rows: [{ target: "PID-3", from: copy("PID-3") }] }]);
    expect(emitIris(spec)).not.toContain(`property='target.{PID}' action='set'`);
  });
});

// ---------------------------------------------------------------------------

describe("the round trip", () => {
  // The GUI rewrites the whole spec literal on every save. A flag serialize.ts
  // does not know about survives exactly until the first time somebody opens
  // the form, and then the class quietly stops copying the segment.
  test("a GUI save keeps the flag", () => {
    const spec = base([msh, { id: "PID", wholeSegment: true, rows: [] }]);
    const text = specToSource(spec);
    expect(text).toContain("wholeSegment: true,");
  });

  test("a block without the flag does not gain one", () => {
    const spec = base([msh, { id: "PID", rows: [{ target: "PID-3", from: copy("PID-3") }] }]);
    const blocks = specToSource(spec).split("id: ");
    expect(blocks[blocks.length - 1]).not.toContain("wholeSegment");
  });
});

// ---------------------------------------------------------------------------

describe("the mapping document", () => {
  // trace.ts is what the receiving team reads. A seeded segment whose table
  // lists three overridden fields and says nothing about the forty it copied is
  // a document that looks complete and is not.
  test("declares the copy rather than implying a field list", () => {
    const spec = base([
      msh,
      { id: "PID", wholeSegment: true, rows: [{ target: "PID-9", from: literal("") }] },
    ]);
    const out = trace(spec, new Message(IN));
    expect(out).toContain("(whole segment)");
    expect(out).toContain("PID copied whole");
    expect(out).toContain("field(s) passed through");
  });

  test("says so when the source carries no such segment", () => {
    const spec = base([msh, { id: "PV2", wholeSegment: true, rows: [] }]);
    expect(trace(spec, new Message(IN))).toContain("(no source segment)");
  });
});

// ---------------------------------------------------------------------------
// A seed that finds nothing delivers NO segment.
//
// This was wrong in all three backends and wrong DIFFERENTLY, which is the
// part that matters. Measured on a message with NK1, PV2, GT1 and IN1 stripped:
//
//   bench   delivered 5 segments, the fifth printing as a bare "PV2"
//   IRIS    delivered 5 segments, the fifth with no id at all -- SetValueAt("",
//           "PV2") creates a segment, and it goes down the wire as a blank line
//
// Neither is right, and a golden gate comparing two wrong answers that happen
// to have the same segment COUNT would have called it agreement. The sender
// did not send it, so neither do we, and the rows go with it: they exist to
// overwrite fields on top of a copy and there is no copy.
//
// Repeats are deliberately not part of this. A repeat over an absent segment
// iterates zero times and already delivers nothing.
// ---------------------------------------------------------------------------

describe("a wholeSegment block whose source segment is absent", () => {
  // The sparse case: no PV2 anywhere in IN, and no NK1 either once stripped.
  const SPARSE =
    "MSH|^~\\&|SENDING_APP|SENDING_FAC|RECEIVER|ATH|20260921120000||ADT^A01|MSG0001|P|2.3\r" +
    "EVN|A01|20260921120000\r" +
    "PID|1||MRN123^^^SENDING_APP||DOE^JANE^Q||19800102|F\r";

  const spec = base([
    msh,
    { id: "EVN", wholeSegment: true, rows: [] },
    { id: "PID", wholeSegment: true, rows: [{ target: "PID-19", from: literal("") }] },
    // Optional in the source and absent from SPARSE. This is the one under test.
    { id: "PV2", wholeSegment: true, rows: [{ target: "PV2-3", from: literal("X") }] },
  ]);

  const runOn = (raw: string) => {
    const m = new Message(raw);
    const r = runSpec(spec, m);
    return { out: m, ...r };
  };

  test("the runner delivers three segments, not four", () => {
    const { out } = runOn(SPARSE);
    expect(out.all("PV2")).toHaveLength(0);
    expect(out.all("MSH")).toHaveLength(1);
    expect(out.all("EVN")).toHaveLength(1);
    expect(out.all("PID")).toHaveLength(1);
  });

  // Losing a segment silently is the failure the guard exists to stop being
  // silent. The message is well formed with or without it.
  test("the runner says so rather than dropping it quietly", () => {
    expect(runOn(SPARSE).notes.join(" "))
      .toContain("PV2: source carries no PV2, segment not delivered");
  });

  // The rows go with the segment. A literal() row would otherwise build a PV2
  // out of nothing, which is a segment the sender never sent carrying a value
  // the receiver has no reason to trust.
  test("the block's rows do not build a segment out of nothing", () => {
    const raw = runOn(SPARSE).out.toString();
    expect(raw).not.toContain("PV2");
    expect(raw).not.toContain("|X|");
  });

  test("a blank line is not delivered in its place", () => {
    // The IRIS failure mode, asserted on the bench so the two cannot diverge
    // again: a segment with no id prints as an empty line. The last element is
    // dropped because the message ends WITH a separator rather than between
    // two segments, so it is the terminator and not a segment.
    const lines = runOn(SPARSE).out.toString().split(/\r\n?/);
    if (lines[lines.length - 1] === "") lines.pop();
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line.trim()).not.toBe("");
  });

  test("the same block still delivers when the source carries the segment", () => {
    const withPv2 = SPARSE + "PV2|||ADMIT REASON\r";
    const { out } = runOn(withPv2);
    expect(out.all("PV2")).toHaveLength(1);
    expect(out.get("PV2-3")).toBe("X");
  });

  // ---- the two emitters, held to the same decision ----

  test("the DTL guards the seed and its rows on the source being present", () => {
    const dtl = emitIris(spec);
    expect(dtl).toContain(`<if condition='$LENGTH(source.{PV2})&gt;0' >`);
    // The row is INSIDE the guard, not beside it.
    const open = dtl.indexOf(`$LENGTH(source.{PV2})`);
    const row = dtl.indexOf(`property='target.{PV2:3}'`);
    const close = dtl.indexOf("</if>", open);
    expect(row).toBeGreaterThan(open);
    expect(row).toBeLessThan(close);
  });

  test("the DTL says which segment it did not deliver", () => {
    expect(emitIris(spec)).toContain("PV2: source carries no PV2, segment not delivered");
  });

  test("a repeat gets no guard, because its loop already delivers nothing", () => {
    const repeating = base([
      msh,
      { id: "NK1", wholeSegment: true, repeat: { over: "NK1" }, rows: [] },
    ]);
    expect(emitIris(repeating)).not.toContain(`$LENGTH(source.{NK1})&gt;0`);
  });

  // The third backend. This is the one whose behaviour was MEASURED wrong in
  // IRIS -- SetValueAt("", "PV2") creating a segment with no id -- so it is
  // the one the guard was written for.
  const inlineBody = (s: Spec): string => {
    const withProcess: Spec = {
      ...s,
      iris: {
        ...s.iris,
        process: {
          className: "Seed.Test.Process",
          sendTo: "ToTarget.ADT.TCP",
          transform: "inline",
        },
      },
    };
    const cls = emitProcess(withProcess);
    return cls.slice(cls.indexOf("Method OnRequest"));
  };

  test("the inline process guards the seed write on the source being present", () => {
    const b = inlineBody(spec);
    expect(b).toContain(`set tSeed = ..ValueAt(tSource,"PV2")`);
    expect(b).toContain("if $LENGTH(tSeed) {");
    // The write is inside the guard, so the empty seed is never written and
    // the id-less segment is never created.
    const guard = b.indexOf(`set tSeed = ..ValueAt(tSource,"PV2")`);
    const write = b.indexOf(`tTarget.SetValueAt(tSeed, "PV2")`);
    expect(write).toBeGreaterThan(guard);
    expect(b.slice(guard, write)).toContain("if $LENGTH(tSeed) {");
  });

  test("the inline process puts the block's rows inside the guard too", () => {
    const b = inlineBody(spec);
    const guard = b.indexOf(`set tSeed = ..ValueAt(tSource,"PV2")`);
    const row = b.indexOf(`tTarget.SetValueAt("X", "PV2:3")`);
    expect(row).toBeGreaterThan(guard);
    // Same nesting depth as the seed write, which is one level in from the if.
    expect(b.split("\n").find((l) => l.includes(`"X", "PV2:3"`))).toMatch(/^ {8}\S/);
  });

  test("the inline process says which segment it did not deliver", () => {
    expect(inlineBody(spec)).toContain("PV2: source carries no PV2, segment not delivered");
  });

  test("all three backends name the same thing the same way", () => {
    const said = "PV2: source carries no PV2, segment not delivered";
    expect(runOn(SPARSE).notes.join(" ")).toContain(said);
    expect(emitIris(spec)).toContain(said);
    expect(inlineBody(spec)).toContain(said);
  });
});
