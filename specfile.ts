/**
 * specfile.ts -- load the spec, from wherever `specpath.ts` says it lives.
 *
 * `transform.ts` is the spec by default, and for one interface on one machine
 * that is still the right answer. It stops being the right answer as soon as the
 * tool and the interface have different owners, and two failures follow from
 * that, both of which have now happened here.
 *
 * The tool upgrades on a machine without git by unpacking a zip over the folder.
 * `transform.ts` is the one file in there that cannot be replaced from upstream,
 * so the upgrade either destroys the interface or gets skipped, and skipped
 * upgrades are why a second full copy of this tool ended up on disk holding one
 * site's spec.
 *
 * The tool also ships to a public repo, and a customer's mapping does not. A
 * tracked `transform.ts` holding a real interface put a customer's name, their
 * vendor and two accession numbers one `git push` from being public, and the only
 * thing that stopped it was somebody reading the diff first.
 *
 *     HL7_BENCH_TRANSFORM=C:\work\exa\transform.exa.ts
 *
 * Set it and every reader -- bench, emit, navcheck, schema-sync, trace, reads,
 * and the GUI, which also SAVES there -- uses that file. Leave it unset and
 * nothing about this tool changes.
 *
 * The external file is an ordinary spec module: it exports `spec`, and it may
 * export `transform`. A copy of `transform.ts` already qualifies, which is the
 * point -- moving an interface out is a file move and an environment variable,
 * not a rewrite.
 *
 * This fails CLOSED. A path that is not there, or a module with no `spec` export,
 * stops the run. It does not fall back to the demo spec, because running a
 * mapping you did not write while believing you ran yours is worse than not
 * running at all, and it is the exact shape of failure the rest of this tool is
 * built to refuse.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import type { Message } from "./hl7";
import { runSpec } from "./run";
import { specIsExternal, specOverride, specPath } from "./specpath";
import type { Spec } from "./spec";

export { specIsExternal, specPath } from "./specpath";

function die(message: string): never {
  process.stderr.write(`hl7-bench: ${message}\n`);
  process.exit(1);
}

if (specIsExternal && !existsSync(specPath)) {
  die(
    `HL7_BENCH_TRANSFORM names a file that is not there.\n` +
      `  it points at   ${specPath}\n` +
      `  set to         ${specOverride}\n` +
      `Fix the path or clear the variable. Refusing to run the demo spec in its place.`,
  );
}

const loaded = (await import(pathToFileURL(specPath).href)) as {
  spec?: Spec;
  transform?: (msg: Message) => void;
};

if (!loaded.spec) {
  die(
    `the spec file exports no \`spec\`.\n` +
      `  read           ${specPath}\n` +
      `A spec module ends with \`export const spec: Spec = { ... }\`.`,
  );
}

export const spec: Spec = loaded.spec;

/**
 * The bench contract: parsed message in, mutated in place. Taken from the spec
 * file when it defines one, so a file carrying its own diagnostics keeps them,
 * and synthesized otherwise so a file that is only a spec still runs.
 */
export const transform: (msg: Message) => void =
  loaded.transform ??
  ((msg: Message): void => {
    const result = runSpec(spec, msg);
    if (process.env.HL7_BENCH_NOTES === "off") return;
    for (const note of result.notes) process.stderr.write(`  ${note}\n`);
  });
