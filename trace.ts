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
import { sheetName, toCsv, toXlsx, type Sheet } from "./sheet";
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";

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
// Several messages, one workbook
// ---------------------------------------------------------------------------

/** One message going into a combined workbook, and the name it is known by. */
export interface Named {
  name: string;
  msg: Message;
}

/**
 * One workbook for every message type the interface handles.
 *
 * An interface is reviewed as a whole: "what does the receiver get on an A08 that it
 * does not get on an A01" is the question, and three separate files make the
 * reviewer build that comparison by hand. So the first sheet is an Overview --
 * one row per mapped field, one column per message, the value that message
 * delivers in it. A row that one event does not walk reads `(not sent)`, which
 * is a different statement from an empty value and is written differently.
 *
 * Each message keeps its own full Mapping sheet behind the Overview, built by
 * `grid()`, so the per-message detail (raw, steps, notes) has one definition.
 *
 * A message the gate refuses gets no sheet. It is listed on About with the
 * reason, because a refusal is part of the interface's contract too.
 */
export function combinedGrid(spec: Spec, inputs: Named[], opts: TraceOptions = {}): Sheet[] {
  assertRunnable(spec);

  type Taken = { name: string; label: string; rows: string[][] };
  const taken: Taken[] = [];
  const refused: string[][] = [];
  const notes = new Set<string>();
  const outOfScope = new Set<string>();

  for (const { name, msg } of inputs) {
    let sheets: Sheet[];
    let label: string;
    try {
      const { trigger, event } = gate(spec, msg);
      label = trigger === event ? trigger : `${trigger} to ${event}`;
      sheets = grid(spec, msg, opts);
    } catch (e) {
      refused.push(["Refused", `${name}: ${e instanceof Error ? e.message : String(e)}`]);
      continue;
    }
    taken.push({ name, label, rows: sheets[0]!.rows });
    for (const [item, value] of sheets[1]!.rows.slice(1)) {
      if (item === "Note" || item === "Missing required") notes.add(`${label} (${name}): ${value}`);
      if (item === "Out of scope") outOfScope.add(value!);
    }
  }

  if (taken.length === 0) {
    throw new Error(
      `the gate refused every message given, so there is nothing to map.\n` +
        refused.map((r) => `  ${r[1]}`).join("\n"),
    );
  }

  // Tab names: the event, and the file where two messages share an event.
  // Excel refuses a duplicate tab name outright, so the file is not optional.
  const counts = new Map<string, number>();
  for (const t of taken) counts.set(t.label, (counts.get(t.label) ?? 0) + 1);
  const used = new Set<string>(["Overview", "About"]);
  const tabOf = (t: Taken): string => {
    const base = (counts.get(t.label) ?? 0) > 1 ? `${t.label} ${t.name}` : t.label;
    let tab = sheetName(base);
    for (let i = 2; used.has(tab); i++) tab = sheetName(`${base.slice(0, 26)} #${i}`);
    used.add(tab);
    return tab;
  };
  const tabs = taken.map(tabOf);

  // Overview. Mapping columns are fixed by grid(): Block 0, Occurrence 1,
  // Group 2, Target 3, Required 4, Name 5, Source 6, Raw 7, Steps 8, Final 9.
  //
  // One row per FIELD, not per occurrence. A repeating block used to get a full
  // set of rows for every occurrence -- ten FT1s made ten copies of every FT1
  // field, most of them "(not sent)" for the messages with fewer -- and the
  // reviewer had to scroll past the repetition to compare anything. The
  // occurrences now share a row and the cell carries them in order. The
  // per-message sheets keep one row per occurrence for the detail.
  //
  // Keyed on the spec row, not just block and target: a spec may declare the
  // same segment twice (report-line OBXs, then a CPT OBX with
  // continuesNumbering), and keyed on "OBX" + "OBX-2" alone the second block
  // folded into the first as one odd occurrence and its own source vanished.
  // Name and Source are what tell two spec rows apart on the sheet, so they
  // are what tells them apart here.
  const key = (r: string[]) => [r[0], r[3], r[5], r[6]].join("\u0000");
  const order: string[] = [];
  const shape = new Map<string, string[]>();
  const repeats = new Set<string>();
  const finals = taken.map((t) => {
    const m = new Map<string, string[]>();
    for (const r of t.rows.slice(1)) {
      const k = key(r);
      if (!shape.has(k)) {
        order.push(k);
        shape.set(k, [r[0]!, r[3]!, r[4]!, r[5]!, r[6]!]);
      }
      m.set(k, [...(m.get(k) ?? []), r[9]!]);
    }
    // "yes" when a message actually delivered this row more than once. Not
    // from grid()'s occurrence text: that counts by segment ID, so a one-off
    // block sharing an ID with a repeating one reads "44 of 44" and would be
    // marked as repeating when it never does.
    for (const [k, vs] of m) if (vs.length > 1) repeats.add(k);
    return m;
  });
  const overview: string[][] = [
    ["Block", "Repeats", "Target", "Required", "Name", "Source", ...tabs],
    ...order.map((k) => {
      const [block, target, required, name, source] = shape.get(k)!;
      return [
        block!, repeats.has(k) ? "yes" : "", target!, required!, name!, source!,
        ...finals.map((f, i) => occurrences(f.get(k), tabs[i])),
      ];
    }),
  ];

  const about: string[][] = [
    ["Item", "Value"],
    ["Spec", spec.name],
  ];
  for (const [trigger, event] of Object.entries(spec.gate.permit)) {
    about.push(["Gate", `${spec.gate.path} "${trigger}" delivers as ${event}`]);
  }
  for (const req of spec.gate.require ?? []) {
    about.push(["Gate requires", `${req.path} must be "${req.equals}", or the message is refused`]);
  }
  if (spec.description) about.push(["Description", spec.description]);
  taken.forEach((t, i) => about.push(["Message", `${t.name}: ${t.label}, sheet "${tabs[i]}"`]));
  // A permitted trigger with no message is a gap in the evidence, not in the
  // interface, and the reviewer should see it rather than assume coverage.
  const covered = new Set(taken.map((t) => t.label.split(" ")[0]));
  for (const trigger of Object.keys(spec.gate.permit)) {
    if (!covered.has(trigger)) about.push(["Not shown", `${trigger}: no sample message was given`]);
  }
  about.push(...refused);
  for (const n of notes) about.push(["Note", n]);
  for (const s of outOfScope) about.push(["Out of scope", s]);

  return [
    { name: "Overview", rows: overview },
    ...taken.map((t, i) => ({ name: tabs[i]!, rows: t.rows })),
    { name: "About", rows: about },
  ];
}

