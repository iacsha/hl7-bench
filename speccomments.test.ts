// bun test
//
// A GUI save used to delete every comment inside the spec literal. These pin
// the round trip: a comment read from transform.ts comes back in the same
// place, moves with its row, and never reaches anything that runs the spec.

import { expect, test, describe } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  attachComments, collectComments, extractComments, reinsertComments, specLiteral, stripComments,
} from "./speccomments";
import { endOfObject, rewriteTransform, specToSource } from "./serialize";
import { fingerprint } from "./fingerprint";
import { copy, validate, type Spec } from "./spec";

const LIT = `{
  name: "T",

  // Which messages this handles.
  gate: {
    path: "MSH-9.2",
    permit: {
      A01: "A28", // registration
      A08: "A31", // update
    },
  },

  /**
   * Where the schema keeps things.
   */
  iris: { className: "T.D", sourceDocType: "2.5:ADT_A01", targetDocType: "2.5:ADT_A01" },

  blocks: [
    // the header
    { id: "MSH", wholeSegment: true, rows: [] },
    {
      // the patient
      id: "PID",
      rows: [
        // medical record number
        { target: "PID-3", from: copy("PID-3") },
        { target: "PID-5", from: copy("PID-5") }, // name as sent
      ],
    },
    { id: "OBX", rows: [] },
    // second OBX block
    { id: "OBX", continuesNumbering: true, rows: [] },
  ],
}`;

describe("extractComments", () => {
  const m = extractComments(LIT);

  test("a comment above a key is pinned to its path", () => {
    expect(m["gate"]).toEqual({ above: "Which messages this handles." });
  });

  test("an end-of-line comment is pinned to the first thing on that line", () => {
    expect(m["gate.permit.A01"]).toEqual({ after: "registration" });
    expect(m["blocks[PID].rows[PID-5]"]).toEqual({ after: "name as sent" });
  });

  test("a /** */ block loses its markers, not its words", () => {
    expect(m["iris"]).toEqual({ above: "Where the schema keeps things." });
  });

  test("blocks and rows are named by id and target, not position", () => {
    expect(m["blocks[MSH]"]).toEqual({ above: "the header" });
    expect(m["blocks[PID].rows[PID-3]"]).toEqual({ above: "medical record number" });
  });

  test("a repeated block id is told apart by occurrence", () => {
    expect(m["blocks[OBX#2]"]).toEqual({ above: "second OBX block" });
  });

  test("a comment just inside a block's brace is the block's", () => {
    expect(m["blocks[PID].id"]).toEqual({ above: "the patient" });
    const spec = attachComments({ blocks: [{ id: "PID", rows: [] }] }, { "blocks[PID].id": { above: "the patient" } });
    expect((spec.blocks[0] as Record<string, unknown>)["//"]).toEqual({ above: "the patient" });
  });
});

describe("on the value", () => {
  const spec = (): Spec => ({
    name: "T",
    gate: { path: "MSH-9.2", permit: { A01: "A28" } },
    iris: { className: "T.D", sourceDocType: "2.5:ADT_A01", targetDocType: "2.5:ADT_A01" },
    blocks: [{ id: "PID", rows: [{ target: "PID-3", from: copy("PID-3") }, { target: "PID-5", from: copy("PID-5") }] }],
  });

  test("a row's comment rides on the row, a section's on the root", () => {
    const s = attachComments(spec(), { "blocks[PID].rows[PID-5]": { above: "name" }, gate: { above: "g" } });
    expect((s.blocks[0]!.rows[1] as unknown as Record<string, unknown>)["//"]).toEqual({ above: "name" });
    expect((s as unknown as Record<string, unknown>)["//"]).toEqual({ gate: { above: "g" } });
  });

  test("a comment follows its row when the target is renamed and the row moves", () => {
    const s = attachComments(spec(), { "blocks[PID].rows[PID-5]": { above: "name" } });
    const rows = s.blocks[0]!.rows;
    rows[1]!.target = "PID-6";
    rows.reverse();
    expect(collectComments(s)).toEqual({ "blocks[PID].rows[PID-6]": { above: "name" } });
  });

  test("stripped, nothing that runs the spec can tell", () => {
    const s = attachComments(spec(), { "blocks[PID].rows[PID-3]": { above: "x" }, gate: { above: "g" } });
    const clean = stripComments(s);
    expect(JSON.stringify(clean)).not.toContain(`"//"`);
    expect(fingerprint(clean)).toBe(fingerprint(spec()));
    expect(validate(clean)).toEqual([]);
  });
});

