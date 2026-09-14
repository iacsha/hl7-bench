#!/usr/bin/env bun
/**
 * navcheck.ts -- does this message actually navigate under its DocType?
 *
 *   bun navcheck.ts messages/yours.hl7
 *   bun navcheck.ts messages/yours.hl7 --doctype 2.5:DFT_P03
 *
 * WHY THIS EXISTS
 *
 * `run.ts` walks segments. It asks the message for every OBX and gets every
 * OBX, because that is what an array scan does.
 *
 * The DTL walks the SCHEMA. `<foreach property='source.{OBX()}'>` asks IRIS to
 * resolve a structure path, and IRIS answers from the DocType's definition --
 * not from what is in the message.
 *
 * On a conforming message those two are the same answer. On a message the
 * schema does not describe they are not, and the failure has no symptom: the
 * structure walk stops at the first violation, every path past it resolves to
 * EMPTY rather than erroring, the transform runs, and a well-formed message
 * comes out the far end with nothing in it.
 *
 * That cost an afternoon on the EXA radiology DFT. The feed omits EVN, which
 * 2.5 requires, and puts OBR and OBX after GT1, where DFT_P03 has nowhere to
 * put them. The bench delivered 43 segments, the engine delivered 0, and the
 * whole test suite was green, because nothing in the bench models schema
 * navigation at all.
 *
 * So this asks the engine. It is the one question the bench cannot answer
 * about itself, and it needs an IRIS to answer it -- the same IRIS the
 * transform will run on, reached the same way `xform.ts` reaches it.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not validate the message against the schema. `Validate()` already
 * does that and answers a different question: "is this legal HL7". A message
 * can fail validation and still navigate fine, and a message can carry
 * warnings that do not matter. The only question here is whether the paths
 * THIS SPEC READS return what is really in the message.
 */

import { spec } from "./specfile";
import { Message } from "./hl7";
import { segmentOf, sourcePathsOf, type Spec } from "./spec";
import { dtlPath } from "./emit/iris";

const MODE = (process.env.IRIS_MODE ?? "docker").toLowerCase();
const CONTAINER = process.env.IRIS_CONTAINER ?? "iris-lab";
const INSTANCE = process.env.IRIS_INSTANCE ?? "IRIS";
const NAMESPACE = process.env.IRIS_NAMESPACE ?? "USER";
const IRIS_EXE = process.env.IRIS_EXE ?? "iris";
/** Where the message is readable FROM INSIDE the engine. */
const REMOTE = process.env.IRIS_LAB_DIR ?? "/lab";

function die(code: number, msg: string): never {
  process.stderr.write(`navcheck: ${msg}\n`);
  process.exit(code);
}

/**
 * Every source path the spec reads, plus the ones a repeat reads on its own.
 *
 * `sourcePathsOf` covers rows. It does not cover `repeat.over`,
 * `skipWhenEmpty`, `select.path` or `fold.path` -- and those are exactly the
 * paths that decide how many segments exist, so a spec can navigate perfectly
 * on every row and still deliver nothing.
 */
function pathsRead(s: Spec): string[] {
  const out = new Set<string>();
  for (const b of s.blocks) {
    const r = b.repeat;
    if (r) {
      if (r.skipWhenEmpty) out.add(r.skipWhenEmpty);
      if (r.select) out.add(r.select.path);
      if (r.fold) out.add(r.fold.path);
    }
    for (const row of b.rows) for (const p of sourcePathsOf(row.from)) out.add(p);
  }
  return [...out].sort();
}

/** Segment ids the spec walks with a <foreach>, which address as SEG(k). */
function repeatedSegments(s: Spec): Set<string> {
  return new Set(s.blocks.filter((b) => b.repeat).map((b) => b.repeat!.over));
}

/**
 * The reference the EMITTER would write for this path, with occurrence 1
 * standing in for the loop key.
 *
 * Built with `dtlPath` rather than assembled here, so this checks the paths the
 * DTL will really contain. A checker that constructs its own spelling tests its
 * own spelling: `OBX:5` resolves to nothing on a repeating segment whether or
 * not the schema is right, and reporting that as a finding is how a checker
 * gets ignored inside a week.
 */
function namedRef(path: string, repeats: Set<string>): string {
  const seg = segmentOf(path);
  return repeats.has(seg) ? dtlPath(path, `${seg}(1)`) : dtlPath(path);
}

const file = process.argv.slice(2).find((a) => a.endsWith(".hl7"));
if (!file) die(1, "name a .hl7 file");

const dtArg = process.argv.indexOf("--doctype");
const docType = dtArg > -1 ? process.argv[dtArg + 1] : spec.iris.sourceDocType;

const raw = await Bun.file(file).text();
const msg = new Message(raw);

// The truth, from an array scan. This is what run.ts sees, and it is what the
// engine ought to agree with.
const truth = new Map<string, number>();
for (const s of msg.segments) truth.set(s.id, (truth.get(s.id) ?? 0) + 1);

const paths = pathsRead(spec);
const repeats = repeatedSegments(spec);
const segments = [...new Set([...paths.map(segmentOf), ...repeats])].sort();

