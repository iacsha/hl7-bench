// bun test
//
// The bug this gate exists for was green on every other check in this repo. A
// `GT1` block with `wholeSegment: true` and no `repeat` emitted bare `GT1`
// paths; IRIS returns EMPTY for `GetValueAt("GT1")` on a segment the schema
// marks as repeating; the interface dropped GT1 and three mapped fields in
// production and `bun check.ts` never moved, because `run.ts` has a flat
// message model that finds a segment by name whatever the schema says.
//
// So the tests that matter are: does the GT1 shape fail, does a spec that got
// it right pass, and -- the one that decides whether any of the rest can be
// believed -- does a line this parser cannot read get COUNTED rather than
// dropped. A schema checker that silently skips the entry the check was about
// commits the exact failure it was built to catch.

import { expect, test, describe } from "bun:test";

import { copy, event, fromFirst, literal, type Spec } from "./spec";
import {
  bareSegments,
  checkSpec,
  commandsFor,
  diffDumps,
  docTypeParts,
  normaliseGroupPath,
  parseDump,
  repeatingGroups,
  renderDiff,
  renderReport,
  sourceSegments,
} from "./schemacheck";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The dump as it really came off the instance, verbatim, plus EVN and PV2.
 *
 * The paste in the task is alphabetical and stops short, so it genuinely lacks
 * EVN and PV2 -- which is a correct finding about that paste and a distraction
 * in a test about repeats. These two rows are the only additions.
 */
const DUMP = [
  '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","ACC")="=16|2.3:ACC"',
  '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","AL1()")="=10,*|2.3:AL1"',
  '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","EVN")="=02|2.3:EVN"',
  '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","GT1()")="=14,*|2.3:GT1"',
  '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","IN1grp().IN1")="=15,*,1|2.3:IN1"',
  '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","IN1grp().IN2")="=15,*,2|2.3:IN2"',
  '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","MSH")="=01|2.3:MSH"',
  '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","NK1()")="=05,*|2.3:NK1"',
  '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","PID")="=03|2.3:PID"',
  '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","PR1grp().PR1")="=13,*,1|2.3:PR1"',
  '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","PR1grp().ROL()")="=13,*,2,*|2.3:ROL"',
  '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","PV1")="=06|2.3:PV1"',
  '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","PV2")="=07|2.3:PV2"',
  '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","leftoversegs()")="=19,*|:Any"',
].join("\n");

const base = (over: Partial<Spec> = {}): Spec => ({
  name: "Schemacheck Test",
  gate: { path: "MSH-9.2", permit: { A01: "A28" } },
  iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3:ADT_A01" },
  tables: {},
  blocks: [],
  ...over,
});

/** The findings a spec produces against a dump, with the emitter's own bare set. */
function findingsFor(spec: Spec, dumpText = DUMP) {
  const { bare, refused } = bareSegments(spec);
  expect(refused).toEqual([]);
  return checkSpec(spec, parseDump(dumpText), bare);
}

const codes = (spec: Spec, dumpText = DUMP) => findingsFor(spec, dumpText).map((f) => f.code);

// ---------------------------------------------------------------------------
// The bug
// ---------------------------------------------------------------------------

