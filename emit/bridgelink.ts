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
  emptyTables, parsePath, seedGuarded, describeSelect, describeFold,
  type Spec, type Source, type Step, type Row, type Block, type Select,
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
 * THE E4X TRAP THIS EXISTS FOR. A one-piece field can arrive either way: as
 * <PID.8><PID.8.1>F</PID.8.1></PID.8>, which is what the BridgeLink 26.9.0
 * non-strict parser produced for every field when measured (2026-10-24), or as
 * <PID.8>F</PID.8> with no child, which a segment this step built or seeded can
 * hold. Reading .1 off the second the obvious way returns EMPTY, and empty is
 * indistinguishable from a field the sender left blank. Index 1 with no child
 * means the parent's own text IS that first piece. Any other index with no
 * child is genuinely absent.
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
  // would serialize alongside them. The text IS the first piece -- the same
  // trap benchDown reads around -- so it moves into .1 rather than vanishing.
  // Reachable whenever a seeded segment carries "SMITH" in PID-5 and a row
  // writes PID-5.2: clearing it would deliver "^JOHN".
  if (parent.hasSimpleContent() && parent.toString() !== '') {
    var text = parent.toString();
    var first = name.substring(0, name.lastIndexOf('.')) + '.1';
    parent.setChildren(new XMLList());
    parent.appendChild(new XML('<' + first + '/>'));
    parent.child(first)[0].setChildren(text);
    if (name === first) { return; }
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

/**
 * Put a value into a node, split the way the parser would have split it.
 *
 * A value carrying separators -- TXA-22 written whole from sameAs("TXA-5") as
 * "1234^N^M" -- written as one text node is a field with ONE component as far
 * as E4X is concerned. The next write to TXA-22.19 then counts from that one
 * node and lands two places to the right of where the bench puts it. Measured
 * on BridgeLink 26.9.0. Splitting at write time gives the shape the inbound
 * parser produces, so every later read and write counts the same way.
 */
function benchFill(node, base, value, sep, next) {
  if (sep === '' || value.indexOf(sep) === -1) { node.setChildren(value); return; }
  node.setChildren(new XMLList());
  var parts = value.split(sep);
  for (var i = 0; i < parts.length; i++) {
    var name = base + '.' + (i + 1);
    node.appendChild(new XML('<' + name + '/>'));
    var kid = node.child(name)[0];
    if (next !== '' && parts[i].indexOf(next) !== -1) {
      benchFill(kid, name, parts[i], next, '');
    } else {
      kid.setChildren(parts[i]);
    }
  }
}

/** Write a path numerically. Creates every level it needs. */
function benchSet(seg, id, field, rep, comp, sub, value) {
  var base = id + '.' + field;
  var node = benchAt(seg, base, rep);
  // MSH-1 and MSH-2 ARE the separators, so they are never split on them.
  if (id === 'MSH' && field <= 2) { node.setChildren(value); return; }
  if (comp === 0) { benchFill(node, base, value, benchComp, benchSub); return; }
  base = base + '.' + comp;
  node = benchAt(node, base, 1);
  if (sub === 0) { benchFill(node, base, value, benchSub, ''); return; }
  node = benchAt(node, base + '.' + sub, 1);
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

const SEED_RUNTIME = `
/**
 * A target segment seeded from a source segment, whole, appended to the
 * outbound message. A deep copy: the rows overwrite fields on top of it, and
 * writing into the source node itself would change what later reads see.
 */
function benchSeed(root, src) {
  var copy = src.copy();
  root.appendChild(copy);
  var kids = root.child(copy.localName());
  return kids[kids.length() - 1];
}
`.trimEnd();

const RANK_RUNTIME = `
/**
 * Order two values the way the bench does: empty lowest, numeric when BOTH
 * are digits only, text otherwise. Digits only on purpose -- Number() also
 * accepts "02", " 2" and "0x10", and the bench and the IRIS side agree with it
 * on none of them.
 */
function benchRank(a, b) {
  if (a === b) { return 0; }
  if (a === '') { return -1; }
  if (b === '') { return 1; }
  if (/^\\d+$/.test(a) && /^\\d+$/.test(b)) { return parseInt(a, 10) - parseInt(b, 10); }
  return a < b ? -1 : 1;
}
`.trimEnd();

const SAMEAS_RUNTIME = `
/** Every target an earlier row wrote, by target path, as written. */
var benchW = {};

/**
 * What an earlier row made of a target. Written whole, that value; written as
 * components, the components put back together in position, empties included,
 * so TXA-5.1/.2/.3 reads back as the composite TXA-5 now holds.
 */
function benchSameAs(target) {
  if (Object.prototype.hasOwnProperty.call(benchW, target)) { return benchW[target]; }
  var parts = [];
  var top = 0;
  for (var k in benchW) {
    if (!Object.prototype.hasOwnProperty.call(benchW, k)) { continue; }
    if (k.indexOf(target + '.') !== 0) { continue; }
    var rest = k.substring(target.length + 1);
    if (!/^\\d+$/.test(rest)) { continue; }
    var n = parseInt(rest, 10);
    parts[n - 1] = benchW[k];
    if (n > top) { top = n; }
  }
  if (top === 0) { return ''; }
  var out = [];
  for (var i = 0; i < top; i++) { out.push(parts[i] === undefined ? '' : parts[i]); }
  return out.join(benchComp);
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
  /** Local holding this segment's OUTPUT ordinal, what counter() reads. */
  counterVar?: string;
}

interface State {
  spec: Spec;
  temp: number;
  /** A sameAs() row reads back what earlier rows wrote, so every row records it. */
  record: boolean;
  /** Some block continues numbering, so every block reports its count. */
  counts: boolean;
  /** Plain blocks emitted so far: names their locals apart from the temps. */
  blocks: number;
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
      //
      // `from` supersedes `path` when the key needs finding first (the NK1
      // whose NK1-1 is 2). Every KeySource kind is also a Source kind, so it
      // goes through this same function, one level deep by the spec's rule.
      const k = `key${st.temp++}`;
      const key = from.from
        ? sourceCode(st, from.from, scope)
        : { expr: readExpr(from.path!, scope), pre: [] as string[] };
      const pre = [...(key.pre ?? []), `var ${k} = ${key.expr};`];
      if (level(st.spec) !== "off") {
        // Asked as "is it in the table", not as "did the lookup come back
        // empty". With `passthrough` and `constant` the fallback IS a real
        // value, so a miss and a hit are indistinguishable by result.
        const where = from.path ?? from.from!.kind;
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

    case "fromWhere": {
      // The sibling of fromFirst for "the NK1 whose NK1-1 is 2": first match
      // wins, and none found is empty. Reads the message, never the repeat.
      const v = `where${st.temp++}`;
      const lv = `${v}List`;
      const iv = `${v}i`;
      const nv = `${v}Seg`;
      const wp = parsePath(from.where);
      const rp = parsePath(from.read);
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
          `  if (${read(wp)} === ${js(from.equals)}) {`,
          `    ${v} = ${read(rp)};`,
          `    break;`,
          `  }`,
          `}`,
        ],
      };
    }

    case "sameAs":
      // Read back from benchW, which every row writes into after its steps
      // ran. Not from the target XML: reading E4X back is a second,
      // differently-shaped read of the thing just written.
      return { expr: `benchSameAs(${js(from.target)})` };

    case "todo":
      return { expr: null };

    default: {
      // No tsc gates this repo, so an unhandled kind is caught here at emit
      // time rather than as `undefined` in a channel.
      const kind: never = from;
      throw new Error(`emit/bridgelink.ts has no case for source kind "${(kind as Source).kind}"`);
    }
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
    case "prefix":
      // Verbatim, delimiter included. A "^" here is a component separator only
      // because the message declares "^"; the spec type says so, and so does
      // the bench, which writes the same text.
      return `${js(step.text)} + (${expr})`;
    default: {
      const kind: never = step;
      throw new Error(`emit/bridgelink.ts has no case for step kind "${(kind as Step).kind}"`);
    }
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
  if (st.record) out.push(`${indent}benchW[${js(row.target)}] = ${v};`);

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

/**
 * Where a block's output ordinals start. Zero, or the count the nearest
 * earlier block with this id reached, read at run time because a repeat
 * delivers a different number of segments for every message.
 */
function startExpr(st: State, block: Block): string {
  if (!block.continuesNumbering) return "0";
  return `(benchCount[${js(block.id)}] || 0)`;
}

/**
 * The statement that opens the target segment: a copy of the source when the
 * block seeds, an empty segment otherwise.
 */
function openSegment(block: Block, targetVar: string, seedFrom: string | null): string {
  if (block.wholeSegment && seedFrom) {
    return `var ${targetVar} = benchSeed(out, ${seedFrom});`;
  }
  return `var ${targetVar} = benchNewSeg(out, ${js(block.id)}, benchDelims);`;
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
  const n = ++st.blocks;
  const ord = `ord${n}`;
  const scope: Scope = { targetVar, counterVar: ord };
  out.push(`var ${ord} = ${startExpr(st, block)} + 1;`);

  if (!block.wholeSegment) {
    out.push(openSegment(block, targetVar, null));
    for (const row of block.rows) emitRow(st, row, scope, "", out);
  } else {
    const src = `seed${n}`;
    out.push(`var ${src} = benchSeg(msg, ${js(block.id)});`);
    if (seedGuarded(st.spec, block)) {
      // A seed that finds nothing delivers nothing, rows included: they exist
      // to overwrite fields on a copy, and there is no copy. The bench and both
      // IRIS forms agree on this, measured, so the channel does too.
      out.push(
        `// ${block.id} is seeded whole from the source. No ${block.id} in, no ${block.id} out.`,
        `if (${src} !== null) {`,
        `  ${openSegment(block, targetVar, src)}`,
      );
      for (const row of block.rows) emitRow(st, row, scope, "  ", out);
      out.push(`}`);
    } else {
      // MSH, or listed in iris.alwaysPresent: a claim that it is always there.
      // When the claim is false the bench delivers a bare segment, so this does.
      out.push(
        `// ${block.id} is seeded whole from the source, and assumed always present.`,
        `var ${targetVar} = ${src} !== null ? benchSeed(out, ${src}) : benchNewSeg(out, ${js(block.id)}, benchDelims);`,
      );
      for (const row of block.rows) emitRow(st, row, scope, "", out);
    }
  }
  if (st.counts) out.push(`benchCount[${js(block.id)}] = ${ord};`);
}

