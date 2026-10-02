// bun test
//
// A gate on membership in a lookup table, and the filter expression a router
// stores as a string. Both came out of one go-live: a facility allowlist gated
// in a router filter typed by hand, where one missing ")" passed the SQL that
// stored it and failed only on the host. The bench now builds that string from
// the same gate it runs, and checks it before printing it.

import { expect, test, describe } from "bun:test";

import { Message } from "./hl7";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { explainGate, gate, nearKeys } from "./run";
import { splitMessages } from "./gate";
import { specToSource } from "./serialize";
import { checkExpression, emitIris, filterExpression, routingCondition } from "./emit/iris";
import { emitProcess } from "./emit/process";
import { filterCondition } from "./emit/bridgelink";
import { trace } from "./trace";
import { resolveStyle } from "./style";
import { copy, describeRequire, gateTables, validate, type GateRequire, type Spec } from "./spec";

const base = (require: GateRequire[], permit: Record<string, string> = { A01: "A28" }): Spec => ({
  name: "Gate Table Test",
  gate: { path: "MSH-9.2", permit, require },
  tables: { "Dept.ADT.Facility": { RGH: "RGH", HGH: "" }, Other: {} },
  iris: {
    className: "Gate.Test.Dtl",
    sourceDocType: "2.3:ADT_A01",
    targetDocType: "2.3:ADT_A01",
    process: { className: "Gate.Test.Process", sendTo: "ToTarget.ADT.TCP", transform: "inline" },
  },
  blocks: [{ id: "PID", rows: [{ target: "PID-3", from: copy("PID-3") }] }],
});

const facility = { path: "MSH-6.1", inTable: "Dept.ADT.Facility" } as const;

const msg = (fac: string, event = "A01") =>
  new Message(`MSH|^~\\&|APP|SRC|RCV|${fac}|20261002120000||ADT^${event}|1|P|2.3\rPID|1||MRN1\r`);

describe("the spec", () => {
  test("a table requirement is valid when the table is declared", () => {
    expect(validate(base([facility]))).toEqual([]);
  });

  test("an undeclared table is refused, because it refuses every message", () => {
    const problems = validate(base([{ path: "MSH-6.1", inTable: "Missing" }]));
    expect(problems.join("\n")).toContain(`inTable names "Missing"`);
  });

  test("equals and inTable together are refused", () => {
    const both = { path: "MSH-6.1", equals: "X", inTable: "Dept.ADT.Facility" } as unknown as GateRequire;
    expect(validate(base([both])).join("\n")).toContain("exactly one of equals or inTable");
  });

  test("neither is refused", () => {
    const neither = { path: "MSH-6.1" } as unknown as GateRequire;
    expect(validate(base([neither])).join("\n")).toContain("exactly one of equals or inTable");
  });

  test("gate tables are listed once, in order", () => {
    const spec = base([facility, { path: "PV1-3.4", inTable: "Other" }, facility]);
    expect(gateTables(spec)).toEqual(["Dept.ADT.Facility", "Other"]);
  });

  test("the condition reads as words", () => {
    expect(describeRequire(facility)).toBe("MSH-6.1 must be a key in table Dept.ADT.Facility");
    expect(describeRequire({ path: "MSH-9.1", equals: "ADT" })).toBe(`MSH-9.1 must be "ADT"`);
  });
});

describe("the bench runs it", () => {
  const spec = base([facility]);

  test("a listed code passes", () => {
    expect(gate(spec, msg("RGH")).event).toBe("A28");
  });

  test("an unlisted code is refused, and the refusal names the table", () => {
    expect(() => gate(spec, msg("XYZ"))).toThrow(`MSH-6.1 is "XYZ", which is not a key in table Dept.ADT.Facility`);
  });

  // Exists tests the key, not the value. A blank value still admits its code.
  test("a row with a blank value still admits its code", () => {
    expect(gate(spec, msg("HGH")).event).toBe("A28");
  });

  test("an inherited property name is not a key", () => {
    expect(() => gate(spec, msg("constructor"))).toThrow("not a key");
  });

  test("an empty field is refused", () => {
    expect(() => gate(spec, msg(""))).toThrow(`"(empty)"`);
  });
});

