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
import { transform, specPath, spec } from "./specfile";
import { runText } from "./run";
import { sourceFormat, targetFormat } from "./spec";
import { logEvent } from "./log";
import { readMessage } from "./input";
import { basename } from "node:path";

function die(msg: string): never {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

const { raw, source } = await readMessage("bench");

const t0 = performance.now();

// HL7 to HL7 keeps the in-place contract, so a spec file's own transform() and
// its diagnostics still run. A spec with XML on either side cannot turn the
// message into its output in place, and goes through runText instead.
const inPlace = sourceFormat(spec) === "hl7v2" && targetFormat(spec) === "hl7v2";
let out: string;
let delivered: number;

if (inPlace) {
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
  out = msg.toString();
  delivered = msg.segments.length;
} else {
  try {
    const r = runText(spec, raw);
    out = r.text;
    delivered = out.split("\n").length;
    if (process.env.HL7_BENCH_NOTES !== "off") {
      for (const note of r.result.notes) process.stderr.write(`  ${note}\n`);
    }
  } catch (e) {
    // Same rule as above: the refusal text is a note, not a field.
    const detail = e instanceof Error ? e.message : String(e);
    logEvent("bench", { source, bytes: raw.length, result: "threw" }, [detail]);
    die(`The spec could not run on this message:\n${detail}`);
  }
}
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
  segments: delivered,
  ms,
  result: "ok",
});

if (outFile) {
  await Bun.write(outFile, out);
  process.stderr.write(`OK  ${basename(specPath)}  ${ms} ms  ->  ${outFile}\n`);
} else {
  process.stdout.write(out);
  process.stderr.write(`OK  ${basename(specPath)}  ${ms} ms\n`);
}
