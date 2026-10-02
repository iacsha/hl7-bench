/**
 * emit/inline.ts -- the mapping as plain ObjectScript, inside `OnRequest`.
 *
 * WHY THIS FILE EXISTS
 *
 * `emit/process.ts` normally writes a process that calls a DTL. Some receiving
 * IRIS teams will not deploy a DTL. That is not a style disagreement to be won,
 * it is the shape the interface has to fit in, so this backend writes the whole
 * mapping into the process class and calls nothing. One artifact, self
 * contained, and the class the customer already accepts.
 *
 * THE VOCABULARY IS NOT WRITTEN TWICE
 *
 * Every source kind and every step kind is defined ONCE, in `emit/iris.ts`, and
 * both backends call `sourceCode` and `stepCode` there. The only thing this
 * file changes is the `Dialect` it passes -- `INLINE` instead of `DTL` -- which
 * decides how a path is spelled and where statements may live. Seventeen kinds
 * with two implementations would be sixteen chances for the bench and the
 * namespace to disagree quietly, and `spec.test.ts` can only hold every backend
 * to every kind while there is one definition to hold.
 *
 * What IS written twice, deliberately, is the STRUCTURE: a DTL says `<foreach>`
 * and `<assign>`, a Method body says `for` and `SetValueAt`. Those are not two
 * spellings of one thing and no parameter would make them one.
 *
 * READS ARE GUARDED, WRITES ARE NOT, AND BOTH ARE ON PURPOSE
 *
 * `GetValueAt` on a path whose SEGMENT is absent THROWS, and an unhandled throw
 * inside `OnRequest` fails the message. A self-pay patient with no IN1 is an
 * ordinary patient, so every read here goes through the `ValueAt` helper below
 * and an absent PV2, GT1, NK1 or IN1 reads as "" rather than taking the process
 * down. That failure has already happened in this shop; it is not hypothetical.
 *
 * Writes go the other way: unconditional, empties included. That is what
 * `run.ts` does -- "Assigned even when empty, because that is what `<assign>`
 * does in a DTL: it creates the field" -- and `run.ts` is the referee
 * `check.ts` judges every backend against. Skipping an empty write here would
 * make this class deliver a SHORTER segment than the bench signed off, and a
 * receiver reading by ordinal position sees a different message.
 *
 * The same rule decides the seed. `startSegment` in `run.ts` delivers a blank
 * segment when a `wholeSegment` block finds no source segment, so this does
 * too, and says so in the log rather than leaving it to be noticed.
 */

import {
  INLINE, comment, dtlPath, lookupExpr, dtlSegment, highestScanStatement, irisComments, irisLog,
  lookupMissStatement, newState, noteBare, os, pathString, pickNotes, sourceCode,
  srcGroups, stepCode,
  type BareRefs, type Dialect, type Scope, type State,
} from "./iris";
import { DEFAULT_STYLE, styledWrite, type Style } from "../style";
import { seedGuarded, type Spec, type Block, type Row, type CommentLevel, type Source } from "../spec";

/**
 * HOUSE STYLE: the same mapping, written the way an IRIS team writes a
 * process by hand. Set for one emit by `emitInlineMapping(..., true)`, which is
 * what `transform: "build"` asks for.
 *
 * Reads come straight off `pRequest` with `GetValueAt`, which on IRIS for
 * Health returns "" for an absent segment rather than throwing (measured, and
 * what every hand-written class in the sampled namespace relies on), so the
 * guarded-read helper goes. Writes go through `$$$ThrowOnError` into
 * `tRequest`, so the status variables go. The explanatory prose goes too; a
 * note the spec's author wrote still prints. Nothing about WHAT is mapped
 * changes -- every source, step, repeat, select, fold and seed below is the
 * same code either way.
 */
let house = false;
/** The style in force for a house emit. See style.ts. */
let houseStyle: Style = DEFAULT_STYLE;

/** Reads for house style: the request as it arrived, and the message being built. */
const HOUSE: Dialect = {
  value: (braced) => houseRead(braced),
  code: (braced) => houseRead(braced),
  lookup: (table, key, fallback) =>
    `##class(Ens.Rule.FunctionSet).Lookup(${table},${key},${fallback})`,
  block: (lines) => lines,
};

function houseRead(braced: string): string {
  const m = /^(\w+)\.\{(.+)\}$/.exec(braced);
  if (!m) throw new Error(`Not a DTL reference: "${braced}"`);
  const obj = m[1] === "source" ? "pRequest" : m[1] === "target" ? "tRequest" : m[1];
  return `${obj}.GetValueAt(${pathString(`{${m[2]}}`)})`;
}

/** The dialect in force for this emit. */
const D = (): Dialect => (house ? HOUSE : INLINE);

/**
 * Whether a spec note prints as a comment in the class.
 *
 * In house style only a short one does, at the default level: a note that runs
 * to a paragraph is the reasoning behind a decision, and it already prints in
 * the mapping document `trace.ts` writes. In the class it is one line nobody
 * can read without scrolling sideways. `comments: "full"` prints them all.
 */
