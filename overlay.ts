#!/usr/bin/env bun
/**
 * overlay.ts -- add changes to an existing business process and see what they
 * do to a real message, without rewriting the class.
 *
 *     bun overlay.ts OrigClass.cls messages\real.hl7 --doctype Vendor:ADT_A01
 *     bun overlay.ts OrigClass.cls messages\real.hl7 --run
 *     bun overlay.ts OrigClass.cls messages\real.hl7 --run -o OrigClass.modified.cls
 *     bun overlay.ts gui OrigClass.cls messages\real.hl7      the page, on :7318
 *
 * The changes live in `OrigClass.changes.local.json` beside the class (created
 * on first run, gitignored by the *.local.json rule). Edit it, or use the page.
 * See overlay-core.ts for what an overlay is and what it refuses.
 *
 * `--schema dump.txt` reads the DocType's structure from a pasted
 * `zw ^EnsHL7.Schema("<cat>","MS","<struct>","map")` instead of asking the
 * engine -- for a box that cannot reach IRIS. Without either, nothing runs:
 * the paths cannot be indexed, and an unindexed repeating path reads empty.
 *
 * NO SPEC IS NEEDED. This tool does not read HL7_BENCH_TRANSFORM, so an unset
 * or stale one does not stop it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { decodeText } from "./input";
import { runHosted, schemaMapFromEngine, type HostedResult } from "./engine-core";
import {
  diffLines, diffMessages, keysFromZw, overlayClass, schemaFromKeys,
  type FieldChange, type LineDiff, type Overlay, type SchemaMap,
} from "./overlay-core";

// ---------------------------------------------------------------------------
// The session: one base class, one changes file, one message
// ---------------------------------------------------------------------------

export interface Session {
  basePath: string;
  changesPath: string;
  messagePath: string;
  overlay: Overlay;
  schemaFile?: string;
}

/** The changes file that belongs to a class: `X.cls` -> `X.changes.local.json`. */
export function changesPathFor(basePath: string): string {
  return join(dirname(basePath), basename(basePath).replace(/\.cls$/i, "") + ".changes.local.json");
}

export function readOverlay(changesPath: string): Overlay {
  const raw = readFileSync(changesPath, "utf8").replace(/^﻿/, "");
  const o = JSON.parse(raw) as Overlay;
  o.changes ??= [];
  return o;
}

export function writeOverlay(changesPath: string, o: Overlay): void {
  writeFileSync(changesPath, JSON.stringify(o, null, 2) + "\n", "utf8");
}

export function readText(path: string): string {
  return decodeText(readFileSync(path)).text;
}

/**
 * Open (or create) the changes file for a class. `--doctype` overrides what the
 * file says and is written back, so it is typed once.
 */
export function openSession(basePath: string, messagePath: string, docType?: string, schemaFile?: string): Session {
  const base = resolve(basePath);
  if (!existsSync(base)) throw new Error(`${basePath} does not exist.`);
  const changesPath = changesPathFor(base);
  let overlay: Overlay;
  if (existsSync(changesPath)) {
    overlay = readOverlay(changesPath);
    if (docType && overlay.docType !== docType) {
      overlay.docType = docType;
      writeOverlay(changesPath, overlay);
    }
  } else {
    if (!docType) {
      throw new Error(
        `No changes file yet (${basename(changesPath)}), so the DocType is unknown.\n` +
          `Add --doctype, e.g. --doctype Vendor:ADT_A01 -- read it off a message in the Message Viewer.`,
      );
    }
    overlay = { base: basename(base), docType, changes: [] };
    writeOverlay(changesPath, overlay);
  }
  return { basePath: base, changesPath, messagePath: resolve(messagePath), overlay, schemaFile };
}

/** The structure map, from the dump file if given, else from the engine. */
export function loadSchema(s: Session): { schema?: SchemaMap; error?: string; from: string } {
  if (s.schemaFile) {
    const { docType, keys } = keysFromZw(readText(s.schemaFile));
    if (keys.length === 0) return { error: `${s.schemaFile} holds no ^EnsHL7.Schema(...,"map",...) rows.`, from: s.schemaFile };
    if (docType && docType !== s.overlay.docType) {
      return { error: `${s.schemaFile} is the map for ${docType}, but the changes are for ${s.overlay.docType}.`, from: s.schemaFile };
    }
    return { schema: schemaFromKeys(s.overlay.docType, keys), from: s.schemaFile };
  }
  const r = schemaMapFromEngine(s.overlay.docType);
  if (r.error) return { error: r.error, from: "the engine" };
  if (r.keys.length === 0) {
    const [cat] = s.overlay.docType.split(":");
    return {
      error:
        `The engine has no structure for ${s.overlay.docType}. Category "${cat}" is not in this namespace ` +
        `(or the structure name is wrong), so every path would read empty. Export the "${cat}" schema from ` +
        `the namespace that has it and load it here, or pass --schema with a zw dump of its map.`,
      from: "the engine",
    };
  }
  return { schema: schemaFromKeys(s.overlay.docType, r.keys), from: "the engine" };
}

