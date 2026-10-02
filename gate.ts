#!/usr/bin/env bun
/**
 * gate.ts -- would this message get through?
 *
 *   bun gate.ts messages\in.hl7
 *   Get-Content in.hl7 -Raw | bun gate.ts
 *
 * PERMIT or REFUSE for each message in the file, and every clause of the gate
 * beside it: the trigger event, each required equality, each table lookup.
 * Every clause is evaluated, not just the first that fails, so a message
 * refused by its trigger that would ALSO have missed the facility table says
 * both at once.
 *
 * WHY THIS EXISTS
 *
 * The bench emitted the routing rule and never evaluated it, so "would this
 * message get through" was answered by deploying and sending one. The commonest
 * allowlist failure is a code typed slightly wrong, in the table or upstream,
 * and that is a laptop-sized question. A table miss lists the keys that differ
 * from the code only by case, space or one character.
 *
 * Exit 0 when every message is permitted, 1 when any is refused, 2 when the
 * input cannot be read. A file of messages that are SUPPOSED to be refused
 * therefore exits 1; read the lines, not just the code.
 */

import { Message } from "./hl7";
import { explainGate } from "./run";
import { spec, specPath } from "./specfile";
import { readMessage } from "./input";
import { basename } from "node:path";

/**
 * One message per MSH. A file of several is the normal shape for a batch pulled
 * out of a message viewer, and asking for one file per message would make the
 * question "which of these get through" a loop the person writes by hand.
 */
export function splitMessages(raw: string): string[] {
  return raw
    .replace(/\r\n?|\n/g, "\r")
    .split(/\r(?=MSH)/)
    .map((m) => m.replace(/^\r+|\r+$/g, ""))
    .filter((m) => m.startsWith("MSH"));
}

if (import.meta.main) {
  const { raw, source } = await readMessage("gate");
  const messages = splitMessages(raw);
  if (messages.length === 0) {
    process.stderr.write(`gate: no MSH segment in ${source}.\n`);
    process.exit(2);
  }

  process.stdout.write(`GATE  ${spec.name}  (${basename(specPath)})  ${source}\n`);
  let refused = 0;

  messages.forEach((text, i) => {
    let msg: Message;
    try {
      msg = new Message(text);
    } catch (e) {
      refused++;
      process.stdout.write(`\n#${i + 1}  UNPARSEABLE  ${(e as Error).message}\n`);
      return;
    }
    const v = explainGate(spec, msg);
    if (!v.permit) refused++;
    const id = msg.get("MSH-10");
    process.stdout.write(`\n#${i + 1}${id ? `  ${id}` : ""}  ${v.permit ? "PERMIT" : "REFUSE"}\n`);
    for (const c of v.clauses) {
      process.stdout.write(`  ${c.ok ? "pass" : "FAIL"}  ${c.why}\n`);
      if (c.near && c.near.length > 0) {
        process.stdout.write(`        close: ${c.near.map((k) => JSON.stringify(k)).join(", ")}\n`);
      }
    }
  });

  if (messages.length > 1) {
    process.stdout.write(`\n${messages.length - refused} permitted, ${refused} refused\n`);
  }
  process.exit(refused > 0 ? 1 : 0);
}
