/**
 * xml.ts -- an XML message, read and written the way hl7.ts reads and writes
 * an HL7 one, so the same spec vocabulary runs over either.
 *
 * WHAT A PATH IS
 *
 * Absolute, from the document element, slash-separated, the way XPath writes
 * it. A leading "/" is what tells it apart from an HL7 path, and nothing else
 * has to:
 *
 *     /Order/Patient/Name/Family       the first Family under the first Name ...
 *     /Order/Items/Item[2]/Code        an index on any step, 1-based
 *     /Order/Patient/@id               an attribute, as the last step only
 *
 * A step with no index means the FIRST match for a read and EVERY match for a
 * repeat's `over`, which is what a segment id means on the HL7 side.
 *
 * WHAT A RECORD IS
 *
 * The XML counterpart of a segment: an element named by its path, the thing a
 * block delivers and a repeat walks. `/Order/Items/Item` walked as a repeat is
 * one occurrence per Item; a path under it, `/Order/Items/Item/Code`, read
 * inside that repeat means THIS Item's Code. Same rule as PID-3 inside a PID
 * loop, spelled as a prefix instead of a segment id.
 *
 * WHAT IS DROPPED ON READ, AND WHY
 *
 * Whitespace-only text between elements, comments, processing instructions and
 * the doctype. Namespace declarations and prefixes, so `<ns:Order>` is
 * `/Order`. All of it to match what the engine's XML data type hands a
 * transformer with its defaults (strip namespaces on, E4X ignoring whitespace,
 * comments and PIs), so the bench and the channel read the same tree. The
 * BridgeLink channel this tool emits sets those defaults explicitly.
 *
 * No dependency. bun has no DOM, and a parser for well-formed documents is
 * smaller than the argument for adding one. It is not a validating parser and
 * does not pretend to be: a malformed document throws, with the offset.
 */

import type { Delims } from "./hl7";

const HL7_DEFAULTS: Delims = { field: "|", comp: "^", rep: "~", esc: "\\", sub: "&" };

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

export class XEl {
  constructor(
    public name: string,
    public attrs: [string, string][] = [],
    public kids: (XEl | string)[] = [],
  ) {}

  /** Child elements with this name, in document order. */
  children(name: string): XEl[] {
    return this.kids.filter((k): k is XEl => typeof k !== "string" && k.name === name);
  }

  attr(name: string): string | undefined {
    return this.attrs.find(([k]) => k === name)?.[1];
  }

  setAttr(name: string, value: string): void {
    const at = this.attrs.findIndex(([k]) => k === name);
    if (at === -1) this.attrs.push([name, value]);
    else this.attrs[at] = [name, value];
  }

  /** XPath string(): every descendant text node, concatenated. */
  text(): string {
    return this.kids.map((k) => (typeof k === "string" ? k : k.text())).join("");
  }

  setText(value: string): void {
    this.kids = value === "" ? [] : [value];
  }

  clone(): XEl {
    return new XEl(
      this.name,
      this.attrs.map(([k, v]) => [k, v] as [string, string]),
      this.kids.map((k) => (typeof k === "string" ? k : k.clone())),
    );
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function decode(s: string, at: number): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return String.fromCodePoint(code);
    }
    if (ref in ENTITIES) return ENTITIES[ref];
    throw new Error(`XML: unknown entity ${whole} near offset ${at}`);
  });
}

/** `ns:Order` is `Order`. See the header: the engine strips them too. */
function local(name: string): string {
  const i = name.indexOf(":");
  return i === -1 ? name : name.slice(i + 1);
}

const NAME = /^[A-Za-z_:][\w.\-:]*/;

/**
 * A well-formed document into its element tree, or a thrown offset.
 *
 * `strict` keeps namespace prefixes and declarations as written. Not for
 * reading a message: for checking what an ENGINE delivered, where an xmlns the
 * receiver will see must not compare equal to a document without one.
 */
