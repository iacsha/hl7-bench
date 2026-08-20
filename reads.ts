/**
 * reads.ts -- every source path in the spec that resolved to nothing.
 *
 *   bun reads.ts  < messages\real.hl7
 *   bun reads.ts --strict  < messages\real.hl7     exit 1 if a block is at risk
 *
 * THE FAILURE THIS EXISTS FOR
 *
 * The emitted class sets `IGNOREMISSINGSOURCE = 1`. That turns a source path
 * IRIS cannot resolve into a skipped `<assign>` rather than an error. Skip every
 * assign in a block and the target segment is never created, so a whole section
 * of the mapping disappears from the delivered message with no error, no
 * warning, and nothing in the Visual Trace to look at. The output is a shorter
 * message that parses cleanly and looks fine.
 *
 * That is a two-day bug on a live build and about four seconds here.
 *
 * WHAT THE TWO HEADLINES MEAN, BECAUSE THEY ARE NOT THE SAME PROBLEM
 *
 *   AT RISK        Every path the block reads belongs to a segment that is not
 *                  in this message. This is the shape that makes IRIS create no
 *                  segment at all. Usually a path that is wrong rather than a
 *                  sender that is quiet.
 *   DELIVERS EMPTY Every row resolved to "" but the paths were readable. IRIS
 *                  still creates the segment; the receiver gets a segment with
 *                  nothing in it, which is its own defect and a different one.
 *
 * THE THING THIS REPORT CANNOT SEE
 *
 * Groups. The bench's message model is flat, so `block.group` is not exercised
 * here at all. A block with the WRONG group name reads perfectly on the bench
 * and writes nowhere in IRIS, silently, which is the exact failure mode this
 * report is named after and the one case it will tell you is fine. Read the
 * group name off your namespace's schema browser; nothing on this machine can
 * check it for you.
 */

import { Message } from "./hl7";
import {
  describeSource, segmentOf, sourcePathsOf,
  type Block, type Row, type Spec,
} from "./spec";
import { assertRunnable, gate, readPath, resolve, segFor, walk, type Ctx } from "./run";

// ---------------------------------------------------------------------------

export interface EmptyRead {
  /** Block heading, with the occurrence number when the block repeats. */
  block: string;
  target: string;
  label: string;
  /** `describeSource` of the row, the same string the trace prints. */
  source: string;
  /** Why it came out empty, in the terms you would act on. */
  why: string;
  /** True when a source segment is missing from the message entirely. */
  absent: boolean;
}

export interface ReadReport {
  event: string;
  /** One entry per row that delivered nothing. */
  empty: EmptyRead[];
  /** Blocks where every path reads an absent segment. The dangerous shape. */
  atRisk: string[];
  /** Blocks that resolve but deliver nothing but empties. */
  deliversEmpty: string[];
  /** `todo()` rows, which deliver nothing by construction. */
  todos: string[];
  /** How many target rows were examined. */
  rows: number;
}

// ---------------------------------------------------------------------------

/** The heading trace.ts would print for this block, so the two line up. */
function heading(block: Block, n: number, total: number): string {
  const g = block.group ? ` (${block.group})` : "";
  return block.repeat ? `${block.id}${g}  ${n} of ${total}` : `${block.id}${g}`;
}

/**
 * Why one row delivered nothing, in the most actionable form available.
 *
 * Ordered by what you would chase first. An absent segment outranks an empty
 * field because it is far more often a path that is wrong than a sender that is
 * quiet, and it is the only one of these that can delete a whole segment from
 * the output.
 */
function diagnose(ctx: Ctx, row: Row): { why: string; absent: boolean } {
  const from = row.from;
  const paths = sourcePathsOf(from);

  const missingSegs = [
    ...new Set(paths.filter((p) => segFor(ctx, p) === undefined).map(segmentOf)),
  ];
  if (missingSegs.length > 0) {
    const which = missingSegs.join(", ");
    return {
      absent: true,
      why: `no ${which} in this message, so IRIS has nothing to resolve`,
    };
  }

  switch (from.kind) {
    case "pickRepeat":
      return {
        absent: false,
        why: `no repetition of ${from.path} has component ${from.whereComponent} = "${from.equals}"`,
      };
    case "fromFirst":
      return {
        absent: false,
        why: `no ${from.segment} in this message has a non-empty ${from.nonEmpty}`,
      };
    case "lookup": {
      const key = readPath(ctx, from.path);
      if (key === "") return { absent: false, why: `${from.path} is empty` };
      // A non-empty key that still delivered nothing took the unmapped branch,
      // and only `blank` delivers nothing, so this is unambiguous.
      return {
        absent: false,
        why: `${from.table} has no row for "${key}" and its unmapped branch is blank`,
      };
    }
    case "literal":
      return { absent: false, why: `the literal in the spec is an empty string` };
    case "counter":
    case "event":
      // Neither can be empty in practice; said plainly rather than guessed at.
      return { absent: false, why: `resolved empty, which should not happen here` };
    default: {
      const empties = paths.filter((p) => readPath(ctx, p) === "");
      if (empties.length === paths.length) {
        return { absent: false, why: `${empties.join(", ")} empty` };
      }
      // Something was read and then thrown away. Almost always a `via` step.
      const steps = (row.via ?? []).map((s) => s.kind).join(", ");
      return {
        absent: false,
        why: steps
          ? `the source had a value and a step emptied it (${steps})`
          : `the source had a value and it did not survive`,
      };
    }
  }
}

