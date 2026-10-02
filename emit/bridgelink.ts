/**
 * emit/bridgelink.ts -- the same spec as a BridgeLink transformer step.
 *
 * Mirth Connect takes the same channel document, so this file serves both. The
 * engine is named after the one we actually run; searching this repo for the
 * other name still lands here, which is the whole reason this paragraph exists.
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * The spec rewrite claimed a second engine would be a new file under `emit/`
 * rather than a second toolkit. Nothing proved that claim until this file did.
 * The output that matters is not one channel: it is the same mapping, authored
 * once, standing next to the ObjectScript answer in the other pane.
 *
 * THE FOUR THINGS THIS FILE CANNOT KNOW
 *
 *   1. The channel's inbound and outbound data types, and whether the HL7 v2.x
 *      listener is set to strict parsing. Everything below assumes the standard
 *      Mirth/BridgeLink HL7 XML shape, where PID-5.1 is <PID.5.1> inside <PID.5>.
 *   2. Whether an outbound template is configured. The last statement handles
 *      both cases and says so out loud.
 *   3. Which JavaScript level the bundled Rhino accepts. This emitter targets
 *      ES5 ONLY -- no let, no arrow functions, no template literals -- because
 *      ES5 runs on every Rhino build and the reverse is not true. If the server
 *      turns out to accept ES6 nothing here breaks; it just stays plain.
 *   4. Whether the receiver wants the structure the blocks describe. Same
 *      caveat the DTL carries, for the same reason.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO
 *
 * It shares no code with `run.ts`. Both are called JavaScript and they are not
 * the same language: `run.ts` runs on bun against `hl7.ts`, and a transformer
 * runs on Rhino against E4X, where a segment is an XMLList and an absent node
 * stringifies to empty rather than throwing. A helper factored out to serve
 * both would have to be correct in two runtimes at once, and the first bug in
 * it would be found by a receiver rather than by a test.
 *
 * The helpers the generated step needs are therefore EMITTED as text, below,
 * in the language they run in.
 */

import { fingerprint } from "../fingerprint";
import { assertRunnable } from "../run";
import {
  emptyTables, parsePath,
  type Spec, type Source, type Step, type Row, type Block,
} from "../spec";

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

/**
 * A JavaScript string literal, single quoted.
 *
 * Single quotes throughout because the emitted code is pasted next to E4X, and
 * E4X markup in a channel is conventionally written with double quotes inside
 * it. Backslash first, or every escape this adds gets escaped again.
 */
export function js(s: string): string {
  return (
    "'" +
    s
      .replace(/\\/g, "\\\\")
      .replace(/'/g, "\\'")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029") +
    "'"
  );
}

/**
 * Free text on a `//` line.
 *
 * A newline in a note would end the comment and turn the rest of the note into
 * code, which fails at parse if you are lucky and runs if you are not.
 */
function comment(s: string): string {
  return s.replace(/[\r\n]+/g, " ").trim();
}

/** A readable local name for a row's value: `PID-5.1` becomes `v_PID_5_1`. */
function varFor(target: string): string {
  return "v_" + target.replace(/[^A-Za-z0-9]/g, "_");
}

