// bun test
//
// Which artifact, and where it goes. Both were wrong at once for an hour:
// `-o` was added without guarding the -1 case, so with no -o the filter dropped
// argument ZERO and `emit.ts process` quietly produced the DTL instead. A
// generator that emits a different artifact than the one you named is the worst
// kind of wrong, because the output looks entirely plausible.

import { expect, test, describe } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = import.meta.dir;
const BUN = process.execPath;
const SCRATCH = mkdtempSync(join(tmpdir(), "hl7-bench-emit-"));

function emit(args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== "HL7_BENCH_TRANSFORM" && v !== undefined) env[k] = v;
  }
  const p = Bun.spawnSync([BUN, join(DIR, "emit.ts"), ...args], {
    cwd: SCRATCH,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
}

describe("which artifact", () => {
  test("no argument is the DTL", () => {
    expect(emit([]).out).toContain("Class ");
  });

  // The regression: with no -o, argument zero used to be dropped.
  test("a named artifact is honoured when there is no -o", () => {
    const got = emit(["process"]);
    expect(got.out + got.err).not.toContain("<transform sourceClass");
  });

  test("a named artifact is honoured when there IS an -o", () => {
    const file = join(SCRATCH, "t.xml");
    emit(["tables", "-o", file]);
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("lookupTable");
  });

  test("an unknown artifact is refused rather than defaulted", () => {
    const got = emit(["nonsense"]);
    expect(got.code).not.toBe(0);
    expect(got.err).toContain("Unknown artifact");
  });
});

describe("where it goes", () => {
  test("-o writes the file, and without a BOM", () => {
    const file = join(SCRATCH, "T.cls");
    const got = emit(["-o", file]);
    expect(got.code).toBe(0);
    const bytes = readFileSync(file);
    expect(bytes[0]).not.toBe(0xef); // UTF-8 BOM
    expect(bytes[0]).not.toBe(0xff); // UTF-16LE BOM
    expect(bytes.toString("utf8", 0, 16)).toStartWith("Include Ensemble");
  });

  // What actually happened on the work PC: a filename where the artifact goes,
  // which used to emit the DTL to stdout and leave the file untouched.
  test("a filename in the artifact slot says to use -o", () => {
    const got = emit(["lab/Transform.cls"]);
    expect(got.code).not.toBe(0);
    expect(got.err).toContain("is a filename, not an artifact");
    expect(got.err).toContain("-o lab/Transform.cls");
  });

  test("-o with nothing after it is refused", () => {
    const got = emit(["-o"]);
    expect(got.code).not.toBe(0);
    expect(got.err).toContain("needs a filename");
  });
});
