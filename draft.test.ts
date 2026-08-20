// bun test
//
// The autosave draft has one job that matters more than the rest: never be
// mistaken for a save. Everything below is a test of that boundary from some
// angle -- the draft is written somewhere else, it survives an invalid spec, it
// stops offering itself the moment transform.ts moves on, and it never carries
// the message pane. Each of those is a decision that would be silent if it
// broke, which is why it is tested rather than trusted.

import { expect, test, describe, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { literal, type Spec } from "./spec";
import { DRAFT_VERSION, discardDraft, draftPath, readDraft, writeDraft } from "./draft";

const DIR = import.meta.dir;

// A transform file that is not the real transform.ts. Every test here writes
// and deletes files, and pointing them at the real one would make a failing
// test destroy work.
const FAKE = join(DIR, ".draft-test-transform.ts");
const OTHER = join(DIR, ".draft-test-other.ts");

const base = (over: Partial<Spec> = {}): Spec => ({
  name: "Draft Test Interface",
  gate: { path: "MSH-9.2", permit: { A01: "A28" } },
  iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3.1:ADT_A05" },
  tables: {},
  blocks: [{ id: "MSH", rows: [{ target: "MSH-3", from: literal("BENCH") }] }],
  ...over,
});

function touch(file: string, at: Date) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "// placeholder\n", "utf8");
  utimesSync(file, at, at);
}

function clean() {
  for (const f of [FAKE, OTHER]) {
    rmSync(draftPath(f), { force: true });
    rmSync(f, { force: true });
  }
}

beforeEach(clean);
afterEach(clean);

// ---------------------------------------------------------------------------

describe("where the draft goes", () => {
  test("under logs/, which is the folder git already ignores", () => {
    const p = draftPath(FAKE).replaceAll("\\", "/");
    expect(p).toContain("/logs/autosave/");
    expect(p.endsWith(".draft.json")).toBe(true);
  });

  test("keyed on the transform file, not on the spec name", () => {
    // The case this protects is a transform.ts that no longer imports. There is
    // no spec then, and therefore no spec.name to key on, but the draft is
    // exactly what you want back. Two transform files must not collide either.
    expect(draftPath(FAKE)).not.toBe(draftPath(OTHER));

    writeDraft(FAKE, base({ name: "One" }));
    writeDraft(OTHER, base({ name: "Two" }));

    expect(readDraft(FAKE).draft?.spec.name).toBe("One");
    expect(readDraft(OTHER).draft?.spec.name).toBe("Two");
  });

  test("renaming the spec does not orphan the draft", () => {
    writeDraft(FAKE, base({ name: "Before" }));
    writeDraft(FAKE, base({ name: "After" }));
    expect(readDraft(FAKE).draft?.spec.name).toBe("After");
  });
});

describe("round trip", () => {
  test("the spec comes back the way it went in", () => {
    const spec = base({ description: "notes survive", tables: { Sex: { M: "1" } } });
    writeDraft(FAKE, spec);

    const { draft, stale } = readDraft(FAKE);
    expect(stale).toBe(false);
    expect(draft?.version).toBe(DRAFT_VERSION);
    expect(draft?.spec).toEqual(spec);
  });

  test("no draft on disk is not an error", () => {
    expect(readDraft(FAKE)).toEqual({ draft: null, stale: false });
  });
});

describe("what is NOT in the file", () => {
  test("the message pane never reaches disk", () => {
    // The one place a real message sits in the GUI is the left pane. A timer
    // copying it every few minutes would be a PHI leak that nothing announces,
    // so the draft takes the spec and only the spec. Asserted against the raw
    // bytes rather than the parsed object, because the question is what landed.
    writeDraft(FAKE, base());
    const raw = readFileSync(draftPath(FAKE), "utf8");
    const parsed = JSON.parse(raw);

    expect(Object.keys(parsed).sort()).toEqual(
      ["savedAt", "savedAtMs", "spec", "specName", "transformFile", "version"],
    );
    expect(raw).not.toContain("MSH|");
    expect(raw).not.toContain("PID|");
  });
});

describe("an invalid spec is still drafted", () => {
  test("a half-finished spec is written, not refused", () => {
    // This is the exact inversion of the /run rule, and on purpose. /run refuses
    // an invalid spec because a file the CLI would reject is worse than an
    // unsaved edit. A draft is the opposite trade: work in progress is invalid
    // almost by definition, and that is the state most worth recovering.
    const broken = base({ blocks: [{ id: "PID", rows: [{ target: "", from: literal("") }] }] });
    expect(writeDraft(FAKE, broken)).not.toBeNull();
    expect(readDraft(FAKE).draft?.spec.blocks[0].rows[0].target).toBe("");
  });
});

describe("staleness", () => {
  test("a transform.ts written after the draft makes the draft stale", () => {
    // This is what a Ctrl+Enter looks like from here, and also what a hand edit
    // in another editor looks like. One rule covers both, which is why it is
    // mtime and not a flag the GUI sets.
    writeDraft(FAKE, base(), new Date(1_000_000));
    touch(FAKE, new Date(2_000_000));

    const { draft, stale } = readDraft(FAKE);
    expect(draft).not.toBeNull();
    expect(stale).toBe(true);
  });

  test("a transform.ts older than the draft leaves it offerable", () => {
    touch(FAKE, new Date(1_000_000));
    writeDraft(FAKE, base(), new Date(2_000_000));
    expect(readDraft(FAKE).stale).toBe(false);
  });

  test("a missing transform.ts is not stale, because the draft is all there is", () => {
    writeDraft(FAKE, base(), new Date(1_000_000));
    expect(existsSync(FAKE)).toBe(false);
    expect(readDraft(FAKE).stale).toBe(false);
  });
});

describe("a bad draft file cannot break the page", () => {
  test("unparseable JSON reads as no draft rather than throwing", () => {
    // readDraft is called from /state, the request that renders the whole GUI.
    // A junk file in a log folder must not be able to stop the editor loading.
    const p = draftPath(FAKE);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "{ not json", "utf8");
    expect(() => readDraft(FAKE)).not.toThrow();
    expect(readDraft(FAKE).draft).toBeNull();
  });

  test("a draft from another version is dropped, not guessed at", () => {
    const p = draftPath(FAKE);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ version: DRAFT_VERSION + 99, spec: base(), savedAtMs: 1 }), "utf8");
    expect(readDraft(FAKE).draft).toBeNull();
  });

  test("a draft with no spec in it is dropped", () => {
    const p = draftPath(FAKE);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ version: DRAFT_VERSION, savedAtMs: 1 }), "utf8");
    expect(readDraft(FAKE).draft).toBeNull();
  });
});

describe("discard", () => {
  test("removes the file", () => {
    writeDraft(FAKE, base());
    expect(existsSync(draftPath(FAKE))).toBe(true);
    expect(discardDraft(FAKE)).toBe(true);
    expect(existsSync(draftPath(FAKE))).toBe(false);
    expect(readDraft(FAKE).draft).toBeNull();
  });

  test("discarding a draft that is not there is success", () => {
    // The point of the call is that the draft is gone afterwards. Reporting a
    // failure because it was already gone would make every caller write the
    // same existsSync check.
    expect(discardDraft(FAKE)).toBe(true);
  });

  test("discarding one transform's draft leaves another's alone", () => {
    writeDraft(FAKE, base({ name: "One" }));
    writeDraft(OTHER, base({ name: "Two" }));
    discardDraft(FAKE);
    expect(readDraft(FAKE).draft).toBeNull();
    expect(readDraft(OTHER).draft?.spec.name).toBe("Two");
  });
});
