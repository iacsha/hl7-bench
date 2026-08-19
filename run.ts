/**
 * run.ts -- executes a spec against a message. The bench half of `spec.ts`.
 *
 * `runSpec(spec, msg)` rebuilds `msg` in place into the delivered message, so
 * it slots straight into the existing transform contract:
 *
 *     export function transform(msg: Message): void { runSpec(spec, msg); }
 *
 * and everything downstream -- bench.ts, check.ts, gui.ts, the PipeHat
 * provider -- keeps working unchanged.
 *
 * `resolve()` is exported because `trace.ts` needs the SAME resolution the
 * runner uses. If the trace re-derived values on its own you would be back to
 * two authorings of one behaviour, with the document quietly disagreeing with
 * the bench. One code path, two consumers.
 */

import { Message, Segment, type Delims } from "./hl7";
import { logEvent } from "./log";
import {
  validate, segmentOf, fieldOf,
  type Spec, type Source, type Step, type Row, type Block,
} from "./spec";

// ---------------------------------------------------------------------------

export interface Ctx {
  msg: Message;
  /** The target trigger event the gate resolved to. */
  event: string;
  tables: Record<string, Record<string, string>>;
  /** Source segment id being walked, when inside a repeat. */
  repeatOver?: string;
  /** The current source occurrence, when inside a repeat. */
  current?: Segment;
  /** 1-based OUTPUT ordinal. Not the source repeat index; see below. */
  ordinal: number;
}

export interface Resolved {
  /** The value before `via` steps. */
  raw: string;
  /** The value written to the target. */
  value: string;
  /** Human labels for the steps that ran, for the trace. */
  steps: string[];
  /** Set when the source was `todo`. */
  todo?: string;
}

