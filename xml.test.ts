/**
 * xml.test.ts -- the XML side: the reader, paths, records, the runner over
 * either format, the refusals, and the BridgeLink step for each direction.
 *
 * What the step DOES in an engine is bridgelink-check.ts against the three
 * conformance/*.ts XML specs: on BridgeLink 26.9.0 (2026-10-24) xml-to-xml 5/5,
 * hl7-to-xml 3/3, xml-to-hl7 3/3, with namespaces compared strictly.
 */

import { expect, test, describe } from "bun:test";
import {
  parseXml, printXml, canonicalXml, parseXmlPath, isXmlPath, underRecord,
  XmlMessage, XmlRecord, XmlBuilder, blankRecord,
} from "./xml";
import { runText, runSpec } from "./run";
import { Message } from "./hl7";
import {
  validate, copy, literal, pickRepeat, sourceFormat, targetFormat, inRecord,
  type Spec,
} from "./spec";
import { emitBridgelink, filterCondition } from "./emit/bridgelink";
import { emitChannel } from "./emit/channel";
import * as x2x from "./conformance/xml-to-xml";
import * as h2x from "./conformance/hl7-to-xml";
import * as x2h from "./conformance/xml-to-hl7";

// ---------------------------------------------------------------------------

describe("the reader", () => {
  test("declaration, comments, PIs and whitespace between elements are not content", () => {
    const el = parseXml(`<?xml version="1.0"?>\n<!-- c --><a>\n  <?pi x?>\n  <b>one</b>\n</a>`);
    expect(printXml(el)).toBe("<a>\n  <b>one</b>\n</a>");
  });

  test("entities and CDATA decode to text, and print back escaped", () => {
    const el = parseXml(`<a><b>x &amp; y &#65;&#x42;</b><c><![CDATA[<n> & m]]></c></a>`);
    expect(el.children("b")[0].text()).toBe("x & y AB");
    expect(el.children("c")[0].text()).toBe("<n> & m");
    expect(printXml(el)).toContain("<c>&lt;n&gt; &amp; m</c>");
  });

  test("a leading space in text survives: it is what marks a continuation", () => {
    expect(parseXml(`<a><b> more</b></a>`).children("b")[0].text()).toBe(" more");
  });

  test("namespaces are read as local names, declarations dropped", () => {
    const el = parseXml(`<ns:Order xmlns:ns="urn:x" xmlns="urn:d" ns:v="2"><ns:Id>1</ns:Id></ns:Order>`);
    expect(printXml(el)).toBe(`<Order v="2">\n  <Id>1</Id>\n</Order>`);
  });

  test("strict keeps them, so a delivered xmlns is a difference", () => {
    expect(canonicalXml(`<a xmlns="urn:x"/>`, true)).toBe(`<a xmlns="urn:x"/>`);
    expect(canonicalXml(`<a xmlns="urn:x"/>`, true)).not.toBe(canonicalXml(`<a/>`, true));
  });

  test("a malformed document throws with where", () => {
    expect(() => parseXml(`<a><b></a>`)).toThrow(/does not close/);
    expect(() => parseXml(`<a>`)).toThrow(/never closed/);
    expect(() => parseXml(`<a/><b/>`)).toThrow(/second document element/);
    expect(() => parseXml(`<a>&bogus;</a>`)).toThrow(/unknown entity/);
  });

  test("two documents that mean the same thing print the same", () => {
    expect(canonicalXml(`<a><b></b><c  x='1'>t</c></a>`)).toBe(canonicalXml(`<a>\n<b/>\n<c x="1">t</c></a>`));
  });
});

// ---------------------------------------------------------------------------