/** The local holding a block's target segment node: `segPID`. */
function segVarFor(id: string): string {
  return "seg" + id.replace(/[^A-Za-z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// The emitted runtime
//
// Every function here exists because of one true thing about E4X that would
// otherwise be a silent wrong value. They are emitted rather than imported
// because there is nothing to import them from: this text runs inside a
// channel, on Rhino, alone.
// ---------------------------------------------------------------------------

/** Helpers every generated step needs. */
const CORE_RUNTIME = `
// --- generated helpers: do not hand-edit, regenerate ------------------------

/** The first occurrence of a segment, or null. */
function benchSeg(root, id) {
  var list = root.child(id);
  return list.length() === 0 ? null : list[0];
}

/** Every occurrence of a segment, as an XMLList. */
function benchAll(root, id) {
  return root.child(id);
}

/**
 * One level down, or the node itself when that level was never separated out.
 *
 * THE E4X TRAP THIS EXISTS FOR. A field carrying no component separator has no
 * <PID.3.1> child under it: the value sits in <PID.3> directly. Reading .1 off
 * it the obvious way returns EMPTY, and empty is indistinguishable from a field
 * the sender left blank. Index 1 with no child means the parent's own text IS
 * that first piece. Any other index with no child is genuinely absent.
 */
function benchDown(node, name, index) {
  var kids = node.child(name);
  if (kids.length() > 0) { return kids[0]; }
  return index === 1 ? node : null;
}

/** How many dots are in an element name: PID.5 is 1, PID.5.1 is 2. */
function benchDepth(node) {
  var nm = node.name();
  if (nm === null) { return 0; }
  var s = nm.toString();
  var n = 0;
  for (var i = 0; i < s.length; i++) { if (s.charAt(i) === '.') { n++; } }
  return n;
}

/**
 * The TEXT of a node, with its separators put back.
 *
 * THE SECOND E4X TRAP. toString() on an element with child elements returns
 * MARKUP, not text: reading PID-5 whole would hand you the string
 * "<PID.5.1>SMITH</PID.5.1><PID.5.2>JOHN</PID.5.2>" and write that onto the
 * wire. Only a node with simple content stringifies to what you meant.
 *
 * So flatten by hand, joining with the separator for that level, which is what
 * the bench means by copy("PID-5") on a field that has components.
 */
function benchText(node) {
  if (!node.hasComplexContent()) { return node.toString(); }
  var sep = benchDepth(node) >= 2 ? benchSub : benchComp;
  var parts = [];
  var kids = node.children();
  for (var i = 0; i < kids.length(); i++) { parts.push(benchText(kids[i])); }
  return parts.join(sep);
}

/** Read a path numerically. component/subcomponent 0 mean "not named". */
function benchGet(seg, id, field, rep, comp, sub) {
  if (seg === null) { return ''; }
  var fields = seg.child(id + '.' + field);
  if (fields.length() < rep) { return ''; }
  var node = fields[rep - 1];
  if (comp !== 0) {
    node = benchDown(node, id + '.' + field + '.' + comp, comp);
    if (node === null) { return ''; }
    if (sub !== 0) {
      node = benchDown(node, id + '.' + field + '.' + comp + '.' + sub, sub);
      if (node === null) { return ''; }
    }
  }
  return benchText(node);
}

/** How many times a field repeats on this segment. */
function benchRepeats(seg, id, field) {
  if (seg === null) { return 0; }
  return seg.child(id + '.' + field).length();
}

/** The trailing number of an element name: 5 from "PID.5", 1 from "PID.5.1". */
function benchOrd(name) {
  var dot = name.lastIndexOf('.');
  var n = parseInt(name.substring(dot + 1), 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Add one child, in numeric order.
 *
 * Appending in assignment order would put PID.5 ahead of PID.3 whenever the
 * spec lists them that way, and a serializer that writes children in document
 * order then produces a segment with its fields transposed. Ordering here costs
 * nothing and is correct whichever way the serializer works.
 */
function benchInsert(parent, name) {
  // A node holding loose text cannot also hold numbered children: the text
  // would serialize alongside them. Reachable only when one spec assigns both
  // a field and one of that field's components.
  if (parent.hasSimpleContent() && parent.toString() !== '') {
    parent.setChildren(new XMLList());
  }
  var mine = benchOrd(name);
  var kids = parent.children();
  for (var i = 0; i < kids.length(); i++) {
    var nm = kids[i].name();
    if (nm === null) { continue; }
    if (benchOrd(nm.toString()) > mine) {
      parent.insertChildBefore(kids[i], new XML('<' + name + '/>'));
      return;
    }
  }
  parent.appendChild(new XML('<' + name + '/>'));
}

/** The index'th child of this name, creating what is missing. */
function benchAt(parent, name, index) {
  var kids = parent.child(name);
  while (kids.length() < index) {
    benchInsert(parent, name);
    kids = parent.child(name);
  }
  return kids[index - 1];
}

/** Write a path numerically. Creates every level it needs. */
function benchSet(seg, id, field, rep, comp, sub, value) {
  var node = benchAt(seg, id + '.' + field, rep);
  if (comp !== 0) {
    node = benchAt(node, id + '.' + field + '.' + comp, 1);
    if (sub !== 0) {
      node = benchAt(node, id + '.' + field + '.' + comp + '.' + sub, 1);
    }
  }
  node.setChildren(value);
}

/**
 * The inbound delimiters, as one string in MSH-1 then MSH-2 order.
 *
 * Read rather than assumed. A sender using a non-standard component separator
 * is rare and it is not hypothetical, and a hard-coded '^' would then strip the
 * wrong character and join fields with a character the receiver reads as text.
 */
function benchDelimiters(root) {
  var m = benchSeg(root, 'MSH');
  if (m === null) { return '|^~\\\\&'; }
  var f = m.child('MSH.1').toString();
  var e = m.child('MSH.2').toString();
  if (f === '') { f = '|'; }
  if (e === '') { e = '^~\\\\&'; }
  return f + e;
}

/**
 * A fresh target segment, appended to the outbound message.
 *
 * MSH is special: MSH-1 IS the field separator and has no slot of its own, and
 * MSH-2 defines the rest. Building MSH like every other segment produces a
 * header that parses back wrong.
 */
function benchNewSeg(root, id, delims) {
  root.appendChild(new XML('<' + id + '/>'));
  var kids = root.child(id);
  var seg = kids[kids.length() - 1];
  if (id === 'MSH') {
    benchSet(seg, 'MSH', 1, 1, 0, 0, delims.charAt(0));
    benchSet(seg, 'MSH', 2, 1, 0, 0, delims.substring(1));
  }
  return seg;
}
`.trimEnd();

const FIRST_RUNTIME = `
/** The first non-empty argument. Every argument is evaluated; reads are pure. */
function benchFirst() {
  for (var i = 0; i < arguments.length; i++) {
    if (arguments[i] !== '') { return arguments[i]; }
  }
  return '';
}
`.trimEnd();

const LOOKUP_RUNTIME = `
/** Is this code in the table at all. Asked separately from what it maps to. */
function benchHas(table, key) {
  var t = benchTables[table];
  return t !== undefined && Object.prototype.hasOwnProperty.call(t, key);
}

/**
 * Table translation with an explicit unmapped branch.
 *
 * The empty check is first and is not a convenience: sending the unmapped
 * default for a field the sender simply did not populate INVENTS a value, and
 * it invents it on every message rather than on the interesting ones.
 */
function benchLookup(table, key, fallback) {
  if (key === '') { return ''; }
  return benchHas(table, key) ? benchTables[table][key] : fallback;
}
`.trimEnd();

const STRIP_RUNTIME = `
/** Remove every character that appears in chars. */
function benchStrip(v, chars) {
  var out = '';
  for (var i = 0; i < v.length; i++) {
    if (chars.indexOf(v.charAt(i)) === -1) { out += v.charAt(i); }
  }
  return out;
}
`.trimEnd();

const DEFAULT_RUNTIME = `
/** Substitute when empty. Empty, not falsy: '0' is a value. */
function benchDefault(v, d) {
  return v === '' ? d : v;
}
`.trimEnd();

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

interface Scope {
  /** Source segment id being walked, when inside a repeat. */
  repeatOver?: string;
  /** Local holding the current source occurrence, when inside a repeat. */
  sourceVar?: string;
  /** Local holding the target segment being filled. */
  targetVar: string;
  /** Local holding the OUTPUT ordinal, when inside a repeat. */
  counterVar?: string;
}

interface State {
  spec: Spec;
  temp: number;
}

function level(spec: Spec): "off" | "warn" | "trace" {
  return spec.bridgelink?.log ?? "warn";
}

/**
 * A read, honouring repeat scope.
 *
 * Inside a repeat, a path naming the repeated segment reads the CURRENT
 * occurrence and anything else falls through to the message. Same rule as
 * `readPath` in `run.ts`, and without it coverage two and three would silently
 * be copies of coverage one.
 */
function readExpr(path: string, scope: Scope): string {
  const p = parsePath(path);
  const seg =
    scope.sourceVar && scope.repeatOver === p.segment
      ? scope.sourceVar
      : `benchSeg(msg, ${js(p.segment)})`;
  return (
    `benchGet(${seg}, ${js(p.segment)}, ${p.field}, ${p.repeat}, ` +
    `${p.component}, ${p.subcomponent})`
  );
}

/**
 * One source as an expression, plus any statements that have to run above it.
 *
 * `pre` is where the kinds that need a loop go. Keeping them as statements
 * rather than folding them into an expression is what makes the emitted step
 * look like a channel somebody wrote by hand.
 */
function sourceCode(
  st: State,
  from: Source,
  scope: Scope,
): { expr: string | null; pre?: string[] } {
  switch (from.kind) {
    case "copy":
      return { expr: readExpr(from.path, scope) };

    case "literal":
      return { expr: js(from.value) };

    case "firstOf":
      return { expr: `benchFirst(${from.paths.map((p) => readExpr(p, scope)).join(", ")})` };

    case "lookup": {
      // The key is read into a local rather than read twice. `passthrough`
      // makes the fallback the key itself, so the obvious inline form would
      // walk the message a second time for the same value.
      const k = `key${st.temp++}`;
      const pre = [`var ${k} = ${readExpr(from.path, scope)};`];
      if (level(st.spec) !== "off") {
        // Asked as "is it in the table", not as "did the lookup come back
        // empty". With `passthrough` and `constant` the fallback IS a real
        // value, so a miss and a hit are indistinguishable by result.
        const where = from.path === scope.targetVar ? from.path : from.path;
        const head = js(`${from.table} has no row for "`);
        const tail = js(`" (from ${where})`);
        pre.push(
          `if (${k} !== '' && !benchHas(${js(from.table)}, ${k})) { ` +
            `logger.warn(${head} + ${k} + ${tail}); }`,
        );
      }
      const fallback =
        from.unmapped.kind === "blank" ? `''`
        : from.unmapped.kind === "passthrough" ? k
        : js(from.unmapped.value);
      return { expr: `benchLookup(${js(from.table)}, ${k}, ${fallback})`, pre };
    }

    case "counter":
      if (!scope.counterVar) throw new Error("counter() used outside a repeat");
      return { expr: `String(${scope.counterVar})` };

    case "event":
      return { expr: "benchEvent" };

    case "pickRepeat": {
      // Position-based reads of doctor fields are the most common quiet bug in
      // this work: the same doctor arrives twice, once qualified and once not,
      // and which comes first is not stable across sites. So scan.
      const p = parsePath(from.path);
      const v = `pick${st.temp++}`;
      const sv = `${v}Seg`;
      const nv = `${v}Count`;
      const iv = `${v}i`;
      const segExpr =
        scope.sourceVar && scope.repeatOver === p.segment
          ? scope.sourceVar
          : `benchSeg(msg, ${js(p.segment)})`;
      const at = (comp: number) =>
        `benchGet(${sv}, ${js(p.segment)}, ${p.field}, ${iv}, ${comp}, 0)`;
      const take =
        from.take === "whole" ? at(0)
        : Array.isArray(from.take)
          // Joined back together rather than written as one row per component:
          // four rows would put a bare "^^^" on the wire when nothing matches.
          ? from.take.map((c) => at(c)).join(" + benchComp + ")
          : at(from.take);
      return {
        expr: v,
        pre: [
          `var ${v} = '';`,
          `var ${sv} = ${segExpr};`,
          `var ${nv} = benchRepeats(${sv}, ${js(p.segment)}, ${p.field});`,
          `for (var ${iv} = 1; ${iv} <= ${nv}; ${iv}++) {`,
          `  if (${at(from.whereComponent)} === ${js(from.equals)}) {`,
          `    ${v} = ${take};`,
          `    break;`,
          `  }`,
          `}`,
        ],
      };
    }

    case "fromFirst": {
      // Reads the MESSAGE, never the enclosing repeat: "the first NK1 that has
      // a name in it" is a question about the whole message by definition.
      const v = `first${st.temp++}`;
      const lv = `${v}List`;
      const iv = `${v}i`;
      const nv = `${v}Seg`;
      const ne = parsePath(from.nonEmpty);
      const pp = parsePath(from.path);
      const read = (p: ReturnType<typeof parsePath>) =>
        `benchGet(${nv}, ${js(p.segment)}, ${p.field}, ${p.repeat}, ` +
        `${p.component}, ${p.subcomponent})`;
      return {
        expr: v,
        pre: [
          `var ${v} = '';`,
          `var ${lv} = benchAll(msg, ${js(from.segment)});`,
          `for (var ${iv} = 0; ${iv} < ${lv}.length(); ${iv}++) {`,
          `  var ${nv} = ${lv}[${iv}];`,
          `  if (${read(ne)} !== '') {`,
          `    ${v} = ${read(pp)};`,
          `    break;`,
          `  }`,
          `}`,
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
      return `(${expr}).substring(0, 8)`;
    case "truncate":
      return `(${expr}).substring(0, ${step.n})`;
    case "upper":
      return `(${expr}).toUpperCase()`;
    case "stripDelims":
      // The five HL7 delimiters, read off this message's own MSH. A value
      // carrying one of them splits the field it lands in.
      return `benchStrip(${expr}, benchDelims)`;
    case "stripChars":
      return `benchStrip(${expr}, ${js(step.chars)})`;
    case "defaultTo":
      return `benchDefault(${expr}, ${js(step.value)})`;
  }
}

// ---------------------------------------------------------------------------
// Rows and blocks
// ---------------------------------------------------------------------------

function emitRow(st: State, row: Row, scope: Scope, indent: string, out: string[]): void {
  if (row.note) out.push(`${indent}// ${comment(row.note)}`);

  if (row.from.kind === "todo") {
    out.push(
      `${indent}// TODO ${comment(row.target)}: ${comment(row.from.why)}`,
      `${indent}//      Write this assignment by hand. The generator will not guess it.`,
    );
    return;
  }

  const { expr, pre } = sourceCode(st, row.from, scope);
  for (const line of pre ?? []) out.push(indent + line);

  let value = expr!;
  for (const step of row.via ?? []) value = stepCode(value, step);

  // Into a local first, always. The two things worth logging are both about
  // the value AFTER its steps ran, and reading the target back out of E4X to
  // ask would be a second, differently-shaped read of the thing we just wrote.
  const v = varFor(row.target);
  const p = parsePath(row.target);
  out.push(`${indent}var ${v} = ${value};`);
  out.push(
    `${indent}benchSet(${scope.targetVar}, ${js(p.segment)}, ${p.field}, ` +
      `${p.repeat}, ${p.component}, ${p.subcomponent}, ${v});`,
  );

  const lvl = level(st.spec);
  const label = row.label ?? row.target;

  // A required target that came out empty. Checked on the value rather than on
  // the source, so it catches a source that was populated and a step that
  // emptied it.
  if (lvl !== "off" && row.required) {
    const named = label === row.target ? row.target : `${row.target} (${label})`;
    out.push(
      `${indent}if (${v} === '') { logger.warn(${js(`${named} is required and came out empty`)}); }`,
    );
  }

  // A trace carries the VALUE, which is message content. Not a new exposure --
  // the channel already logs the whole message either side of this step when
  // message storage is on -- but it is the reason this is not the default.
  if (lvl === "trace") {
    out.push(`${indent}logger.info(${js(`${row.target} = `)} + ${v});`);
  }
}

function emitBlock(st: State, block: Block, out: string[]): void {
  out.push("");
  if (block.note) out.push(`// ${comment(block.note)}`);
  if (block.group) {
    // Groups are an IRIS schema concept. There is no group in the Mirth HL7
    // XML: segments are siblings under the message root. Said here rather than
    // dropped silently, because the DTL for this same block DOES address the
    // group and the two files would otherwise look like they disagree.
    out.push(
      `// group "${comment(block.group)}" applies to the DTL only. The HL7 XML here has`,
      `// no groups, so the segment is written as a sibling like every other one.`,
    );
  }

  const targetVar = segVarFor(block.id);
  out.push(`var ${targetVar} = benchNewSeg(out, ${js(block.id)}, benchDelims);`);
  const scope: Scope = { targetVar };
  for (const row of block.rows) emitRow(st, row, scope, "", out);
}

function emitRepeat(st: State, block: Block, index: number, out: string[]): void {
  const r = block.repeat!;
  const k = `k${index + 1}`;
  const n = `n${index + 1}`;
  const cur = `cur${index + 1}`;
  const list = `src${index + 1}`;
  const targetVar = segVarFor(block.id);

  out.push("");
  if (block.note) out.push(`// ${comment(block.note)}`);
  out.push(
    `// ${comment(block.id)}: numbered by OUTPUT ordinal (${n}), not by source repeat (${k}).`,
    `//      A skipped occurrence must not leave a hole in the set ids.`,
    `var ${n} = 0;`,
    `var ${list} = benchAll(msg, ${js(r.over)});`,
    `for (var ${k} = 0; ${k} < ${list}.length(); ${k}++) {`,
    `  var ${cur} = ${list}[${k}];`,
  );

  const scope: Scope = {
    repeatOver: r.over,
    sourceVar: cur,
    targetVar,
    counterVar: n,
  };

  const guards: string[] = [];
  if (r.skipWhenEmpty) {
    const p = parsePath(r.skipWhenEmpty);
    guards.push(
      `benchGet(${cur}, ${js(p.segment)}, ${p.field}, ${p.repeat}, ` +
        `${p.component}, ${p.subcomponent}) !== ''`,
    );
  }
  // Counted on the OUTPUT, so occurrences past the cap are dropped after the
  // skip rule has run, which is the order the runner uses.
  if (r.max !== undefined) guards.push(`${n} < ${r.max}`);

  const body: string[] = [];
  const bodyIndent = guards.length ? "    " : "  ";
  body.push(`${bodyIndent}${n} = ${n} + 1;`);
  body.push(`${bodyIndent}var ${targetVar} = benchNewSeg(out, ${js(block.id)}, benchDelims);`);
  for (const row of block.rows) emitRow(st, row, scope, bodyIndent, body);

  if (guards.length) {
    out.push(`  if (${guards.join(" && ")}) {`, ...body, `  }`);
  } else {
    out.push(...body);
  }

  out.push(`}`);
}

// ---------------------------------------------------------------------------
// The channel's half of the job
// ---------------------------------------------------------------------------

/** A path as plain E4X, for code that runs without the helpers above. */
function e4x(path: string): string {
  const p = parsePath(path);
  let s = `msg[${js(p.segment)}][${js(`${p.segment}.${p.field}`)}]`;
  if (p.component !== 0) s += `[${js(`${p.segment}.${p.field}.${p.component}`)}]`;
  if (p.subcomponent !== 0) {
    s += `[${js(`${p.segment}.${p.field}.${p.component}.${p.subcomponent}`)}]`;
  }
  return `${s}.toString()`;
}

/**
 * The SOURCE FILTER this step expects in front of it.
 *
 * The gate belongs in the filter, not the transformer: a message this interface
 * does not handle should never be transformed at all, rather than transformed
 * into something else. Same decision as the IRIS routing rule, printed here for
 * the same reason -- it is a step you would otherwise forget.
 *
 * Written as plain E4X because a filter script does not have the helpers this
 * emitter puts at the top of the transformer. That is safe for a gate on a
 * component of MSH-9, which always arrives with its separators; it is the one
 * place in the generated channel where the component trap is not handled for
 * you, so gate on something structured.
 */
export function filterCondition(spec: Spec): string {
  if (spec.gate.enabled === false) {
    return `// gate declared upstream: ${comment(spec.gate.upstream ?? "WHERE? gate.upstream is empty")}`;
  }
  const events = Object.keys(spec.gate.permit)
    .map((t) => `${e4x(spec.gate.path)} === ${js(t)}`)
    .join(" || ");
  // A filter script has no lookup tables and none of the step's helpers, so a
  // membership gate carries its keys inline. Key presence, as Exists tests it.
  const required = (spec.gate.require ?? []).map((r) => {
    if (r.inTable === undefined) return `${e4x(r.path)} === ${js(r.equals)}`;
    const keys = Object.keys(spec.tables?.[r.inTable] ?? {}).map((k) => `${js(k)}: 1`).join(", ");
    return `({${keys}}).hasOwnProperty(${e4x(r.path)})`;
  });
  // Parenthesised because || binds looser than && and a filter that reads
  // A && B || C lets C through on its own.
  return required.length === 0
    ? `return ${events};`
    : `return ${required.join(" && ")} && (${events});`;
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

/** Every kind used anywhere in the spec, so the runtime carries no dead code. */
function kindsUsed(spec: Spec): { sources: Set<string>; steps: Set<string> } {
  const sources = new Set<string>();
  const steps = new Set<string>();
  for (const block of spec.blocks) {
    for (const row of block.rows) {
      sources.add(row.from.kind);
      for (const s of row.via ?? []) steps.add(s.kind);
    }
  }
  return { sources, steps };
}

/** Every table a `lookup()` row actually reads, in first-seen order. */
function referencedTables(spec: Spec): string[] {
  const seen: string[] = [];
  for (const block of spec.blocks) {
    for (const row of block.rows) {
      if (row.from.kind === "lookup" && !seen.includes(row.from.table)) seen.push(row.from.table);
    }
  }
  return seen;
}

/** The lookup tables as a literal, in the shape `benchLookup` reads. */
function tablesLiteral(spec: Spec, tables: string[]): string[] {
  const out: string[] = [
    `// Lookup tables, inlined. The IRIS side imports these into`,
    `// Ens.Util.LookupTable; here they are data in the step, which means a table`,
    `// change is a redeploy of the channel rather than an edit in a portal. That`,
    `// is the trade, and it is why the "tables" artifact will hoist them into a`,
    `// code template once it exists.`,
    `var benchTables = {`,
  ];
  tables.forEach((name, i) => {
    const rows = spec.tables?.[name] ?? {};
    const keys = Object.keys(rows);
    const comma = i === tables.length - 1 ? "" : ",";
    if (keys.length === 0) {
      out.push(`  ${js(name)}: {}${comma}   // EMPTY: every lookup takes the unmapped branch`);
      return;
    }
    out.push(`  ${js(name)}: {`);
    keys.forEach((k, j) => {
      out.push(`    ${js(k)}: ${js(rows[k])}${j === keys.length - 1 ? "" : ","}`);
    });
    out.push(`  }${comma}`);
  });
  out.push(`};`);
  return out;
}

/** The whole transformer step, ready to paste into the channel. */
export function emitBridgelink(spec: Spec): string {
  assertRunnable(spec, "bridgelink");

  const bl = spec.bridgelink!;
  const st: State = { spec, temp: 1 };
  const used = kindsUsed(spec);
  const tables = referencedTables(spec);
  const empties = emptyTables(spec).filter((t) => tables.includes(t));
  const lvl = level(spec);

  const out: string[] = [
    `// ${comment(spec.description ?? spec.name)}`,
    `//`,
    `// GENERATED by hl7-bench from a spec proven on the bench.`,
    `// Channel: ${comment(bl.channelName)}`,
    ...(bl.note ? [`// ${comment(bl.note)}`] : []),
    `// Spec fingerprint: ${fingerprint(spec)}`,
    `//   Compare it with what "bun emit.ts bridgelink" prints. Same string, same`,
    `//   mapping. Different, and the deployed channel is an older revision than`,
    `//   the one you are reading. It describes the SPEC: hand-edit this step and`,
    `//   it becomes a lie.`,
    `//`,
    `// ES5 ONLY, on purpose. No let, no arrow functions, no template literals.`,
    `//   The JavaScript level is fixed by the Rhino build the vendor bundles, not`,
    `//   by the JDK the server runs on. ES5 runs on every Rhino; the reverse is`,
    `//   not true, and the cost of being wrong the other way is a channel that`,
    `//   fails to deploy at 2am.`,
    `//`,
    `// Before you trust it, three things it could not check for you:`,
    `//   1. The channel's inbound and outbound data types. This assumes HL7 v2.x`,
    `//      parsed to the standard Mirth/BridgeLink XML, where PID-5.1 arrives as`,
    `//      <PID.5.1> inside <PID.5>.`,
    `//   2. Whether an outbound template is configured. The last statement in`,
    `//      this step handles both, and says which it took.`,
    `//   3. That the receiver wants the segments in the order the blocks below`,
    `//      deliver them.`,
    `//`,
    ...(spec.gate.enabled === false
      ? [
          `// Gating is NOT this step's job, by decision. It lives here:`,
          `//   ${comment(spec.gate.upstream ?? "WHERE? gate.upstream is empty")}`,
          `//   This step transforms whatever reaches it. A trigger that`,
          `//   gate.permit does not list is delivered UNCHANGED, not blanked.`,
        ]
      : [
          `// Source filter this step expects in front of it:`,
          `//   ${filterCondition(spec)}`,
        ]),
  ];

  if (tables.length > 0) {
    out.push(`//`, `// Lookup tables this step reads:`);
    for (const t of tables) {
      out.push(`//   ${t}${empties.includes(t) ? "   *** EMPTY IN THE SPEC, a go-live gate ***" : ""}`);
    }
  }
  if (spec.outOfScope?.length) {
    out.push(`//`, `// Out of scope, decided rather than overlooked:`);
    for (const s of spec.outOfScope) out.push(`//   ${comment(s)}`);
  }
  if (lvl !== "off") {
    out.push(
      `//`,
      `// Run-time logging: ${lvl}.`,
      lvl === "warn"
        ? `//   logger.warn on an unmapped lookup code and on an empty required field.`
        : `//   logger.warn as above, plus logger.info per assigned field.`,
      `//   A sender that routinely emits an unmapped code writes one line PER`,
      `//   MESSAGE until the table is fixed. Set bridgelink.log to "off" in the`,
      `//   spec if that is not what you want.`,
    );
  }

  out.push(CORE_RUNTIME);
  if (used.sources.has("firstOf")) out.push(FIRST_RUNTIME);
  if (used.sources.has("lookup")) out.push(LOOKUP_RUNTIME);
  if (used.steps.has("stripDelims") || used.steps.has("stripChars")) out.push(STRIP_RUNTIME);
  if (used.steps.has("defaultTo")) out.push(DEFAULT_RUNTIME);

  out.push("");
  if (tables.length > 0) out.push(...tablesLiteral(spec, tables));

  out.push(
    ``,
    `// Delimiters in MSH-1 then MSH-2 order: field, component, repeat, escape,`,
    `// subcomponent. Read off this message rather than assumed, because a sender`,
    `// using a non-standard component separator is rare and is not hypothetical.`,
    `var benchDelims = benchDelimiters(msg);`,
    `var benchComp = benchDelims.charAt(1);`,
    `var benchSub = benchDelims.charAt(4);`,
  );

  if (used.sources.has("event")) {
    // The gate lives in the source filter, but the target event still has to be
    // stamped. One chain here keeps the step correct for every trigger the
    // filter lets through, and empty for anything it should not have.
    const p = parsePath(spec.gate.path);
    const unlisted =
      spec.gate.enabled === false
        ? "benchTrigger"
        : `''`;
    out.push(
      ``,
      `// The target trigger event. The unlisted branch has to say the same thing`,
      `// the bench says, or the two disagree on exactly the message nobody tested.`,
      `var benchTrigger = benchGet(benchSeg(msg, ${js(p.segment)}), ${js(p.segment)}, ` +
        `${p.field}, ${p.repeat}, ${p.component}, ${p.subcomponent});`,
      `var benchEvent = ${unlisted};`,
    );
    for (const [trigger, event] of Object.entries(spec.gate.permit)) {
      out.push(`if (benchTrigger === ${js(trigger)}) { benchEvent = ${js(event)}; }`);
    }
  }

  out.push(
    ``,
    `// The outbound message, built fresh. This is what create='new' means on the`,
    `// IRIS side: block order below IS the delivered segment order, and anything`,
    `// the sender sent that no block names is gone on purpose.`,
    `var out = new XML('<HL7Message/>');`,
  );

  let repeatIndex = 0;
  for (const block of spec.blocks) {
    if (block.repeat) emitRepeat(st, block, repeatIndex++, out);
    else emitBlock(st, block, out);
  }

  out.push(
    ``,
    `// Hand the built message back.`,
    `//`,
    `// With an outbound template configured, "tmp" is the outbound message and`,
    `// "msg" is not. Without one, the channel serializes "msg". Rather than`,
    `// require a template that this step does not otherwise need, write whichever`,
    `// one this channel actually has. Replacing children rather than the root`,
    `// keeps the <HL7Message> wrapper the serializer expects.`,
    `if (typeof tmp !== 'undefined' && tmp !== null) {`,
    `  tmp.setChildren(out.children());`,
    `} else {`,
    `  msg.setChildren(out.children());`,
    `}`,
    ``,
  );

  return out.join("\n");
}
