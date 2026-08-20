// bun test
//
// A lookup document that imports cleanly and carries the wrong rows is the
// failure this artifact exists to prevent, so most of what is checked here is
// refusal rather than output: an empty key, a control character, a table that
// is not in the spec. The one thing that is warned about rather than refused is
// an empty VALUE, and the test says why.

import { expect, test, describe } from "bun:test";

import { buildLookup } from "./lookup";
import { type Spec } from "../spec";

const base = (tables: Spec["tables"]): Spec => ({
  name: "Lookup Emit Test",
  gate: { path: "MSH-9.2", permit: { A01: "A01" } },
  iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3:ADT_A01" },
  tables,
  blocks: [],
});

describe("document shape", () => {
  test("an XML declaration, a lookupTable root, one entry per row", () => {
    const { xml } = buildLookup(base({ Sex: { M: "MALE", F: "FEMALE" } }));
    expect(xml).toStartWith(`<?xml version="1.0" encoding="UTF-8"?>`);
    expect(xml).toContain(`<lookupTable>`);
    expect(xml).toContain(`<entry table="Sex" key="M">MALE</entry>`);
    expect(xml).toContain(`<entry table="Sex" key="F">FEMALE</entry>`);
    expect(xml.trimEnd()).toEndWith(`</lookupTable>`);
  });

  test("row order follows the spec, so a diff against the last export reads", () => {
    const { xml } = buildLookup(base({ T: { a: "1", b: "2", c: "3" } }));
    expect(xml.indexOf(`key="a"`)).toBeLessThan(xml.indexOf(`key="b"`));
    expect(xml.indexOf(`key="b"`)).toBeLessThan(xml.indexOf(`key="c"`));
  });

  test("every table in one document, which is one import instead of five", () => {
    const { xml, counts } = buildLookup(base({ A: { x: "1" }, B: { y: "2" } }));
    expect(xml).toContain(`table="A"`);
    expect(xml).toContain(`table="B"`);
    expect(counts).toEqual({ A: 1, B: 1 });
  });

  test("a spec with no tables still produces a well formed empty document", () => {
    const { xml, counts } = buildLookup(base(undefined));
    expect(xml).toContain(`<lookupTable>`);
    expect(counts).toEqual({});
  });
});

describe("escaping", () => {
  // These are not hypothetical. Facility and department names carry
  // apostrophes and ampersands, and one unescaped character rejects the whole
  // document with an error about a line number.
  test("ampersands and angle brackets in a value", () => {
    const { xml } = buildLookup(base({ T: { k: "A & B <ok>" } }));
    expect(xml).toContain(`>A &amp; B &lt;ok&gt;<`);
  });

  test("an apostrophe in a value, which is what a hospital name looks like", () => {
    const { xml } = buildLookup(base({ T: { MSM: "MOUNT ST. MARY'S" } }));
    expect(xml).toContain(`MOUNT ST. MARY&apos;S`);
    expect(xml).not.toContain(`MARY'S`);
  });

  test("a quote in a KEY cannot close the attribute early", () => {
    const { xml } = buildLookup(base({ T: { 'a"b': "v" } }));
    expect(xml).toContain(`key="a&quot;b"`);
  });

  test("the table name is escaped too", () => {
    const { xml } = buildLookup(base({ "A&B": { k: "v" } }));
    expect(xml).toContain(`table="A&amp;B"`);
  });
});

describe("refusals", () => {
  test("an empty key is fatal and the row is not written", () => {
    const { xml, problems, counts } = buildLookup(base({ T: { "": "v", k: "w" } }));
    const fatal = problems.filter((p) => p.fatal);
    expect(fatal).toHaveLength(1);
    expect(fatal[0].problem).toContain("empty key");
    expect(counts.T).toBe(1);
    expect(xml).not.toContain(`key=""`);
  });

  test("a control character is fatal, because the import blames the file", () => {
    const { problems, counts } = buildLookup(base({ T: { k: `a${String.fromCharCode(7)}b` } }));
    const fatal = problems.filter((p) => p.fatal);
    expect(fatal).toHaveLength(1);
    expect(fatal[0].problem).toContain("control character");
    expect(counts.T).toBe(0);
  });

  test("tab, newline and carriage return are legal XML and pass", () => {
    const { problems, counts } = buildLookup(base({ T: { k: "a\tb\nc\rd" } }));
    expect(problems.filter((p) => p.fatal)).toHaveLength(0);
    expect(counts.T).toBe(1);
  });

  test("naming a table the spec does not have lists the ones it does", () => {
    expect(() => buildLookup(base({ Sex: { M: "MALE" } }), "Nope")).toThrow(/This spec has: Sex/);
  });

  test("naming a table when there are none says so plainly", () => {
    expect(() => buildLookup(base({}), "Nope")).toThrow(/no tables at all/);
  });
});

describe("empty values", () => {
  // Warned, not refused. `Lookup` returns your default for a blank value
  // exactly as it does for a key that is not there, so the row is
  // indistinguishable from its own absence. Sometimes intended, always worth
  // saying out loud, and in an allowlist it is a permitted code being refused.
  test("an empty value warns and is still written", () => {
    const { xml, problems, counts } = buildLookup(base({ T: { k: "" } }));
    expect(problems).toHaveLength(1);
    expect(problems[0].fatal).toBe(false);
    expect(problems[0].problem).toContain("empty value");
    expect(xml).toContain(`key="k"></entry>`);
    expect(counts.T).toBe(1);
  });
});

describe("selecting one table", () => {
  test("--table writes only that one", () => {
    const { xml, counts } = buildLookup(base({ A: { x: "1" }, B: { y: "2" } }), "A");
    expect(xml).toContain(`table="A"`);
    expect(xml).not.toContain(`table="B"`);
    expect(counts).toEqual({ A: 1 });
  });
});
