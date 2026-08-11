/**
 * toolbox.ts -- declare a mapping as data, run it, and see every field's
 * journey from source path to target value.
 *
 * WHY THIS EXISTS
 *
 * A hand-written transform function tells you what the output is. It does not
 * tell you WHY a field came out empty, which source path fed it, or which of
 * five rules silently did nothing. When you are reverse-engineering somebody
 * else's interface -- or documenting your own for a receiving team -- that
 * "why" is the entire deliverable.
 *
 * So the mapping here is a list of rules, not a block of code. Rules are data,
 * data can be printed, and `renderTrace()` prints it as a table you can hand to
 * an analyst.
 *
 *   const rules: Rule[] = [
 *     { to: "AccountNumber", from: "PID-18.1" },
 *     { to: "ServiceDate",   from: "FT1-4",  via: [date8()] },
 *     { to: "Quantity",      from: "FT1-10", via: [signed("FT1-6", ["CH"], ["CG","R"])] },
 *   ];
 *   const out = mapOne(msg, rules);
 *   console.log(renderTrace(out));
 *
 * WHAT IT IS NOT
 *
 * Not a transformation engine and not a replacement for `transform.ts`. When
 * the logic is genuinely procedural, write a function. This is for the large
 * boring middle of real interfaces -- field goes here, field goes there, with
 * a truncation and a code lookup -- which is most of the surface area and all
 * of the documentation burden.
 */

import type { Message, Segment } from "./hl7";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What a rule can see when it runs. `seg` is set only inside `mapEach`. */
export interface Ctx {
  msg: Message;
  /** The repeating segment currently being mapped, when there is one. */
  seg?: Segment;
}

/** A source of a value. Carries its own description so the trace can print it. */
export interface Getter {
  describe: string;
  read(ctx: Ctx): string;
}

/** A named step applied to a value. Also self-describing, for the same reason. */
export interface Step {
  describe: string;
  apply(v: string, ctx: Ctx): string;
}

export interface Rule {
  /** Target field name. Free text -- this is your record layout, not ours. */
  to: string;
  /** An HL7 path string, or a Getter for anything more interesting. */
  from: string | Getter;
  /** Ordered transformations. Each one is traced separately. */
  via?: Step[];
  /** Empty after all steps is reported as missing rather than passing quietly. */
  required?: boolean;
  /** Free note. Shows up in the trace. Use it for the "ask the receiver" items. */
  note?: string;
}

export interface StepTrace {
  describe: string;
  before: string;
  after: string;
}

export interface FieldTrace {
  to: string;
  source: string;
  raw: string;
  steps: StepTrace[];
  final: string;
  required: boolean;
  missing: boolean;
  note?: string;
}

