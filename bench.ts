#!/usr/bin/env bun
/**
 * Portable HL7 transform bench.
 *
 * A UNIX filter, which is the contract PipeHat's External Transform Provider
 * expects:
 *
 *     stdin   <- raw HL7
 *     stdout  -> transformed HL7
 *     stderr  -> diagnostics
 *     exit 0  =  success, non-zero = failure
 *
 * No install, no admin, no service, no container. One bun.exe and these files.
 *
 * You edit transform.ts. This file you can ignore.
 *
 * SAVING THE OUTPUT
 *
 *   bun bench.ts -o messages\out.hl7  < messages\in.hl7
 *
 * Use -o rather than a PowerShell `>` redirect. PowerShell writes a UTF-8 BOM
 * ahead of the first byte, so the file starts EF BB BF 4D 53 48 instead of
 * "MSH". This bench survives it -- JavaScript's trim() happens to strip U+FEFF
 * -- but a byte comparison against a golden file fails, and plenty of receivers
 * and diff tools reject the message outright. -o writes the bytes and nothing
 * else.
 */

import { Message } from "./hl7";
import { transform } from "./transform";
import { logEvent } from "./log";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const FALLBACK = join(import.meta.dir, "sample.hl7");

function die(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

const piped = await Bun.stdin.text();
let raw = piped;
// Named for the log. A piped message has no filename to record, and saying
// so is more honest than recording the fallback path for a run that never
// touched it.
let source = "stdin";
if (raw.trim().length === 0) {
  source = FALLBACK;
  // Run by hand with no pipe -- use the sample so the thing is never a no-op.
  if (!existsSync(FALLBACK)) die(`No message on stdin and no ${FALLBACK} to fall back to.`);
  raw = readFileSync(FALLBACK, "utf8");
}

const t0 = performance.now();

let msg: Message;
try {
  msg = new Message(raw);
} catch (e) {
  const detail = e instanceof Error ? e.message : String(e);
  logEvent("bench", { source, bytes: raw.length, result: "unparseable" }, [detail]);
  die(`Could not parse the message.\n${detail}`);
}

try {
  transform(msg);
} catch (e) {
  // The error a learner hits constantly. Show the stack: the line number in
  // transform.ts is the single most useful thing on the screen.
  const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
  // The detail goes in as a note, not a field. A gate refusal reaches here
  // carrying the value that was refused, and a `require` rule can read any
  // path, so this text is exactly as sensitive as the notes are.
  logEvent("bench", { source, bytes: raw.length, result: "threw" }, [detail]);
  die(`transform() threw:\n${detail}`);
}

const out = msg.toString();
const ms = Math.round(performance.now() - t0);

// -o writes the file itself instead of leaning on the shell. See the header:
// a PowerShell redirect prepends a BOM and quietly breaks byte comparison.
const oi = process.argv.findIndex((a) => a === "-o" || a === "--out");
const outFile = oi === -1 ? null : process.argv[oi + 1];

if (oi !== -1 && !outFile) die("-o needs a filename after it.");

logEvent("bench", {
  source,
  out: outFile ?? "stdout",
  bytesIn: raw.length,
  bytesOut: out.length,
  segments: msg.segments.length,
  ms,
  result: "ok",
});

if (outFile) {
  await Bun.write(outFile, out);
  process.stderr.write(`OK  transform.ts  ${ms} ms  ->  ${outFile}\n`);
} else {
  process.stdout.write(out);
  process.stderr.write(`OK  transform.ts  ${ms} ms\n`);
}