export interface RunResult {
  /** The target trigger event. */
  event: string;
  /** Labels of required fields that came out empty. Every one, not the first. */
  missing: string[];
  /** Everything worth saying on stderr: TODOs, unmapped codes, empty tables. */
  notes: string[];
  /** How many target fields were actually assigned. Counted for the log. */
  assigned: number;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Read a source path with repeat scoping.
 *
 * Inside a repeat, a path naming the repeated segment reads the CURRENT
 * occurrence. Anything else falls through to the message. This is what makes
 * `IN1-4` inside an IN1 loop mean "this coverage" while `MSH-7` in the same
 * loop still means the header. Without the scoping, coverage two and three
 * would silently be copies of coverage one.
 */
function readPath(ctx: Ctx, path: string): string {
  if (ctx.current && ctx.repeatOver && segmentOf(path) === ctx.repeatOver) {
    return ctx.current.get(path);
  }
  return ctx.msg.get(path);
}

/** The segment a path should be read from, honouring repeat scope. */
function segFor(ctx: Ctx, path: string): Segment | undefined {
  if (ctx.current && ctx.repeatOver && segmentOf(path) === ctx.repeatOver) return ctx.current;
  return ctx.msg.seg(segmentOf(path));
}

/** Field number out of a path: 7 from "PV1-7". */
function fieldNumber(path: string): number {
  const n = parseInt(fieldOf(path).split(/[.(]/)[0], 10);
  if (!Number.isFinite(n)) throw new Error(`Cannot read a field number out of "${path}"`);
  return n;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function resolveSource(ctx: Ctx, from: Source): { raw: string; todo?: string; note?: string } {
  switch (from.kind) {
    case "copy":
      return { raw: readPath(ctx, from.path) };

    case "literal":
      return { raw: from.value };

    case "firstOf": {
      for (let i = 0; i < from.paths.length; i++) {
        const p = from.paths[i];
        const v = readPath(ctx, p);
        if (v === "") continue;
        // Falling past the first path is the interesting case. It means this
        // site does not populate the field the mapping was written against,
        // which is a question for the sending system rather than a shrug.
        const note =
          i === 0 ? undefined : `${from.paths.slice(0, i).join(", ")} empty, fell back to ${p}`;
        return { raw: v, note };
      }
      return { raw: "" };
    }

    case "lookup": {
      const key = readPath(ctx, from.path);
      // An empty source is not an unmapped code. Sending the unmapped default
      // for a field the sender simply did not populate invents data.
      if (key === "") return { raw: "" };
      const table = ctx.tables[from.table] ?? {};
      if (key in table) return { raw: table[key] };
      const note = `unmapped ${from.table} code "${key}" from ${from.path}`;
      switch (from.unmapped.kind) {
        case "blank": return { raw: "", note };
        case "passthrough": return { raw: key, note };
        case "constant": return { raw: from.unmapped.value, note };
      }
    }

    case "counter":
      return { raw: String(ctx.ordinal) };

    case "event":
      return { raw: ctx.event };

    case "pickRepeat": {
      const seg = segFor(ctx, from.path);
      if (!seg) return { raw: "" };
      const id = segmentOf(from.path);
      const f = fieldNumber(from.path);
      const at = (r: number, comp?: number) =>
        seg.get(`${id}-${f}(${r})${comp === undefined ? "" : "." + comp}`);
      for (let r = 1; r <= seg.repCount(f); r++) {
        if (at(r, from.whereComponent) !== from.equals) continue;
        if (from.take === "whole") return { raw: at(r) };
        if (Array.isArray(from.take)) {
          // Joined back together rather than written as one row per component:
          // four rows would put a bare "^^^" on the wire when nothing matches.
          return { raw: from.take.map((c) => at(r, c)).join(ctx.msg.delims.comp) };
        }
        return { raw: at(r, from.take) };
      }
      return { raw: "" };
    }

    case "fromFirst": {
      for (const seg of ctx.msg.all(from.segment)) {
        if (seg.get(from.nonEmpty) === "") continue;
        return { raw: seg.get(from.path) };
      }
      return { raw: "" };
    }

    case "todo":
      return { raw: "", todo: from.why };
  }
}

function applyStep(value: string, step: Step, delims: Delims): { value: string; label: string } {
  switch (step.kind) {
    case "date8":
      return { value: value.slice(0, 8), label: "date8 (YYYYMMDD)" };
    case "truncate":
      return { value: value.slice(0, step.n), label: `truncate ${step.n}` };
    case "upper":
      return { value: value.toUpperCase(), label: "uppercase" };
    case "stripDelims": {
      const bad = [delims.field, delims.comp, delims.rep, delims.esc, delims.sub];
      return {
        value: [...value].filter((c) => !bad.includes(c)).join(""),
        label: "strip delimiters",
      };
    }
    case "stripChars":
      return {
        value: [...value].filter((c) => !step.chars.includes(c)).join(""),
        label: `strip "${step.chars}"`,
      };
    case "defaultTo":
      return {
        value: value === "" ? step.value : value,
        label: `default "${step.value}"`,
      };
  }
}

/** Source plus steps. The one place a target value is computed. */
export function resolve(ctx: Ctx, row: Row): Resolved & { note?: string } {
  const { raw, todo, note } = resolveSource(ctx, row.from);
  let value = raw;
  const steps: string[] = [];
  for (const step of row.via ?? []) {
    const applied = applyStep(value, step, ctx.msg.delims);
    value = applied.value;
    steps.push(applied.label);
  }
  return { raw, value, steps, todo, note };
}

// ---------------------------------------------------------------------------
// Building the target
// ---------------------------------------------------------------------------

/**
 * An empty segment ready to be assigned into.
 *
 * MSH is special: it needs MSH-2 present from the start, because MSH-1 is the
 * field separator and has no slot, and MSH-2 defines the rest of the
 * delimiters. Building MSH like every other segment produces a header that
 * parses back wrong.
 */
export function blankSegment(id: string, d: Delims): Segment {
  return id === "MSH"
    ? new Segment("MSH", ["MSH", d.comp + d.rep + d.esc + d.sub], d)
    : new Segment(id, [id], d);
}

/** Which source occurrences a repeat block delivers, after skip and max. */
function occurrences(msg: Message, block: Block): Segment[] {
  const r = block.repeat!;
  let segs = msg.all(r.over);
  if (r.skipWhenEmpty) segs = segs.filter((s) => s.get(r.skipWhenEmpty!) !== "");
  if (r.max !== undefined) segs = segs.slice(0, r.max);
  return segs;
}

function fill(ctx: Ctx, block: Block, out: Segment, result: RunResult): void {
  for (const row of block.rows) {
    const { value, todo, note } = resolve(ctx, row);
    const label = row.label ?? row.target;

    if (todo) {
      result.notes.push(`TODO ${label}: ${todo}`);
      continue; // no assign, so an unfinished field is empty rather than wrong
    }
    if (note) result.notes.push(note);
    if (row.note) result.notes.push(`${label}: ${row.note}`);

    // Assigned even when empty, because that is what `<assign>` does in a DTL:
    // it creates the field. Skipping empties here would make the bench produce
    // a SHORTER segment than the engine does, and a receiver that reads by
    // ordinal position sees a different message than the one you signed off.
    out.set(row.target, value);
    result.assigned++;
    if (row.required && value === "") result.missing.push(label);
  }
}

/**
 * Apply the gate, or throw.
 *
 * Throwing is deliberate and is what `<name>.reject.hl7` cases in `check.ts`
 * assert: a message this interface does not handle must fail loudly rather
 * than be delivered as something else. In IRIS the same decision belongs in
 * the routing rule, so an unhandled event never reaches the transform at all.
 */
export function gate(spec: Spec, msg: Message): { trigger: string; event: string } {
  const trigger = msg.get(spec.gate.path);
  const event = spec.gate.permit[trigger];
  if (event === undefined) {
    const handled = Object.keys(spec.gate.permit).join(", ");
    throw new Error(
      `${spec.gate.path} is "${trigger}", which this interface does not handle (handles: ${handled})`,
    );
  }
  for (const req of spec.gate.require ?? []) {
    const got = msg.get(req.path);
    if (got === req.equals) continue;
    throw new Error(`${req.path} is "${got || "(empty)"}", expected "${req.equals}"`);
  }
  return { trigger, event };
}

/**
 * Walk the delivered target, one call to `visit` per delivered segment.
 *
 * `runSpec` and `trace.ts` both go through here, so the document cannot
 * describe a different set of segments than the bench produces. Occurrence
 * counting, skip rules, and the max cap have exactly one implementation.
 */
export function walk(
  spec: Spec,
  msg: Message,
  event: string,
  visit: (block: Block, ctx: Ctx) => void,
): void {
  const tables = spec.tables ?? {};
  for (const block of spec.blocks) {
    if (!block.repeat) {
      visit(block, { msg, event, tables, ordinal: 1 });
      continue;
    }
    let ordinal = 0;
    for (const current of occurrences(msg, block)) {
      ordinal++;
      visit(block, { msg, event, tables, ordinal, repeatOver: block.repeat.over, current });
    }
  }
}

/** Structural problems, or throw. Called by every backend before it works. */
export function assertRunnable(spec: Spec): void {
  const problems = validate(spec);
  if (problems.length > 0) {
    throw new Error(`Spec "${spec.name}" is not runnable:\n  ` + problems.join("\n  "));
  }
}

/**
 * Run a spec against a message, replacing its segments with the delivered ones.
 *
 * The two `logEvent` calls are the only impure thing in this file, and they do
 * nothing at all unless HL7_BENCH_LOG is set. They live here rather than in
 * `bench.ts` because this is the single place that holds the gate decision,
 * the missing list and the notes together: `bench.ts` and `check.ts` both go
 * through `transform()`, which returns nothing.
 */
export function runSpec(spec: Spec, msg: Message): RunResult {
  assertRunnable(spec);

  let event: string;
  try {
    event = gate(spec, msg).event;
  } catch (e) {
    // A refusal is the interesting line in the log, not the boring one, so it
    // gets recorded before the throw carries it away. The gate PATH is logged
    // and the message is not, because a `require` rule can read any path --
    // including PID-3 -- and the refusal text quotes the value it found. That
    // text is a note, and notes only land on disk at `full`.
    logEvent("run", { spec: spec.name, gate: spec.gate.path, result: "refused" }, [
      (e as Error).message,
    ]);
    throw e;
  }

  const result: RunResult = { event, missing: [], notes: [], assigned: 0 };
  const out: Segment[] = [];

  walk(spec, msg, event, (block, ctx) => {
    const seg = blankSegment(block.id, msg.delims);
    fill(ctx, block, seg, result);
    out.push(seg);
  });

  // What a repeat left behind. Both of these are silent by construction: the
  // delivered message looks correct and simply has fewer segments in it than
  // the sender sent, which nobody notices until a coverage is missing.
  for (const block of spec.blocks) {
    if (!block.repeat) continue;
    const r = block.repeat;
    const all = msg.all(r.over);
    const kept = r.skipWhenEmpty
      ? all.filter((s) => s.get(r.skipWhenEmpty!) !== "")
      : all;
    const skipped = all.length - kept.length;
    if (skipped > 0) {
      result.notes.push(
        `${skipped} ${r.over} segment(s) skipped: ${r.skipWhenEmpty} empty`,
      );
    }
    if (r.max !== undefined && kept.length > r.max) {
      result.notes.push(
        `${kept.length} ${r.over} segment(s) qualify but this interface delivers at most ` +
          `${r.max}; dropping ${kept.length - r.max}`,
      );
    }
  }

  for (const [name, rows] of Object.entries(spec.tables ?? {})) {
    if (Object.keys(rows).length === 0) {
      result.notes.push(`table ${name} is empty, so every lookup against it takes the unmapped branch`);
    }
  }
  if (result.missing.length > 0) {
    result.notes.push(`MISSING REQUIRED: ${result.missing.join(", ")}`);
  }

  // The same note raised by three rows reading the same fallback is one
  // finding, not three. Repeated verbatim it stops being read at all.
  result.notes = [...new Set(result.notes)];

  // Swap the delivered segments in. Same move the imperative transform made,
  // and the reason `create='new'` is the DTL default: block order above IS the
  // output segment order, stated rather than implied.
  msg.segments.splice(0, msg.segments.length, ...out);

  logEvent(
    "run",
    {
      spec: spec.name,
      event: result.event,
      segments: out.length,
      fields: result.assigned,
      missing: result.missing.length,
      result: result.missing.length > 0 ? "missing-required" : "ok",
    },
    result.notes,
  );

  return result;
}
