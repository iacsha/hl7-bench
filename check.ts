#!/usr/bin/env bun
/**
 * check.ts -- the golden gate. Convention over configuration.
 *
 *   bun check.ts              every case in messages\
 *   bun check.ts a01          only cases whose name contains "a01"
 *
 * Drop files in messages\ and name them. Nothing to register, nothing to edit:
 *
 *   <name>.in.hl7       the message you receive
 *   <name>.want.hl7     what transform.ts must produce from it
 *   <name>.reject.hl7   a message transform.ts must REFUSE
 *
 * A case is <name>.in.hl7 plus <name>.want.hl7. A rejection case is a lone
 * <name>.reject.hl7 -- no want file, because a refused message has no output.
 *
 * WHY THIS EXISTS
 *
 * The bench's own tests prove the PARSER is right. This proves the INTERFACE is
 * right, against a target somebody else specified. Two different claims, and
 * only the second one is the thing you get paged about.
 *
 * WHY REJECTION CASES ARE NOT OPTIONAL
 *
 * An interface that "permits two events" is an untested adjective until you have
 * watched it refuse the third. The failure this catches -- a trigger event
 * falling through an unnamed else branch and reaching the receiver as something
 * it is not -- does not announce itself. It looks like a working interface right
 * up until someone downstream asks why a discharge became a registration.
 *
 * WHEN YOU MOVE TO AN ENGINE
 *
 * Keep this green through the build. Dump the engine's output to a file, diff it
 * against the same .want.hl7, and the bench becomes the reference implementation
 * -- any divergence is an engine bug rather than an argument about what the spec
 * meant three months ago.
 */

import { Message } from "./hl7";
import { transform } from "./transform";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "messages");

if (!existsSync(DIR)) {
  console.error(`No messages\\ folder yet. Create it and add <name>.in.hl7 and <name>.want.hl7.`);
  process.exit(2);
}

const filter = process.argv[2]?.toLowerCase();
const files = readdirSync(DIR);

interface Case {
  name: string;
  input: string;
  want: string | null;   // null = this message must be refused
}

const cases: Case[] = [];

for (const f of files) {
  if (f.endsWith(".in.hl7")) {
    const name = f.slice(0, -".in.hl7".length);
    const want = `${name}.want.hl7`;
    if (!files.includes(want)) {
      console.error(`SKIP  ${name}  -- has ${f} but no ${want}`);
      continue;
    }
    cases.push({ name, input: f, want });
  } else if (f.endsWith(".reject.hl7")) {
    cases.push({ name: f.slice(0, -".reject.hl7".length), input: f, want: null });
  }
}

const chosen = filter ? cases.filter((c) => c.name.toLowerCase().includes(filter)) : cases;

if (chosen.length === 0) {
  console.error(
    filter
      ? `No cases matching "${filter}". Found: ${cases.map((c) => c.name).join(", ") || "(none)"}`
      : `No cases in messages\\. Name them <name>.in.hl7 + <name>.want.hl7, or <name>.reject.hl7.`,
  );
  process.exit(2);
}

/** Compare on segments, ignoring line-ending style and trailing blank lines. */
function segments(raw: string): string[] {
  return raw.split(/\r\n|\r|\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
}

function run(c: Case): boolean {
  const msg = new Message(readFileSync(join(DIR, c.input), "utf8"));

  if (c.want === null) {
    try {
      transform(msg);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      console.log(`PASS  ${c.name}  refused: ${m.slice(0, 58)}${m.length > 58 ? "..." : ""}`);
      return true;
    }
    console.log(`FAIL  ${c.name}  was NOT refused -- it transformed and would have been delivered`);
    return false;
  }

  try {
    transform(msg);
  } catch (e) {
    console.log(`FAIL  ${c.name}  threw: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }

  const got = segments(msg.toString());
  const want = segments(readFileSync(join(DIR, c.want), "utf8"));

  const bad: string[] = [];
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (got[i] !== want[i]) {
      bad.push(`      line ${i + 1}\n        got  ${got[i] ?? "(absent)"}\n        want ${want[i] ?? "(absent)"}`);
    }
  }

  if (bad.length === 0) {
    console.log(`PASS  ${c.name}  ${got.length} segments identical`);
    return true;
  }
  console.log(`FAIL  ${c.name}  ${bad.length} differing line(s):\n${bad.join("\n")}`);
  return false;
}

const results = chosen.map(run);
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} cases passed`);
process.exit(failed === 0 ? 0 : 1);
