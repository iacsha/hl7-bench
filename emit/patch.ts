/**
 * emit/patch.ts -- the mapping as a clone-and-patch business process.
 *
 * WHY THIS FILE EXISTS
 *
 * `emit/inline.ts` BUILDS the target: an empty message, then every delivered
 * segment copied in one at a time. That is a faithful rendering of what the
 * bench does, and it is not how a receiving IRIS team writes an HL7-to-HL7
 * process. Every hand-written HL7 process sampled from a production namespace
 * does the other thing: clone the request, patch fields in place, remove the
 * segments the receiver does not take, and send. Their review of the inline
 * class was "leaner, and consistent with what we have" -- and most of the bulk
 * they meant (seed copies, a presence guard per segment, a guarded read helper,
 * a second counter per loop) exists only because the target is built rather
 * than cloned. Cloned, an absent segment is simply still absent.
 *
 * So this backend writes their shape. `OnRequest` is try, `Mapping`, send;
 * `Mapping` clones and patches. Writes, removes and the send go through
 * `$$$ThrowOnError`; the class is `[ ClassType = persistent ]` with a Storage
 * block and no Include. Reads are bare `GetValueAt`, which on IRIS for Health
 * 2026.1 returns "" for a path whose segment is absent rather than throwing --
 * measured on the lab, and what every sampled class already relies on.
 *
 * THE SAME MESSAGE, NOT A NEW MEANING
 *
 * The bench is still the referee. This backend accepts only the specs whose
 * clone-and-patch rendering delivers what `run.ts` delivers, and `validate()`
 * refuses the rest by name (see `patchProblems` in spec.ts): every block copied
 * whole, one block per segment, repeats with at most a `skipWhenEmpty`, and a
 * source DocType the target can keep. Inside that, the only difference is
 * segment ORDER -- a clone keeps the sender's, the bench delivers block order --
 * which for a schema-ordered feed is the same order. The golden gate on a real
 * engine is what proves it for a given spec.
 *
 * WHERE THE SOURCE AND STEP KINDS COME FROM
 *
 * `sourceCode` and `stepCode` in `emit/iris.ts`, through the `PATCH` dialect
 * below. There is still one definition of every kind. The one exception is
 * `event()`: the gate's permit table is mapped ONCE in `OnRequest` with a
 * `$CASE` and handed to `Mapping` as `pEvent`, so the rows read the variable
 * instead of repeating the table -- and read it off the request, which a patch
 * of MSH-9.2 higher up would otherwise have changed underneath them.
 */

import {
  comment, dtlPath, dtlSegment, irisComments, irisLog, lookupExpr, lookupMissStatement, newState,
  noteBare, os, pathString, sourceCode, srcGroups, stepCode,
  type BareRefs, type Dialect, type Scope, type State,
} from "./iris";
import { fingerprint } from "../fingerprint";
import { emitInlineMapping } from "./inline";
import { DEFAULT_STYLE, layout, loadStyle, mappingReturnsStatus, styledWrite, type Style } from "../style";

/** The style in force for one emit. See style.ts. */
let S: Style = DEFAULT_STYLE;
/** The spec's own fingerprint, taken before a style's comment level is applied. */
let FP = "";

/** A write or remove, as the style in force writes it. */
const W = (call: string) => styledWrite(S, call);

/**
 * Set the style for one emit, and apply its comment level to the spec the
 * emitter reads. The fingerprint is taken from the spec as written: a style is
 * a site's taste, not a change to the interface.
 */
function begin(spec: Spec, style: Style): Spec {
  S = style;
  FP = fingerprint(spec);
  return style.comments ? { ...spec, iris: { ...spec.iris, comments: style.comments } } : spec;
}

/**
 * The finished class. Head and tail are the shell; the body is Mapping's. The
 * body is written two tabs in, inside Mapping's try; a style without that try
 * takes one tab back out. Then the style's indent and command case, last.
 */
