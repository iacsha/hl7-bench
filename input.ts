/**
 * input.ts -- where the message comes from, for every tool that takes one.
 *
 * Three ways in, in this order:
 *
 *   1. A filename on the command line.   bun bench.ts messages\in.hl7
 *   2. Standard input.                   bun bench.ts < messages\in.hl7
 *   3. sample.hl7, so a bare run does something instead of hanging.
 *
 * WHY A FILENAME AT ALL
 *
 * PowerShell 5.1 has no input redirection:
 *
 *     bun bench.ts < messages\in.hl7
 *     The '<' operator is reserved for future use.
 *
 * Every `<` in this repo's documentation was written on a machine with a shell
 * that has it, and the work machine is the one that does not. The workarounds --
 * `cmd /c "... < file"`, or `Get-Content -Raw file | bun ...` -- both work and
 * neither is something anyone should have to know.
 *
 * WHY IT REFUSES RATHER THAN FALLING BACK
 *
 * Naming a file that is not there used to land on `sample.hl7`, which is a
 * synthetic A01. The tool then ran, exited 0, and reported on a message the user
 * had never seen. That cost a wrong diagnosis on 2026-09-14: a transform was
 * declared broken on the strength of a gate refusal that belonged to the sample.
 *
 * So a named file that cannot be read is an error. The fallback is only for the
 * case where nothing was named and nothing was piped.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type MessageInput = {
  raw: string;
  /** What to record in the log: the path, "stdin", or "sample.hl7". */
  source: string;
};

/** Flags whose VALUE is a filename and must not be read as the input. */
const VALUE_FLAGS = new Set(["-o", "--out", "--doctype", "--key", "--value", "--delim", "--from"]);

/** What each tool will accept as a named input file. */
const HL7 = [".hl7"];
const DATA = [".csv", ".tsv", ".txt"];

/**
 * The first bare `.hl7` argument that is not the value of a flag.
 *
 * `bun bench.ts -o out.hl7 in.hl7` names both an output and an input, and taking
 * the first `.hl7` on the line would read the file it is about to overwrite.
 */
export function namedArg(
  argv: string[] = process.argv.slice(2),
  exts: string[] = HL7,
): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (VALUE_FLAGS.has(a)) {
      i++; // skip the value
      continue;
    }
    if (a.startsWith("-")) continue;
    const lower = a.toLowerCase();
    if (exts.some((e) => lower.endsWith(e))) return a;
  }
  return undefined;
}

/** The message form, kept as its own name because that is what tools ask for. */
export const messageArg = (argv?: string[]) => namedArg(argv, HL7);

/**
 * Resolve the message for a CLI run.
 *
 * `toolName` only shapes the error text, so the line that fails says which tool
 * failed without the caller having to catch and re-throw.
 */
export async function readMessage(
  toolName: string,
  argv: string[] = process.argv.slice(2),
): Promise<MessageInput> {
  return read(toolName, argv, HL7, true);
}

/**
 * The same three ways in, for a tool whose input is a table rather than a
 * message. No fallback: there is no synthetic CSV to stand in for one, and
 * inventing an empty table would build a lookup that silently matches nothing.
 */
export async function readData(
  toolName: string,
  argv: string[] = process.argv.slice(2),
): Promise<MessageInput> {
  return read(toolName, argv, DATA, false);
}

async function read(
  toolName: string,
  argv: string[],
  exts: string[],
  sampleFallback: boolean,
): Promise<MessageInput> {
  const named = namedArg(argv, exts);

  if (named) {
    if (!existsSync(named)) {
      const consequence = sampleFallback
        ? `Refusing to fall back to sample.hl7, which would report on a message you did not name.`
        : `Refusing to continue with no table, which would build a lookup that matches nothing.`;
      process.stderr.write(
        `${toolName}: no such file.\n  looked for   ${named}\n${consequence}\n`,
      );
      process.exit(1);
    }
    return { raw: readFileSync(named, "utf8"), source: named };
  }

  // A bare run on a terminal would otherwise block on input that is never
  // coming, which reads as a hang.
  const piped = process.stdin.isTTY ? "" : await Bun.stdin.text();
  if (piped.trim().length > 0) return { raw: piped, source: "stdin" };

  const fallback = join(import.meta.dir, "sample.hl7");
  if (sampleFallback && existsSync(fallback)) {
    return { raw: readFileSync(fallback, "utf8"), source: "sample.hl7" };
  }

  const example = exts[0] === ".hl7" ? "messages\\yours.hl7" : "codes.csv";
  process.stderr.write(
    `${toolName}: nothing to read.\n` +
      `  name a file    bun ${toolName}.ts ${example}\n` +
      `  or pipe one    Get-Content -Raw ${example} | bun ${toolName}.ts\n`,
  );
  process.exit(1);
}