export const NOTE_MAX = 100;
export function noteShown(level: CommentLevel, note: string | undefined, houseStyle: boolean): boolean {
  if (!note || level === "off") return false;
  return !houseStyle || level === "full" || note.length <= NOTE_MAX;
}

type Found = Extract<Source, { kind: "fromFirst" | "fromWhere" }>;

/** The "find an occurrence" source a row reads, directly or as a lookup key. */
function foundOf(from: Source): Found | undefined {
  if (from.kind === "fromFirst" || from.kind === "fromWhere") return from;
  if (from.kind === "lookup" && (from.from?.kind === "fromFirst" || from.from?.kind === "fromWhere")) {
    return from.from as Found;
  }
  return undefined;
}

const foundKey = (x: Found) =>
  x.kind === "fromFirst" ? `first|${x.segment}|${x.nonEmpty}|${x.path}` : `where|${x.segment}|${x.where}|${x.equals}|${x.read}`;

/** House style: the variable each hoisted find was read into. */
let hoisted = new Map<string, string>();
/** House style: top-level required targets, checked in one loop at the end. */
let requiredPaths: string[] = [];

/**
 * House style: ONE pass over each segment the mapping searches, at the top of
 * Mapping, reading every "first non-empty" and "the one where" value in it.
 *
 * A spec that says "the first OBX-14" in five places used to emit five loops
 * over OBX. Both kinds read the MESSAGE, never the occurrence a repeat is on,
 * so the answer is the same wherever the row sits and it may be read once,
 * up front. First match wins, and nothing found leaves "", exactly as each
 * loop on its own did. Variables are named for what they hold: Obxf14 is the
 * first non-empty OBX-14, the way a hand-written class names Pid2.
 */
function emitFirstPass(st: State, indent: string, out: string[]): void {
  hoisted = new Map();
  const bySeg = new Map<string, Found[]>();
  for (const block of st.spec.blocks) {
    for (const row of block.rows) {
      const x = foundOf(row.from);
      if (!x || hoisted.has(foundKey(x))) continue;
      hoisted.set(foundKey(x), "");
      bySeg.set(x.segment, [...(bySeg.get(x.segment) ?? []), x]);
    }
  }
  if (bySeg.size === 0) return;
  const groups = srcGroups(st);
  const names = new Set<string>();
  const nameFor = (seg: string, path: string) => {
    const stem = seg[0] + seg.slice(1).toLowerCase();
    const base = `${stem}f${path.slice(seg.length + 1).replace(/[^0-9]+/g, "c")}`;
    let n = base;
    for (let k = 2; names.has(n); k++) n = `${base}s${k}`;
    names.add(n);
    return n;
  };

  for (const [seg, finds] of bySeg) {
    const g = groups[seg];
    const i = `i${seg[0]}${seg.slice(1).toLowerCase()}`;
    const at = (p: string) => {
      const field = p.slice(seg.length + 1);
      const braced = g ? `{${g}(${i}).${seg}:${field}}` : `{${seg}(${i}):${field}}`;
      noteBare(st, braced);
      return HOUSE.value(`source.${braced}`);
    };
    const count = HOUSE.value(`source.${g ? `{${g}(*)}` : `{${seg}(*)}`}`);
    const vars: string[] = [];
    const lines: string[] = [];
    for (const x of finds) {
      const v = nameFor(seg, x.kind === "fromFirst" ? x.path : x.read);
      vars.push(v);
      hoisted.set(foundKey(x), v);
      if (x.kind === "fromFirst" && x.nonEmpty === x.path) {
        // "First non-empty X": setting an empty value leaves it "", so no flag.
        lines.push(`    if (${v} = "") set ${v} = ${at(x.path)}`);
      } else {
        const flag = `${v}Found`;
        vars.push(flag);
        const test = x.kind === "fromFirst" ? `(${at(x.nonEmpty)} '= "")` : `(${at(x.where)} = ${os(x.equals)})`;
        lines.push(`    if ('${flag}) && ${test} set ${flag} = 1, ${v} = ${at(x.kind === "fromFirst" ? x.path : x.read)}`);
      }
    }
    out.push(
      `${indent}// One pass over ${seg} for every value read from it`,
      `${indent}set (${vars.join(",")}) = ""`,
      `${indent}for ${i}=1:1:${count} {`,
      ...lines.map((l) => indent + l),
      `${indent}}`,
    );
  }
  // Flags start "", which '"" reads as true: not found yet.
}

/** `pickNotes`, wrapped as ObjectScript line comments at one indent. None in house style. */
function osNotes(
  level: CommentLevel,
  indent: string,
  full: string[],
  brief: string[],
): string[] {
  if (house) return [];
  return pickNotes(level, full, brief).map((l) => `${indent}// ${l}`);
}

// ---------------------------------------------------------------------------
// Variable names
//
// Every name the emitted body invents lives here, so a collision is one table
// to read rather than a hunt. `sourceCode` brings its own -- p1, w1, ip1 --
// which is why nothing below uses a bare p or w prefix.
// ---------------------------------------------------------------------------