const objectScript = [
  `zn "${NAMESPACE}"`,
  `set st=##class(%Stream.FileCharacter).%New(), sc=st.LinkToFile("${REMOTE}/${file.split("/").pop()}")`,
  `set msg=##class(EnsLib.HL7.Message).ImportFromLibraryStream(st,.sc)`,
  `do msg.PokeDocType("${docType}")`,
  `write "DOCTYPE|",msg.DocType,!`,
  `write "SEGCOUNT|",msg.SegCount,!`,
  // `(*)` counts occurrences and answers nothing for a segment the schema says
  // appears once, so only repeating segments are counted that way. The rest are
  // asked whether they are reachable at all.
  ...segments.map((s) =>
    repeats.has(s)
      ? `write "SEG|${s}|",+msg.GetValueAt("${s}(*)"),!`
      : `write "SEG|${s}|",$select(msg.GetValueAt("${s}:0")="":0,1:1),!`,
  ),
  ...paths.map(
    (p) =>
      `write "PATH|${p}|",$select(msg.GetValueAt("${namedRef(p, repeats).slice(1, -1)}")="":"EMPTY",1:"OK"),!`,
  ),
  `halt`,
].join("\n");

const cmd =
  MODE === "docker"
    ? ["docker", "exec", "-i", CONTAINER, "iris", "session", INSTANCE]
    : [IRIS_EXE, "session", INSTANCE];

const p = Bun.spawnSync(cmd, {
  stdin: new TextEncoder().encode(objectScript + "\n"),
  stdout: "pipe",
  stderr: "pipe",
});
const out = p.stdout.toString();
if (p.exitCode !== 0 && !out.includes("DOCTYPE|")) {
  die(2, `could not reach IRIS (${MODE}): ${p.stderr.toString().trim() || "no output"}`);
}

const got = (tag: string) =>
  out
    .split(/\r?\n/)
    .filter((l) => l.startsWith(tag + "|"))
    .map((l) => l.split("|"));

const resolvedDocType = got("DOCTYPE")[0]?.[1] ?? "(none)";

/**
 * Did the engine actually get the message?
 *
 * `LinkToFile` on a path that is not there returns a status nobody reads, and
 * `ImportFromLibraryStream` then hands back an empty message. Every segment
 * resolves 0, which is indistinguishable from the schema violation this tool
 * exists to report -- so it reported one: five mismatches and a recommendation
 * to write a custom schema, for a message the engine never opened. A checker
 * that cries schema on a missing file gets ignored inside a week.
 *
 * The engine reads `REMOTE/<basename>`, not the path you typed. In docker mode
 * that is the mounted lab directory, so a file sitting in the bench folder is
 * not a file the engine can see.
 */
const segCount = Number(got("SEGCOUNT")[0]?.[1] ?? 0);
if (segCount === 0 || resolvedDocType === "" || resolvedDocType === "(none)") {
  die(
    2,
    `the engine read no message.\n` +
      `  it opened          ${REMOTE}/${file.split("/").pop()}\n` +
      `  doctype resolved   ${resolvedDocType || "(empty)"}\n` +
      `  segments seen      ${segCount}\n` +
      `  this file carries  ${msg.segments.length}\n\n` +
      `This is NOT a schema finding. Put the message where the engine can read it\n` +
      `(${REMOTE} inside the engine; set IRIS_LAB_DIR if it lives elsewhere), then re-run.`,
  );
}

const problems: string[] = [];

console.log(`message   ${file}`);
console.log(`doctype   ${resolvedDocType}`);
console.log("");
console.log("SEGMENT   in message   via schema   ");
console.log("-------   ----------   ----------   ");
for (const [, seg, count] of got("SEG")) {
  const realCount = truth.get(seg) ?? 0;
  const real = repeats.has(seg) ? realCount : Math.min(realCount, 1);
  const named = Number(count || 0);
  const flag = named === real ? "" : "   <-- MISMATCH";
  console.log(`${seg.padEnd(9)} ${String(real).padEnd(12)} ${String(named).padEnd(12)}${flag}`);
  if (named !== real) {
    problems.push(
      `${seg}: the message carries ${real}, the schema resolves ${named}. ` +
        `Every ${seg} path in the transform reads what the SCHEMA says is there.`,
    );
  }
}

const empties = got("PATH").filter(([, , v]) => v === "EMPTY");
if (empties.length) {
  console.log("");
  console.log("paths that resolve EMPTY under this doctype:");
  for (const [, path] of empties) {
    // Empty for a real reason, or empty because navigation never reached it?
    // Different problems, different fixes, and they look identical here.
    const present = msg.get(path) !== "";
    console.log(`  ${path.padEnd(14)}${present ? "but the message HAS a value <-- MISMATCH" : "(the message is empty here too)"}`);
    if (present) problems.push(`${path}: present in the message, empty via the schema.`);
  }
}

console.log("");
if (problems.length === 0) {
  console.log("OK. Every path this spec reads resolves the same way the bench reads it.");
  process.exit(0);
}

console.log(`${problems.length} mismatch(es). The bench and the engine will disagree:\n`);
for (const p of problems) console.log(`  - ${p}`);
console.log(`
A mismatch means the message does not conform to ${resolvedDocType} in a way that
stops the structure walk. Everything after the first violation is unreachable by
name, and it fails SILENTLY: paths resolve to empty rather than erroring.

The fix is a custom schema category that describes the feed as it really is --
not a change to the transform. See Notes/custom-schema.md.`);
process.exit(1);
