/**
 * speccomments.ts -- the comments inside a spec literal, carried through a GUI save.
 *
 * `serialize.ts` regenerates the spec literal from the value, and a value has no
 * comments, so a GUI save used to delete every `//` and `/** *\/` inside it. The
 * reasoning people write next to a row is the part of a spec that is hardest to
 * reconstruct, and the GUI was the one tool that destroyed it.
 *
 * HOW A COMMENT SURVIVES
 *
 *   load   `extractComments` reads the literal and pins each comment to what it
 *          sits above (or at the end of): a property path such as
 *          `iris.sourceGroups` or `tables.DocStatus`, or an array element.
 *          Elements are named by their `id` or `target`, so `blocks[NK1].rows[NK1-2]`
 *          and not `blocks[3].rows[1]`, which every reorder would break.
 *   edit   `attachComments` puts element comments ON the element (`"//"`), so a
 *          comment travels with a row when the row moves or its target is
 *          renamed, and property comments on the spec root (`spec["//"]`).
 *   save   `collectComments` takes them back off, the clean value is printed,
 *          and `reinsertComments` finds every anchor in the printed text with
 *          the same scanner and puts each comment back above its line, or at
 *          the end of it when it was written there.
 *
 * Nothing that runs a spec ever sees a comment: the GUI strips them before
 * preview, validate, the fingerprint and every emitter. A comment whose anchor
 * no longer exists (the table was deleted) is not dropped either. It is written
 * at the top of the literal with the path it used to belong to.
 *
 * A `/** *\/` block comes back as `//` lines. Same words, one style.
 */

export interface SpecComment {
  /** Lines written above the anchor, markers removed, joined with "\n". */
  above?: string;
  /** A comment written at the end of the anchor's line. */
  after?: string;
}

export type CommentMap = Record<string, SpecComment>;

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------

interface Anchor {
  path: string;
  /** 0-based line in the scanned text. */
  line: number;
}

interface Frame {
  kind: "obj" | "arr" | "paren";
  path: string;
  /** obj: the next token is a key. arr: the next token starts an element. */
  expect: boolean;
  /** arr: elements seen. */
  index: number;
  /** arr: occurrences per identity, for `#2` on a repeated block id. */
  seen: Map<string, number>;
  /** obj: the key whose value is being read. */
  key?: string;
  /** obj that is an array element: its `id` or `target`, first one written. */
  ident?: string;
  /** obj that is an array element: the offset it started at. */
  start?: number;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT = /[A-Za-z0-9_$]/;

const join = (parent: string, key: string) => (parent ? `${parent}.${key}` : key);

/** `// x` or `/** x *\/` to its text lines. */
function commentText(raw: string): string[] {
  if (raw.startsWith("//")) return [raw.replace(/^\/\/ ?/, "").trimEnd()];
  return raw
    .replace(/^\/\*+/, "")
    .replace(/\*+\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, "").trimEnd())
    .filter((l, i, all) => !(l === "" && (i === 0 || i === all.length - 1)));
}

interface Scan {
  anchors: Anchor[];
  comments: CommentMap;
  /** Element start offset to its identity, from a first pass. */
  idents: Map<number, string>;
}

/**
 * One pass over a spec literal, from its opening `{` to its closing `}`.
 *
 * Run twice: an element's identity is the `id` or `target` written INSIDE it,
 * which is only known once the element closes, and its children's paths need
 * it. The first pass records identities by offset; the second uses them.
 */
