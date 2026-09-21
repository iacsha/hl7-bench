#!/usr/bin/env bun
/**
 * import-cls.ts -- a hand-written business process, read into a spec, ONCE.
 *
 *     bun import-cls.ts AdtToReceiver.cls -o transform.site.local.ts
 *
 * WHY THIS EXISTS, HAVING BEEN REFUSED TWICE
 *
 * The rule was: nothing reads a `.cls` back into a spec, because that makes the
 * class and the spec two sources of truth for one set of decisions and nothing
 * checks that they agree.
 *
 * That rule is about a LOOP -- edit the class, re-import, edit the spec,
 * re-emit -- and it still holds. This is not that. This runs once, on a class
 * that already exists, to get you to a spec you then own. After the import the
 * spec is the source and `bun emit.ts process -o My.cls` writes the class.
 * Importing twice is the thing to be suspicious of, and the output says so.
 *
 * WHAT IT REFUSES TO DO
 *
 * Guess. A line it does not recognise is reported with its number and its text,
 * and the summary counts them. An importer that silently drops what it cannot
 * read produces a spec that LOOKS complete, emits a class that compiles, and
 * delivers a message missing three fields nobody can account for -- which is
 * strictly worse than not importing at all.
 *
 * So: read the report before you trust the spec. If it says four lines were not
 * understood, four decisions are missing from that file.
 *
 * WHAT IT DOES RECOGNISE
 *
 * The disciplined segment-copy shape this bench is aimed at:
 *
 *   do tTarget.PokeDocType("2.3:ADT_A01")          the target DocType
 *   set event = pRequest.GetValueAt("MSH:9.2")     the gate path
 *   if ((event '= "A01") && ...)                   the permitted triggers
 *   set tEvent = $SELECT(event="A01":"A28",...)    what each becomes
 *   ...SetValueAt(tSource.GetValueAt("PID"),"PID") a whole-segment copy
 *   ...SetValueAt("SENDING_APP","MSH:3")              a literal
 *   ...SetValueAt("","PID:19")                     a suppressed field
 *   ...SetValueAt(tSource.GetValueAt("A"),"B")     a field copy
 *   ...SetValueAt(tEvent,"EVN:1")                  the target event
 *   for k=1:1:tNK1Count { ... }                    a repeat
 *   if $LENGTH(tSource.GetValueAt("NK1(k):2"))     skipWhenEmpty
 *   ..SendRequestAsync("ToReceiver.ADT.TCP",...)     iris.process.sendTo
 */

import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";

import { decodeText } from "./input";
import { importLine, specToSource } from "./serialize";
import { validate, type Block, type Row, type Spec } from "./spec";

/**
 * The whole spec file, not just the literal.
 *
 * `specToSource` writes the `export const spec = {...}` and nothing else,
 * because its usual caller splices that into a file that already has the
 * imports around it. An import has no such file to splice into: it is creating
 * one. Writing only the literal produced a spec that failed to load with
 * "literal is not defined", which reads as a bug in the spec rather than as a
 * missing import line.
 */
export function specModule(spec: Spec, from: string, unread: number): string {
  return [
    `/**`,
    ` * Imported from ${from} by \`bun import-cls.ts\`.`,
    ` *`,
    unread === 0
      ? ` * Every line of that class was understood. Even so, read this file against`
      : ` * ${unread} line(s) of that class were NOT understood and are missing here. Read`,
    unread === 0
      ? ` * the original once before trusting it -- an importer agrees with itself.`
      : ` * the import report, then the original, before trusting this file.`,
    ` *`,
    ` * THE SPEC IS THE SOURCE OF TRUTH FROM HERE. Edit this file, then`,
    ` * \`bun emit.ts process -o ${from}\` writes the class back. Importing a second`,
    ` * time, after editing either side, is how the two quietly stop agreeing.`,
    ` */`,
    ``,
    `import type { Message } from "./hl7";`,
    `import { runSpec } from "./run";`,
    importLine(spec),
    ``,
    specToSource(spec),
    ``,
    `export function transform(msg: Message): void {`,
    `  const result = runSpec(spec, msg);`,
    `  if (process.env.HL7_BENCH_NOTES === "off") return;`,
    `  for (const note of result.notes) process.stderr.write(\`  \${note}\\n\`);`,
    `}`,
    ``,
  ].join("\n");
}

