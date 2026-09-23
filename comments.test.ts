// bun test
//
// `iris.comments` decides how much of the WHY travels into the generated class.
// It must decide NOTHING else.
//
// The emitted class is roughly 40% comment by line, and the people who maintain
// it are the receiving site's IRIS team, not whoever ran the bench. So the
// default moved to `brief`. That is only a safe trade while the setting cannot
// change behaviour, and "cannot" here means tested rather than intended: a
// comment level that quietly drops a $$$ISERR check or an assign would be a
// silent production change wearing the costume of a formatting option.
//
// The load-bearing test in this file is `the levels differ only in comments`.
// Everything above it is a named instance of that property, kept because a
// property test that fails tells you THAT something moved and not WHAT.

import { expect, test, describe } from "bun:test";

import { emitIris } from "./emit/iris";
import { emitProcess } from "./emit/process";
import { copy, literal, todo, validate, COMMENT_LEVELS, type CommentLevel, type Spec } from "./spec";
import { fingerprint } from "./fingerprint";

/**
 * A spec exercising the shapes that carry comments: a guarded wholeSegment
 * block, a repeat, a labelled row, a required row and a note.
 */
const base = (comments?: CommentLevel, over: Partial<Spec> = {}): Spec => ({
  name: "Comment Level Test",
  description: "one sentence the receiving team will read",
  gate: { path: "MSH-9.2", permit: { A01: "A01", A08: "A08" } },
  iris: {
    className: "Site.Interface.DTL.Thing",
    sourceDocType: "2.3:ADT_A01",
    targetDocType: "2.3:ADT_A01",
    log: "warn",
    ...(comments ? { comments } : {}),
  },
  outOfScope: ["GT1, decided rather than overlooked"],
  blocks: [
    {
      id: "PID",
      wholeSegment: true,
      note: "the note is the engineer's own words",
      rows: [
        { target: "PID-3", from: copy("PID-3"), label: "MRN", required: true },
        { target: "PID-19", from: literal(""), label: "SSN (suppressed)" },
      ],
    },
    {
      id: "NK1",
      wholeSegment: true,
      repeat: { over: "NK1", skipWhenEmpty: "NK1-2" },
      rows: [{ target: "NK1-2", from: copy("NK1-2") }],
    },
  ],
  ...over,
});

/** The same spec with a business process, so the process header is covered. */
const withProcess = (comments?: CommentLevel): Spec => {
  const spec = base(comments);
  spec.iris.process = {
    className: "Site.Interface.Process.Thing",
    sendTo: "ToTarget.ADT.TCP",
    transform: "inline",
  };
  return spec;
};

/**
 * Every whole-line comment removed: `///`, `//`, `<!-- ... -->`.
 *
 * Whole-line only, deliberately. A comment level that tucked something into the
 * tail of a code line would survive this and show up as a difference, which is
 * the outcome we want -- the point is to catch a statement that moved, not to
 * launder one.
 */
function stripComments(cls: string): string {
  return cls
    .split("\n")
    .filter((l) => !/^\s*(\/\/\/|\/\/|<!--)/.test(l))
    .join("\n");
}

/**
 * The one line whose TEXT is allowed to move with the level, normalised.
 *
 * `emit/inline.ts` checks the status of every SetValueAt. The CHECK is
 * behaviour and runs at every level; its MESSAGE restates the field and label
 * at `full` and carries the path expression below it. Normalising the argument
 * lets the property test below assert what it is actually about: that the
 * STATEMENT is there, unchanged in shape, at every level.
 */
function normaliseWriteWarning(s: string): string {
  return s.replace(
    /\$\$\$LOGWARNING\((?:(?!\)\s*\}).)*\$SYSTEM\.Status\.GetErrorText\(tWriteSC\)\)/g,
    "$$$$$$LOGWARNING(<write-status message>)",
  );
}

/**
 * The fingerprint, blanked.
 *
 * `fingerprint.ts` hashes the WHOLE spec on purpose -- "the narrow version,
 * hash only the parts that change the ObjectScript, sounds tidier and is
 * worse". So writing `comments: "brief"` by hand is a different spec from
 * leaving it unset, even though both emit the same mapping, and the fingerprint
 * says so. That is the documented behaviour and it matches `iris.log`, which
 * has defaulted to "warn" and moved the hash when set explicitly since long
 * before this setting existed.
 *
 * It has to come out here so the comparisons below are about the CLASS rather
 * than about which keys the spec literal happened to spell out.
 */
function normaliseFingerprint(s: string): string {
  return s.replace(/Spec fingerprint: [0-9a-f]{12}/g, "Spec fingerprint: <fp>");
}

// ---------------------------------------------------------------------------

