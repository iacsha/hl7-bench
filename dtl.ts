#!/usr/bin/env bun
/**
 * dtl.ts -- turn a settled mapping into an IRIS DTL class.
 *
 *   bun dtl.ts                    print the worked example
 *   bun dtl.ts > Foo.cls          save it
 *
 * You do not run this against a message. You describe the mapping as data,
 * exactly once, and this writes the ObjectScript. The bench proves the mapping
 * is right; this saves you typing it a second time in a second language.
 *
 * WHAT IT DOES AND DOES NOT DO
 *
 * It emits the boring rows, which are most of them: literals, straight copies,
 * lookups with a stated unmapped branch, a counter for output ordinals, and a
 * foreach over a repeating segment with an emptiness guard.
 *
 * It does NOT emit branching logic, string surgery, date arithmetic, or
 * anything else genuinely procedural. Those rows you declare as `manual()` and
 * they come out as a TODO comment in the right place in the file. That is
 * deliberate: a generator that quietly drops what it cannot express is worse
 * than no generator, because the gap is invisible until validation.
 *
 * THE THREE THINGS IT CANNOT KNOW
 *
 *  1. Whether your DocTypes are right. It writes what you hand it. A wrong
 *     DocType fails CLOSED in IRIS: paths stop resolving, the message comes out
 *     empty, and nothing useful reaches the log. Open the schema browser in
 *     your namespace and read the real structure names before you compile.
 *  2. Whether a segment sits inside a group. IN1 inside INSURANCE means
 *     `target.{IN1(1):2}` resolves to nothing where
 *     `target.{INSURANCEgrp(1).IN1:2}` works, with the same silence. Set
 *     `group` on the loop when it does.
 *  3. Whether your lookup tables have rows. An empty Ens.Util.LookupTable
 *     returns the default for every message, which looks exactly like a working
 *     lookup right up until someone reads a report.
 *
 * So: compile it, then run the golden gate against the DTL's own Test output.
 * `WORKFLOW.md` step 8.
 */

// ---------------------------------------------------------------------------
// The spec you write
// ---------------------------------------------------------------------------

/** Where a target field's value comes from. */
export type Source =
  /** Copy a source path straight across. */
  | { kind: "copy"; path: string }
  /** Stamp a constant. */
  | { kind: "literal"; value: string }
  /** First non-empty of several source paths. Becomes nested $SELECT. */
  | { kind: "firstOf"; paths: string[] }
  /** Ens.Util.LookupTable. `unmapped` is the value when the code is not in it. */
  | { kind: "lookup"; table: string; path: string; unmapped: Unmapped }
  /** The loop's output ordinal. Only valid inside a loop. */
  | { kind: "counter" }
  /** Raw ObjectScript, verbatim. Your escape hatch. */
  | { kind: "raw"; expression: string }
  /** Cannot be generated. Comes out as a TODO comment. */
  | { kind: "manual"; why: string };

/**
 * What a lookup does with a code that is not in the table. There is no default
 * for this on purpose: picking one by accident is the single most expensive
 * habit in interface work.
 */
export type Unmapped =
  | { kind: "blank" }
  | { kind: "passthrough" }
  | { kind: "constant"; value: string };

export interface Row {
  /** Target path in bench syntax: "PID-5.1", "MSH-9.2", "PID-13(1).3". */
  target: string;
  from: Source;
  /** Free note. Becomes an XML comment above the assign. */
  note?: string;
}

export interface Loop {
  /** Source segment that repeats, e.g. "IN1". */
  segment: string;
  /** Group the segment sits inside, if any. e.g. "INSURANCEgrp". */
  group?: string;
  /**
   * Skip a repetition when this source path is empty. Paths inside a loop are
   * written relative to the segment: "IN1-4", not the full group path.
   */
  skipWhenEmpty?: string;
  /** Stop after this many delivered repetitions. Omit for no cap. */
  max?: number;
  rows: Row[];
  note?: string;
}