export function parseXml(raw: string, strict = false): XEl {
  const name = (n: string) => (strict ? n : local(n));
  const s = raw.replace(/^﻿/, "");
  let i = 0;
  const stack: XEl[] = [];
  let root: XEl | undefined;

  const fail = (what: string): never => {
    throw new Error(`XML: ${what} at offset ${i}`);
  };

  while (i < s.length) {
    if (s.startsWith("<!--", i)) {
      const end = s.indexOf("-->", i + 4);
      if (end === -1) fail("unclosed comment");
      i = end + 3;
    } else if (s.startsWith("<![CDATA[", i)) {
      const end = s.indexOf("]]>", i + 9);
      if (end === -1) fail("unclosed CDATA");
      if (stack.length === 0) fail("text outside the document element");
      stack[stack.length - 1].kids.push(s.slice(i + 9, end));
      i = end + 3;
    } else if (s.startsWith("<?", i)) {
      const end = s.indexOf("?>", i + 2);
      if (end === -1) fail("unclosed processing instruction");
      i = end + 2;
    } else if (s.startsWith("<!", i)) {
      // DOCTYPE, with or without an internal subset.
      let depth = 0;
      let j = i + 2;
      for (; j < s.length; j++) {
        if (s[j] === "[") depth++;
        else if (s[j] === "]") depth--;
        else if (s[j] === ">" && depth === 0) break;
      }
      i = j + 1;
    } else if (s.startsWith("</", i)) {
      const m = NAME.exec(s.slice(i + 2));
      if (!m) fail("bad closing tag");
      const closing = name(m![0]);
      const open = stack.pop();
      if (!open || open.name !== closing) fail(`</${m![0]}> does not close <${open?.name ?? "nothing"}>`);
      i = s.indexOf(">", i) + 1;
      if (i === 0) fail("unclosed closing tag");
    } else if (s[i] === "<") {
      const m = NAME.exec(s.slice(i + 1));
      if (!m) fail("bad tag");
      const el = new XEl(name(m![0]));
      i += 1 + m![0].length;
      for (;;) {
        while (/\s/.test(s[i] ?? "")) i++;
        if (s.startsWith("/>", i) || s[i] === ">") break;
        const a = NAME.exec(s.slice(i));
        if (!a) fail(`bad attribute in <${el.name}>`);
        i += a![0].length;
        while (/\s/.test(s[i] ?? "")) i++;
        if (s[i] !== "=") fail(`attribute ${a![0]} has no value`);
        i++;
        while (/\s/.test(s[i] ?? "")) i++;
        const q = s[i];
        if (q !== '"' && q !== "'") fail(`attribute ${a![0]} is not quoted`);
        const end = s.indexOf(q, i + 1);
        if (end === -1) fail(`attribute ${a![0]} is not closed`);
        const an = a![0];
        // Namespace declarations go, prefixed attributes keep their local name.
        if (strict || (an !== "xmlns" && !an.startsWith("xmlns:"))) {
          el.setAttr(name(an), decode(s.slice(i + 1, end), i));
        }
        i = end + 1;
      }
      if (stack.length > 0) stack[stack.length - 1].kids.push(el);
      else if (root) fail("a second document element");
      else root = el;
      if (s.startsWith("/>", i)) {
        i += 2;
      } else {
        i += 1;
        stack.push(el);
      }
    } else {
      const end = s.indexOf("<", i);
      const chunk = s.slice(i, end === -1 ? s.length : end);
      if (chunk.trim() !== "") {
        if (stack.length === 0) fail("text outside the document element");
        stack[stack.length - 1].kids.push(decode(chunk, i));
      }
      i = end === -1 ? s.length : end;
    }
  }
  if (stack.length > 0) fail(`<${stack[stack.length - 1].name}> is never closed`);
  if (!root) throw new Error("XML: no document element");
  mergeText(root);
  return root;
}