function finish(head: string[], body: string[], tail: string[]): string {
  const b = S.mappingTry ? body : body.map((l) => l.replace(/^\t/, ""));
  return layout(S, [...head, ...b, ...tail].join("\n"));
}
import { seedGuarded, fieldOf, type Spec, type Block, type Row, type KeySource } from "../spec";

const T = "\t";

/**
 * Reads come off `pRequest`, never off the clone being patched: a row that
 * reads a field an earlier row already rewrote would otherwise see the new
 * value, where the bench reads the message as it arrived.
 */
export const PATCH: Dialect = {
  value: (braced) => patchRead(braced),
  code: (braced) => patchRead(braced),
  lookup: (table, key, fallback) =>
    `##class(Ens.Rule.FunctionSet).Lookup(${table},${key},${fallback})`,
  block: (lines) => lines,
};

function patchRead(braced: string): string {
  const m = /^(\w+)\.\{(.+)\}$/.exec(braced);
  if (!m) throw new Error(`Not a DTL reference: "${braced}"`);
  const obj = m[1] === "source" ? "pRequest" : m[1] === "target" ? "tRequest" : m[1];
  return `${obj}.GetValueAt(${pathString(`{${m[2]}}`)})`;
}

type Where = Extract<KeySource, { kind: "fromWhere" }>;

/** The occurrence a fromWhere finds: same segment, same test, same value. */
const whereKey = (w: Where) => `${w.segment}|${w.where}|${w.equals}`;

/** The fromWhere a row reads through, directly or as a lookup key, or none. */
function whereOf(row: Row): Where | undefined {
  const f = row.from;
  if (f.kind === "fromWhere") return f;
  if (f.kind === "lookup" && f.from?.kind === "fromWhere") return f.from;
  return undefined;
}

/**
 * Field reads resolved by a shared scan, keyed by `whereKey|read`. Set for the
 * rows of one block, while that block is being written.
 */
let scanned = new Map<string, string>();

/** How many scans each segment has had in this class, for unique names. */
let usedStems = new Map<string, number>();

/**
 * One scan for every fromWhere match a block's rows share, emitted ABOVE the
 * block and its loop.
 *
 * GT1-45, GT1-46 and GT1-48 all want "the NK1 whose NK1-1 is 2". Written row by
 * row that is three identical loops over NK1, repeated for every GT1 -- the
 * first thing a reviewer circles. This finds the occurrence once and pulls
 * every field the rows read out of it in the same pass. It may move out of the
 * repeat because fromWhere reads the MESSAGE, not the current occurrence, so
 * its answer is the same on every pass of the loop; first match wins, and no
 * match leaves every field "", exactly as the row-by-row form does.
 */
function emitScans(st: State, block: Block, indent: string, out: string[]): void {
  scanned = new Map();
  const groupsBy = new Map<string, { w: Where; reads: string[] }>();
  for (const row of block.rows) {
    const w = whereOf(row);
    if (!w) continue;
    const g = groupsBy.get(whereKey(w)) ?? { w, reads: [] };
    if (!g.reads.includes(w.read)) g.reads.push(w.read);
    groupsBy.set(whereKey(w), g);
  }
  const groups = srcGroups(st);
  for (const { w, reads } of groupsBy.values()) {
    // Named for what they hold, the way hand-written classes name them (Pid2,
    // Pid18): "Nk1f2" is NK1-2. A second scan of the same segment in one class
    // gets a number, so the names never collide.
    const stem = w.segment[0] + w.segment.slice(1).toLowerCase();
    const n = (usedStems.get(stem) ?? 0) + 1;
    usedStems.set(stem, n);
    const tag = n === 1 ? stem : `${stem}s${n}`;
    const vars = reads.map((r) => `${tag}f${r.slice(w.segment.length + 1).replace(/[^0-9]+/g, "c")}`);
    const i = `i${tag}`;
    const g = groups[w.segment];
    const at = (path: string) => {
      const field = path.slice(w.segment.length + 1);
      return pathString(g ? `{${g}(${i}).${w.segment}:${field}}` : `{${w.segment}(${i}):${field}}`);
    };
    const count = pathString(g ? `{${g}(*)}` : `{${w.segment}(*)}`);
    if (irisComments(st.spec) !== "off") {
      out.push(`${indent}//The ${w.segment} whose ${w.where} is ${comment(w.equals)}, found once for every field read from it`);
    }
    out.push(
      `${indent}Set (${vars.join(",")}) = ""`,
      `${indent}For ${i}=1:1:pRequest.GetValueAt(${count}) {`,
      `${indent}${T}If (pRequest.GetValueAt(${at(w.where)}) = ${os(w.equals)}) {`,
      `${indent}${T}${T}Set ${reads.map((r, n) => `${vars[n]} = pRequest.GetValueAt(${at(r)})`).join(", ")}`,
      `${indent}${T}${T}Quit`,
      `${indent}${T}}`,
      `${indent}}`,
    );
    reads.forEach((r, n) => scanned.set(`${whereKey(w)}|${r}`, vars[n]!));
  }
}