/** The source occurrence a repeat loop is on. */
const key = (i: number) => `k${i + 1}`;
/** The OUTPUT ordinal a repeat has delivered so far. */
const ordinal = (i: number) => `n${i + 1}`;
/** How many source occurrences there are, read once before the loop. */
const count = (i: number) => `cnt${i + 1}`;
/** The highest value seen by a `select: highest` scan, and its cursor. */
const highestVar = (i: number) => `max${i + 1}`;
const scanValue = (i: number) => `v${i + 1}`;
const scanKey = (i: number) => `${key(i)}m`;

/** The status of the last SetValueAt, when anything is watching it. */
const WRITE_SC = "tWriteSC";
/** The whole-segment value a seed read, held so the log can report a miss. */
const SEED = "tSeed";

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * One `SetValueAt`, and the check on its status when logging is on.
 *
 * At `iris.log: "off"` the status is discarded with `do`, rather than kept in a
 * variable nothing reads. That is what "off" means -- the class says nothing --
 * and a dead variable holding an error nobody looks at reads like a bug.
 */
function write(
  spec: Spec,
  value: string,
  path: string,
  what: string,
  indent: string,
): string[] {
  if (house) return [`${indent}${styledWrite(houseStyle, `tRequest.SetValueAt(${value},${path})`)}`];
  if (irisLog(spec) === "off") return [`${indent}do tTarget.SetValueAt(${value}, ${path})`];
  // The CHECK runs at every comment level -- it is behaviour, and a write that
  // failed silently is the failure `iris.log` exists for. Only the MESSAGE
  // moves. At `full` it names the field and its label, which is the line
  // directly above restated; below `full` it carries the path EXPRESSION, which
  // resolves the occurrence number at run time and so says strictly more.
  // Fold the path INTO the literal rather than concatenating around it.
  // `"write failed "_"MSH:3"_": "` is three constants the compiler joins
  // anyway, and it reads like the generator could not be bothered -- which is
  // the impression this whole change exists to remove.
  //
  // Splicing inside the quotes works for both shapes, because every path this
  // emitter produces begins and ends with a quote character:
  //
  //   "MSH:3"            ->  "write failed MSH:3: "
  //   "NK1("_n1_")"      ->  "write failed NK1("_n1_"): "
  //
  // The second keeps its concatenation, which is where the occurrence number
  // comes from, and loses only the two joins that carried nothing.
  const spliced = path.startsWith(`"`) && path.endsWith(`"`)
    ? `"write failed ${path.slice(1, -1)}: "`
    : `${os(`write failed `)}_${path}_${os(`: `)}`;
  const msg = irisComments(spec) === "full"
    ? `${os(`${what} could not be written: `)}_$SYSTEM.Status.GetErrorText(${WRITE_SC})`
    : `${spliced}_$SYSTEM.Status.GetErrorText(${WRITE_SC})`;
  return [
    `${indent}set ${WRITE_SC} = tTarget.SetValueAt(${value}, ${path})`,
    `${indent}if $$$ISERR(${WRITE_SC}) { $$$LOGWARNING(${msg}) }`,
  ];
}

// ---------------------------------------------------------------------------
// Seed and rows
// ---------------------------------------------------------------------------

/**
 * The seed for a `wholeSegment` block: the source segment copied entire, before
 * any row runs, so the rows below overwrite fields on top of it.
 *
 * This is the one call the hand-written classes this backend models are built
 * out of -- `tTarget.SetValueAt(tSource.GetValueAt("PID"),"PID")` -- and the
 * reason a passthrough interface is three lines rather than fifty.
 *
 * A seed that finds nothing still writes, because `run.ts` still delivers the
 * segment. It is the silent case, so it is also the one the log names.
 */
function emitSeed(st: State, block: Block, scope: Scope, indent: string, out: string[]): void {
  if (!block.wholeSegment) return;
  const to = pathString(dtlSegment(block.id, scope.targetPrefix));
  const braced = dtlSegment(block.id, scope.sourcePrefix, srcGroups(st));
  noteBare(st, braced);
  out.push(
    ...osNotes(
      irisComments(st.spec),
      indent,
      [
        `${comment(block.id)}: copied WHOLE from the source, then overwritten below.`,
        `     Fields not listed below are passed through unexamined.`,
      ],
      [`${comment(block.id)}: copied WHOLE, then overwritten below.`],
    ),
    ...(house
      ? write(st.spec, HOUSE.value(`source.${braced}`), to, block.id, indent)
      : [
          `${indent}set ${SEED} = ${INLINE.value(`source.${braced}`)}`,
          ...write(st.spec, SEED, to, `${block.id} (whole segment)`, indent),
        ]),
  );
}

