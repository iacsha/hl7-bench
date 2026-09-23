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
  INLINE, comment, dtlPath, dtlSegment, highestScanStatement, irisComments, irisLog,
  lookupMissStatement, newState, noteBare, os, pathString, pickNotes, sourceCode,
  srcGroups, stepCode,
  type BareRefs, type Scope, type State,
} from "./iris";
import type { Spec, Block, Row, CommentLevel } from "../spec";

/** `pickNotes`, wrapped as ObjectScript line comments at one indent. */
function osNotes(
  level: CommentLevel,
  indent: string,
  full: string[],
  brief: string[],
): string[] {
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
    `${indent}set ${SEED} = ${INLINE.value(`source.${braced}`)}`,
    ...write(st.spec, SEED, to, `${block.id} (whole segment)`, indent),
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
  const from = INLINE.value(`source.${braced}`);
  const to = pathString(dtlSegment(block.id, scope.targetPrefix));
  const inner = `${indent}    `;

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
  if (notes !== "off" && row.note) out.push(`${indent}// ${comment(row.note)}`);

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
  if (notes === "brief" && row.label && row.label !== row.target) {
    out.push(`${indent}// ${comment(row.target)}: ${comment(row.label)}`);
  }

  const { expr, pre } = sourceCode(st, row.from, scope, INLINE);
  for (const line of pre ?? []) out.push(indent + line);

  let value = expr!;
  for (const step of row.via ?? []) value = stepCode(value, step);

  const braced = dtlPath(row.target, scope.targetPrefix);
  const path = pathString(braced);
  const readBack = INLINE.value(`target.${braced}`);
  const level = irisLog(spec);
  const label = row.label ?? row.target;

  // An unmapped code, reported before the write that swallows it. Skipped when
  // the key came through a nested source, for the reason the DTL skips it: that
  // source already ran above and left its answer in a variable, and re-walking
  // it here could disagree with the value actually used.
  if (level !== "off" && row.from.kind === "lookup" && row.from.path) {
    const ref = INLINE.value(
      `source.${dtlPath(row.from.path, scope.sourcePrefix, srcGroups(st))}`,
    );
    const where =
      row.from.path === row.target ? row.target : `${row.from.path} to ${row.target}`;
    const msg = `${os(`${row.from.table} has no row for "`)}_${ref}_${os(`" (${where})`)}`;
    out.push(`${indent}${lookupMissStatement(INLINE, row.from.table, ref, msg)}`);
  }

  out.push(...write(spec, value, path, label === row.target ? row.target : `${row.target} (${label})`, indent));

  // The other silent failure: a required target that came out empty. Read back
  // off the TARGET rather than checked on the source, so a step that emptied a
  // populated source is caught too.
  if (level !== "off" && row.required) {
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
  if (notes !== "off" && block.note) out.push(`${indent}// ${comment(block.note)}`);
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
    `${indent}set ${cnt} = +..ValueAt(tSource, ${countPath})`,
  );

  const guards: string[] = [];
  if (r.skipWhenEmpty) {
    const skipBraced = dtlPath(r.skipWhenEmpty, scope.sourcePrefix, srcGroups(st));
    noteBare(st, skipBraced);
    guards.push(`$LENGTH(${INLINE.value(`source.${skipBraced}`)})>0`);
  }

  // select, between skipWhenEmpty and max, because that is the order the stages
  // run in and the order decides the result.
  if (r.select) {
    const sel = r.select;
    const selBraced = dtlPath(sel.path, scope.sourcePrefix, srcGroups(st));
    noteBare(st, selBraced);
    const here = INLINE.value(`source.${selBraced}`);
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
      const read = INLINE.value(`source.${scanBraced}`);
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
    const here = INLINE.value(`source.${foldBraced}`);
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
          ? `${INLINE.value(`target.${t}`)}_${here}`
          : `${INLINE.value(`target.${t}`)}_${os(fold.join)}_${here}`;
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
    out.push(`${indent}    if ${guards.join(" && ")} {`, ...body, `${indent}    }`);
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
): string[] {
  const st: State = newState(spec, collect);
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

  if (create === "copy") {
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

  out.push(
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
    if (notes !== "off" && block.note) out.push(`${indent}// ${comment(block.note)}`);

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

    if (block.wholeSegment) {
      emitGuardedSeedBlock(st, block, scope, indent, out);
      continue;
    }
    for (const row of block.rows) emitRow(st, row, scope, indent, out);
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
