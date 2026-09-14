// bun test
//
// `HL7_BENCH_TRANSFORM` moves the spec out of the tool folder. Everything that
// can go wrong with it goes wrong QUIETLY unless it is checked here: a path with
// a typo, a relative path read against the wrong folder, a file that is not a
// spec module. Every one of those has the same shape -- the tool runs, and it
// runs a mapping that is not the one you edited.
//
// The variable is read when the module loads, so these tests cannot set it and
// re-import. They spawn a process, which is also how a person uses it.

import { expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const DIR = import.meta.dir;
const BUN = process.execPath;

/** Print what `specpath.ts` resolved, with the environment we want tested. */
function resolvePathWith(env: Record<string, string | undefined>) {
  const p = Bun.spawnSync(
    [BUN, "-e", 'import("./specpath").then(m => console.log(m.specPath + "|" + m.specIsExternal))'],
    { cwd: DIR, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" },
  );
  const [path, external] = p.stdout.toString().trim().split("|");
  return { path, external: external === "true", stderr: p.stderr.toString() };
}

/** Run the bench over a message with the environment we want tested. */
function bench(env: Record<string, string | undefined>, message: string) {
  const p = Bun.spawnSync([BUN, "bench.ts"], {
    cwd: DIR,
    env: { ...process.env, ...env, HL7_BENCH_NOTES: "off" },
    stdin: new TextEncoder().encode(message),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { out: p.stdout.toString(), err: p.stderr.toString(), code: p.exitCode };
}

/** A minimal spec module, written where the test can point the variable at it. */
function writeSpecFile(sendingApp: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hl7-bench-spec-"));
  const file = join(dir, "transform.custom.ts");
  writeFileSync(
    file,
    [
      `import { literal, copy, type Spec } from "${join(DIR, "spec")}";`,
      `export const spec: Spec = {`,
      `  name: "External Spec Under Test",`,
      `  gate: { path: "MSH-9.2", permit: { A01: "A01" } },`,
      `  iris: { sourceDocType: "2.3:ADT_A01", targetDocType: "2.3:ADT_A01" },`,
      `  blocks: [{ id: "MSH", rows: [`,
      `    { target: "MSH-3", from: literal(${JSON.stringify(sendingApp)}) },`,
      `    { target: "MSH-9.1", from: copy("MSH-9.1") },`,
      `    { target: "MSH-9.2", from: copy("MSH-9.2") },`,
      `  ] }],`,
      `};`,
      "",
    ].join("\n"),
    "utf8",
  );
  return file;
}

describe("which file holds the spec", () => {
  test("unset means transform.ts in the tool folder, and not external", () => {
    const got = resolvePathWith({ HL7_BENCH_TRANSFORM: undefined });
    expect(got.path).toBe(join(DIR, "transform.ts"));
    expect(got.external).toBe(false);
  });

  test("an absolute path is used as given, and counts as external", () => {
    const got = resolvePathWith({ HL7_BENCH_TRANSFORM: "/tmp/somewhere/transform.exa.ts" });
    expect(got.path).toBe("/tmp/somewhere/transform.exa.ts");
    expect(got.external).toBe(true);
  });

  // "relative to where I am" is how a person reads a relative path in an
  // environment variable. Resolving it against the tool folder instead would
  // point somewhere else and still find a file often enough to be believed.
  test("a relative path resolves against the working directory", () => {
    const got = resolvePathWith({ HL7_BENCH_TRANSFORM: "transform.local.ts" });
    expect(got.path).toBe(resolve(DIR, "transform.local.ts"));
  });

  test("surrounding whitespace is trimmed", () => {
    const got = resolvePathWith({ HL7_BENCH_TRANSFORM: "  /tmp/padded.ts  " });
    expect(got.path).toBe("/tmp/padded.ts");
  });

  test("an empty variable is the same as not setting it", () => {
    const got = resolvePathWith({ HL7_BENCH_TRANSFORM: "" });
    expect(got.path).toBe(join(DIR, "transform.ts"));
    expect(got.external).toBe(false);
  });
});

describe("loading it", () => {
  const A01 = "MSH|^~\\&|SEND|FAC|RECV|RFAC|20260101120000||ADT^A01|1|P|2.3\rPID|1||123456||DOE^JANE\r";

  test("the external spec is what actually runs", () => {
    const file = writeSpecFile("FROM-THE-EXTERNAL-FILE");
    const got = bench({ HL7_BENCH_TRANSFORM: file }, A01);
    expect(got.code).toBe(0);
    expect(got.out).toContain("FROM-THE-EXTERNAL-FILE");
  });

  // The whole point of failing closed. A typo in the path must not silently
  // deliver the demo mapping, because the demo mapping runs, exits 0, and
  // produces a message that looks like work.
  test("a path that is not there stops the run and names it", () => {
    const got = bench({ HL7_BENCH_TRANSFORM: "/tmp/definitely-not-here-42.ts" }, A01);
    expect(got.code).not.toBe(0);
    expect(got.err).toContain("/tmp/definitely-not-here-42.ts");
    expect(got.out).toBe("");
  });

  test("a module with no spec export stops the run and says what is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "hl7-bench-nospec-"));
    const file = join(dir, "notaspec.ts");
    writeFileSync(file, "export const somethingElse = 1;\n", "utf8");
    const got = bench({ HL7_BENCH_TRANSFORM: file }, A01);
    expect(got.code).not.toBe(0);
    expect(got.err).toContain("exports no");
    expect(got.out).toBe("");
  });

  test("the demo spec still runs when the variable is unset", () => {
    const got = bench({ HL7_BENCH_TRANSFORM: undefined }, A01);
    expect(got.code).toBe(0);
    expect(got.out).toContain("MSH|");
  });
});