/** Loop variable for the n-th repeating block. */
const key = (i: number) => `k${i + 1}`;

// ---------------------------------------------------------------------------

export function emitPatch(specIn: Spec, collect?: BareRefs, style: Style = loadStyle()): string {
  const spec = begin(specIn, style);
  const proc = spec.iris.process!;
  const st = newState(spec, collect);
  usedStems = new Map();
  const notes = irisComments(spec);
  const said = notes !== "off";
  const groups = srcGroups(st);
  const out: string[] = [];

  const head = houseHead(spec, st);
  out.push(`${T}${T}Set tRequest = pRequest.%ConstructClone()`);

  const body = `${T}${T}`;
  const inner = `${body}${T}`;

  // ---- field patches, in block order ----------------------------------------
  // Before any removal, so occurrence k of the clone is still occurrence k of
  // the request and a repeat can read one and write the other by one index.
  // Numbered in the order the loops appear in the class, not the order the
  // blocks appear in the spec: a skip-only repeat is written further down.
  const keys = new Map<Block, string>();
  const keyFor = (b: Block) => keys.get(b) ?? (keys.set(b, key(keys.size)), keys.get(b)!);
  const skips: { block: Block; countPath: string; grp?: string }[] = [];
  for (const block of spec.blocks) {
    const grp = groups[block.id] ?? block.group;
    if (block.repeat) {
      const countPath = pathString(grp ? `{${grp}(*)}` : `{${block.id}(*)}`);
      if (block.repeat.skipWhenEmpty) skips.push({ block, countPath, grp });
      if (block.rows.length === 0) continue;
      const k = keyFor(block);
      const prefix = grp ? `${grp}(${k})` : `${block.id}(${k})`;
      // counter() is the occurrence index. patchProblems() refuses it beside a
      // skipWhenEmpty, which is the one case where the two would differ.
      const scope: Scope = { sourcePrefix: prefix, targetPrefix: prefix, counterVar: k };
      out.push(``);
      if (said && block.note) out.push(`${body}//${comment(block.note)}`);
      emitScans(st, block, body, out);
      out.push(`${body}For ${k}=1:1:pRequest.GetValueAt(${countPath}) {`);
      for (const row of block.rows) emitRow(st, row, scope, inner, out);
      out.push(`${body}}`);
      continue;
    }

    if (block.rows.length === 0) continue;
    const prefix = grp ? `${grp}(1)` : "";
    const scope: Scope = { sourcePrefix: prefix, targetPrefix: prefix };
    out.push(``);
    if (said && block.note) out.push(`${body}//${comment(block.note)}`);
    emitScans(st, block, body, out);
    // A segment the sender can leave out keeps its rows behind a presence
    // test: written unconditionally, the first SetValueAt would CREATE the
    // segment the sender did not send. MSH, and anything the spec lists in
    // iris.alwaysPresent, are written without one.
    if (seedGuarded(spec, block)) {
      const seg = dtlSegment(block.id, prefix, groups);
      noteBare(st, seg);
      out.push(`${body}If (${PATCH.value(`source.${seg}`)} '= "") {`);
      for (const row of block.rows) emitRow(st, row, scope, inner, out);
      out.push(`${body}}`);
    } else {
      for (const row of block.rows) emitRow(st, row, scope, body, out);
    }
  }

  // ---- occurrences the spec skips -------------------------------------------
  // Backwards, so removing occurrence k never renumbers one still to be tested,
  // and tested on the REQUEST, which no patch above has touched.
  for (const { block, countPath, grp } of skips) {
    const k = keyFor(block);
    const path = block.repeat!.skipWhenEmpty!;
    const at = grp ? `${grp}(${k})` : `${block.id}(${k})`;
    const test = PATCH.value(`source.${dtlPath(path, at, groups)}`);
    const seg = pathString(dtlSegment(block.id, at, groups));
    out.push(``);
    if (said) {
      out.push(`${body}//${comment(block.note ?? `Remove each ${block.id} whose ${block.id}-${fieldOf(path)} is empty`)}`);
    }
    out.push(
      `${body}For ${k}=pRequest.GetValueAt(${countPath}):-1:1 {`,
      // Each comparison parenthesised: ObjectScript reads `a = "" || a = "X"`
      // left to right as `((a = "") || a) = "X"`.
      `${inner}If ${["", ...(block.repeat!.skipValues ?? [])].map((v) => `(${test} = ${os(v)})`).join(" || ")} ${W(`tRequest.RemoveSegmentAt(${seg})`)}`,
      `${body}}`,
    );
  }

  // ---- the segments that go -------------------------------------------------
  // One forward pass by position, advancing only past a segment that stays --
  // the loop UtilitySet.removeZsegments uses -- with the bound tested at the
  // top, so a message that is MSH alone never reads a segment 2 it does not
  // have.
  const kept = [...new Set(spec.blocks.map((b) => b.id))].filter((id) => id !== "MSH");
  out.push(``);
  if (said) out.push(`${body}//Only these segments are sent. Anything else, Z segments included, is removed`);
  out.push(
    `${body}Set segCount = 2`,
    `${body}While (segCount <= tRequest.SegCount) {`,
    `${inner}If ##class(Ens.Util.FunctionSet).In(tRequest.GetSegmentAt(segCount).Name,${os(kept.join(","))}) {`,
    `${inner}${T}Set segCount = segCount + 1`,
    `${inner}} Else {`,
    `${inner}${T}${W("tRequest.RemoveSegmentAt(segCount)")}`,
    // segCount only advances past a kept segment, so a remove that fails and
    // does not throw would spin here forever. Accumulate stops the sweep.
    ...(S.writes === "accumulate" ? [`${inner}${T}If $$$ISERR(tSC) Quit`] : []),
    `${inner}}`,
    `${body}}`,
  );

  return finish(head, out, houseTail(spec));
}

