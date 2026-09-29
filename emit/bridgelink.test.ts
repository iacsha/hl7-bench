/**
 * emit/bridgelink.test.ts -- the claims that are specific to the channel.
 *
 * The mechanical coverage (every source kind, every step kind, every backend)
 * lives in `spec.test.ts` and is not repeated here. What is here is the set of
 * things that are true about E4X and Rhino and about nothing else, each one a
 * bug that would otherwise be found by a receiver.
 */

import { expect, test, describe } from "bun:test";
import {
  copy, literal, firstOf, lookup, counter, event, pickRepeat, fromFirst, todo,
  blank, passthrough, constant,
  date8, stripDelims, upper,
  type Spec, type Block,
} from "../spec";
import { emitBridgelink, filterCondition, js } from "./bridgelink";

const base = (over: Partial<Spec> = {}): Spec => ({
  name: "Test Interface",
  gate: { path: "MSH-9.2", permit: { A01: "A28", A08: "A31" } },
  iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3.1:ADT_A05" },
  bridgelink: { channelName: "Test Channel" },
  tables: { Sex: { M: "1", F: "2" } },
  blocks: [{ id: "MSH", rows: [{ target: "MSH-3", from: literal("BENCH") }] }],
  ...over,
});

const withBlocks = (blocks: Block[], over: Partial<Spec> = {}) =>
  emitBridgelink(base({ blocks, ...over }));

const oneRow = (target: string, from: any, via?: any[]) =>
  withBlocks([{ id: target.slice(0, 3), rows: [{ target, from, via }] }]);

// ---------------------------------------------------------------------------

describe("the refusal", () => {
  test("a spec with no bridgelink key is refused, and the message says what to add", () => {
    const spec = base();
    delete (spec as any).bridgelink;
    expect(() => emitBridgelink(spec)).toThrow(/no "bridgelink" key/);
    expect(() => emitBridgelink(spec)).toThrow(/channelName/);
  });

  test("an empty channel name is refused too", () => {
    // An empty string is not a name. It would emit a header that says
    // "Channel:" and nothing after it, which is worse than not emitting.
    const spec = base({ bridgelink: { channelName: "   " } });
    expect(() => emitBridgelink(spec)).toThrow(/channelName is empty/);
  });

  test("the ordinary spec problems are still caught", () => {
    const spec = base({ gate: { path: "MSH-9.2", permit: {} } });
    expect(() => emitBridgelink(spec)).toThrow(/not runnable/);
  });
});

// ---------------------------------------------------------------------------

describe("what the step says about itself", () => {
  test("the header names the channel and carries the fingerprint", () => {
    const out = emitBridgelink(base());
    expect(out).toContain("Channel: Test Channel");
    expect(out).toMatch(/Spec fingerprint: [0-9a-f]{12}/);
  });

  test("the source filter is printed, because the step does not gate", () => {
    const out = emitBridgelink(base());
    expect(out).toContain("Source filter this step expects in front of it:");
    // and the step itself contains no refusal
    expect(out).not.toContain("throw");
  });

  test("a gate declared upstream is named rather than silently absent", () => {
    const out = emitBridgelink(
      base({ gate: { path: "MSH-9.2", permit: { A01: "A28" }, enabled: false, upstream: "the router rule" } }),
    );
    expect(out).toContain("the router rule");
    expect(out).toContain("delivered UNCHANGED");
  });

  test("an empty lookup table is called out as a go-live gate", () => {
    const out = withBlocks(
      [{ id: "PID", rows: [{ target: "PID-8", from: lookup("Sex", "PID-8", blank()) }] }],
      { tables: { Sex: {} } },
    );
    expect(out).toContain("EMPTY IN THE SPEC");
  });
});

// ---------------------------------------------------------------------------