/** Adjacent text pieces (text, CDATA, text) are one text node. */
function mergeText(el: XEl): void {
  const out: (XEl | string)[] = [];
  for (const k of el.kids) {
    if (typeof k === "string" && typeof out[out.length - 1] === "string") {
      out[out.length - 1] += k;
    } else {
      out.push(k);
      if (typeof k !== "string") mergeText(k);
    }
  }
  el.kids = out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(s: string): string {
  return escText(s).replace(/"/g, "&quot;");
}

/**
 * The canonical form: two-space indent, one element per line, `<a/>` for an
 * empty element. Canonical rather than faithful, so two trees that mean the
 * same thing print the same way -- which is what lets the bench and an engine
 * that pretty-prints differently be compared line for line.
 */
export function printXml(el: XEl, indent = ""): string {
  const attrs = el.attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("");
  if (el.kids.length === 0) return `${indent}<${el.name}${attrs}/>`;
  if (el.kids.every((k) => typeof k === "string")) {
    return `${indent}<${el.name}${attrs}>${escText(el.kids.join(""))}</${el.name}>`;
  }
  const inner = el.kids.map((k) =>
    typeof k === "string" ? `${indent}  ${escText(k)}` : printXml(k, indent + "  "),
  );
  return `${indent}<${el.name}${attrs}>\n${inner.join("\n")}\n${indent}</${el.name}>`;
}

/** Parse, then print canonically. The comparison form for two XML documents. */
export function canonicalXml(raw: string, strict = false): string {
  return printXml(parseXml(raw, strict));
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface XStep {
  name: string;
  /** 1-based, or undefined for "first" on a read and "every" on a walk. */
  index?: number;
}

export interface XPath {
  steps: XStep[];
  /** Set when the last step is `@name`. */
  attr?: string;
}

const STEP_RE = /^([A-Za-z_][\w.\-]*)(?:\[(\d+)\])?$/;
const ATTR_RE = /^@([A-Za-z_][\w.\-]*)$/;

/** True for an XML path. An HL7 path never starts with "/". */
export function isXmlPath(path: string): boolean {
  return path.trim().startsWith("/");
}

export function parseXmlPath(path: string): XPath {
  const p = path.trim();
  if (!p.startsWith("/") || p.length < 2) {
    throw new Error(`Not a valid XML path: "${path}" (expected something like /Order/Patient/Name)`);
  }
  const parts = p.slice(1).split("/");
  const steps: XStep[] = [];
  let attr: string | undefined;
  parts.forEach((part, n) => {
    const a = ATTR_RE.exec(part);
    if (a) {
      if (n !== parts.length - 1) throw new Error(`XML path "${path}": an attribute can only be the last step`);
      attr = a[1];
      return;
    }
    const m = STEP_RE.exec(part);
    if (!m) throw new Error(`Not a valid XML path: "${path}" (bad step "${part}")`);
    const index = m[2] === undefined ? undefined : parseInt(m[2], 10);
    if (index === 0) throw new Error(`XML path "${path}": indexes start at 1`);
    steps.push({ name: m[1], index });
  });
  if (steps.length === 0) throw new Error(`XML path "${path}": names no element`);
  return { steps, attr };
}

/** The path a record is named by, with no attribute: what a block or repeat may name. */
export function isRecordPath(path: string): boolean {
  try {
    return parseXmlPath(path).attr === undefined;
  } catch {
    return false;
  }
}

/**
 * Whether `path` is the record `record` or under it: the scoping rule.
 * Step-wise, so `/A/Item` does not claim `/A/Items/Code`.
 */
export function underRecord(path: string, record: string): boolean {
  const p = path.trim();
  const r = record.trim();
  return p === r || p.startsWith(r + "/");
}

function pick(els: XEl[], index: number | undefined): XEl[] {
  if (index === undefined) return els;
  const one = els[index - 1];
  return one ? [one] : [];
}

/** Every element a path's steps reach from `from`, steps relative to it. */
function walkSteps(from: XEl[], steps: XStep[]): XEl[] {
  let at = from;
  for (const st of steps) at = at.flatMap((e) => pick(e.children(st.name), st.index));
  return at;
}

/** Read a path's value off one element, steps relative to it. "" when absent. */
function readFrom(el: XEl, steps: XStep[], attr: string | undefined): string {
  let at: XEl | undefined = el;
  for (const st of steps) {
    at = at.children(st.name)[(st.index ?? 1) - 1];
    if (!at) return "";
  }
  if (attr !== undefined) return at.attr(attr) ?? "";
  return at.text();
}

/** Write a path's value under one element, creating every step it needs. */
function writeUnder(el: XEl, steps: XStep[], attr: string | undefined, value: string): void {
  let at = el;
  for (const st of steps) {
    const want = st.index ?? 1;
    let kids = at.children(st.name);
    while (kids.length < want) {
      at.kids.push(new XEl(st.name));
      kids = at.children(st.name);
    }
    at = kids[want - 1];
  }
  if (attr !== undefined) at.setAttr(attr, value);
  else at.setText(value);
}

// ---------------------------------------------------------------------------
// The message and its records: the same surface run.ts uses on hl7.ts
// ---------------------------------------------------------------------------

/**
 * One element, named by its record path. The XML counterpart of `Segment`:
 * `get` and `set` take ABSOLUTE paths, exactly as `Segment.get("PID-5.1")`
 * does, and read relative to this element when the path is under it.
 */
export class XmlRecord {
  constructor(
    readonly id: string,
    readonly el: XEl,
  ) {}

  private rest(path: string): XPath | null {
    const own = parseXmlPath(this.id).steps.length;
    const p = parseXmlPath(path);
    if (!underRecord(path, this.id)) return null;
    return { steps: p.steps.slice(own), attr: p.attr };
  }

  get(path: string): string {
    const r = this.rest(path);
    return r ? readFrom(this.el, r.steps, r.attr) : "";
  }

  set(path: string, value: string): void {
    const r = this.rest(path);
    if (!r) throw new Error(`${path} is not under the record ${this.id}`);
    writeUnder(this.el, r.steps, r.attr, value);
  }

  clone(): XmlRecord {
    return new XmlRecord(this.id, this.el.clone());
  }

  toString(): string {
    return printXml(this.el);
  }
}

export class XmlMessage {
  /** HL7 defaults, for an HL7 target built from an XML source. */
  readonly delims: Delims = HL7_DEFAULTS;

  constructor(readonly root: XEl) {}

  static parse(raw: string): XmlMessage {
    return new XmlMessage(parseXml(raw));
  }

  /** The elements a path names, from the document element. */
  private reach(path: string): { els: XEl[]; p: XPath } {
    const p = parseXmlPath(path);
    const [first, ...rest] = p.steps;
    if (first.name !== this.root.name || (first.index ?? 1) !== 1) return { els: [], p };
    return { els: walkSteps([this.root], rest), p };
  }

  /** First match's value, the way `Message.get` reads the first segment. */
  get(path: string): string {
    const { els, p } = this.reach(path);
    const el = els[0];
    if (!el) return "";
    return p.attr !== undefined ? (el.attr(p.attr) ?? "") : el.text();
  }

  /** Every element a record path names, in document order. */
  all(record: string): XmlRecord[] {
    return this.reach(record).els.map((el) => new XmlRecord(record, el));
  }

  seg(record: string): XmlRecord | undefined {
    return this.all(record)[0];
  }

  toString(): string {
    return printXml(this.root) + "\n";
  }
}

/**
 * The outbound document, assembled record by record.
 *
 * A record is appended under its parent path, creating each parent once, the
 * first time something needs it: every Item of `/Order/Items/Item` lands in one
 * Items, in delivery order. Block order is therefore output order, the same
 * promise the HL7 side makes about segments.
 */
export class XmlBuilder {
  readonly root: XEl;

  constructor(rootName: string) {
    this.root = new XEl(rootName);
  }

  place(rec: XmlRecord): void {
    const steps = parseXmlPath(rec.id).steps;
    if (steps[0].name !== this.root.name) {
      throw new Error(`${rec.id} is not under the target document element <${this.root.name}>`);
    }
    let at = this.root;
    for (const st of steps.slice(1, -1)) {
      const want = st.index ?? 1;
      while (at.children(st.name).length < want) at.kids.push(new XEl(st.name));
      at = at.children(st.name)[want - 1];
    }
    at.kids.push(rec.el);
  }

  message(): XmlMessage {
    return new XmlMessage(this.root);
  }
}

/** A fresh, empty record for a target path. */
export function blankRecord(record: string): XmlRecord {
  const steps = parseXmlPath(record).steps;
  return new XmlRecord(record, new XEl(steps[steps.length - 1].name));
}

/** The document element a set of paths agrees on, or a thrown disagreement. */
export function rootOf(paths: string[]): string {
  const roots = [...new Set(paths.map((p) => parseXmlPath(p).steps[0].name))];
  if (roots.length !== 1) {
    throw new Error(`XML paths disagree on the document element: ${roots.join(", ")}`);
  }
  return roots[0];
}