function emitRow(st: State, row: Row, scope: Scope, indent: string, out: string[]): void {
  const spec = st.spec;
  const notes = irisComments(spec);
  if (notes !== "off" && row.note) out.push(`${indent}//${comment(row.note)}`);
  if (notes === "full" && row.label && row.label !== row.target) {
    out.push(`${indent}//${comment(row.target)}: ${comment(row.label)}`);
  }

  // Printed at every level: a todo row writes nothing, so this is the only
  // trace it leaves. validate() refuses todo() under "patch" anyway.
  if (row.from.kind === "todo") {
    out.push(`${indent}//TODO ${comment(row.target)}: ${comment(row.from.why)}`);
    return;
  }

  let value: string;
  const w = whereOf(row);
  const found = w && scanned.get(`${whereKey(w)}|${w.read}`);
  if (row.from.kind === "event") {
    value = "pEvent";
  } else if (found && row.from.kind === "fromWhere") {
    value = found;
  } else if (found && row.from.kind === "lookup") {
    value = lookupExpr(PATCH, row.from.table, found, row.from.unmapped);
  } else {
    const { expr, pre } = sourceCode(st, row.from, scope, PATCH);
    // The shared scans indent by two spaces; this class indents by tab.
    for (const line of pre ?? []) out.push(indent + line.replace(/^(  )+/, (m) => T.repeat(m.length / 2)));
    value = expr!;
  }
  for (const step of row.via ?? []) value = stepCode(value, step);

  const path = pathString(dtlPath(row.target, scope.targetPrefix, srcGroups(st)));
  const level = irisLog(spec);
  const named = row.label && row.label !== row.target ? `${row.target} (${row.label})` : row.target;

  if (level !== "off" && row.from.kind === "lookup" && row.from.path) {
    const ref = PATCH.value(`source.${dtlPath(row.from.path, scope.sourcePrefix, srcGroups(st))}`);
    const msg = `${os(`${row.from.table} has no row for "`)}_${ref}_${os(`" (${row.target})`)}`;
    out.push(`${indent}${lookupMissStatement(PATCH, row.from.table, ref, msg)}`);
  }

  out.push(`${indent}${W(`tRequest.SetValueAt(${value},${path})`)}`);

  if (level !== "off" && row.required) {
    out.push(`${indent}If (tRequest.GetValueAt(${path}) = "") $$$LOGWARNING(${os(`${named} is required and came out empty`)})`);
  }
  if (level === "trace") out.push(`${indent}$$$TRACE(${os(`${row.target} = `)}_tRequest.GetValueAt(${path}))`);
}