/**
 * A repeat, as the bench runs it: every stage a separate pass, in the order
 * that is load-bearing.
 *
 *     all  ->  skipWhenEmpty  ->  select  ->  fold  ->  max
 *
 * One loop with every guard in it is shorter and only right while there is no
 * select or fold: `highest` cannot decide before it has seen every occurrence,
 * and `max` counts what is delivered AFTER folding, not what arrived.
 */
function emitRepeat(st: State, block: Block, index: number, out: string[]): void {
  const r = block.repeat!;
  const i = index + 1;
  const all = `all${i}`;
  const list = `src${i}`;
  const k = `k${i}`;
  const cur = `cur${i}`;
  const n = `n${i}`;
  const targetVar = segVarFor(block.id);
  const get = (seg: string, path: string) => {
    const p = parsePath(path);
    return `benchGet(${seg}, ${js(p.segment)}, ${p.field}, ${p.repeat}, ${p.component}, ${p.subcomponent})`;
  };

  out.push("");
  if (block.note) out.push(`// ${comment(block.note)}`);
  out.push(
    `// ${comment(block.id)}: numbered by OUTPUT ordinal (${n}), not by source position.`,
    `//      A skipped occurrence must not leave a hole in the set ids.`,
    `var ${all} = benchAll(msg, ${js(r.over)});`,
    `var ${list} = [];`,
  );

  // Stage 1: skip.
  const guards: string[] = [];
  if (r.skipWhenEmpty) {
    guards.push(`${get(`${all}[${k}]`, r.skipWhenEmpty)} !== ''`);
    if (r.skipValues?.length) {
      guards.push(
        `[${r.skipValues.map(js).join(", ")}].indexOf(${get(`${all}[${k}]`, r.skipWhenEmpty)}) < 0`,
      );
    }
  }
  out.push(
    `for (var ${k} = 0; ${k} < ${all}.length(); ${k}++) {`,
    guards.length
      ? `  if (${guards.join(" && ")}) { ${list}.push(${all}[${k}]); }`
      : `  ${list}.push(${all}[${k}]);`,
    `}`,
  );

  // Stage 2: select.
  if (r.select) {
    const keep = `keep${i}`;
    const j = `j${i}`;
    out.push(`// select: ${comment(describeSelect(r.select))}`);
    switch (r.select.kind) {
      case "equals":
        out.push(
          `var ${keep} = [];`,
          `for (var ${j} = 0; ${j} < ${list}.length; ${j}++) {`,
          `  if (${get(`${list}[${j}]`, r.select.path)} === ${js(r.select.value)}) { ${keep}.push(${list}[${j}]); }`,
          `}`,
          `${list} = ${keep};`,
        );
        break;
      case "highest": {
        const top = `top${i}`;
        out.push(
          `if (${list}.length > 0) {`,
          `  var ${top} = ${get(`${list}[0]`, r.select.path)};`,
          `  for (var ${j} = 1; ${j} < ${list}.length; ${j}++) {`,
          `    if (benchRank(${get(`${list}[${j}]`, r.select.path)}, ${top}) > 0) { ${top} = ${get(`${list}[${j}]`, r.select.path)}; }`,
          `  }`,
          `  var ${keep} = [];`,
          `  for (var ${j} = 0; ${j} < ${list}.length; ${j}++) {`,
          `    if (${get(`${list}[${j}]`, r.select.path)} === ${top}) { ${keep}.push(${list}[${j}]); }`,
          `  }`,
          `  ${list} = ${keep};`,
          `}`,
        );
        break;
      }
      default: {
        const kind: never = r.select;
        throw new Error(`emit/bridgelink.ts has no case for select kind "${(kind as Select).kind}"`);
      }
    }
  }

  // Stage 3: fold.
  if (r.fold) {
    switch (r.fold.kind) {
      case "continuation": {
        const f = r.fold;
        const p = parsePath(f.path);
        const held = `held${i}`;
        const merged = `fold${i}`;
        const j = `f${i}`;
        const line = `line${i}`;
        out.push(
          `// fold: ${comment(describeFold(f))}`,
          `var ${merged} = [];`,
          `var ${held} = null;`,
          `for (var ${j} = 0; ${j} < ${list}.length; ${j}++) {`,
          `  var ${line} = ${get(`${list}[${j}]`, f.path)};`,
          `  if (${held} !== null && ${line}.charAt(0) === ' ') {`,
          `    benchSet(${held}, ${js(p.segment)}, ${p.field}, ${p.repeat}, ${p.component}, ${p.subcomponent}, ` +
            `${get(held, f.path)} + ${js(f.join)} + ${line});`,
          `    continue;`,
          `  }`,
          `  if (${held} !== null) { ${merged}.push(${held}); }`,
          // A copy, so the merge never writes into the inbound message.
          `  ${held} = ${list}[${j}].copy();`,
          `}`,
          `if (${held} !== null) { ${merged}.push(${held}); }`,
          `${list} = ${merged};`,
        );
        break;
      }
      default: {
        const kind: never = r.fold.kind;
        throw new Error(`emit/bridgelink.ts has no case for fold kind "${kind}"`);
      }
    }
  }

  // Stage 4: max, then deliver.
  const d = `d${i}`;
  const bound = r.max !== undefined ? `${d} < ${list}.length && ${d} < ${r.max}` : `${d} < ${list}.length`;
  out.push(
    `var ${n} = ${startExpr(st, block)};`,
    `for (var ${d} = 0; ${bound}; ${d}++) {`,
    `  var ${cur} = ${list}[${d}];`,
    `  ${n} = ${n} + 1;`,
    `  ${openSegment(block, targetVar, cur)}`,
  );
  const scope: Scope = { repeatOver: r.over, sourceVar: cur, targetVar, counterVar: n };
  for (const row of block.rows) emitRow(st, row, scope, "  ", out);
  out.push(`}`);
  if (st.counts) out.push(`benchCount[${js(block.id)}] = ${n};`);
}

