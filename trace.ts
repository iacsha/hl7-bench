/**
 * trace.ts -- the document half of `spec.ts`.
 *
 * Same spec, same walk, same resolution as `run.ts`. The point of routing both
 * through `walk()` and `resolve()` is that the table below cannot describe an
 * interface the bench does not actually produce. If you change a row, the
 * document changes with it because there is nothing else to change.
 *
 * Two audiences, two tables:
 *
 *   trace()      what the RECEIVER gets, field by field, with the source that
 *                fed it and the steps that ran. This is the mapping document.
 *   inventory()  what the SENDER emits, mapped or not. This is the agenda for
 *                the call with the sending system, and it is a different list.
 *
 * A field can be perfect in the first table and still be the whole problem in
 * the second, because "we map PID-4" and "PID-4 is empty at this site" are not
 * the same statement.
 */

import { Message } from "./hl7";
import { describeSource, emptyTables, sourcePathsOf, type Spec } from "./spec";
import { assertRunnable, gate, resolve, seedSource, walk, type Ctx } from "./run";
import { toCsv, toXlsx, type Sheet } from "./sheet";

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [
    line(headers),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
  ].join("\n");
}

/** Blank cells read as "nothing came through", which is the useful reading. */
const show = (v: string) => (v === "" ? "" : v);

// ---------------------------------------------------------------------------
// The delivered trace
// ---------------------------------------------------------------------------

export interface TraceOptions {
  /** Include rows whose final value is empty. Default true. */
  showEmpty?: boolean;
}

/**
 * Render what this spec delivers for this message.
 *
 * An asterisk on a target marks `required: true`. Every required field that
 * came out empty is listed at the bottom, all of them, not the first one. An
 * operator who has to resubmit once per missing field stops reporting them.
 */
