/**
 * serialize.test.ts -- the spec has to survive the trip out of the GUI.
 *
 * Two properties matter here, and a break in either one is silent. The value
 * that comes back has to be the value that went in, or the GUI quietly edits
 * your interface. And every byte of `transform.ts` OUTSIDE the spec literal has
 * to survive, or a save deletes prose, helpers, or imports that the file needs
 * and nothing says so until a message fails.
 */

import { expect, test, describe } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Message } from "./hl7";
import {
  validate,
  copy, literal, firstOf, lookup, counter, event, pickRepeat, fromFirst, todo,
  blank, passthrough, constant,
  date8, truncate, upper, stripDelims, stripChars, defaultTo,
  type Spec,
} from "./spec";
import { runSpec } from "./run";
import {
  constructorsUsed, specToSource, importLine, endOfObject, rewriteTransform,
} from "./serialize";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MSG = [
  "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260819101500||ADT^A01|MSG0001|P|2.3",
  "PID|1||MRN9^^^MR||doe^john^q||19800101|M|||123 fake st",
  "PV1|1|I|WARD^101^A||||1234^SMITH^JOHN^^^^MT~9876543210^SMITH^JOHN^^^^NPI|||||||||||V123",
  "NK1|1|||||",
  "NK1|2|ROE^JANE|SPO",
  "IN1|1|PLANA||||||||||||||||||||||||||||||||||POL1",
].join("\r\n");

const msg = () => new Message(MSG);

const base = (over: Partial<Spec> = {}): Spec => ({
  name: "Test Interface",
  gate: { path: "MSH-9.2", permit: { A01: "A28", A08: "A31" } },
  iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3.1:ADT_A05" },
  tables: { Sex: { M: "1", F: "2" } },
  blocks: [{ id: "MSH", rows: [{ target: "MSH-3", from: literal("BENCH") }] }],
  ...over,
});

/**
 * Every source kind, every step kind, a group, a repeat with both of its
 * options, an odd table name, an inventory and an out-of-scope note.
 *
 * A kind nobody round-trips is a kind whose printer is untested, and the way
 * that shows up in the field is a GUI save that drops one field out of forty.
 */
const rich = (): Spec => ({
  name: "Rich Interface",
  description: "Every kind, so no printer goes unexercised.",
  gate: {
    path: "MSH-9.2",
    permit: { A01: "A28", A08: "A31" },
    require: [{ path: "MSH-9.1", equals: "ADT" }],
  },
  iris: {
    className: "Test.Rich",
    sourceDocType: "2.3:ADT_A01",
    targetDocType: "2.3.1:ADT_A05",
    create: "new",
    log: "trace",
  },
  tables: {
    Sex: { M: "1", F: "2" },
    "Odd-Name": { A: "B" },
  },
  blocks: [
    {
      id: "MSH",
      note: "header",
      rows: [
        { target: "MSH-3", from: literal("BENCH") },
        { target: "MSH-4", label: "Sending Facility", from: copy("MSH-4"), required: true },
        { target: "MSH-9.2", from: event() },
        { target: "MSH-7", from: copy("MSH-7"), via: [date8()] },
      ],
    },
    {
      id: "PID",
      rows: [
        { target: "PID-5", from: firstOf("PID-5", "PID-9"), via: [upper(), truncate(8)] },
        { target: "PID-8", from: lookup("Sex", "PID-8", blank()) },
        { target: "PID-2", from: lookup("Sex", "PID-8", passthrough()) },
        { target: "PID-6", from: lookup("Sex", "PID-8", constant("U")) },
        {
          target: "PID-11",
          from: copy("PID-11"),
          via: [stripDelims(), stripChars("- "), defaultTo("X")],
        },
        { target: "PID-19", from: todo("no agreed code set yet"), note: "raise on the next call" },
      ],
    },
    {
      id: "PV1",
      rows: [
        { target: "PV1-7", from: pickRepeat("PV1-7", 13, "NPI") },
        { target: "PV1-8", from: pickRepeat("PV1-7", 13, "MT", 2) },
        { target: "PV1-9", from: pickRepeat("PV1-7", 13, "NPI", [1, 2, 3]) },
      ],
    },
    {
      id: "NK1",
      repeat: { over: "NK1" },
      rows: [
        { target: "NK1-1", from: counter() },
        { target: "NK1-2", from: fromFirst("NK1", "NK1-2", "NK1-2") },
      ],
    },
    {
      id: "IN1",
      group: "INSURANCEgrp",
      repeat: { over: "IN1", skipWhenEmpty: "IN1-2", max: 3 },
      rows: [{ target: "IN1-1", from: counter() }],
    },
  ],
  sourceInventory: [
    { path: "PID-19", label: "SSN", required: true, note: "sender says it is always present" },
    { path: "PID-10", label: "Race" },
  ],
  outOfScope: ["PID-16 marital status, no agreed code set yet"],
});