describe("what IRIS is given", () => {
  test("the routing rule uses Exists", () => {
    expect(routingCondition(base([facility]))).toBe(
      `Exists("Dept.ADT.Facility",HL7.{MSH:6.1}) && (HL7.{MSH:9.2}="A01")`,
    );
  });

  test("the process class refuses with Exists, not Lookup", () => {
    const cls = emitProcess(base([facility]));
    expect(cls).toContain(`'##class(Ens.Util.FunctionSet).Exists("Dept.ADT.Facility", `);
    expect(cls).toContain("is not a key in Dept.ADT.Facility, refusing");
    expect(cls).not.toContain("Lookup(\"Dept.ADT.Facility\"");
  });

  test("an empty gate table is on the class header's go-live list", () => {
    const spec = base([{ path: "MSH-6.1", inTable: "Other" }]);
    expect(emitIris(spec)).toContain("Other   *** EMPTY IN THE SPEC, a go-live gate ***");
  });
});

describe("the filter expression", () => {
  test("one trigger, one table: the shape that went live, built rather than typed", () => {
    expect(filterExpression(base([facility]))).toBe(
      `(##class(Ens.Util.FunctionSet).Exists("Dept.ADT.Facility",pRequest.GetValueAt("MSH:6.1"))) && ` +
        `(pRequest.GetValueAt("MSH:9.2")="A01")`,
    );
  });

  // ObjectScript reads left to right with no precedence, so every comparison
  // carries its own parens and the trigger arms are grouped.
  test("several triggers are grouped behind the &&", () => {
    const expr = filterExpression(base([{ path: "MSH-9.1", equals: "ADT" }], { A01: "A28", A08: "A31" }));
    expect(expr).toBe(
      `(pRequest.GetValueAt("MSH:9.1")="ADT") && ` +
        `((pRequest.GetValueAt("MSH:9.2")="A01") || (pRequest.GetValueAt("MSH:9.2")="A08"))`,
    );
  });

  test("no requirements is the trigger arms alone", () => {
    expect(filterExpression(base([]))).toBe(`(pRequest.GetValueAt("MSH:9.2")="A01")`);
  });

  test("a quote in a value is doubled and still balances", () => {
    expect(() => filterExpression(base([{ path: "PV1-3.4", equals: `O"BRIEN` }]))).not.toThrow();
  });
});

describe("checkExpression", () => {
  // The string that actually failed on the host, one ")" short.
  test("the missing paren from the go-live is caught", () => {
    const typed =
      `("SENDER"=pRequest.GetValueAt("1:3")) && ` +
      `(##class(Ens.Util.FunctionSet).Exists("Dept.ADT.Facility",pRequest.GetValueAt("1:6"))`;
    expect(() => checkExpression(typed)).toThrow(`1 "(" never closed`);
  });

  test("a stray close paren is caught where it is", () => {
    expect(() => checkExpression(`(a=1))`)).toThrow(`unbalanced ")" at character 6`);
  });

  test("an unclosed string is caught", () => {
    expect(() => checkExpression(`(a="x)`)).toThrow("never closes");
  });

  test("parens inside a string do not count, and a doubled quote is a quote", () => {
    expect(() => checkExpression(`(a="(""")`)).not.toThrow();
  });
});

describe("the rest of the bench keeps it", () => {
  test("a GUI save writes inTable, not equals", () => {
    const text = specToSource(base([facility]));
    expect(text).toContain(`{ path: "MSH-6.1", inTable: "Dept.ADT.Facility" },`);
    expect(text).not.toContain("equals: undefined");
  });

  test("the trace document states the membership", () => {
    expect(trace(base([facility]), msg("RGH"))).toContain("MSH-6.1 must be a key in table Dept.ADT.Facility");
  });

  test("a channel filter carries the keys inline", () => {
    expect(filterCondition(base([facility]))).toContain(`({'RGH': 1, 'HGH': 1}).hasOwnProperty(`);
  });
});

describe("a site's filter wrapper", () => {
  test("is read from the style file", () => {
    expect(resolveStyle({ filterWrap: "eval = {expr}" }).filterWrap).toBe("eval = {expr}");
  });

  test("without the placeholder it is refused", () => {
    expect(() => resolveStyle({ filterWrap: "eval = " })).toThrow("{expr}");
  });
});