export function trace(spec: Spec, msg: Message, opts: TraceOptions = {}): string {
  assertRunnable(spec);
  const { trigger, event } = gate(spec, msg);
  const showEmpty = opts.showEmpty ?? true;

  const out: string[] = [
    `SPEC:  ${spec.name}`,
    `GATE:  ${spec.gate.path} "${trigger}" delivers as ${event}`,
  ];
  for (const req of spec.gate.require ?? []) {
    out.push(`GATE:  ${req.path} must be "${req.equals}", or the message is refused`);
  }
  if (spec.description) out.push(`NOTE:  ${spec.description}`);
  out.push("");

  const missing: string[] = [];
  const notes: string[] = [];
  // How many of each block have been delivered, so a repeat can label itself.
  const seen = new Map<string, number>();
  const totals = new Map<string, number>();
  walk(spec, msg, event, (block) => {
    totals.set(block.id, (totals.get(block.id) ?? 0) + 1);
  });

  walk(spec, msg, event, (block, ctx: Ctx) => {
    const n = (seen.get(block.id) ?? 0) + 1;
    seen.set(block.id, n);
    const total = totals.get(block.id) ?? 1;

    const heading = block.repeat
      ? `${block.id}${block.group ? ` (${block.group})` : ""}  --  ${n} of ${total}`
      : `${block.id}${block.group ? ` (${block.group})` : ""}`;

    const rows: string[][] = [];

    // A seeded block copies fields nobody enumerated, so the table below cannot
    // name them. Saying so as the first row is the whole honesty of this
    // document: the receiving team reads "sent as received, except the rows
    // under it" rather than a field list that looks complete and is not.
    if (block.wholeSegment) {
      const src = seedSource(ctx, block);
      rows.push([
        block.id,
        "(whole segment)",
        `${block.id} copied whole`,
        show(src ? src.toString() : ""),
        "",
        src ? `${src.fieldCount} field(s) passed through` : "(no source segment)",
      ]);
    }

    for (const row of block.rows) {
      const r = resolve(ctx, row);
      const label = row.label ?? row.target;
      if (row.required && r.value === "" && !r.todo) missing.push(label);
      if (r.todo) notes.push(`TODO ${label}: ${r.todo}`);
      if (r.note) notes.push(r.note);
      if (row.note) notes.push(`${label}: ${row.note}`);
      if (!showEmpty && r.value === "" && !r.todo) continue;

      rows.push([
        `${row.target}${row.required ? " *" : ""}`,
        row.label ?? "",
        r.todo ? "(TODO)" : describeSource(row.from),
        show(r.raw),
        r.steps.join(", "),
        r.todo ? "" : show(r.value),
      ]);
    }

    out.push(heading);
    if (block.note) out.push(`  ${block.note}`);
    out.push(table(["TARGET", "NAME", "SOURCE", "RAW", "STEPS", "FINAL"], rows));
    out.push("");
  });

  if (missing.length > 0) {
    out.push(`MISSING REQUIRED (${missing.length}): ${missing.join(", ")}`, "");
  }

  const empties = emptyTables(spec);
  for (const name of empties) {
    notes.push(`table ${name} has no rows, so every lookup against it takes the unmapped branch`);
  }
  // Deduped for the same reason run.ts dedupes: three rows reading the same
  // fallback are one finding, and a note repeated verbatim stops being read.
  const unique = [...new Set(notes)];
  if (unique.length > 0) {
    out.push("NOTES", ...unique.map((n) => `  - ${n}`), "");
  }

  if (spec.outOfScope?.length) {
    out.push(
      "OUT OF SCOPE (decided, not overlooked)",
      ...spec.outOfScope.map((s) => `  - ${s}`),
      "",
    );
  }

  return out.join("\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// The same document as a grid
// ---------------------------------------------------------------------------

/**
 * The trace as sheets, for `--csv` and `--xlsx`.
 *
 * The text trace puts the block in a HEADING and the fields under it, which
 * reads well and sorts not at all. A reviewer opening a spreadsheet wants one
 * flat table: block as a column, one row per decision, so they can filter to
 * the suppressions or sort by target without being taught anything.
 *
 * Both renderers call `resolve()` for every row, so what a row DOES has one
 * definition and only the layout differs. `inventory()` already coexists with
 * `trace()` on the same terms.
 */
export function grid(spec: Spec, msg: Message, opts: TraceOptions = {}): Sheet[] {
  assertRunnable(spec);
  const { trigger, event } = gate(spec, msg);
  const showEmpty = opts.showEmpty ?? true;

  const header = [
    "Block", "Occurrence", "Group", "Target", "Required",
    "Name", "Source", "Raw", "Steps", "Final", "Note",
  ];
  const rows: string[][] = [header];
  const notes: string[] = [];
  const missing: string[] = [];

  const seen = new Map<string, number>();
  const totals = new Map<string, number>();
  walk(spec, msg, event, (block) => {
    totals.set(block.id, (totals.get(block.id) ?? 0) + 1);
  });

  walk(spec, msg, event, (block, ctx: Ctx) => {
    const n = (seen.get(block.id) ?? 0) + 1;
    seen.set(block.id, n);
    const total = totals.get(block.id) ?? 1;
    // "1 of 3" only where there is more than one; a lone segment reading
    // "1 of 1" invites the question of where the other one went.
    const occurrence = total > 1 || block.repeat ? `${n} of ${total}` : "";

    if (block.wholeSegment) {
      const src = seedSource(ctx, block);
      rows.push([
        block.id, occurrence, block.group ?? "", "(whole segment)", "",
        "", `${block.id} copied whole`, show(src ? src.toString() : ""), "",
        src ? `${src.fieldCount} field(s) passed through` : "(no source segment)",
        block.note ?? "",
      ]);
    }

    for (const row of block.rows) {
      const r = resolve(ctx, row);
      const label = row.label ?? row.target;
      if (row.required && r.value === "" && !r.todo) missing.push(label);
      if (r.todo) notes.push(`TODO ${label}: ${r.todo}`);
      if (r.note) notes.push(r.note);
      if (row.note) notes.push(`${label}: ${row.note}`);
      if (!showEmpty && r.value === "" && !r.todo) continue;

      rows.push([
        block.id, occurrence, block.group ?? "", row.target, row.required ? "yes" : "",
        row.label ?? "", r.todo ? "(TODO)" : describeSource(row.from),
        show(r.raw), r.steps.join(", "), r.todo ? "" : show(r.value),
        row.note ?? "",
      ]);
    }
  });

  // Everything that is not a mapped field goes on its own sheet rather than
  // above the header, where it would break the filter and the sort.
  const about: string[][] = [
    ["Item", "Value"],
    ["Spec", spec.name],
    ["Gate", `${spec.gate.path} "${trigger}" delivers as ${event}`],
  ];
  for (const req of spec.gate.require ?? []) {
    about.push(["Gate requires", `${req.path} must be "${req.equals}", or the message is refused`]);
  }
  if (spec.description) about.push(["Description", spec.description]);
  if (missing.length > 0) about.push(["Missing required", missing.join(", ")]);
  for (const name of emptyTables(spec)) {
    notes.push(`table ${name} has no rows, so every lookup against it takes the unmapped branch`);
  }
  for (const note of [...new Set(notes)]) about.push(["Note", note]);
  for (const s of spec.outOfScope ?? []) about.push(["Out of scope", s]);

  return [
    { name: "Mapping", rows },
    { name: "About", rows: about },
  ];
}

// ---------------------------------------------------------------------------
// The source inventory
// ---------------------------------------------------------------------------

/**
 * Render what the sender put on the wire, against what the spec expected.
 *
 * Every `sourceInventory` entry is listed whether or not it is mapped, and the
 * MAPPED column says which target rows read it. An inventory item nothing reads
 * is a real finding: either the receiver does not want it, or you missed it.
 */
export function inventory(spec: Spec, msg: Message): string {
  if (!spec.sourceInventory?.length) return "";

  // Which target rows read each source path, gathered from the spec itself so
  // the two tables cannot drift apart.
  const readers = new Map<string, string[]>();
  // The gate reads before any row does, and a gate path listed as "not mapped"
  // is the one line in this table that would be flatly wrong: it is the field
  // that decides whether the message is delivered at all.
  readers.set(spec.gate.path, ["(gate)"]);
  for (const req of spec.gate.require ?? []) {
    readers.set(req.path, [...(readers.get(req.path) ?? []), "(gate)"]);
  }
  for (const block of spec.blocks) {
    for (const row of block.rows) {
      for (const p of sourcePathsOf(row.from)) {
        readers.set(p, [...(readers.get(p) ?? []), row.target]);
      }
    }
  }

  const missing: string[] = [];
  const rows = spec.sourceInventory.map((item) => {
    const value = msg.get(item.path);
    if (item.required && value === "") missing.push(item.label);
    const mapped = readers.get(item.path);
    return [
      `${item.path}${item.required ? " *" : ""}`,
      item.label,
      value === "" ? "EMPTY" : "present",
      show(value),
      mapped ? mapped.join(", ") : "not mapped",
      item.note ?? "",
    ];
  });

  const out = [
    `SOURCE INVENTORY  --  what ${spec.name} expects on the wire`,
    "",
    table(["PATH", "NAME", "STATE", "VALUE", "READ BY", "NOTE"], rows),
  ];
  if (missing.length > 0) {
    out.push("", `MISSING FROM SENDER (${missing.length}): ${missing.join(", ")}`);
  }
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { spec } = await import("./specfile");
  const { readMessage, outArg, deliverText } = await import("./input");
  const outFile = outArg("trace");
  const { raw, source } = await readMessage("trace");

  const { logEvent } = await import("./log");

  const m = new Message(raw);

  // A spreadsheet for the people who review this, text for the people who
  // diff it. Same walk, same resolution, two renderers.
  const wantXlsx = process.argv.includes("--xlsx");
  const wantCsv = process.argv.includes("--csv");
  if (wantXlsx || wantCsv) {
    if (wantXlsx && wantCsv) {
      process.stderr.write("trace: --csv and --xlsx are two files. Ask for one.\n");
      process.exit(2);
    }
    const sheets = grid(spec, m);
    const target = outFile ?? (wantXlsx ? "mapping-document.xlsx" : "mapping-document.csv");
    if (wantXlsx) {
      await Bun.write(target, toXlsx(sheets));
    } else {
      // One sheet only. A CSV has no tabs, and silently dropping the About
      // sheet would lose the gate, the out-of-scope list and the notes.
      await Bun.write(target, toCsv(sheets[0]!.rows));
      process.stderr.write(
        "trace: CSV carries the Mapping sheet only -- the About sheet (gate, notes,\n" +
          "       out of scope) needs --xlsx. Excel also rewrites a CSV as it opens it:\n" +
          '       "01" becomes 1 and "19680101" becomes a date. Use --xlsx for review.\n',
      );
    }
    process.stderr.write(`wrote ${target}\n`);
    process.exit(0);
  }

  const doc = trace(spec, m);
  const inv = inventory(spec, m);

  // No notes here. A trace is entirely message content, so there is nothing
  // about this run that could be logged at `full` and not at `summary`: it
  // would be the whole document or none of it, and the document is already
  // on stdout where you asked for it.
  logEvent("trace", {
    spec: spec.name,
    source,
    segments: m.segments.length,
    chars: doc.length + inv.length,
    result: "ok",
  });

  // The inventory is part of the document, not a footnote to the screen. A file
  // that carried the mapping table and dropped what the sender must populate
  // would be handed to a receiving team missing half its point.
  await deliverText(inv ? doc + "\n" + inv : doc, outFile);
}