describe("reinsertComments", () => {
  test("above the line, at its indent, and at the end of a line", () => {
    const text = `export const spec: Spec = {\n  gate: {\n    path: "X",\n  },\n};`;
    const out = reinsertComments(text, { gate: { above: "one\n\ntwo" }, "gate.path": { after: "why" } });
    expect(out).toBe(`export const spec: Spec = {\n  // one\n  //\n  // two\n  gate: {\n    path: "X",  // why\n  },\n};`);
  });

  test("a comment whose place is gone is kept at the top, labelled", () => {
    const text = `export const spec: Spec = {\n  name: "T",\n};`;
    const out = reinsertComments(text, { "tables.Gone": { above: "was here" } });
    expect(out).toContain(`  // [was at tables.Gone] was here`);
  });

  test("no comments, no change", () => {
    expect(reinsertComments("a\nb", {})).toBe("a\nb");
  });
});

// The whole save, on the tracked demo spec: every comment back, the value
// unchanged, and a second save identical to the first.
describe("a GUI save of the demo spec", () => {
  const file = readFileSync(join(import.meta.dir, "transform.ts"), "utf8");
  const lit = (s: string) => {
    const at = specLiteral(s, endOfObject)!;
    return s.slice(at.open, at.close + 1);
  };
  const words = (m: Record<string, { above?: string; after?: string }>) =>
    Object.values(m).flatMap((c) => `${c.above ?? ""}\n${c.after ?? ""}`.split("\n")).map((l) => l.trim()).filter(Boolean).sort();

  const save = async (src: string, tag: string) => {
    const tmp = join(import.meta.dir, `zz-save-${tag}.ts`);
    writeFileSync(tmp, src);
    try {
      const mod = await import(`${tmp}?${Math.random()}`);
      return { out: rewriteTransform(src, attachComments(structuredClone(mod.spec), extractComments(lit(src)))), spec: mod.spec as Spec };
    } finally {
      rmSync(tmp, { force: true });
    }
  };

  test("keeps every comment and the value, and is stable", async () => {
    const first = await save(file, "a");
    const second = await save(first.out, "b");
    expect(words(extractComments(lit(first.out)))).toEqual(words(extractComments(lit(file))));
    expect(fingerprint(second.spec)).toBe(fingerprint(first.spec));
    expect(second.out).toBe(first.out);
  });
});

describe("found on the way", () => {
  // A GUI save printed no bridgelink key, so it deleted the channel name.
  test("bridgelink survives a GUI save", () => {
    const s: Spec = {
      name: "T",
      gate: { path: "MSH-9.2", permit: { A01: "A28" } },
      bridgelink: { channelName: "Chan", log: "warn" },
      iris: { className: "T.D", sourceDocType: "2.5:ADT_A01", targetDocType: "2.5:ADT_A01" },
      blocks: [],
    };
    expect(specToSource(s)).toContain(`  bridgelink: {\n    channelName: "Chan",\n    log: "warn",\n  },`);
  });

  test("a permit table with a commented key prints one key per line", () => {
    const s: Spec = {
      name: "T",
      gate: { path: "MSH-9.2", permit: { A01: "A28", A08: "A31" } },
      iris: { className: "T.D", sourceDocType: "2.5:ADT_A01", targetDocType: "2.5:ADT_A01" },
      blocks: [],
    };
    expect(specToSource(s)).toContain(`permit: { A01: "A28", A08: "A31" }`);
    expect(specToSource(s, new Set(["gate.permit"]))).toContain(`permit: {\n      A01: "A28",\n      A08: "A31",\n    }`);
  });
});

describe("the GUI", () => {
  const html = readFileSync(join(import.meta.dir, "gui.html"), "utf8");
  test("has a // toggle on segments and rows, and a section panel", () => {
    expect(html).toContain("const blockCmt = commentToggle(block);");
    expect(html).toContain("const rowCmt = commentToggle(row);");
    expect(html).toContain("// ---- section comments");
  });

  test("no longer says comments are lost", () => {
    expect(html).not.toContain("Comments written inside that literal are lost");
  });
});