/**
 * A non-repeating `wholeSegment` block, whole: the seed, the emptiness guard
 * around it, and the block's rows inside that guard.
 *
 * A source that carries no PV2 delivers NO PV2. Writing the empty seed anyway
 * creates a segment with no id -- measured in IRIS, where it prints as a blank
 * line in the message -- and the bench used to deliver a bare "PV2". Neither
 * is right, and the rows go with the segment: they exist to overwrite fields
 * on top of a copy, and there is no copy to overwrite.
 *
 * `run.ts` makes the same decision in the same place, which is the only reason
 * a golden file means anything here.
 *
 * A REPEAT DOES NOT COME THROUGH HERE. Its loop bound is the occurrence count,
 * so an absent segment iterates zero times and no segment is written. Adding a
 * second guard inside the loop would be a test that can never be true.
 */
function emitGuardedSeedBlock(
  st: State,
  block: Block,
  scope: Scope,
  indent: string,
  out: string[],
): void {
  const spec = st.spec;
  const braced = dtlSegment(block.id, scope.sourcePrefix, srcGroups(st));
  noteBare(st, braced);
  const from = D().value(`source.${braced}`);
  const to = pathString(dtlSegment(block.id, scope.targetPrefix));
  const inner = `${indent}    `;

  // House style: test the request, copy it, patch it. No seed variable, and no
  // warning for an optional segment the sender left out -- that is ordinary.
  if (house) {
    out.push(`${indent}If (${from} '= "") {`, ...write(spec, from, to, block.id, inner));
    for (const row of block.rows) emitRow(st, row, scope, inner, out);
    out.push(`${indent}}`);
    return;
  }

  out.push(
    ...osNotes(
      irisComments(spec),
      indent,
      [
        `${comment(block.id)}: copied WHOLE from the source, then overwritten below.`,
        `     Fields not listed below are passed through unexamined.`,
        `A source carrying no ${comment(block.id)} delivers NO ${comment(block.id)}. Writing the empty`,
        `seed would create a segment with no id, which goes down the wire as a`,
        `blank line -- measured in IRIS, not assumed.`,
      ],
      [
        `${comment(block.id)}: copied WHOLE, then overwritten below. A source carrying ` +
          `no ${comment(block.id)} delivers none.`,
      ],
    ),
    `${indent}set ${SEED} = ${from}`,
    `${indent}if $LENGTH(${SEED}) {`,
    ...write(spec, SEED, to, `${block.id} (whole segment)`, inner),
  );

  for (const row of block.rows) emitRow(st, row, scope, inner, out);

  if (irisLog(spec) === "off") {
    out.push(`${indent}}`);
    return;
  }
  // Losing a segment silently is the failure this whole guard exists to stop
  // being silent. The message is well formed either way.
  out.push(
    `${indent}} else {`,
    `${inner}$$$LOGWARNING(${os(`${block.id}: source carries no ${block.id}, segment not delivered`)})`,
    `${indent}}`,
  );
}

function emitRow(st: State, row: Row, scope: Scope, indent: string, out: string[]): void {
  const spec = st.spec;
  const notes = irisComments(spec);
  if (noteShown(notes, row.note, house)) out.push(`${indent}// ${comment(row.note!)}`);

  if (row.from.kind === "todo") {
    // Visible, and no write. A generator that quietly dropped what it cannot
    // express would be worse than no generator: the gap stays invisible until
    // somebody reads a report. `validate()` refuses this pairing outright when
    // the transform is inline, so reaching here means the spec was built by
    // hand past that refusal.
    // Printed at EVERY level, `off` included: a todo row emits no write, so
    // this comment is the only trace it leaves. Dropping it deletes an
    // undecided field in silence.
    out.push(`${indent}// TODO ${comment(row.target)}: ${comment(row.from.why)}`);
    if (notes === "full") {
      out.push(`${indent}//      Write this line by hand. The generator will not guess it.`);
    }
    return;
  }

  // The label's own line. See the twin of this block in `emit/iris.ts`: at
  // `full` the label rides inside the write-failure message, `brief` shortens
  // that message to the path, and without this the spec's own words for the
  // field would be lost at the level that is now the default.
  if (!house && notes === "brief" && row.label && row.label !== row.target) {
    out.push(`${indent}// ${comment(row.target)}: ${comment(row.label)}`);
  }

  // House style maps the event once, in OnRequest, and hands it in as pEvent.
  const found = house ? foundOf(row.from) : undefined;
  const held = found && hoisted.get(foundKey(found));
  const { expr, pre } =
    house && row.from.kind === "event" ? { expr: "pEvent", pre: [] }
    : held && row.from.kind === "lookup" ? { expr: lookupExpr(HOUSE, row.from.table, held, row.from.unmapped), pre: [] }
    : held ? { expr: held, pre: [] }
    : sourceCode(st, row.from, scope, D());
  for (const line of pre ?? []) out.push(indent + line);

  let value = expr!;
  for (const step of row.via ?? []) value = stepCode(value, step);

  const braced = dtlPath(row.target, scope.targetPrefix);
  const path = pathString(braced);
  const readBack = D().value(`target.${braced}`);
  const level = irisLog(spec);
  const label = row.label ?? row.target;

  // An unmapped code, reported before the write that swallows it. Skipped when
  // the key came through a nested source, for the reason the DTL skips it: that
  // source already ran above and left its answer in a variable, and re-walking
  // it here could disagree with the value actually used.
  if (level !== "off" && row.from.kind === "lookup" && row.from.path) {
    const ref = D().value(
      `source.${dtlPath(row.from.path, scope.sourcePrefix, srcGroups(st))}`,
    );
    const where =
      row.from.path === row.target ? row.target : `${row.from.path} to ${row.target}`;
    const msg = `${os(`${row.from.table} has no row for "`)}_${ref}_${os(`" (${where})`)}`;
    out.push(`${indent}${lookupMissStatement(D(), row.from.table, ref, msg)}`);
  }

  out.push(...write(spec, value, path, label === row.target ? row.target : `${row.target} (${label})`, indent));

  // The other silent failure: a required target that came out empty. Read back
  // off the TARGET rather than checked on the source, so a step that emptied a
  // populated source is caught too.
  if (house && level !== "off" && row.required && !scope.targetPrefix) {
    requiredPaths.push(path.slice(1, -1));
  } else if (level !== "off" && row.required) {
    const named = label === row.target ? row.target : `${row.target} (${label})`;
    out.push(
      `${indent}if '$LENGTH(${readBack}) { $$$LOGWARNING(${os(`${named} is required and came out empty`)}) }`,
    );
  }

  if (level === "trace") {
    out.push(`${indent}$$$TRACE(${os(`${row.target} = `)}_${readBack})`);
  }
}

