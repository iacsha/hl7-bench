// bun test
//
// Resolving the password, which is the piece that must not get this wrong in
// either direction: a command that fails silently would send an empty password
// and look like a refused login, and a password that leaks into an error
// transcript is worse than the failure it was explaining.

import { expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = import.meta.dir;
const BUN = process.execPath;
const SCRATCH = mkdtempSync(join(tmpdir(), "hl7-bench-pw-"));

/** Resolve a password in a child process, because the module reads env at load. */
function resolveWith(env: Record<string, string | undefined>) {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("IRIS_") && v !== undefined) base[k] = v;
  }
  for (const [k, v] of Object.entries(env)) if (v !== undefined) base[k] = v;

  const p = Bun.spawnSync(
    [
      BUN,
      "-e",
      `import(${JSON.stringify(join(DIR, "iris-session.ts").replaceAll("\\", "/"))}).then(m => console.log("PW|" + m.resolvePassword()))`,
    ],
    { cwd: SCRATCH, env: base, stdout: "pipe", stderr: "pipe" },
  );
  const line = p.stdout.toString().split(/\r?\n/).find((l) => l.startsWith("PW|"));
  return { pw: line?.slice(3), err: p.stderr.toString(), code: p.exitCode };
}

describe("where the password comes from", () => {
  test("IRIS_PASSWORD is used as given", () => {
    expect(resolveWith({ IRIS_PASSWORD: "hunter2" }).pw).toBe("hunter2");
  });

  test("unset is an empty string, not undefined", () => {
    expect(resolveWith({}).pw).toBe("");
  });

  test("IRIS_PASSWORD_CMD wins, so the plain one can be left behind without effect", () => {
    const got = resolveWith({ IRIS_PASSWORD: "stale", IRIS_PASSWORD_CMD: "echo fromcmd" });
    expect(got.pw).toBe("fromcmd");
  });

  test("only the first line is taken, so a chatty script does not send its banner", () => {
    const got = resolveWith({ IRIS_PASSWORD_CMD: "printf 'secret\\nnoise\\n'" });
    expect(got.pw).toBe("secret");
  });

  // The failure that would otherwise look like a refused login.
  test("a command that prints nothing is an error, not an empty password", () => {
    const got = resolveWith({ IRIS_PASSWORD_CMD: "true" });
    expect(got.code).not.toBe(0);
    expect(got.err).toContain("produced no password");
  });

  test("a command that fails says so and names what it ran", () => {
    const got = resolveWith({ IRIS_PASSWORD_CMD: "exit 3" });
    expect(got.code).not.toBe(0);
    expect(got.err).toContain("exit 3");
  });
});
