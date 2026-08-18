import { expect, test, describe } from "bun:test";
import {
  emitDtl, dtlPath, copy, literal, firstOf, lookup, counter, raw, manual,
  blank, passthrough, constant, type DtlSpec,
} from "./dtl";

const base: DtlSpec = {
  className: "T.Case",
  sourceDocType: "2.3:ADT_A01",
  targetDocType: "2.3.1:ADT_A05",
  rows: [],
};

const emit = (spec: Partial<DtlSpec>) => emitDtl({ ...base, ...spec });

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

describe("sources", () => {
  test("literal quotes, copy does not", () => {
    const out = emit({ rows: [{ target: "MSH-3", from: literal("MEDITECH") }] });
    expect(out).toContain(`value='"MEDITECH"' property='target.{MSH:3}'`);
    expect(emit({ rows: [{ target: "MSH-7", from: copy("MSH-7") }] }))
      .toContain(`value='source.{MSH:7}'`);
  });

  test("a quote inside a literal is doubled, not escaped", () => {
    expect(emit({ rows: [{ target: "MSH-3", from: literal(`A"B`) }] }))
      .toContain(`value='"A""B"'`);
  });

  test("firstOf becomes a $SELECT with a final empty arm", () => {
    const out = emit({ rows: [{ target: "PID-3", from: firstOf("PID-4", "PID-3") }] });
    expect(out).toContain("$SELECT($LENGTH(source.{PID:4})&gt;0:source.{PID:4}");
    expect(out).toContain(`,1:""`);
  });

  test("each unmapped branch produces a different third argument", () => {
    const of = (u: any) => emit({ rows: [{ target: "PID-8", from: lookup("Sex", "PID-8", u) }] });
    expect(of(blank())).toContain(`..Lookup("Sex",source.{PID:8},"")`);
    expect(of(passthrough())).toContain(`..Lookup("Sex",source.{PID:8},source.{PID:8})`);
    expect(of(constant("U"))).toContain(`..Lookup("Sex",source.{PID:8},"U")`);
  });

  test("raw goes through untouched", () => {
    expect(emit({ rows: [{ target: "PID-19", from: raw("$TRANSLATE(source.{PID:19},$C(45))") }] }))
      .toContain("$TRANSLATE(source.{PID:19},$C(45))");
  });

  test("manual emits a TODO and no assign", () => {
    const out = emit({ rows: [{ target: "PID-19", from: manual("strip punctuation") }] });
    expect(out).toContain("TODO PID-19: strip punctuation");
    expect(out).not.toContain("target.{PID:19}' action='set'");
  });

  test("counter outside a loop is an error, not a wrong file", () => {
    expect(() => emit({ rows: [{ target: "IN1-1", from: counter() }] })).toThrow(/counter/);
  });
});

describe("XML escaping", () => {
  test("comparison operators are escaped in conditions and values", () => {
    const out = emit({
      rows: [{ target: "PID-3", from: firstOf("PID-4", "PID-3") }],
    });
    expect(out).toContain("&gt;0");
    expect(out).not.toContain("&amp;gt;"); // double escaping is the easy bug here
    expect(out).not.toMatch(/value='[^']*>/);
  });

  test("an ampersand in a note does not break the XML", () => {
    expect(emit({ rows: [{ target: "MSH-3", from: literal("X"), note: "A & B" }] }))
      .toContain("<!-- A &amp; B -->");
  });
});

describe("loops", () => {
  const loop = (over: any) => emit({ loops: [over] });

  test("grouped loop prefixes source with the key and target with the ordinal", () => {
    const out = loop({
      segment: "IN1", group: "INSURANCEgrp", skipWhenEmpty: "IN1-4", max: 3,
      rows: [{ target: "IN1-1", from: counter() }, { target: "IN1-2", from: copy("IN1-2") }],
    });
    expect(out).toContain(`<foreach property='source.{INSURANCEgrp()}' key='k1' >`);
    expect(out).toContain(`value='n1' property='target.{INSURANCEgrp(n1).IN1:1}'`);
    expect(out).toContain(`value='source.{INSURANCEgrp(k1).IN1:2}' property='target.{INSURANCEgrp(n1).IN1:2}'`);
  });

  test("ungrouped loop repeats on the segment itself", () => {
    const out = loop({ segment: "NK1", rows: [{ target: "NK1-2", from: copy("NK1-2") }] });
    expect(out).toContain(`<foreach property='source.{NK1()}' key='k1' >`);
    expect(out).toContain(`value='source.{NK1(k1):2}' property='target.{NK1(n1):2}'`);
    expect(out).not.toContain("NK1(k1).NK1");
  });

  test("the ordinal is reset before the loop and incremented inside the guard", () => {
    const out = loop({
      segment: "IN1", group: "INSURANCEgrp", skipWhenEmpty: "IN1-4",
      rows: [{ target: "IN1-1", from: counter() }],
    });
    expect(out.indexOf("set n1 = 0")).toBeLessThan(out.indexOf("<foreach"));
    expect(out.indexOf("<true>")).toBeLessThan(out.indexOf("set n1 = n1 + 1"));
  });

  test("no guard means no if wrapper", () => {
    const out = loop({ segment: "NK1", rows: [{ target: "NK1-2", from: copy("NK1-2") }] });
    expect(out).not.toContain("<if condition");
  });

  test("two loops get distinct key and ordinal variables", () => {
    const out = emit({
      loops: [
        { segment: "IN1", group: "INSURANCEgrp", rows: [{ target: "IN1-1", from: counter() }] },
        { segment: "NK1", rows: [{ target: "NK1-1", from: counter() }] },
      ],
    });
    expect(out).toContain("key='k1'");
    expect(out).toContain("key='k2'");
    expect(out).toContain("set n2 = 0");
  });
});

describe("the class shell", () => {
  test("create defaults to new, because the bench builds a fresh target", () => {
    expect(emit({})).toContain("create='new'");
    expect(emit({ create: "copy" })).toContain("create='copy'");
  });

  test("doctypes are written verbatim and the header says to check them", () => {
    const out = emit({});
    expect(out).toContain("sourceDocType='2.3:ADT_A01'");
    expect(out).toContain("targetDocType='2.3.1:ADT_A05'");
    expect(out).toContain("fails closed");
  });
});