// ---------------------------------------------------------------------------
// Repeats
// ---------------------------------------------------------------------------

/**
 * A repeating block as an ObjectScript loop.
 *
 * The stages run in the order `Repeat` documents and the order is load bearing:
 * skipWhenEmpty, then select, then fold, then max.
 *
 * The count is read ONCE, into a variable, before the loop. Two reasons. A
 * `for` whose limit is a method call reads like it might be re-evaluated per
 * iteration even though it is not, and `+` in front of it turns the "" that an
 * absent segment produces into 0 -- so a message with no NK1 at all runs the
 * body zero times instead of throwing on the way in.
 */
function emitRepeat(st: State, block: Block, index: number, indent: string, out: string[]): void {
  const r = block.repeat!;
  const spec = st.spec;
  const k = key(index);
  const n = ordinal(index);
  const cnt = count(index);
  const grp = block.group;
  // Source and target group separately: `block.group` describes the TARGET, and
  // a 2.5 source that keeps IN1 in IN1grp against a flat 2.3 target is the
  // ordinary case, not the exception.
  const sgrp = srcGroups(st)[r.over] ?? grp;

  const countPath = pathString(sgrp ? `{${sgrp}(*)}` : `{${r.over}(*)}`);
  const scope: Scope = {
    sourcePrefix: sgrp ? `${sgrp}(${k})` : `${r.over}(${k})`,
    targetPrefix: grp ? `${grp}(${n})` : `${block.id}(${n})`,
    counterVar: n,
  };

  const notes = irisComments(spec);

  out.push("");
  if (noteShown(notes, block.note, house)) out.push(`${indent}// ${comment(block.note!)}`);
  out.push(
    ...osNotes(
      notes,
      indent,
      [
        `${comment(block.id)}: numbered by OUTPUT ordinal (${n}), not by source repeat (${k}).`,
        `     A skipped repetition must not leave a hole in the set ids.`,
        `An absent source segment reads as "" and + makes that 0, so this`,
        `loop runs no times rather than failing the message.`,
      ],
      [`${comment(block.id)}: numbered by OUTPUT ordinal (${n}), not by source repeat (${k}).`],
    ),
    `${indent}set ${n} = 0`,
    house ? `${indent}set ${cnt} = pRequest.GetValueAt(${countPath})` : `${indent}set ${cnt} = +..ValueAt(tSource, ${countPath})`,
  );

  const guards: string[] = [];
  if (r.skipWhenEmpty) {
    const skipBraced = dtlPath(r.skipWhenEmpty, scope.sourcePrefix, srcGroups(st));
    noteBare(st, skipBraced);
    guards.push(`$LENGTH(${D().value(`source.${skipBraced}`)})>0`);
  }

  // select, between skipWhenEmpty and max, because that is the order the stages
  // run in and the order decides the result.
  if (r.select) {
    const sel = r.select;
    const selBraced = dtlPath(sel.path, scope.sourcePrefix, srcGroups(st));
    noteBare(st, selBraced);
    const here = D().value(`source.${selBraced}`);
    if (sel.kind === "equals") {
      guards.push(`${here}=${os(sel.value)}`);
    } else {
      // `highest` cannot be a guard on its own: the maximum is not known until
      // every occurrence has been read, so it gets a pass of its own first.
      const mx = highestVar(index);
      const v = scanValue(index);
      const km = scanKey(index);
      const scanPrefix = sgrp ? `${sgrp}(${km})` : `${r.over}(${km})`;
      const scanBraced = dtlPath(sel.path, scanPrefix, srcGroups(st));
      noteBare(st, scanBraced);
      const read = D().value(`source.${scanBraced}`);
      out.push(
        ...osNotes(
          notes,
          indent,
          [
            `${comment(block.id)}: first pass finds the highest ${comment(sel.path)}.`,
            `     Empty ranks lowest, so a message that carries none keeps them all.`,
            `     Digits compare as numbers so 10 beats 9; anything else compares as text.`,
          ],
          [
            `${comment(block.id)}: first pass finds the highest ${comment(sel.path)}. Empty ranks ` +
              `lowest; digits compare as numbers, anything else as text.`,
          ],
        ),
        `${indent}set ${mx} = ""`,
        `${indent}for ${km}=1:1:${cnt} {`,
        `${indent}    ${highestScanStatement(read, mx, v)}`,
        `${indent}}`,
      );
      guards.push(`${here}=${mx}`);
    }
  }

  if (r.max !== undefined) guards.push(`${n}<${r.max}`);

  const bodyIndent = guards.length ? `${indent}        ` : `${indent}    `;
  const body: string[] = [];

  if (r.fold) {
    // A fold is n:1. The head is written immediately and a continuation is
    // APPENDED onto the target field already there, rather than held back --
    // same delivered text as the DTL, and the DTL cannot hold state across a
    // <foreach> at all. Keeping the shapes identical is worth more here than
    // the state a loop would let us keep.
    const fold = r.fold;
    const foldBraced = dtlPath(fold.path, scope.sourcePrefix, srcGroups(st));
    noteBare(st, foldBraced);
    const here = D().value(`source.${foldBraced}`);
    const isCont = `(${n}>0)&&($EXTRACT(${here},1)=" ")`;
    const carriers = block.rows.filter(
      (row) => row.from.kind === "copy" && row.from.path === fold.path,
    );

    const headIndent = `${bodyIndent}    `;
    const head: string[] = [`${headIndent}set ${n} = ${n} + 1`];
    emitSeed(st, block, scope, headIndent, head);
    for (const row of block.rows) emitRow(st, row, scope, headIndent, head);

    body.push(
      ...osNotes(
        notes,
        bodyIndent,
        [
          `A continuation line does not open a new segment. It is appended`,
          `to the one already written, and ${n} is left where it is.`,
        ],
        [`A continuation line is appended to the segment already written; ${n} does not advance.`],
      ),
      `${bodyIndent}if ${isCont} {`,
    );
    for (const row of carriers) {
      const t = dtlPath(row.target, scope.targetPrefix);
      const joined =
        fold.join === ""
          ? `${D().value(`target.${t}`)}_${here}`
          : `${D().value(`target.${t}`)}_${os(fold.join)}_${here}`;
      body.push(...write(spec, joined, pathString(t), row.target, `${bodyIndent}    `));
    }
    body.push(`${bodyIndent}} else {`, ...head, `${bodyIndent}}`);
  } else {
    body.push(`${bodyIndent}set ${n} = ${n} + 1`);
    emitSeed(st, block, scope, bodyIndent, body);
    for (const row of block.rows) emitRow(st, row, scope, bodyIndent, body);
  }

  out.push(`${indent}for ${k}=1:1:${cnt} {`);
  if (guards.length) {
    // Parenthesised: ObjectScript reads `a>0 && n<3` as `((a>0)&&n)<3`. See the
    // DTL emitter's <if> for the measurement.
    out.push(`${indent}    if ${guards.map((g) => `(${g})`).join(" && ")} {`, ...body, `${indent}    }`);
  } else {
    out.push(...body);
  }
  out.push(`${indent}}`);
}

