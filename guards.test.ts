// bun test
//
// ObjectScript has no operator precedence. `$LENGTH(x)>0 && n<3` evaluates as
// `(($LENGTH(x)>0)&&n)<3`: 1 for an empty x and 1 for n=5. So a repeat with
// both a skip and a cap ignored both in IRIS while the bench honoured them.
// Measured on IRIS for Health 2026-10-02: the demo DTL delivered all five NK1,
// the empty one included; parenthesised, it delivered the same three the bench
// does. These pin the parentheses, since nothing else would notice them go.

import { expect, test, describe } from "bun:test";

import { emitIris } from "./emit/iris";
import { emitProcess } from "./emit/process";
import { copy, type Spec } from "./spec";

const spec = (transform?: "inline"): Spec => ({
  name: "Guard Test",
  gate: { path: "MSH-9.2", permit: { A01: "A28" } },
  iris: {
    className: "Guard.Test.Dtl",
    sourceDocType: "2.5:ADT_A01",
    targetDocType: "2.5:ADT_A01",
    ...(transform ? { process: { className: "Guard.Test.Process", sendTo: "ToT", transform } } : {}),
  },
  blocks: [
    { id: "NK1", repeat: { over: "NK1", skipWhenEmpty: "NK1-2", max: 3 }, rows: [{ target: "NK1-2", from: copy("NK1-2") }] },
  ],
});

describe("repeat guards are parenthesised", () => {
  test("in the DTL", () => {
    expect(emitIris(spec())).toContain(
      `<if condition='($LENGTH(source.{NK1(k1):2})&gt;0) &amp;&amp; (n1&lt;3)' >`,
    );
  });

  test("in an inline process", () => {
    const cls = emitProcess(spec("inline"));
    expect(cls).toMatch(/if \(\$LENGTH\(.*NK1.*\)>0\) && \(n\d+<3\) \{/);
  });

  test("no guard is joined bare in either", () => {
    for (const text of [emitIris(spec()), emitProcess(spec("inline"))]) {
      expect(text).not.toMatch(/>0 (&&|&amp;&amp;) n\d+/);
    }
  });
});
