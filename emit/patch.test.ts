// bun test
//
// The clone-and-patch backend. Two things matter and both are tested here:
// that the class is in the shape an IRIS team writes by hand (the reason the
// backend exists), and that validate() refuses every spec whose patch rendering
// would deliver a different message from the bench (the reason it can be
// trusted). Whether the ENGINE delivers what the bench delivers is not a unit
// test -- that was measured on IRIS for Health 2026.1 against ten messages,
// byte for byte, and is the job of the golden gate for any given spec.

import { expect, test, describe } from "bun:test";

import { emitProcess } from "./process";
import {
  validate, patchProblems, literal, event, copy, prefix, type Spec, type Block,
} from "../spec";

const msh: Block = {
  id: "MSH",
  wholeSegment: true,
  rows: [
    { target: "MSH-5", from: literal("RECEIVER") },
    { target: "MSH-9", from: event(), via: [prefix("ADT^")] },
  ],
};

const spec = (blocks: Block[], extra: Partial<Spec["iris"]> = {}): Spec => ({
  name: "Patch Test",
  gate: { path: "MSH-9.2", permit: { A01: "A28", A08: "A31", A04: "A04" } },
  iris: {
    className: "Patch.Test.Dtl",
    sourceDocType: "2.3:ADT_A01",
    targetDocType: "2.3:ADT_A01",
    alwaysPresent: ["PID", "EVN"],
    process: { className: "Patch.Test.Process", sendTo: "ToTarget.ADT.TCP", transform: "patch" },
    ...extra,
  },
  blocks,
});

const passthrough = spec([
  msh,
  { id: "EVN", wholeSegment: true, rows: [{ target: "EVN-1", from: event() }] },
  { id: "PID", wholeSegment: true, rows: [{ target: "PID-19", from: literal("") }] },
  { id: "NK1", wholeSegment: true, repeat: { over: "NK1", skipWhenEmpty: "NK1-2" }, rows: [] },
  { id: "PV1", wholeSegment: true, rows: [] },
  { id: "PV2", wholeSegment: true, rows: [{ target: "PV2-3", from: literal("X") }] },
  { id: "GT1", wholeSegment: true, repeat: { over: "GT1" }, rows: [{ target: "GT1-12", from: literal("") }] },
  { id: "IN1", group: "IN1grp", wholeSegment: true, repeat: { over: "IN1" }, rows: [] },
]);

const cls = emitProcess(passthrough);

