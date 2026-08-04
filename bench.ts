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
 */

import { Message } from "./hl7";
import { transform } from "./transform";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const FALLBACK = join(import.meta.dir, "sample.hl7");

function die(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

const piped = await Bun.stdin.text();
let raw = piped;
if (raw.trim().length === 0) {
  // Run by hand with no pipe -- use the sample so the thing is never a no-op.
  if (!existsSync(FALLBACK)) die(`No message on stdin and no ${FALLBACK} to fall back to.`);
  raw = readFileSync(FALLBACK, "utf8");
}

const t0 = performance.now();

let msg: Message;
try {
  msg = new Message(raw);
} catch (e) {
  die(`Could not parse the message.\n${e instanceof Error ? e.message : String(e)}`);
}

try {
  transform(msg);
} catch (e) {
  // The error a learner hits constantly. Show the stack: the line number in
  // transform.ts is the single most useful thing on the screen.
  const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
  die(`transform() threw:\n${detail}`);
}

process.stdout.write(msg.toString());
process.stderr.write(`OK  transform.ts  ${Math.round(performance.now() - t0)} ms\n`);