export interface Result {
  problems: string[];
  notes: string[];
  modified?: string;
  classDiff?: LineDiff;
  before?: HostedResult;
  after?: HostedResult;
  fields?: FieldChange[];
}

/** Generate, and optionally run both classes on the message. */
export function evaluate(s: Session, schema: SchemaMap, run: boolean, messageText?: string): Result {
  const baseText = readText(s.basePath);
  const r = overlayClass(s.overlay, baseText, schema, { changesFile: basename(s.changesPath) });
  if (r.problems.length > 0 || r.text === undefined) return { problems: r.problems, notes: r.notes };
  const classDiff = diffLines(baseText.split(/\r?\n/), r.text.split(/\r?\n/));
  const result: Result = { problems: [], notes: r.notes, modified: r.text, classDiff };
  if (!run) return result;

  const message = messageText ?? readText(s.messagePath);
  result.before = runHosted({ source: baseText, message, docType: s.overlay.docType });
  result.after = runHosted({ source: r.text, message, docType: s.overlay.docType });
  if (result.before.segments && result.after.segments) {
    result.fields = diffMessages(result.before.segments, result.after.segments);
  }
  return result;
}

/** The sentence for a run that did not deliver, or "" when it did. */
export function explainRun(label: string, h: HostedResult): string {
  if (h.error) return `${label}: ${h.error}`;
  if (h.segments) return "";
  if (h.status) return `${label}: OnRequest returned an error and sent nothing: ${h.status}`;
  return `${label}: the class sent nothing for this message. It filtered it (a pre-admit, or an event its gate does not permit).`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function positional(argv: string[]): string[] {
  const takesValue = new Set(["--doctype", "--schema", "-o", "--out", "--port"]);
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (takesValue.has(argv[i]!)) { i++; continue; }
    if (argv[i]!.startsWith("-")) continue;
    out.push(argv[i]!);
  }
  return out;
}

function die(lines: string[]): never {
  process.stderr.write(lines.map((l) => `overlay: ${l}`).join("\n") + "\n");
  process.exit(2);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "gui") {
    await import("./overlay-gui");
  } else {
    const [basePath, messagePath] = positional(argv);
    if (!basePath || !messagePath) {
      die([
        `usage: bun overlay.ts <Class.cls> <message.hl7> [--doctype Cat:Struct] [--schema zw.txt] [--run] [-o Out.cls]`,
        `       bun overlay.ts gui <Class.cls> <message.hl7> [--doctype Cat:Struct] [--schema zw.txt]`,
      ]);
    }
    let s: Session;
    try {
      s = openSession(basePath, messagePath, flag(argv, "--doctype"), flag(argv, "--schema"));
    } catch (e) {
      die([(e as Error).message]);
    }
    process.stderr.write(`\n  class    ${s.basePath}\n  changes  ${s.changesPath} (${s.overlay.changes.length})\n  doctype  ${s.overlay.docType}\n`);
    const sc = loadSchema(s);
    if (!sc.schema) die([sc.error!]);
    process.stderr.write(`  schema   ${sc.schema.segments.size} segments, from ${sc.from}\n\n`);

    const run = argv.includes("--run");
    const r = evaluate(s, sc.schema, run);
    if (r.problems.length > 0) die(["the changes cannot be applied:", ...r.problems.map((p) => `  - ${p}`)]);

    process.stdout.write(`CLASS CHANGES\n`);
    for (const d of r.classDiff!) if (d.op !== " ") process.stdout.write(`${d.op} ${d.text}\n`);
    if (s.overlay.changes.length === 0) process.stdout.write(`  (none -- add changes to ${basename(s.changesPath)}, or use: bun overlay.ts gui ...)\n`);
    process.stdout.write(`\nWHAT THE NEW CODE DOES\n${r.notes.map((n) => `  ${n}`).join("\n")}\n`);

    if (run) {
      const bad = [explainRun("before", r.before!), explainRun("after", r.after!)].filter(Boolean);
      for (const b of bad) process.stdout.write(`\n${b}\n`);
      if (r.after?.segments) {
        process.stdout.write(`\nMESSAGE AFTER (sent to ${r.after.sentTo})\n${r.after.segments.join("\n")}\n`);
      }
      if (r.fields) {
        process.stdout.write(`\nFIELDS CHANGED\n`);
        if (r.fields.length === 0) process.stdout.write(`  none -- the change did nothing to this message\n`);
        for (const f of r.fields) {
          process.stdout.write(`  ${f.segment}${f.occurrence > 1 ? `(${f.occurrence})` : ""} ${f.field}\n    before  ${f.before || "(empty)"}\n    after   ${f.after || "(empty)"}\n`);
        }
      }
    }

    const out = flag(argv, "-o") ?? flag(argv, "--out");
    if (out) {
      writeFileSync(out, r.modified!, "utf8");
      process.stderr.write(`\n  wrote ${out}. The class name inside is unchanged, so it deploys over the original.\n`);
    }
  }
}
