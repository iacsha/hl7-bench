/**
 * emit.ts -- write the engine artifact for the spec in `transform.ts`.
 *
 *   bun emit.ts              IRIS DTL class to stdout
 *   bun emit.ts > My.cls     ...into a file you import into Studio
 *
 * There is exactly one backend today because there is exactly one engine in
 * front of us. The seam is `emit/`, so a second engine is a new file there plus
 * a case below, not a refactor of the spec.
 *
 * What comes out is a starting class, not a finished interface. It compiles and
 * it says what the spec says, but the DocType names, the lookup table contents,
 * and the routing rule are yours to confirm against the live namespace. A wrong
 * DocType fails CLOSED: paths stop resolving, the output is empty, and nothing
 * in the log says why.
 */

import { spec } from "./transform";
import { emitIris, routingCondition } from "./emit/iris";
import { emptyTables, validate } from "./spec";
import { logEvent } from "./log";

const BACKENDS: Record<string, (s: typeof spec) => string> = {
  iris: emitIris,
};

const which = (process.argv[2] ?? "iris").toLowerCase();
const backend = BACKENDS[which];
if (!backend) {
  const known = Object.keys(BACKENDS).join(", ");
  process.stderr.write(`Unknown engine "${which}". Known: ${known}\n`);
  process.exit(2);
}

// Refuse to emit from a spec that does not hold together. A class that compiles
// from a broken spec is worse than no class, because it looks finished.
const problems = validate(spec);
if (problems.length > 0) {
  // Validation problems name rows and paths, never message values, so they
  // would be safe as fields. They go in as notes anyway: one rule about what
  // reaches disk at `summary` is easier to trust than a rule with exceptions.
  logEvent("emit", { spec: spec.name, engine: which, problems: problems.length, result: "invalid" }, problems);
  process.stderr.write(`Spec "${spec.name}" has ${problems.length} problem(s):\n`);
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.exit(1);
}

const artifact = backend(spec);
const empties = emptyTables(spec);

logEvent("emit", {
  spec: spec.name,
  engine: which,
  blocks: spec.blocks.length,
  rows: spec.blocks.reduce((n, b) => n + b.rows.length, 0),
  chars: artifact.length,
  emptyTables: empties.length,
  result: "ok",
});

process.stdout.write(artifact);

// Diagnostics on stderr so `bun emit.ts > My.cls` still shows them and the file
// still holds nothing but the class.
process.stderr.write(`\nROUTING RULE CONDITION\n  ${routingCondition(spec)}\n`);

if (empties.length > 0) {
  process.stderr.write(
    `\nEMPTY LOOKUP TABLES (${empties.length}), each one a go-live gate:\n`,
  );
  for (const name of empties) {
    process.stderr.write(`  - ${name}: returns the unmapped branch for EVERY message\n`);
  }
}
