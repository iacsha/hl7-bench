/**
 * serialize.ts -- spec object back to the TypeScript that produced it.
 *
 * The GUI edits the spec as data. To make that edit stick it has to become
 * `transform.ts` again, because `transform.ts` on disk is what `bench.ts`,
 * `trace.ts`, `emit.ts` and PipeHat all read. Nothing here is a second
 * authoring: this is a printer for a value, and the value is the authoring.
 *
 * WHAT SURVIVES A GUI SAVE AND WHAT DOES NOT
 *
 * Everything before `export const spec` and everything after the literal's
 * closing brace is copied through byte for byte. The doc comment at the top of
 * your transform, the `transform()` shim at the bottom, any helper you wrote:
 * all untouched.
 *
 * Comments INSIDE the spec literal do not survive. That is not laziness, it is
 * the honest consequence of the value being the source of truth, and it points
 * the right way: a `//` comment in the spec literal is a fourth copy of your
 * reasoning that only a reader of this one file will ever see. The same
 * sentence in a `note`, `description` or `outOfScope` field prints in the
 * mapping document AND lands in the emitted DTL as a comment the next engineer
 * reads in IRIS. Put it where all three consumers can reach it.
 *
 * The one import statement from "./spec" IS rewritten, because the set of
 * constructors a spec needs changes as you edit it, and a stale import list
 * fails at compile time rather than quietly.
 */

import type { Row, Source, Spec, Step, Unmapped } from "./spec";

// ---------------------------------------------------------------------------
// Value printing
// ---------------------------------------------------------------------------

const q = (s: string) => JSON.stringify(s);

/** Bare where legal, quoted where not. `{ A01: "A28" }` reads better. */
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (k: string) => (IDENT.test(k) ? k : q(k));

/** Constructor names this spec needs, so the import line can be regenerated. */
export function constructorsUsed(spec: Spec): string[] {
  const used = new Set<string>();
  for (const block of spec.blocks) {
    for (const row of block.rows) {
      used.add(row.from.kind);
      if (row.from.kind === "lookup") used.add(row.from.unmapped.kind);
      for (const s of row.via ?? []) used.add(s.kind);
    }
  }
  // Declared order rather than insertion order: the import line should not
  // churn in a diff because you happened to add a row at the top.
  const order = [
    "copy", "literal", "firstOf", "lookup", "counter", "event",
    "pickRepeat", "fromFirst", "todo",
    "blank", "passthrough", "constant",
    "date8", "truncate", "upper", "stripDelims", "stripChars", "defaultTo",
  ];
  return order.filter((n) => used.has(n));
}

function unmapped(u: Unmapped): string {
  switch (u.kind) {
    case "blank": return "blank()";
    case "passthrough": return "passthrough()";
    case "constant": return `constant(${q(u.value)})`;
  }
}

function source(from: Source): string {
  switch (from.kind) {
    case "copy": return `copy(${q(from.path)})`;
    case "literal": return `literal(${q(from.value)})`;
    case "firstOf": return `firstOf(${from.paths.map(q).join(", ")})`;
    case "lookup": return `lookup(${q(from.table)}, ${q(from.path)}, ${unmapped(from.unmapped)})`;
    case "counter": return "counter()";
    case "event": return "event()";
    case "pickRepeat": {
      const head = `${q(from.path)}, ${from.whereComponent}, ${q(from.equals)}`;
      // "whole" is the constructor default. Printing it adds an argument that
      // says nothing, and the shorter call is the one people copy.
      if (from.take === "whole") return `pickRepeat(${head})`;
      const take = Array.isArray(from.take) ? `[${from.take.join(", ")}]` : String(from.take);
      return `pickRepeat(${head}, ${take})`;
    }
    case "fromFirst":
      return `fromFirst(${q(from.segment)}, ${q(from.nonEmpty)}, ${q(from.path)})`;
    case "todo": return `todo(${q(from.why)})`;
  }
}

