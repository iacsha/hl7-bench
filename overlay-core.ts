/**
 * overlay-core.ts -- change somebody else's business process without
 * re-authoring it.
 *
 * WHY THIS EXISTS
 *
 * The rest of the bench is spec-first: the spec is the source of truth and the
 * class is generated from it. That is right for an interface you own. It is
 * wrong for the common job of "add one field to the class the last engineer
 * wrote": `import-cls.ts` cannot read most real classes (a clone-and-patch
 * process with a utility-class filter imports as 0 blocks), and `emit.ts`
 * would replace their class with the bench's own shape, so the reviewer sees a
 * rewrite instead of a one-line change.
 *
 * An overlay leaves their class exactly as written and owns ONE region of it:
 *
 *     // >>> hl7-bench changes ...
 *     ...generated from the changes file...
 *     // <<< hl7-bench changes
 *
 * inserted immediately above the line that sends the message. The changes are
 * data (`*.changes.local.json`), written in the same source and step
 * vocabulary as a spec row, and generated through the same `sourceCode` and
 * `stepCode` every other backend uses -- there is still one definition of each
 * kind. Re-applying replaces the region and touches nothing else.
 *
 * WHAT IT REFUSES, AND WHY
 *
 * A class with no send, or more than one, unless `anchor` says which: the
 * insertion point is the whole contract. A path whose segment the DocType does
 * not have: it resolves to nothing in IRIS, silently. And the source kinds that
 * mean nothing outside a spec (`event`, `counter`, `sameAs`, `todo`).
 *
 * PATHS COME FROM THE ENGINE'S SCHEMA, NOT FROM GUESSWORK
 *
 * `DG1-3` on a schema where DG1 repeats must be written `DG1(1):3`; bare, IRIS
 * returns "" and reports nothing. `IN1-4` in 2.3:ADT_A01 lives at
 * `IN1grp(1).IN1:4`. The overlay reads the DocType's structure map (from the
 * engine, or a pasted `zw` dump) and indexes every flat path by it, and the
 * preview says which reads were indexed so nobody is surprised by `(1)`.
 */

import { dtlPath, pathString, newState, sourceCode, stepCode, type Dialect } from "./emit/iris";
import { loadStyle, type Style } from "./style";
import type { Source, Spec, Step } from "./spec";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One field change. Same source and step vocabulary as a spec row. */
export interface Change {
  /** The field written on the outgoing message, e.g. "PV2-3". */
  target: string;
  from: Source;
  via?: Step[];
  /** Why. Printed as a comment above the generated lines. */
  note?: string;
  /**
   * When the source comes out empty. "skip" (the default) leaves the target as
   * it was; "write" writes the empty value, which blanks the target.
   */
  ifEmpty?: "skip" | "write";
  /**
   * Write even when the target segment is absent from the outgoing message,
   * which CREATES that segment. Off by default: a SetValueAt on an absent
   * segment adds it, and a receiver gets a PV2 the sender never sent.
   */
  createSegment?: boolean;
}

/** The changes file. */
export interface Overlay {
  /** The class file the changes apply to, relative to the changes file. */
  base: string;
  /** The DocType the class's messages carry, e.g. "Vendor:ADT_A01". */
  docType: string;
  /** Method holding the send. Default OnRequest. */
  method?: string;
  /**
   * 1-based line number, in the base file, of the send to insert above. Only
   * needed when the method sends more than once.
   */
  anchor?: number;
  changes: Change[];
}

/** What the structure map says about where segments live. */
export interface SchemaMap {
  docType: string;
  /** Every segment id the structure has. */
  segments: Set<string>;
  /** Structural names that repeat: "DG1", "IN1grp", "PR1grp.ROL". */
  repeats: Set<string>;
  /** Segment id to the group path holding it, without occurrences: IN1 -> "IN1grp". */
  groups: Record<string, string>;
}

export const BEGIN = "// >>> hl7-bench changes";
export const END = "// <<< hl7-bench changes";

const ALLOWED: Source["kind"][] = ["copy", "literal", "firstOf", "lookup", "pickRepeat", "fromFirst", "fromWhere"];

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Build a SchemaMap from structure-map keys ("PID", "DG1()", "IN1grp().IN1"),
 * as the engine returns them or as a `zw` dump prints them.
 */
