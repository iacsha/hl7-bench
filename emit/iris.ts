/**
 * emit/iris.ts -- a spec becomes an Ens.DataTransformDTL class.
 *
 * Same spec `run.ts` executes and `trace.ts` documents. You do not write the
 * mapping again here; there is nothing to write. Every source and step kind in
 * `spec.ts` is handled below, and `spec.test.ts` fails the build if one is not,
 * so the ObjectScript cannot silently express less than the bench does.
 *
 * THE THREE THINGS THIS FILE CANNOT KNOW
 *
 *  1. Whether your DocTypes are right. It writes what the spec hands it. A
 *     wrong DocType fails CLOSED in IRIS: paths stop resolving, the message
 *     comes out empty, and nothing useful reaches the log. Open the schema
 *     browser in YOUR namespace and read the real structure names.
 *  2. Whether a target segment sits inside a group. IN1 inside INSURANCE means
 *     `target.{IN1(1):2}` resolves to nothing where
 *     `target.{INSURANCEgrp(1).IN1:2}` works, with the same silence. Set
 *     `group` on the block when it does.
 *  3. Whether your Ens.Util.LookupTable rows exist. An empty table returns the
 *     default for every message, which looks exactly like a working lookup
 *     right up until someone reads a report. The header lists every table the
 *     class needs, and flags the ones your spec knows are empty.
 *
 * So: compile it, then run the golden gate against the DTL's own Test output.
 */

import {
  assertRunnable, // shared with the runner, so both reject the same specs
} from "../run";
import {
  emptyTables, segmentOf,
  type Spec, type Source, type Step, type Row, type Block, type CommentLevel,
} from "../spec";
import { fingerprint } from "../fingerprint";

// ---------------------------------------------------------------------------
// Comment volume
// ---------------------------------------------------------------------------

/**
 * How much of the WHY this class carries. `brief` unless the spec says else.
 *
 * The emitted class is maintained by the receiving site, not by whoever ran the
 * bench, so the default is the level that respects their screen. See
 * `Spec["iris"].comments` for what each level keeps.
 */
export function irisComments(spec: Spec): CommentLevel {
  return spec.iris.comments ?? "brief";
}

/**
 * The comment lines for one site, at the level in force.
 *
 * Every site names BOTH forms and hands them here rather than branching for
 * itself. That is the whole discipline: "what does brief keep" is answerable by
 * reading the second argument at each call, and a site that cannot say what its
 * one line would be is a site whose comment was never worth a line.
 */
export function pickNotes(level: CommentLevel, full: string[], brief: string[]): string[] {
  if (level === "off") return [];
  return level === "full" ? full : brief;
}

/** `pickNotes`, wrapped as DTL comments at one indent. */
function dtlNotes(
  level: CommentLevel,
  indent: string,
  full: string[],
  brief: string[],
): string[] {
  return pickNotes(level, full, brief).map((l) => `${indent}<!-- ${l} -->`);
}

// ---------------------------------------------------------------------------
// Bare segment paths
// ---------------------------------------------------------------------------

/**
 * A reference that names its segment with NO occurrence index: "{GT1}",
 * "{GT1:5}". Returns the segment id, or undefined when the reference carries an
 * occurrence, a group, or is not a segment reference at all.
 *
 * Read off the reference the emitter ACTUALLY produced rather than re-derived
 * from the spec, because the rules that decide it -- `sourceGroups`, a loop
 * prefix, the escape branches in `dtlPath` -- live in this file and a second
 * opinion about them would be wrong in exactly the cases that matter.
 */
function bareSegmentOf(braced: string): string | undefined {
  const m = /^\{([A-Z][A-Z0-9]{2})[:}]/.exec(braced);
  return m ? m[1] : undefined;
}

/**
 * The GROUP names in a reference that carry no occurrence index:
 * "{IN1grp.IN1:2}" gives ["IN1grp"], "{IN1grp(1).IN1:2}" gives none.
 *
 * The same bug as `bareSegmentOf`, one level up, and it fails the same way.
 * Measured on IRIS for Health, 2.3:ADT_A01, one IN1 inside IN1grp:
 *
 *     GRP_NO_OCC |[]
 *     GRP_OCC    |[IN1|1|PLAN1|PAY1|PAYER NAME]
 *
 * `GetValueAt("IN1grp.IN1")` returns EMPTY where `GetValueAt("IN1grp(1).IN1")`
 * returns the segment, and it is empty rather than an error, so nothing says so.
 *
 * Everything before the LAST dot is a group; the last part is the segment,
 * which `bareSegmentOf` already answers for. Field numbers live after the
 * colon and are cut first, so `{PID:5.1}` contributes nothing.
 */
function bareGroupsOf(braced: string): string[] {
  const inner = braced.replace(/^\{/, "").replace(/\}$/, "").split(":")[0]!;
  const parts = inner.split(".");
  // One part is a segment with no group in front of it. Nothing to report.
  return parts.slice(0, -1).filter((p) => !p.includes("("));
}

/**
 * References an emit addressed with no occurrence index, collected as it goes.
 *
 * Two sets and not one, because they have different fixes and `emit.ts` prints
 * them under different headings. A group name in the segment list would read as
 * a segment that does not exist.
 */
export interface BareRefs {
  /** Segment ids: "GT1". */
  segments: Set<string>;
  /** Group names: "IN1grp". */
  groups: Set<string>;
}

export const newBareRefs = (): BareRefs => ({ segments: new Set(), groups: new Set() });

/**
 * Record a SOURCE reference that carries no occurrence index.
 *
 * In IRIS, `GetValueAt("GT1")` on a segment the schema marks as repeating --
 * `^EnsHL7.Schema(2.3,"MS","ADT_A01","map","GT1()")` -- returns EMPTY. Measured
 * on a live instance, not assumed. The read finds nothing, the absent-seed
 * guard correctly delivers no segment, and the interface drops the segment in
 * production without a word.
 *
 * `bun check.ts` cannot catch it: `run.ts` has a flat message model and finds a
 * segment by name whatever the schema says about repeats. The bench does not
 * read your schema, so it cannot know which segments repeat -- what it CAN do
 * is say which ones it ASSUMED do not, and let you spend ten seconds checking.
 * `emit.ts` prints them.
 */
export function noteBare(st: State, braced: string): void {
  const id = bareSegmentOf(braced);
  if (id) st.bare.segments.add(id);
  for (const g of bareGroupsOf(braced)) st.bare.groups.add(g);
}

// ---------------------------------------------------------------------------
// Path and string plumbing
// ---------------------------------------------------------------------------

/**
 * Bench syntax to DTL syntax. "PID-5.1" becomes "{PID:5.1}".
 *
 * The only structural difference is where the colon goes, which is why the
 * bench uses a dash: reading them side by side, a path you got wrong is
 * visible rather than plausible.
 */