function step(s: Step): string {
  switch (s.kind) {
    case "date8": return "date8()";
    case "truncate": return `truncate(${s.n})`;
    case "upper": return "upper()";
    case "stripDelims": return "stripDelims()";
    case "stripChars": return `stripChars(${q(s.chars)})`;
    case "defaultTo": return `defaultTo(${q(s.value)})`;
  }
}

/**
 * One row, one line. A mapping is a table and reads like one; breaking rows
 * across lines to respect a column limit is how a table stops looking like a
 * table.
 */
function row(r: Row): string {
  const parts = [`target: ${q(r.target)}`];
  if (r.label) parts.push(`label: ${q(r.label)}`);
  parts.push(`from: ${source(r.from)}`);
  if (r.via?.length) parts.push(`via: [${r.via.map(step).join(", ")}]`);
  if (r.required) parts.push("required: true");
  if (r.note) parts.push(`note: ${q(r.note)}`);
  return `{ ${parts.join(", ")} }`;
}

function record(rows: Record<string, string>, indent: string): string {
  const keys = Object.keys(rows);
  if (keys.length === 0) return "{}";
  const inline = `{ ${keys.map((k) => `${key(k)}: ${q(rows[k])}`).join(", ")} }`;
  if (inline.length + indent.length <= 96) return inline;
  return [
    "{",
    ...keys.map((k) => `${indent}  ${key(k)}: ${q(rows[k])},`),
    `${indent}}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The spec literal
// ---------------------------------------------------------------------------

/** Print `export const spec: Spec = { ... };` for this spec. */
export function specToSource(spec: Spec): string {
  const out: string[] = ["export const spec: Spec = {"];
  out.push(`  name: ${q(spec.name)},`);
  if (spec.description) out.push(`  description: ${q(spec.description)},`);

  out.push("", "  gate: {");
  out.push(`    path: ${q(spec.gate.path)},`);
  out.push(`    permit: ${record(spec.gate.permit, "    ")},`);
  if (spec.gate.require?.length) {
    out.push("    require: [");
    for (const r of spec.gate.require) {
      out.push(`      { path: ${q(r.path)}, equals: ${q(r.equals)} },`);
    }
    out.push("    ],");
  }
  out.push("  },");

  out.push("", "  iris: {");
  if (spec.iris.className) out.push(`    className: ${q(spec.iris.className)},`);
  out.push(`    sourceDocType: ${q(spec.iris.sourceDocType)},`);
  out.push(`    targetDocType: ${q(spec.iris.targetDocType)},`);
  if (spec.iris.create) out.push(`    create: ${q(spec.iris.create)},`);
  if (spec.iris.log) out.push(`    log: ${q(spec.iris.log)},`);
  out.push("  },");

  const tables = Object.keys(spec.tables ?? {});
  if (tables.length) {
    out.push("", "  tables: {");
    for (const name of tables) {
      out.push(`    ${key(name)}: ${record(spec.tables![name], "    ")},`);
    }
    out.push("  },");
  }

  out.push("", "  blocks: [");
  for (const block of spec.blocks) {
    out.push("    {");
    out.push(`      id: ${q(block.id)},`);
    if (block.group) out.push(`      group: ${q(block.group)},`);
    if (block.note) out.push(`      note: ${q(block.note)},`);
    if (block.repeat) {
      const r = block.repeat;
      const parts = [`over: ${q(r.over)}`];
      if (r.skipWhenEmpty) parts.push(`skipWhenEmpty: ${q(r.skipWhenEmpty)}`);
      if (r.max !== undefined) parts.push(`max: ${r.max}`);
      out.push(`      repeat: { ${parts.join(", ")} },`);
    }
    out.push("      rows: [");
    for (const r of block.rows) out.push(`        ${row(r)},`);
    out.push("      ],");
    out.push("    },");
  }
  out.push("  ],");

  if (spec.sourceInventory?.length) {
    out.push("", "  sourceInventory: [");
    for (const item of spec.sourceInventory) {
      const parts = [`path: ${q(item.path)}`, `label: ${q(item.label)}`];
      if (item.required) parts.push("required: true");
      if (item.note) parts.push(`note: ${q(item.note)}`);
      out.push(`    { ${parts.join(", ")} },`);
    }
    out.push("  ],");
  }

  if (spec.outOfScope?.length) {
    out.push("", "  outOfScope: [");
    for (const s of spec.outOfScope) out.push(`    ${q(s)},`);
    out.push("  ],");
  }

  out.push("};");
  return out.join("\n");
}

/** The `import { ... } from "./spec";` statement this spec needs. */
export function importLine(spec: Spec, from = "./spec"): string {
  const names = [...constructorsUsed(spec), "type Spec"];
  const single = `import { ${names.join(", ")} } from ${q(from)};`;
  if (single.length <= 88) return single;

  // Wrapped by hand rather than by a formatter, because the bench ships no
  // formatter and a file that reformats itself on save is a diff nobody reads.
  const lines: string[] = ["import {"];
  let line = " ";
  for (const n of names) {
    if (line.length + n.length + 2 > 76) {
      lines.push(line.trimEnd());
      line = " ";
    }
    line += ` ${n},`;
  }
  if (line.trim() !== "") lines.push(line.trimEnd());
  lines.push(`} from ${q(from)};`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Splicing the literal back into an existing transform.ts
// ---------------------------------------------------------------------------

/** Walk past a quoted string starting at `i`, returning the index after it. */
function skipString(src: string, i: number): number {
  const quote = src[i];
  i++;
  while (i < src.length) {
    if (src[i] === "\\") { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    i++;
  }
  return -1;
}

/**
 * Index of the `}` matching the `{` at `open`, ignoring braces inside strings
 * and comments.
 *
 * Known limit: a backtick inside a `${}` interpolation would end the scan
 * early. No spec literal has one, and a spec literal that needs one is telling
 * you the value should have been a plain string.
 */
export function endOfObject(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i === -1) return -1;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      if (i === -1) return -1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// The brace body is `[^{}]*` and not `[\s\S]*?` on purpose. A lazy any-char
// body starts matching at the FIRST `import {` in the file and then stretches
// across the intervening statements to reach the closest `} from "./spec"`,
// which silently deletes every named import declared above this one. An import
// specifier list never contains a brace, so refusing to cross one keeps the
// match anchored to the statement it belongs to.
const SPEC_IMPORT = /import\s*\{[^{}]*\}\s*from\s*["']\.\/spec["'];?/;

/**
 * Replace the spec literal and the "./spec" import inside `file`, leaving every
 * other byte alone.
 *
 * Throws with a readable message rather than returning something it is not sure
 * about, because the caller overwrites `transform.ts` with the result.
 */
export function rewriteTransform(file: string, spec: Spec): string {
  const decl = file.indexOf("export const spec");
  if (decl === -1) {
    throw new Error(
      'Could not find "export const spec" in transform.ts, so there is nothing to replace.',
    );
  }
  const open = file.indexOf("{", decl);
  if (open === -1) throw new Error("Found the spec declaration but no opening brace after it.");
  const close = endOfObject(file, open);
  if (close === -1) throw new Error("The spec literal has no matching closing brace.");

  // Swallow a trailing semicolon so the generated one does not double up.
  let after = close + 1;
  while (after < file.length && /[ \t]/.test(file[after])) after++;
  if (file[after] === ";") after++;
  else after = close + 1;

  const head = file.slice(0, decl);
  const tail = file.slice(after);

  if (!SPEC_IMPORT.test(head)) {
    throw new Error('Could not find an import from "./spec" to update.');
  }
  return head.replace(SPEC_IMPORT, importLine(spec)) + specToSource(spec) + tail;
}