/**
 * Key order is an artifact of how an object was built, not part of its meaning.
 * Comparing raw JSON would fail on a difference nobody can see.
 */
const stable = (o: unknown) =>
  JSON.stringify(o, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );

let tmpCount = 0;

/** Print the spec to a real file, import it back, hand back what came out. */
async function roundTrip(spec: Spec): Promise<Spec> {
  // The printed file lives outside the repo, so a bare "./spec" would not
  // resolve from there. Pointing the import at spec.ts by absolute URL keeps
  // the temp file out of the working tree, and exercises importLine's `from`
  // argument while it is there.
  const from = pathToFileURL(join(import.meta.dir, "spec.ts")).href;
  const file = `${importLine(spec, from)}\n\n${specToSource(spec)}\n`;
  const path = join(tmpdir(), `hl7-bench-roundtrip-${process.pid}-${tmpCount++}.ts`);
  // Imported from a real file rather than eval'd, because the thing under test
  // is whether Bun can PARSE what we printed, not whether we can.
  writeFileSync(path, file, "utf8");
  try {
    const mod = await import(pathToFileURL(path).href);
    return mod.spec as Spec;
  } finally {
    rmSync(path, { force: true });
  }
}

// ---------------------------------------------------------------------------
// The printer
// ---------------------------------------------------------------------------

describe("the serializer", () => {
  test("a spec using every kind survives the trip out and back", async () => {
    const before = rich();
    expect(stable(await roundTrip(before))).toBe(stable(before));
  });

  test("iris.log survives, because a dropped one changes what IRIS logs", async () => {
    // The iris block is printed field by field rather than dumped, so every
    // field needs its own line in the printer. A field the printer forgets is
    // not a crash: the GUI saves, the spec loads, and the setting is just gone.
    // Called out separately from the rich round-trip so the failure names it.
    const back = await roundTrip(base({
      iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3.1:ADT_A05", log: "off" },
    }));
    expect(back.iris.log).toBe("off");
  });

  test("what comes back still validates and still runs", async () => {
    const back = await roundTrip(rich());
    expect(validate(back)).toEqual([]);
    expect(() => runSpec(back, msg())).not.toThrow();
  });

  test("printing twice prints the same thing", () => {
    // Idempotence is what makes a GUI save reviewable in a diff. A printer that
    // drifted would touch lines nobody edited on every save.
    const spec = rich();
    expect(specToSource(spec)).toBe(specToSource(spec));
  });

  test("the import line lists what the spec uses and nothing else", () => {
    const spec = base({
      blocks: [{
        id: "PID",
        rows: [{ target: "PID-8", from: lookup("Sex", "PID-8", constant("U")), via: [upper()] }],
      }],
    });
    expect(constructorsUsed(spec)).toEqual(["lookup", "constant", "upper"]);
    const line = importLine(spec);
    expect(line).toContain("lookup");
    expect(line).toContain("constant");
    expect(line).toContain("upper");
    expect(line).not.toContain("copy");
    expect(line).toContain("type Spec");
  });

  test("the import line is ordered by the vocabulary, not by where you added a row", () => {
    // Otherwise adding a row at the top of a block reorders the import, and the
    // diff shows a line nobody meant to touch.
    const rows = [
      { target: "PID-1", from: copy("PID-1") },
      { target: "PID-2", from: literal("X") },
    ];
    const a = base({ blocks: [{ id: "PID", rows }] });
    const b = base({ blocks: [{ id: "PID", rows: [...rows].reverse() }] });
    expect(importLine(a)).toBe(importLine(b));
  });

  test("a long import list wraps instead of running off the screen", async () => {
    const line = importLine(rich());
    expect(line).toContain("\n");
    // Still has to parse, which is the only reason the wrapping matters.
    expect(stable(await roundTrip(rich()))).toBe(stable(rich()));
  });

  test("pickRepeat omits the take when it is the constructor default", () => {
    const src = specToSource(base({
      blocks: [{ id: "PV1", rows: [{ target: "PV1-7", from: pickRepeat("PV1-7", 13, "NPI") }] }],
    }));
    expect(src).toContain('pickRepeat("PV1-7", 13, "NPI")');
    expect(src).not.toContain('"whole"');
  });

  test("a component list take round-trips as a list", async () => {
    const spec = base({
      blocks: [{ id: "PV1", rows: [{ target: "PV1-7", from: pickRepeat("PV1-7", 13, "NPI", [1, 2]) }] }],
    });
    const back = await roundTrip(spec);
    expect((back.blocks[0].rows[0].from as { take: unknown }).take).toEqual([1, 2]);
  });

  test("empty tables still print, because an empty table is a finding", () => {
    // Dropping them would hide the exact thing emptyTables() exists to report.
    expect(specToSource(base({ tables: { Sex: {} } }))).toContain("Sex: {}");
  });

  test("a table name that is not an identifier is quoted", () => {
    expect(specToSource(base({ tables: { "Odd-Name": { A: "B" } } }))).toContain('"Odd-Name"');
  });
});