// ---------------------------------------------------------------------------
// The class around the mapping, shared by "patch" and "build"
// ---------------------------------------------------------------------------

/**
 * Header, OnRequest, and the opening of Mapping, up to its `try {`.
 *
 * One shell for both house-style backends, so a class that clones and a class
 * that builds read identically everywhere except the body of Mapping: the same
 * `$CASE` over the permit table, the same "Message Filtered Out" trace, the
 * same `$$$ThrowOnError` on Mapping and on the send.
 */
function houseHead(spec: Spec, st: State): string[] {
  const proc = spec.iris.process!;
  const said = irisComments(spec) !== "off";
  const groups = srcGroups(st);
  const out: string[] = [];
  const gateRef = PATCH.value(`source.${dtlPath(spec.gate.path, "", groups)}`);
  const arms = Object.entries(spec.gate.permit).map(([from, to]) => `${os(from)}:${os(to)}`);

  // The header is two lines at every level: what it is, and where it came
  // from. The fingerprint is the only way to tell a stale compile from a
  // current one, so `off` keeps it.
  out.push(
    `/// ${comment(proc.comment ?? `Business process for ${spec.name}`)}`,
    ...(S.header === "generator"
      ? [`/// Generated by hl7-bench from spec ${FP}${S.name === "defensive" ? "" : `, style ${S.name}`}. Change the spec and re-emit, not this class.`]
      : []),
    `Class ${proc.className} Extends Ens.BusinessProcess [ ClassType = persistent ]`,
    `{`,
    ``,
    `Method OnRequest(pRequest As EnsLib.HL7.Message, Output pResponse As Ens.Response) As %Status`,
    `{`,
    `${T}#dim tRequest As EnsLib.HL7.Message`,
    `${T}Set tSC = $$$OK`,
    `${T}try {`,
  );
  if (said) {
    const described = Object.entries(spec.gate.permit)
      .map(([from, to]) => (from === to ? from : `${from} as ${to}`))
      .join(", ");
    out.push(`${T}${T}//Sent on: ${comment(described)}. Anything else is filtered out, not failed`);
  }
  out.push(
    `${T}${T}Set tEvent = $CASE(${gateRef},${arms.join(",")},:"")`,
    `${T}${T}If (tEvent = "") {`,
    ...filtered(`${T}${T}${T}`, `${os(`Message Filtered Out: ${spec.gate.path} is `)}_${gateRef}`),
    `${T}${T}${T}Return tSC`,
    `${T}${T}}`,
  );
  for (const r of spec.gate.require ?? []) {
    const ref = PATCH.value(`source.${dtlPath(r.path, "", groups)}`);
    out.push(
      r.inTable !== undefined
        ? `${T}${T}If ('##class(Ens.Util.FunctionSet).Exists(${os(r.inTable)},${ref})) {`
        : `${T}${T}If (${ref} '= ${os(r.equals)}) {`,
      ...filtered(
        `${T}${T}${T}`,
        os(r.inTable !== undefined
          ? `Message Filtered Out: ${r.path} is not a key in ${r.inTable}`
          : `Message Filtered Out: ${r.path} is not ${r.equals}`),
      ),
      `${T}${T}${T}Return tSC`,
      `${T}${T}}`,
    );
  }
  out.push(
    ``,
    mappingReturnsStatus(S)
      ? `${T}${T}$$$ThrowOnError(..Mapping(pRequest,.tRequest,tEvent))`
      : `${T}${T}Do ..Mapping(pRequest,.tRequest,tEvent)`,
    S.send === "checked"
      ? `${T}${T}$$$ThrowOnError(..SendRequestAsync(${os(proc.sendTo)},tRequest,0))`
      : `${T}${T}Do ..SendRequestAsync(${os(proc.sendTo)},tRequest,0)`,
    `${T}} catch e {`,
    `${T}${T}Set tSC = e.AsStatus()`,
    `${T}}`,
    `${T}Quit tSC`,
    `}`,
    ``,
    `Method Mapping(pRequest As EnsLib.HL7.Message, Output tRequest As EnsLib.HL7.Message, pEvent As %String) As %Status`,
    `{`,
    ...(S.mappingTry ? [`${T}Set tSC = $$$OK`, `${T}try {`] : S.writes === "accumulate" ? [`${T}Set tSC = $$$OK`] : []),
  );
  return out;
}