// ---------------------------------------------------------------------------
// The whole mapping
// ---------------------------------------------------------------------------

/** True when anything in the emitted body will keep a SetValueAt status. */
function watchesWrites(spec: Spec): boolean {
  return irisLog(spec) !== "off";
}

/** True when any block seeds, so the seed variable is worth declaring. */
function seeds(spec: Spec): boolean {
  return spec.blocks.some((b) => b.wholeSegment);
}

/**
 * The `#dim` lines the inline body needs on top of the ones every process has.
 *
 * Only the variables that are always written. Loop counters are private and
 * auto-declared inside a ProcedureBlock method, and listing thirty of them
 * would bury the two that matter.
 */
export function inlineDeclarations(spec: Spec): string[] {
  const out: string[] = [];
  if (watchesWrites(spec)) out.push(`    #dim ${WRITE_SC} As %Status = $$$OK`);
  if (seeds(spec)) out.push(`    #dim ${SEED} As %String = ""`);
  return out;
}

/**
 * The statements that build `tTarget` and fill it, for an `OnRequest` body.
 *
 * `tSource` is already a clone of the request when this runs -- the caller does
 * that, because it has to happen whether the mapping is inline or in a DTL.
 */
export function emitInlineMapping(
  spec: Spec,
  indent: string,
  collect?: BareRefs,
  houseMode = false,
  style: Style = DEFAULT_STYLE,
): string[] {
  house = houseMode;
  houseStyle = style;
  try {
    const out = mappingBody(spec, indent, collect);
    return house ? out.map(houseLine) : out;
  } finally {
    house = false;
  }
}