// ---------------------------------------------------------------------------
// Splicing back into an existing transform.ts
// ---------------------------------------------------------------------------

describe("rewriting transform.ts", () => {
  const FILE = [
    "/**",
    " * A doc comment nobody wants regenerated.",
    " */",
    "",
    'import type { Message } from "./hl7";',
    'import { runSpec } from "./run";',
    'import { copy, type Spec } from "./spec";',
    "",
    "export const spec: Spec = {",
    '  name: "Old",',
    '  gate: { path: "MSH-9.2", permit: { A01: "A01" } },',
    '  iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3:ADT_A01" },',
    '  blocks: [{ id: "MSH", rows: [{ target: "MSH-3", from: copy("MSH-3") }] }],',
    "};",
    "",
    "// A helper below the spec.",
    "export function transform(msg: Message): void {",
    "  runSpec(spec, msg);",
    "}",
    "",
  ].join("\n");

  const HEADER = FILE.slice(0, FILE.indexOf("import type"));
  const FOOTER = FILE.slice(FILE.indexOf("// A helper below the spec."));

  test("everything above and below the literal is byte identical", () => {
    const out = rewriteTransform(FILE, base());
    expect(out.startsWith(HEADER)).toBe(true);
    expect(out.endsWith(FOOTER)).toBe(true);
  });

  test("imports declared above the spec import are left alone", () => {
    // Regression, and it cost a debugging session. A lazy brace body starts at
    // the FIRST `import {` in the file and stretches to the nearest
    // `} from "./spec"`, deleting every named import in between. The file still
    // parsed. It threw `runSpec is not defined` on the first message instead.
    const out = rewriteTransform(FILE, base());
    expect(out).toContain('import { runSpec } from "./run";');
    expect(out).toContain('import type { Message } from "./hl7";');
  });

  test("the spec import is regenerated, because a stale one is a compile error", () => {
    const out = rewriteTransform(FILE, base({
      blocks: [{ id: "PID", rows: [{ target: "PID-8", from: lookup("Sex", "PID-8", blank()) }] }],
    }));
    expect(out).toContain("lookup");
    expect(out).toContain("blank");
    expect(out).not.toContain("import { copy, type Spec }");
  });

  test("rewriting twice changes nothing the second time", () => {
    const once = rewriteTransform(FILE, base());
    expect(rewriteTransform(once, base())).toBe(once);
  });

  test("the new spec is what lands on disk", () => {
    const out = rewriteTransform(FILE, base({ name: "New" }));
    expect(out).toContain('name: "New"');
    expect(out).not.toContain('name: "Old"');
  });

  test("the semicolon is not doubled", () => {
    expect(rewriteTransform(FILE, base())).not.toContain("};;");
  });

  test("a file with no spec declaration is refused, not guessed at", () => {
    // The caller overwrites transform.ts with whatever comes back, so a wrong
    // answer here is somebody's afternoon.
    expect(() => rewriteTransform('import { copy } from "./spec";\n', base()))
      .toThrow(/export const spec/);
  });

  test("a file with no spec import is refused", () => {
    const noImport = FILE.replace('import { copy, type Spec } from "./spec";', "");
    expect(() => rewriteTransform(noImport, base())).toThrow(/import/);
  });

  test("an unbalanced literal is refused", () => {
    const broken = FILE.replace("};\n\n// A helper", "\n\n// A helper");
    expect(() => rewriteTransform(broken, base())).toThrow(/brace/);
  });
});

// ---------------------------------------------------------------------------
// Finding the end of the literal
// ---------------------------------------------------------------------------

describe("finding the end of the spec literal", () => {
  test("a brace inside a string does not end the object", () => {
    const src = 'x = { a: "}", b: 1 };';
    expect(endOfObject(src, src.indexOf("{"))).toBe(src.lastIndexOf("}"));
  });

  test("an escaped quote does not end the string", () => {
    const src = 'x = { a: "\\"}", b: 1 };';
    expect(endOfObject(src, src.indexOf("{"))).toBe(src.lastIndexOf("}"));
  });

  test("a brace inside a line comment does not end the object", () => {
    const src = "x = {\n  // }\n  a: 1,\n};";
    expect(endOfObject(src, src.indexOf("{"))).toBe(src.lastIndexOf("}"));
  });

  test("a brace inside a block comment does not end the object", () => {
    const src = "x = {\n  /* } */\n  a: 1,\n};";
    expect(endOfObject(src, src.indexOf("{"))).toBe(src.lastIndexOf("}"));
  });

  test("nested objects close in the right order", () => {
    const src = "x = { a: { b: { c: 1 } } };";
    expect(endOfObject(src, src.indexOf("{"))).toBe(src.lastIndexOf("}"));
  });

  test("an unclosed object reports failure instead of a plausible index", () => {
    expect(endOfObject("x = { a: 1", 4)).toBe(-1);
  });
});
