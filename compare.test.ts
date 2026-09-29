// bun test
//
// The claim this file exists to defend is the aggregation rule: ONE MESSAGE
// COUNTS ONCE PER FIELD, however many occurrences of that field differed. Get
// that wrong and the headline number stops meaning anything -- a single message
// with forty differing OBX repeats would read as forty messages, which is the
// difference between "one bad message" and "a systematic mapping error" and the
// only reason anyone runs this instead of reading diffs by hand.
//
// The second claim worth a test is that nothing is dropped silently: the ignore
// list is printed, the every-message stamp is FLAGGED rather than removed, and
// examples beyond the cap are counted in `distinct` rather than vanishing.

import { expect, test, describe } from "bun:test";

import { Message } from "./hl7";
import {
  diffFields, diffSegmentCounts, accumulate, render,
  type Cell, type FieldRow, type Report,
} from "./compare";

const MSH = "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260819101500||ADT^A01|MSG0001|P|2.3";

const msg = (...lines: string[]) => new Message([MSH, ...lines].join("\r\n"));

/** A Report with only the fields the assertion under test cares about. */
const report = (over: Partial<Report> = {}): Report => ({
  pairs: 0, compared: 0, refused: [], unreadable: [],
  fields: [], counts: [], ignored: [],
  ...over,
});

const row = (over: Partial<FieldRow> = {}): FieldRow => ({
  path: "PID-5", messages: 1, distinct: 1,
  examples: [{ case: "c1", occurrence: 1, got: "A", want: "B" }],
  ...over,
});

// ---------------------------------------------------------------------------

describe("diffFields", () => {
  test("identical messages differ nowhere", () => {
    const a = msg("PID|1||MRN9^^^MR||DOE^JOHN");
    const b = msg("PID|1||MRN9^^^MR||DOE^JOHN");
    expect(diffFields(a, b)).toEqual([]);
  });

  test("one changed field is reported once, with both values", () => {
    const got = msg("PID|1||MRN9^^^MR||DOE^JOHN");
    const want = msg("PID|1||MRN9^^^MR||DOE^JANE");
    expect(diffFields(got, want)).toEqual([
      { path: "PID-5", occurrence: 1, got: "DOE^JOHN", want: "DOE^JANE" },
    ]);
  });

  // The failure the whole tool was built for: the spec stops writing a trailing
  // field. getField returns "" past the end of a segment, so walking only `got`
  // would compare nothing and report clean.
  test("a field the spec stopped writing shows as empty against the old value", () => {
    const got = msg("OBR|1|||||||||||||||||||||||F");
    const want = msg("OBR|1|||||||||||||||||||||||F|C");
    const cells = diffFields(got, want);
    expect(cells).toEqual([{ path: "OBR-25", occurrence: 1, got: "", want: "C" }]);
  });

  test("MSH is compared without the off-by-one", () => {
    const got = new Message(MSH);
    const want = new Message(MSH.replace("ADT^A01", "ADT^A08"));
    expect(diffFields(got, want)).toEqual([
      { path: "MSH-9", occurrence: 1, got: "ADT^A01", want: "ADT^A08" },
    ]);
  });

  test("repeating segments align by order of appearance", () => {
    const got = msg("OBX|1|ST|A||one", "OBX|2|ST|B||two", "OBX|3|ST|C||THREE");
    const want = msg("OBX|1|ST|A||one", "OBX|2|ST|B||two", "OBX|3|ST|C||three");
    expect(diffFields(got, want)).toEqual([
      { path: "OBX-5", occurrence: 3, got: "THREE", want: "three" },
    ]);
  });

  test("ignore suppresses a path and nothing else", () => {
    const got = msg("PID|1||MRN9||DOE^JOHN");
    const want = msg("PID|2||MRN9||DOE^JANE");
    expect(diffFields(got, want).map((c) => c.path)).toEqual(["PID-1", "PID-5"]);
    expect(diffFields(got, want, new Set(["PID-1"])).map((c) => c.path)).toEqual(["PID-5"]);
  });

  // Surplus occurrences belong to diffSegmentCounts. If they leaked in here,
  // every field of a missing OBX would report as a difference and one absent
  // segment would look like six mapping errors.
  test("surplus occurrences are not compared as fields", () => {
    const got = msg("OBX|1|ST|A||one");
    const want = msg("OBX|1|ST|A||one", "OBX|2|ST|B||two");
    expect(diffFields(got, want)).toEqual([]);
    expect(diffSegmentCounts(got, want)).toEqual([{ id: "OBX", got: 1, want: 2 }]);
  });

  test("a segment id present on only one side is a count difference", () => {
    const got = msg("PID|1");
    const want = msg("PID|1", "PV1|1|I");
    expect(diffSegmentCounts(got, want)).toEqual([{ id: "PV1", got: 0, want: 1 }]);
  });
});

// ---------------------------------------------------------------------------

