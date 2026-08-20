// bun test
//
// The generated class has to COMPILE, and there is no IRIS on the machine that
// generates it. That gap is what these tests cover: the one syntax rule the
// backend can break silently, checked here so it is caught at `bun test`
// rather than in Studio at 7am on a go-live.
//
// The rule is about `{PID:5.1}`. It is a DTL compiler feature and it works in
// a DTL element attribute -- `<assign value=`, `<if condition=`,
// `<foreach property=` -- and nowhere else. A `<code>` body goes to the
// ObjectScript compiler exactly as written, so the same text there fails with
//
//   Error compiling routine  invalid name $LENGTH(target.{MSH.10})
//
// The in-code equivalent is GetValueAt("PID:5.1"), and an occurrence number
// that is a loop VARIABLE has to be concatenated in rather than left inside
// the string, or the class looks for a repetition literally numbered "k1".

import { expect, test, describe } from "bun:test";

import { copy, fromFirst, literal, lookup, pickRepeat, blank, type Spec } from "../spec";
import { emitIris } from "./iris";

const base = (over: Partial<Spec> = {}): Spec => ({
  name: "Iris Emit Test",
  gate: { path: "MSH-9.2", permit: { A01: "A01" } },
  iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3.1:ADT_A01", log: "warn" },
  tables: {},
  blocks: [],
  ...over,
});