export function dtlPath(
  path: string,
  prefix = "",
  groups: Record<string, string> = {},
): string {
  const m = /^([A-Z0-9]{3})-(.+)$/.exec(path.trim());
  if (!m) throw new Error(`Not an HL7 path: "${path}". Expected e.g. PID-5.1`);
  const [, seg, rest] = m;

  // Where this segment lives when nothing else is in scope. Top level unless
  // `iris.sourceGroups` says the schema keeps it inside a group.
  const home = (): string => {
    const g = groups[seg];
    return g ? `{${g}.${seg}:${rest}}` : `{${seg}:${rest}}`;
  };

  if (!prefix) return home();

  // Inside a loop the prefix is either a group occurrence, "INSURANCEgrp(k1)",
  // or the repeating segment itself, "IN1(k1)". In the second case the segment
  // id is already in the prefix and repeating it gives {IN1(k1).IN1:4}, which
  // resolves to nothing and does it silently.
  const p = /^([A-Z0-9]{3})\((\w+)\)$/.exec(prefix);
  if (p) {
    // A bare segment prefix, so the loop walks the segment itself.
    if (p[1] === seg) return `{${seg}(${p[2]}):${rest}}`;
    // A DIFFERENT segment read from inside that loop is not nested in it -- it
    // is elsewhere in the message, and `{OBX(k1).OBR:4.1}` resolves to nothing.
    // `run.ts` reads it off the message for exactly this case, so this escapes
    // the loop to agree with it -- to the segment's own home, which is the top
    // level unless sourceGroups places it somewhere else.
    return home();
  }

  // A group prefix. It belongs to the segment the loop walks, so a read of a
  // DIFFERENT segment has to escape it the same way the bare-segment branch
  // does. `{ORCgrp(1).OBXgrp(k1).OBR:4.1}` resolves to nothing and says so
  // never -- the OBR is in ORCgrp, but it is in OBRgrp, not OBXgrp.
  //
  // Only a spec that describes its source layout gets that judgement. With no
  // `sourceGroups` at all there is nothing to escape TO: the emitter has no
  // idea where the segment lives, and nesting is what it has always done.
  if (Object.keys(groups).length > 0 && stripOccurrence(prefix) !== groups[seg]) {
    return home();
  }

  return `{${prefix}.${seg}:${rest}}`;
}

/**
 * The DTL reference for a WHOLE segment: "{PID}", "{NK1(n1)}", "{IN1grp(1).IN1}".
 *
 * `dtlPath` cannot express this -- every path it takes carries a field number,
 * because every other thing the vocabulary assigns is a field. A reference with
 * no ":n" on it resolves to the segment's own text, which is what
 * `GetValueAt("PID")` returns in ObjectScript and what the assign below copies.
 *
 * The prefix rules are `dtlPath`'s, minus the escape branches: a seed is the
 * identity copy, so the segment being addressed is always the one the loop is
 * walking and there is never a different segment to escape to.
 */
export function dtlSegment(
  id: string,
  prefix = "",
  groups: Record<string, string> = {},
): string {
  if (!prefix) {
    const g = groups[id];
    return g ? `{${g}.${id}}` : `{${id}}`;
  }
  // A bare segment prefix, "NK1(k1)": the id is already in it, and repeating it
  // gives {NK1(k1).NK1}, which resolves to nothing and does it quietly.
  const p = /^([A-Z0-9]{3})\((\w+)\)$/.exec(prefix);
  if (p) {
    if (p[1] === id) return `{${id}(${p[2]})}`;
    return dtlSegment(id, "", groups);
  }
  // A group prefix that is not where this spec says the segment lives. Same
  // judgement `dtlPath` makes, and for the same reason: nesting it anyway
  // produces a reference that resolves to nothing and reports that never.
  if (Object.keys(groups).length > 0 && stripOccurrence(prefix) !== groups[id]) {
    return dtlSegment(id, "", groups);
  }
  return `{${prefix}.${id}}`;
}

/** "ORCgrp(1).OBXgrp(k1)" becomes "ORCgrp(1).OBXgrp". */
function stripOccurrence(prefix: string): string {
  return prefix.replace(/\([^)]*\)$/, "");
}

/** Escape for an XML attribute delimited by single quotes. */
function attr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;");
}

/** Escape for XML character data, for comments. */
function text(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/--/g, "- -");
}

/**
 * What a `pickRepeat` takes out of the matching repetition.
 *
 * The list form concatenates with a literal "^", which assumes the standard
 * component separator. Every feed in the wild uses it, and MSH-2 declaring
 * something else would break far more than this line, but it IS an assumption
 * and it is stated here rather than buried.
 */
function takeExpr(
  take: number | number[] | "whole",
  at: (idx: string, comp?: number) => string,
  i: string,
): string {
  if (take === "whole") return at(i);
  if (Array.isArray(take)) return take.map((c) => at(i, c)).join(`_"^"_`);
  return at(i, take);
}

/**
 * An ObjectScript string literal. Internal quotes double, they do not escape.
 *
 * Exported for `emit/process.ts`, which builds ObjectScript out of the same
 * free-text spec fields. Two functions quoting the same strings two ways is one
 * of them being wrong, and the wrong one fails at compile time in a file nobody
 * generated on purpose.
 */