describe("accumulate", () => {
  const cell = (over: Partial<Cell> = {}): Cell =>
    ({ path: "OBX-5", occurrence: 1, got: "A", want: "B", ...over });

  // THE headline claim.
  test("three differing occurrences in one message count as one message", () => {
    const totals = new Map<string, FieldRow>();
    accumulate(totals, "c1", [
      cell({ occurrence: 1 }),
      cell({ occurrence: 2 }),
      cell({ occurrence: 3 }),
    ]);
    expect(totals.get("OBX-5")!.messages).toBe(1);
  });

  test("the same field differing in two messages counts as two", () => {
    const totals = new Map<string, FieldRow>();
    accumulate(totals, "c1", [cell()]);
    accumulate(totals, "c2", [cell()]);
    expect(totals.get("OBX-5")!.messages).toBe(2);
  });

  test("one mapping error across many messages stays distinct 1", () => {
    const totals = new Map<string, FieldRow>();
    for (let i = 0; i < 50; i++) accumulate(totals, `c${i}`, [cell()]);
    const r = totals.get("OBX-5")!;
    expect(r.messages).toBe(50);
    expect(r.distinct).toBe(1);
    expect(r.examples).toHaveLength(1);
  });

  test("examples are capped but the excess is counted, not dropped", () => {
    const totals = new Map<string, FieldRow>();
    for (let i = 0; i < 10; i++) {
      accumulate(totals, `c${i}`, [cell({ got: `G${i}`, want: `W${i}` })]);
    }
    const r = totals.get("OBX-5")!;
    expect(r.examples).toHaveLength(3);
    expect(r.distinct).toBe(10);
  });

  test("different fields accumulate independently", () => {
    const totals = new Map<string, FieldRow>();
    accumulate(totals, "c1", [cell({ path: "OBX-5" }), cell({ path: "OBR-25" })]);
    accumulate(totals, "c2", [cell({ path: "OBX-5" })]);
    expect(totals.get("OBX-5")!.messages).toBe(2);
    expect(totals.get("OBR-25")!.messages).toBe(1);
  });

  test("the first example records which case and occurrence it came from", () => {
    const totals = new Map<string, FieldRow>();
    accumulate(totals, "adt-0042", [cell({ occurrence: 4 })]);
    expect(totals.get("OBX-5")!.examples[0]).toEqual({
      case: "adt-0042", occurrence: 4, got: "A", want: "B",
    });
  });
});

// ---------------------------------------------------------------------------

describe("render", () => {
  test("a clean run says so rather than printing an empty table", () => {
    const out = render(report({ pairs: 100, compared: 100 }));
    expect(out).toContain("100 of 100 pairs compared");
    expect(out).toContain("No field differences.");
  });

  test("nothing compared is not the same as nothing differing", () => {
    const out = render(report({ pairs: 5, compared: 0, refused: [{ case: "a", why: "gate" }] }));
    expect(out).toContain("No messages were compared.");
    expect(out).not.toContain("No field differences.");
  });

  test("the ignore list is always stated, either way", () => {
    expect(render(report())).toContain("ignoring nothing");
    expect(render(report({ ignored: ["MSH-10", "MSH-7"] }))).toContain("ignoring MSH-10, MSH-7");
  });

  test("refusals are stated in the header, not only in the tail", () => {
    const out = render(report({ pairs: 10, compared: 6, refused: Array.from({ length: 4 }, (_, i) => ({ case: `c${i}`, why: "not permitted" })) }));
    expect(out).toContain("6 of 10 pairs compared");
    expect(out).toContain("4 refused by the gate");
  });

  // Flagged, not removed. Removing it by default is the one shortcut that would
  // hide a real MSH-10 mapping change on the day one happens.
  test("a field differing in every message is flagged as a likely stamp", () => {
    const out = render(report({ pairs: 20, compared: 20, fields: [row({ path: "MSH-10", messages: 20 })] }));
    expect(out).toContain("differs in EVERY message");
    expect(out).toContain("--ignore MSH-10");
  });

  test("a field differing in most but not all messages is not flagged", () => {
    const out = render(report({ pairs: 20, compared: 20, fields: [row({ path: "OBR-25", messages: 19 })] }));
    expect(out).not.toContain("differs in EVERY message");
  });

  test("the percentage is of messages compared, not of pairs found", () => {
    const out = render(report({ pairs: 200, compared: 100, fields: [row({ messages: 50 })] }));
    expect(out).toContain("50%");
  });

  test("truncated examples are announced with a count", () => {
    const out = render(report({ compared: 9, fields: [row({ messages: 9, distinct: 9 })] }));
    expect(out).toContain("and 8 more distinct value pair(s)");
  });

  test("an empty value renders as a visible token, not as nothing", () => {
    const out = render(report({
      compared: 1,
      fields: [row({ examples: [{ case: "c1", occurrence: 1, got: "", want: "F" }] })],
    }));
    expect(out).toContain("got  (empty)");
    expect(out).toContain("want F");
  });

  test("segment count differences get their own section", () => {
    const out = render(report({
      compared: 10,
      counts: [{ id: "OBX", messages: 3, examples: [{ case: "c1", got: 1, want: 2 }] }],
    }));
    expect(out).toContain("SEGMENT COUNT DIFFERENCES");
    expect(out).toContain("OBX  in 3 message(s)");
  });

  test("long lists of refusals are truncated with a count", () => {
    const refused = Array.from({ length: 25 }, (_, i) => ({ case: `c${i}`, why: "not permitted" }));
    const out = render(report({ pairs: 25, compared: 0, refused }));
    expect(out).toContain("... and 15 more");
  });
});