// "Would this message get through", answered on the laptop.
describe("explainGate", () => {
  const spec = base([facility, { path: "MSH-9.1", equals: "ADT" }], { A01: "A28", A08: "A31" });

  test("a permitted message passes every clause", () => {
    const v = explainGate(spec, msg("RGH"));
    expect(v.permit).toBe(true);
    expect(v.event).toBe("A28");
    expect(v.clauses.map((c) => c.ok)).toEqual([true, true, true]);
  });

  test("every clause is evaluated, not just the first that fails", () => {
    const v = explainGate(spec, msg("XYZ", "A03"));
    expect(v.permit).toBe(false);
    expect(v.clauses.map((c) => [c.kind, c.ok])).toEqual([
      ["trigger", false], ["inTable", false], ["equals", true],
    ]);
  });

  test("gate() still throws the first refusal, worded as before", () => {
    expect(() => gate(spec, msg("XYZ", "A03"))).toThrow(
      `MSH-9.2 is "A03", which this interface does not handle (handles: A01, A08)`,
    );
  });

  test("a trigger that is an inherited property name is not permitted", () => {
    expect(explainGate(spec, msg("RGH", "constructor")).clauses[0].ok).toBe(false);
  });
});

describe("near misses on a table", () => {
  const keys = ["RGH", "HGH", "UNITY", "MAIN-1"];

  test("case and space come first", () => {
    expect(nearKeys(keys, " rgh")).toEqual(["RGH", "HGH"]);
  });

  test("one character changed, dropped, added or swapped", () => {
    expect(nearKeys(keys, "RGX")).toEqual(["RGH"]);
    expect(nearKeys(keys, "UNIT")).toEqual(["UNITY"]);
    expect(nearKeys(keys, "MAIN-12")).toEqual(["MAIN-1"]);
    expect(nearKeys(keys, "RHG")).toEqual(["RGH"]);
  });

  test("nothing close is nothing", () => {
    expect(nearKeys(keys, "ZZZZ")).toEqual([]);
  });

  test("a one-character code is not near every other one-character code", () => {
    expect(nearKeys(["A", "B"], "C")).toEqual([]);
  });

  test("an empty field suggests nothing", () => {
    expect(nearKeys(keys, "")).toEqual([]);
  });

  test("the miss carries them, a pass does not", () => {
    const v = explainGate(base([facility]), msg("rgh"));
    expect(v.clauses[1].near).toEqual(["RGH", "HGH"]);
    expect(explainGate(base([facility]), msg("RGH")).clauses[1].near).toBeUndefined();
  });
});

// Run from a scratch folder: Bun loads .env from the working folder, and the
// repo's own .env would point these at a site spec.
describe("gate.ts", () => {
  test("a batch splits on MSH, whatever the line endings", () => {
    const raw = "MSH|a\r\nPID|1\r\n\r\nMSH|b\nPID|2\rMSH|c\r";
    expect(splitMessages(raw)).toEqual(["MSH|a\rPID|1", "MSH|b\rPID|2", "MSH|c"]);
  });

  test("permits the demo message and exits 0", () => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (k !== "HL7_BENCH_TRANSFORM" && v !== undefined) env[k] = v;
    const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "gate.ts"), join(import.meta.dir, "sample.hl7")], {
      cwd: tmpdir(), env, stdout: "pipe", stderr: "pipe",
    });
    expect(p.stdout.toString()).toContain("PERMIT");
    expect(p.exitCode).toBe(0);
  });

  test("refuses with every failing clause and exits 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "hl7-bench-gate-"));
    const file = join(dir, "x.hl7");
    writeFileSync(file, "MSH|^~\\&|A|B|C|D|20261002||ORU^R01|9|P|2.3\r");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (k !== "HL7_BENCH_TRANSFORM" && v !== undefined) env[k] = v;
    const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "gate.ts"), file], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
    expect(p.stdout.toString()).toContain("REFUSE");
    expect(p.stdout.toString()).toContain(`FAIL  MSH-9.2 is "R01"`);
    expect(p.exitCode).toBe(1);
  });
});