export function os(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Comment text that cannot end a `///` line early or open a block comment.
 *
 * Exported for the same reason `os` is: `emit/process.ts` and `emit/inline.ts`
 * both put free-text spec fields into ObjectScript comments, and three copies
 * of this rule is two of them going stale.
 */
export function comment(s: string): string {
  return s.replace(/\r?\n/g, " ").replace(/\*\//g, "* /");
}

/**
 * A DTL path rendered as an ObjectScript STRING expression.
 *
 * The curly form, `{PID:5.1}`, is a DTL compiler feature. It works in a DTL
 * attribute -- `<assign value=`, `<if condition=`, `<foreach property=` -- and
 * nowhere else. A `<code>` body is handed to the ObjectScript compiler exactly
 * as written, so a brace there fails with "invalid name" at compile time
 * rather than at runtime, which is at least the good kind of failure.
 *
 * Occurrence numbers that are loop VARIABLES have to come out of the literal
 * and be concatenated in, or the class looks for a repetition literally
 * numbered "k1". A `*` or a fixed digit stays inside the string, because that
 * is what it means to the message class.
 */
function osPath(path: string): string {
  const parts: string[] = [];
  let lit = "";
  let last = 0;
  for (const m of path.matchAll(/\(([^)]*)\)/g)) {
    const inner = m[1];
    if (inner === "" || inner === "*" || /^\d+$/.test(inner)) continue;
    lit += path.slice(last, m.index) + "(";
    parts.push(os(lit));
    parts.push(inner);
    lit = ")";
    last = m.index! + m[0].length;
  }
  lit += path.slice(last);
  if (lit !== "") parts.push(os(lit));
  return parts.join("_");
}

/**
 * The same reference a DTL attribute would write, in the form a `<code>` body
 * can compile. `source.{PID:8}` becomes `source.GetValueAt("PID:8")`.
 */
function codeRef(braced: string): string {
  const m = /^(\w+)\.\{(.+)\}$/.exec(braced);
  if (!m) throw new Error(`Not a DTL reference: "${braced}"`);
  return `${m[1]}.GetValueAt(${osPath(m[2])})`;
}

/**
 * A bare DTL path reference as the ObjectScript STRING a Get/SetValueAt wants.
 * "{IN1grp(n1).IN1:4}" becomes `"IN1grp("_n1_").IN1:4"`.
 *
 * `codeRef` answers the same question for a reference that carries its object;
 * this one is for the WRITE side, where the path and the object are two
 * arguments rather than one expression.
 */
export function pathString(braced: string): string {
  const m = /^\{(.+)\}$/.exec(braced);
  if (!m) throw new Error(`Not a DTL path reference: "${braced}"`);
  return osPath(m[1]);
}

// ---------------------------------------------------------------------------
// Dialects: the ONE thing that differs between the two backends
// ---------------------------------------------------------------------------

/**
 * How a path is spelled, and where statements are allowed to live.
 *
 * `sourceCode` below is the single definition of all ten source kinds, and
 * `stepCode` the single definition of all seven step kinds. Both are shared
 * verbatim by the DTL backend and the inline business-process backend, because
 * the only thing that actually differs between them is this:
 *
 *   dtl      source.{PID:5.1}               braced, a DTL compiler feature
 *   inline   ..ValueAt(tSource,"PID:5.1")   plain ObjectScript, and guarded
 *
 * A second copy of `sourceCode` for the inline backend is the failure this
 * type exists to prevent. Seventeen kinds, two copies, and a kind added to one
 * of them reads on the bench as a mapping that works and delivers an empty
 * field in the namespace. `spec.test.ts` holds every backend to every kind, and
 * it can only do that while there is one definition to hold.
 */
export interface Dialect {
  /** A path in EXPRESSION position: a DTL attribute, or anywhere in a Method. */
  value(braced: string): string;
  /** A path inside a STATEMENT body. The same thing, in a place DTL narrows. */
  code(braced: string): string;
  /**
   * The lookup-table call.
   *
   * `..Lookup` is a method of Ens.DataTransformDTL and exists nowhere else. A
   * business process calling it does not compile, which is the good kind of
   * failure, and it is still a failure nobody should have to discover.
   */
  lookup(table: string, key: string, fallback: string): string;
  /** Wrap statements so the backend can hold them. */
  block(lines: string[]): string[];
}

/** The DTL backend. A `<code>` element is the only place statements may live. */
export const DTL: Dialect = {
  value: (braced) => braced,
  code: (braced) => codeRef(braced),
  lookup: (table, key, fallback) => `..Lookup(${table},${key},${fallback})`,
  block: (lines) => [
    `<code>`,
    `  <![CDATA[`,
    ...lines.map((l) => `  ${l}`),
    `  ]]>`,
    `</code>`,
  ],
};

/**
 * The inline business-process backend. Everything is already a statement body,
 * so a block is the lines themselves and the caller indents them.
 *
 * Every read goes through `..ValueAt`, the guarded helper `emit/inline.ts`
 * writes into the class. A bare `GetValueAt` on a path whose SEGMENT is absent
 * THROWS, and an unhandled throw inside `OnRequest` fails the message -- so a
 * self-pay patient with no IN1 becomes an error queue entry for being ordinary.
 * That is a production failure this shop has already had.
 */
export const INLINE: Dialect = {
  value: (braced) => inlineRead(braced),
  code: (braced) => inlineRead(braced),
  lookup: (table, key, fallback) =>
    `##class(Ens.Util.FunctionSet).Lookup(${table},${key},${fallback})`,
  block: (lines) => lines,
};

/** "source.{PID:5}" becomes `..ValueAt(tSource,"PID:5")`. */
function inlineRead(braced: string): string {
  const m = /^(\w+)\.\{(.+)\}$/.exec(braced);
  if (!m) throw new Error(`Not a DTL reference: "${braced}"`);
  const obj = m[1] === "source" ? "tSource" : m[1] === "target" ? "tTarget" : m[1];
  return `..ValueAt(${obj},${osPath(m[2])})`;
}

/**
 * The one statement that finds the highest value of a path across a scan.
 *
 * Shared rather than written twice: "empty ranks lowest", "digits compare as
 * numbers so 10 beats 9" and "anything else compares as text" are three
 * decisions, and a backend that drifts on any of them delivers the wrong
 * revision of a report with every individual field correct.
 */
export function highestScanStatement(read: string, mx: string, v: string): string {
  return (
    `set ${v} = ${read} ` +
    `if ${v}'="" { ` +
    `if ${mx}="" { set ${mx} = ${v} } ` +
    `elseif ((${v}?1.N)&&(${mx}?1.N)) { if +${v}>+${mx} set ${mx} = ${v} } ` +
    `elseif (${v}]${mx}) { set ${mx} = ${v} } }`
  );
}

/**
 * The unmapped-code check, as one statement, for whichever backend asked.
 *
 * The obvious test -- "did Lookup come back empty" -- is wrong for two of the
 * three unmapped branches, which is what MISS is for. Written once so the two
 * backends cannot disagree about when a lookup miss is reportable.
 */
export function lookupMissStatement(
  d: Dialect,
  table: string,
  ref: string,
  message: string,
): string {
  return `if $LENGTH(${ref}),${d.lookup(os(table), ref, MISS)}=${MISS} { $$$LOGWARNING(${message}) }`;
}

/** A class name out of a free-text spec name. */
function classNameFor(spec: Spec): string {
  if (spec.iris.className) return spec.iris.className;
  const parts = spec.name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1));
  return `Bench.${parts.join("") || "Transform"}`;
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export interface Scope {
  /** Path prefix for source reads inside a loop, e.g. "INSURANCEgrp(k1)". */
  sourcePrefix: string;
  /** Path prefix for target writes inside a loop, e.g. "INSURANCEgrp(n1)". */
  targetPrefix: string;
  /** Ordinal counter variable, when a loop is in scope. */
  counterVar?: string;
}

const TOP: Scope = { sourcePrefix: "", targetPrefix: "" };

/**
 * Where the SOURCE schema keeps each segment, when it is not at the top level.
 *
 * Target-side grouping is `block.group` and is a different fact: a source can
 * be nested where the target is flat, which is the ordinary case when the two
 * DocTypes are different HL7 versions. Reading one off the other produces a
 * transform that resolves nothing on one side and says nothing about it.
 */
export function srcGroups(st: State): Record<string, string> {
  return st.spec.iris.sourceGroups ?? {};
}