describe("the default", () => {
  test("an unconfigured spec emits brief", () => {
    // Everything but the fingerprint, which is a different fact -- see
    // `the fingerprint covers iris.comments` below.
    expect(normaliseFingerprint(emitIris(base()))).toBe(
      normaliseFingerprint(emitIris(base("brief"))),
    );
  });

  test("brief is genuinely shorter than full, which is the whole point", () => {
    const full = emitIris(base("full")).split("\n").length;
    const brief = emitIris(base("brief")).split("\n").length;
    expect(brief).toBeLessThan(full);
  });

  test("a level the emitter does not know is refused by name, not defaulted", () => {
    const spec = base();
    (spec.iris as { comments: string }).comments = "Brief";
    expect(validate(spec).some((p) => /iris\.comments is "Brief"/.test(p))).toBe(true);
  });
});

describe("the header stands at every level", () => {
  // A generated file nobody can match back to its spec is a file nobody can
  // trust, and that is a worse outcome than a verbose one. So the fingerprint
  // survives `off`, and so does the claim about where the class came from.
  for (const level of COMMENT_LEVELS) {
    test(`${level} still carries the fingerprint and the DocTypes`, () => {
      const cls = emitIris(base(level));
      expect(cls).toMatch(/Spec fingerprint: [0-9a-f]{12}/);
      expect(cls).toContain("2.3:ADT_A01");
    });
  }

  test("off keeps the header and drops the essay around it", () => {
    const cls = emitIris(base("off"));
    expect(cls).toMatch(/Spec fingerprint: [0-9a-f]{12}/);
    expect(cls).not.toContain("two-day hunt");
  });
});

describe("what brief cuts", () => {
  test("the seed preamble stops repeating itself for every wholeSegment block", () => {
    // The specific waste the user named: this second line was emitted verbatim
    // under every wholeSegment block in the class.
    const full = emitIris(base("full"));
    const brief = emitIris(base("brief"));
    expect(full).toContain("Fields not listed below are passed through unexamined");
    expect(brief).not.toContain("Fields not listed below are passed through unexamined");
  });

  test("the class header essay goes", () => {
    expect(emitIris(base("full"))).toContain("two-day hunt");
    expect(emitIris(base("brief"))).not.toContain("two-day hunt");
  });

  test("the IGNOREMISSINGSOURCE essay becomes one line, and the Parameter stays", () => {
    const brief = emitIris(base("brief"));
    expect(brief).toContain("Parameter IGNOREMISSINGSOURCE = 1;");
    expect(brief).not.toContain("at 2am, for being ordinary");
  });
});

describe("what brief keeps, because a maintainer cannot re-derive it", () => {
  const brief = emitIris(base("brief"));

  test("one label line per block", () => {
    expect(brief).toContain("PID: copied WHOLE");
    expect(brief).toContain("NK1: numbered by OUTPUT ordinal");
  });

  // The inline backend only. There the label rides inside the write-failure
  // message at `full`, and `brief` shortens that message to the path, so
  // without a line of its own the spec's own words for the field would be lost.
  //
  // The DTL never carried a label for a non-required row at ANY level, so
  // `brief` drops nothing there and a new label line would make the class
  // longer rather than shorter. See the note in `emit/iris.ts`.
  test("the suppression label, which only the spec knows (inline)", () => {
    expect(emitProcess(withProcess("brief"))).toContain("PID-19: SSN (suppressed)");
  });

  test("and it is not lost relative to full, which carried it in the log message", () => {
    expect(emitProcess(withProcess("full"))).toContain("SSN (suppressed)");
    expect(emitProcess(withProcess("brief"))).toContain("SSN (suppressed)");
  });

  test("the DTL adds no label line, because brief must shorten and not grow", () => {
    expect(emitIris(base("brief")).split("\n").length).toBeLessThan(
      emitIris(base("full")).split("\n").length,
    );
  });

  test("the engineer's own note", () => {
    expect(brief).toContain("the note is the engineer's own words");
  });

  test("decisions recorded as decisions", () => {
    expect(brief).toContain("GT1, decided rather than overlooked");
  });

  test("the gate rationale, in the process", () => {
    // "quit $$$OK" on a message this interface is not for reads like a
    // swallowed error until something says it is deliberate.
    expect(emitProcess(withProcess("brief"))).toContain("Refused, not failed");
  });

  test("the IsMutable reason, which costs a morning when it is missing", () => {
    const cls = emitProcess(withProcess("brief"));
    expect(cls).toContain("set tTarget.IsMutable = 1");
    expect(cls).toContain("immutable message");
  });

  test("the group name, when the spec places a source segment in one", () => {
    const spec = base("brief");
    spec.iris.sourceGroups = { NK1: "NK1grp" };
    expect(emitIris(spec)).toContain("NK1grp");
  });
});

