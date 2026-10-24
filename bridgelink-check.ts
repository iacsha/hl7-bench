#!/usr/bin/env bun
/**
 * bridgelink-check.ts -- run the generated channel in a real BridgeLink and
 * hold it to the bench, message by message.
 *
 *   bun bridgelink-check.ts           every case
 *   bun bridgelink-check.ts a01       only cases whose name contains "a01"
 *   bun bridgelink-check.ts --keep    leave the channel deployed afterwards
 *
 * The spec is the active one (HL7_BENCH_TRANSFORM), the same as every other
 * tool. The cases are the spec module's exported `cases` when it has them, and
 * `messages\` otherwise, read with check.ts's convention: `<name>.in.hl7` is a
 * message to transform, `<name>.reject.hl7` one the gate must refuse.
 *
 * WHAT IT CLAIMS
 *
 * Not that the output is right. `check.ts` claims that, against the want files.
 * This claims the ENGINE AGREES WITH THE BENCH: for every input, the channel
 * delivers the segments `runSpec` delivers, and filters what the gate refuses.
 * Together they make the bench the reference implementation, which is the
 * promise check.ts's header makes and could not keep for this engine until
 * something actually ran the step.
 *
 * WHAT IT DOES TO THE SERVER
 *
 * One channel, named "hl7-bench check", with an id derived from that name, so
 * every run updates the same channel rather than adding one. Its stored
 * messages are cleared and it is undeployed at the end unless --keep. Nothing
 * else on the server is touched.
 *
 * Connection settings are in bridgelink-session.ts.
 */

process.env.HL7_BENCH_NOTES = "off";

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Message } from "./hl7";
import { runSpec } from "./run";
import { specPath } from "./specpath";
import { emitChannel, channelId } from "./emit/channel";
import { fieldReport } from "./compare";
import * as bl from "./bridgelink-session";
import type { Spec } from "./spec";

/** One message to send. `reject` means the gate must refuse it. */
export interface EngineCase {
  name: string;
  input: string;
  reject?: boolean;
}

const CHANNEL = "hl7-bench check";

function segments(raw: string): string[] {
  return raw.split(/\r\n|\r|\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
}

function casesFromDir(dir: string): EngineCase[] {
  if (!existsSync(dir)) return [];
  const out: EngineCase[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (f.endsWith(".in.hl7")) out.push({ name: f.slice(0, -7), input: readFileSync(join(dir, f), "utf8") });
    else if (f.endsWith(".reject.hl7")) {
      out.push({ name: f.slice(0, -11), input: readFileSync(join(dir, f), "utf8"), reject: true });
    }
  }
  return out;
}

/** What the bench says should happen: delivered segments, or a refusal. */
function benchSays(spec: Spec, raw: string): { refused: string } | { segments: string[]; msg: Message } {
  const msg = new Message(raw);
  try {
    runSpec(spec, msg);
  } catch (e) {
    return { refused: (e as Error).message };
  }
  return { segments: segments(msg.toString()), msg };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  const filter = args.find((a) => !a.startsWith("--"))?.toLowerCase();

  const mod = await import(specPath);
  // The harness names its own channel, so an IRIS-only spec can still be held
  // to the engine. In memory only: the spec file is not touched.
  const spec: Spec = mod.spec.bridgelink ? mod.spec : { ...mod.spec, bridgelink: { channelName: CHANNEL } };
  const all: EngineCase[] = Array.isArray(mod.cases) ? mod.cases : casesFromDir(join(import.meta.dir, "messages"));
  const chosen = filter ? all.filter((c) => c.name.toLowerCase().includes(filter)) : all;
  if (chosen.length === 0) {
    console.error(
      `No cases${filter ? ` matching "${filter}"` : ""}. The spec module exports no \`cases\` ` +
        `and messages\\ holds no <name>.in.hl7 or <name>.reject.hl7.`,
    );
    return 2;
  }

  const s = await bl.connect();
  const version = await bl.serverVersion(s);
  const id = channelId(CHANNEL);
  await bl.putChannel(
    s,
    id,
    emitChannel(spec, {
      id,
      name: CHANNEL,
      version,
      description: `Scratch channel for bridgelink-check.ts, spec "${spec.name}". Safe to delete.`,
    }),
  );
  await bl.deploy(s, id);
  console.log(`BridgeLink ${version} at ${s.base}, channel "${CHANNEL}", spec "${spec.name}"\n`);

  let failed = 0;
  try {
    for (const c of chosen) {
      const want = benchSays(spec, c.input);
      const got = await bl.processMessage(s, id, c.input);

      if (got.status === "ERROR") {
        failed++;
        console.log(`FAIL  ${c.name}  the step threw in the engine:\n${indent(got.error, 6)}`);
        continue;
      }

      if ("refused" in want) {
        if (got.status === "FILTERED") {
          console.log(`PASS  ${c.name}  filtered, as the bench refused it`);
        } else {
          failed++;
          console.log(`FAIL  ${c.name}  the bench refuses it, the engine let it through (${got.status})`);
        }
        if (!c.reject) console.log(`      note: not named as a reject case, and the bench refused it: ${want.refused.slice(0, 80)}`);
        continue;
      }

      if (got.status === "FILTERED") {
        failed++;
        console.log(`FAIL  ${c.name}  the engine filtered it, the bench delivers it`);
        continue;
      }

      const engine = segments(got.encoded);
      const bad: string[] = [];
      for (let i = 0; i < Math.max(engine.length, want.segments.length); i++) {
        if (engine[i] !== want.segments[i]) {
          bad.push(`      line ${i + 1}\n        engine ${engine[i] ?? "(absent)"}\n        bench  ${want.segments[i] ?? "(absent)"}`);
        }
      }
      if (bad.length === 0) {
        console.log(`PASS  ${c.name}  ${engine.length} segments identical`);
        continue;
      }
      failed++;
      let fields: string[] = [];
      try {
        fields = fieldReport(new Message(got.encoded), want.msg);
      } catch {
        fields = [];
      }
      const head = fields.length ? `\n    fields:\n${fields.map((l) => `      ${l}`).join("\n")}\n    lines:` : "";
      console.log(`FAIL  ${c.name}  ${bad.length} differing line(s):${head}\n${bad.join("\n")}`);
    }
  } finally {
    await bl.clearMessages(s, id);
    if (!keep) await bl.undeploy(s, id);
  }

  console.log(`\n${chosen.length - failed}/${chosen.length} cases agree with the bench`);
  return failed === 0 ? 0 : 1;
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s.split(/\r?\n/).slice(0, 12).map((l) => pad + l).join("\n");
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`bridgelink-check: ${(e as Error).message}`);
      process.exit(2);
    },
  );
}
