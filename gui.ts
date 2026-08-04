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

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;
const PORT = Number(process.env.BENCH_PORT ?? 7317);
const TRANSFORM = join(DIR, "transform.ts");
const SAMPLE = join(DIR, "sample.hl7");
const PAGE = join(DIR, "gui.html");

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
        message: read(SAMPLE, "MSH|^~\\&|SEND|FAC|RECV|FAC|20260101120000||ADT^A01^ADT_A01|1|P|2.5\r\n"),
        code: read(TRANSFORM),
      });
    }

    if (url.pathname === "/run" && req.method === "POST") {
      const body = (await req.json()) as { message?: string; code?: string };
      const message = body.message ?? "";
      const code = body.code ?? "";

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
      const body = (await req.json()) as { message?: string };
      try {
        writeFileSync(SAMPLE, body.message ?? "", "utf8");
        return json({ ok: true });
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
console.log(`Ctrl+C to stop.`);

if (!process.argv.includes("--no-open")) {
  // `start` is a cmd builtin, hence the cmd /c. The empty "" is the window
  // title argument, without which a quoted URL is swallowed as the title.
  Bun.spawn(["cmd", "/c", "start", "", url], { stdout: "ignore", stderr: "ignore" });
}
