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
  type Spec, type Source, type Step, type Row, type Block,
} from "../spec";

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
export function dtlPath(path: string, prefix = ""): string {
  const m = /^([A-Z0-9]{3})-(.+)$/.exec(path.trim());
  if (!m) throw new Error(`Not an HL7 path: "${path}". Expected e.g. PID-5.1`);
  const [, seg, rest] = m;
  if (!prefix) return `{${seg}:${rest}}`;

  // Inside a loop the prefix is either a group occurrence, "INSURANCEgrp(k1)",
  // or the repeating segment itself, "IN1(k1)". In the second case the segment
  // id is already in the prefix and repeating it gives {IN1(k1).IN1:4}, which
  // resolves to nothing and does it silently.
  const p = /^([A-Z0-9]{3})\((\w+)\)$/.exec(prefix);
  if (p && p[1] === seg) return `{${seg}(${p[2]}):${rest}}`;

  return `{${prefix}.${seg}:${rest}}`;
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

/** An ObjectScript string literal. Internal quotes double, they do not escape. */
function os(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
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

interface Scope {
  /** Path prefix for source reads inside a loop, e.g. "INSURANCEgrp(k1)". */
  sourcePrefix: string;
  /** Path prefix for target writes inside a loop, e.g. "INSURANCEgrp(n1)". */
  targetPrefix: string;
  /** Ordinal counter variable, when a loop is in scope. */
  counterVar?: string;
}

const TOP: Scope = { sourcePrefix: "", targetPrefix: "" };

/** Emitter state that has to be unique across the whole class. */
interface State {
  spec: Spec;
  /** Next temp variable number, for scans that need a preamble. */
  temp: number;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/**
 * The ObjectScript for one source.
 *
 * Some sources need statements, not just an expression: scanning repetitions
 * is a loop. Those return `pre`, lines emitted immediately above the assign at
 * the same indent, and an `expr` that reads the variable they set.
 */
function sourceCode(
  st: State,
  from: Source,
  scope: Scope,
): { expr: string | null; pre?: string[] } {
  const src = (p: string) => `source.${dtlPath(p, scope.sourcePrefix)}`;

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
      const ref = src(from.path);
      const fallback =
        from.unmapped.kind === "blank" ? '""'
        : from.unmapped.kind === "passthrough" ? ref
        : os(from.unmapped.value);
      // Guard on emptiness so a field the sender left blank does not take the
      // unmapped branch and invent a value.
      const call = `..Lookup(${os(from.table)},${ref},${fallback})`;
      return { expr: `$SELECT($LENGTH(${ref})>0:${call},1:"")` };
    }

    case "counter":
      if (!scope.counterVar) throw new Error("counter() used outside a repeat");
      return { expr: scope.counterVar };

    case "event": {
      // The gate lives in the routing rule, but the target event still has to
      // be stamped. One $SELECT keeps this class correct for every trigger the
      // rule lets through, and empty for anything it should not have.
      const g = st.spec.gate;
      const ref = `source.${dtlPath(g.path)}`;
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
      // codeRef, not the braced form: every use below lands inside <code>.
      const at = (idx: string, comp?: number) =>
        codeRef(
          `source.${dtlPath(`${id}-${f}(${idx})${comp === undefined ? "" : "." + comp}`, scope.sourcePrefix)}`,
        );
      return {
        expr: v,
        pre: [
          `<code>`,
          `  <![CDATA[`,
          `  set ${v} = ""`,
          `  for ${i}=1:1:${at("*")} {`,
          `    if ${at(i, from.whereComponent)} = ${os(from.equals)} {`,
          `      set ${v} = ${takeExpr(from.take, at, i)}`,
          `      quit`,
          `    }`,
          `  }`,
          `  ]]>`,
          `</code>`,
        ],
      };
    }

    case "fromFirst": {
      // A bare NK1-2 on a message with three NK1s returns EMPTY in IRIS rather
      // than the first repeat. This is not a convenience, it is the only read
      // that works.
      const v = `p${st.temp++}`;
      const seg = from.segment;
      const rest = (p: string) => p.slice(seg.length + 1);
      const count = codeRef(`source.{${seg}(*)}`);
      const ref = (p: string) => codeRef(`source.{${seg}(i${v}):${rest(p)}}`);
      return {
        expr: v,
        pre: [
          `<code>`,
          `  <![CDATA[`,
          `  set ${v} = ""`,
          `  for i${v}=1:1:${count} {`,
          `    if $LENGTH(${ref(from.nonEmpty)}) > 0 {`,
          `      set ${v} = ${ref(from.path)}`,
          `      quit`,
          `    }`,
          `  }`,
          `  ]]>`,
          `</code>`,
        ],
      };
    }

    case "todo":
      return { expr: null };
  }
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/** Wrap an expression in one step. Same semantics the runner applies. */
function stepCode(expr: string, step: Step): string {
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
  }
}

// ---------------------------------------------------------------------------
// Rows and blocks
// ---------------------------------------------------------------------------

/**
 * What the generated class logs at run time. Nothing to do with the bench's
 * own HL7_BENCH_LOG, which writes files on your machine. This one runs inside
 * IRIS and writes to the Event Log.
 */
function irisLog(spec: Spec): "off" | "warn" | "trace" {
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

function emitRow(st: State, row: Row, scope: Scope, indent: string, out: string[]): void {
  if (row.note) out.push(`${indent}<!-- ${text(row.note)} -->`);

  if (row.from.kind === "todo") {
    out.push(
      `${indent}<!-- TODO ${text(row.target)}: ${text(row.from.why)} -->`,
      `${indent}<!--      Write this assign by hand. The generator will not guess it. -->`,
    );
    return;
  }

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
  if (level !== "off" && row.from.kind === "lookup") {
    const ref = codeRef(`source.${dtlPath(row.from.path, scope.sourcePrefix)}`);
    const t = os(row.from.table);
    // Built with os() on both halves rather than typed as one literal: a
    // table name or a label is free text out of the spec, and one quote in it
    // would otherwise close the ObjectScript string early and fail to compile.
    const where =
      row.from.path === row.target ? row.target : `${row.from.path} to ${row.target}`;
    const msg =
      `${os(`${row.from.table} has no row for "`)}_${ref}_${os(`" (${where})`)}`;
    out.push(
      ...code(
        indent,
        `if $LENGTH(${ref}),..Lookup(${t},${ref},${MISS})=${MISS} { $$$LOGWARNING(${msg}) }`,
      ),
    );
  }

  out.push(`${indent}<assign value='${attr(value)}' property='${attr(prop)}' action='set' />`);

  // The other silent failure: a required target that came out empty. Checked
  // on the TARGET after the assign rather than on the source before it, so it
  // catches a source that was populated and a step that emptied it.
  if (level !== "off" && row.required) {
    const msg = os(`${row.target} (${label}) is required and came out empty`);
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

  // Without a group the segment repeats directly and the occurrence number
  // goes on the segment itself. With a group, it goes on the group.
  const srcRef = grp ? `source.{${grp}()}` : `source.{${r.over}()}`;
  const scope: Scope = {
    sourcePrefix: grp ? `${grp}(${k})` : `${r.over}(${k})`,
    targetPrefix: grp ? `${grp}(${n})` : `${block.id}(${n})`,
    counterVar: n,
  };

  out.push("");
  if (block.note) out.push(`  <!-- ${text(block.note)} -->`);
  out.push(
    `  <!-- ${text(block.id)}: numbered by OUTPUT ordinal (${n}), not by source repeat (${k}). -->`,
    `  <!--      A skipped repetition must not leave a hole in the set ids. -->`,
    `  <code>`,
    `    <![CDATA[ set ${n} = 0 ]]>`,
    `  </code>`,
    `  <foreach property='${attr(srcRef)}' key='${k}' >`,
  );

  const guards: string[] = [];
  if (r.skipWhenEmpty) {
    guards.push(`$LENGTH(source.${dtlPath(r.skipWhenEmpty, scope.sourcePrefix)})>0`);
  }
  if (r.max !== undefined) guards.push(`${n}<${r.max}`);

  const body: string[] = [];
  const bodyIndent = guards.length ? "        " : "    ";
  body.push(
    `${bodyIndent}<code>`,
    `${bodyIndent}  <![CDATA[ set ${n} = ${n} + 1 ]]>`,
    `${bodyIndent}</code>`,
  );
  for (const row of block.rows) emitRow(st, row, scope, bodyIndent, body);

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

export function emitIris(spec: Spec): string {
  assertRunnable(spec);

  const st: State = { spec, temp: 1 };
  const className = classNameFor(spec);
  const create = spec.iris.create ?? "new";
  // Tables the class CALLS, not tables the spec declares. A leftover entry in
  // spec.tables used to print here as an empty-table go-live gate, which is a
  // false alarm on the one line of the header that has to be believed.
  const tables = referencedTables(spec);
  const empties = emptyTables(spec).filter((t) => tables.includes(t));

  const out: string[] = [
    `/// ${spec.description ?? spec.name}`,
    `///`,
    `/// GENERATED by hl7-bench from a spec proven on the bench.`,
    `/// Before you trust it, three things it could not check for you:`,
    `///   1. sourceDocType and targetDocType against YOUR schema browser.`,
    `///      A wrong DocType fails closed: empty output, nothing in the log.`,
    `///   2. Whether any target segment sits inside a group.`,
    `///   3. Whether every Ens.Util.LookupTable named below has rows in it.`,
    `///`,
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
      `/// Run-time logging: ${level}.`,
      level === "warn"
        ? `///   $$$LOGWARNING on an unmapped lookup code and on an empty required field.`
        : `///   $$$LOGWARNING as above, plus $$$TRACE per assigned field.`,
      `///   A sender that routinely emits an unmapped code writes one Event Log`,
      `///   warning PER MESSAGE until the table is fixed. Set iris.log to "off"`,
      `///   in the spec if that is not what you want.`,
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
  for (const block of spec.blocks) {
    if (block.repeat) {
      emitRepeat(st, block, repeatIndex++, out);
      continue;
    }
    out.push("");
    if (block.note) out.push(`  <!-- ${text(block.note)} -->`);

    // A group on a block that does NOT repeat still has to be addressed. The
    // segment lives inside the group's first occurrence, so a bare {IN1:2} on
    // a schema whose IN1 sits in IN1group writes nowhere -- and writes nowhere
    // quietly, which is the whole reason the header tells you to check.
    const scope: Scope = block.group
      ? { sourcePrefix: `${block.group}(1)`, targetPrefix: `${block.group}(1)` }
      : TOP;
    for (const row of block.rows) emitRow(st, row, scope, "  ", out);
  }

  out.push(``, `</transform>`, `}`, ``, `}`, ``);
  return out.join("\n");
}
