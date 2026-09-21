// bun test
//
// An importer has exactly one dangerous failure: reading a class, understanding
// four fifths of it, and reporting nothing about the fifth. The spec then looks
// complete, emits a class that compiles, and delivers a message missing fields
// nobody can account for.
//
// So most of what is asserted here is the REPORT, not the spec. "It read the
// literal rows" matters; "it told me about the line it could not read" matters
// more, because that is the only thing standing between a partial import and a
// silent one.

import { expect, test, describe } from "bun:test";

import { importClass } from "./import-cls";
import { validate } from "./spec";

const CLASS = (body: string) =>
  [
    `/// A test interface.`,
    `Class Site.Test.Process.Thing Extends Ens.BusinessProcess [ ClassType = persistent ]`,
    `{`,
    ``,
    `Method OnRequest(pRequest As EnsLib.HL7.Message, Output pResponse As Ens.Response) As %Status`,
    `{`,
    `    #dim tsc As %Status`,
    `    s tsc = $$$OK`,
    `    try {`,
    `        s event = pRequest.GetValueAt("MSH:9.2")`,
    `        if ((event '= "A01") && (event '= "A08")) {`,
    `            return $$$OK`,
    `        }`,
    `        s tSource = pRequest.%ConstructClone()`,
    `        s tTarget = ##class(EnsLib.HL7.Message).%New()`,
    `        d tTarget.PokeDocType("2.3:ADT_A01")`,
    `        s tEvent = $SELECT(event="A01":"A28",event="A08":"A31",1:"")`,
    body,
    `        $$$ThrowOnError(..SendRequestAsync("ToSomewhere.ADT.TCP",tTarget,0))`,
    `    } catch e {`,
    `        s tsc = e.AsStatus()`,
    `    }`,
    `    quit tsc`,
    `}`,
    ``,
    `}`,
  ].join("\n");

const blockFor = (r: ReturnType<typeof importClass>, id: string) =>
  r.spec.blocks.find((b) => b.id === id);

// ---------------------------------------------------------------------------