/**
 * Dry run: what this spec reads, and what came back with nothing in it.
 *
 * Routed through the same `walk` and `resolve` the runner uses, so the report
 * cannot describe a read the bench does not actually perform.
 */
export function emptyReads(spec: Spec, msg: Message): ReadReport {
  assertRunnable(spec);
  const { event } = gate(spec, msg);

  const totals = new Map<string, number>();
  walk(spec, msg, event, (block) => {
    totals.set(block.id, (totals.get(block.id) ?? 0) + 1);
  });

  const report: ReadReport = {
    event, empty: [], atRisk: [], deliversEmpty: [], todos: [], rows: 0,
  };
  const seen = new Map<string, number>();

  walk(spec, msg, event, (block, ctx) => {
    const n = (seen.get(block.id) ?? 0) + 1;
    seen.set(block.id, n);
    const head = heading(block, n, totals.get(block.id) ?? 1);

    let delivered = 0;
    let reads = 0;
    let absentReads = 0;

    for (const row of block.rows) {
      report.rows++;
      const label = row.label ?? row.target;

      if (row.from.kind === "todo") {
        report.todos.push(`${head}  ${row.target}  ${row.from.why}`);
        continue;
      }

      const paths = sourcePathsOf(row.from);
      if (paths.length > 0) {
        reads++;
        if (paths.every((p) => segFor(ctx, p) === undefined)) absentReads++;
      }

      const { value } = resolve(ctx, row);
      if (value !== "") {
        delivered++;
        continue;
      }

      const { why, absent } = diagnose(ctx, row);
      report.empty.push({
        block: head, target: row.target, label,
        source: describeSource(row.from), why, absent,
      });
    }

    // A block is at risk only when EVERY path-reading row reads an absent
    // segment. One resolvable assign is enough for IRIS to create the segment,
    // and then the problem is a thin segment rather than a missing one.
    if (reads > 0 && absentReads === reads && delivered === 0) report.atRisk.push(head);
    else if (delivered === 0 && block.rows.length > 0) report.deliversEmpty.push(head);
  });

  return report;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)].join("\n");
}

export function renderReads(spec: Spec, report: ReadReport): string {
  const out: string[] = [
    `EMPTY READS  --  ${spec.name}`,
    `Delivered as ${report.event}. ${report.rows} target row(s) examined.`,
    "",
  ];

  if (report.atRisk.length > 0) {
    out.push(
      `AT RISK (${report.atRisk.length}): every path these blocks read belongs to a segment`,
      `that is not in this message. With IGNOREMISSINGSOURCE = 1 the segment is not`,
      `created at all, and nothing says so.`,
      ...report.atRisk.map((b) => `  - ${b}`),
      "",
    );
  }

  if (report.deliversEmpty.length > 0) {
    out.push(
      `DELIVERS EMPTY (${report.deliversEmpty.length}): these blocks resolve, so the segment IS`,
      `created, and every field in it is blank. The receiver gets an empty segment.`,
      ...report.deliversEmpty.map((b) => `  - ${b}`),
      "",
    );
  }

  if (report.empty.length === 0) {
    out.push("Every source path this spec reads came back with a value.", "");
  } else {
    out.push(
      `EMPTY (${report.empty.length})`,
      table(
        ["", "BLOCK", "TARGET", "NAME", "SOURCE", "WHY"],
        report.empty.map((e) => [
          e.absent ? "!" : "", e.block, e.target, e.label === e.target ? "" : e.label,
          e.source, e.why,
        ]),
      ),
      "",
      `A "!" marks a read against a segment that is not in this message.`,
      "",
    );
  }

  if (report.todos.length > 0) {
    out.push(`TODO (${report.todos.length}), unwritten rather than empty`, ...report.todos.map((t) => `  - ${t}`), "");
  }

  out.push(
    `Groups are not checked. The bench message model is flat, so a wrong`,
    `block.group reads correctly here and writes nowhere in IRIS. Read the group`,
    `name off your schema browser.`,
  );

  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { spec } = await import("./transform");
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { logEvent } = await import("./log");

  const strict = process.argv.includes("--strict");

  // A bare `bun reads.ts` with no pipe would block on a terminal that is never
  // going to send anything, which reads as a hang.
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

  const msg = new Message(raw);
  let report: ReadReport;
  try {
    report = emptyReads(spec, msg);
  } catch (e) {
    // A gate refusal lands here. It is not a failure of this tool: the message
    // is one the interface does not handle, and there is nothing to report.
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
  }

  // Paths and reasons only. The `why` strings quote lookup KEYS, which are
  // message content, so they go in as notes rather than fields for the same
  // reason run.ts puts refusal text there.
  logEvent(
    "reads",
    {
      spec: spec.name,
      source: piped.trim().length > 0 ? "stdin" : "sample.hl7",
      rows: report.rows,
      empty: report.empty.length,
      atRisk: report.atRisk.length,
      result: report.atRisk.length > 0 ? "at-risk" : "ok",
    },
    report.atRisk.map((b) => `at risk: ${b}`),
  );

  process.stdout.write(renderReads(spec, report));

  if (strict && report.atRisk.length > 0) process.exit(1);
}