export function schemaFromKeys(docType: string, keys: string[]): SchemaMap {
  const map: SchemaMap = { docType, segments: new Set(), repeats: new Set(), groups: {} };
  for (const key of keys) {
    const parts = key.split(".");
    const names: string[] = [];
    for (const p of parts) {
      const name = p.replace(/\(\)$/, "");
      names.push(name);
      if (p.endsWith("()")) map.repeats.add(names.join("."));
    }
    const seg = names[names.length - 1]!;
    if (!/^[A-Z][A-Z0-9]{2}$/.test(seg)) continue; // leftoversegs() and the like
    map.segments.add(seg);
    if (names.length > 1 && !map.groups[seg]) map.groups[seg] = names.slice(0, -1).join(".");
  }
  return map;
}

/**
 * Keys out of pasted `zw ^EnsHL7.Schema(...,"map")` output. Lines that are not
 * map rows are ignored, so a whole terminal paste works.
 */
export function keysFromZw(text: string): { docType?: string; keys: string[] } {
  const keys: string[] = [];
  let docType: string | undefined;
  const re = /^\^EnsHL7\.Schema\("?([^",]+)"?,"MS","([^"]+)","map","([^"]+)"\)=/;
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line.trim());
    if (!m) continue;
    docType ??= `${m[1]}:${m[2]}`;
    keys.push(m[3]!);
  }
  return { docType, keys };
}

/**
 * A braced path with an occurrence added to every repeating level that has
 * none. `{DG1:3}` becomes `{DG1(1):3}`; `{IN1grp.IN1:4}` becomes
 * `{IN1grp(1).IN1:4}`. Levels already indexed (`DG1(ip1)`, `DG1(*)`) are left.
 */
export function indexBraced(braced: string, schema: SchemaMap, indexed?: Set<string>): string {
  const m = /^\{(.+)\}$/.exec(braced);
  if (!m) return braced;
  const inner = m[1]!;
  const colon = inner.indexOf(":");
  const head = colon === -1 ? inner : inner.slice(0, colon);
  const tail = colon === -1 ? "" : inner.slice(colon);
  const names: string[] = [];
  const out = head.split(".").map((part) => {
    const name = part.replace(/\(.*\)$/, "");
    names.push(name);
    if (part !== name) return part;
    if (schema.repeats.has(names.join("."))) {
      indexed?.add(names.join("."));
      return `${name}(1)`;
    }
    return part;
  });
  return `{${out.join(".")}${tail}}`;
}

// ---------------------------------------------------------------------------
// The class
// ---------------------------------------------------------------------------

export interface Anchor {
  /** 0-based index into the class's lines of the send. */
  line: number;
  /** The send line's own leading whitespace. */
  indent: string;
  /** The variable the method sends. */
  sendVar: string;
  /** The method's first parameter: the message as it arrived. */
  requestVar: string;
  /** Lines between the markers, if the class already carries a region. */
  region?: { begin: number; end: number };
}

/** Where the method's body starts and ends, as 0-based line indexes. */
function methodSpan(lines: string[], method: string): { sig: number; open: number; close: number } | string {
  const sigRe = new RegExp(`^\\s*(?:Class)?Method\\s+${method}\\s*\\(`);
  const sig = lines.findIndex((l) => sigRe.test(l));
  if (sig === -1) return `No method named ${method} in the class.`;
  let depth = 0;
  let open = -1;
  for (let i = sig; i < lines.length; i++) {
    for (const ch of lines[i]!) {
      if (ch === "{") {
        if (depth === 0 && open === -1) open = i;
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0 && open !== -1) return { sig, open, close: i };
      }
    }
  }
  return `${method} has an unclosed body.`;
}

/**
 * Find where the changes go: immediately above the one line in the method that
 * sends. With markers already present, their region is reused.
 */
