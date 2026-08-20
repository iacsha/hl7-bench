import { expect, test, describe } from "bun:test";
import { Message } from "./hl7";
import {
  SOURCE_KINDS, STEP_KINDS, validate, emptyTables, describeSource,
  copy, literal, firstOf, lookup, counter, event, pickRepeat, fromFirst, todo,
  blank, passthrough, constant,
  date8, truncate, upper, stripDelims, stripChars, defaultTo, stamp,
  type Spec, type Source, type Step,
} from "./spec";
import { runSpec } from "./run";
import { trace, inventory } from "./trace";
import { emitIris, dtlPath, routingCondition } from "./emit/iris";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MSG = [
  "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260819101500||ADT^A01|MSG0001|P|2.3",
  "PID|1||MRN9^^^MR||doe^john^q||19800101|M",
  "PV1|1|I|WARD^101^A||||1234^SMITH^JOHN^^^^MT~9876543210^SMITH^JOHN^^^^NPI|||||||||||V123",
  "NK1|1|||||",
  "NK1|2|ROE^JANE|SPO",
  "IN1|1|PLANA||||||||||||||||||||||||||||||||||POL1",
  "IN1|2||||||||||||||||||||||||||||||||",
  "IN1|3|PLANC||||||||||||||||||||||||||||||||||POL3",
].join("\r\n");

const msg = () => new Message(MSG);

const base = (over: Partial<Spec> = {}): Spec => ({
  name: "Test Interface",
  gate: { path: "MSH-9.2", permit: { A01: "A28", A08: "A31" } },
  iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3.1:ADT_A05" },
  tables: { Sex: { M: "1", F: "2" } },
  blocks: [{ id: "MSH", rows: [{ target: "MSH-3", from: literal("BENCH") }] }],
  ...over,
});