/**
 * One Overview cell: every occurrence of a field in one message, kept short.
 *
 *   none               (not sent)        the message never walked this block
 *   one                the value         exactly as before
 *   several, same      X (all 3)         a literal, a suppression
 *   a counter          1 to 43           an output ordinal: OBX-1, FT1-1
 *   short enough       1: a; 2: b        in delivery order, numbered
 *   a few distinct     F (42); C (1)     most common first
 *   long free text     43 values, first "..."; every one on sheet "P03"
 *
 * The Overview is for reading ACROSS messages. A report split into 43 OBX
 * lines made a 1900-character cell that compared nothing and buried the rows
 * that did. The text is still whole on that message's own sheet, and the cell
 * says which one.
 *
 * On one line, not one per occurrence: a line break in a cell only shows in
 * Excel with wrap turned on, and without it the cell reads as run-together text.
 */
export function occurrences(values: string[] | undefined, tab?: string): string {
  if (!values || values.length === 0) return "(not sent)";
  if (values.length === 1) return values[0]!;
  const n = values.length;
  if (values.every((v) => v === values[0])) {
    return values[0] === "" ? `(empty, all ${n})` : `${values[0]} (all ${n})`;
  }
  const first = Number(values[0]);
  const counting = values.every((v, i) => /^\d+$/.test(v) && Number(v) === first + i);
  if (counting) return `${values[0]} to ${values[n - 1]}`;

  const show = (v: string) => (v === "" ? "(empty)" : v);
  const listed = values.map((v, i) => `${i + 1}: ${show(v)}`).join("; ");
  if (listed.length <= OVERVIEW_CELL) return listed;

  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  if (counts.size <= 3) {
    return [...counts].sort((x, y) => y[1] - x[1]).map(([v, c]) => `${show(v)} (${c})`).join("; ");
  }
  const head = show(values[0]!);
  const clipped = head.length > 40 ? `${head.slice(0, 40)}...` : head;
  return `${n} values, first "${clipped}"` + (tab ? `; every one on sheet "${tab}"` : "");
}