describe("the shape an IRIS team writes", () => {
  test("clones the request instead of building a message", () => {
    expect(cls).toContain("Set tRequest = pRequest.%ConstructClone()");
    expect(cls).not.toContain("EnsLib.HL7.Message).%New()");
    expect(cls).not.toContain("tSeed");
  });

  test("OnRequest is try, Mapping, send", () => {
    expect(cls).toContain("$$$ThrowOnError(..Mapping(pRequest,.tRequest,tEvent))");
    expect(cls).toContain(`$$$ThrowOnError(..SendRequestAsync("ToTarget.ADT.TCP",tRequest,0))`);
    expect(cls).toContain("Set tSC = e.AsStatus()");
  });

  test("the class is persistent with a Storage block and no Include", () => {
    expect(cls).toContain("Extends Ens.BusinessProcess [ ClassType = persistent ]");
    expect(cls).toContain("<Type>%Storage.Persistent</Type>");
    expect(cls).not.toContain("Include Ensemble");
    expect(cls).not.toContain("ProcedureBlock");
  });

  test("writes go through $$$ThrowOnError", () => {
    expect(cls).toContain(`$$$ThrowOnError(tRequest.SetValueAt("RECEIVER","MSH:5"))`);
    expect(cls).not.toContain("tWriteSC");
  });

  test("there is no guarded-read helper, because a bare read of an absent segment is empty", () => {
    expect(cls).not.toContain("ValueAt(tSource");
    expect(cls).not.toContain("ClassMethod ValueAt");
  });

  test("the permit table is mapped once, with no silent default", () => {
    expect(cls).toContain(`Set tEvent = $CASE(pRequest.GetValueAt("MSH:9.2"),"A01":"A28","A08":"A31","A04":"A04",:"")`);
    expect(cls).not.toContain(`1:""`);
    expect(cls).toContain(`$$$ThrowOnError(tRequest.SetValueAt("ADT^"_pEvent,"MSH:9"))`);
    expect(cls).toContain(`$$$ThrowOnError(tRequest.SetValueAt(pEvent,"EVN:1"))`);
  });

  test("an unhandled event is filtered out with a trace, not failed", () => {
    expect(cls).toContain(`$$$TRACE("Message Filtered Out: MSH-9.2 is "_pRequest.GetValueAt("MSH:9.2"))`);
    expect(cls).toContain("Return tSC");
  });

  test("reads come off the request, never off the clone being patched", () => {
    const mapping = cls.slice(cls.indexOf("Method Mapping"));
    expect(mapping).not.toMatch(/tRequest\.GetValueAt\("NK1\(/);
    expect(mapping).toContain(`pRequest.GetValueAt("NK1("_k2_"):2")`);
  });
});

describe("segments", () => {
  test("an optional segment's rows sit behind a presence test, so a patch cannot create it", () => {
    expect(cls).toContain(`If (pRequest.GetValueAt("PV2") '= "") {`);
  });

  test("MSH and the alwaysPresent segments are patched without one", () => {
    expect(cls).not.toContain(`GetValueAt("PID") '= ""`);
    expect(cls).not.toContain(`GetValueAt("EVN") '= ""`);
    expect(cls).not.toContain(`GetValueAt("MSH") '= ""`);
  });

  test("a skipped occurrence is removed walking backwards", () => {
    expect(cls).toContain(`For k2=pRequest.GetValueAt("NK1(*)"):-1:1 {`);
    expect(cls).toContain(`$$$ThrowOnError(tRequest.RemoveSegmentAt("NK1("_k2_")"))`);
  });

  test("a repeat's rows patch every occurrence by one index", () => {
    expect(cls).toContain(`For k1=1:1:pRequest.GetValueAt("GT1(*)") {`);
    expect(cls).toContain(`$$$ThrowOnError(tRequest.SetValueAt("","GT1("_k1_"):12"))`);
  });

  test("every segment no block names is removed in one pass, bound tested at the top", () => {
    expect(cls).toContain("While (segCount <= tRequest.SegCount) {");
    expect(cls).toContain(`##class(Ens.Util.FunctionSet).In(tRequest.GetSegmentAt(segCount).Name,"EVN,PID,NK1,PV1,PV2,GT1,IN1")`);
  });

  test("the removal pass comes after every patch, so indexes still line up", () => {
    expect(cls.indexOf("GT1(\"_k1_\"):12")).toBeLessThan(cls.indexOf("While (segCount"));
    expect(cls.indexOf("RemoveSegmentAt(\"NK1(")).toBeGreaterThan(cls.indexOf("GT1(\"_k1_\"):12"));
  });

  test("the spec's own note becomes the comment", () => {
    const noted = spec([{ ...msh, note: "Routing identity is rewritten" }]);
    expect(emitProcess(noted)).toContain("//Routing identity is rewritten");
  });

  test("comments off leaves the two header lines and nothing else", () => {
    const quiet = emitProcess(spec(passthrough.blocks, { comments: "off" }));
    expect(quiet.match(/^\s+\/\//gm)).toBeNull();
    expect(quiet.match(/^\/\/\//gm)?.length).toBe(2);
  });
});

describe("validate refuses what a patch cannot say", () => {
  const says = (s: Spec, what: string) => expect(validate(s).join("\n")).toContain(what);

  test("the reference passthrough is accepted", () => {
    expect(validate(passthrough)).toEqual([]);
  });

  test("a block that enumerates fields", () => {
    says(spec([msh, { id: "PID", rows: [{ target: "PID-3", from: copy("PID-3") }] }]), "has to be wholeSegment");
  });

  test("a DocType conversion", () => {
    says(spec([msh], { targetDocType: "2.5:ADT_A01" }), "clones the request, so the target keeps the source DocType");
  });

  test("no seeded MSH", () => {
    says(spec([{ id: "PID", wholeSegment: true, rows: [] }]), "needs an MSH block with wholeSegment");
  });

  test("two blocks for one segment", () => {
    says(spec([msh, { id: "PID", wholeSegment: true, rows: [] }, { id: "PID", wholeSegment: true, rows: [] }]), "more than one block");
  });

  test("select, fold and max on a repeat", () => {
    const r = spec([msh, { id: "NK1", wholeSegment: true, repeat: { over: "NK1", max: 1 }, rows: [] }]);
    says(r, "repeat.max is not a patch");
  });

  test("counter() beside skipWhenEmpty", () => {
    says(
      spec([msh, {
        id: "NK1", wholeSegment: true, repeat: { over: "NK1", skipWhenEmpty: "NK1-2" },
        rows: [{ target: "NK1-1", from: { kind: "counter" } }],
      }]),
      "counter() beside skipWhenEmpty",
    );
  });

  test("every refusal points at the backend that can say it", () => {
    const bad = spec([msh, { id: "PID", rows: [{ target: "PID-3", from: copy("PID-3") }] }]);
    for (const p of patchProblems(bad).filter((p) => !p.startsWith("transform \"patch\" always"))) {
      expect(p).toContain(`"inline"`);
    }
  });

  test("a patch spec is not refused for being patch", () => {
    expect(validate(passthrough).join("\n")).not.toContain("not a place the mapping can live");
  });
});