export interface DtlSpec {
  className: string;
  description?: string;
  /** Real schema names from YOUR namespace. e.g. "2.3:ADT_A01". */
  sourceDocType: string;
  targetDocType: string;
  /**
   * "new" builds a fresh target, which is what you want when the bench
   * transform builds one. "copy" carries the source across first, and then
   * fields you never assigned ride along.
   */
  create?: "new" | "copy" | "existing";
  rows: Row[];
  loops?: Loop[];
}

// Convenience constructors, so a spec reads like a mapping table.
export const copy = (path: string): Source => ({ kind: "copy", path });
export const literal = (value: string): Source => ({ kind: "literal", value });
export const firstOf = (...paths: string[]): Source => ({ kind: "firstOf", paths });
export const counter = (): Source => ({ kind: "counter" });
export const raw = (expression: string): Source => ({ kind: "raw", expression });
export const manual = (why: string): Source => ({ kind: "manual", why });
export const lookup = (table: string, path: string, unmapped: Unmapped): Source =>
  ({ kind: "lookup", table, path, unmapped });

export const blank = (): Unmapped => ({ kind: "blank" });
export const passthrough = (): Unmapped => ({ kind: "passthrough" });
export const constant = (value: string): Unmapped => ({ kind: "constant", value });

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

/** An ObjectScript string literal. Internal quotes double. */
function os(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// Emitting
// ---------------------------------------------------------------------------

interface Scope {
  /** Path prefix for source reads inside a loop, e.g. "INSURANCEgrp(k)". */
  sourcePrefix: string;
  /** Path prefix for target writes inside a loop, e.g. "INSURANCEgrp(out)". */
  targetPrefix: string;
  /** Name of the ordinal counter variable, when one is in scope. */
  counterVar?: string;
}

const TOP: Scope = { sourcePrefix: "", targetPrefix: "" };

/** The ObjectScript expression that produces this row's value. */
function expression(from: Source, scope: Scope): string | null {
  switch (from.kind) {
    case "copy":
      return `source.${dtlPath(from.path, scope.sourcePrefix)}`;

    case "literal":
      return os(from.value);

    case "firstOf": {
      // $SELECT stops at the first true condition, so nesting is not needed.
      // A final 1: arm keeps it from erroring when every path is empty.
      const arms = from.paths.map((p) => {
        const ref = `source.${dtlPath(p, scope.sourcePrefix)}`;
        return `$LENGTH(${ref})>0:${ref}`;
      });
      return `$SELECT(${arms.join(",")},1:"")`;
    }

    case "lookup": {
      const ref = `source.${dtlPath(from.path, scope.sourcePrefix)}`;
      const fallback =
        from.unmapped.kind === "blank" ? '""'
        : from.unmapped.kind === "passthrough" ? ref
        : os(from.unmapped.value);
      return `..Lookup(${os(from.table)},${ref},${fallback})`;
    }

    case "counter":
      if (!scope.counterVar) throw new Error("counter() used outside a loop");
      return scope.counterVar;

    case "raw":
      return from.expression;

    case "manual":
      return null;
  }
}

function emitRow(row: Row, scope: Scope, indent: string, out: string[]): void {
  if (row.note) out.push(`${indent}<!-- ${text(row.note)} -->`);

  if (row.from.kind === "manual") {
    out.push(
      `${indent}<!-- TODO ${text(row.target)}: ${text(row.from.why)} -->`,
      `${indent}<!--      Write this assign by hand. dtl.ts will not generate it. -->`,
    );
    return;
  }

  const value = expression(row.from, scope);
  const prop = `target.${dtlPath(row.target, scope.targetPrefix)}`;
  out.push(`${indent}<assign value='${attr(value!)}' property='${attr(prop)}' action='set' />`);
}

function emitLoop(loop: Loop, index: number, out: string[]): void {
  const k = `k${index + 1}`;
  const n = `n${index + 1}`;
  const grp = loop.group;
  const sourcePrefix = grp ? `${grp}(${k})` : "";
  const targetPrefix = grp ? `${grp}(${n})` : "";

  // Without a group, the segment repeats directly and the occurrence number
  // goes on the segment itself. With a group, it goes on the group.
  const srcRef = grp ? `source.{${grp}()}` : `source.{${loop.segment}()}`;
  const scope: Scope = {
    sourcePrefix: sourcePrefix || `${loop.segment}(${k})`,
    targetPrefix: targetPrefix || `${loop.segment}(${n})`,
    counterVar: n,
  };

  out.push("");
  if (loop.note) out.push(`  <!-- ${text(loop.note)} -->`);
  out.push(
    `  <!-- ${text(loop.segment)}: numbered by OUTPUT ordinal (${n}), not by source repeat (${k}). -->`,
    `  <!--      A skipped repetition must not leave a hole in the set ids. -->`,
    `  <code>`,
    `    <![CDATA[ set ${n} = 0 ]]>`,
    `  </code>`,
    `  <foreach property='${attr(srcRef)}' key='${k}' >`,
  );

  const guards: string[] = [];
  if (loop.skipWhenEmpty) {
    const ref = `source.${dtlPathLocal(loop.skipWhenEmpty, loop, k)}`;
    guards.push(`$LENGTH(${ref})>0`);
  }
  if (loop.max !== undefined) guards.push(`${n}<${loop.max}`);

  const body: string[] = [];
  const bodyIndent = guards.length ? "        " : "    ";

  body.push(`${bodyIndent}<code>`);
  body.push(`${bodyIndent}  <![CDATA[ set ${n} = ${n} + 1 ]]>`);
  body.push(`${bodyIndent}</code>`);
  for (const row of loop.rows) emitRow(row, scope, bodyIndent, body);

  if (guards.length) {
    out.push(`    <if condition='${attr(guards.join(" && "))}' >`);
    out.push(`      <true>`);
    out.push(...body);
    out.push(`      </true>`);
    out.push(`    </if>`);
  } else {
    out.push(...body);
  }

  out.push(`  </foreach>`);
}

/** Loop-local path with the loop's own source prefix, for the guard condition. */
function dtlPathLocal(path: string, loop: Loop, key: string): string {
  return dtlPath(path, loop.group ? `${loop.group}(${key})` : `${loop.segment}(${key})`);
}

/** The whole class, ready to paste into Studio or save as a .cls. */
export function emitDtl(spec: DtlSpec): string {
  const out: string[] = [];
  const create = spec.create ?? "new";

  out.push(
    `/// ${spec.description ?? spec.className}`,
    `///`,
    `/// GENERATED by hl7-bench dtl.ts from a mapping proven on the bench.`,
    `/// Before you trust it, three things it could not check for you:`,
    `///   1. sourceDocType and targetDocType against YOUR schema browser.`,
    `///      A wrong DocType fails closed: empty output, nothing in the log.`,
    `///   2. Whether any target segment sits inside a group.`,
    `///   3. Whether every Ens.Util.LookupTable named below has rows in it.`,
    `Class ${spec.className} Extends Ens.DataTransformDTL [ DependsOn = (EnsLib.HL7.Message, EnsLib.HL7.Message) ]`,
    `{`,
    ``,
    `Parameter IGNOREMISSINGSOURCE = 1;`,
    ``,
    `XData DTL [ XMLNamespace = "http://www.intersystems.com/dtl" ]`,
    `{`,
    `<transform sourceClass='EnsLib.HL7.Message' targetClass='EnsLib.HL7.Message' ` +
      `sourceDocType='${attr(spec.sourceDocType)}' targetDocType='${attr(spec.targetDocType)}' ` +
      `create='${create}' language='objectscript' >`,
  );

  for (const row of spec.rows) emitRow(row, TOP, "  ", out);
  (spec.loops ?? []).forEach((loop, i) => emitLoop(loop, i, out));

  out.push(`</transform>`, `}`, ``, `}`, ``);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Worked example. Run the file to see it.
// ---------------------------------------------------------------------------

export const EXAMPLE: DtlSpec = {
  className: "Demo.AdtToDownstream",
  description: "ADT A01 to A28. Worked example for dtl.ts.",
  sourceDocType: "2.3:ADT_A01",
  targetDocType: "2.3.1:ADT_A05",
  create: "new",
  rows: [
    { target: "MSH-3", from: literal("SOURCEAPP") },
    { target: "MSH-5", from: literal("DOWNSTREAM"), note: "Placeholder. Get the real value from the receiver." },
    { target: "MSH-7", from: copy("MSH-7") },
    { target: "MSH-9.1", from: literal("ADT") },
    { target: "MSH-9.2", from: literal("A28"), note: "Do NOT set MSH-9.3. Two components in, two out." },
    { target: "MSH-10", from: copy("MSH-10") },
    { target: "MSH-11", from: copy("MSH-11"), note: "D in dev. Must be P before cutover." },
    { target: "MSH-12", from: literal("2.3.1") },

    { target: "EVN-1", from: literal("A28") },
    { target: "EVN-2", from: copy("EVN-2") },

    {
      target: "PID-3",
      from: firstOf("PID-4", "PID-3"),
      note: "PID-4 is populated at one site and empty at two others. Confirm per site.",
    },
    { target: "PID-5.1", from: copy("PID-5.1") },
    { target: "PID-5.2", from: copy("PID-5.2") },
    { target: "PID-7", from: copy("PID-7") },
    { target: "PID-8", from: lookup("DemoSex", "PID-8", passthrough()) },
    { target: "PID-11.6", from: literal("UNITED STATES") },
    { target: "PID-13(1).2", from: literal("PRN") },
    {
      target: "PID-19",
      from: manual("SSN arrives punctuated. Strip with $TRANSLATE(source.{PID:19},\"-\",\"\")."),
    },

    {
      target: "PV1-3.1",
      from: lookup("DemoDepartment", "PV1-3.1", blank()),
      note: "GO-LIVE GATE. Empty table means every visit lands with no department.",
    },
    {
      target: "PV1-7.1",
      from: manual("Scan the PV1-7 repetitions for the one whose component 13 is NPI. Position is not stable."),
    },
    { target: "PV1-44", from: copy("PV1-44") },
  ],
  loops: [
    {
      segment: "IN1",
      group: "INSURANCEgrp",
      skipWhenEmpty: "IN1-4",
      max: 3,
      note: "An IN1 with no company name is a shell. Skipping it must not leave a hole in the set ids.",
      rows: [
        { target: "IN1-1", from: counter() },
        { target: "IN1-22", from: counter(), note: "Coverage priority, from the output ordinal." },
        { target: "IN1-2", from: copy("IN1-2"), note: "Part 1 of the package match key." },
        { target: "IN1-4", from: copy("IN1-4"), note: "Part 2." },
        { target: "IN1-5", from: copy("IN1-5"), note: "Part 3. A partial key is a DIFFERENT key." },
        { target: "IN1-16", from: copy("IN1-16") },
        {
          target: "IN1-17",
          from: lookup("DemoInsRelation", "IN1-17", passthrough()),
          note: "Passthrough is temporary. Self versus Spouse changes whether a claim pays.",
        },
        { target: "IN1-36", from: copy("IN1-36") },
      ],
    },
  ],
};

if (import.meta.main) {
  const spec = EXAMPLE;
  process.stdout.write(emitDtl(spec));
  process.stderr.write(
    "\nThat is the worked example. Copy this file's EXAMPLE into dtl.<interface>.ts,\n" +
      "rewrite the rows from your mapping trace, and import emitDtl from here.\n" +
      "dtl.*.ts is gitignored, same as mapping.*.ts, because the mapping belongs\n" +
      "to the employer and the tool does not.\n",
  );
}