export type ImportReport = {
  spec: Spec;
  /** Lines that carry a decision this importer could not read. */
  unread: { line: number; text: string }[];
  /** What it did understand, for the summary. */
  notes: string[];
};

/** "MSH:9.2" -> "MSH-9.2". The only difference is where the colon goes. */
const toBenchPath = (iris: string) => iris.replace(":", "-");

/**
 * An ObjectScript reference, concatenation and all, as a plain path.
 *
 *   "NK1("_n1_")"          ->  NK1()
 *   "GT1("_g1_"):12"       ->  GT1():12
 *   "IN1grp("_i1_").IN1"   ->  IN1grp().IN1
 *
 * The loop variable is the one thing in these that carries no decision -- it is
 * bookkeeping for an occurrence the spec numbers by output ordinal anyway. A
 * regex that took the first quoted run instead would read `"NK1("` as the whole
 * target and invent a block called `NK1(`.
 */
function normalizeRef(expr: string): string {
  return expr
    .trim()
    .replace(/"\s*_\s*[\w$()]+\s*_\s*"/g, "")  // "("_k1_")" joins away
    .replace(/^"|"$/g, "")
    .trim();
}

/**
 * The arguments of a call, split at the top-level comma.
 *
 * A regex cannot do this. `SetValueAt(tSource.GetValueAt("NK1("_k1_")"),"NK1("_n1_")")`
 * has commas nowhere and parentheses everywhere, and the line usually ends
 * `$$$ThrowOnError(tsc)` -- so a greedy pattern runs to the last bracket on the
 * line and a lazy one stops inside the first quoted run. Balancing brackets
 * while respecting quotes is the only reading that is right for both.
 */
function callArgs(line: string, name: string): string[] | undefined {
  const i = line.indexOf(name + "(");
  if (i === -1) return undefined;

  let depth = 0;
  let inStr = false;
  const args: string[] = [];
  let cur = "";

  for (let k = i + name.length; k < line.length; k++) {
    const c = line[k]!;
    if (inStr) {
      cur += c;
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; cur += c; continue; }
    if (c === "(") {
      depth++;
      if (depth === 1) continue;       // the call's own bracket
    } else if (c === ")") {
      depth--;
      if (depth === 0) { args.push(cur); return args; }
    }
    if (c === "," && depth === 1) { args.push(cur); cur = ""; continue; }
    cur += c;
  }
  return undefined;
}

/** Strip an occurrence subscript: "NK1(k1)" -> "NK1", "IN1grp(k3).IN1" -> "IN1". */
function segmentIdOf(ref: string): string {
  // The field comes off first. "MSH:3" is the MSH segment, and a version that
  // forgot the colon produced an id of "MSH:3", which matches no segment and
  // sent every literal row to the not-understood list.
  const noField = ref.split(":")[0]!;
  const last = noField.split(".").pop() ?? noField;
  return last.replace(/\(.*\)$/, "");
}

/** The group a grouped reference names: "IN1grp(k3).IN1" -> "IN1grp". */
function groupOf(ref: string): string | undefined {
  const parts = ref.split(":")[0]!.split(".");
  if (parts.length < 2) return undefined;
  return parts[0]!.replace(/\(.*\)$/, "");
}

/**
 * Read a class into a spec.
 *
 * Deliberately line-oriented and deliberately literal. A real ObjectScript
 * parser would recognise more and would also be confident about code it had
 * mis-read; this recognises exactly the forms listed in the header and hands
 * back everything else for a person to look at.
 */