describe("the GT1 bug", () => {
  // Exactly the shape that shipped: wholeSegment, no repeat, on a segment the
  // schema marks "GT1()".
  const broken = base({
    blocks: [
      { id: "MSH", wholeSegment: true, rows: [{ target: "MSH-9.2", from: event() }] },
      { id: "GT1", wholeSegment: true, rows: [{ target: "GT1-12", from: literal("") }] },
    ],
  });

  test("a bare read of a repeating segment is an error", () => {
    const f = findingsFor(broken).filter((x) => x.code === "bare-repeating");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("error");
    expect(f[0]!.subject).toBe("GT1");
    // The message has to carry the fix, not just the diagnosis: the operator
    // reading it at 4pm is the one who has to type the repeat.
    expect(f[0]!.text).toContain('repeat: { over: "GT1" }');
    expect(f[0]!.text).toContain("block GT1");
  });

  test("the same spec with a repeat passes", () => {
    const fixed = base({
      blocks: [
        { id: "MSH", wholeSegment: true, rows: [{ target: "MSH-9.2", from: event() }] },
        {
          id: "GT1",
          wholeSegment: true,
          repeat: { over: "GT1" },
          rows: [{ target: "GT1-12", from: literal("") }],
        },
      ],
    });
    expect(codes(fixed)).toEqual([]);
  });

  test("a segment that does NOT repeat is fine read bare", () => {
    const pid = base({
      blocks: [{ id: "PID", wholeSegment: true, rows: [{ target: "PID-19", from: literal("") }] }],
    });
    expect(codes(pid)).toEqual([]);
  });

  test("a row reading a repeating segment from another block is caught too", () => {
    // Not a wholeSegment seed and not this block's own repeat -- the read is
    // still bare and still empty, and attributing it to a block that cannot
    // simply grow a `repeat` is why the message says where else to look.
    const spec = base({
      blocks: [{ id: "PID", rows: [{ target: "PID-5", from: copy("NK1-2") }] }],
    });
    const f = findingsFor(spec).filter((x) => x.code === "bare-repeating");
    expect(f).toHaveLength(1);
    expect(f[0]!.subject).toBe("NK1");
  });

  test("fromFirst walks occurrences itself, so it is not a bare read", () => {
    const spec = base({
      blocks: [
        {
          id: "PID",
          rows: [
            { target: "PID-5", from: fromFirst("NK1", "NK1-2", "NK1-2") },
          ],
        },
      ],
    });
    expect(codes(spec)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

describe("groups", () => {
  const in1Block = (over: Record<string, unknown> = {}) => ({
    id: "IN1",
    wholeSegment: true as const,
    repeat: { over: "IN1" },
    rows: [],
    ...over,
  });

  test("a target segment inside a group with no block.group is an error naming the group", () => {
    const spec = base({
      blocks: [in1Block()],
      iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3:ADT_A01", sourceGroups: { IN1: "IN1grp" } },
    });
    const f = findingsFor(spec).filter((x) => x.code === "group-mismatch");
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("error");
    expect(f[0]!.text).toContain("IN1grp");
    expect(f[0]!.text).toContain('group: "IN1grp"');
  });

  test("the right group name passes", () => {
    const spec = base({
      blocks: [in1Block({ group: "IN1grp" })],
      iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3:ADT_A01", sourceGroups: { IN1: "IN1grp" } },
    });
    expect(codes(spec)).toEqual([]);
  });

  test("a DIFFERENT group name is an error that names the one the schema says", () => {
    const spec = base({
      blocks: [in1Block({ group: "INSURANCEgrp" })],
      iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3:ADT_A01", sourceGroups: { IN1: "IN1grp" } },
    });
    const f = findingsFor(spec).filter((x) => x.code === "group-mismatch");
    expect(f).toHaveLength(1);
    expect(f[0]!.text).toContain("INSURANCEgrp");
    expect(f[0]!.text).toContain("IN1grp");
  });

  test("a group that differs only in case says so", () => {
    const spec = base({
      blocks: [in1Block({ group: "IN1GRP" })],
      iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3:ADT_A01", sourceGroups: { IN1: "IN1grp" } },
    });
    const f = findingsFor(spec).filter((x) => x.code === "group-mismatch");
    expect(f[0]!.text).toContain("CASE only");
  });

  test("a missing sourceGroups entry for a grouped source segment is an error", () => {
    const spec = base({ blocks: [in1Block({ group: "IN1grp" })] });
    const f = findingsFor(spec).filter((x) => x.code === "source-group-mismatch");
    expect(f).toHaveLength(1);
    expect(f[0]!.text).toContain('iris.sourceGroups: { IN1: "IN1grp" }');
  });

  test("a wrong sourceGroups entry is an error", () => {
    const spec = base({
      blocks: [in1Block({ group: "IN1grp" })],
      iris: {
        sourceDocType: "2.3:ADT_A01",
        targetDocType: "2.3:ADT_A01",
        sourceGroups: { IN1: "INSURANCEgrp" },
      },
    });
    const f = findingsFor(spec).filter((x) => x.code === "source-group-mismatch");
    expect(f).toHaveLength(1);
    expect(f[0]!.text).toContain("INSURANCEgrp");
  });

  // The GT1 bug one level up, on the same evidence footing. Measured on IRIS
  // for Health, 2.3:ADT_A01, one IN1 inside IN1grp:
  //   GRP_NO_OCC |[]                             GetValueAt("IN1grp.IN1")
  //   GRP_OCC    |[IN1|1|PLAN1|PAY1|PAYER NAME]  GetValueAt("IN1grp(1).IN1")
  describe("a repeating group read with no occurrence index", () => {
    // A PID row reading IN1 from outside any loop over it. This is the shape
    // that emits `source.{IN1grp.IN1:2}`, and before the group set existed it
    // was collected by nothing -- it is not a bare SEGMENT either.
    const readsThroughGroup = base({
      blocks: [{ id: "PID", wholeSegment: true, rows: [{ target: "PID-3", from: copy("IN1-2") }] }],
      iris: {
        sourceDocType: "2.3:ADT_A01",
        targetDocType: "2.3:ADT_A01",
        sourceGroups: { IN1: "IN1grp" },
      },
    });

    test("is an error naming the group, what IRIS returns, and the fix", () => {
      const f = findingsFor(readsThroughGroup).filter((x) => x.code === "bare-repeating-group");
      expect(f).toHaveLength(1);
      expect(f[0]!.severity).toBe("error");
      expect(f[0]!.subject).toBe("IN1grp");
      expect(f[0]!.text).toContain('GetValueAt("IN1grp.IN1") returns EMPTY');
      expect(f[0]!.text).toContain('GetValueAt("IN1grp(1).IN1") returns the segment');
      expect(f[0]!.text).toContain('"IN1grp(1)"');
    });

    test("stays quiet when the schema says that group does not repeat", () => {
      // Same spec, an instance whose IN1grp appears once. Nothing to index.
      const flat = [
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","MSH")="=01|2.3:MSH"',
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","PID")="=03|2.3:PID"',
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","IN1grp.IN1")="=15,1|2.3:IN1"',
      ].join("\n");
      expect(codes(readsThroughGroup, flat)).toEqual([]);
    });

    test("stays quiet on the shape the real spec uses -- a repeat over the segment", () => {
      // The emitter walks the group occurrence, so nothing is read bare. This
      // is why the check does not fire forever on a correct interface.
      const spec = base({
        blocks: [
          {
            id: "IN1",
            group: "IN1grp",
            wholeSegment: true,
            repeat: { over: "IN1" },
            rows: [],
          },
        ],
        iris: {
          sourceDocType: "2.3:ADT_A01",
          targetDocType: "2.3:ADT_A01",
          sourceGroups: { IN1: "IN1grp" },
        },
      });
      expect(codes(spec)).toEqual([]);
    });

    test("repeatingGroups reads group repeats off the entries that carry them", () => {
      const d = parseDump(DUMP);
      expect([...repeatingGroups(d, "2.3:ADT_A01")].sort()).toEqual(["IN1grp", "PR1grp"]);
      expect([...repeatingGroups(d, "2.5:NOPE")]).toEqual([]);
    });
  });

  test("an occurrence index in sourceGroups is spelling, not a mismatch", () => {
    // `iris.sourceGroups` is written with the index the emitter needs in a
    // path; the schema states structure. Comparing them raw fails every
    // correct spec, which is how a checker gets turned off.
    expect(normaliseGroupPath("ORCgrp(1).OBXgrp")).toBe("ORCgrp.OBXgrp");
    expect(normaliseGroupPath("IN1grp()")).toBe("IN1grp");
    expect(normaliseGroupPath("IN1grp")).toBe("IN1grp");
  });
});

// ---------------------------------------------------------------------------
// Doctypes and absent segments
// ---------------------------------------------------------------------------

describe("doctypes", () => {
  test("a doctype the dump does not carry is an error naming what is there", () => {
    const spec = base({
      iris: { sourceDocType: "2.5:DFT_P03", targetDocType: "2.5:DFT_P03" },
      blocks: [{ id: "MSH", wholeSegment: true, rows: [] }],
    });
    const f = findingsFor(spec).filter((x) => x.code === "doctype-missing");
    expect(f).toHaveLength(2); // source and target, both named
    expect(f[0]!.text).toContain("2.3:ADT_A01");
    expect(f[0]!.severity).toBe("error");
  });

  test("a wrong doctype does not also produce a flood of segment findings", () => {
    // Every segment would be "absent" under a structure that is not here, and
    // burying the one real finding under twelve derived ones is how a report
    // stops being read.
    const spec = base({
      iris: { sourceDocType: "2.5:DFT_P03", targetDocType: "2.5:DFT_P03" },
      blocks: [
        { id: "MSH", wholeSegment: true, rows: [] },
        { id: "PID", wholeSegment: true, rows: [] },
        { id: "GT1", wholeSegment: true, repeat: { over: "GT1" }, rows: [] },
      ],
    });
    expect(codes(spec)).toEqual(["doctype-missing", "doctype-missing"]);
  });

  test("only the source doctype missing is one error, and the target still checks", () => {
    const spec = base({
      iris: { sourceDocType: "2.5:DFT_P03", targetDocType: "2.3:ADT_A01" },
      blocks: [{ id: "MSH", wholeSegment: true, rows: [] }],
    });
    const f = findingsFor(spec);
    expect(f.map((x) => x.code)).toEqual(["doctype-missing"]);
    expect(f[0]!.subject).toBe("2.5:DFT_P03");
  });

  test("a segment the structure does not define is an error on both sides", () => {
    const spec = base({ blocks: [{ id: "ZPD", wholeSegment: true, rows: [] }] });
    const f = findingsFor(spec).filter((x) => x.code === "segment-absent");
    expect(f).toHaveLength(2); // once as a source read, once as a target write
    expect(f.every((x) => x.subject === "ZPD")).toBe(true);
  });

  test("--commands prints the zw line for each distinct doctype", () => {
    expect(commandsFor(base()).lines).toEqual([
      'zw ^EnsHL7.Schema("2.3","MS","ADT_A01","map")',
    ]);
    expect(
      commandsFor(base({ iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.5:ORU_R01" } }))
        .lines,
    ).toEqual([
      'zw ^EnsHL7.Schema("2.3","MS","ADT_A01","map")',
      'zw ^EnsHL7.Schema("2.5","MS","ORU_R01","map")',
    ]);
  });

  test("--commands refuses a doctype that is not category:structure", () => {
    const { lines, problems } = commandsFor(
      base({ iris: { sourceDocType: "ADT_A01", targetDocType: "2.3:ADT_A01" } }),
    );
    expect(lines).toEqual(['zw ^EnsHL7.Schema("2.3","MS","ADT_A01","map")']);
    expect(problems).toHaveLength(1);
    expect(docTypeParts("ADT_A01")).toBeUndefined();
    expect(docTypeParts("2.3:ADT_A01")).toEqual({ category: "2.3", structure: "ADT_A01" });
  });
});

// ---------------------------------------------------------------------------
// A defensive repeat warns rather than failing
// ---------------------------------------------------------------------------

test("a repeat over a segment the schema says appears once is a warning", () => {
  const spec = base({
    blocks: [{ id: "PID", wholeSegment: true, repeat: { over: "PID" }, rows: [] }],
  });
  const f = findingsFor(spec);
  expect(f.map((x) => x.code)).toEqual(["repeat-not-repeating"]);
  expect(f[0]!.severity).toBe("warn");
});

// ---------------------------------------------------------------------------
// The parser, against a real terminal
// ---------------------------------------------------------------------------

describe("parsing a terminal paste", () => {
  const MESSY = [
    "",
    "Node: DEVHOST01, Instance: DEVINSTANCE",
    "",
    'DEV-NS>zw ^EnsHL7.Schema("2.3","MS","ADT_A01","map")',
    '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","GT1()")="=14,*|2.3:GT1"\r',
    'DEV-NS>^EnsHL7.Schema(2.3,"MS","ADT_A01","map","PID")="=03|2.3:PID"',
    "   ",
    '  ^EnsHL7.Schema(2.3,"MS","ADT_A01","map","IN1grp().IN1")="=15,*,1|2.3:IN1"',
    "",
    "DEV-NS>halt",
    "",
  ].join("\r\n");

  test("banners, prompts, CRLF and the echoed command all survive", () => {
    const d = parseDump(MESSY);
    expect(d.mapEntries).toBe(3);
    expect(d.commands).toBe(1);
    expect(d.unparsed).toEqual([]);
    expect([...d.structures.keys()]).toEqual(["2.3:ADT_A01"]);
    const segs = d.structures.get("2.3:ADT_A01")!;
    expect(segs.get("GT1")![0]!.repeats).toBe(true);
    expect(segs.get("PID")![0]!.repeats).toBe(false);
    expect(segs.get("IN1")![0]!.groupPath).toBe("IN1grp");
    expect(segs.get("IN1")![0]!.groupRepeats).toBe(true);
  });

  test("several structures concatenated stay separate", () => {
    const d = parseDump(
      [
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","GT1()")="=14,*|2.3:GT1"',
        '^EnsHL7.Schema(2.5,"MS","DFT_P03","map","GT1")="=14|2.5:GT1"',
        '^EnsHL7.Schema("SITE_2.3","MS","ADT_A08","map","PID")="=03|2.3:PID"',
      ].join("\n"),
    );
    expect([...d.structures.keys()].sort()).toEqual([
      "2.3:ADT_A01",
      "2.5:DFT_P03",
      "SITE_2.3:ADT_A08",
    ]);
    expect(d.structures.get("2.3:ADT_A01")!.get("GT1")![0]!.repeats).toBe(true);
    expect(d.structures.get("2.5:DFT_P03")!.get("GT1")![0]!.repeats).toBe(false);
  });

  test("subscripts that are not map entries are ignored, not counted as failures", () => {
    const d = parseDump(
      [
        '^EnsHL7.Schema(2.3,"base")="2.3"',
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","name")="ADT_A01"',
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","PID")="=03|2.3:PID"',
      ].join("\n"),
    );
    expect(d.mapEntries).toBe(1);
    expect(d.ignored).toBe(2);
    expect(d.unparsed).toEqual([]);
  });

  test("one segment with two homes keeps both", () => {
    const d = parseDump(
      [
        '^EnsHL7.Schema(2.5,"MS","ORU_R01","map","OBRgrp().OBX()")="=1|2.5:OBX"',
        '^EnsHL7.Schema(2.5,"MS","ORU_R01","map","OBXgrp().OBX()")="=2|2.5:OBX"',
      ].join("\n"),
    );
    const homes = d.structures.get("2.5:ORU_R01")!.get("OBX")!;
    expect(homes.map((h) => h.groupPath).sort()).toEqual(["OBRgrp", "OBXgrp"]);
  });

  test("a line with nothing recognisable in it is not counted at all", () => {
    const d = parseDump("Node: DEVHOST01\n\nDEV-NS>\nsomething else entirely\n");
    expect(d.mapEntries).toBe(0);
    expect(d.unparsed).toEqual([]);
    expect(d.ignored).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The one the rest depends on
// ---------------------------------------------------------------------------

describe("unreadable lines are counted, never dropped", () => {
  test("a subscript list that never closes is reported verbatim", () => {
    const d = parseDump(
      [
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","PID")="=03|2.3:PID"',
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","GT1()"',
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","NK1()")="=05,*|2.3:NK1"',
      ].join("\n"),
    );
    expect(d.mapEntries).toBe(2);
    expect(d.unparsed).toHaveLength(1);
    expect(d.unparsed[0]).toContain("GT1()");
  });

  test("an entry key this parser cannot decompose is reported, not skipped", () => {
    const d = parseDump(
      '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","IN1grp(.IN1")="=15|2.3:IN1"',
    );
    expect(d.mapEntries).toBe(0);
    expect(d.unparsed).toHaveLength(1);
  });

  test("an unterminated quoted subscript is reported", () => {
    const d = parseDump('^EnsHL7.Schema(2.3,"MS","ADT_A01","map","PID)="=03|2.3:PID"');
    expect(d.unparsed).toHaveLength(1);
  });

  test("the report says how many were lost, above the verdict", () => {
    const spec = base({ blocks: [{ id: "PID", wholeSegment: true, rows: [] }] });
    const text = [
      '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","MSH")="=01|2.3:MSH"',
      '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","PID")="=03|2.3:PID"',
      '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","GT1()"',
    ].join("\n");
    const dump = parseDump(text);
    const { bare } = bareSegments(spec);
    const report = renderReport(spec, dump, checkSpec(spec, dump, bare), "paste.zw");
    expect(report.text).toContain("1 ^EnsHL7.Schema line(s) could not be read");
    expect(report.text).toContain("1 unparsed");
    // Nothing DISAGREED, and it is still not an OK. `incomplete` is what the
    // exit code reads, so an answer computed from input that was partly
    // unreadable cannot be reported as a pass.
    expect(report.errors).toBe(0);
    expect(report.incomplete).toBe(true);
    expect(report.text).not.toMatch(/^OK\./m);
    expect(report.text).toContain("this is not an OK");
  });

  test("a fully readable dump is not flagged incomplete", () => {
    const spec = base({ blocks: [{ id: "PID", wholeSegment: true, rows: [] }] });
    const dump = parseDump(DUMP);
    const { bare } = bareSegments(spec);
    const report = renderReport(spec, dump, checkSpec(spec, dump, bare), "schema.zw");
    expect(report.incomplete).toBe(false);
    expect(report.text).toContain("OK.");
  });
});

// ---------------------------------------------------------------------------
// --diff: has the target drifted from what I develop against?
// ---------------------------------------------------------------------------

describe("--diff", () => {
  const only = (...entries: string[]) =>
    parseDump(
      entries.map((e) => `^EnsHL7.Schema(2.3,"MS","ADT_A01","map","${e}")="=x|2.3:x"`).join("\n"),
    );

  const TARGET = only("MSH", "PID", "GT1()", "NK1()", "IN1grp().IN1");

  test("two identical dumps are no difference at all", () => {
    const local = only("IN1grp().IN1", "NK1()", "GT1()", "PID", "MSH"); // same set, pasted in another order
    const f = diffDumps(TARGET, local, "target.txt", "local.txt");
    expect(f).toEqual([]);
    const r = renderDiff(TARGET, local, "target.txt", "local.txt", f);
    expect(r.errors).toBe(0);
    expect(r.incomplete).toBe(false);
    expect(r.text).toContain("OK.");
  });

  test("a segment only one instance has is a difference naming which", () => {
    const local = only("MSH", "PID", "GT1()", "NK1()");
    const f = diffDumps(TARGET, local, "target.txt", "local.txt");
    expect(f.map((x) => [x.code, x.subject])).toEqual([["segment-only", "IN1"]]);
    expect(f[0]!.text).toContain("in target.txt");
    expect(f[0]!.text).toContain("not in local.txt");
  });

  test("a repeat that differs between the two is a difference", () => {
    const local = only("MSH", "PID", "GT1", "NK1()", "IN1grp().IN1");
    const f = diffDumps(TARGET, local, "target.txt", "local.txt");
    expect(f.map((x) => [x.code, x.subject])).toEqual([["shape-differs", "GT1"]]);
    expect(f[0]!.text).toContain("repeats, at the top level in target.txt");
    expect(f[0]!.text).toContain("appears once, at the top level in local.txt");
    // Names the thing that actually differs. A group explanation on a repeat
    // difference is how an operator learns to stop reading the text.
    expect(f[0]!.text).toContain("occurrence index");
    expect(f[0]!.text).not.toContain("group name");
  });

  test("a group that differs between the two is a difference", () => {
    const local = only("MSH", "PID", "GT1()", "NK1()", "INSURANCEgrp().IN1");
    const f = diffDumps(TARGET, local, "target.txt", "local.txt");
    expect(f.map((x) => [x.code, x.subject])).toEqual([["shape-differs", "IN1"]]);
    expect(f[0]!.text).toContain("IN1grp");
    expect(f[0]!.text).toContain("INSURANCEgrp");
    expect(f[0]!.text).toContain("group name");
    expect(f[0]!.text).not.toContain("occurrence index");
  });

  test("a segment whose repeat AND group both moved says both", () => {
    const local = only("MSH", "PID", "GT1()", "NK1()", "INSURANCEgrp().IN1()");
    const f = diffDumps(TARGET, local, "target.txt", "local.txt");
    expect(f.map((x) => x.subject)).toEqual(["IN1"]);
    expect(f[0]!.text).toContain("occurrence index");
    expect(f[0]!.text).toContain("group name");
  });

  test("a structure present in one file only is a difference, not a crash", () => {
    const local = parseDump(
      [
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","MSH")="=01|2.3:MSH"',
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","PID")="=03|2.3:PID"',
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","GT1()")="=14,*|2.3:GT1"',
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","NK1()")="=05,*|2.3:NK1"',
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","IN1grp().IN1")="=15,*,1|2.3:IN1"',
        '^EnsHL7.Schema(2.5,"MS","ORU_R01","map","MSH")="=01|2.5:MSH"',
      ].join("\n"),
    );
    const f = diffDumps(TARGET, local, "target.txt", "local.txt");
    expect(f.map((x) => [x.code, x.subject])).toEqual([["structure-only", "2.5:ORU_R01"]]);
    expect(f[0]!.text).toContain("in local.txt and not in target.txt");
  });

  test("every difference is reported, not the first", () => {
    const local = only("MSH", "GT1", "IN1grp().IN1", "AL1()");
    const f = diffDumps(TARGET, local, "target.txt", "local.txt");
    // AL1 added, GT1 stopped repeating, NK1 and PID gone. All four.
    expect(f.map((x) => x.subject)).toEqual(["AL1", "GT1", "NK1", "PID"]);
    expect(renderDiff(TARGET, local, "target.txt", "local.txt", f).errors).toBe(4);
  });

  test("the direction is stable: swapping the files swaps the labels, not the count", () => {
    const local = only("MSH", "PID", "GT1", "NK1()");
    const ab = diffDumps(TARGET, local, "target.txt", "local.txt");
    const ba = diffDumps(local, TARGET, "local.txt", "target.txt");
    expect(ba.map((x) => x.subject)).toEqual(ab.map((x) => x.subject));
  });

  test("an unreadable line in either dump means the run is not a pass", () => {
    const local = parseDump(
      [
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","MSH")="=01|2.3:MSH"',
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","PID")="=03|2.3:PID"',
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","GT1()")="=14,*|2.3:GT1"',
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","NK1()")="=05,*|2.3:NK1"',
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","IN1grp().IN1")="=15,*,1|2.3:IN1"',
        '^EnsHL7.Schema(2.3,"MS","ADT_A01","map","AL1()"',
      ].join("\n"),
    );
    const f = diffDumps(TARGET, local, "target.txt", "local.txt");
    // Nothing DIFFERS among what was read, which is exactly the shape a lost
    // line hides in.
    expect(f).toEqual([]);
    const r = renderDiff(TARGET, local, "target.txt", "local.txt", f);
    expect(r.errors).toBe(0);
    expect(r.incomplete).toBe(true);
    expect(r.text).toContain("could not be read");
    expect(r.text).toContain("local.txt:");
    expect(r.text).not.toMatch(/^OK\./m);
  });
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

describe("the report", () => {
  const broken = base({
    blocks: [
      { id: "MSH", wholeSegment: true, rows: [{ target: "MSH-9.2", from: event() }] },
      { id: "GT1", wholeSegment: true, rows: [] },
      { id: "NK1", wholeSegment: true, rows: [] },
    ],
  });

  test("every problem is reported, not the first", () => {
    const f = findingsFor(broken).filter((x) => x.code === "bare-repeating");
    expect(f.map((x) => x.subject)).toEqual(["GT1", "NK1"]);
  });

  test("errors are counted and the text names each segment", () => {
    const dump = parseDump(DUMP);
    const { bare } = bareSegments(broken);
    const report = renderReport(broken, dump, checkSpec(broken, dump, bare), "schema.zw");
    expect(report.errors).toBe(2);
    expect(report.warnings).toBe(0);
    expect(report.text).toContain("GT1");
    expect(report.text).toContain("NK1");
    expect(report.text).toContain("2 error(s)");
  });

  test("a clean spec says so and counts nothing", () => {
    const clean = base({
      blocks: [
        { id: "MSH", wholeSegment: true, rows: [{ target: "MSH-9.2", from: event() }] },
        { id: "PID", wholeSegment: true, rows: [{ target: "PID-19", from: literal("") }] },
        { id: "GT1", wholeSegment: true, repeat: { over: "GT1" }, rows: [] },
      ],
    });
    const dump = parseDump(DUMP);
    const { bare } = bareSegments(clean);
    const report = renderReport(clean, dump, checkSpec(clean, dump, bare), "schema.zw");
    expect(report.errors).toBe(0);
    expect(report.warnings).toBe(0);
    expect(report.text).toContain("OK.");
    // The table is the evidence. Without it "OK" is an assertion.
    expect(report.text).toContain("SEGMENT");
    expect(report.text).toMatch(/GT1\s+repeat over GT1\s+repeats/);
  });

  test("the gate's own path counts as a segment the spec reads", () => {
    expect([...sourceSegments(base({ blocks: [] }))]).toEqual(["MSH"]);
  });

  test("findings come back in a stable order whatever the block order", () => {
    const a = base({
      blocks: [
        { id: "NK1", wholeSegment: true, rows: [] },
        { id: "GT1", wholeSegment: true, rows: [] },
      ],
    });
    const b = base({
      blocks: [
        { id: "GT1", wholeSegment: true, rows: [] },
        { id: "NK1", wholeSegment: true, rows: [] },
      ],
    });
    expect(findingsFor(a).map((f) => f.subject)).toEqual(findingsFor(b).map((f) => f.subject));
  });
});