describe("paths", () => {
  test("a leading slash is the whole difference from an HL7 path", () => {
    expect(isXmlPath("/Order/Id")).toBe(true);
    expect(isXmlPath("PID-5.1")).toBe(false);
  });

  test("steps, indexes and a trailing attribute", () => {
    expect(parseXmlPath("/A/B[2]/@c")).toEqual({ steps: [{ name: "A" }, { name: "B", index: 2 }], attr: "c" });
  });

  test("an attribute anywhere but last, a zero index, and a relative path are refused", () => {
    expect(() => parseXmlPath("/A/@b/C")).toThrow(/last step/);
    expect(() => parseXmlPath("/A[0]")).toThrow(/start at 1/);
    expect(() => parseXmlPath("A/B")).toThrow(/Not a valid XML path/);
  });

  test("record scope is step-wise, so /A/Item does not claim /A/Items", () => {
    expect(underRecord("/A/Item/Code", "/A/Item")).toBe(true);
    expect(underRecord("/A/Item", "/A/Item")).toBe(true);
    expect(underRecord("/A/Items/Code", "/A/Item")).toBe(false);
    expect(inRecord("/A/Item/@x", "/A/Item")).toBe(true);
    expect(inRecord("PID-5", "/A/Item")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("the message and its records", () => {
  const m = XmlMessage.parse(`<O v="2"><P id="7"><N>a</N></P><L><I c="1">x</I><I c="2">y</I></L></O>`);

  test("a read takes the first match, and a wrong document element reads nothing", () => {
    expect(m.get("/O/@v")).toBe("2");
    expect(m.get("/O/L/I/@c")).toBe("1");
    expect(m.get("/O/L/I[2]")).toBe("y");
    expect(m.get("/Other/P/N")).toBe("");
  });

  test("a walk takes every match, and a record reads relative to itself", () => {
    const items = m.all("/O/L/I");
    expect(items.map((r) => r.get("/O/L/I/@c"))).toEqual(["1", "2"]);
    expect(items[1].get("/O/L/I")).toBe("y");
  });

  test("a write creates what it needs, and a clone is independent", () => {
    const r = blankRecord("/T/Rec");
    r.set("/T/Rec/A/B", "v");
    r.set("/T/Rec/@k", "1");
    const c = r.clone();
    c.set("/T/Rec/A/B", "changed");
    expect(r.toString()).toBe(`<Rec k="1">\n  <A>\n    <B>v</B>\n  </A>\n</Rec>`);
    expect(() => r.set("/T/Other", "x")).toThrow(/not under the record/);
  });

  test("records land under their parents, each parent made once", () => {
    const b = new XmlBuilder("T");
    for (const v of ["1", "2"]) {
      const r = new XmlRecord("/T/List/Item", blankRecord("/T/List/Item").el);
      r.set("/T/List/Item/@n", v);
      b.place(r);
    }
    expect(b.message().toString()).toBe(`<T>\n  <List>\n    <Item n="1"/>\n    <Item n="2"/>\n  </List>\n</T>\n`);
  });
});

// ---------------------------------------------------------------------------

describe("the runner over either format", () => {
  test("the format of each side is read off the paths", () => {
    expect([sourceFormat(x2x.spec), targetFormat(x2x.spec)]).toEqual(["xml", "xml"]);
    expect([sourceFormat(h2x.spec), targetFormat(h2x.spec)]).toEqual(["hl7v2", "xml"]);
    expect([sourceFormat(x2h.spec), targetFormat(x2h.spec)]).toEqual(["xml", "hl7v2"]);
  });

  test("XML to XML: select, fold, skip, max, seed and continued numbering", () => {
    const out = runText(x2x.spec, x2x.cases[0].input).text;
    expect(out).toContain(`<Line n="1">Findings are unremarkable.</Line>`);
    expect(out).toContain(`<Line n="2">Impression: &lt;normal&gt; &amp; stable.</Line>`);
    expect(out).toContain(`<Line n="3">END</Line>`);
    expect(out).not.toContain("first draft");
    expect(out).not.toContain("UNKNOWN");
    expect(out.match(/<Person seq=/g)?.length).toBe(2);
    expect(out).toContain(`<Items checked="yes">`);
    expect(out).toContain(`<Name>Roe &amp; Jane</Name>`);
  });

  test("a guarded seed with nothing to copy delivers nothing", () => {
    expect(runText(x2x.spec, x2x.cases[1].input).text).not.toContain("<Items");
  });

  test("HL7 to XML: a composite field becomes one value, separators and all", () => {
    const out = runText(h2x.spec, h2x.cases[0].input).text;
    expect(out).toContain(`<Address>1 Main St^^Rochester^NY^14624</Address>`);
    expect(out).toContain(`<Header event="ADMIT">`);
  });

  test("XML to HL7: the HL7 defaults, and a stripped delimiter", () => {
    const out = runText(x2h.spec, x2h.cases[0].input).text;
    expect(out.startsWith("MSH|^~\\&|BENCH")).toBe(true);
    expect(out).toContain("PID|1||MRN5||O'HARAX^KIM");
    expect(out).toContain("NK1|1|PatLee|SPO");
  });

  test("the gate refuses over XML exactly as over HL7", () => {
    expect(() => runText(x2x.spec, x2x.cases.find((c) => c.reject)!.input)).toThrow(/does not handle/);
  });

  test("runSpec keeps its in-place HL7 contract and says what to use instead", () => {
    expect(() => runSpec(h2x.spec, new Message(h2x.cases[0].input))).toThrow(/runText/);
  });
});

// ---------------------------------------------------------------------------

describe("what XML refuses", () => {
  const xbase = (over: Partial<Spec> = {}): Spec => ({
    name: "X",
    gate: { path: "/O/T", permit: { A: "A" } },
    iris: { sourceDocType: "2.5:ADT_A01", targetDocType: "2.5:ADT_A01" },
    blocks: [{ id: "/R/B", rows: [{ target: "/R/B/V", from: copy("/O/V") }] }],
    ...over,
  });
  const has = (spec: Spec, re: RegExp, engine?: "iris" | "bridgelink") =>
    expect(validate(spec, engine).some((p) => re.test(p))).toBe(true);

  test("the base is valid", () => {
    expect(validate(xbase())).toEqual([]);
  });

  test("a source path in the other format", () => {
    has(xbase({ blocks: [{ id: "/R/B", rows: [{ target: "/R/B/V", from: copy("PID-5") }] }] }), /every source path must too/);
  });

  test("blocks that mix formats, and two document elements", () => {
    has(xbase({ blocks: [{ id: "/R/B", rows: [] }, { id: "PID", rows: [] }] }), /mix XML and HL7/);
    has(xbase({ blocks: [{ id: "/R/B", rows: [] }, { id: "/S/B", rows: [] }] }), /disagree on the document element/);
  });

  test("a row outside its block, and a block that is an attribute", () => {
    has(xbase({ blocks: [{ id: "/R/B", rows: [{ target: "/R/C/V", from: literal("x") }] }] }), /not under it/);
    has(xbase({ blocks: [{ id: "/R/@b", rows: [] }] }), /attribute is written by a row/);
  });

  test("pickRepeat on XML, bundle, and a seed across formats", () => {
    has(xbase({ blocks: [{ id: "/R/B", rows: [{ target: "/R/B/V", from: pickRepeat("/O/V", 1, "x") }] }] }), /pickRepeat scans/);
    has(xbase({ blocks: [{ id: "/R/B", bundle: ["X"], repeat: { over: "/O/B" }, rows: [] }] }), /bundle is HL7 only/);
    has({ ...xbase(), gate: { path: "MSH-9.2", permit: { A01: "A01" } }, blocks: [{ id: "/R/B", wholeSegment: true, rows: [] }] }, /same format/);
  });

  test("the IRIS emitters refuse XML by name", () => {
    has(xbase(), /IRIS emitters write HL7 v2/, "iris");
  });
});

// ---------------------------------------------------------------------------

describe("the BridgeLink step for each direction", () => {
  // `default xml namespace = ''` is E4X syntax, the one line plain JavaScript
  // cannot parse; everything else must.
  const parses = (body: string) => {
    const js = body.replace(/^default xml namespace = '';$/m, "");
    expect(() => new Function("msg", "tmp", "logger", `function step() {\n${js}\n}`)).not.toThrow();
  };

  for (const [name, mod] of [["xml-to-xml", x2x], ["hl7-to-xml", h2x], ["xml-to-hl7", x2h]] as const) {
    test(`${name}: the step and the filter parse`, () => {
      parses(emitBridgelink(mod.spec));
      parses(filterCondition(mod.spec));
    });
  }

  test("an XML step resets the default namespace, and matches names locally", () => {
    const out = emitBridgelink(x2x.spec);
    expect(out).toContain("default xml namespace = '';");
    expect(out).toContain("kids[i].localName() === name");
    expect(out).toContain("benchXBare(seed)");
  });

  test("the delivered document replaces the message whole", () => {
    expect(emitBridgelink(x2x.spec)).toContain("msg = out;");
    expect(emitBridgelink(h2x.spec)).toContain("var out = new XML('<Registration/>');");
  });

  test("the channel's data types follow each side, namespaces kept", () => {
    const ch = emitChannel(h2x.spec, { id: "x" });
    const src = ch.slice(ch.indexOf("<sourceConnector"), ch.indexOf("</sourceConnector>"));
    expect(src).toContain("<inboundDataType>HL7V2</inboundDataType>");
    expect(src).toContain("<outboundDataType>XML</outboundDataType>");
    expect(emitChannel(x2x.spec, { id: "x" })).toContain("<stripNamespaces>false</stripNamespaces>");
  });
});

// ---------------------------------------------------------------------------

describe("the mapping document over XML", () => {
  test("every row is listed against its XML target, with the source that fed it", async () => {
    const { trace } = await import("./trace");
    const { parseFor } = await import("./run");
    const doc = trace(x2x.spec, parseFor(x2x.spec, x2x.cases[0].input));
    expect(doc).toContain("GATE:  /Order/Header/Type");
    expect(doc).toMatch(/\/Order\/Person\/@mrn \*\s+\/Order\/Patient\/Mrn\s+MRN1/);
    expect(doc).toContain("/Order/Kin/Person  --  2 of 2");
    // A seeded record on one line, counted in elements, not "undefined field(s)".
    expect(doc).toContain(`<Items><Item code="A">one</Item><Item code="B">two</Item></Items>`);
    expect(doc).toContain("2 element(s) and 0 attribute(s) passed through");
    expect(doc).not.toContain("undefined");
  });
});