/** Emitter state that has to be unique across the whole class. */
export interface State {
  spec: Spec;
  /** Next temp variable number, for scans that need a preamble. */
  temp: number;
  /**
   * References this run addressed on the SOURCE side with no occurrence index,
   * segments and groups kept apart. See `noteBare` for why anyone cares.
   */
  bare: BareRefs;
}

/** A fresh state, with the one collector nobody should have to remember. */
export function newState(spec: Spec, bare: BareRefs = newBareRefs()): State {
  return { spec, temp: 1, bare };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * The ObjectScript for one source. THE definition of all ten source kinds.
 *
 * Some sources need statements, not just an expression: scanning repetitions
 * is a loop. Those return `pre`, lines emitted immediately above the assign at
 * the same indent, and an `expr` that reads the variable they set.
 *
 * `d` decides how a path is spelled and how `pre` is wrapped, and nothing else.
 * Both backends call this function; neither has a copy of it. See `Dialect`.
 */
export function sourceCode(
  st: State,
  from: Source,
  scope: Scope,
  d: Dialect = DTL,
): { expr: string | null; pre?: string[] } {
  const groups = srcGroups(st);
  const src = (p: string) => {
    const braced = dtlPath(p, scope.sourcePrefix, groups);
    noteBare(st, braced);
    return d.value(`source.${braced}`);
  };

  switch (from.kind) {
    case "copy":
      return { expr: src(from.path) };

    case "literal":
      return { expr: os(from.value) };

    case "firstOf": {
      // $SELECT stops at the first true condition, so nesting is not needed.
      // A final 1: arm keeps it from erroring when every path is empty.
      const arms = from.paths.map((p) => `$LENGTH(${src(p)})>0:${src(p)}`);
      return { expr: `$SELECT(${arms.join(",")},1:"")` };
    }

    case "lookup": {
      // The key is a flat path, or a source that has to run first to find the
      // occurrence carrying it. The nested form emits that source's own
      // preamble, then looks up the variable it left behind -- so the lookup
      // does not need to know how the key was found.
      let pre: string[] | undefined;
      let ref: string;
      if (from.from) {
        const inner = sourceCode(st, from.from as Source, scope, d);
        pre = inner.pre;
        ref = inner.expr!;
      } else {
        ref = src(from.path ?? "");
      }
      const fallback =
        from.unmapped.kind === "blank" ? '""'
        : from.unmapped.kind === "passthrough" ? ref
        : os(from.unmapped.value);
      // Guard on emptiness so a field the sender left blank does not take the
      // unmapped branch and invent a value.
      const call = d.lookup(os(from.table), ref, fallback);
      return { expr: `$SELECT($LENGTH(${ref})>0:${call},1:"")`, pre };
    }

    case "counter":
      if (!scope.counterVar) throw new Error("counter() used outside a repeat");
      return { expr: scope.counterVar };

    case "event": {
      // The gate lives in the routing rule, but the target event still has to
      // be stamped. One $SELECT keeps this class correct for every trigger the
      // rule lets through, and empty for anything it should not have.
      const g = st.spec.gate;
      const braced = dtlPath(g.path, "", groups);
      noteBare(st, braced);
      const ref = d.value(`source.${braced}`);
      const arms = Object.entries(g.permit).map(([tr, ev]) => `${ref}=${os(tr)}:${os(ev)}`);
      return { expr: `$SELECT(${arms.join(",")},1:"")` };
    }

    case "pickRepeat": {
      // Position-based reads of doctor fields are the most common quiet bug in
      // this work: the same doctor arrives twice, once qualified and once not,
      // and which comes first is not stable across sites. So scan.
      const v = `p${st.temp++}`;
      const i = `i${v}`;
      const id = segmentOf(from.path);
      const f = from.path.slice(id.length + 1).split(/[.(]/)[0];
      // The statement form, not the braced form: every use below lands inside
      // a body the ObjectScript compiler reads verbatim.
      const at = (idx: string, comp?: number) => {
        // The occurrence goes on the FIELD here, not the segment, so a
        // repeating segment is still addressed bare and still reads empty.
        const braced = dtlPath(
          `${id}-${f}(${idx})${comp === undefined ? "" : "." + comp}`,
          scope.sourcePrefix,
          groups,
        );
        noteBare(st, braced);
        return d.code(`source.${braced}`);
      };
      return {
        expr: v,
        pre: d.block([
          `set ${v} = ""`,
          `for ${i}=1:1:${at("*")} {`,
          `  if ${at(i, from.whereComponent)} = ${os(from.equals)} {`,
          `    set ${v} = ${takeExpr(from.take, at, i)}`,
          `    quit`,
          `  }`,
          `}`,
        ]),
      };
    }

    case "fromFirst": {
      // A bare NK1-2 on a message with three NK1s returns EMPTY in IRIS rather
      // than the first repeat. This is not a convenience, it is the only read
      // that works.
      const v = `p${st.temp++}`;
      const seg = from.segment;
      const rest = (p: string) => p.slice(seg.length + 1);
      // The occurrence number goes on whatever actually repeats. At the top
      // level that is the segment; inside a group it is the GROUP, and the
      // segment is a single member of each occurrence. `{OBX(3):5}` on a
      // grouped OBX resolves to nothing, silently, which is the failure this
      // whole source kind exists to avoid.
      const g = groups[seg];
      const count = d.code(g ? `source.{${g}(*)}` : `source.{${seg}(*)}`);
      const ref = (p: string) =>
        d.code(
          g
            ? `source.{${g}(i${v}).${seg}:${rest(p)}}`
            : `source.{${seg}(i${v}):${rest(p)}}`,
        );
      return {
        expr: v,
        pre: d.block([
          `set ${v} = ""`,
          `for i${v}=1:1:${count} {`,
          `  if $LENGTH(${ref(from.nonEmpty)}) > 0 {`,
          `    set ${v} = ${ref(from.path)}`,
          `    quit`,
          `  }`,
          `}`,
        ]),
      };
    }

    case "fromWhere": {
      // The same walk as fromFirst, asking a different question. The
      // occurrence number goes on whatever repeats -- the group when the
      // schema nests this segment, the segment itself otherwise.
      const v = `w${st.temp++}`;
      const seg = from.segment;
      const rest = (p: string) => p.slice(seg.length + 1);
      const g = groups[seg];
      const count = d.code(g ? `source.{${g}(*)}` : `source.{${seg}(*)}`);
      const ref = (p: string) =>
        d.code(
          g
            ? `source.{${g}(i${v}).${seg}:${rest(p)}}`
            : `source.{${seg}(i${v}):${rest(p)}}`,
        );
      return {
        expr: v,
        pre: d.block([
          `set ${v} = ""`,
          `for i${v}=1:1:${count} {`,
          `  if ${ref(from.where)} = ${os(from.equals)} {`,
          `    set ${v} = ${ref(from.read)}`,
          `    quit`,
          `  }`,
          `}`,
        ]),
      };
    }

    case "todo":
      return { expr: null };
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Wrap an expression in one step. Same semantics the runner applies, and THE
 * definition of all seven step kinds.
 *
 * Shared by both backends with no dialect at all: every step below is already
 * plain ObjectScript acting on an expression, so there is nothing here for a
 * backend to spell differently.
 */
export function stepCode(expr: string, step: Step): string {
  switch (step.kind) {
    case "date8":
      return `$EXTRACT(${expr},1,8)`;
    case "truncate":
      return `$EXTRACT(${expr},1,${step.n})`;
    case "upper":
      return `$ZCONVERT(${expr},"U")`;
    case "stripDelims":
      // The five HL7 delimiters, in MSH-1 plus MSH-2 order. A value carrying
      // one of these splits the field it lands in.
      return `$TRANSLATE(${expr},"|^~\\&")`;
    case "stripChars":
      return `$TRANSLATE(${expr},${os(step.chars)})`;
    case "defaultTo":
      return `$SELECT($LENGTH(${expr})>0:${expr},1:${os(step.value)})`;
    case "prefix":
      return `${os(step.text)}_${expr}`;
  }
  // Unreachable while the file matches spec.ts. It is here for when it does
  // NOT -- a half-copied update leaves a `via` kind this switch has never
  // heard of, the function returns undefined, and the failure surfaces three
  // frames later as "undefined is not an object (evaluating 's.replace')" in
  // the pane that was trying to escape it. Name the kind instead.
  throw new Error(
    `emit/iris.ts does not handle the "${(step as { kind: string }).kind}" step. ` +
      `This file is older than the spec.ts beside it -- copy them together.`,
  );
}

// ---------------------------------------------------------------------------
// Rows and blocks
// ---------------------------------------------------------------------------

/**
 * What the generated class logs at run time. Nothing to do with the bench's
 * own HL7_BENCH_LOG, which writes files on your machine. This one runs inside
 * IRIS and writes to the Event Log.
 */
export function irisLog(spec: Spec): "off" | "warn" | "trace" {
  return spec.iris.log ?? "warn";
}

/**
 * `$CHAR(0)` as the "not in the table" sentinel.
 *
 * The obvious test for an unmapped code is "did Lookup come back empty", and
 * it is wrong for two of the three unmapped branches: with `passthrough` the
 * fallback IS the source value and with `constant` it is a real code, so a
 * miss and a hit are indistinguishable by result. A second Lookup with a
 * value no table can contain answers the question the fallback erases. It
 * costs one extra global read per lookup per message, only when logging is on.
 */
const MISS = "$CHAR(0)";

/** A `<code>` block. Indented rather than inlined so the DTL stays readable. */
function code(indent: string, body: string): string[] {
  return [`${indent}<code>`, `${indent}  <![CDATA[ ${body} ]]>`, `${indent}</code>`];
}

/**
 * The seed assign for a `wholeSegment` block, emitted above that block's rows.
 *
 * One `<assign>` of segment to segment. In the compiled class it is
 * `target.SetValueAt(source.GetValueAt("PID"),"PID")`, the same call a
 * hand-written business process makes, so the bench and the engine copy the
 * same bytes. The rows that follow overwrite fields on top of it, which is why
 * this has to come first and why nothing here reads the rows.
 */
function emitSeed(
  st: State,
  block: Block,
  scope: Scope,
  indent: string,
  out: string[],
  ownsLabel = true,
): void {
  if (!block.wholeSegment) return;
  const braced = dtlSegment(block.id, scope.sourcePrefix, srcGroups(st));
  noteBare(st, braced);
  const from = `source.${braced}`;
  const to = `target.${dtlSegment(block.id, scope.targetPrefix)}`;
  out.push(
    ...dtlNotes(
      irisComments(st.spec),
      indent,
      [
        `${text(block.id)}: copied WHOLE from the source, then overwritten below.`,
        `     Fields not listed below are passed through unexamined.`,
      ],
      // Silent when the caller already named this block. The guarded
      // non-repeating case prints the guard and the seed as ONE decision, and a
      // second line restating it is the repetition `brief` exists to cut.
      ownsLabel ? [`${text(block.id)}: copied WHOLE, then overwritten below.`] : [],
    ),
    `${indent}<assign value='${attr(from)}' property='${attr(to)}' action='set' />`,
  );
}

function emitRow(st: State, row: Row, scope: Scope, indent: string, out: string[]): void {
  const notes = irisComments(st.spec);

  // A note is the engineer's own words about a decision, so it survives `brief`
  // and goes at `off` -- which is what "off" means.
  if (notes !== "off" && row.note) out.push(`${indent}<!-- ${text(row.note)} -->`);

  if (row.from.kind === "todo") {
    // Printed at EVERY level, `off` included. A todo row emits no assign, so
    // this comment is not commentary about the row -- it is the only trace the
    // row leaves. Dropping it deletes an undecided field silently, which is the
    // failure the whole todo() kind exists to make visible.
    out.push(`${indent}<!-- TODO ${text(row.target)}: ${text(row.from.why)} -->`);
    if (notes === "full") {
      out.push(`${indent}<!--      Write this assign by hand. The generator will not guess it. -->`);
    }
    return;
  }

  // NO LABEL LINE HERE, AND THAT IS THE DIFFERENCE BETWEEN THE TWO BACKENDS.
  //
  // `emit/inline.ts` emits one, because there the label rides inside the
  // write-failure message at `full` and `brief` shortens that message to the
  // path -- so without a line of its own the label would be LOST at the level
  // that is now the default.
  //
  // A DTL has no write-status message. A row's label reaches this file only
  // when the row is `required`, and that message is unchanged at every level.
  // So `brief` loses nothing here, and adding a label line would not be a
  // reduction -- it would be a new feature that makes the class LONGER, which
  // is the opposite of what this setting was asked for. Measured on the EXA
  // spec: 286 lines at `full`, 304 at `brief`, with the label line in.
  //
  // Labelling every DTL assign may still be worth doing. It is a separate
  // change with its own argument, not a rider on this one.

  const { expr, pre } = sourceCode(st, row.from, scope);
  for (const line of pre ?? []) out.push(indent + line);

  let value = expr!;
  for (const step of row.via ?? []) value = stepCode(value, step);

  const prop = `target.${dtlPath(row.target, scope.targetPrefix)}`;
  const level = irisLog(st.spec);
  const label = row.label ?? row.target;

  // An unmapped code, reported before the assign that swallows it. This is
  // one of exactly two silent failures the class can see for itself: the
  // message is delivered, it is well formed, and the field is wrong.
  // Skipped when the key came through a nested source: that source runs in a
  // <code> block above the assign and leaves its answer in a variable, and
  // re-running the walk here to build a warning would double the work and
  // could disagree with the value actually used.
  if (level !== "off" && row.from.kind === "lookup" && row.from.path) {
    const ref = codeRef(`source.${dtlPath(row.from.path, scope.sourcePrefix, srcGroups(st))}`);
    // Built with os() on both halves rather than typed as one literal: a
    // table name or a label is free text out of the spec, and one quote in it
    // would otherwise close the ObjectScript string early and fail to compile.
    const where =
      row.from.path === row.target ? row.target : `${row.from.path} to ${row.target}`;
    const msg =
      `${os(`${row.from.table} has no row for "`)}_${ref}_${os(`" (${where})`)}`;
    out.push(...code(indent, lookupMissStatement(DTL, row.from.table, ref, msg)));
  }

  out.push(`${indent}<assign value='${attr(value)}' property='${attr(prop)}' action='set' />`);

  // The other silent failure: a required target that came out empty. Checked
  // on the TARGET after the assign rather than on the source before it, so it
  // catches a source that was populated and a step that emptied it.
  if (level !== "off" && row.required) {
    // "PID-3 (PID-3) is required" is what an unlabelled row used to print. The
    // parenthetical is there to name the field in human terms for whoever reads
    // the Event Log at 3am; repeating the path says nothing and looks like a
    // bug in the generator, which costs trust the log line needs.
    const named = label === row.target ? row.target : `${row.target} (${label})`;
    const msg = os(`${named} is required and came out empty`);
    out.push(...code(indent, `if '$LENGTH(${codeRef(prop)}) { $$$LOGWARNING(${msg}) }`));
  }

  // A trace carries the VALUE, which is message content. That is not a new
  // exposure -- Visual Trace already shows you the whole message either side
  // of this transform -- but it is the reason this is not the default.
  if (level === "trace") {
    out.push(...code(indent, `$$$TRACE(${os(`${row.target} = `)}_${codeRef(prop)})`));
  }
}

function emitRepeat(st: State, block: Block, index: number, out: string[]): void {
  const r = block.repeat!;
  const k = `k${index + 1}`;
  const n = `n${index + 1}`;
  const grp = block.group;
  // Source and target group separately. `block.group` describes the TARGET, and
  // defaulting the source to it is right only when both DocTypes nest the same
  // way. They routinely do not -- a 2.5 source keeps OBX in ORCgrp while a 2.3
  // target keeps it flat -- so `iris.sourceGroups` wins for the source side
  // when it has an answer, and nothing changes for a spec that does not set it.
  const sgrp = srcGroups(st)[r.over] ?? grp;

  // Without a group the segment repeats directly and the occurrence number
  // goes on the segment itself. With a group, it goes on the group.
  const srcRef = sgrp ? `source.{${sgrp}()}` : `source.{${r.over}()}`;
  const scope: Scope = {
    sourcePrefix: sgrp ? `${sgrp}(${k})` : `${r.over}(${k})`,
    targetPrefix: grp ? `${grp}(${n})` : `${block.id}(${n})`,
    counterVar: n,
  };

  const notes = irisComments(st.spec);

  out.push("");
  if (notes !== "off" && block.note) out.push(`  <!-- ${text(block.note)} -->`);
  out.push(
    ...dtlNotes(
      notes,
      "  ",
      [
        `${text(block.id)}: numbered by OUTPUT ordinal (${n}), not by source repeat (${k}).`,
        `     A skipped repetition must not leave a hole in the set ids.`,
      ],
      [`${text(block.id)}: numbered by OUTPUT ordinal (${n}), not by source repeat (${k}).`],
    ),
    `  <code>`,
    `    <![CDATA[ set ${n} = 0 ]]>`,
    `  </code>`,
    `  <foreach property='${attr(srcRef)}' key='${k}' >`,
  );

  const guards: string[] = [];
  if (r.skipWhenEmpty) {
    const braced = dtlPath(r.skipWhenEmpty, scope.sourcePrefix, srcGroups(st));
    noteBare(st, braced);
    guards.push(`$LENGTH(source.${braced})>0`);
  }

  // select, between skipWhenEmpty and max, because that is the order the stages
  // run in and the order decides the result.
  if (r.select) {
    const sel = r.select;
    const selBraced = dtlPath(sel.path, scope.sourcePrefix, srcGroups(st));
    noteBare(st, selBraced);
    const here = `source.${selBraced}`;
    if (sel.kind === "equals") {
      guards.push(`${here}=${os(sel.value)}`);
    } else {
      // `highest` cannot be a guard on its own: the maximum is not known until
      // every occurrence has been read, so it needs a pass of its own first.
      // Two sequential <foreach> elements over the same property, not a nested
      // one -- the scan finishes before the emit starts.
      const mx = `max${index + 1}`;
      const v = `v${index + 1}`;
      const km = `${k}m`;
      const scanPrefix = sgrp ? `${sgrp}(${km})` : `${r.over}(${km})`;
      const scanBraced = dtlPath(sel.path, scanPrefix, srcGroups(st));
      noteBare(st, scanBraced);
      const read = codeRef(`source.${scanBraced}`);
      out.push(
        ...dtlNotes(
          notes,
          "  ",
          [
            `${text(block.id)}: first pass finds the highest ${text(sel.path)}.`,
            `     Empty ranks lowest, so a message that carries none keeps them all.`,
            `     Digits compare as numbers so 10 beats 9; anything else compares as text.`,
          ],
          [
            `${text(block.id)}: first pass finds the highest ${text(sel.path)}. Empty ranks ` +
              `lowest; digits compare as numbers, anything else as text.`,
          ],
        ),
        ...code("  ", `set ${mx} = ""`),
        `  <foreach property='${attr(srcRef)}' key='${km}' >`,
        ...code("    ", highestScanStatement(read, mx, v)),
        `  </foreach>`,
      );
      guards.push(`${here}=${mx}`);
    }
  }

  if (r.max !== undefined) guards.push(`${n}<${r.max}`);

  const body: string[] = [];
  const bodyIndent = guards.length ? "        " : "    ";

  if (r.fold) {
    // A fold is n:1, and a <foreach> has nowhere to hold a segment across an
    // iteration. So rather than deferring the head, this writes the head
    // immediately and APPENDS a continuation onto the target field already
    // there -- same delivered text, no held state.
    //
    // The cost is that steps would run per piece instead of on the joined
    // value, which is why validate() refuses `via` on a row that carries the
    // folded field, and refuses `max` on a repeat that folds.
    const fold = r.fold;
    const foldBraced = dtlPath(fold.path, scope.sourcePrefix, srcGroups(st));
    noteBare(st, foldBraced);
    const here = `source.${foldBraced}`;
    const isCont = `(${n}>0)&&($EXTRACT(${here},1)=" ")`;
    const carriers = block.rows.filter(
      (row) => row.from.kind === "copy" && row.from.path === fold.path,
    );

    const headIndent = `${bodyIndent}    `;
    const head: string[] = [
      `${headIndent}<code>`,
      `${headIndent}  <![CDATA[ set ${n} = ${n} + 1 ]]>`,
      `${headIndent}</code>`,
    ];
    for (const row of block.rows) emitRow(st, row, scope, headIndent, head);

    const joined = (target: string) =>
      fold.join === ""
        ? `target.${target}_${here}`
        : `target.${target}_${os(fold.join)}_${here}`;

    body.push(
      ...dtlNotes(
        notes,
        bodyIndent,
        [
          `A continuation line does not open a new segment. It is appended`,
          `to the one already written, and ${n} is left where it is.      `,
        ],
        [`A continuation line is appended to the segment already written; ${n} does not advance.`],
      ),
      `${bodyIndent}<if condition='${attr(isCont)}' >`,
      `${bodyIndent}  <true>`,
      ...carriers.map((row) => {
        const t = dtlPath(row.target, scope.targetPrefix);
        return `${bodyIndent}    <assign value='${attr(joined(t))}' property='${attr(`target.${t}`)}' action='set' />`;
      }),
      `${bodyIndent}  </true>`,
      `${bodyIndent}  <false>`,
      ...head,
      `${bodyIndent}  </false>`,
      `${bodyIndent}</if>`,
    );
  } else {
    body.push(
      `${bodyIndent}<code>`,
      `${bodyIndent}  <![CDATA[ set ${n} = ${n} + 1 ]]>`,
      `${bodyIndent}</code>`,
    );
    emitSeed(st, block, scope, bodyIndent, body);
    for (const row of block.rows) emitRow(st, row, scope, bodyIndent, body);
  }

  if (guards.length) {
    out.push(
      `    <if condition='${attr(guards.join(" && "))}' >`,
      `      <true>`,
      ...body,
      `      </true>`,
      `    </if>`,
    );
  } else {
    out.push(...body);
  }

  out.push(`  </foreach>`);
}

// ---------------------------------------------------------------------------
// The class
// ---------------------------------------------------------------------------

/**
 * The routing rule condition this class expects in front of it.
 *
 * The gate belongs in the rule, not the transform: an event the interface does
 * not handle should never be delivered at all, rather than delivered as
 * something else. Printed in the header so it is not a step you forget.
 */
export function routingCondition(spec: Spec): string {
  const triggers = Object.keys(spec.gate.permit);
  const field = spec.gate.path.replace("-", ":");
  const events = triggers.map((t) => `HL7.{${field}}="${t}"`).join(" || ");

  const required = (spec.gate.require ?? []).map(
    (r) => `HL7.{${r.path.replace("-", ":")}}="${r.equals}"`,
  );
  if (required.length === 0) return events;
  // Parenthesised because || binds looser than && and a rule that reads
  // A && B || C lets C through on its own.
  return [...required, `(${events})`].join(" && ");
}

/** The whole class, ready to paste into Studio or save as a .cls. */
/** Every table name a `lookup()` row actually reads, in first-seen order. */
function referencedTables(spec: Spec): string[] {
  const seen: string[] = [];
  for (const block of spec.blocks) {
    for (const row of block.rows) {
      if (row.from.kind === "lookup" && !seen.includes(row.from.table)) seen.push(row.from.table);
    }
  }
  return seen;
}

export function emitIris(spec: Spec, collect?: BareRefs): string {
  assertRunnable(spec);

  const st: State = newState(spec, collect);
  const notes = irisComments(spec);
  const className = classNameFor(spec);
  const create = spec.iris.create ?? "new";
  // Tables the class CALLS, not tables the spec declares. A leftover entry in
  // spec.tables used to print here as an empty-table go-live gate, which is a
  // false alarm on the one line of the header that has to be believed.
  const tables = referencedTables(spec);
  const empties = emptyTables(spec).filter((t) => tables.includes(t));

  // The header stands at every level, `off` included. It carries the
  // fingerprint, and a generated file nobody can match back to the spec it came
  // from is a file nobody can trust -- which is a worse outcome than a few
  // lines of prose. What `off` and `brief` drop is the ESSAY around it.
  const out: string[] = notes === "full"
    ? [
        `/// ${spec.description ?? spec.name}`,
        `///`,
        `/// GENERATED by hl7-bench from a spec proven on the bench.`,
        `/// Spec fingerprint: ${fingerprint(spec)}`,
        `///   Compare it with what "bun emit.ts" prints. Same string, same mapping.`,
        `///   Different, and the namespace is running an older compile than the one`,
        `///   you are reading, which is a two-day hunt if you do not check it first.`,
        `///   It describes the SPEC. Hand-edit this file and it becomes a lie.`,
        `///`,
        `/// Before you trust it, three things it could not check for you:`,
        `///   1. sourceDocType and targetDocType against YOUR schema browser.`,
        `///      A wrong DocType fails closed: empty output, nothing in the log.`,
        `///   2. Whether any target segment sits inside a group.`,
        `///   3. Whether every Ens.Util.LookupTable named below has rows in it.`,
        `///`,
        `/// Routing rule condition this class expects:`,
        `///   ${routingCondition(spec)}`,
      ]
    : [
        `/// ${spec.description ?? spec.name}`,
        `///`,
        `/// GENERATED by hl7-bench. Spec fingerprint: ${fingerprint(spec)}`,
        `///   Not what "bun emit.ts" prints? The namespace is on an older compile.`,
        `/// DocTypes: ${spec.iris.sourceDocType} -> ${spec.iris.targetDocType}. ` +
          `Confirm both in YOUR schema browser; a wrong one fails closed.`,
        `/// Routing rule condition this class expects:`,
        `///   ${routingCondition(spec)}`,
      ];

  if (tables.length > 0) {
    out.push(`///`, `/// Lookup tables this class calls:`);
    for (const t of tables) {
      out.push(`///   ${t}${empties.includes(t) ? "   *** EMPTY IN THE SPEC, a go-live gate ***" : ""}`);
    }
  }
  if (spec.outOfScope?.length) {
    out.push(`///`, `/// Out of scope, decided rather than overlooked:`);
    for (const s of spec.outOfScope) out.push(`///   ${s}`);
  }

  const level = irisLog(spec);
  if (level !== "off") {
    out.push(
      `///`,
      ...(notes === "full"
        ? [
            `/// Run-time logging: ${level}.`,
            level === "warn"
              ? `///   $$$LOGWARNING on an unmapped lookup code and on an empty required field.`
              : `///   $$$LOGWARNING as above, plus $$$TRACE per assigned field.`,
            `///   A sender that routinely emits an unmapped code writes one Event Log`,
            `///   warning PER MESSAGE until the table is fixed. Set iris.log to "off"`,
            `///   in the spec if that is not what you want.`,
          ]
        : [
            `/// Run-time logging: ${level}. ` +
              (level === "warn"
                ? `$$$LOGWARNING on an unmapped code and on an empty required field.`
                : `$$$LOGWARNING as at "warn", plus $$$TRACE per assigned field.`),
          ]),
    );
  }

  // The macros below are Ensemble's. Without this line the class does not
  // compile, and the error names the macro rather than the missing include.
  // It goes at the TOP of the file, ahead of the header comment: a /// block
  // only documents the Class when it sits immediately above it.
  if (level !== "off") out.unshift(`Include Ensemble`, ``);

  out.push(
    // One entry, not two. The source and target classes are the same class
    // here, and DTLs generated by the portal list it once. The duplicate
    // compiled fine but read like a copy-paste slip in a file whose whole job
    // is to look like something a person would hand you.
    `Class ${className} Extends Ens.DataTransformDTL [ DependsOn = EnsLib.HL7.Message ]`,
    `{`,
    ``,
    ...pickNotes(
      notes,
      [
        `/// 1: a source path this message cannot resolve becomes a SKIPPED assign.`,
        `/// 0: it throws, and the error names the path.`,
        `///`,
        `/// Set it to 0 when a mapping is not doing what you expect. Running clean at 0`,
        `/// proves every source path resolves, and a failure at 0 hands you the exact`,
        `/// path instead of a hunt. It is the fastest diagnosis in this file.`,
        `///`,
        `/// Ship it at 0 and you have an outage. At 1, a self-pay patient with no IN1`,
        `/// is a skipped segment. At 0 the same patient is a failed message, in the`,
        `/// error queue, at 2am, for being ordinary.`,
        `///`,
        `/// What 1 costs, which is why the bench has an empty-read report: skip EVERY`,
        `/// assign in a segment and the segment is never created. No error, no warning,`,
        `/// nothing in the Visual Trace. Run "bun reads.ts" against a real message`,
        `/// before you trust a block you have not seen populated.`,
      ],
      [
        `/// 1: an unresolvable source path is a SKIPPED assign. 0: it throws and names`,
        `/// the path. Set 0 to diagnose, ship 1 -- at 0 a patient with no IN1 fails.`,
      ],
    ),
    `Parameter IGNOREMISSINGSOURCE = 1;`,
    ``,
    `XData DTL [ XMLNamespace = "http://www.intersystems.com/dtl" ]`,
    `{`,
    `<transform sourceClass='EnsLib.HL7.Message' targetClass='EnsLib.HL7.Message' ` +
      `sourceDocType='${attr(spec.iris.sourceDocType)}' targetDocType='${attr(spec.iris.targetDocType)}' ` +
      `create='${create}' language='objectscript' >`,
  );

  // Segment order is the block order, the same order the runner delivers in.
  let repeatIndex = 0;
  let contIndex = 0;
  // The counter variable a repeat left behind, per target segment id, so a
  // block with continuesNumbering can start one past it.
  const lastCounter = new Map<string, string>();

  for (const block of spec.blocks) {
    if (block.repeat) {
      const idx = repeatIndex++;
      emitRepeat(st, block, idx, out);
      lastCounter.set(block.id, `n${idx + 1}`);
      continue;
    }
    out.push("");
    if (notes !== "off" && block.note) out.push(`  <!-- ${text(block.note)} -->`);

    // A block that continues an earlier one's numbering needs the occurrence in
    // a variable of its own. `{OBX(n1+1):3}` is not a DTL reference -- the
    // occurrence has to be a plain name -- so the addition happens once, in
    // code, and the reference uses the result.
    let contVar: string | undefined;
    if (block.continuesNumbering) {
      const from = lastCounter.get(block.id);
      if (from) {
        contVar = `c${++contIndex}`;
        out.push(
          ...dtlNotes(
            notes,
            "  ",
            [`${text(block.id)}: one more, after the ${text(block.id)} loop above.`],
            [`${text(block.id)}: one more, after the ${text(block.id)} loop above.`],
          ),
          ...code("  ", `set ${contVar} = ${from} + 1`),
        );
        lastCounter.set(block.id, contVar);
      }
    }

    // A group on a block that does NOT repeat still has to be addressed. The
    // segment lives inside the group's first occurrence, so a bare {IN1:2} on
    // a schema whose IN1 sits in IN1group writes nowhere -- and writes nowhere
    // quietly, which is the whole reason the header tells you to check.
    const scope: Scope = contVar
      ? { sourcePrefix: "", targetPrefix: `${block.id}(${contVar})`, counterVar: contVar }
      : block.group
        ? { sourcePrefix: `${block.group}(1)`, targetPrefix: `${block.group}(1)` }
        : TOP;
    // A wholeSegment block whose seed finds nothing delivers NO segment.
    //
    // An `<assign>` of an absent source segment does not skip -- it writes ""
    // and creates a segment with no id, which goes down the wire as a blank
    // line. Measured in IRIS for Health, and the bench had its own version of
    // the same bug (a bare "PV2"). Both are fixed, in the same shape, so the
    // golden gate is judging agreement rather than coincidence.
    //
    // The rows go inside the guard with the seed: they exist to overwrite
    // fields on top of a copy, and there is no copy.
    //
    // Repeats do not need this. `<foreach>` over an absent segment iterates
    // zero times, so no segment is written and a guard could never fire.
    if (block.wholeSegment) {
      const presentBraced = dtlSegment(block.id, scope.sourcePrefix, srcGroups(st));
      noteBare(st, presentBraced);
      const present = `$LENGTH(source.${presentBraced})>0`;
      out.push(
        ...dtlNotes(
          notes,
          "  ",
          [
            `${text(block.id)}: a source carrying no ${text(block.id)} delivers NO ${text(block.id)}. An assign of`,
            `     an absent segment writes "" and creates one with no id, which is a`,
            `     blank line on the wire.`,
          ],
          // The guard and the seed are ONE decision, so they get one line
          // between them and `emitSeed` below is told not to add a second.
          [
            `${text(block.id)}: copied WHOLE, then overwritten below. A source carrying ` +
              `no ${text(block.id)} delivers none.`,
          ],
        ),
        `  <if condition='${attr(present)}' >`,
        `    <true>`,
      );
      emitSeed(st, block, scope, "      ", out, false);
      for (const row of block.rows) emitRow(st, row, scope, "      ", out);
      out.push(`    </true>`);
      if (irisLog(st.spec) !== "off") {
        // Losing a segment quietly is the failure the guard exists to stop
        // being quiet about.
        out.push(
          `    <false>`,
          ...code("      ", `$$$LOGWARNING(${os(`${block.id}: source carries no ${block.id}, segment not delivered`)})`),
          `    </false>`,
        );
      }
      out.push(`  </if>`);
      continue;
    }

    for (const row of block.rows) emitRow(st, row, scope, "  ", out);
  }

  out.push(``, `</transform>`, `}`, ``, `}`, ``);
  return out.join("\n");
}
