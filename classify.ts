#!/usr/bin/env bun
/**
 * classify.ts -- answer Question 2 mechanically.
 *
 *   bun classify.ts have.hl7 want.hl7
 *
 * Give it the message you HAVE and the message you WANT. It reports every
 * difference, sorted into the five kinds from METHOD.md, and prints the sizing
 * line that tells you how much work the interface actually is.
 *
 * This is the step that decides everything downstream. An interface whose diff
 * comes back "segment set" is a whitelist and about seven lines of DTL. One that
 * comes back "field value" and "code translation" is a mapping document and a
 * fortnight. Knowing which one you are holding, on day one, is the difference.
 *
 * What it CANNOT tell you is Question 3 -- whether a difference is a rule or an
 * accident of this one sample. Two messages cannot answer that; only the sending
 * and receiving analysts can. Every line this prints is a question to ask, not a
 * fact to encode.
 */

import { Message, Segment } from "./hl7";
import { readFileSync } from "node:fs";

/**
 * Fields that describe the MESSAGE rather than the PATIENT. Changes here are
 * metadata, and they usually travel in groups -- change the trigger event and
 * you almost always owe EVN-1 and the doctype as well.
 */
const METADATA = new Set(["MSH-9", "MSH-10", "MSH-11", "MSH-12", "EVN-1", "EVN-2"]);

/** Highest field number present, accounting for the MSH off-by-one. */
function fieldCount(seg: Segment, delim: string): number {
  const n = seg.toString().split(delim).length;
  return seg.id === "MSH" ? n : n - 1;
}

function segKey(id: string, occurrence: number): string {
  return occurrence === 1 ? id : `${id}#${occurrence}`;
}

/** Segment ids in order, with occurrence numbers, so NK1#2 lines up with NK1#2. */
function keyed(msg: Message): Map<string, Segment> {
  const seen: Record<string, number> = {};
  const out = new Map<string, Segment>();
  for (const s of msg.segments) {
    seen[s.id] = (seen[s.id] ?? 0) + 1;
    out.set(segKey(s.id, seen[s.id]!), s);
  }
  return out;
}

const [srcPath, tgtPath] = process.argv.slice(2);
if (!srcPath || !tgtPath) {
  console.error("usage: bun classify.ts <have.hl7> <want.hl7>");
  process.exit(2);
}

const src = new Message(readFileSync(srcPath, "utf8"));
const tgt = new Message(readFileSync(tgtPath, "utf8"));
const a = keyed(src);
const b = keyed(tgt);

const dropped: string[] = [];
const added: string[] = [];
const metaChanges: string[] = [];
const valueChanges: string[] = [];

for (const k of a.keys()) if (!b.has(k)) dropped.push(k);
for (const k of b.keys()) if (!a.has(k)) added.push(k);

for (const [k, segA] of a) {
  const segB = b.get(k);
  if (!segB) continue;

  const max = Math.max(fieldCount(segA, src.delims.field), fieldCount(segB, tgt.delims.field));
  for (let f = 1; f <= max; f++) {
    if (segA.id === "MSH" && f === 1) continue;   // MSH-1 IS the delimiter
    const va = segA.getField(f);
    const vb = segB.getField(f);
    if (va === vb) continue;

    const path = `${segA.id}-${f}`;
    const line = `  ${path.padEnd(10)} ${(va || "(empty)").slice(0, 44).padEnd(46)} -> ${(vb || "(empty)").slice(0, 44)}`;
    if (METADATA.has(path)) metaChanges.push(line);
    else valueChanges.push(line);
  }
}

// ---------------------------------------------------------------------------

console.log(`have: ${srcPath}  (${src.segments.length} segments)`);
console.log(`want: ${tgtPath}  (${tgt.segments.length} segments)\n`);

console.log("1. SEGMENT SET");
if (!dropped.length && !added.length) console.log("  none");
if (dropped.length) console.log(`  drop:  ${dropped.join(", ")}`);
if (added.length) console.log(`  add:   ${added.join(", ")}`);

console.log("\n2. METADATA  (message identity -- these travel in groups)");
console.log(metaChanges.length ? metaChanges.join("\n") : "  none");

console.log("\n3. FIELD VALUES  (content differences)");
console.log(valueChanges.length ? valueChanges.join("\n") : "  none");

console.log("\n4. CODE TRANSLATION");
console.log("  Not detectable from two messages. Look at the field-value list above:");
console.log("  a change where both sides mean the same thing in different vocabularies");
console.log("  (I -> INPATIENT, M -> MALE) is a translation and needs a LOOKUP TABLE,");
console.log("  not an assign. One sample shows you one row of that table.");

console.log("\n5. STRUCTURAL  (repeats, components, segment order)");
const repeatIds = [...new Set(src.segments.map((s) => s.id))].filter(
  (id) => src.all(id).length !== tgt.all(id).length && tgt.all(id).length > 0,
);
console.log(repeatIds.length
  ? `  repetition count changed: ${repeatIds.join(", ")}`
  : "  no repetition-count changes");

const cost = dropped.length + added.length;
console.log(`\n${"-".repeat(70)}`);
console.log(`SIZING: ${cost} segment-set, ${metaChanges.length} metadata, ${valueChanges.length} field-value`);
console.log(
  cost > 0 && valueChanges.length === 0
    ? "This is a SEGMENT WHITELIST job. Short DTL. P1 + P2 in patterns.ts."
    : valueChanges.length > 0
      ? "This has real field mapping. Build a toolbox.ts rules table and trace it."
      : "Metadata only. Two or three assigns.",
);
console.log(`${"-".repeat(70)}`);
console.log("\nEvery line above is a QUESTION for the sending and receiving analysts,");
console.log("not a fact. Two messages cannot tell you which differences are rules and");
console.log("which are accidents of this sample. That is Question 3, and it is a phone call.");