export function importClass(source: string): ImportReport {
  const lines = source.split(/\r?\n/);
  const unread: { line: number; text: string }[] = [];
  const notes: string[] = [];

  let className: string | undefined;
  let processName: string | undefined;
  let sendTo: string | undefined;
  let docType: string | undefined;
  let gatePath = "MSH-9.2";
  const permit: Record<string, string> = {};
  const description: string[] = [];

  const blocks: Block[] = [];
  const blockFor = (id: string, group?: string): Block => {
    let b = blocks.find((x) => x.id === id);
    if (!b) {
      b = { id, rows: [] };
      if (group) b.group = group;
      blocks.push(b);
    }
    if (group && !b.group) b.group = group;
    return b;
  };

  /** Which segment the `for` loop currently being read delivers. */
  let loopSegment: string | undefined;
  let loopDepth = 0;

  const triggers: string[] = [];
  /** Variables holding a whole segment, e.g. `s tGT1 = tSource.GetValueAt("GT1(k)")`. */
  const wholeVars = new Map<string, string>();

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    const at = i + 1;

    // ---- things that are not decisions ----------------------------------
    if (line === "" || line === "{" || line === "}") continue;
    if (/^\/\/\/?/.test(line)) {
      const t = line.replace(/^\/\/\/?\s?/, "").trim();
      if (t) description.push(t);
      continue;
    }
    if (/^#dim\b|^Storage Default|^<Type>|^Include\b|^Method\b|^ClassMethod\b/.test(line)) continue;
    // Bare block keywords only. A one-line `try { s tGT1 = ... } catch { ... }`
    // is how an optional segment is read defensively, and skipping it on the
    // strength of its first word threw away the read it wraps.
    if (/^(try\s*\{?|\}?\s*catch\s*\w*\s*\{?|\}\s*catch.*|quit\b.*|q\b.*|return\b.*)$/.test(line)
        && !/GetValueAt|SetValueAt/.test(line)) continue;
    if (/^set tsc = \$\$\$OK|^s tsc = \$\$\$OK/i.test(line)) continue;
    if (/^s(et)? tSource = pRequest\.%ConstructClone\(\)/.test(line)) continue;
    if (/^s(et)? tTarget = ##class\(EnsLib\.HL7\.Message\)\.%New\(\)/.test(line)) continue;
    if (/^\$\$\$TRACE/.test(line)) continue;
    // Loop bookkeeping. An output ordinal is counted by the spec itself, and a
    // guard that only asks whether a segment is there is a presence test, not a
    // mapping decision. Reporting these as "not understood" would bury the
    // lines that ARE decisions under noise, which is the failure this report
    // exists to avoid.
    if (/^s(?:et)?\s+\w+\s*=\s*0\s*$/.test(line)) continue;
    if (/^s(?:et)?\s+(\w+)\s*=\s*\1\s*\+\s*1\s*$/.test(line)) continue;
    if (/^s(?:et)?\s+\w+\s*=\s*""\s*$/.test(line)) continue;
    if (/^s(?:et)?\s+tsc\s*=\s*e\.AsStatus\(\)/.test(line)) continue;
    if (/^if\s+\$LENGTH\(\$G\(\w+\)\)/.test(line)) continue;
    if (/^if\s+\$LENGTH\(tSource\.GetValueAt\("[^"]*"\)\)\s*\{?\s*$/.test(line)) continue;

    // ---- the class itself ------------------------------------------------
    const cls = /^Class\s+([\w.%]+)\s+Extends/.exec(line);
    if (cls) {
      processName = cls[1];
      notes.push(`process class ${processName}`);
      continue;
    }

    const poke = /PokeDocType\("([^"]+)"\)/.exec(line);
    if (poke) {
      docType = poke[1];
      notes.push(`DocType ${docType}`);
      continue;
    }

    const dispatch = /SendRequest(?:Async|Sync)\("([^"]+)"/.exec(line);
    if (dispatch) {
      sendTo = dispatch[1];
      notes.push(`sends to ${sendTo}`);
      continue;
    }

    // ---- the gate --------------------------------------------------------
    const gateRead = /^s(?:et)?\s+\w+\s*=\s*pRequest\.GetValueAt\("([^"]+)"\)/.exec(line);
    if (gateRead) {
      gatePath = toBenchPath(gateRead[1]!);
      notes.push(`gate reads ${gatePath}`);
      continue;
    }

    if (/'=\s*"/.test(line) && /\bif\b/.test(line)) {
      for (const m of line.matchAll(/'=\s*"([^"]+)"/g)) triggers.push(m[1]!);
      notes.push(`filters on ${triggers.join(", ")}`);
      continue;
    }

    const select = /\$SELECT\((.+)\)\s*$/i.exec(line);
    if (select && /=\s*"/.test(select[1]!)) {
      for (const m of select[1]!.matchAll(/\w+\s*=\s*"([^"]+)"\s*:\s*"([^"]*)"/g)) {
        permit[m[1]!] = m[2]!;
      }
      notes.push(`event table ${Object.entries(permit).map(([k, v]) => `${k}->${v}`).join(", ")}`);
      continue;
    }

    // ---- repeats ---------------------------------------------------------
    const count = /GetValueAt\("(\w+)(?:grp)?\(\*\)"\)/.exec(line);
    if (count) {
      loopSegment = count[1];
      continue;
    }
    if (/^for\s+\w+\s*=/.test(line)) {
      loopDepth++;
      continue;
    }
    const skip = /if\s+\$LENGTH\(tSource\.GetValueAt\("(\w+)\([^)]*\):(\d+(?:\.\d+)?)"\)\)/.exec(line);
    if (skip) {
      const b = blockFor(skip[1]!);
      b.repeat = { over: skip[1]!, skipWhenEmpty: `${skip[1]}-${skip[2]}` };
      notes.push(`${skip[1]} repeats, skipping when ${skip[1]}-${skip[2]} is empty`);
      continue;
    }

    // ---- a variable that holds a whole segment ---------------------------
    //
    //   try { s tGT1 = tSource.GetValueAt("GT1("_k2_")") } catch { ... }
    //
    // The try/catch is there because GetValueAt throws on an optional segment
    // that is not in the message. The DECISION is "copy this GT1 whole"; the
    // guard around it is defensive plumbing the spec expresses as a repeat.
    const holds = /s(?:et)?\s+(\w+)\s*=\s*tSource\.GetValueAt\(/.exec(line);
    if (holds && !/SetValueAt/.test(line)) {
      const a = callArgs(line, "GetValueAt");
      const ref = normalizeRef(a?.[0] ?? "");
      if (!ref.includes(":")) {
        wholeVars.set(holds[1]!, segmentIdOf(ref));
        continue;
      }
    }

    // ---- the assignments -------------------------------------------------
    const args = /SetValueAt\(/.test(line) ? callArgs(line, "SetValueAt") : undefined;
    if (args && args.length >= 2) {
      const value = args[0]!.trim();
      const target = normalizeRef(args[1]!);
      const id = segmentIdOf(target);
      const group = groupOf(target);
      const field = target.includes(":") ? target.split(":").pop()! : undefined;

      if (!/^[A-Z][A-Z0-9]{2}$/.test(id)) {
        unread.push({ line: at, text: line });
        continue;
      }

      const b = blockFor(id, group);
      // A subscript on the target means this assign sits in a loop, so the
      // block repeats even when no skip guard named it.
      if (/\(\)/.test(target) && !b.repeat) b.repeat = { over: id };

      const copyRef = /^tSource\.GetValueAt\((.+)\)$/.exec(value);
      const heldVar = /^\$G\((\w+)\)$|^(\w+)$/.exec(value);
      const held = heldVar ? wholeVars.get(heldVar[1] ?? heldVar[2] ?? "") : undefined;

      // Whole-segment copy: no field on the target, and the value is either a
      // bare GetValueAt of the same segment or a variable holding one.
      if (!field) {
        const from = copyRef ? segmentIdOf(normalizeRef(copyRef[1]!)) : held;
        if (from === id) {
          b.wholeSegment = true;
          notes.push(`${id} copied whole`);
          continue;
        }
        unread.push({ line: at, text: line });
        continue;
      }

      const row: Row = { target: `${id}-${field}`, from: { kind: "literal", value: "" } };
      const lit = /^"((?:[^"]|"")*)"$/.exec(value);

      if (lit) {
        row.from = { kind: "literal", value: lit[1]!.split('""').join('"') };
      } else if (/^tEvent$/.test(value)) {
        row.from = { kind: "event" };
      } else if (copyRef) {
        row.from = { kind: "copy", path: toBenchPath(normalizeRef(copyRef[1]!).replace(/\(\)/g, "")) };
      } else {
        // An expression the vocabulary cannot say. Recorded as a TODO so it
        // shows in the trace and in the emitted class as a line to write by
        // hand, rather than vanishing.
        row.from = { kind: "todo", why: `imported from: ${value}` };
        unread.push({ line: at, text: line });
      }

      b.rows.push(row);
      continue;
    }

    unread.push({ line: at, text: line });
  }

  // The GATE is the `if` filter, not the $SELECT table.
  //
  // An event the filter does not admit never reaches the mapping, whatever
  // $SELECT says about it. Carrying such an entry into `permit` would build a
  // spec that ACCEPTS a message the class refuses -- a divergence in the one
  // direction nobody notices, because the interface simply handles something
  // extra and nothing errors.
  //
  // So: the filter decides who is admitted, $SELECT decides what each becomes,
  // and a $SELECT entry with no trigger behind it is dead code in the class and
  // is reported rather than imported.
  const mapped = { ...permit };
  for (const k of Object.keys(permit)) delete permit[k];
  for (const t of triggers) permit[t] = mapped[t] ?? t;
  for (const k of Object.keys(mapped)) {
    if (!triggers.includes(k)) {
      notes.push(`$SELECT maps ${k} but the filter never admits it -- dead in the class, not imported`);
    }
  }

  const dtl = processName?.replace(/\.Process\./, ".Dtl.") ?? "Imported.Dtl";
  const spec: Spec = {
    name: processName?.split(".").slice(-1)[0] ?? "Imported Interface",
    description: description.join(" ") || undefined,
    gate: { path: gatePath, permit },
    iris: {
      className: dtl === processName ? `${dtl}.Dtl` : dtl,
      sourceDocType: docType ?? "2.3:ADT_A01",
      targetDocType: docType ?? "2.3:ADT_A01",
      ...(blocks.some((b) => b.group)
        ? { sourceGroups: Object.fromEntries(blocks.filter((b) => b.group).map((b) => [b.id, b.group!])) }
        : {}),
      ...(processName && sendTo
        ? { process: { className: processName, sendTo, comment: `Imported from ${processName}` } }
        : {}),
    },
    blocks,
  };

  return { spec, unread, notes };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => a.toLowerCase().endsWith(".cls"));
  const oi = argv.findIndex((a) => a === "-o" || a === "--out");
  const out = oi === -1 ? undefined : argv[oi + 1];

  if (!file) {
    process.stderr.write(
      `import-cls: name the class to read.\n\n` +
        `  bun import-cls.ts AdtToReceiver.cls -o transform.site.local.ts\n`,
    );
    process.exit(2);
  }

  const decoded = decodeText(readFileSync(file));
  if (decoded.note) process.stderr.write(`  ${file} is ${decoded.note}; decoded it\n`);

  const report = importClass(decoded.text);

  process.stderr.write(`\n  READ FROM ${file}\n`);
  for (const n of report.notes) process.stderr.write(`    ${n}\n`);
  process.stderr.write(
    `\n  ${report.spec.blocks.length} block(s), ` +
      `${report.spec.blocks.reduce((n, b) => n + b.rows.length, 0)} row(s)\n`,
  );

  if (report.unread.length > 0) {
    process.stderr.write(
      `\n  ${report.unread.length} LINE(S) NOT UNDERSTOOD -- these decisions are NOT in the spec:\n`,
    );
    for (const u of report.unread) process.stderr.write(`    line ${u.line}: ${u.text}\n`);
    process.stderr.write(
      `\n  Read them before trusting the output. Each one is something the class does\n` +
        `  and the spec does not, and nothing downstream can tell that it is missing.\n`,
    );
  }

  const problems = validate(report.spec);
  if (problems.length > 0) {
    process.stderr.write(`\n  The imported spec does not validate yet:\n`);
    for (const p of problems) process.stderr.write(`    - ${p}\n`);
  }

  const text = specModule(report.spec, file, report.unread.length);
  if (out) {
    writeFileSync(out, text, "utf8");
    process.stderr.write(`\n  wrote ${out}  (${Buffer.byteLength(text)} bytes, no BOM)\n`);
    process.stderr.write(
      `  The spec is the source of truth from here. Edit it, then\n` +
        `  bun emit.ts process -o ${file}  to write the class back.\n`,
    );
  } else {
    process.stdout.write(text);
  }

  process.exit(report.unread.length === 0 ? 0 : 1);
}