export interface MapResult {
  record: Record<string, string>;
  trace: FieldTrace[];
  /** Every required field that came out empty. ALL of them, not the first. */
  missing: string[];
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

function toGetter(from: string | Getter): Getter {
  if (typeof from !== "string") return from;
  // A bare path reads from the current repeating segment when there is one, so
  // the same rule list works under mapOne and mapEach. Inside mapEach a path
  // like "FT1-4" means "field 4 of THIS FT1", which is the only reading that
  // makes sense there.
  return {
    describe: from,
    read: ({ msg, seg }) => (seg && from.startsWith(seg.id) ? seg.get(from) : msg.get(from)),
  };
}

function runRules(ctx: Ctx, rules: Rule[]): MapResult {
  const record: Record<string, string> = {};
  const trace: FieldTrace[] = [];
  const missing: string[] = [];

  for (const rule of rules) {
    const getter = toGetter(rule.from);
    const raw = getter.read(ctx);

    let v = raw;
    const steps: StepTrace[] = [];
    for (const step of rule.via ?? []) {
      const before = v;
      v = step.apply(v, ctx);
      steps.push({ describe: step.describe, before, after: v });
    }

    const required = rule.required === true;
    const isMissing = required && v === "";
    if (isMissing) missing.push(rule.to);

    record[rule.to] = v;
    trace.push({
      to: rule.to,
      source: getter.describe,
      raw,
      steps,
      final: v,
      required,
      missing: isMissing,
      note: rule.note,
    });
  }

  return { record, trace, missing };
}

/** Map a message once. Use when the target is one record per message. */
export function mapOne(msg: Message, rules: Rule[]): MapResult {
  return runRules({ msg }, rules);
}

/**
 * Map once per repeat of `segId`, producing N records from N segments.
 *
 * This is the guard against the most expensive mistake in this whole area:
 * writing a mapping against the FIRST repeating segment and shipping it,
 * because the test message only ever had one. A DFT with four FT1 segments is
 * four charges. An ORU with twenty OBX is twenty results. If your target is one
 * flat record, one message legitimately becomes N records, and a transform that
 * silently reads only `(1)` drops the rest without a word.
 *
 * Run your rules through here and the count in the output tells you
 * immediately whether you have a 1:1 or a 1:N interface on your hands.
 */
export function mapEach(msg: Message, segId: string, rules: Rule[]): MapResult[] {
  return msg.all(segId).map((seg) => runRules({ msg, seg }, rules));
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Keep the first n characters. The HL7-timestamp-to-date-only workhorse. */
export function truncate(n: number): Step {
  return { describe: `truncate(${n})`, apply: (v) => v.slice(0, n) };
}

/** YYYYMMDD out of an HL7 TS. Same as truncate(8), named for what it means. */
export function date8(): Step {
  return { describe: "date8 (YYYYMMDD)", apply: (v) => v.slice(0, 8) };
}

export function upper(): Step {
  return { describe: "uppercase", apply: (v) => v.toUpperCase() };
}

/** Delete HL7 delimiters from free text before it corrupts the message. */
export function stripDelims(): Step {
  return {
    describe: "strip HL7 delimiters",
    apply: (v) => v.replace(/[|^~\\&]/g, ""),
  };
}

export function defaultTo(fallback: string): Step {
  return {
    describe: `default "${fallback}" when empty`,
    apply: (v) => (v === "" ? fallback : v),
  };
}

/**
 * Code translation with an explicit unmapped branch.
 *
 * `onUnmapped` is deliberately required. Blanking an unmapped code is silent
 * data loss and passing it through unchanged is a decision, not a default --
 * either can be right, and the point is that somebody chose.
 */
export function lookup(
  table: Record<string, string>,
  onUnmapped: "passthrough" | "blank" | { error: true },
): Step {
  const how =
    typeof onUnmapped === "object" ? "error" : onUnmapped;
  return {
    describe: `lookup(${Object.keys(table).length} entries, unmapped=${how})`,
    apply: (v) => {
      if (v in table) return table[v]!;
      if (how === "passthrough") return v;
      if (how === "blank") return "";
      throw new Error(`Unmapped code "${v}" and this lookup is set to error`);
    },
  };
}

/**
 * Precedence chain: try each table in order, first hit wins, and if nothing
 * hits the value passes through unchanged.
 *
 * The shape that turns up once one lookup stops being enough -- a small
 * override table consulted first, then the general conversion table.
 */
export function lookupChain(...tables: Record<string, string>[]): Step {
  return {
    describe: `lookupChain(${tables.map((t) => Object.keys(t).length).join(" then ")})`,
    apply: (v) => {
      for (const t of tables) if (v in t) return t[v]!;
      return v;
    },
  };
}

/**
 * Sign a quantity from a transaction-type field, with NO silent default.
 *
 * This exists because of a specific and expensive bug shape. Written the
 * obvious way --
 *
 *     if (type === "CH") qty = q; else qty = "-" + q;
 *
 * -- every transaction type that is not "CH" becomes a credit. Blank, unknown,
 * a new code the vendor introduced last month, a typo at the sending system:
 * all of them silently turn into money off the bill. Write the same rule with
 * the branches the other way round and unknown types silently become charges
 * instead. Two interfaces feeding one billing system with opposite defaults is
 * not a hypothetical.
 *
 * So both lists are explicit, and anything in neither list throws. If you truly
 * want a default, say so with `defaultTo` before this step, where the next
 * person can see it.
 */
export function signed(
  typePath: string,
  positive: string[],
  negative: string[],
): Step {
  return {
    describe: `signed by ${typePath} (+${positive.join("/")} -${negative.join("/")})`,
    apply: (v, ctx) => {
      const t = ctx.seg && typePath.startsWith(ctx.seg.id)
        ? ctx.seg.get(typePath)
        : ctx.msg.get(typePath);
      if (positive.includes(t)) return v;
      if (negative.includes(t)) return v.startsWith("-") ? v : `-${v}`;
      throw new Error(
        `Transaction type "${t}" at ${typePath} is in neither the positive ` +
          `nor the negative list. Add it deliberately -- do not let it default.`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Getters
// ---------------------------------------------------------------------------

export function literal(value: string): Getter {
  return { describe: `literal "${value}"`, read: () => value };
}

/** Concatenate several paths. The given-plus-middle-name idiom. */
export function join(sep: string, ...paths: string[]): Getter {
  return {
    describe: `join("${sep}", ${paths.join(", ")})`,
    read: ({ msg, seg }) =>
      paths
        .map((p) => (seg && p.startsWith(seg.id) ? seg.get(p) : msg.get(p)))
        .join(sep)
        .trim(),
  };
}

/** First non-empty of several paths. The "MSH-4 or else MSH-6" idiom. */
export function coalesce(...paths: string[]): Getter {
  return {
    describe: `coalesce(${paths.join(", ")})`,
    read: ({ msg, seg }) => {
      for (const p of paths) {
        const v = seg && p.startsWith(seg.id) ? seg.get(p) : msg.get(p);
        if (v !== "") return v;
      }
      return "";
    },
  };
}

/** Anything else. Give it a description or the trace becomes useless. */
export function compute(describe: string, fn: (ctx: Ctx) => string): Getter {
  return { describe, read: fn };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * The trace as an aligned table. This is the artifact you hand to a receiving
 * team, paste into an interface spec, or read yourself at 2am when one field is
 * empty and nobody knows why.
 */
export function renderTrace(result: MapResult | MapResult[]): string {
  const results = Array.isArray(result) ? result : [result];
  const out: string[] = [];

  results.forEach((r, i) => {
    if (results.length > 1) out.push(`--- record ${i + 1} of ${results.length} ---`);

    const rows = r.trace.map((t) => ({
      to: t.to + (t.required ? " *" : ""),
      source: t.source,
      raw: t.raw === "" ? "(empty)" : t.raw,
      steps: t.steps.length === 0 ? "" : t.steps.map((s) => s.describe).join(" -> "),
      final: t.final === "" ? "(empty)" : t.final,
      flag: t.missing ? "MISSING" : "",
    }));

    const w = (k: keyof (typeof rows)[0]) =>
      Math.max(k.length, ...rows.map((x) => x[k].length));
    const wTo = w("to"), wSrc = w("source"), wRaw = w("raw"), wStep = w("steps"), wFin = w("final");

    const line = (a: string, b: string, c: string, d: string, e: string, f: string) =>
      `${a.padEnd(wTo)}  ${b.padEnd(wSrc)}  ${c.padEnd(wRaw)}  ${d.padEnd(wStep)}  ${e.padEnd(wFin)}  ${f}`.trimEnd();

    out.push(line("TARGET", "SOURCE", "RAW", "STEPS", "FINAL", ""));
    out.push(line("-".repeat(wTo), "-".repeat(wSrc), "-".repeat(wRaw), "-".repeat(wStep), "-".repeat(wFin), ""));
    for (const x of rows) out.push(line(x.to, x.source, x.raw, x.steps, x.final, x.flag));

    const notes = r.trace.filter((t) => t.note);
    if (notes.length) {
      out.push("");
      for (const n of notes) out.push(`  note ${n.to}: ${n.note}`);
    }

    if (r.missing.length) {
      out.push("");
      out.push(`  MISSING REQUIRED: ${r.missing.join(", ")}`);
    }
    out.push("");
  });

  return out.join("\n");
}

/** The mapped record as a pipe-delimited line, in rule order. */
export function toPipeDelimited(result: MapResult, sep = "|"): string {
  return result.trace.map((t) => t.final).join(sep);
}
