// bun test
//
// The promotion checklist and the MSH-11 guard. A promoted class is identical
// in every namespace, so a constant processing id is the same constant in DEV
// and PROD. A shipped interface fell back to "P" everywhere; the rule adopted
// was copy from the source, never default, and log it when empty.

import { expect, test, describe } from "bun:test";

import { emitPromote, processingId } from "./emit/promote";
import { copy, defaultTo, literal, type Row, type Spec } from "./spec";

const base = (mshRows: Row[] = [], extra: Partial<Spec["iris"]> = {}): Spec => ({
  name: "Promote Test",
  gate: { path: "MSH-9.2", permit: { A01: "A28" } },
  iris: {
    className: "Promote.Test.Dtl",
    sourceDocType: "2.3:ADT_A01",
    targetDocType: "2.3:ADT_A01",
    ...extra,
  },
  blocks: [
    ...(mshRows.length ? [{ id: "MSH", rows: mshRows }] : []),
    { id: "PID", rows: [{ target: "PID-3", from: copy("PID-3") }] },
  ],
});

describe("processingId", () => {
  test("copied and required is the rule, so no hazard", () => {
    const p = processingId(base([{ target: "MSH-11", from: copy("MSH-11"), required: true }]));
    expect(p.how).toBe("copied from MSH-11, required, so an empty one is logged");
    expect(p.hazard).toBeUndefined();
  });

  test("copied but not required goes out empty unlogged", () => {
    expect(processingId(base([{ target: "MSH-11", from: copy("MSH-11") }])).hazard).toContain("not required");
  });

  test("a literal is the same in every namespace", () => {
    expect(processingId(base([{ target: "MSH-11", from: literal("P") }])).hazard).toContain(`literal "P"`);
  });

  // The shipped defect.
  test("a fallback is the same in every namespace", () => {
    const row: Row = { target: "MSH-11", from: copy("MSH-11"), via: [defaultTo("P")] };
    const p = processingId(base([row]));
    expect(p.how).toBe(`copy, falling back to "P"`);
    expect(p.hazard).toContain(`falls back to "P"`);
  });

  test("a stamp is the same in every namespace", () => {
    const spec = base([], {
      process: { className: "P.X", sendTo: "T", stamp: [{ path: "MSH-11", value: "P", why: "x" }] },
    });
    expect(processingId(spec).hazard).toContain(`stamped "P"`);
  });

  test("never written, on a target built new, goes out with none", () => {
    expect(processingId(base()).how).toBe("never written");
  });

  test("seeded with the segment copies it, but nothing logs an empty one", () => {
    const p = processingId(base([], { create: "copy" }));
    expect(p.how).toBe("copied from the source with the MSH segment");
    expect(p.hazard).toContain("required: true");
  });
});

describe("emitPromote", () => {
  test("names the fingerprint and the DTL when nothing else calls a mapping", () => {
    const md = emitPromote(base(), "abc123");
    expect(md).toContain("Spec fingerprint `abc123`");
    expect(md).toContain("- [ ] Compile `Promote.Test.Dtl` (`bun emit.ts`)");
  });

  // Inline and patch carry the mapping; compiling the DTL there is a stray class.
  test("an inline process does not list the DTL", () => {
    const md = emitPromote(base([], { process: { className: "P.X", sendTo: "ToT", transform: "inline" } }), "f");
    expect(md).not.toContain("Promote.Test.Dtl");
    expect(md).toContain(`Compile \`P.X\` (\`bun emit.ts process\`): dispatches to "ToT"`);
  });

  test("tables are listed, and an empty one is called out", () => {
    const spec = { ...base(), tables: { Full: { A: "1" }, Empty: {} } };
    const md = emitPromote(spec, "f");
    expect(md).toContain("Import lookup tables `Full`, `Empty`");
    expect(md).toContain("**Empty is empty in the spec.**");
  });

  test("a gate table gets its order", () => {
    const spec: Spec = {
      ...base(),
      gate: { path: "MSH-9.2", permit: { A01: "A28" }, require: [{ path: "MSH-6.1", inTable: "Fac" }] },
      tables: { Fac: { RGH: "RGH" } },
    };
    expect(emitPromote(spec, "f")).toContain("The gate reads `Fac`. Import it first, then change the filter.");
  });

  test("the site's filter wrapper is applied", () => {
    expect(emitPromote(base(), "f", "eval = {expr}")).toContain("`eval = (pRequest.GetValueAt(");
  });

  test("a long external schema note is cut to its first sentence", () => {
    const spec = base([], { externalSchemas: [{ category: "Ext", note: "Owned elsewhere. " + "x".repeat(500) }] });
    expect(emitPromote(spec, "f")).toContain("- [ ] Confirm schema category `Ext` already exists here. Owned elsewhere.\n");
  });

  test("the processing id section carries the hazard", () => {
    expect(emitPromote(base([{ target: "MSH-11", from: literal("P") }]), "f")).toContain(`**MSH-11 is the literal "P"`);
  });
});