/** Past this, a numbered list stops being readable in a cell. */
const OVERVIEW_CELL = 120;

/**
 * The goldens in `dir`, for `--goldens`. Inputs and rejections both: a refusal
 * belongs in the document as much as a delivery does.
 *
 * PowerShell does not expand `messages\*.hl7` for a native program, so asking
 * for a glob on the command line would work on CT109 and fail on the work PC.
 */
export function goldenFiles(dir: string, filter?: string): string[] {
  const f = filter?.toLowerCase();
  return readdirSync(dir)
    .filter((n) => n.endsWith(".in.hl7") || n.endsWith(".reject.hl7"))
    .filter((n) => !f || n.toLowerCase().includes(f))
    .sort()
    .map((n) => join(dir, n));
}

/** `messages/adt-a08b.in.hl7` is known as `adt-a08b`. */
export function caseName(path: string): string {
  return basename(path).replace(/\.(in|reject)\.hl7$/i, "").replace(/\.hl7$/i, "");
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
  const wantXlsx = process.argv.includes("--xlsx");
  const wantCsv = process.argv.includes("--csv");
  if (wantXlsx && wantCsv) {
    process.stderr.write("trace: --csv and --xlsx are two files. Ask for one.\n");
    process.exit(2);
  }

  // Several messages: named on the line, or every golden via --goldens.
  const argv = process.argv.slice(2);
  const gi = argv.indexOf("--goldens");
  const named = argv.filter(
    (a, i) => a.toLowerCase().endsWith(".hl7") && argv[i - 1] !== "-o" && argv[i - 1] !== "--out",
  );
  if (gi !== -1 || named.length > 1) {
    if (!wantXlsx && !wantCsv) {
      process.stderr.write(
        "trace: several messages make a combined workbook. Add --xlsx (or --csv for the Overview only).\n",
      );
      process.exit(2);
    }
    let files = named;
    if (gi !== -1) {
      const next = argv[gi + 1];
      const filter = next && !next.startsWith("-") && !next.toLowerCase().endsWith(".hl7") ? next : undefined;
      const { existsSync } = await import("node:fs");
      if (!existsSync("messages")) {
        process.stderr.write("trace: --goldens reads messages\\, and there is no messages\\ folder here.\n");
        process.exit(1);
      }
      files = goldenFiles("messages", filter);
      if (files.length === 0) {
        process.stderr.write(`trace: no goldens in messages\\${filter ? ` matching "${filter}"` : ""}.\n`);
        process.exit(1);
      }
    }
    const { decodeText } = await import("./input");
    const { readFileSync } = await import("node:fs");
    const inputs = files.map((f) => ({ name: caseName(f), msg: new Message(decodeText(readFileSync(f)).text) }));
    let sheets: Sheet[];
    try {
      sheets = combinedGrid(spec, inputs);
    } catch (e) {
      process.stderr.write(`trace: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
    const target = outFile ?? (wantXlsx ? "mapping-document.xlsx" : "mapping-document.csv");
    if (wantXlsx) {
      await Bun.write(target, toXlsx(sheets));
    } else {
      await Bun.write(target, toCsv(sheets[0]!.rows));
      process.stderr.write("trace: CSV carries the Overview sheet only -- use --xlsx for every sheet.\n");
    }
    const shown = sheets.slice(1, -1).map((s) => s.name);
    const refusedCount = inputs.length - shown.length;
    process.stderr.write(
      `wrote ${target}\n  ${shown.length} mapped: ${shown.join(", ")}` +
        (refusedCount > 0 ? `\n  ${refusedCount} refused by the gate, listed on About` : "") +
        "\n",
    );
    process.exit(0);
  }

  const { raw, source } = await readMessage("trace");

  const { logEvent } = await import("./log");

  const m = new Message(raw);

  // A spreadsheet for the people who review this, text for the people who
  // diff it. Same walk, same resolution, two renderers.
  if (wantXlsx || wantCsv) {
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
