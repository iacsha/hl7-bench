#!/usr/bin/env bun
/**
 * Local GUI for the bench.
 *
 *   bun gui.ts     ->  opens http://127.0.0.1:7317
 *
 * Why a browser page and not a native window: the browser is already on the
 * machine, bun is already required, and neither needs installing. A native GUI
 * would mean shipping another binary you cannot compile at work.
 *
 * Two things keep this honest:
 *
 *  1. It shells out to bench.ts rather than importing transform() directly, so
 *     the GUI and PipeHat run the message through the exact same code path.
 *     An in-process import would also serve a stale module after every edit.
 *  2. transform.ts on disk is the single source of truth. The editor loads from
 *     it and writes back to it, so a transform you tuned here is the one
 *     PipeHat runs, with no export step.
 *
 * Bound to 127.0.0.1 deliberately. That is not decoration: binding 0.0.0.0 is
 * what triggers the Windows Firewall prompt you cannot approve without admin,
 * and this endpoint writes a file and executes it, so it has no business
 * listening anywhere but the loopback interface.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, relative, isAbsolute, dirname, basename } from "node:path";

const DIR = import.meta.dir;
const PORT = Number(process.env.BENCH_PORT ?? 7317);
const TRANSFORM = join(DIR, "transform.ts");
const PAGE = join(DIR, "gui.html");

/**
 * Which message file the left pane loads from and saves back to.
 *
 *   bun gui.ts                             sample.hl7 (synthetic, tracked in git)
 *   bun gui.ts messages\real.hl7           a real message
 *
 * The argument matters more than it looks. sample.hl7 is the ONE .hl7 file
 * .gitignore does not exclude, because it is synthetic. Pasting a real message
 * into the page and pressing Save with no argument writes PHI into the one file
 * that gets committed. Name the file you mean, and keep real ones in messages\.
 */
const arg = process.argv.slice(2).find((a) => a.endsWith(".hl7"));
const MESSAGE = arg ? resolve(arg) : join(DIR, "sample.hl7");

/**
 * Nothing outside the bench folder gets written, whatever the page asks for.
 *
 * `relative` is computed from DIR rather than from the process working
 * directory. Resolving a relative path against cwd would make the guard depend
 * on where bun was launched from, which is exactly the kind of thing that holds
 * in testing and gives way in use.
 */
function insideBench(rel: string): boolean {
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return false;
  const r = relative(DIR, resolve(DIR, rel));
  return r !== "" && !r.startsWith("..") && !isAbsolute(r);
}

// The same parser the bench uses, bundled for the browser, so the field diff in
// the page and the transform on disk can never disagree about what PID-3(2).5
// means. One parser, two runtimes.
const built = await Bun.build({ entrypoints: [join(DIR, "hl7.ts")], target: "browser" });
if (!built.success) {
  console.error("Could not bundle hl7.ts for the browser:");
  for (const log of built.logs) console.error(log);
  process.exit(1);
}
const hl7Js = await built.outputs[0].text();

function read(path: string, fallback = ""): string {
  return existsSync(path) ? readFileSync(path, "utf8") : fallback;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// process.execPath is the bun.exe currently running. Using "bun" would assume
// it is on PATH, which is exactly what a portable install does not guarantee.
function runBench(message: string) {
  const t0 = performance.now();
  const p = Bun.spawnSync([process.execPath, join(DIR, "bench.ts")], {
    stdin: new TextEncoder().encode(message),
    stdout: "pipe",
    stderr: "pipe",
    cwd: DIR,
  });
  return {
    stdout: p.stdout.toString(),
    stderr: p.stderr.toString(),
    exitCode: p.exitCode ?? 1,
    ms: Math.round(performance.now() - t0),
  };
}

/**
 * A malformed body must come back as our own 400, not as Bun's HTML error
 * overlay. The page only ever shows `res.error`, so an unhandled throw here
 * surfaces as a wall of markup in the status bar and tells you nothing.
 */
async function body<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      return new Response(readFileSync(PAGE, "utf8"), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/hl7.js") {
      return new Response(hl7Js, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }

    if (url.pathname === "/state") {
      return json({
        message: read(MESSAGE, "MSH|^~\\&|SEND|FAC|RECV|FAC|20260101120000||ADT^A01^ADT_A01|1|P|2.5\r\n"),
        code: read(TRANSFORM),
        messageFile: relative(DIR, MESSAGE) || basename(MESSAGE),
        defaultOut: `messages/output.hl7`,
      });
    }

    if (url.pathname === "/run" && req.method === "POST") {
      const b = await body<{ message?: string; code?: string }>(req);
      if (!b) return json({ error: "Malformed request body." }, 400);
      const message = b.message ?? "";
      const code = b.code ?? "";

      if (message.trim() === "") return json({ error: "No message to transform." }, 400);

      // Persist first so what runs is what is on disk -- and so PipeHat picks
      // up the same edit without an export step.
      try {
        writeFileSync(TRANSFORM, code, "utf8");
      } catch (e) {
        return json({ error: `Could not write transform.ts: ${String(e)}` }, 500);
      }

      return json(runBench(message));
    }

    if (url.pathname === "/save-message" && req.method === "POST") {
      const b = await body<{ message?: string }>(req);
      if (!b) return json({ error: "Malformed request body." }, 400);
      try {
        writeFileSync(MESSAGE, b.message ?? "", "utf8");
        return json({ ok: true, file: relative(DIR, MESSAGE) || basename(MESSAGE) });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    // Save the transformed message. The page sends the output text it is
    // already displaying, so what lands on disk is exactly what you verified on
    // screen -- no second run, no chance of the two disagreeing.
    if (url.pathname === "/save-output" && req.method === "POST") {
      const b = await body<{ output?: string; file?: string }>(req);
      if (!b) return json({ error: "Malformed request body." }, 400);
      const target = (b.file ?? "").trim() || "messages/output.hl7";

      if (!target.endsWith(".hl7")) return json({ error: "Output filename must end in .hl7" }, 400);
      if (!insideBench(target)) return json({ error: "Refusing to write outside the bench folder." }, 400);
      if (!b.output) return json({ error: "Nothing to save -- run the transform first." }, 400);

      const full = join(DIR, target);
      try {
        mkdirSync(dirname(full), { recursive: true });
        // Written as UTF-8 with no BOM. A PowerShell `>` redirect would prepend
        // EF BB BF and break byte comparison against a golden file.
        writeFileSync(full, b.output, "utf8");
        return json({ ok: true, file: target, bytes: Buffer.byteLength(b.output) });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

const url = `http://127.0.0.1:${server.port}`;
console.log(`hl7-bench GUI  ->  ${url}`);
console.log(`editing        ->  ${TRANSFORM}`);
console.log(`message        ->  ${MESSAGE}`);
if (!arg) {
  console.log(`\n  Loading sample.hl7 -- the one .hl7 file git DOES track, because it is`);
  console.log(`  synthetic. Pressing "Save message" with a real message in the pane writes`);
  console.log(`  PHI into it. Pass a file instead:  bun gui.ts messages\\yours.hl7\n`);
}
console.log(`Ctrl+C to stop.`);

if (!process.argv.includes("--no-open")) {
  // `start` is a cmd builtin, hence the cmd /c. The empty "" is the window
  // title argument, without which a quoted URL is swallowed as the title.
  Bun.spawn(["cmd", "/c", "start", "", url], { stdout: "ignore", stderr: "ignore" });
}