function scan(text: string, idents: Map<number, string> = new Map()): Scan {
  const anchors: Anchor[] = [];
  const comments: CommentMap = {};
  const found = new Map<number, string>();
  const stack: Frame[] = [];
  let pending: string[] = [];
  let line = 0;
  let lineHasCode = false;
  /** First anchor on each line, for a comment written at its end. */
  const firstOnLine = new Map<number, string>();

  const anchor = (path: string) => {
    anchors.push({ path, line });
    if (!firstOnLine.has(line)) firstOnLine.set(line, path);
    if (pending.length) {
      comments[path] = { ...comments[path], above: pending.join("\n") };
      pending = [];
    }
  };

  const top = () => stack[stack.length - 1];

  /** An element starts at `i` inside the array frame on top. */
  const element = (i: number) => {
    const arr = top()!;
    const ident = idents.get(i) ?? String(arr.index);
    const n = (arr.seen.get(ident) ?? 0) + 1;
    arr.seen.set(ident, n);
    arr.index++;
    arr.expect = false;
    const path = `${arr.path}[${n > 1 ? `${ident}#${n}` : ident}]`;
    anchor(path);
    return path;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;

    if (c === "\n") { line++; lineHasCode = false; continue; }
    if (c === " " || c === "\t" || c === "\r") continue;

    if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      const end = text[i + 1] === "/"
        ? (text.indexOf("\n", i) === -1 ? text.length : text.indexOf("\n", i))
        : text.indexOf("*/", i + 2) + 2;
      const raw = text.slice(i, end);
      const lines = commentText(raw);
      const at = firstOnLine.get(line);
      if (lineHasCode && at !== undefined && raw.startsWith("//")) {
        comments[at] = { ...comments[at], after: lines.join(" ") };
      } else {
        pending.push(...lines);
      }
      line += (raw.match(/\n/g) ?? []).length;
      i = end - 1;
      continue;
    }

    const f = top();

    // An array element starts at the first token after `[` or `,`.
    let elemPath: string | undefined;
    if (f && f.kind === "arr" && f.expect && c !== "]") elemPath = element(i);

    lineHasCode = true;

    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      const str = text.slice(i + 1, j);
      line += (str.match(/\n/g) ?? []).length;
      // A quoted key, or an `id`/`target` value naming the element.
      const k = j + 1;
      let m = k;
      while (m < text.length && /[ \t]/.test(text[m]!)) m++;
      if (f && f.kind === "obj" && f.expect && text[m] === ":") {
        f.key = str;
        f.expect = false;
        anchor(join(f.path, f.key));
        i = m;
        continue;
      }
      if (f && f.kind === "obj" && (f.key === "id" || f.key === "target") && f.ident === undefined && f.start !== undefined) {
        f.ident = str;
      }
      i = j;
      continue;
    }

    if (IDENT_START.test(c)) {
      let j = i;
      while (j < text.length && IDENT.test(text[j]!)) j++;
      const word = text.slice(i, j);
      let m = j;
      while (m < text.length && /[ \t]/.test(text[m]!)) m++;
      if (f && f.kind === "obj" && f.expect && text[m] === ":") {
        f.key = word;
        f.expect = false;
        anchor(join(f.path, word));
        i = m;
        continue;
      }
      i = j - 1;
      continue;
    }

    if (c === "{" || c === "[" || c === "(") {
      const parentPath = f
        ? f.kind === "obj" && f.key !== undefined ? join(f.path, f.key)
        : f.kind === "arr" ? (elemPath ?? f.path)
        : `${f.path}()`
        : "";
      stack.push({
        kind: c === "{" ? "obj" : c === "[" ? "arr" : "paren",
        path: parentPath,
        expect: c !== "(",
        index: 0,
        seen: new Map(),
        ...(c === "{" && elemPath !== undefined ? { start: i } : {}),
      });
      continue;
    }

    if (c === "}" || c === "]" || c === ")") {
      const done = stack.pop();
      if (done && done.kind !== "paren") anchor(`${done.path}/end`);
      if (done?.start !== undefined && done.ident !== undefined) found.set(done.start, done.ident);
      continue;
    }

    if (c === ",") {
      if (f && f.kind !== "paren") { f.expect = true; f.key = f.kind === "obj" ? undefined : f.key; }
      continue;
    }
  }

  return { anchors, comments, idents: found };
}

/** The spec literal inside a whole transform file: `{` to its matching `}`. */
export function specLiteral(file: string, endOfObject: (s: string, open: number) => number): { open: number; close: number } | null {
  const decl = file.indexOf("export const spec");
  if (decl === -1) return null;
  const open = file.indexOf("{", decl);
  if (open === -1) return null;
  const close = endOfObject(file, open);
  return close === -1 ? null : { open, close };
}

/** Every comment in a spec literal, pinned to its anchor path. */
export function extractComments(literal: string): CommentMap {
  return scan(literal, scan(literal).idents).comments;
}

/**
 * Put comments back into a freshly printed literal. The printed text is
 * scanned exactly as the original was, so an anchor path means the same thing
 * on both sides.
 */