// ---------------------------------------------------------------------------
// The channel's half of the job
// ---------------------------------------------------------------------------

/** A path as E4X, read through the filter's own text helper. */
function e4x(path: string): string {
  const p = parsePath(path);
  let s = `msg[${js(p.segment)}][${js(`${p.segment}.${p.field}`)}]`;
  if (p.component !== 0) s += `[${js(`${p.segment}.${p.field}.${p.component}`)}]`;
  if (p.subcomponent !== 0) {
    s += `[${js(`${p.segment}.${p.field}.${p.component}.${p.subcomponent}`)}]`;
  }
  return `benchGateText(${s})`;
}

/**
 * The filter's one helper. A filter script runs without the transformer's
 * runtime, so it carries its own copy of the only read it needs.
 *
 * Measured on BridgeLink 26.9.0, not assumed: the HL7 v2 parser puts even a
 * one-piece field's value in a .1 child, `<MSH.11><MSH.11.1>T</MSH.11.1></MSH.11>`.
 * A bare `.toString()` on that returns MARKUP, so a gate on MSH-11 compared
 * markup against 'T' and filtered every message. This flattens instead, joined
 * with the message's own separators, which is what the bench means by the path.
 */
const GATE_RUNTIME = [
  `function benchGateText(list) {`,
  `  if (list.length() === 0) { return ''; }`,
  `  var enc = msg['MSH']['MSH.2'].toString();`,
  `  var flat = function (n) {`,
  `    if (!n.hasComplexContent()) { return n.toString(); }`,
  `    var nm = n.name() === null ? '' : n.name().toString();`,
  `    var sep = nm.split('.').length > 2 ? (enc.charAt(3) || '&') : (enc.charAt(0) || '^');`,
  `    var parts = [];`,
  `    var kids = n.children();`,
  `    for (var i = 0; i < kids.length(); i++) { parts.push(flat(kids[i])); }`,
  `    return parts.join(sep);`,
  `  };`,
  `  return flat(list[0]);`,
  `}`,
];

