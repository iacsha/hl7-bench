/**
 * emit.ts -- write an engine artifact for the spec in `transform.ts`.
 *
 *   bun emit.ts                      the DTL class            (default)
 *   bun emit.ts process              the business process template
 *   bun emit.ts tables               every lookup table, as import XML
 *   bun emit.ts tables --table Sex   one of them
 *
 *   bun emit.ts > My.cls             ...into a file you import into Studio
 *
 * The argument is `[engine:]artifact`. Bare names mean IRIS, because IRIS is the
 * only engine in front of us; `iris:process` spells it out and reads the same.
 * The seam is `emit/`, so a second engine is a new file there plus a row in the
 * table below, not a refactor of the spec.
 *
 * THREE ARTIFACTS, THREE DIFFERENT CLAIMS
 *
 *   dtl      Proven on the bench. Real messages went through that mapping and
 *            you read the output.
 *   process  A template. Nothing in it has been executed, because a business
 *            process needs a production and there isn't one here.
 *   tables   Data, not code. Verify the document shape against an export from
 *            your own portal once, then trust it.
 *
 * What comes out of any of them is still a starting point in one respect: the
 * DocType names, the lookup table contents, and the routing rule are yours to
 * confirm against the live namespace. A wrong DocType fails CLOSED -- paths stop
 * resolving, the output is empty, and nothing in the log says why.
 */

import { spec } from "./transform";
import { emitIris, routingCondition } from "./emit/iris";
import { emitProcess } from "./emit/process";
import { buildLookup } from "./emit/lookup";
import { fingerprint } from "./fingerprint";
import { emptyTables, validate } from "./spec";
import { logEvent } from "./log";

// ---------------------------------------------------------------------------

const ARTIFACTS = ["dtl", "process", "tables"] as const;
type Artifact = (typeof ARTIFACTS)[number];

const ENGINES = ["iris"] as const;

const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const tableFlag = (() => {
  const i = argv.indexOf("--table");
  return i === -1 ? undefined : argv[i + 1];
})();

// `iris` on its own has always meant the DTL and still does, so nobody's shell
// history breaks.
const raw = (positional[0] ?? "iris").toLowerCase();
const [left, right] = raw.includes(":") ? raw.split(":", 2) : [undefined, raw];

const engine = left ?? (ENGINES.includes(right as any) ? right : "iris");
const artifact: string = left === undefined && ENGINES.includes(right as any) ? "dtl" : right;

if (!ENGINES.includes(engine as any)) {
  process.stderr.write(
    `Unknown engine "${engine}". Known: ${ENGINES.join(", ")}\n` +
      `The argument is [engine:]artifact, e.g. iris:process, or just "process".\n`,
  );
  process.exit(2);
}
if (!ARTIFACTS.includes(artifact as Artifact)) {
  process.stderr.write(
    `Unknown artifact "${artifact}". Known: ${ARTIFACTS.join(", ")}\n` +
      `  dtl      the transform class, the default\n` +
      `  process  the business process template\n` +
      `  tables   lookup tables as an import document\n`,
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------

// Refuse to emit from a spec that does not hold together. A class that compiles
// from a broken spec is worse than no class, because it looks finished.
const problems = validate(spec);
if (problems.length > 0) {
  // Validation problems name rows and paths, never message values, so they
  // would be safe as fields. They go in as notes anyway: one rule about what
  // reaches disk at `summary` is easier to trust than a rule with exceptions.
  logEvent("emit", { spec: spec.name, engine, artifact, problems: problems.length, result: "invalid" }, problems);
  process.stderr.write(`Spec "${spec.name}" has ${problems.length} problem(s):\n`);
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.exit(1);
}

const stamp = fingerprint(spec);

// ---------------------------------------------------------------------------

if (artifact === "tables") {
  let built;
  try {
    built = buildLookup(spec, tableFlag);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
  }

  const fatal = built.problems.filter((p) => p.fatal);
  if (fatal.length > 0) {
    // Nothing is written. A lookup document that silently dropped rows would
    // import cleanly and translate the wrong subset, which is the failure this
    // whole artifact exists to prevent.
    logEvent("emit", { spec: spec.name, engine, artifact, problems: fatal.length, result: "invalid" });
    process.stderr.write(`${fatal.length} row(s) cannot be written, so nothing was:\n`);
    for (const p of fatal) process.stderr.write(`  - ${p.table}: ${p.problem}\n`);
    process.exit(1);
  }

  const total = Object.values(built.counts).reduce((a, b) => a + b, 0);
  logEvent("emit", {
    spec: spec.name, engine, artifact, fingerprint: stamp,
    tables: Object.keys(built.counts).length, rows: total,
    warnings: built.problems.length, result: "ok",
  });

  process.stdout.write(built.xml);

  process.stderr.write(`\nLOOKUP TABLES (${Object.keys(built.counts).length}), ${total} row(s)\n`);
  for (const [name, n] of Object.entries(built.counts)) {
    process.stderr.write(`  ${name}: ${n} row(s)${n === 0 ? "   *** EMPTY, a go-live gate ***" : ""}\n`);
  }

  for (const p of built.problems) {
    process.stderr.write(`\nwarning: ${p.table} key "${p.key}": ${p.problem}\n`);
  }

  process.stderr.write(
    `\nImport at Interoperability > Configure > Data Lookup Tables.\n` +
      `First time on this version: export a table you already have and diff the\n` +
      `shape against this. Thirty seconds once, and then you trust it.\n` +
      `\nThese are namespace DATA. They do not travel with a class export and they\n` +
      `do not travel with a production deployment. Promote this file with them.\n`,
  );

  process.exit(0);
}

// ---------------------------------------------------------------------------

let out: string;
try {
  out = artifact === "process" ? emitProcess(spec) : emitIris(spec);
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(2);
}

const empties = emptyTables(spec);

logEvent("emit", {
  spec: spec.name,
  engine,
  artifact,
  fingerprint: stamp,
  blocks: spec.blocks.length,
  rows: spec.blocks.reduce((n, b) => n + b.rows.length, 0),
  chars: out.length,
  emptyTables: empties.length,
  result: "ok",
});

process.stdout.write(out);

// Diagnostics on stderr so `bun emit.ts > My.cls` still shows them and the file
// still holds nothing but the class.
process.stderr.write(`\nSPEC FINGERPRINT\n  ${stamp}\n`);
process.stderr.write(
  `  The class carries the same string in its header. When a namespace is not\n` +
    `  behaving like the mapping you are reading, compare these two before you\n` +
    `  read the mapping again.\n`,
);

if (artifact === "process") {
  process.stderr.write(
    `\nTEMPLATE, not a proven artifact. Nothing in it has been executed.\n` +
      `  Config item to dispatch to: ${spec.iris.process!.sendTo}\n` +
      `  Confirm that spelling in the production. A name that does not resolve\n` +
      `  fails at run time, per message, not at compile time.\n`,
  );
}

process.stderr.write(`\nROUTING RULE CONDITION\n  ${routingCondition(spec)}\n`);
if (artifact === "process") {
  process.stderr.write(
    `  The process class filters on this too. Two copies of one gate: keep the\n` +
      `  rule's if a routing engine is in front, keep the class's if it is not.\n`,
  );
}

if (empties.length > 0) {
  process.stderr.write(
    `\nEMPTY LOOKUP TABLES (${empties.length}), each one a go-live gate:\n`,
  );
  for (const name of empties) {
    process.stderr.write(`  - ${name}: returns the unmapped branch for EVERY message\n`);
  }
}