export function reinsertComments(literal: string, comments: CommentMap): string {
  if (Object.keys(comments).length === 0) return literal;
  const { anchors } = scan(literal, scan(literal).idents);
  const lines = literal.split("\n");
  const above = new Map<number, string[]>();
  const after = new Map<number, string>();
  const placed = new Set<string>();

  for (const a of anchors) {
    const c = comments[a.path];
    if (!c || placed.has(a.path)) continue;
    placed.add(a.path);
    const indent = /^\s*/.exec(lines[a.line] ?? "")![0];
    if (c.above !== undefined) {
      above.set(a.line, [...(above.get(a.line) ?? []), ...c.above.split("\n").map((l) => (l === "" ? `${indent}//` : `${indent}// ${l}`))]);
    }
    if (c.after !== undefined && !after.has(a.line)) after.set(a.line, c.after);
  }

  const orphans = Object.entries(comments).filter(([p]) => !placed.has(p));
  const out: string[] = [];
  lines.forEach((l, n) => {
    if (n === 1 && orphans.length) {
      out.push(`  // Kept by a GUI save: these comments belonged to something that is no longer in the spec.`);
      for (const [p, c] of orphans) {
        const text = [c.above, c.after].filter(Boolean).join(" ");
        text.split("\n").forEach((t, i) => out.push(i === 0 ? `  // [was at ${p}] ${t}` : `  // ${t}`));
      }
    }
    out.push(...(above.get(n) ?? []));
    out.push(after.has(n) ? `${l}  // ${after.get(n)}` : l);
  });
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Comments on the value, for the GUI
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** Path segments: "blocks[NK1].rows[NK1-2#2]" to ["blocks", "[NK1]", "rows", "[NK1-2#2]"]. */
function segments(path: string): string[] {
  return path.match(/\[[^\]]*\]|[^.[\]]+/g) ?? [];
}

/** The identity of each element of an array, as the scanner names them. */
function idents(arr: unknown[]): string[] {
  const seen = new Map<string, number>();
  return arr.map((el, i) => {
    const o = el && typeof el === "object" ? (el as Json) : undefined;
    const id = typeof o?.id === "string" ? o.id : typeof o?.target === "string" ? o.target : String(i);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    return n > 1 ? `${id}#${n}` : id;
  });
}

/**
 * Comments onto the spec value: an element's on the element as `"//"`, so it
 * moves with it; everything else on the root as `spec["//"][path]`.
 */
export function attachComments<T extends object>(spec: T, comments: CommentMap): T {
  const root: CommentMap = {};
  for (const [raw, c] of Object.entries(comments)) {
    // A comment just inside an element's `{`, above its `id:` or `target:`, is
    // about the element. Pinned there it shows on the block in the GUI and
    // follows a rename; it is written back above the `{`.
    const path = raw.replace(/(\[[^\]]*\])\.(id|target)$/, "$1");
    const segs = segments(path);
    const last = segs[segs.length - 1] ?? "";
    let at: unknown = spec;
    for (const s of segs) {
      if (at === undefined || at === null) break;
      if (s.startsWith("[") && Array.isArray(at)) {
        const want = s.slice(1, -1);
        const i = idents(at).indexOf(want);
        at = i === -1 ? undefined : at[i];
      } else if (typeof at === "object" && !s.endsWith("/end")) {
        at = (at as Json)[s];
      } else {
        at = undefined;
      }
    }
    if (last.startsWith("[") && at && typeof at === "object" && !Array.isArray(at)) {
      (at as Json)["//"] = c;
    } else {
      root[path] = c;
    }
  }
  if (Object.keys(root).length) (spec as Json)["//"] = root;
  return spec;
}

/** Comments off the value, as a path map. Leaves the value untouched. */
export function collectComments(spec: object): CommentMap {
  const out: CommentMap = { ...(((spec as Json)["//"] as CommentMap | undefined) ?? {}) };
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) {
      const names = idents(v);
      v.forEach((el, i) => {
        const p = `${path}[${names[i]}]`;
        if (el && typeof el === "object" && !Array.isArray(el) && (el as Json)["//"]) {
          const c = (el as Json)["//"] as SpecComment;
          if (c.above || c.after) out[p] = c;
        }
        walk(el, p);
      });
    } else if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v as Json)) {
        if (k === "//") continue;
        walk(child, join(path, k));
      }
    }
  };
  walk(spec, "");
  for (const [p, c] of Object.entries(out)) if (!c.above && !c.after) delete out[p];
  return out;
}

/** A deep copy with every `"//"` key removed: what preview, validate and the emitters see. */
export function stripComments<T>(spec: T): T {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const o: Json = {};
      for (const [k, child] of Object.entries(v as Json)) if (k !== "//") o[k] = strip(child);
      return o;
    }
    return v;
  };
  return strip(spec) as T;
}