/** Every `<![CDATA[ ... ]]>` body in the emitted class. */
function cdata(cls: string): string[] {
  return [...cls.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((m) => m[1]);
}

/**
 * A DTL virtual property reference: `target.{MSH:10}` or a bare `{PID:3}`.
 *
 * Not a bare brace. ObjectScript blocks them too -- `if x { ... }` is most of
 * what a code body looks like -- so the test has to name the thing that
 * actually fails to compile rather than the character it starts with.
 */
const BRACED = /\.\{|\{[A-Z0-9]{3}[:(]/;

// ---------------------------------------------------------------------------

describe("no curly braces inside <code>", () => {
  // One test per source kind that emits a code block, because a new kind that
  // gets this wrong should fail on its own line rather than hide inside a
  // sweep. The sweep is here too, for the kind nobody thought of.

  test("a required target, which is the guard most rows carry", () => {
    const cls = emitIris(
      base({
        blocks: [{ id: "MSH", rows: [{ target: "MSH-10", from: copy("MSH-10"), required: true, label: "Control ID" }] }],
      }),
    );
    const guard = cdata(cls).find((c) => c.includes("LOGWARNING"))!;
    expect(guard).toContain(`target.GetValueAt("MSH:10")`);
    expect(guard).not.toMatch(BRACED);
  });

  test("an unmapped lookup code", () => {
    const cls = emitIris(
      base({
        tables: { DemoSex: { M: "1" } },
        blocks: [{ id: "PID", rows: [{ target: "PID-8", from: lookup("DemoSex", "PID-8", blank()) }] }],
      }),
    );
    const guard = cdata(cls).find((c) => c.includes("Lookup"))!;
    expect(guard).toContain(`source.GetValueAt("PID:8")`);
    expect(guard).not.toMatch(BRACED);
  });

  test("a pickRepeat scan", () => {
    const cls = emitIris(
      base({
        blocks: [
          { id: "PV1", rows: [{ target: "PV1-7", from: pickRepeat("PV1-7", 13, "NPI", [1, 2, 3]) }] },
        ],
      }),
    );
    const scan = cdata(cls).find((c) => c.includes("for "))!;
    expect(scan).toContain("GetValueAt");
    expect(scan).not.toMatch(BRACED);
  });

  test("a fromFirst scan", () => {
    const cls = emitIris(
      base({
        blocks: [{ id: "NK1", rows: [{ target: "NK1-2", from: fromFirst("NK1", "NK1-2", "NK1-2.1") }] }],
      }),
    );
    const scan = cdata(cls).find((c) => c.includes("for "))!;
    expect(scan).toContain(`source.GetValueAt("NK1(*)")`);
    expect(scan).toContain(`source.GetValueAt("NK1("_ip1_"):2")`);
    expect(scan).not.toMatch(BRACED);
  });

  test("a trace, which touches every assigned field", () => {
    const cls = emitIris(
      base({
        iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3.1:ADT_A01", log: "trace" },
        blocks: [{ id: "PID", rows: [{ target: "PID-3", from: copy("PID-3") }] }],
      }),
    );
    const trace = cdata(cls).find((c) => c.includes("TRACE"))!;
    expect(trace).toContain(`target.GetValueAt("PID:3")`);
    expect(trace).not.toMatch(BRACED);
  });

  test("the sweep: no CDATA body anywhere carries a brace", () => {
    // A spec that exercises every code-emitting path at once, including inside
    // a repeat, where the paths carry a loop variable and are the easiest to
    // get wrong.
    const cls = emitIris(
      base({
        iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3.1:ADT_A01", log: "trace" },
        tables: { DemoSex: { M: "1" } },
        blocks: [
          { id: "MSH", rows: [{ target: "MSH-10", from: copy("MSH-10"), required: true }] },
          { id: "PID", rows: [{ target: "PID-8", from: lookup("DemoSex", "PID-8", blank()) }] },
          {
            id: "NK1",
            repeat: { over: "NK1", skipWhenEmpty: "NK1-2", max: 3 },
            rows: [
              { target: "NK1-2", from: copy("NK1-2"), required: true },
              { target: "NK1-3", from: pickRepeat("NK1-3", 1, "SPO") },
            ],
          },
          {
            id: "IN1",
            group: "INSURANCEgrp",
            repeat: { over: "IN1" },
            rows: [{ target: "IN1-2", from: copy("IN1-2"), required: true }],
          },
        ],
      }),
    );

    for (const body of cdata(cls)) expect(body).not.toMatch(BRACED);
    expect(cdata(cls).length).toBeGreaterThan(6);
  });
});

describe("loop occurrence numbers come out of the string", () => {
  test("a variable is concatenated, a star and a digit stay inside", () => {
    // "NK1("_k1_"):2" reads the repetition k1 is on. "NK1(k1):2" reads a
    // repetition named k1, finds nothing, and says nothing about it.
    const cls = emitIris(
      base({
        blocks: [
          {
            id: "NK1",
            repeat: { over: "NK1" },
            rows: [{ target: "NK1-2", from: copy("NK1-2"), required: true }],
          },
        ],
      }),
    );
    const guard = cdata(cls).find((c) => c.includes("LOGWARNING"))!;
    expect(guard).toContain(`target.GetValueAt("NK1("_n1_"):2")`);
  });

  test("a group prefix survives the conversion", () => {
    const cls = emitIris(
      base({
        blocks: [
          {
            id: "IN1",
            group: "INSURANCEgrp",
            repeat: { over: "IN1" },
            rows: [{ target: "IN1-2", from: copy("IN1-2"), required: true }],
          },
        ],
      }),
    );
    const guard = cdata(cls).find((c) => c.includes("LOGWARNING"))!;
    expect(guard).toContain(`target.GetValueAt("INSURANCEgrp("_n1_").IN1:2")`);
  });
});

describe("the macros survive", () => {
  test("LOGWARNING keeps all three dollars", () => {
    // $$$X is an ObjectScript macro. $$X is a call to an external routine, and
    // it compiles into a class that fails at run time instead of at build.
    // Worth a test because a stray String.replace() in the backend eats one.
    const cls = emitIris(
      base({ blocks: [{ id: "MSH", rows: [{ target: "MSH-10", from: copy("MSH-10"), required: true }] }] }),
    );
    expect(cls).toContain("$$$LOGWARNING(");
    expect(cls).not.toMatch(/[^$]\$\$LOGWARNING/);
  });

  test("Include Ensemble is there, because the macros need it", () => {
    const cls = emitIris(
      base({ blocks: [{ id: "MSH", rows: [{ target: "MSH-10", from: copy("MSH-10"), required: true }] }] }),
    );
    expect(cls.split("\n")[0]).toBe("Include Ensemble");
  });

  test("and it is left out when the class logs nothing", () => {
    const cls = emitIris(
      base({
        iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3.1:ADT_A01", log: "off" },
        blocks: [{ id: "MSH", rows: [{ target: "MSH-10", from: literal("X") }] }],
      }),
    );
    expect(cls).not.toContain("Include Ensemble");
  });
});

describe("a group on a block that does not repeat", () => {
  // The group prefix used to be applied only inside emitRepeat, so a segment
  // that sits in a group but appears once -- IN1 in IRIS's 2.3 ADT_A01, which
  // names the group IN1group -- emitted a bare {IN1:2}. That write lands
  // nowhere and IRIS does not say so, which is the exact failure the class
  // header tells you to go check the schema browser for.

  test("the group prefixes the target and the source", () => {
    const cls = emitIris(
      base({
        blocks: [{ id: "IN1", group: "IN1group", rows: [{ target: "IN1-2", from: copy("IN1-2") }] }],
      }),
    );
    expect(cls).toContain(
      `<assign value='source.{IN1group(1).IN1:2}' property='target.{IN1group(1).IN1:2}' action='set' />`,
    );
    expect(cls).not.toContain(`property='target.{IN1:2}'`);
  });

  test("two blocks in the same group land in the same occurrence", () => {
    // IN1 and IN2 are one bundle. Splitting them across group occurrences
    // would give the receiver an IN2 belonging to no coverage.
    const cls = emitIris(
      base({
        blocks: [
          { id: "IN1", group: "IN1group", rows: [{ target: "IN1-2", from: copy("IN1-2") }] },
          { id: "IN2", group: "IN1group", rows: [{ target: "IN2-1", from: copy("IN2-1") }] },
        ],
      }),
    );
    expect(cls).toContain(`property='target.{IN1group(1).IN1:2}'`);
    expect(cls).toContain(`property='target.{IN1group(1).IN2:1}'`);
  });

  test("the guard in a code body gets the prefix too", () => {
    const cls = emitIris(
      base({
        blocks: [
          { id: "IN1", group: "IN1group", rows: [{ target: "IN1-2", from: copy("IN1-2"), required: true }] },
        ],
      }),
    );
    const guard = cdata(cls).find((c) => c.includes("LOGWARNING"))!;
    expect(guard).toContain(`target.GetValueAt("IN1group(1).IN1:2")`);
    expect(guard).not.toMatch(BRACED);
  });

  test("no group means no prefix, which is every other block", () => {
    const cls = emitIris(base({ blocks: [{ id: "PID", rows: [{ target: "PID-3", from: copy("PID-3") }] }] }));
    expect(cls).toContain(`property='target.{PID:3}'`);
  });
});

describe("the lookup table header lists what the class calls", () => {
  test("a declared but uncalled table is not listed", () => {
    const cls = emitIris(
      base({
        tables: { Unused: {} },
        blocks: [{ id: "PID", rows: [{ target: "PID-3", from: copy("PID-3") }] }],
      }),
    );
    expect(cls).not.toContain("Unused");
    expect(cls).not.toContain("EMPTY IN THE SPEC");
  });

  test("a called table is listed, and flagged when it has no rows", () => {
    const cls = emitIris(
      base({
        tables: { Sex: { M: "1" }, Dept: {} },
        blocks: [
          { id: "PID", rows: [{ target: "PID-8", from: lookup("Sex", "PID-8", blank()) }] },
          { id: "PV1", rows: [{ target: "PV1-3", from: lookup("Dept", "PV1-3", blank()) }] },
        ],
      }),
    );
    expect(cls).toContain("Lookup tables this class calls");
    expect(cls).toContain("///   Sex");
    expect(cls).toContain("///   Dept   *** EMPTY IN THE SPEC");
  });
});

describe("attributes still use the curly form", () => {
  test("an assign reads {PID:3}, not GetValueAt", () => {
    // The conversion is scoped to code bodies. An attribute that lost its
    // braces would stop resolving and fail closed, which is the failure this
    // whole file exists to keep out of Studio.
    const cls = emitIris(base({ blocks: [{ id: "PID", rows: [{ target: "PID-3", from: copy("PID-3") }] }] }));
    expect(cls).toContain(`<assign value='source.{PID:3}' property='target.{PID:3}' action='set' />`);
  });
});
