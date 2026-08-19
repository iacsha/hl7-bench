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
import { assertRunnable, gate, resolve, walk, type Ctx } from "./run";

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
  const { spec } = await import("./transform");
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");

  // A bare `bun trace.ts` with no pipe would otherwise block on a terminal
  // that is never going to send anything, which reads as a hang.
  const piped = process.stdin.isTTY ? "" : await Bun.stdin.text();
  let raw = piped;
  if (raw.trim().length === 0) {
    const fallback = join(import.meta.dir, "sample.hl7");
    if (!existsSync(fallback)) {
      process.stderr.write("No message on stdin and no sample.hl7 to fall back to.\n");
      process.exit(1);
    }
    raw = readFileSync(fallback, "utf8");
  }

  const m = new Message(raw);
  process.stdout.write(trace(spec, m));
  const inv = inventory(spec, m);
  if (inv) process.stdout.write("\n" + inv);
}