const runOn = (spec: Spec, raw = MSG) => {
  const m = new Message(raw);
  const r = runSpec(spec, m);
  return { out: m, ...r };
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("the gate", () => {
  test("a permitted trigger resolves to its target event", () => {
    expect(runOn(base()).event).toBe("A28");
  });

  test("an unhandled trigger throws instead of delivering something else", () => {
    const a03 = MSG.replace("ADT^A01", "ADT^A03");
    expect(() => runOn(base(), a03)).toThrow(/does not handle/);
  });

  test("the error names what the interface does handle", () => {
    const a03 = MSG.replace("ADT^A01", "ADT^A03");
    expect(() => runOn(base(), a03)).toThrow(/A01, A08/);
  });

  test("an empty permit table is refused as unrunnable, not as a refusal of every message", () => {
    const spec = base({ gate: { path: "MSH-9.2", permit: {} } });
    expect(() => runOn(spec)).toThrow(/not runnable/);
  });
});

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

describe("sources", () => {
  const one = (from: Source, via?: Step[]) =>
    runOn(base({ blocks: [{ id: "ZZZ", rows: [{ target: "ZZZ-1", from, via }] }] }))
      .out.get("ZZZ-1");

  test("copy takes the source path", () => {
    expect(one(copy("PID-5.1"))).toBe("doe");
  });

  test("literal stamps a constant", () => {
    expect(one(literal("X"))).toBe("X");
  });

  test("firstOf takes the first path with a value", () => {
    expect(one(firstOf("PID-4", "PID-3.1"))).toBe("MRN9");
  });

  test("firstOf with nothing populated is empty, not an error", () => {
    expect(one(firstOf("PID-4", "PID-30"))).toBe("");
  });

  test("lookup translates a mapped code", () => {
    expect(one(lookup("Sex", "PID-8", blank()))).toBe("1");
  });

  test("each unmapped branch behaves differently, and none is the default", () => {
    const f = MSG.replace("|19800101|M", "|19800101|U");
    const of = (u: any) =>
      runOn(base({ blocks: [{ id: "ZZZ", rows: [{ target: "ZZZ-1", from: lookup("Sex", "PID-8", u) }] }] }), f)
        .out.get("ZZZ-1");
    expect(of(blank())).toBe("");
    expect(of(passthrough())).toBe("U");
    expect(of(constant("9"))).toBe("9");
  });

  test("an EMPTY source is not an unmapped code", () => {
    // The distinction matters: sending the unmapped default for a field the
    // sender never populated invents data that no system asserted.
    const f = MSG.replace("|19800101|M", "|19800101|");
    const spec = base({ blocks: [{ id: "ZZZ", rows: [{ target: "ZZZ-1", from: lookup("Sex", "PID-8", constant("9")) }] }] });
    expect(runOn(spec, f).out.get("ZZZ-1")).toBe("");
  });

  test("an unmapped code is reported, not just substituted", () => {
    const f = MSG.replace("|19800101|M", "|19800101|U");
    const spec = base({ blocks: [{ id: "ZZZ", rows: [{ target: "ZZZ-1", from: lookup("Sex", "PID-8", blank()) }] }] });
    expect(runOn(spec, f).notes.join("\n")).toContain(`unmapped Sex code "U"`);
  });

  test("event stamps the gate's target event, not the source trigger", () => {
    expect(one(event())).toBe("A28");
  });

  test("pickRepeat finds the qualified repetition wherever it sits", () => {
    // PV1-7 carries the same doctor twice, MT then NPI. Reading PV1-7(2) works
    // until a site sends them the other way round.
    expect(one(pickRepeat("PV1-7", 7, "NPI", 1))).toBe("9876543210");
    expect(one(pickRepeat("PV1-7", 7, "MT", 1))).toBe("1234");
  });

  test("pickRepeat with no matching qualifier is empty, not the first repetition", () => {
    expect(one(pickRepeat("PV1-7", 7, "DEA", 1))).toBe("");
  });

  test("fromFirst skips the shell segments", () => {
    // NK1(1) is empty past its set id. A bare NK1-2 read would take it.
    expect(one(fromFirst("NK1", "NK1-2", "NK1-2.1"))).toBe("ROE");
  });

  test("todo delivers nothing and says so", () => {
    const spec = base({ blocks: [{ id: "ZZZ", rows: [{ target: "ZZZ-1", from: todo("needs the code set") }] }] });
    const r = runOn(spec);
    expect(r.out.get("ZZZ-1")).toBe("");
    expect(r.notes.join("\n")).toContain("TODO ZZZ-1: needs the code set");
  });
});

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

describe("steps", () => {
  const via = (steps: Step[], from: Source = copy("PID-5.1")) =>
    runOn(base({ blocks: [{ id: "ZZZ", rows: [{ target: "ZZZ-1", from, via: steps }] }] })).out.get("ZZZ-1");

  test("date8 cuts a datetime to a date", () => {
    expect(via([date8()], copy("MSH-7"))).toBe("20260819");
  });

  test("truncate cuts to length", () => {
    expect(via([truncate(2)])).toBe("do");
  });

  test("upper uppercases", () => {
    expect(via([upper()])).toBe("DOE");
  });

  test("stripDelims removes characters that would split the field", () => {
    expect(via([stripDelims()], literal("A^B|C~D&E"))).toBe("ABCDE");
  });

  test("defaultTo only fires on empty", () => {
    expect(via([defaultTo("X")])).toBe("doe");
    expect(via([defaultTo("X")], copy("PID-30"))).toBe("X");
  });

  test("steps run in order", () => {
    expect(via([truncate(2), upper()])).toBe("DO");
    expect(via([upper(), truncate(2)])).toBe("DO");
    // and order is visible where it matters
    expect(via([defaultTo("zz"), upper()], copy("PID-30"))).toBe("ZZ");
    expect(via([upper(), defaultTo("zz")], copy("PID-30"))).toBe("zz");
  });
});

// ---------------------------------------------------------------------------
// Repeats
// ---------------------------------------------------------------------------

describe("repeats", () => {
  const insurance = (over: Partial<Spec["blocks"][0]["repeat"]> = {}): Spec =>
    base({
      blocks: [
        {
          id: "IN1",
          repeat: { over: "IN1", skipWhenEmpty: "IN1-2", ...over },
          rows: [
            { target: "IN1-1", from: counter() },
            { target: "IN1-2", from: copy("IN1-2") },
            { target: "IN1-36", from: copy("IN1-36") },
          ],
        },
      ],
    });

  test("skipWhenEmpty drops the shell coverage", () => {
    const out = runOn(insurance()).out;
    expect(out.all("IN1").length).toBe(2);
  });

  test("the set id numbers by OUTPUT ordinal, not by source repeat", () => {
    // IN1|3 is the second one delivered. Numbering it 3 leaves a hole, and
    // receivers that validate set id sequence reject the whole message.
    const segs = runOn(insurance()).out.all("IN1");
    expect(segs.map((s) => s.get("IN1-1"))).toEqual(["1", "2"]);
    expect(segs.map((s) => s.get("IN1-2"))).toEqual(["PLANA", "PLANC"]);
  });

  test("each occurrence reads its own segment, not the first", () => {
    const segs = runOn(insurance()).out.all("IN1");
    expect(segs.map((s) => s.get("IN1-36"))).toEqual(["POL1", "POL3"]);
  });

  test("max caps the delivered count", () => {
    expect(runOn(insurance({ max: 1 })).out.all("IN1").length).toBe(1);
  });

  test("a path outside the repeated segment still reads the message", () => {
    const spec = base({
      blocks: [{
        id: "IN1",
        repeat: { over: "IN1", skipWhenEmpty: "IN1-2" },
        rows: [{ target: "IN1-4", from: copy("MSH-4") }],
      }],
    });
    expect(runOn(spec).out.all("IN1").map((s) => s.get("IN1-4"))).toEqual(["SENDFAC", "SENDFAC"]);
  });

  test("no matching source segments delivers no segments, silently and correctly", () => {
    const spec = base({
      blocks: [{ id: "ZZZ", repeat: { over: "ZZZ" }, rows: [{ target: "ZZZ-1", from: counter() }] }],
    });
    expect(runOn(spec).out.all("ZZZ").length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

describe("the delivered message", () => {
  test("block order is segment order", () => {
    const spec = base({
      blocks: [
        { id: "MSH", rows: [{ target: "MSH-3", from: literal("BENCH") }] },
        { id: "EVN", rows: [{ target: "EVN-1", from: event() }] },
        { id: "PID", rows: [{ target: "PID-3", from: copy("PID-3.1") }] },
      ],
    });
    expect(runOn(spec).out.segments.map((s) => s.id)).toEqual(["MSH", "EVN", "PID"]);
  });

  test("MSH comes out parseable, with the encoding characters intact", () => {
    const spec = base({
      blocks: [{
        id: "MSH",
        rows: [
          { target: "MSH-3", from: literal("BENCH") },
          { target: "MSH-9.1", from: literal("ADT") },
          { target: "MSH-9.2", from: event() },
          { target: "MSH-12", from: literal("2.3.1") },
        ],
      }],
    });
    const round = new Message(runOn(spec).out.toString());
    expect(round.get("MSH-2")).toBe("^~\\&");
    expect(round.get("MSH-3")).toBe("BENCH");
    expect(round.get("MSH-9.2")).toBe("A28");
    expect(round.get("MSH-12")).toBe("2.3.1");
  });

  test("nothing from the source rides along that the spec did not ask for", () => {
    // create='new' in the DTL and a fresh target here. Same behaviour, so a
    // field nobody mapped cannot reach the receiver on either side.
    expect(runOn(base()).out.segments.map((s) => s.id)).toEqual(["MSH"]);
  });
});

// ---------------------------------------------------------------------------
// Required and notes
// ---------------------------------------------------------------------------

describe("required fields", () => {
  const spec = base({
    blocks: [{
      id: "PID",
      rows: [
        { target: "PID-3", from: copy("PID-3.1"), required: true, label: "MRN" },
        { target: "PID-4", from: copy("PID-4"), required: true, label: "Account Number" },
        { target: "PID-19", from: copy("PID-19"), required: true, label: "SSN" },
      ],
    }],
  });

  test("EVERY missing required field is reported, not the first", () => {
    const r = runOn(spec);
    expect(r.missing).toEqual(["Account Number", "SSN"]);
  });

  test("the missing list uses labels, because that is what the receiver calls them", () => {
    expect(runOn(spec).notes.join("\n")).toContain("MISSING REQUIRED: Account Number, SSN");
  });

  test("an empty lookup table is called out, because it looks like a working lookup", () => {
    const s = base({ tables: { Sex: {}, Dept: {} } });
    const notes = runOn(s).notes.join("\n");
    expect(notes).toContain("table Sex is empty");
    expect(notes).toContain("table Dept is empty");
    expect(emptyTables(s)).toEqual(["Sex", "Dept"]);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validate", () => {
  test("a row in the wrong block is caught, since it would just come out empty", () => {
    const p = validate(base({ blocks: [{ id: "PID", rows: [{ target: "PV1-2", from: literal("X") }] }] }));
    expect(p.join()).toContain("targets PV1");
  });

  test("a lookup naming a table that does not exist is caught", () => {
    const p = validate(base({ blocks: [{ id: "PID", rows: [{ target: "PID-8", from: lookup("Nope", "PID-8", blank()) }] }] }));
    expect(p.join()).toContain(`no table named "Nope"`);
  });

  test("counter outside a repeat has no ordinal and is caught", () => {
    const p = validate(base({ blocks: [{ id: "IN1", rows: [{ target: "IN1-1", from: counter() }] }] }));
    expect(p.join()).toContain("counter()");
  });

  test("a malformed path is caught rather than silently reading nothing", () => {
    const p = validate(base({ blocks: [{ id: "PID", rows: [{ target: "PatientName", from: literal("X") }] }] }));
    expect(p.join()).toContain(`Not a valid HL7 path: "PatientName"`);
  });

  test("a valid spec has no problems", () => {
    expect(validate(base())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The trace
// ---------------------------------------------------------------------------

describe("trace", () => {
  const spec = base({
    description: "worked example",
    blocks: [
      { id: "MSH", rows: [{ target: "MSH-3", from: literal("BENCH"), label: "Sending App" }] },
      {
        id: "PID",
        rows: [
          { target: "PID-5.1", from: copy("PID-5.1"), via: [upper()], label: "Last Name", required: true },
          { target: "PID-4", from: copy("PID-4"), label: "Account Number", required: true },
        ],
      },
      {
        id: "IN1",
        repeat: { over: "IN1", skipWhenEmpty: "IN1-2" },
        rows: [{ target: "IN1-1", from: counter() }, { target: "IN1-2", from: copy("IN1-2") }],
      },
    ],
    outOfScope: ["PID-10 race, receiver does not consume it"],
  });

  const t = trace(spec, msg());

  test("it shows the gate decision in the header", () => {
    expect(t).toContain(`MSH-9.2 "A01" delivers as A28`);
  });

  test("it shows source, raw, steps, and final for a transformed field", () => {
    expect(t).toMatch(/PID-5\.1 \*.*Last Name.*PID-5\.1.*doe.*uppercase.*DOE/);
  });

  test("repeats are labelled by occurrence", () => {
    expect(t).toContain("IN1  --  1 of 2");
    expect(t).toContain("IN1  --  2 of 2");
  });

  test("it lists every missing required field", () => {
    expect(t).toContain("MISSING REQUIRED (1): Account Number");
  });

  test("out of scope is stated as a decision, so absence is never just absence", () => {
    expect(t).toContain("OUT OF SCOPE");
    expect(t).toContain("PID-10 race");
  });

  test("the trace and the run agree, because both go through the same walk", () => {
    const r = runOn(spec);
    expect(t).toContain(`MISSING REQUIRED (${r.missing.length})`);
    expect((t.match(/^IN1 /gm) ?? []).length).toBe(r.out.all("IN1").length);
  });
});

describe("inventory", () => {
  const spec = base({
    blocks: [{ id: "PID", rows: [{ target: "PID-3", from: copy("PID-3.1") }] }],
    sourceInventory: [
      { path: "PID-3.1", label: "MRN", required: true },
      { path: "PID-4", label: "Account Number", required: true, note: "empty at this site" },
      { path: "PID-8", label: "Sex" },
    ],
  });

  const inv = inventory(spec, msg());

  test("it reports what the SENDER left empty, which is a different list", () => {
    expect(inv).toContain("MISSING FROM SENDER (1): Account Number");
  });

  test("it names which target rows read each source field", () => {
    expect(inv).toMatch(/PID-3\.1.*MRN.*present.*MRN9.*PID-3/);
  });

  test("a source field nothing reads is called out as unmapped", () => {
    expect(inv).toMatch(/PID-8.*Sex.*not mapped/);
  });

  test("no inventory means no table, rather than an empty one", () => {
    expect(inventory(base(), msg())).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The IRIS backend
// ---------------------------------------------------------------------------

describe("dtlPath", () => {
  test("field, component, repetition", () => {
    expect(dtlPath("PID-3")).toBe("{PID:3}");
    expect(dtlPath("PID-5.1")).toBe("{PID:5.1}");
    expect(dtlPath("PID-13(1).3")).toBe("{PID:13(1).3}");
  });

  test("a group prefix nests the segment", () => {
    expect(dtlPath("IN1-4", "INSURANCEgrp(k1)")).toBe("{INSURANCEgrp(k1).IN1:4}");
  });

  test("a prefix that IS the segment does not repeat it", () => {
    // {IN1(k1).IN1:4} would resolve to nothing, silently. This is the guard.
    expect(dtlPath("IN1-4", "IN1(k1)")).toBe("{IN1(k1):4}");
  });

  test("refuses something that is not a path", () => {
    expect(() => dtlPath("PatientLastName")).toThrow();
  });
});

describe("emitIris", () => {
  const of = (over: Partial<Spec>) => emitIris(base(over));

  test("literal quotes, copy does not", () => {
    const out = of({ blocks: [{ id: "MSH", rows: [{ target: "MSH-3", from: literal("SOURCEAPP") }] }] });
    expect(out).toContain(`value='"SOURCEAPP"' property='target.{MSH:3}'`);
    expect(of({ blocks: [{ id: "MSH", rows: [{ target: "MSH-7", from: copy("MSH-7") }] }] }))
      .toContain(`value='source.{MSH:7}'`);
  });

  test("a quote inside a literal is doubled, not backslash escaped", () => {
    expect(of({ blocks: [{ id: "MSH", rows: [{ target: "MSH-3", from: literal(`A"B`) }] }] }))
      .toContain(`value='"A""B"'`);
  });

  test("firstOf becomes a $SELECT with a final empty arm", () => {
    const out = of({ blocks: [{ id: "PID", rows: [{ target: "PID-3", from: firstOf("PID-4", "PID-3") }] }] });
    expect(out).toContain("$SELECT($LENGTH(source.{PID:4})&gt;0:source.{PID:4}");
    expect(out).toContain(`,1:""`);
  });

  test("each unmapped branch produces a different Lookup fallback", () => {
    const l = (u: any) => of({ blocks: [{ id: "PID", rows: [{ target: "PID-8", from: lookup("Sex", "PID-8", u) }] }] });
    expect(l(blank())).toContain(`..Lookup("Sex",source.{PID:8},"")`);
    expect(l(passthrough())).toContain(`..Lookup("Sex",source.{PID:8},source.{PID:8})`);
    expect(l(constant("U"))).toContain(`..Lookup("Sex",source.{PID:8},"U")`);
  });

  test("lookup is guarded on emptiness, matching the runner", () => {
    expect(of({ blocks: [{ id: "PID", rows: [{ target: "PID-8", from: lookup("Sex", "PID-8", constant("U")) }] }] }))
      .toContain("$SELECT($LENGTH(source.{PID:8})&gt;0:..Lookup");
  });

  test("event becomes a $SELECT over the gate, so one class serves every permitted trigger", () => {
    const out = of({ blocks: [{ id: "MSH", rows: [{ target: "MSH-9.2", from: event() }] }] });
    expect(out).toContain(`source.{MSH:9.2}="A01":"A28"`);
    expect(out).toContain(`source.{MSH:9.2}="A08":"A31"`);
  });

  test("pickRepeat emits a scan, not a fixed repetition index", () => {
    const out = of({ blocks: [{ id: "PV1", rows: [{ target: "PV1-7", from: pickRepeat("PV1-7", 7, "NPI", 1) }] }] });
    // GetValueAt rather than {PV1:7(*)}: the scan is a <code> body, and the
    // curly form only compiles in a DTL attribute. See emit/iris.test.ts.
    expect(out).toContain(`source.GetValueAt("PV1:7(*)")`);
    expect(out).toContain(`= "NPI"`);
    expect(out).not.toContain(`"PV1:7(2)`);
  });

  test("fromFirst emits a scan over the segment repetitions", () => {
    const out = of({ blocks: [{ id: "GT1", rows: [{ target: "GT1-3", from: fromFirst("NK1", "NK1-2", "NK1-2.1") }] }] });
    expect(out).toContain(`source.GetValueAt("NK1(*)")`);
    expect(out).toContain(`$LENGTH(source.GetValueAt("NK1("_i`);
  });

  test("todo emits a TODO comment and NO assign", () => {
    const out = of({ blocks: [{ id: "PID", rows: [{ target: "PID-19", from: todo("strip punctuation") }] }] });
    expect(out).toContain("TODO PID-19: strip punctuation");
    expect(out).not.toContain("target.{PID:19}' action='set'");
  });

  test("steps wrap the expression, in order", () => {
    const out = of({
      blocks: [{ id: "PID", rows: [{ target: "PID-7", from: copy("PID-7"), via: [date8(), truncate(4)] }] }],
    });
    expect(out).toContain("$EXTRACT($EXTRACT(source.{PID:7},1,8),1,4)");
  });

  test("counter outside a repeat is an error, not a wrong file", () => {
    expect(() => of({ blocks: [{ id: "IN1", rows: [{ target: "IN1-1", from: counter() }] }] })).toThrow();
  });

  describe("XML escaping", () => {
    test("comparison operators are escaped once, not twice", () => {
      const out = of({ blocks: [{ id: "PID", rows: [{ target: "PID-3", from: firstOf("PID-4", "PID-3") }] }] });
      expect(out).toContain("&gt;0");
      expect(out).not.toContain("&amp;gt;");
      expect(out).not.toMatch(/value='[^']*>/);
    });

    test("an ampersand in a note does not break the XML", () => {
      expect(of({ blocks: [{ id: "MSH", rows: [{ target: "MSH-3", from: literal("X"), note: "A & B" }] }] }))
        .toContain("<!-- A &amp; B -->");
    });
  });

  describe("repeats", () => {
    const loop = (block: any) => emitIris(base({ blocks: [block] }));

    test("a grouped repeat prefixes source with the key and target with the ordinal", () => {
      const out = loop({
        id: "IN1", group: "INSURANCEgrp",
        repeat: { over: "IN1", skipWhenEmpty: "IN1-4", max: 3 },
        rows: [{ target: "IN1-1", from: counter() }, { target: "IN1-2", from: copy("IN1-2") }],
      });
      expect(out).toContain(`<foreach property='source.{INSURANCEgrp()}' key='k1' >`);
      expect(out).toContain(`value='n1' property='target.{INSURANCEgrp(n1).IN1:1}'`);
      expect(out).toContain(`value='source.{INSURANCEgrp(k1).IN1:2}' property='target.{INSURANCEgrp(n1).IN1:2}'`);
    });

    test("an ungrouped repeat repeats on the segment itself", () => {
      const out = loop({ id: "NK1", repeat: { over: "NK1" }, rows: [{ target: "NK1-2", from: copy("NK1-2") }] });
      expect(out).toContain(`<foreach property='source.{NK1()}' key='k1' >`);
      expect(out).toContain(`value='source.{NK1(k1):2}' property='target.{NK1(n1):2}'`);
      expect(out).not.toContain("NK1(k1).NK1");
    });

    test("the ordinal resets before the loop and increments inside the guard", () => {
      const out = loop({
        id: "IN1", group: "INSURANCEgrp",
        repeat: { over: "IN1", skipWhenEmpty: "IN1-4" },
        rows: [{ target: "IN1-1", from: counter() }],
      });
      expect(out.indexOf("set n1 = 0")).toBeLessThan(out.indexOf("<foreach"));
      expect(out.indexOf("<true>")).toBeLessThan(out.indexOf("set n1 = n1 + 1"));
    });

    test("no guard means no if wrapper", () => {
      const out = loop({ id: "NK1", repeat: { over: "NK1" }, rows: [{ target: "NK1-2", from: copy("NK1-2") }] });
      expect(out).not.toContain("<if condition");
    });

    test("two repeats get distinct key and ordinal variables", () => {
      const out = emitIris(base({
        blocks: [
          { id: "IN1", group: "INSURANCEgrp", repeat: { over: "IN1" }, rows: [{ target: "IN1-1", from: counter() }] },
          { id: "NK1", repeat: { over: "NK1" }, rows: [{ target: "NK1-1", from: counter() }] },
        ],
      }));
      expect(out).toContain("key='k1'");
      expect(out).toContain("key='k2'");
      expect(out).toContain("set n2 = 0");
    });
  });

  describe("iris.className is refused when it would clobber InterSystems", () => {
    // A class definition occupies its name, it does not extend it. Naming a
    // DTL Ens.BusinessProcess and compiling it replaces the system class and
    // takes every business process in the namespace with it. The mistake is
    // reasonable: the portal sorts config items into Services / Processes /
    // Operations and the name looks like the lever. It is not. The column
    // comes from the class a config item EXTENDS, and a DTL extends
    // Ens.DataTransformDTL, which is no business host and gets no column.
    const withClass = (className: string) =>
      validate({ ...base(), iris: { ...base().iris, className } });

    for (const bad of [
      "Ens.BusinessProcess",
      "EnsLib.HL7.Message",
      "EnsPortal.Anything",
      "HS.Local.Thing",
      "%Library.String",
    ]) {
      test(`"${bad}" is rejected`, () => {
        expect(withClass(bad).join(" ")).toContain("InterSystems package");
      });
    }

    test("an ordinary site package passes", () => {
      expect(withClass("Site.Interface.Transform.AdtToRegistration")).toEqual([]);
    });

    test("a name with no package is called out, since it is easy to overwrite", () => {
      expect(withClass("AdtToRegistration").join(" ")).toContain("no package");
    });

    test("an illegal name is called out rather than emitted", () => {
      expect(withClass("9Bad.Name").join(" ")).toContain("not a legal class name");
      expect(withClass("Trailing.").join(" ")).toContain("not a legal class name");
    });

    test("unset is fine, because the emitter builds one from spec.name", () => {
      expect(validate(base())).toEqual([]);
    });
  });

  describe("iris.process, which is a second class out of the same spec", () => {
    const withProcess = (process: NonNullable<Spec["iris"]["process"]>, over: Partial<Spec["iris"]> = {}) =>
      validate({ ...base(), iris: { ...base().iris, process, ...over } });

    const ok = { className: "Site.Interface.Process.Adt", sendTo: "ToTarget.ADT.TCP" };

    test("a well formed process is silent", () => {
      expect(withProcess(ok)).toEqual([]);
    });

    test("absent is fine; it is optional and nothing else depends on it", () => {
      expect(validate(base())).toEqual([]);
    });

    // The same rule as the DTL name and for the same reason: a class definition
    // occupies its name rather than extending it.
    test("a reserved package is refused, and the message names this field", () => {
      const out = withProcess({ ...ok, className: "Ens.BusinessProcess" }).join(" ");
      expect(out).toContain("InterSystems package");
      expect(out).toContain("iris.process.className");
      expect(out).not.toContain("iris.className is");
    });

    test("an illegal name is refused here too", () => {
      expect(withProcess({ ...ok, className: "9Bad.Name" }).join(" ")).toContain("not a legal class name");
    });

    // Two classes, one name. Compiling both replaces the DTL with the process,
    // and the transform the process calls is then the process, which recurses.
    test("the same name as the DTL is refused", () => {
      const out = withProcess({ ...ok, className: "Site.Interface.Dtl.Adt" }, {
        className: "Site.Interface.Dtl.Adt",
      }).join(" ");
      expect(out).toContain("They are two classes");
    });

    test("a different name from the DTL is fine", () => {
      expect(withProcess(ok, { className: "Site.Interface.Dtl.Adt" })).toEqual([]);
    });

    // SendRequestAsync with an unresolvable target fails per message at run
    // time, not at compile time, so an empty one compiles and then bleeds.
    test("an empty sendTo is refused, since the failure is at run time", () => {
      expect(withProcess({ ...ok, sendTo: "" }).join(" ")).toContain("sendTo is empty");
    });

    test("whitespace-only sendTo counts as empty", () => {
      expect(withProcess({ ...ok, sendTo: "   " }).join(" ")).toContain("sendTo is empty");
    });
  });

  describe("the class shell", () => {
    test("create defaults to new, because the spec builds a fresh target", () => {
      expect(of({})).toContain("create='new'");
      expect(of({ iris: { ...base().iris, create: "copy" } })).toContain("create='copy'");
    });

    test("doctypes are written verbatim and the header says to check them", () => {
      const out = of({});
      expect(out).toContain("sourceDocType='2.3:ADT_A01'");
      expect(out).toContain("targetDocType='2.3.1:ADT_A05'");
      expect(out).toContain("fails closed");
    });

    test("the header carries the routing rule condition, since the gate belongs there", () => {
      expect(of({})).toContain(`HL7.{MSH:9.2}="A01" || HL7.{MSH:9.2}="A08"`);
      expect(routingCondition(base())).toBe(`HL7.{MSH:9.2}="A01" || HL7.{MSH:9.2}="A08"`);
    });

    test("an empty lookup table the class calls is flagged as a go-live gate", () => {
      const out = of({
        tables: { Dept: {} },
        blocks: [{ id: "PV1", rows: [{ target: "PV1-3", from: lookup("Dept", "PV1-3", blank()) }] }],
      });
      expect(out).toContain("*** EMPTY IN THE SPEC");
    });

    test("a table nothing calls is not listed, empty or otherwise", () => {
      // The header used to print spec.tables, so a leftover entry raised a
      // go-live gate on a table the class never touches. A false alarm on the
      // one header line that has to be believed is worse than no line.
      const out = of({ tables: { Dept: {}, Sex: { M: "1" } } });
      expect(out).not.toContain("*** EMPTY IN THE SPEC");
      expect(out).not.toContain("Lookup tables this class calls");
    });

    test("out of scope decisions travel into the class documentation", () => {
      expect(of({ outOfScope: ["PID-10 race"] })).toContain("PID-10 race");
    });

    test("block order is segment order in the emitted file too", () => {
      const out = of({
        blocks: [
          { id: "MSH", rows: [{ target: "MSH-3", from: literal("A") }] },
          { id: "EVN", rows: [{ target: "EVN-1", from: literal("B") }] },
        ],
      });
      expect(out.indexOf("{MSH:3}")).toBeLessThan(out.indexOf("{EVN:1}"));
    });
  });
});

// ---------------------------------------------------------------------------
// Completeness. The test that keeps the backends honest.
// ---------------------------------------------------------------------------

describe("iris.log puts the class's own logging in the spec", () => {
  const withLog = (log: Spec["iris"]["log"], blocks?: Spec["blocks"]) =>
    emitIris(base({
      iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3.1:ADT_A05", log },
      blocks: blocks ?? [{
        id: "PID",
        rows: [
          { target: "PID-3", from: copy("PID-3.1"), label: "MRN", required: true },
          { target: "PID-8", from: lookup("Sex", "PID-8", blank()) },
        ],
      }],
    }));

  test("warn is the default, because both things it catches are silent", () => {
    expect(withLog(undefined)).toContain("$$$LOGWARNING");
  });

  test("off emits no macros at all", () => {
    const out = withLog("off");
    expect(out).not.toContain("$$$");
  });

  test("off does not include Ensemble either, since nothing needs it", () => {
    expect(withLog("off")).not.toContain("Include Ensemble");
  });

  // Without the include the class does not compile, and the error names the
  // macro rather than the missing line, which is a bad half hour.
  test("logging on pulls in the macro definitions", () => {
    expect(withLog("warn").startsWith("Include Ensemble")).toBe(true);
  });

  test("a required target is checked AFTER the assign, on the target", () => {
    const out = withLog("warn");
    expect(out).toContain(`if '$LENGTH(target.GetValueAt("PID:3")) { $$$LOGWARNING(`);
    expect(out.indexOf("property='target.{PID:3}'")).toBeLessThan(
      out.indexOf(`if '$LENGTH(target.GetValueAt("PID:3"))`),
    );
  });

  test("the warning names the label, not just the path", () => {
    expect(withLog("warn")).toContain("PID-3 (MRN) is required and came out empty");
  });

  // The obvious test -- did Lookup come back empty -- cannot tell a miss from
  // a hit under passthrough or constant, because the fallback IS a real value.
  test("an unmapped code is detected with a sentinel, not with emptiness", () => {
    expect(withLog("warn")).toContain(
      '..Lookup("Sex",source.GetValueAt("PID:8"),$CHAR(0))=$CHAR(0)',
    );
  });

  test("the lookup check runs before the assign that swallows the miss", () => {
    const out = withLog("warn");
    expect(out.indexOf("$CHAR(0))=$CHAR(0)")).toBeLessThan(
      out.indexOf("property='target.{PID:8}'"),
    );
  });

  test("a passthrough fallback still gets a check, which is the whole point", () => {
    const out = withLog("warn", [{
      id: "PID",
      rows: [{ target: "PID-8", from: lookup("Sex", "PID-8", passthrough()) }],
    }]);
    expect(out).toContain("$CHAR(0))=$CHAR(0)");
  });

  test("warn does not trace", () => {
    expect(withLog("warn")).not.toContain("$$$TRACE");
  });

  test("trace adds one per assigned field and keeps the warnings", () => {
    const out = withLog("trace");
    expect(out).toContain("$$$TRACE");
    expect(out).toContain("$$$LOGWARNING");
  });

  test("a quote in a label cannot close the ObjectScript string early", () => {
    const out = withLog("warn", [{
      id: "PID",
      rows: [{ target: "PID-3", from: copy("PID-3.1"), label: 'the "real" MRN', required: true }],
    }]);
    expect(out).toContain('the ""real"" MRN');
  });
});

// ---------------------------------------------------------------------------

describe("every vocabulary kind is handled by every backend", () => {
  // One sample per kind. Adding a kind to spec.ts without adding it here fails
  // the first test below, and without handling it in a backend fails the rest.
  const SAMPLES: Record<(typeof SOURCE_KINDS)[number], Source> = {
    copy: copy("PID-5.1"),
    literal: literal("X"),
    firstOf: firstOf("PID-4", "PID-3.1"),
    lookup: lookup("Sex", "PID-8", blank()),
    counter: counter(),
    event: event(),
    pickRepeat: pickRepeat("PV1-7", 7, "NPI", 1),
    fromFirst: fromFirst("NK1", "NK1-2", "NK1-2.1"),
    todo: todo("not settled yet"),
  };

  const STEP_SAMPLES: Record<(typeof STEP_KINDS)[number], Step> = {
    date8: date8(),
    truncate: truncate(3),
    upper: upper(),
    stripDelims: stripDelims(),
    stripChars: stripChars("- "),
    defaultTo: defaultTo("X"),
  };

  test("the sample table covers every declared kind", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...SOURCE_KINDS].sort());
    expect(Object.keys(STEP_SAMPLES).sort()).toEqual([...STEP_KINDS].sort());
  });

  // counter() only means something inside a repeat, so every sample is
  // exercised inside one. That is the strictest context, not a special case.
  const specFor = (from: Source, via?: Step[]): Spec =>
    base({
      blocks: [{
        id: "IN1",
        repeat: { over: "IN1", skipWhenEmpty: "IN1-2" },
        rows: [{ target: "IN1-4", from, via }],
      }],
    });

  for (const kind of SOURCE_KINDS) {
    test(`run.ts handles ${kind}`, () => {
      const r = runOn(specFor(SAMPLES[kind]));
      expect(r.out.all("IN1").length).toBe(2);
    });

    test(`emit/iris.ts handles ${kind}`, () => {
      const out = emitIris(specFor(SAMPLES[kind]));
      expect(out).toContain("Class Bench.TestInterface");
      if (kind !== "todo") expect(out).toContain("action='set'");
    });

    test(`trace.ts handles ${kind}`, () => {
      const t = trace(specFor(SAMPLES[kind]), msg());
      expect(t).toContain("IN1-4");
      expect(describeSource(SAMPLES[kind])).not.toBe("");
    });
  }

  for (const kind of STEP_KINDS) {
    test(`both backends handle the ${kind} step`, () => {
      const spec = specFor(copy("IN1-2"), [STEP_SAMPLES[kind]]);
      expect(() => runOn(spec)).not.toThrow();
      expect(() => emitIris(spec)).not.toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// The behaviours a real port added
//
// Each of these came out of putting a real production interface onto this spec.
// They are here because each one is a way the bench could disagree with the
// engine while every existing test still passed.
// ---------------------------------------------------------------------------

describe("assign semantics", () => {
  // `<assign>` in a DTL CREATES the field, empty value and all. A bench that
  // skips empty assigns produces a SHORTER segment than the engine does, and a
  // receiver reading by ordinal position sees a different message than the one
  // that was signed off.
  const spec = base({
    blocks: [
      {
        id: "EVN",
        rows: [
          { target: "EVN-1", from: event() },
          { target: "EVN-2", from: copy("MSH-7") },
          { target: "EVN-5", from: copy("EVN-5") },
        ],
      },
    ],
  });

  test("an empty assign still creates the field", () => {
    const line = runOn(spec).out.all("EVN")[0].toString();
    // EVN-5 is empty at the source and EVN-3 and EVN-4 were never assigned,
    // but every one of them holds a place on the wire.
    expect(line).toBe("EVN|A28|20260819101500|||");
  });
});

describe("stripChars", () => {
  const via = (from: Source, chars: string) =>
    runOn(base({ blocks: [{ id: "ZZZ", rows: [{ target: "ZZZ-1", from, via: [stripChars(chars)] }] }] }))
      .out.get("ZZZ-1");

  test("it removes every listed character", () => {
    expect(via(literal("000-00-0000"), "- ")).toBe("000000000");
  });

  test("it leaves an already clean value alone", () => {
    expect(via(literal("000000000"), "- ")).toBe("000000000");
  });

  test("IRIS gets $TRANSLATE, which is the same removal", () => {
    const spec = base({
      blocks: [{ id: "PID", rows: [{ target: "PID-19", from: copy("PID-19"), via: [stripChars("- ")] }] }],
    });
    expect(emitIris(spec)).toContain("$TRANSLATE(");
  });
});

describe("pickRepeat taking several components", () => {
  const pv1 = (take: number | number[] | "whole") =>
    runOn(
      base({
        blocks: [{ id: "PV1", rows: [{ target: "PV1-7", from: pickRepeat("PV1-7", 7, "NPI", take) }] }],
      }),
    ).out;

  test("a component list comes out joined by the component separator", () => {
    expect(pv1([1, 2, 3]).get("PV1-7")).toBe("9876543210^SMITH^JOHN");
  });

  test("no matching repetition writes ONE empty field, not a bare ^^^", () => {
    // Written as three separate rows this would put "^^^" on the wire, and a
    // receiver that checks for a populated provider would see one.
    const out = runOn(
      base({
        blocks: [
          { id: "PV1", rows: [{ target: "PV1-7", from: pickRepeat("PV1-7", 7, "DEA", [1, 2, 3]) }] },
        ],
      }),
    ).out;
    expect(out.get("PV1-7")).toBe("");
    expect(out.all("PV1")[0].toString()).not.toContain("^^^");
  });

  test("the trace names which components were taken", () => {
    expect(describeSource(pickRepeat("PV1-7", 7, "NPI", [1, 2, 3]))).toContain("components 1+2+3");
    expect(describeSource(pickRepeat("PV1-7", 7, "NPI", 1))).toContain("component 1");
  });
});

describe("gate.require", () => {
  const spec = base({
    gate: {
      path: "MSH-9.2",
      permit: { A01: "A28" },
      require: [{ path: "MSH-9.1", equals: "ADT" }],
    },
  });

  test("a message satisfying every requirement is delivered", () => {
    expect(runOn(spec).event).toBe("A28");
  });

  test("a permitted trigger with the wrong message type is still refused", () => {
    // ORU in MSH-9.1 with an A01 in MSH-9.2 is a real feed, and the receiver
    // believes MSH-9.2.
    const wrong = MSG.replace("ADT^A01", "ORU^A01");
    expect(() => runOn(spec, wrong)).toThrow(/MSH-9\.1/);
  });

  test("the routing rule ANDs the requirement and parenthesises the events", () => {
    const two = base({
      gate: {
        path: "MSH-9.2",
        permit: { A01: "A28", A08: "A31" },
        require: [{ path: "MSH-9.1", equals: "ADT" }],
      },
    });
    // || binds looser than &&, so a rule reading A && B || C lets C through on
    // its own. The parentheses are the whole point of this assertion.
    expect(routingCondition(two)).toBe(
      `HL7.{MSH:9.1}="ADT" && (HL7.{MSH:9.2}="A01" || HL7.{MSH:9.2}="A08")`,
    );
  });

  test("the trace states the requirement, since it is why messages go missing", () => {
    expect(trace(spec, msg())).toContain(`MSH-9.1 must be "ADT"`);
  });
});

describe("notes that explain a silent outcome", () => {
  test("firstOf says when it fell past the first path", () => {
    const spec = base({
      blocks: [{ id: "PID", rows: [{ target: "PID-3", from: firstOf("PID-4", "PID-3.1"), label: "MRN" }] }],
    });
    expect(runOn(spec).notes.join("\n")).toContain("PID-4 empty, fell back to PID-3.1");
  });

  test("the same note raised by three rows is reported once", () => {
    const three = base({
      blocks: [
        {
          id: "PID",
          rows: [
            { target: "PID-2", from: firstOf("PID-4", "PID-3.1") },
            { target: "PID-3", from: firstOf("PID-4", "PID-3.1") },
            { target: "PID-4", from: firstOf("PID-4", "PID-3.1") },
          ],
        },
      ],
    });
    const hits = runOn(three).notes.filter((n) => n.includes("fell back")).length;
    expect(hits).toBe(1);
  });

  test("a skipped repetition is counted, because nothing else shows it", () => {
    const spec = base({
      blocks: [
        {
          id: "IN1",
          repeat: { over: "IN1", skipWhenEmpty: "IN1-2" },
          rows: [{ target: "IN1-1", from: counter() }],
        },
      ],
    });
    expect(runOn(spec).notes.join("\n")).toContain("1 IN1 segment(s) skipped");
  });

  test("a capped repetition says how many it dropped", () => {
    const spec = base({
      blocks: [
        {
          id: "IN1",
          repeat: { over: "IN1", skipWhenEmpty: "IN1-2", max: 1 },
          rows: [{ target: "IN1-1", from: counter() }],
        },
      ],
    });
    expect(runOn(spec).notes.join("\n")).toContain("dropping 1");
  });

  test("a row note reaches both the run and the trace", () => {
    const spec = base({
      blocks: [
        {
          id: "MSH",
          rows: [
            { target: "MSH-11", from: copy("MSH-11"), label: "Processing ID", note: "must be P at cutover" },
          ],
        },
      ],
    });
    expect(runOn(spec).notes.join("\n")).toContain("Processing ID: must be P at cutover");
    expect(trace(spec, msg())).toContain("Processing ID: must be P at cutover");
  });
});

describe("the source inventory credits the gate", () => {
  const spec = base({
    gate: {
      path: "MSH-9.2",
      permit: { A01: "A28" },
      require: [{ path: "MSH-9.1", equals: "ADT" }],
    },
    sourceInventory: [
      { path: "MSH-9.1", label: "Message Type", required: true },
      { path: "MSH-9.2", label: "Trigger Event", required: true },
    ],
  });

  test("gate paths are not listed as unmapped", () => {
    // They decide whether the message is delivered at all. "not mapped" is the
    // one reading of those two rows that would be flatly wrong.
    const inv = inventory(spec, msg());
    expect(inv).not.toContain("not mapped");
    expect(inv).toContain("(gate)");
  });
});

// ---------------------------------------------------------------------------
// Stamps
// ---------------------------------------------------------------------------

describe("validate: iris.process.stamp", () => {
  const proc = { className: "Site.Interface.Process.Adt", sendTo: "ToTarget.ADT.TCP" };
  const withStamp = (st: ReturnType<typeof stamp>[]) =>
    validate({ ...base(), iris: { ...base().iris, process: { ...proc, stamp: st } } });

  test("a well formed stamp is silent", () => {
    expect(withStamp([stamp("MSH-4", "WEST_LAB", "receiver routes on facility")])).toEqual([]);
  });

  test("no stamp key at all is silent", () => {
    expect(validate({ ...base(), iris: { ...base().iris, process: proc } })).toEqual([]);
  });

  test("a malformed path is named, and does not stop the rest of validation", () => {
    const out = withStamp([stamp("MSH4", "X", "why")]).join(" ");
    expect(out).toContain("iris.process.stamp");
    expect(out).toContain("MSH4");
  });

  // A stamp is a field the delivered trace will not explain. If nobody can say
  // why it is there, the next person keeps or deletes it by coin flip.
  test("an empty why is refused", () => {
    expect(withStamp([stamp("MSH-4", "X", "   ")]).join(" ")).toContain("empty why");
  });

  test("two stamps on one path is the second one winning silently", () => {
    const out = withStamp([stamp("MSH-4", "A", "one"), stamp("MSH-4", "B", "two")]).join(" ");
    expect(out).toContain("more than once");
  });

  test("three on one path still reports once, not twice", () => {
    const out = withStamp([stamp("MSH-4", "A", "a"), stamp("MSH-4", "B", "b"), stamp("MSH-4", "C", "c")]);
    expect(out.filter((x) => x.includes("more than once"))).toHaveLength(1);
  });

  // The expensive one. base() maps MSH-3 in a block, so stamping MSH-3 means
  // the trace document says BENCH and the receiver gets something else.
  test("stamping a path a block row already assigns is refused", () => {
    const out = withStamp([stamp("MSH-3", "OTHER", "why")]).join(" ");
    expect(out).toContain("MSH-3");
    expect(out).toContain("a block row also assigns");
    expect(out).toContain("delivered trace");
  });

  test("stamping a path no block touches is fine", () => {
    expect(withStamp([stamp("MSH-4", "X", "why")])).toEqual([]);
  });
});
