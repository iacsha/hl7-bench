#!/usr/bin/env bun
/**
 * compare.ts -- bulk compare. The corpus-scale sibling of `check.ts`.
 *
 *   bun compare.ts <dir>                        every pair in <dir>
 *   bun compare.ts <dir> --ignore MSH-10,MSH-7  minus fields you have ruled out
 *
 * Same file convention as `check.ts`, so a corpus is a folder and nothing has
 * to be registered:
 *
 *   <name>.in.hl7     the message the old interface received
 *   <name>.want.hl7   what the old interface actually SENT for it
 *
 * WHAT MAKES THIS A DIFFERENT QUESTION FROM check.ts
 *
 * `check.ts` asks whether the spec still does what it did yesterday, against
 * outputs this bench produced. It answers per message, and a person reads the
 * diff.
 *
 * This asks the migration question: does the new spec do what the OLD ENGINE
 * did, across everything the old engine has ever seen. The `.want.hl7` side is
 * not captured from here -- it is real output pulled off the interface being
 * replaced. And the answer cannot be read per message, because the failure
 * being hunted is statistical:
 *
 *   a spec that passes every message anyone thought to test, and quietly drops
 *   OBR-25 on the two percent of results that carry a correction.
 *
 * Nobody reviews two percent of a corpus by hand. A field-level count finds it
 * in one line. That is the whole reason this file exists, and it is why the
 * report is keyed on FIELD rather than on message.
 *
 * THE UNIT IS MESSAGES, NOT DIFFERENCES
 *
 * A field that differs in three OBX occurrences of one message counts ONCE.
 * "OBR-25 differs in 214 of 1000 messages" is a sentence you can act on;
 * "OBR-25 differs 900 times" is not, because you cannot tell a systematic
 * mapping error from one pathological message with 900 repeats.
 *
 * NOTHING IS IGNORED UNLESS YOU SAY SO
 *
 * The obvious trap: the old engine stamped its own MSH-10 and MSH-7, the spec
 * generates different ones, and every message differs on both. It would be
 * easy to drop those two by default and hand back a clean-looking report. That
 * would also silently hide a real MSH-10 mapping change on the day one happens.
 * So the default ignore list is EMPTY, `--ignore` is yours to set, whatever you
 * set is printed at the top of the report, and any field differing in 100% of
 * messages is FLAGGED as a likely stamp rather than removed. You decide; the
 * tool refuses to decide quietly.
 *
 * REFUSALS ARE PART OF THE ANSWER
 *
 * A spec whose gate turns away 400 of 1000 messages would otherwise show a
 * beautifully small diff, computed over the 600 it deigned to transform. The
 * refused count sits in the header next to the compared count for that reason.
 *
 * PHI
 *
 * The example values printed are message content, by design -- a count with no
 * value tells you a field moved but not what it moved to. Same posture as
 * `check.ts`: the values go to stdout because that is the tool's entire output,
 * and they reach the log file only at `HL7_BENCH_LOG=full`. The corpus itself
 * belongs in `messages\`, which is gitignored, or somewhere else off the repo.
 */

// The transform writes per-message diagnostics to stderr for the GUI pane. On a
// thousand-message corpus they would bury the report entirely.
process.env.HL7_BENCH_NOTES = "off";

import { Message } from "./hl7";
import { transform } from "./transform";
import { logEvent } from "./log";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Distinct got/want pairs shown per field. Excess is reported, never dropped. */
const EXAMPLES = 3;

// ---------------------------------------------------------------------------
// The comparison core. No filesystem, no process, so `bun test` can drive it.
// ---------------------------------------------------------------------------

export interface Cell {
  /** `SEG-F`. The aggregation key, deliberately without the occurrence. */
  path: string;
  /** 1-based occurrence of that segment id. 1 for non-repeating segments. */
  occurrence: number;
  got: string;
  want: string;
}