/** What a filtered-out message leaves behind, per the style. */
function filtered(indent: string, message: string): string[] {
  if (S.filteredOut === "silent") return [];
  const macro = { trace: "$$$TRACE", info: "$$$LOGINFO", warning: "$$$LOGWARNING" }[S.filteredOut];
  return [`${indent}${macro}(${message})`];
}

/** Stamps, then the close of Mapping and of the class. */
function houseTail(spec: Spec): string[] {
  const proc = spec.iris.process!;
  const said = irisComments(spec) !== "off";
  const body = `${T}${T}`;
  const out: string[] = [];
  // ---- stamps ---------------------------------------------------------------
  const stamps = proc.stamp ?? [];
  if (stamps.length > 0) out.push(``);
  for (const s of stamps) {
    if (said) out.push(`${body}//${comment(s.why)}`);
    out.push(`${body}${W(`tRequest.SetValueAt(${os(s.value)},${os(s.path.replace("-", ":"))})`)}`);
  }

  out.push(
    ...(S.mappingTry
      ? [`${T}} catch e {`, `${T}${T}Set tSC = e.AsStatus()`, `${T}}`, `${T}Quit tSC`]
      : [`${T}Quit ${S.writes === "accumulate" ? "tSC" : "$$$OK"}`]),
    `}`,
    ``,
    `Storage Default`,
    `{`,
    `<Type>%Storage.Persistent</Type>`,
    `}`,
    ``,
    `}`,
    ``,
  );
  return out;
}

/**
 * `transform: "build"`: the same house-style class, for an interface whose
 * message changes shape -- DFT to MDM, ORU to MDM -- where cloning the request
 * would start from the wrong structure. Mapping builds a fresh message of the
 * target DocType and fills it; every source, step, repeat, select, fold and
 * seed is written by `emit/inline.ts`, in house style.
 */
export function emitBuild(specIn: Spec, collect?: BareRefs, style: Style = loadStyle()): string {
  const spec = begin(specIn, style);
  const st = newState(spec, collect);
  return finish(houseHead(spec, st), emitInlineMapping(spec, "        ", st.bare, true, style), houseTail(spec));
}