/**
 * One line, as a hand-written class writes it: tabs, and a capitalised
 * leading command. Applied to the body AFTER it is built, so the shared source
 * and step code does not need to know who is asking.
 */
function houseLine(line: string): string {
  const m = /^( *)(.*)$/.exec(line)!;
  const tabs = "\t".repeat(Math.floor(m[1]!.length / 4)) + " ".repeat(m[1]!.length % 4);
  const text = m[2]!
    .replace(/^(set|if|for|quit|do|while)\b/, (w) => w[0]!.toUpperCase() + w.slice(1))
    .replace(/^\} else \{/, "} Else {")
    .replace(/^\} elseif /, "} ElseIf ")
    // A command after a condition on the same line, as in If (x) Set y = z.
    .replace(/([{)]) (set|if|quit|do) /g, (_m, p: string, w: string) => `${p} ${w[0]!.toUpperCase()}${w.slice(1)} `)
    .replace(/\} elseif /g, "} ElseIf ");
  return tabs + text.replace(/^\/\/ /, "//");
}

function mappingBody(spec: Spec, indent: string, collect?: BareRefs): string[] {
  const st: State = newState(spec, collect);
  requiredPaths = [];
  const notes = irisComments(spec);
  const out: string[] = [];
  const create = spec.iris.create ?? "new";

  out.push(
    ...osNotes(
      notes,
      indent,
      [
        `No DTL. The mapping is below, which is the whole point of`,
        `iris.process.transform = "inline": one class to deploy, and`,
        `nothing that needs a transform in the portal.`,
      ],
      [],
    ),
  );

  if (house) {
    out.push(
      `${indent}set tRequest = ##class(EnsLib.HL7.Message).%New()`,
      `${indent}set tRequest.Separators = pRequest.Separators`,
      `${indent}${styledWrite(houseStyle, `tRequest.PokeDocType(${os(spec.iris.targetDocType)})`)}`,
    );
  } else if (create === "copy") {
    out.push(
      ...osNotes(
        notes,
        indent,
        [
          `create='copy' in the spec, so the target STARTS as the request and the`,
          `blocks below overwrite on top of it. Fields nobody assigned ride along,`,
          `which is what 'copy' means and is rarely what you want.`,
        ],
        [`create='copy': the target starts as the request, so unassigned fields ride along.`],
      ),
      `${indent}set tTarget = tSource.%ConstructClone(1)`,
    );
  } else {
    out.push(
      ...osNotes(
        notes,
        indent,
        [
          `create='new' in the spec, so block order below IS the output and`,
          `nothing rides along from the request.`,
        ],
        [`create='new': block order below IS the output; nothing rides along.`],
      ),
      `${indent}set tTarget = ##class(EnsLib.HL7.Message).%New()`,
      ...osNotes(
        notes,
        indent,
        [
          `Separators come from the SENDER. A fresh message would otherwise use`,
          `the defaults, and a feed declaring anything else leaves re-encoded.`,
        ],
        [`Separators come from the SENDER, or a feed declaring its own leaves re-encoded.`],
      ),
      `${indent}set tTarget.Separators = tSource.Separators`,
    );
  }

  // House style set its DocType above and needs no IsMutable: %New() is mutable.
  if (!house) out.push(
    ...osNotes(
      notes,
      indent,
      [
        `The DocType is what tells SetValueAt where a path goes. Without it every`,
        `write below resolves nowhere and a well-formed empty message is`,
        `delivered -- the same fail-closed silence a wrong DocType has in a DTL,`,
        `with no transform page to inspect.`,
      ],
      [`Without a DocType every write below resolves nowhere, and does it silently.`],
    ),
    `${indent}set tSC = tTarget.PokeDocType(${os(spec.iris.targetDocType)})`,
    `${indent}if $$$ISERR(tSC) quit tSC`,
    ``,
    ...osNotes(
      notes,
      indent,
      [
        `A transformed or saved message refuses SetValueAt at RUN time, per`,
        `message, with <Ens>ErrGeneral: Cannot modify immutable message. It`,
        `compiles without this line, which is what makes leaving it out cost a`,
        `morning rather than a compile.`,
      ],
      // The IsMutable reason survives `brief` by name: the line looks like
      // boilerplate, it compiles without complaint, and it fails at run time
      // per message. Nobody re-derives that from the code.
      [`Without this, SetValueAt fails at RUN time: <Ens>ErrGeneral, Cannot modify immutable message.`],
    ),
    `${indent}set tTarget.IsMutable = 1`,
  );

  if (house) {
    out.push(``);
    emitFirstPass(st, indent, out);
  }

  // Segment order is block order, the same order the runner delivers in.
  let repeatIndex = 0;
  let contIndex = 0;
  const lastCounter = new Map<string, string>();

  for (const block of spec.blocks) {
    if (block.repeat) {
      const idx = repeatIndex++;
      emitRepeat(st, block, idx, indent, out);
      lastCounter.set(block.id, ordinal(idx));
      continue;
    }

    out.push("");
    if (noteShown(notes, block.note, house)) out.push(`${indent}// ${comment(block.note!)}`);

    // A block that continues an earlier one's numbering needs the occurrence in
    // a variable of its own, for the same reason the DTL does: the addition
    // happens once and the path uses the result.
    let contVar: string | undefined;
    if (block.continuesNumbering) {
      const from = lastCounter.get(block.id);
      if (from) {
        contVar = `c${++contIndex}`;
        out.push(
          ...osNotes(
            notes,
            indent,
            [`${comment(block.id)}: one more, after the ${comment(block.id)} loop above.`],
            [`${comment(block.id)}: one more, after the ${comment(block.id)} loop above.`],
          ),
          `${indent}set ${contVar} = ${from} + 1`,
        );
        lastCounter.set(block.id, contVar);
      }
    }

    // A group on a block that does NOT repeat still has to be addressed: the
    // segment lives inside the group's first occurrence, and a bare IN1:2 on a
    // schema whose IN1 sits in IN1grp writes nowhere, quietly.
    const scope: Scope = contVar
      ? { sourcePrefix: "", targetPrefix: `${block.id}(${contVar})`, counterVar: contVar }
      : block.group
        ? { sourcePrefix: `${block.group}(1)`, targetPrefix: `${block.group}(1)` }
        : { sourcePrefix: "", targetPrefix: "" };

    if (seedGuarded(st.spec, block)) {
      emitGuardedSeedBlock(st, block, scope, indent, out);
      continue;
    }
    // MSH, and anything in `iris.alwaysPresent`: the same seed, no guard around it.
    emitSeed(st, block, scope, indent, out);
    for (const row of block.rows) emitRow(st, row, scope, indent, out);
  }

  // The receiver's required fields, checked once the message is built: warn,
  // never block. One loop, the way a hand-written class checks a list.
  if (house && requiredPaths.length > 0) {
    out.push(
      ``,
      `${indent}// Required by the receiver: warn, do not block`,
      `${indent}for f=${requiredPaths.map((p) => os(p)).join(",")} {`,
      `${indent}    if (tRequest.GetValueAt(f) = "") $$$LOGWARNING("Required field "_f_" came out empty")`,
      `${indent}}`,
    );
  }

  return out;
}

