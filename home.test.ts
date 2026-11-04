// bun test
//
// The command builder is the security boundary of home.ts: whatever the page
// sends, only declared tools with declared arguments become argv, files stay in
// the workspace, and a value can never turn into a flag.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import { TOOLS, build, serverUrl, toolById } from "./home-tools";

const ROOT = resolve("/work/bench");
const M = ["messages", "a.hl7"].join(sep);
const t = (id: string) => toolById(id)!;

describe("build", () => {
  test("engine: message, --script class, --doctype, --host", () => {
    const b = build(t("engine-script"), { message: "messages/a.hl7", class: "Orig.cls", doctype: "Vendor:ADT_A01", host: true }, ROOT);
    if ("problems" in b) throw new Error(b.problems.join());
    expect(b.argv).toEqual(["engine.ts", M, "--script", "Orig.cls", "--doctype", "Vendor:ADT_A01", "--host"]);
    expect(b.display).toBe("bun engine.ts " + M + " --script Orig.cls --doctype Vendor:ADT_A01 --host");
  });

  test("fixed arguments come first; an empty optional is left out", () => {
    const b = build(t("overlay-gui"), { class: "Orig.cls", message: "m.hl7", doctype: "" }, ROOT);
    if ("problems" in b) throw new Error(b.problems.join());
    expect(b.argv).toEqual(["overlay.ts", "gui", "Orig.cls", "m.hl7"]);
  });

  test("a required argument missing is named", () => {
    const b = build(t("bench"), {}, ROOT);
    expect("problems" in b && b.problems[0]).toBe("Message is required.");
  });

  test("a file outside the workspace is refused", () => {
    for (const p of ["../secret.hl7", "/etc/passwd", "messages/../../x.hl7"]) {
      const b = build(t("bench"), { message: p }, ROOT);
      expect("problems" in b && b.problems[0]).toContain("outside the workspace");
    }
  });

  test("a text value cannot become a flag, or a second line", () => {
    const a = build(t("check"), { prefix: "--update" }, ROOT);
    expect("problems" in a && a.problems[0]).toContain(`may not start with "-"`);
    const b = build(t("navcheck"), { message: "m.hl7", doctype: "2.3:ADT_A01\nX" }, ROOT);
    expect("problems" in b && b.problems[0]).toContain("one line");
  });

  test("a choice must be one of its choices; the empty choice adds nothing", () => {
    const a = build(t("emit"), { what: "rm" }, ROOT);
    expect("problems" in a).toBe(true);
    const b = build(t("emit"), { what: "" }, ROOT);
    expect("problems" in b ? b.problems : b.argv).toEqual(["emit.ts"]);
    const c = build(t("emit"), { what: "process" }, ROOT);
    expect("problems" in c ? c.problems : c.argv).toEqual(["emit.ts", "process"]);
  });

  test("a flag is on only for true", () => {
    const off = build(t("reads"), { message: "m.hl7", strict: "yes" }, ROOT);
    expect("problems" in off ? off.problems : off.argv).toEqual(["reads.ts", "m.hl7"]);
  });

  test("bun test is its own shape", () => {
    const b = build(t("selftest"), {}, ROOT);
    expect("problems" in b ? b.problems : b.display).toBe("bun test");
  });

  test("a path with a space is quoted in the display, not in argv", () => {
    const b = build(t("bench"), { message: "my messages/a b.hl7" }, ROOT);
    if ("problems" in b) throw new Error(b.problems.join());
    expect(b.argv[1]).toBe(["my messages", "a b.hl7"].join(sep));
    expect(b.display).toBe(`bun bench.ts "${["my messages", "a b.hl7"].join(sep)}"`);
  });
});

describe("registry", () => {
  test("every tool's script exists in the bench", () => {
    for (const tool of TOOLS) {
      if (tool.script === "test") continue;
      expect(existsSync(join(import.meta.dir, tool.script))).toBe(true);
    }
  });

  test("ids are unique and every flag argument names its flag", () => {
    expect(new Set(TOOLS.map((x) => x.id)).size).toBe(TOOLS.length);
    for (const tool of TOOLS) for (const a of tool.args) if (a.kind === "flag") expect(a.flag?.startsWith("--")).toBe(true);
  });

  test("server tools announce a link the page can find", () => {
    expect(serverUrl("hl7-bench overlay  ->  http://127.0.0.1:7318")).toBe("http://127.0.0.1:7318");
    expect(serverUrl("nothing here")).toBeUndefined();
  });
});

describe("allowed", () => {
  const { allowed } = require("./home-tools") as typeof import("./home-tools");
  const req = (host: string, method = "GET", hdr?: string) =>
    new Request("http://127.0.0.1:7316/x", { method, headers: { host, ...(hdr ? { "x-hl7-bench": hdr } : {}) } });

  test("loopback hosts on this port pass a GET", () => {
    expect(allowed(req("127.0.0.1:7316"), 7316)).toBe(true);
    expect(allowed(req("localhost:7316"), 7316)).toBe(true);
  });

  test("a rebound hostname, another port, or no host is refused", () => {
    expect(allowed(req("evil.example:7316"), 7316)).toBe(false);
    expect(allowed(req("127.0.0.1:7317"), 7316)).toBe(false);
    expect(allowed(req("10.0.0.10:7316"), 7316)).toBe(false);
  });

  test("a POST needs the header", () => {
    expect(allowed(req("127.0.0.1:7316", "POST"), 7316)).toBe(false);
    expect(allowed(req("127.0.0.1:7316", "POST", "0"), 7316)).toBe(false);
    expect(allowed(req("127.0.0.1:7316", "POST", "1"), 7316)).toBe(true);
  });
});
