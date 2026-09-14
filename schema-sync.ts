#!/usr/bin/env bun
/**
 * schema-sync.ts -- keep the engine's schema category and the spec's agreeing.
 *
 *   bun schema-sync.ts                 compare; non-zero if they differ
 *   bun schema-sync.ts --import        write the spec's version into IRIS
 *   bun schema-sync.ts --derive DFT_P03 [--base 2.5]
 *                                      print the stock definition to start from
 *
 * WHY A MISSING CATEGORY IS THE EASY CASE
 *
 * `navcheck.ts` catches a category IRIS does not have: paths resolve to empty
 * and the mismatch is loud once you look.
 *
 * A category IRIS has but which is STALE passes navcheck. The structure walk
 * succeeds, every path resolves, and the message navigates -- under last
 * month's definition. If the sender has since moved a segment, or somebody
 * imported a hand-edited copy, the transform reads the wrong thing and
 * everything downstream agrees with it.
 *
 * So the check is not "does the category exist". It is "is the definition in
 * the engine byte-identical to the one this spec would emit".
 *
 * WHY --derive EXISTS
 *
 * A definition is several hundred characters of `~[~{~` and nobody should type
 * one. Start from the stock structure the sender is closest to, change only
 * what the feed forces, and the diff against stock is then reviewable -- which
 * is the thing you actually have to defend to whoever owns the interface.
 */

import { spec } from "./specfile";
import { emitSchema } from "./emit/schema";
import { validate, type CustomSchema } from "./spec";

import { CONTAINER, MODE, NAMESPACE, REMOTE, engineLabel, runIris } from "./iris-session";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const value = (n: string) => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};

function die(code: number, msg: string): never {
  process.stderr.write(`schema-sync: ${msg}\n`);
  process.exit(code);
  // Unreachable. There is no tsconfig here and no @types/node, so the compiler
  // cannot know process.exit returns never; this states it rather than leaving
  // every caller downstream of a die() looking possibly-undefined.
  throw new Error(msg);
}

function iris(objectScript: string): string {
  const { out } = runIris(
    "schema-sync",
    `zn "${NAMESPACE}"\n${objectScript}\nhalt\n`,
    (o) => o.trim() !== "",
  );
  return out;
}

/** One tagged line out of a session transcript, which echoes prompts around it. */
function tagged(out: string, tag: string): string | undefined {
  const line = out.split(/\r?\n/).find((l) => l.startsWith(tag + "|"));
  return line?.slice(tag.length + 1);
}

// ---------------------------------------------------------------------------

if (flag("--derive")) {
  const structure = value("--derive");
  const base = value("--base") ?? spec.iris.schema?.base ?? "2.5";
  if (!structure) die(1, "--derive needs a structure name, e.g. --derive DFT_P03");

  const out = iris(`write "DEF|",$get(^EnsHL7.Schema("${base}","MS","${structure}")),!`);
  const def = tagged(out, "DEF");
  if (!def) die(1, `no structure "${structure}" in category "${base}" on this instance`);

  process.stderr.write(
    `Stock ${base}:${structure}, ${def.length} characters.\n\n` +
      `Paste into iris.schema.structures and change ONLY what the feed forces.\n` +
      `Keeping the rest identical is what lets a conforming message still validate\n` +
      `exactly as it did, and what makes the diff against stock reviewable.\n\n`,
  );
  console.log(def);
  process.exit(0);
}

// ---------------------------------------------------------------------------

const problems = validate(spec);
if (problems.length > 0) {
  process.stderr.write(`Spec "${spec.name}" has ${problems.length} problem(s):\n`);
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.exit(1);
}

const declared = spec.iris.schema;
if (!declared) {
  console.log(`${spec.name} declares no custom schema. Nothing to sync.`);
  process.exit(0);
  throw new Error("unreachable");
}
const sch: CustomSchema = declared;

