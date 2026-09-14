// bun test
//
// Where the message comes from, which is the thing that silently went wrong for
// a whole morning: a filename passed to a tool that only read stdin ran
// `sample.hl7` instead, exited 0, and reported a gate refusal belonging to a
// message nobody had looked at.
//
// The argument scan is pure, so most of this is direct. The refusals go through
// a spawned process, because exiting is the behaviour under test.

import { expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { messageArg, namedArg } from "./input";

const DIR = import.meta.dir;
const BUN = process.execPath;
const SCRATCH = mkdtempSync(join(tmpdir(), "hl7-bench-input-"));

/**
 * The machine's own spec must not ride along. `bun test` runs in the bench
 * folder, bun loads `.env` from there, and on a real machine that file sets
 * HL7_BENCH_TRANSFORM to a path relative to that folder -- which resolves to
 * nothing from the scratch directory and kills the child before it reads a
 * message. These tests are about the message, so the spec stays the demo.
 */
function run(args: string[], stdin = "") {
  const env: Record<string, string> = { HL7_BENCH_NOTES: "off" };
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== "HL7_BENCH_TRANSFORM" && v !== undefined) env[k] = v;
  }
  env.HL7_BENCH_NOTES = "off";
  const p = Bun.spawnSync([BUN, join(DIR, args[0]!), ...args.slice(1)], {
    cwd: SCRATCH,
    env,
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
}

describe("which argument is the input file", () => {
  test("a bare .hl7 argument is the message", () => {
    expect(messageArg(["messages/in.hl7"])).toBe("messages/in.hl7");
  });

  test("case does not matter", () => {
    expect(messageArg(["MESSAGES/IN.HL7"])).toBe("MESSAGES/IN.HL7");
  });

  // The one that would overwrite your work: `-o out.hl7 in.hl7` names an output
  // first, and reading the first .hl7 on the line would read the file the tool
  // is about to write.
  test("the value of -o is not the input", () => {
    expect(messageArg(["-o", "out.hl7", "in.hl7"])).toBe("in.hl7");
    expect(messageArg(["--out", "out.hl7", "in.hl7"])).toBe("in.hl7");
  });

  test("the value of --doctype is not the input", () => {
    expect(messageArg(["--doctype", "2.5:DFT_P03", "in.hl7"])).toBe("in.hl7");
  });

  test("flags on their own are ignored", () => {
    expect(messageArg(["--strict", "in.hl7"])).toBe("in.hl7");
  });

  test("no file named means undefined, not a guess", () => {
    expect(messageArg(["--strict"])).toBeUndefined();
    expect(messageArg([])).toBeUndefined();
  });

  test("table tools accept csv, tsv and txt, and not hl7", () => {
    const DATA = [".csv", ".tsv", ".txt"];
    expect(namedArg(["codes.csv"], DATA)).toBe("codes.csv");
    expect(namedArg(["codes.TSV"], DATA)).toBe("codes.TSV");
    expect(namedArg(["--delim", "tab", "codes.txt"], DATA)).toBe("codes.txt");
    expect(namedArg(["message.hl7"], DATA)).toBeUndefined();
  });

  test("the value of --from is not the input", () => {
    const DATA = [".csv", ".tsv", ".txt"];
    expect(namedArg(["--from", "original.csv", "actual.csv"], DATA)).toBe("actual.csv");
  });
});

describe("reading it", () => {
  const A01 = "MSH|^~\\&|SEND|FAC|RECV|RFAC|20260101120000||ADT^A01|1|P|2.3\rPID|1||123456||DOE^JANE\r";

  test("a named message is read, and stdin is not required", () => {
    const file = join(SCRATCH, "named.hl7");
    writeFileSync(file, A01, "utf8");
    const got = run(["bench.ts", file]);
    expect(got.code).toBe(0);
    expect(got.out).toContain("MSH|");
  });

  // The failure this whole module exists for.
  test("a named message that is not there refuses instead of running the sample", () => {
    const got = run(["bench.ts", join(SCRATCH, "not-here.hl7")]);
    expect(got.code).not.toBe(0);
    expect(got.err).toContain("no such file");
    expect(got.err).toContain("Refusing to fall back to sample.hl7");
    expect(got.out).toBe("");
  });

  test("a named table that is not there refuses too, and says what it would have built", () => {
    const got = run(["tables.ts", "Facilities", join(SCRATCH, "not-here.csv")]);
    expect(got.code).not.toBe(0);
    expect(got.err).toContain("no such file");
    expect(got.err).toContain("matches nothing");
  });

  test("a named table is read without a pipe", () => {
    const file = join(SCRATCH, "codes.csv");
    writeFileSync(file, "code,meaning\nF,Final report\nA,Addendum\n", "utf8");
    const got = run(["tables.ts", "DocStatus", file]);
    expect(got.code).toBe(0);
    expect(got.out).toContain('"F": "Final report"');
  });

  test("stdin still works when no file is named", () => {
    const got = run(["bench.ts"], A01);
    expect(got.code).toBe(0);
    expect(got.out).toContain("MSH|");
  });
});

describe("-o, on the tools that write a document", () => {
  test("trace writes the file, and the file carries the source inventory too", () => {
    const msg = join(SCRATCH, "t.hl7");
    writeFileSync(msg, "MSH|^~\\&|SEND|FAC|RECV|RFAC|20260101120000||ADT^A01|1|P|2.3\rPID|1||123456||DOE^JANE\r", "utf8");
    const out = join(SCRATCH, "mapping.txt");
    const got = run(["trace.ts", msg, "-o", out]);
    expect(got.code).toBe(0);
    expect(got.err).toContain("wrote");
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toContain("SPEC:");
    // stdout stays clean, so a piped run is not doubled
    expect(got.out).toBe("");
  });

  test("reads writes the file", () => {
    const msg = join(SCRATCH, "t2.hl7");
    writeFileSync(msg, "MSH|^~\\&|SEND|FAC|RECV|RFAC|20260101120000||ADT^A01|1|P|2.3\rPID|1||123456||DOE^JANE\r", "utf8");
    const out = join(SCRATCH, "reads.txt");
    const got = run(["reads.ts", msg, "-o", out]);
    expect(existsSync(out)).toBe(true);
  });

  // The failure that prompted all this: a flag accepted in silence, and a person
  // hunting for a file that was never written.
  test("-o with no filename is refused rather than ignored", () => {
    const msg = join(SCRATCH, "t3.hl7");
    writeFileSync(msg, "MSH|^~\\&|SEND|FAC|RECV|RFAC|20260101120000||ADT^A01|1|P|2.3\r", "utf8");
    const got = run(["trace.ts", msg, "-o"]);
    expect(got.code).not.toBe(0);
    expect(got.err).toContain("needs a filename");
  });
});