describe("the frame", () => {
  test("gate path, permitted events and what each becomes", () => {
    const r = importClass(CLASS(`        s tsc = tTarget.SetValueAt(tSource.GetValueAt("MSH"),"MSH")`));
    expect(r.spec.gate.path).toBe("MSH-9.2");
    expect(r.spec.gate.permit).toEqual({ A01: "A28", A08: "A31" });
  });

  // The filter decides who is admitted; $SELECT decides what each becomes. An
  // event the filter admits with no $SELECT entry passes through unchanged, and
  // a $SELECT entry the filter never admits is dead code in the class. Carrying
  // that second one in would build a spec that ACCEPTS a message the class
  // refuses -- the direction of error nobody notices, because the interface
  // just handles something extra and nothing errors.
  test("the filter decides who is admitted, not the $SELECT table", () => {
    const src = CLASS(`        s tsc = tTarget.SetValueAt(tSource.GetValueAt("MSH"),"MSH")`)
      .replace(`(event '= "A08")`, `(event '= "A04")`);
    const r = importClass(src);
    expect(r.spec.gate.permit).toEqual({ A01: "A28", A04: "A04" });
    expect(r.notes.join("\n")).toContain("A08");
    expect(r.notes.join("\n")).toContain("dead in the class");
  });

  test("doctype, process class and dispatch target", () => {
    const r = importClass(CLASS(`        s tsc = tTarget.SetValueAt(tSource.GetValueAt("PID"),"PID")`));
    expect(r.spec.iris.sourceDocType).toBe("2.3:ADT_A01");
    expect(r.spec.iris.process?.className).toBe("Site.Test.Process.Thing");
    expect(r.spec.iris.process?.sendTo).toBe("ToSomewhere.ADT.TCP");
  });

  // Two classes, so two names. The emitter refuses them equal, so an import
  // that reused the process name would produce a spec that cannot emit.
  test("the DTL is given a different name from the process", () => {
    const r = importClass(CLASS(`        s tsc = tTarget.SetValueAt(tSource.GetValueAt("PID"),"PID")`));
    expect(r.spec.iris.className).not.toBe(r.spec.iris.process?.className);
    expect(validate(r.spec)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("the assignments", () => {
  test("a whole-segment copy", () => {
    const r = importClass(CLASS(`        s tsc = tTarget.SetValueAt(tSource.GetValueAt("PID"),"PID")`));
    expect(blockFor(r, "PID")?.wholeSegment).toBe(true);
    expect(r.unread).toEqual([]);
  });

  test("a literal, a blank and the target event", () => {
    const r = importClass(
      CLASS(
        [
          `        s tsc = tTarget.SetValueAt("SENDING_APP","MSH:3") $$$ThrowOnError(tsc)`,
          `        s tsc = tTarget.SetValueAt("","PID:19") $$$ThrowOnError(tsc)`,
          `        s tsc = tTarget.SetValueAt(tEvent,"EVN:1") $$$ThrowOnError(tsc)`,
        ].join("\n"),
      ),
    );
    expect(blockFor(r, "MSH")?.rows[0]).toEqual({ target: "MSH-3", from: { kind: "literal", value: "SENDING_APP" } });
    expect(blockFor(r, "PID")?.rows[0]).toEqual({ target: "PID-19", from: { kind: "literal", value: "" } });
    expect(blockFor(r, "EVN")?.rows[0]).toEqual({ target: "EVN-1", from: { kind: "event" } });
    expect(r.unread).toEqual([]);
  });

  test("a field copy", () => {
    const r = importClass(
      CLASS(`        s tsc = tTarget.SetValueAt(tSource.GetValueAt("PID:5.1"),"PID:5.1")`),
    );
    expect(blockFor(r, "PID")?.rows[0]).toEqual({
      target: "PID-5.1",
      from: { kind: "copy", path: "PID-5.1" },
    });
  });

  // The line that broke a first attempt. `$$$ThrowOnError(tsc)` on the end means
  // a greedy pattern runs to the LAST bracket on the line, and the target comes
  // back as everything in between.
  test("a trailing macro on the same line does not swallow the target", () => {
    const r = importClass(CLASS(`        s tsc = tTarget.SetValueAt("SENDING_FAC","MSH:4") $$$ThrowOnError(tsc)`));
    expect(blockFor(r, "MSH")?.rows[0]?.target).toBe("MSH-4");
    expect(r.unread).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("repeats", () => {
  const LOOP = [
    `        s tNK1Count = +tSource.GetValueAt("NK1(*)")`,
    `        s n1 = 0`,
    `        for k1=1:1:tNK1Count {`,
    `            if $LENGTH(tSource.GetValueAt("NK1("_k1_"):2")) {`,
    `                s n1 = n1+1`,
    `                s tsc = tTarget.SetValueAt(tSource.GetValueAt("NK1("_k1_")"),"NK1("_n1_")") $$$ThrowOnError(tsc)`,
    `            }`,
    `        }`,
  ].join("\n");

  test("the loop becomes a repeat with its skip rule", () => {
    const r = importClass(CLASS(LOOP));
    expect(blockFor(r, "NK1")?.repeat).toEqual({ over: "NK1", skipWhenEmpty: "NK1-2" });
    expect(blockFor(r, "NK1")?.wholeSegment).toBe(true);
  });

  // `"NK1("_n1_")"` is a concatenation. Reading the first quoted run instead
  // gives a target of `NK1(` and invents a block nothing can deliver.
  test("a concatenated occurrence does not become part of the segment id", () => {
    const r = importClass(CLASS(LOOP));
    expect(r.spec.blocks.map((b) => b.id)).toEqual(["NK1"]);
    expect(r.unread).toEqual([]);
  });

  test("a grouped segment keeps its group", () => {
    const r = importClass(
      CLASS(
        [
          `        s tINCount = +tSource.GetValueAt("IN1grp(*)")`,
          `        s i1 = 0`,
          `        for k3=1:1:tINCount {`,
          `            s tIN1 = ""`,
          `            try { s tIN1 = tSource.GetValueAt("IN1grp("_k3_").IN1") } catch { s tIN1 = "" }`,
          `            if $LENGTH($G(tIN1)) {`,
          `                s i1 = i1+1`,
          `                s tsc = tTarget.SetValueAt($G(tIN1),"IN1grp("_i1_").IN1") $$$ThrowOnError(tsc)`,
          `            }`,
          `        }`,
        ].join("\n"),
      ),
    );
    expect(blockFor(r, "IN1")?.group).toBe("IN1grp");
    expect(blockFor(r, "IN1")?.wholeSegment).toBe(true);
    expect(r.unread).toEqual([]);
  });

  // A one-line `try { s tGT1 = ... } catch { ... }` is how an optional segment
  // is read defensively. Skipping it on the strength of its first word threw
  // away the read it wraps, and the assign that used the variable then had no
  // idea what was in it.
  test("a variable holding a whole segment is followed through", () => {
    const r = importClass(
      CLASS(
        [
          `        s tGT1 = ""`,
          `        try { s tGT1 = tSource.GetValueAt("GT1("_k2_")") } catch { s tGT1 = "" }`,
          `        s tsc = tTarget.SetValueAt($G(tGT1),"GT1("_g1_")") $$$ThrowOnError(tsc)`,
        ].join("\n"),
      ),
    );
    expect(blockFor(r, "GT1")?.wholeSegment).toBe(true);
    expect(r.unread).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("what it refuses to guess", () => {
  // The whole point. A line it cannot read must be REPORTED, not dropped.
  test("an expression it cannot say is reported and left as a TODO", () => {
    const r = importClass(
      CLASS(`        s tsc = tTarget.SetValueAt($ZDATE(tSource.GetValueAt("PID:7"),8),"PID:7")`),
    );
    expect(r.unread).toHaveLength(1);
    expect(r.unread[0]!.text).toContain("$ZDATE");
    // Present in the spec as a TODO, so it shows in the trace and in the
    // emitted class rather than vanishing.
    expect(blockFor(r, "PID")?.rows[0]?.from.kind).toBe("todo");
  });

  test("a line it has never seen is reported rather than ignored", () => {
    const r = importClass(CLASS(`        d ..SomethingNobodyAnticipated(tTarget)`));
    expect(r.unread).toHaveLength(1);
    expect(r.unread[0]!.text).toContain("SomethingNobodyAnticipated");
  });

  // Bookkeeping is not a decision. Reporting `s n1 = n1+1` as "not understood"
  // buries the lines that ARE decisions under noise, and a report nobody reads
  // is the same as no report.
  test("loop bookkeeping is not reported as an unread decision", () => {
    const r = importClass(
      CLASS([`        s n1 = 0`, `        s n1 = n1+1`, `        s tGT1 = ""`].join("\n")),
    );
    expect(r.unread).toEqual([]);
  });
});
