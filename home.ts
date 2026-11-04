#!/usr/bin/env bun
/**
 * home.ts -- one page for every bench command.
 *
 *     bun home.ts                 http://127.0.0.1:7316
 *     bun home.ts --port 7400
 *
 * Pick a tool, fill its form (files are picked from this folder), Run. The
 * output streams into the page, and the exact command is printed above it with
 * a Copy button, so the command line is learned by using the page. The spec
 * editor and the overlay page start from here too, with a link and a Stop.
 *
 * What it can run is fixed in home-tools.ts. It spawns `bun` with an argv
 * array, never a shell; file arguments must be inside this folder; and every
 * POST needs a header a cross-site page cannot send without a preflight this
 * server never answers. Bound to 127.0.0.1.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

import { TOOLS, build, serverUrl, toolById, type Values } from "./home-tools";

const BENCH = import.meta.dir;
const ROOT = process.cwd();
const argv = process.argv.slice(2);
const pi = argv.indexOf("--port");
const PORT = pi === -1 ? 7316 : Number(argv[pi + 1]);

// ---------------------------------------------------------------------------
// Files the forms can pick
// ---------------------------------------------------------------------------

const SKIP = new Set(["node_modules", ".git", "logs", ".claude", ".vscode", "bak"]);
const KINDS: Record<string, string[]> = {
  message: [".hl7", ".txt"],
  class: [".cls"],
  file: [".txt", ".zw", ".hl7", ".cls", ".json", ".csv", ".xml"],
};

function listFiles(): Record<string, string[]> {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n.startsWith(".") || SKIP.has(n)) continue;
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth < 3) walk(p, depth + 1); continue; }
      found.push(relative(ROOT, p));
      if (found.length > 2000) return;
    }
  };
  walk(ROOT, 0);
  const out: Record<string, string[]> = {};
  for (const [k, exts] of Object.entries(KINDS)) {
    out[k] = found
      .filter((f) => exts.includes(extname(f).toLowerCase()))
      .filter((f) => !(k === "message" && /^(README|ROADMAP|CHANGELOG|LICENSE)/i.test(f)))
      .sort((a, b) => Number(a.includes(sep)) - Number(b.includes(sep)) || a.localeCompare(b));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

type Running = { proc: ReturnType<typeof Bun.spawn>; tool: string; display: string; url?: string; started: number };
const running = new Map<string, Running>();
let nextId = 1;

function stopAll() {
  for (const r of running.values()) { try { r.proc.kill(); } catch { /* gone */ } }
}
process.on("SIGINT", () => { stopAll(); process.exit(0); });
process.on("SIGTERM", () => { stopAll(); process.exit(0); });
process.on("exit", stopAll);

const enc = new TextEncoder();

/**
 * Start a tool and stream its output. The stream is plain text with three
 * kinds of control line the page reads: RUN|<id> first, CMD|<command> second,
 * EXIT|<code> last. Everything between is the tool's own stdout and stderr,
 * interleaved as it arrives.
 */
function start(toolId: string, values: Values): Response {
  const tool = toolById(toolId);
  if (!tool) return json({ error: `No tool "${toolId}".` }, 400);
  const b = build(tool, values, ROOT);
  if ("problems" in b) return json({ error: b.problems.join("\n") }, 400);

  // A server tool is one instance at a time: a second gui.ts would fail on the port anyway.
  if (tool.server) {
    for (const [id, r] of running) if (r.tool === tool.id) return json({ error: `${tool.title} is already running${r.url ? ` at ${r.url}` : ""}. Stop it first.`, id }, 409);
  }

  const args = tool.script === "test" ? ["test"] : [join(BENCH, b.argv[0]!), ...b.argv.slice(1)];
  const proc = Bun.spawn([process.execPath, ...args], {
    cwd: tool.script === "test" ? BENCH : ROOT,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  const id = String(nextId++);
  const rec: Running = { proc, tool: tool.id, display: b.display, started: Date.now() };
  running.set(id, rec);

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      let open = true;
      const send = (s: string) => { if (open) { try { ctrl.enqueue(enc.encode(s)); } catch { open = false; } } };
      send(`RUN|${id}\nCMD|${b.display}\n`);
      const pump = async (r: ReadableStream<Uint8Array>) => {
        const dec = new TextDecoder();
        for await (const chunk of r) {
          const text = dec.decode(chunk, { stream: true });
          if (tool.server && !rec.url) rec.url = serverUrl(text);
          send(text);
        }
      };
      await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]);
      const code = await proc.exited;
      running.delete(id);
      send(`\nEXIT|${code}\n`);
      if (open) { try { ctrl.close(); } catch { /* closed by client */ } }
    },
    cancel() {
      // The page navigated away. A one-shot tool is pointless to finish; a
      // server keeps running until Stop, so the editor tab stays usable.
      if (!tool.server) { try { proc.kill(); } catch { /* gone */ } }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

// ---------------------------------------------------------------------------

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json; charset=utf-8" } });

/**
 * A POST must carry this header. A form on another site cannot set it without
 * a CORS preflight, and nothing here answers OPTIONS, so a page you happen to
 * have open elsewhere cannot start a command on this one.
 */
const GUARD = "x-hl7-bench";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && req.headers.get(GUARD) !== "1") return new Response("Forbidden", { status: 403 });

    if (url.pathname === "/") {
      return new Response(Bun.file(join(BENCH, "home.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/tools") {
      return json({
        tools: TOOLS,
        files: listFiles(),
        root: ROOT,
        env: {
          spec: process.env.HL7_BENCH_TRANSFORM ?? "transform.ts",
          specExists: existsSync(resolve(ROOT, process.env.HL7_BENCH_TRANSFORM ?? "transform.ts")),
          engine: process.env.IRIS_CMD ? "IRIS_CMD" : `IRIS_MODE=${process.env.IRIS_MODE ?? "docker"}`,
          namespace: process.env.IRIS_NAMESPACE ?? "USER",
          labDir: process.env.IRIS_LAB_DIR ?? "(unset)",
        },
      });
    }
    if (url.pathname === "/running") {
      return json([...running.entries()].map(([id, r]) => ({ id, tool: r.tool, display: r.display, url: r.url, started: r.started })));
    }
    if (url.pathname === "/run" && req.method === "POST") {
      let b: { tool?: string; values?: Values } | null = null;
      try { b = await req.json(); } catch { /* below */ }
      if (!b?.tool) return json({ error: "No tool named." }, 400);
      return start(b.tool, b.values ?? {});
    }
    if (url.pathname === "/stop" && req.method === "POST") {
      let b: { id?: string } | null = null;
      try { b = await req.json(); } catch { /* below */ }
      const r = b?.id ? running.get(b.id) : undefined;
      if (!r) return json({ ok: false, error: "Not running." }, 404);
      try { r.proc.kill(); } catch { /* gone */ }
      return json({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`hl7-bench home  ->  http://127.0.0.1:${server.port}`);
console.log(`workspace       ->  ${ROOT}`);
console.log(`Ctrl+C stops this and anything it started.`);