export function findAnchor(text: string, method = "OnRequest", anchorLine?: number): Anchor | { error: string } {
  const lines = text.split(/\r?\n/);
  const span = methodSpan(lines, method);
  if (typeof span === "string") return { error: span };

  const sigLine = lines[span.sig]!;
  const param = /\(\s*([\w%]+)/.exec(sigLine.slice(sigLine.indexOf(method)));
  const requestVar = param?.[1] ?? "pRequest";

  const sendRe = /\.\.SendRequest(?:Async|Sync)\(\s*[^,]+,\s*([\w%.]+)/;
  const sends: number[] = [];
  for (let i = span.open; i <= span.close; i++) {
    const code = lines[i]!.replace(/\/\/.*$/, "");
    if (sendRe.test(code) && !/^\s*;/.test(lines[i]!)) sends.push(i);
  }
  if (sends.length === 0) {
    return { error: `${method} never calls SendRequestAsync or SendRequestSync, so there is no outgoing message to change.` };
  }
  let at: number;
  if (anchorLine !== undefined) {
    if (!sends.includes(anchorLine - 1)) {
      return { error: `anchor is line ${anchorLine}, which is not a send. Sends are on line(s) ${sends.map((s) => s + 1).join(", ")}.` };
    }
    at = anchorLine - 1;
  } else if (sends.length > 1) {
    return {
      error:
        `${method} sends on ${sends.length} lines (${sends.map((s) => s + 1).join(", ")}). ` +
        `Set "anchor" in the changes file to the line number of the send these changes belong to.`,
    };
  } else {
    at = sends[0]!;
  }

  const sendVar = sendRe.exec(lines[at]!)![1]!;
  const indent = /^\s*/.exec(lines[at]!)![0];

  const begin = lines.findIndex((l) => l.trim().startsWith(BEGIN));
  const end = lines.findIndex((l) => l.trim().startsWith(END));
  const region = begin !== -1 && end > begin ? { begin, end } : undefined;
  return { line: at, indent, sendVar, requestVar, region };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PATH = /^([A-Z][A-Z0-9]{2})-\d+/;

/** Every segment-qualified path a source reads. */
function pathsOf(from: Source): string[] {
  switch (from.kind) {
    case "copy": return [from.path];
    case "firstOf": return from.paths;
    case "lookup": return from.path ? [from.path] : from.from ? pathsOf(from.from as Source) : [];
    case "pickRepeat": return [from.path];
    case "fromFirst": return [from.nonEmpty, from.path];
    case "fromWhere": return [from.where, from.read];
    default: return [];
  }
}

/** Problems that stop generation, one sentence each. */
export function validateOverlay(o: Overlay, schema?: SchemaMap): string[] {
  const problems: string[] = [];
  if (!o.docType || !o.docType.includes(":")) problems.push(`docType must be <category>:<structure>, e.g. Vendor:ADT_A01.`);
  o.changes.forEach((c, n) => {
    const at = `change ${n + 1} (${c.target || "no target"})`;
    if (!PATH.test(c.target ?? "")) problems.push(`${at}: target must be a field path like PV2-3.`);
    if (!ALLOWED.includes(c.from?.kind)) {
      problems.push(`${at}: source "${c.from?.kind}" means nothing outside a spec. Use one of ${ALLOWED.join(", ")}.`);
      return;
    }
    for (const p of pathsOf(c.from)) {
      if (!PATH.test(p)) problems.push(`${at}: "${p}" is not a field path like DG1-3.`);
    }
    if (c.from.kind === "lookup" && !c.from.table) problems.push(`${at}: a lookup needs a table name.`);
    if (!schema) return;
    for (const p of [c.target, ...pathsOf(c.from)]) {
      const seg = PATH.exec(p ?? "")?.[1];
      if (seg && !schema.segments.has(seg)) {
        problems.push(
          `${at}: ${seg} is not in ${schema.docType}. IRIS resolves a path to a segment the structure ` +
            `does not have to nothing, and says nothing. Check the DocType, or the segment id.`,
        );
      }
    }
  });
  return problems;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface Generated {
  /** The lines between and including the markers, already indented. */
  lines: string[];
  /** Plain-language notes about what the generated code does. Not problems. */
  notes: string[];
}

/** Lowest number N >= 900 whose temp names do not already appear in the class. */
function freeTemp(text: string): number {
  for (let n = 900; ; n += 100) {
    if (!new RegExp(`\\b(?:i?[pw]${n}\\d?|hb${n}\\d?)\\b`).test(text)) return n;
  }
}

/** Describe a change in words, for the comment above it and the notes pane. */
export function describe(c: Change): string {
  const f = c.from;
  const src =
    f.kind === "copy" ? f.path
    : f.kind === "literal" ? JSON.stringify(f.value)
    : f.kind === "firstOf" ? `first non-empty of ${f.paths.join(", ")}`
    : f.kind === "fromFirst" ? `${f.path} from the first ${f.segment} whose ${f.nonEmpty} has a value`
    : f.kind === "fromWhere" ? `${f.read} from the ${f.segment} whose ${f.where} is ${JSON.stringify(f.equals)}`
    : f.kind === "lookup" ? `${f.path ?? "key"} looked up in ${f.table}`
    : f.kind === "pickRepeat" ? `${f.path} repetition whose component ${f.whereComponent} is ${JSON.stringify(f.equals)}`
    : f.kind;
  const steps = (c.via ?? []).map((s) => s.kind).join(", ");
  return `${c.target} <- ${src}${steps ? ` (then ${steps})` : ""}`;
}

/**
 * The marked region for a set of changes, written against an anchor.
 *
 * Reads come off the request variable -- the message as it arrived -- never off
 * the message being changed, so a change that reads a field an earlier change
 * wrote still sees the sender's value. Writes go to the variable the class
 * sends.
 */
export function generate(
  o: Overlay,
  anchor: Anchor,
  schema: SchemaMap,
  classText: string,
  style: Style = loadStyle(),
  changesFile = "the changes file",
): Generated {
  const indexed = new Set<string>();
  const req = anchor.requestVar;
  const out = anchor.sendVar;
  const ind = anchor.indent;
  const T = "\t";
  const ix = (braced: string) => indexBraced(braced, schema, indexed);

  const dialect: Dialect = {
    value: (braced) => read(braced),
    code: (braced) => read(braced),
    lookup: (table, key, fallback) => `##class(Ens.Rule.FunctionSet).Lookup(${table},${key},${fallback})`,
    block: (lines) => lines,
  };
  function read(braced: string): string {
    const m = /^(\w+)\.(\{.+\})$/.exec(braced);
    if (!m) throw new Error(`Not a path reference: "${braced}"`);
    const obj = m[1] === "target" ? out : req;
    return `${obj}.GetValueAt(${pathString(ix(m[2]!))})`;
  }

  // A spec only as far as sourceCode needs one: where segments live, and a
  // gate nobody reads (event() is refused before generation).
  const spec = {
    name: "overlay",
    gate: { path: "MSH-9.2", permit: {} },
    iris: { className: "", sourceDocType: o.docType, targetDocType: o.docType, sourceGroups: schema.groups },
    blocks: [],
  } as unknown as Spec;
  const st = newState(spec);
  st.temp = freeTemp(classText);

  const lines: string[] = [];
  const notes: string[] = [];
  lines.push(`${ind}${BEGIN} (${o.changes.length}) from ${changesFile}. Edit there and re-apply; do not edit by hand.`);
  o.changes.forEach((c, n) => {
    const v = `hb${st.temp++}`;
    lines.push(`${ind}//${describe(c)}${c.note ? ` -- ${c.note.replace(/\s+/g, " ")}` : ""}`);
    const { expr, pre } = sourceCode(st, c.from, { sourcePrefix: "", targetPrefix: "" }, dialect);
    let value = expr!;
    for (const step of c.via ?? []) value = stepCode(value, step);

    const seg = PATH.exec(c.target)![1]!;
    const targetPath = pathString(ix(dtlPath(c.target, "", schema.groups)));
    const segPath = pathString(ix(`{${schema.groups[seg] ? `${schema.groups[seg]}.` : ""}${seg}}`));
    const guarded = !c.createSegment && seg !== "MSH";
    const body = guarded ? `${ind}${T}` : ind;

    if (guarded) lines.push(`${ind}If (${out}.GetValueAt(${segPath}) '= "") {`);
    for (const l of pre ?? []) lines.push(body + l.replace(/^( {2})+/, (m) => T.repeat(m.length / 2)));
    lines.push(`${body}Set ${v} = ${value}`);
    // Checked unless the site style says writes are unchecked. Never the
    // "accumulate" form: that names tSC, and the class being changed may call
    // its status anything (tsc, sc, status) -- ObjectScript names are case
    // sensitive, so a guess compiles and writes to a variable nobody reads.
    const call = `${out}.SetValueAt(${v},${targetPath})`;
    const write = style.writes === "unchecked" ? `Do ${call}` : `$$$ThrowOnError(${call})`;
    lines.push(c.ifEmpty === "write" ? `${body}${write}` : `${body}If (${v} '= "") ${write}`);
    if (guarded) lines.push(`${ind}}`);

    notes.push(
      `${n + 1}. ${describe(c)}: ` +
        (c.ifEmpty === "write" ? `an empty source BLANKS ${c.target}; ` : `an empty source leaves ${c.target} as it was; `) +
        (guarded ? `nothing is written when ${seg} is not in the outgoing message.` : `writes even when ${seg} is absent, which creates it.`),
    );
  });
  lines.push(`${ind}${END}`);

  for (const name of indexed) {
    notes.push(`${name} repeats in ${schema.docType}, so flat reads and writes of it use occurrence (1). Use fromFirst or fromWhere to choose a different one.`);
  }
  notes.push(`Reads come from ${req} (the message as it arrived); writes go to ${out} (the message the class sends).`);
  return { lines, notes };
}

/**
 * The class with the region in place: replacing an existing region, or
 * inserted above the send. Everything else is byte-for-byte the base,
 * including its line endings.
 */
export function applyRegion(text: string, anchor: Anchor, region: string[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (anchor.region) {
    lines.splice(anchor.region.begin, anchor.region.end - anchor.region.begin + 1, ...region);
  } else {
    lines.splice(anchor.line, 0, ...region);
  }
  return lines.join(eol);
}

/** One call: validate, anchor, generate, apply. */
export function overlayClass(
  o: Overlay,
  baseText: string,
  schema: SchemaMap,
  opts: { style?: Style; changesFile?: string } = {},
): { text?: string; problems: string[]; notes: string[]; anchor?: Anchor; region?: string[] } {
  const problems = validateOverlay(o, schema);
  const anchor = findAnchor(baseText, o.method ?? "OnRequest", o.anchor);
  if ("error" in anchor) problems.push(anchor.error);
  if (problems.length > 0 || "error" in anchor) return { problems, notes: [] };
  if (o.changes.length === 0) return { text: baseText, problems: [], notes: ["No changes yet. The class is the base, unchanged."], anchor };
  const g = generate(o, anchor, schema, baseText, opts.style, opts.changesFile);
  return { text: applyRegion(baseText, anchor, g.lines), problems: [], notes: g.notes, anchor, region: g.lines };
}

// ---------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------

export type LineDiff = { op: " " | "+" | "-"; text: string }[];

/** A plain LCS line diff. Classes are a few hundred lines; this is fine. */
export function diffLines(a: string[], b: string[]): LineDiff {
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: LineDiff = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: " ", text: a[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ op: "-", text: a[i]! }); i++; }
    else { out.push({ op: "+", text: b[j]! }); j++; }
  }
  while (i < n) out.push({ op: "-", text: a[i++]! });
  while (j < m) out.push({ op: "+", text: b[j++]! });
  return out;
}

export interface FieldChange {
  /** Segment id and its 1-based occurrence among segments with that id. */
  segment: string;
  occurrence: number;
  /** "PV2-3", or "(segment added)" / "(segment removed)". */
  field: string;
  before: string;
  after: string;
}

/**
 * Field by field, what changed between two delivered messages. Segments are
 * paired by id and occurrence, so an added PV2 shows as added rather than
 * shifting every segment after it.
 */
export function diffMessages(before: string[], after: string[]): FieldChange[] {
  const key = (segs: string[]) => {
    const seen = new Map<string, number>();
    return segs.map((s) => {
      const id = s.slice(0, 3);
      const k = (seen.get(id) ?? 0) + 1;
      seen.set(id, k);
      return { id, k, s };
    });
  };
  const a = key(before), b = key(after);
  const bIndex = new Map(b.map((x) => [`${x.id}#${x.k}`, x]));
  const aIndex = new Map(a.map((x) => [`${x.id}#${x.k}`, x]));
  const out: FieldChange[] = [];
  for (const x of a) {
    const y = bIndex.get(`${x.id}#${x.k}`);
    if (!y) { out.push({ segment: x.id, occurrence: x.k, field: "(segment removed)", before: x.s, after: "" }); continue; }
    if (x.s === y.s) continue;
    const fa = x.s.split("|"), fb = y.s.split("|");
    const n = Math.max(fa.length, fb.length);
    // MSH-1 is the field separator itself, so MSH field numbers run one ahead
    // of their split index.
    const offset = x.id === "MSH" ? 1 : 0;
    for (let i = 1; i < n; i++) {
      if ((fa[i] ?? "") !== (fb[i] ?? "")) {
        out.push({ segment: x.id, occurrence: x.k, field: `${x.id}-${i + offset}`, before: fa[i] ?? "", after: fb[i] ?? "" });
      }
    }
  }
  for (const y of b) {
    if (!aIndex.has(`${y.id}#${y.k}`)) out.push({ segment: y.id, occurrence: y.k, field: "(segment added)", before: "", after: y.s });
  }
  return out;
}