/**
 * Every field that differs between two messages.
 *
 * Segments are aligned by id and then by ORDER OF APPEARANCE -- the third OBX
 * against the third OBX. That is the only alignment available without knowing
 * the message structure, and it is the one a reader assumes. When the counts
 * disagree the surplus occurrences are not compared here; `diffSegmentCounts`
 * reports them instead, because "the fourth OBX is missing" is a different
 * finding from "the fourth OBX has a different OBX-5", and conflating them
 * produces a field report full of ghosts.
 */
export function diffFields(got: Message, want: Message, ignore: Set<string> = new Set()): Cell[] {
  const cells: Cell[] = [];
  const ids = new Set<string>([...want.segments.map((s) => s.id), ...got.segments.map((s) => s.id)]);

  for (const id of ids) {
    const g = got.all(id);
    const w = want.all(id);
    const aligned = Math.min(g.length, w.length);

    for (let i = 0; i < aligned; i++) {
      // fieldCount is the real edge of each segment. getField returns "" past it
      // and cannot tell an absent field from an empty one, so walking to the
      // longer of the two is what makes a TRUNCATED segment visible: want has
      // OBR-25, got stops at OBR-24, and the pair reads got (empty) want "F".
      const last = Math.max(g[i].fieldCount, w[i].fieldCount);
      for (let f = 1; f <= last; f++) {
        const path = `${id}-${f}`;
        if (ignore.has(path)) continue;
        const gv = g[i].getField(f);
        const wv = w[i].getField(f);
        if (gv !== wv) cells.push({ path, occurrence: i + 1, got: gv, want: wv });
      }
    }
  }
  return cells;
}

export interface CountDiff {
  id: string;
  got: number;
  want: number;
}