/**
 * The guarded read every inline body is built on, as a class member.
 *
 * TWO THINGS BITE HERE AND THEY BITE SEPARATELY
 *
 *   1. `GetValueAt` on a path whose SEGMENT is absent THROWS. An unhandled
 *      throw inside `OnRequest` fails the message, so a patient with no IN1
 *      lands in the error queue for being ordinary. This is the failure mode
 *      this whole helper exists for, and it is one this shop has already had.
 *   2. On a failed read the STATUS argument is left undefined rather than set,
 *      so testing it without initialising it is an <UNDEFINED> of its own.
 *
 * So: initialise first, pass the status by reference, and catch anyway. The
 * catch is not belt and braces -- the status argument covers a path that
 * resolves and finds nothing, and the catch covers a path the schema cannot
 * resolve at all, which is the one that throws.
 *
 * Empty is the right answer for both. It is what `source.{PV2:3}` yields in a
 * DTL with IGNOREMISSINGSOURCE=1, and what `run.ts` yields on the bench.
 */
export function inlineHelpers(level: CommentLevel = "full"): string[] {
  return [
    ...pickNotes(
      level,
      [
        `/// A read that cannot kill the process.`,
        `///`,
        `/// GetValueAt on a path whose SEGMENT is absent THROWS, and an unhandled throw`,
        `/// in OnRequest fails the message -- so a self-pay patient with no IN1 reaches`,
        `/// the error queue for being ordinary. On a failed read the status argument is`,
        `/// also left UNDEFINED rather than set, so it is initialised before it is read.`,
        `///`,
        `/// Empty is the right answer for a path that is not there. It is what the DTL`,
        `/// yields with IGNOREMISSINGSOURCE=1 and what the bench yields, and all three`,
        `/// agreeing is the only reason a golden file means anything.`,
      ],
      [
        `/// A read that cannot kill the process. GetValueAt on an absent SEGMENT throws,`,
        `/// and it leaves its status argument UNDEFINED rather than set. Empty is the`,
        `/// right answer for a path that is not there, and what the DTL and bench yield.`,
      ],
    ),
    `ClassMethod ValueAt(pDoc As EnsLib.HL7.Message, pPath As %String) As %String`,
    `{`,
    `    #dim tValue As %String = ""`,
    `    #dim tSC As %Status = $$$OK`,
    `    try {`,
    `        set tValue = pDoc.GetValueAt(pPath, , .tSC)`,
    `        if $$$ISERR(tSC) set tValue = ""`,
    `    } catch {`,
    `        set tValue = ""`,
    `    }`,
    `    quit tValue`,
    `}`,
    ``,
  ];
}