/**
 * The SOURCE FILTER this step expects in front of it.
 *
 * The gate belongs in the filter, not the transformer: a message this interface
 * does not handle should never be transformed at all, rather than transformed
 * into something else. Same decision as the IRIS routing rule, printed here for
 * the same reason -- it is a step you would otherwise forget.
 *
 * A whole filter script: one helper, then one `return`. Paste it as a single
 * JavaScript rule. See GATE_RUNTIME for why even this needs a helper.
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
  const ret = required.length === 0
    ? `return ${events};`
    : `return ${required.join(" && ")} && (${events});`;
  return [...GATE_RUNTIME, ret].join("\n");
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
  const used = kindsUsed(spec);
  const st: State = {
    spec,
    temp: 1,
    record: used.sources.has("sameAs"),
    counts: spec.blocks.some((b) => b.continuesNumbering),
    blocks: 0,
  };
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
          // One comment line per script line: the filter is several lines now,
          // and a bare newline here leaked its `return` into the step as code.
          ...filterCondition(spec).split("\n").map((l) => `//   ${l}`),
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
  if (spec.blocks.some((b) => b.wholeSegment)) out.push(SEED_RUNTIME);
  if (spec.blocks.some((b) => b.repeat?.select?.kind === "highest")) out.push(RANK_RUNTIME);
  if (st.record) out.push(SAMEAS_RUNTIME);
  if (st.counts) {
    out.push(
      ``,
      `// Segments delivered so far, per id, so a block that continues numbering`,
      `// picks up after the last one rather than overwriting set id 1.`,
      `var benchCount = {};`,
    );
  }

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