// What the engine holds right now, structure by structure.
const reads = sch.structures
  .map((st) => `write "DEF|${st.name}|",$get(^EnsHL7.Schema("${sch.category}","MS","${st.name}")),!`)
  .join("\n");
const live = iris(reads);

const drift: string[] = [];
const missing: string[] = [];
// Collected rather than written as they are found. The summary goes to stdout
// and detail written to stderr mid-loop arrives interleaved with it over ssh or
// a pipe, which puts the evidence above the finding it belongs to.
const detail: string[] = [];

for (const st of sch.structures) {
  const line = live.split(/\r?\n/).find((l) => l.startsWith(`DEF|${st.name}|`));
  const there = line?.slice(`DEF|${st.name}|`.length) ?? "";
  if (there === "") {
    missing.push(st.name);
  } else if (there !== st.definition) {
    drift.push(st.name);
    detail.push(
      `${st.name}: the engine's definition is NOT the spec's.`,
      `  engine ${there.length} chars, spec ${st.definition.length} chars`,
    );
    // The first difference, because on a 600-character definition the position
    // is the whole diagnosis and a full dump of both is unreadable.
    for (let i = 0; i < Math.max(there.length, st.definition.length); i++) {
      if (there[i] !== st.definition[i]) {
        detail.push(
          `  first difference at ${i}:`,
          `    engine ...${there.slice(Math.max(0, i - 24), i + 24)}`,
          `    spec   ...${st.definition.slice(Math.max(0, i - 24), i + 24)}`,
        );
        break;
      }
    }
  }
}

if (flag("--import")) {
  const xml = emitSchema(spec);
  const local = `.schema-sync-${process.pid}.xml`;
  await Bun.write(local, xml);

  // The engine reads its own filesystem, not ours. In docker that is the
  // mounted lab directory; natively the two are the same place.
  let remote = local;
  if (MODE === "docker") {
    const cp = Bun.spawnSync(["docker", "cp", local, `${CONTAINER}:${REMOTE}/${local}`]);
    if (cp.exitCode !== 0) die(2, `could not copy the schema into ${CONTAINER}`);
    remote = `${REMOTE}/${local}`;
  }

  const out = iris(
    `set sc = ##class(EnsLib.HL7.SchemaXML).Import("${remote}", .cat)\n` +
      `write "IMPORT|",$select($system.Status.IsOK(sc):"OK",1:$system.Status.GetErrorText(sc)),!\n` +
      `write "RESOLVES|",##class(EnsLib.HL7.Schema).ResolveSchemaTypeToDocType("${sch.category}","${sch.structures[0].name}"),!`,
  );
  await Bun.file(local).delete();
  if (MODE === "docker") Bun.spawnSync(["docker", "exec", CONTAINER, "rm", "-f", remote]);

  const status = tagged(out, "IMPORT");
  const resolves = tagged(out, "RESOLVES");
  if (status !== "OK") die(1, `import failed: ${status}`);

  console.log(`imported ${sch.category} (base ${sch.base}), ${sch.structures.length} structure(s)`);
  console.log(`resolves: ${resolves}`);
  console.log(`\nNext: bun navcheck.ts <a real message>.hl7`);
  process.exit(0);
}

// ---------------------------------------------------------------------------

console.log(`spec     ${sch.category} (base ${sch.base}), ${sch.structures.length} structure(s)`);
console.log(`engine   ${engineLabel()}`);
console.log("");

if (missing.length === 0 && drift.length === 0) {
  console.log("IN SYNC. The engine holds exactly what this spec would emit.");
  process.exit(0);
}

for (const n of missing) console.log(`  MISSING  ${n}  the engine has no such structure`);
for (const n of drift) console.log(`  STALE    ${n}  the engine has a DIFFERENT definition`);
if (detail.length) {
  console.log("");
  for (const l of detail) console.log(l);
}

console.log(`
Run:  bun schema-sync.ts --import

A STALE category is the dangerous one. It passes navcheck, because the message
does navigate: under the wrong definition. Everything downstream then agrees
with a reading nobody chose.`);
process.exit(1);