describe("off is code only, with two stated exceptions", () => {
  test("the note and the essay both go", () => {
    const cls = emitIris(base("off"));
    expect(cls).not.toContain("the note is the engineer's own words");
    expect(cls).not.toContain("Fields not listed below");
  });

  // A todo row emits NO assign, so the comment is not commentary about the
  // row -- it is the only trace the row leaves. Dropping it would delete an
  // undecided field in silence, which is the failure todo() exists to prevent.
  test("a todo row still says so, because nothing else would", () => {
    const spec = base("off", {
      blocks: [{ id: "PID", rows: [{ target: "PID-8", from: todo("nobody has decided") }] }],
    });
    expect(emitIris(spec)).toContain("TODO PID-8: nobody has decided");
  });

  test("and the header, which always stays", () => {
    expect(emitIris(base("off"))).toMatch(/Spec fingerprint:/);
  });
});

describe("the write-status check is behaviour, not commentary", () => {
  // The user asked for the message to stop restating the label. The CHECK
  // itself is what stops a failed write being silent, so it runs everywhere.
  for (const level of COMMENT_LEVELS) {
    test(`${level} still checks every SetValueAt`, () => {
      const cls = emitProcess(withProcess(level));
      const writes = (cls.match(/tTarget\.SetValueAt\(/g) ?? []).length;
      const checks = (cls.match(/if \$\$\$ISERR\(tWriteSC\)/g) ?? []).length;
      expect(writes).toBeGreaterThan(0);
      expect(checks).toBe(writes);
    });
  }

  test("below full the message carries the path, not the restated label", () => {
    const brief = emitProcess(withProcess("brief"));
    // The path is spliced INSIDE the literal, not concatenated around it.
    // `"write failed "_"PID:19"_": "` is three constants the compiler joins
    // anyway and it reads like the generator could not be bothered.
    expect(brief).toContain(`$$$LOGWARNING("write failed PID:19: "`);
    expect(brief).not.toContain(`"write failed "_"PID:19"`);
    expect(brief).not.toContain("(SSN (suppressed)) could not be written");
  });

  test("at full it is what it has always been", () => {
    expect(emitProcess(withProcess("full"))).toContain(
      `PID-19 (SSN (suppressed)) could not be written`,
    );
  });
});

// ---------------------------------------------------------------------------
// THE PROPERTY. Everything above is an instance of this.
// ---------------------------------------------------------------------------

describe("the levels differ only in comments", () => {
  const artifacts: [string, (s: Spec) => string, (c?: CommentLevel) => Spec][] = [
    ["dtl", emitIris, base],
    ["process (inline)", emitProcess, withProcess],
    [
      "process (dtl)",
      emitProcess,
      (c?: CommentLevel) => {
        const spec = base(c);
        spec.iris.process = {
          className: "Site.Interface.Process.Thing",
          sendTo: "ToTarget.ADT.TCP",
        };
        return spec;
      },
    ],
  ];

  for (const [name, emit, mk] of artifacts) {
    test(`${name}: strip the comments and all three levels are byte-identical`, () => {
      const at = (level: CommentLevel) =>
        normaliseWriteWarning(stripComments(emit(mk(level))));

      expect(at("brief")).toBe(at("full"));
      expect(at("off")).toBe(at("full"));
    });

    test(`${name}: default and explicit brief differ in the fingerprint and nothing else`, () => {
      expect(normaliseFingerprint(emit(mk()))).toBe(normaliseFingerprint(emit(mk("brief"))));
    });
  }
});

// ---------------------------------------------------------------------------

describe("the fingerprint covers iris.comments", () => {
  // Pinned as a DECISION rather than left to be rediscovered.
  //
  // `fingerprint.ts` hashes the whole spec on purpose: "the narrow version --
  // hash only the parts that change the ObjectScript -- sounds tidier and is
  // worse". Excluding `comments` would mean two classes carrying ONE
  // fingerprint and different bytes, and the stale-compile check in the runbook
  // is "same fingerprint, same mapping". That check is the thing standing
  // between a mapping and a two-day hunt; it does not get a quiet exception.
  //
  // The cost is that writing `comments: "brief"` by hand moves the hash even
  // though the mapping is unchanged. `iris.log` has behaved this way since long
  // before this setting existed.
  test("setting it explicitly moves the hash, exactly as iris.log does", () => {
    expect(fingerprint(base("brief"))).not.toBe(fingerprint(base()));
    expect(fingerprint(base("full"))).not.toBe(fingerprint(base("brief")));
  });

  test("two specs that differ only in comment level are told apart", () => {
    const seen = new Set(COMMENT_LEVELS.map((l) => fingerprint(base(l))));
    expect(seen.size).toBe(COMMENT_LEVELS.length);
  });

  test("the class carries whichever hash its own spec produced", () => {
    for (const level of COMMENT_LEVELS) {
      expect(emitIris(base(level))).toContain(`Spec fingerprint: ${fingerprint(base(level))}`);
    }
  });
});