describe("ES5 only", () => {
  // The JavaScript level is fixed by the bundled Rhino build, not by the JDK.
  // Until somebody pastes the probe into a real channel and reads the log, the
  // only safe target is the one every Rhino has ever accepted.
  const everything = withBlocks([
    { id: "MSH", rows: [{ target: "MSH-9.2", from: event() }] },
    {
      id: "IN1",
      repeat: { over: "IN1", skipWhenEmpty: "IN1-2", max: 3 },
      rows: [
        { target: "IN1-1", from: counter() },
        { target: "IN1-2", from: firstOf("IN1-2", "IN1-3") },
        { target: "IN1-3", from: lookup("Sex", "PID-8", passthrough()) },
        { target: "IN1-4", from: pickRepeat("PV1-7", 7, "NPI", 1) },
        { target: "IN1-5", from: fromFirst("NK1", "NK1-2", "NK1-2.1") },
        { target: "IN1-6", from: copy("IN1-2"), via: [date8(), upper(), stripDelims()] },
      ],
    },
  ]);

  test("no arrow functions", () => {
    expect(everything).not.toContain("=>");
  });

  test("no let and no const", () => {
    expect(everything).not.toMatch(/\blet\s/);
    expect(everything).not.toMatch(/\bconst\s/);
  });

  test("no template literals", () => {
    expect(everything).not.toContain("`");
  });

  test("every declaration is a var", () => {
    // Every line that declares something declares it with var. A single ES6
    // declaration slipping in is a channel that fails to deploy, at whatever
    // hour the deploy happens.
    const declarations = everything.split("\n").filter((l) => /^\s*(var|let|const)\s/.test(l));
    expect(declarations.length).toBeGreaterThan(10);
    expect(declarations.every((l) => /^\s*var\s/.test(l))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("the E4X shapes that would otherwise be silent wrong values", () => {
  test("a component read falls back to the parent's own text at index 1", () => {
    // A field carrying no ^ has NO child element under it: the value is on the
    // parent. Reading .1 the obvious way returns empty, and empty looks exactly
    // like a field the sender left blank.
    const out = oneRow("PID-3", copy("PID-3.1"));
    expect(out).toContain("function benchDown(");
    expect(out).toContain("return index === 1 ? node : null;");
  });

  test("a whole-field read flattens components rather than emitting markup", () => {
    // toString() on a node with children returns MARKUP. Writing that onto the
    // wire produces a field containing angle brackets, and it parses.
    const out = oneRow("PID-5", copy("PID-5"));
    expect(out).toContain("function benchText(");
    expect(out).toContain("hasComplexContent()");
    expect(out).toContain("return benchText(node);");
  });

  test("the separators are read off the message, not assumed", () => {
    const out = emitBridgelink(base());
    expect(out).toContain("var benchDelims = benchDelimiters(msg);");
    expect(out).toContain("var benchComp = benchDelims.charAt(1);");
    expect(out).toContain("var benchSub = benchDelims.charAt(4);");
  });

  test("MSH is seeded with its own delimiters, because MSH-1 IS the separator", () => {
    const out = emitBridgelink(base());
    expect(out).toContain("benchSet(seg, 'MSH', 1, 1, 0, 0, delims.charAt(0));");
    expect(out).toContain("benchSet(seg, 'MSH', 2, 1, 0, 0, delims.substring(1));");
  });

  test("children are inserted in numeric order, not in assignment order", () => {
    const out = withBlocks([
      { id: "PID", rows: [
        { target: "PID-5", from: literal("A") },
        { target: "PID-3", from: literal("B") },
      ] },
    ]);
    expect(out).toContain("function benchInsert(");
    expect(out).toContain("insertChildBefore(");
  });

  test("a component and a subcomponent are addressed as different numbers", () => {
    // PID-5 and PID-5.1 differ in every engine that has ever shipped. Collapsing
    // them would make copy("PID-5") drop everything after the first ^.
    expect(oneRow("PID-5", copy("PID-5"))).toContain("'PID', 5, 1, 0, 0)");
    expect(oneRow("PID-5", copy("PID-5.1"))).toContain("'PID', 5, 1, 1, 0)");
    expect(oneRow("PID-5", copy("PID-5.1.2"))).toContain("'PID', 5, 1, 1, 2)");
  });
});

// ---------------------------------------------------------------------------

describe("the gate's target event", () => {
  test("a permitted trigger maps to the target event, not to itself", () => {
    const out = oneRow("MSH-9.2", event());
    expect(out).toContain("if (benchTrigger === 'A01') { benchEvent = 'A28'; }");
    expect(out).toContain("if (benchTrigger === 'A08') { benchEvent = 'A31'; }");
  });

  test("an unlisted trigger is EMPTY when the gate is on", () => {
    // The filter should already have refused it. If one gets through anyway,
    // saying nothing beats stamping a trigger this interface never mapped.
    const out = oneRow("MSH-9.2", event());
    expect(out).toContain("var benchEvent = '';");
  });

  test("an unlisted trigger PASSES THROUGH when gating is declared upstream", () => {
    const out = withBlocks(
      [{ id: "MSH", rows: [{ target: "MSH-9.2", from: event() }] }],
      { gate: { path: "MSH-9.2", permit: { A01: "A28" }, enabled: false, upstream: "the router" } },
    );
    expect(out).toContain("var benchEvent = benchTrigger;");
  });

  test("no event row means no event machinery", () => {
    expect(emitBridgelink(base())).not.toContain("benchTrigger");
  });
});

// ---------------------------------------------------------------------------

describe("repeats", () => {
  const spec = () =>
    withBlocks([
      {
        id: "IN1",
        repeat: { over: "IN1", skipWhenEmpty: "IN1-2", max: 2 },
        rows: [
          { target: "IN1-1", from: counter() },
          { target: "IN1-2", from: copy("IN1-2") },
        ],
      },
    ]);

  test("the set id is the OUTPUT ordinal, not the source index", () => {
    // A skipped occurrence must not leave a hole in the numbering. IN1-1 of the
    // second delivered segment is 2 even when it came from the third IN1.
    const out = spec();
    expect(out).toContain("var v_IN1_1 = String(n1);");
    expect(out).toContain("for (var k1 = 0; k1 < src1.length(); k1++)");
  });

  test("the cap counts what was delivered, after the skip rule ran", () => {
    expect(spec()).toContain("if (benchGet(cur1, 'IN1', 2, 1, 0, 0) !== '' && n1 < 2)");
  });

  test("a path naming the repeated segment reads the CURRENT occurrence", () => {
    expect(spec()).toContain("benchGet(cur1, 'IN1', 2,");
  });

  test("a path naming anything else falls through to the message", () => {
    const out = withBlocks([
      { id: "IN1", repeat: { over: "IN1" }, rows: [{ target: "IN1-3", from: copy("PID-3") }] },
    ]);
    expect(out).toContain("benchGet(benchSeg(msg, 'PID'), 'PID', 3,");
  });

  test("fromFirst reads the whole message even inside a repeat", () => {
    // "the first NK1 with a name in it" is a question about the message. Scoping
    // it to the enclosing repeat would answer a different question.
    const out = withBlocks([
      { id: "IN1", repeat: { over: "IN1" }, rows: [{ target: "IN1-3", from: fromFirst("NK1", "NK1-2", "NK1-2.1") }] },
    ]);
    expect(out).toContain("benchAll(msg, 'NK1')");
  });

  test("counter outside a repeat is refused rather than emitted as zero", () => {
    const spec = base({ blocks: [{ id: "PID", rows: [{ target: "PID-1", from: counter() }] }] });
    expect(() => emitBridgelink(spec)).toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("lookup", () => {
  const of = (u: any) => oneRow("PID-8", lookup("Sex", "PID-8", u));

  test("the key is read once, into a local", () => {
    expect(of(passthrough())).toContain("var key1 = benchGet(");
  });

  test("each unmapped branch emits a different fallback", () => {
    expect(of(blank())).toContain("benchLookup('Sex', key1, '')");
    expect(of(passthrough())).toContain("benchLookup('Sex', key1, key1)");
    expect(of(constant("9"))).toContain("benchLookup('Sex', key1, '9')");
  });

  test("an empty source is not an unmapped code", () => {
    // Sending the unmapped default for a field the sender never populated
    // invents a value, and invents it on every message rather than on the
    // interesting ones.
    expect(of(constant("9"))).toContain("if (key === '') { return ''; }");
  });

  test("the miss is reported by asking the table, not by reading the result", () => {
    // With passthrough or constant the fallback IS a real value, so a miss and
    // a hit are indistinguishable by result.
    expect(of(passthrough())).toContain("!benchHas('Sex', key1)");
  });

  test("the tables are inlined, and the trade is stated", () => {
    expect(of(blank())).toContain("var benchTables = {");
    expect(of(blank())).toContain("'M': '1'");
  });
});

// ---------------------------------------------------------------------------

describe("rows", () => {
  test("a todo row assigns nothing at all", () => {
    const out = oneRow("PID-3", todo("no agreed code set"));
    expect(out).toContain("TODO PID-3: no agreed code set");
    expect(out).not.toContain("benchSet(segPID");
  });

  test("an ordinary row assigns even when the value is empty", () => {
    // Same as <assign> in a DTL: it creates the field. A receiver that counts
    // fields positionally cares about the difference.
    expect(oneRow("PID-3", copy("PID-30"))).toContain("benchSet(segPID, 'PID', 3,");
  });

  test("a required field that came out empty warns on the VALUE, not the source", () => {
    // So it also catches a source that was populated and a step that emptied it.
    const out = withBlocks([
      { id: "PID", rows: [{ target: "PID-3", from: copy("PID-3.1"), label: "MRN", required: true }] },
    ]);
    expect(out).toContain("if (v_PID_3 === '') { logger.warn('PID-3 (MRN) is required and came out empty'); }");
  });

  test("logging off emits no logger call anywhere", () => {
    const out = withBlocks(
      [{ id: "PID", rows: [{ target: "PID-8", from: lookup("Sex", "PID-8", blank()), required: true }] }],
      { bridgelink: { channelName: "Test Channel", log: "off" } },
    );
    expect(out).not.toContain("logger.");
  });

  test("trace adds one line per assigned field and keeps the warnings", () => {
    const out = withBlocks(
      [{ id: "PID", rows: [{ target: "PID-3", from: copy("PID-3.1"), required: true }] }],
      { bridgelink: { channelName: "Test Channel", log: "trace" } },
    );
    expect(out).toContain("logger.info('PID-3 = ' + v_PID_3);");
    expect(out).toContain("logger.warn(");
  });
});

// ---------------------------------------------------------------------------

describe("string escaping", () => {
  test("a quote in a literal cannot close the JavaScript string early", () => {
    expect(js("the 'real' MRN")).toBe("'the \\'real\\' MRN'");
  });

  test("a backslash is escaped before anything else is", () => {
    // Otherwise every escape this adds gets escaped again.
    expect(js("a\\b")).toBe("'a\\\\b'");
  });

  test("a newline in a note cannot turn the rest of the note into code", () => {
    const out = withBlocks([
      { id: "PID", rows: [{ target: "PID-3", from: literal("X"), note: "line one\nlogger.warn('oops')" }] },
    ]);
    const noteLine = out.split("\n").find((l) => l.includes("line one"))!;
    expect(noteLine.startsWith("// ")).toBe(true);
    expect(out).not.toContain("\nlogger.warn('oops')");
  });
});

// ---------------------------------------------------------------------------

describe("the runtime carries no dead code", () => {
  test("a spec with no lookup does not carry the lookup helpers", () => {
    expect(emitBridgelink(base())).not.toContain("function benchLookup(");
  });

  test("a spec with no firstOf does not carry benchFirst", () => {
    expect(emitBridgelink(base())).not.toContain("function benchFirst(");
  });

  test("a strip step brings its helper with it", () => {
    const out = oneRow("PID-3", copy("PID-3.1"), [stripDelims()]);
    expect(out).toContain("function benchStrip(");
    expect(out).toContain("benchStrip(benchGet(");
  });
});

// ---------------------------------------------------------------------------

describe("filterCondition", () => {
  test("every permitted trigger is an alternative", () => {
    const c = filterCondition(base());
    expect(c).toContain("'A01'");
    expect(c).toContain("'A08'");
    expect(c.startsWith("return ")).toBe(true);
  });

  test("a require is ANDed and the events are parenthesised", () => {
    // || binds looser than &&. A filter reading A && B || C lets C through on
    // its own, which is a different interface than the one specified.
    const c = filterCondition(
      base({ gate: { path: "MSH-9.2", permit: { A01: "A28", A08: "A31" }, require: [{ path: "MSH-4", equals: "SENDFAC" }] } }),
    );
    expect(c).toContain("&& (");
    expect(c.indexOf("&&")).toBeLessThan(c.indexOf("||"));
  });

  test("a gate declared upstream returns the declaration, not a condition", () => {
    const c = filterCondition(base({ gate: { path: "MSH-9.2", permit: { A01: "A28" }, enabled: false, upstream: "the router rule" } }));
    expect(c).toContain("the router rule");
    expect(c).not.toContain("return ");
  });

  test("a filter reads plain E4X, because a filter script has no helpers", () => {
    expect(filterCondition(base())).toContain("msg['MSH']['MSH.9']['MSH.9.2'].toString()");
  });
});

// ---------------------------------------------------------------------------

describe("the ending", () => {
  test("the step writes tmp when there is an outbound template and msg when not", () => {
    const out = emitBridgelink(base());
    expect(out).toContain("if (typeof tmp !== 'undefined' && tmp !== null) {");
    expect(out).toContain("tmp.setChildren(out.children());");
    expect(out).toContain("msg.setChildren(out.children());");
  });

  test("the outbound message is built fresh, and says so", () => {
    const out = emitBridgelink(base());
    expect(out).toContain("var out = new XML('<HL7Message/>');");
    expect(out).toContain("gone on purpose");
  });

  test("a group is named as IRIS-only rather than dropped in silence", () => {
    // The DTL for this same block DOES address the group. Saying nothing here
    // would make the two files look like they disagree.
    const out = withBlocks([{ id: "IN1", group: "INSURANCEgrp", rows: [{ target: "IN1-1", from: literal("1") }] }]);
    expect(out).toContain("INSURANCEgrp");
    expect(out).toContain("no groups");
  });
});