/** Segment ids present a different number of times in the two messages. */
export function diffSegmentCounts(got: Message, want: Message): CountDiff[] {
  const out: CountDiff[] = [];
  const ids = new Set<string>([...want.segments.map((s) => s.id), ...got.segments.map((s) => s.id)]);
  for (const id of ids) {
    const g = got.all(id).length;
    const w = want.all(id).length;
    if (g !== w) out.push({ id, got: g, want: w });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Aggregation across the corpus.
// ---------------------------------------------------------------------------

export interface Example {
  case: string;
  occurrence: number;
  got: string;
  want: string;
}

export interface FieldRow {
  path: string;
  /** Messages in which this field differed at least once. The headline number. */
  messages: number;
  /** Distinct got/want value pairs seen. `examples` holds the first few. */
  distinct: number;
  examples: Example[];
  /**
   * Bookkeeping for `accumulate`, not part of the report anyone reads. It is a
   * Set, so it does not survive JSON; nothing downstream may depend on it.
   */
  seen?: Set<string>;
}

export interface CountRow {
  id: string;
  messages: number;
  examples: { case: string; got: number; want: number }[];
}

export interface Report {
  /** Pairs found on disk. */
  pairs: number;
  /** Pairs actually compared: pairs minus refusals minus unreadable. */
  compared: number;
  refused: { case: string; why: string }[];
  unreadable: { case: string; why: string }[];
  fields: FieldRow[];
  counts: CountRow[];
  ignored: string[];
}

/**
 * Fold one message's cells into the running totals.
 *
 * Exported because the aggregation rule -- one message counts once per field,
 * however many occurrences differed -- is the claim in this file most worth a
 * test, and testing it through the filesystem would prove the directory reader
 * instead.
 */
export function accumulate(totals: Map<string, FieldRow>, caseName: string, cells: Cell[]): void {
  const countedThisMessage = new Set<string>();

  for (const c of cells) {
    let row = totals.get(c.path);
    if (!row) {
      row = { path: c.path, messages: 0, distinct: 0, examples: [] };
      totals.set(c.path, row);
    }
    if (!countedThisMessage.has(c.path)) {
      row.messages++;
      countedThisMessage.add(c.path);
    }

    // `distinct` counts VALUE PAIRS across the whole corpus, not occurrences. A
    // field mapped wrong one single way has distinct 1 no matter how many
    // messages carry it, and that one line is the signature of a systematic
    // mapping error as opposed to dirty source data.
    // Joined on NUL because no HL7 field value can contain one, so no pair of
    // values can collide into a single key.
    const key = `${c.got}\u0000${c.want}`;
    row.seen ??= new Set<string>();
    if (!row.seen.has(key)) {
      row.seen.add(key);
      row.distinct++;
      if (row.examples.length < EXAMPLES) {
        row.examples.push({ case: caseName, occurrence: c.occurrence, got: c.got, want: c.want });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

/** Values can be long and can contain delimiters. Keep the table readable. */
function show(v: string): string {
  const s = v.replace(/\r|\n/g, " ");
  return s === "" ? "(empty)" : s.length > 40 ? `${s.slice(0, 37)}...` : s;
}

function pct(n: number, of: number): string {
  if (of === 0) return "  n/a";
  return `${String(Math.round((n / of) * 100)).padStart(4)}%`;
}

export function render(r: Report): string {
  const out: string[] = [];

  out.push(`${r.compared} of ${r.pairs} pairs compared`);
  if (r.refused.length > 0) {
    out.push(`${r.refused.length} refused by the gate, listed below and NOT compared`);
  }
  if (r.unreadable.length > 0) {
    out.push(`${r.unreadable.length} unreadable, listed below and NOT compared`);
  }
  out.push(
    r.ignored.length > 0
      ? `ignoring ${r.ignored.join(", ")} -- differences on these fields were not counted`
      : `ignoring nothing`,
  );
  out.push("");

  if (r.fields.length === 0) {
    out.push(r.compared === 0 ? "No messages were compared." : "No field differences.");
    out.push("");
  } else {
    out.push("FIELD DIFFERENCES, most-affected first");
    out.push("");
    const w = Math.max(9, ...r.fields.map((f) => f.path.length));
    const pad = " ".repeat(w + 19);
    out.push(`${"FIELD".padEnd(w)}  ${"MESSAGES".padStart(8)}  ${"PCT".padStart(5)}`);
    for (const f of r.fields) {
      out.push(`${f.path.padEnd(w)}  ${String(f.messages).padStart(8)}  ${pct(f.messages, r.compared)}`);
      for (const e of f.examples) {
        const where = `${e.case}${e.occurrence > 1 ? ` #${e.occurrence}` : ""}`;
        out.push(`${pad}got  ${show(e.got)}`);
        out.push(`${pad}want ${show(e.want)}   (${where})`);
      }
      if (f.distinct > f.examples.length) {
        out.push(`${pad}... and ${f.distinct - f.examples.length} more distinct value pair(s)`);
      }
      // A field differing on every single message is almost always a stamp the
      // old engine wrote and the spec regenerates. Say so; do not act on it.
      if (r.compared > 0 && f.messages === r.compared) {
        out.push(`${pad}^ differs in EVERY message. Likely a stamp. Rule it out with --ignore ${f.path} if so.`);
      }
      out.push("");
    }
  }

  if (r.counts.length > 0) {
    out.push("SEGMENT COUNT DIFFERENCES");
    out.push("");
    for (const c of r.counts) {
      const e = c.examples[0];
      out.push(`  ${c.id}  in ${c.messages} message(s)  e.g. ${e.case}: got ${e.got}, want ${e.want}`);
    }
    out.push("");
  }

  if (r.refused.length > 0) {
    out.push("REFUSED BY THE GATE");
    out.push("");
    for (const x of r.refused.slice(0, 10)) out.push(`  ${x.case}  ${x.why}`);
    if (r.refused.length > 10) out.push(`  ... and ${r.refused.length - 10} more`);
    out.push("");
  }

  if (r.unreadable.length > 0) {
    out.push("UNREADABLE");
    out.push("");
    for (const x of r.unreadable.slice(0, 10)) out.push(`  ${x.case}  ${x.why}`);
    if (r.unreadable.length > 10) out.push(`  ... and ${r.unreadable.length - 10} more`);
    out.push("");
  }

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// The corpus walk.
// ---------------------------------------------------------------------------

export interface Pair {
  name: string;
  input: string;
  want: string;
}

/** Every `<name>.in.hl7` in `dir`, split by whether it has a `<name>.want.hl7`. */
export function pairsIn(dir: string): { pairs: Pair[]; lonely: string[] } {
  const files = readdirSync(dir);
  const pairs: Pair[] = [];
  const lonely: string[] = [];
  for (const f of files.slice().sort()) {
    if (!f.endsWith(".in.hl7")) continue;
    const name = f.slice(0, -".in.hl7".length);
    const want = `${name}.want.hl7`;
    if (files.includes(want)) pairs.push({ name, input: f, want });
    else lonely.push(name);
  }
  return { pairs, lonely };
}

export function compareCorpus(dir: string, ignore: Set<string>): Report {
  const { pairs } = pairsIn(dir);
  const totals = new Map<string, FieldRow>();
  const countTotals = new Map<string, CountRow>();
  const refused: { case: string; why: string }[] = [];
  const unreadable: { case: string; why: string }[] = [];
  let compared = 0;

  for (const p of pairs) {
    let got: Message;
    let want: Message;
    try {
      want = new Message(readFileSync(join(dir, p.want), "utf8"));
      got = new Message(readFileSync(join(dir, p.input), "utf8"));
    } catch (e) {
      unreadable.push({ case: p.name, why: e instanceof Error ? e.message : String(e) });
      continue;
    }

    try {
      transform(got);
    } catch (e) {
      refused.push({ case: p.name, why: e instanceof Error ? e.message : String(e) });
      continue;
    }

    compared++;
    accumulate(totals, p.name, diffFields(got, want, ignore));

    for (const c of diffSegmentCounts(got, want)) {
      let row = countTotals.get(c.id);
      if (!row) {
        row = { id: c.id, messages: 0, examples: [] };
        countTotals.set(c.id, row);
      }
      row.messages++;
      if (row.examples.length < EXAMPLES) {
        row.examples.push({ case: p.name, got: c.got, want: c.want });
      }
    }
  }

  const fields = [...totals.values()].sort(
    (a, b) => b.messages - a.messages || a.path.localeCompare(b.path),
  );
  const counts = [...countTotals.values()].sort(
    (a, b) => b.messages - a.messages || a.id.localeCompare(b.id),
  );

  return {
    pairs: pairs.length,
    compared,
    refused,
    unreadable,
    fields,
    counts,
    ignored: [...ignore].sort(),
  };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

function usage(): never {
  console.error(
    [
      "Usage: bun compare.ts <dir> [--ignore PATH,PATH]",
      "",
      "  <dir>       holds <name>.in.hl7 and <name>.want.hl7 pairs, where the",
      "              .want side is the OLD engine's real recorded output.",
      "  --ignore    fields not to count, comma separated, e.g. MSH-10,MSH-7.",
      "              Nothing is ignored by default, and whatever you set is",
      "              printed in the report header.",
    ].join("\n"),
  );
  process.exit(2);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0].startsWith("--")) usage();

  const dir = argv[0];
  const ignore = new Set<string>();
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--ignore") {
      const list = argv[++i];
      if (!list) usage();
      for (const p of list.split(",").map((s) => s.trim()).filter(Boolean)) ignore.add(p);
    } else {
      console.error(`Unknown argument: ${argv[i]}\n`);
      usage();
    }
  }

  if (!existsSync(dir)) {
    console.error(`No such folder: ${dir}`);
    process.exit(2);
  }

  const { pairs, lonely } = pairsIn(dir);
  for (const name of lonely) {
    console.error(`SKIP  ${name}  -- has ${name}.in.hl7 but no ${name}.want.hl7`);
  }
  if (pairs.length === 0) {
    console.error(`No pairs in ${dir}. Name them <name>.in.hl7 + <name>.want.hl7.`);
    process.exit(2);
  }

  const report = compareCorpus(dir, ignore);
  console.log(render(report));

  const clean = report.fields.length === 0 && report.counts.length === 0;
  logEvent("compare", {
    dir,
    pairs: report.pairs,
    compared: report.compared,
    refused: report.refused.length,
    unreadable: report.unreadable.length,
    fields: report.fields.length,
    ignored: report.ignored.join(",") || "(none)",
    result: clean ? "pass" : "fail",
  });

  process.exit(clean ? 0 : 1);
}
