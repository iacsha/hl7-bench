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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Bytes to text, whatever the editor that wrote them decided.
 *
 * PowerShell 5.1's `>` writes UTF-16LE. Studio and Notepad will both hand you a
 * UTF-8 BOM. Read as plain utf8, the first is text with a NUL between every
 * character -- not text with a problem, text that matches NO pattern at all --
 * and the second has an invisible character sitting in front of the first line,
 * so every `^` anchor misses it.
 *
 * Neither failure announces itself. A tool reads the file, finds nothing it
 * recognises, and reports something true about the wrong thing. So the decoding
 * happens once, here, and `note` says when the file was not what it looked
 * like, because converting somebody's input silently is its own way to be
 * wrong.
 */
export function decodeText(bytes: Uint8Array): { text: string; note?: string } {
  const b = Buffer.from(bytes);

  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return { text: b.subarray(2).toString("utf16le"), note: "UTF-16LE (PowerShell's > writes this)" };
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    return { text: b.subarray(2).swap16().toString("utf16le"), note: "UTF-16BE" };
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return { text: b.subarray(3).toString("utf8"), note: "UTF-8 with a BOM" };
  }
  // No BOM, but every other byte is NUL: UTF-16LE that lost its mark, which is
  // what a redirect into an existing file produces. ASCII text never looks like
  // this, and the sample is capped so a large binary does not cost a scan.
  const look = Math.min(b.length, 64);
  if (look >= 4) {
    let nulls = 0;
    for (let i = 1; i < look; i += 2) if (b[i] === 0) nulls++;
    if (nulls === Math.floor((look - 1) / 2)) {
      return { text: b.toString("utf16le"), note: "UTF-16LE with no BOM" };
    }
  }
  return { text: b.toString("utf8") };
}

export type MessageInput = {
  raw: string;
  /** What to record in the log: the path, "stdin", or "sample.hl7". */
  source: string;
};

/** Flags whose VALUE is a filename and must not be read as the input. */
const VALUE_FLAGS = new Set([
  "-o", "--out", "--doctype", "--key", "--value", "--delim", "--from",
  // engine.ts. `--script somebody.hl7` is a legal thing to write, and without
  // this the body file would be read as the message and the message ignored.
  "--class", "--script",
]);

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
    const d = decodeText(readFileSync(named));
    if (d.note) process.stderr.write(`${toolName}: ${named} is ${d.note}; decoded it\n`);
    return { raw: d.text, source: named };
  }

  // A bare run on a terminal would otherwise block on input that is never
  // coming, which reads as a hang.
  const piped = process.stdin.isTTY ? "" : await Bun.stdin.text();
  if (piped.trim().length > 0) return { raw: piped, source: "stdin" };

  const fallback = join(import.meta.dir, "sample.hl7");
  if (sampleFallback && existsSync(fallback)) {
    return { raw: decodeText(readFileSync(fallback)).text, source: "sample.hl7" };
  }

  const example = exts[0] === ".hl7" ? "messages\\yours.hl7" : "codes.csv";
  process.stderr.write(
    `${toolName}: nothing to read.\n` +
      `  name a file    bun ${toolName}.ts ${example}\n` +
      `  or pipe one    Get-Content -Raw ${example} | bun ${toolName}.ts\n`,
  );
  process.exit(1);
}


/**
 * -o for the tools that print a document rather than a message.
 *
 * `trace.ts` produces the mapping document somebody sends to the receiving team,
 * and it had no way to write a file -- so the obvious `-o mapping.txt` was
 * accepted in silence and went nowhere, and a `>` redirect on PowerShell 5.1
 * writes UTF-16LE. Both failures end with a person hunting for a file that is not
 * there, or opening one full of nulls.
 */
export function outArg(toolName: string, argv: string[] = process.argv.slice(2)): string | undefined {
  const i = argv.findIndex((a) => a === "-o" || a === "--out");
  if (i === -1) return undefined;
  const name = argv[i + 1];
  if (!name || name.startsWith("-")) {
    process.stderr.write(`${toolName}: -o needs a filename after it.\n`);
    process.exit(2);
  }
  return name;
}

/** Write it, or print it. The byte count is there so a silent write is visible. */
export async function deliverText(text: string, outFile: string | undefined): Promise<void> {
  if (!outFile) {
    process.stdout.write(text);
    return;
  }
  // Synchronous for the same reason emit.ts is: a CLI exits as soon as its last
  // statement runs, and an awaited write is only safe while every caller
  // remembers to await it. This one cannot be got wrong by a caller.
  writeFileSync(outFile, text, "utf8");
  process.stderr.write(`wrote ${outFile}  (${text.length} bytes, no BOM)\n`);
}
