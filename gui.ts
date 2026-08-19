#!/usr/bin/env bun
/**
 * Local GUI for the bench -- a spec editor, not a code editor.
 *
 *   bun gui.ts                      opens http://127.0.0.1:7317
 *   bun gui.ts messages\yours.hl7   ...against a real message
 *
 * WHY THIS IS NOT A CODE PANE ANY MORE
 *
 * The old GUI put `transform.ts` in a textarea and let you type JavaScript at
 * it. That was backwards: the artifact you are trying to produce is
 * ObjectScript, and the last thing that should stand between you and it is a
 * second language you did not ask for. Since `spec.ts` made the interface a
 * value rather than a function, the page can edit the value directly. You fill
 * in fields; the JavaScript, the mapping document and the DTL are all printed
 * from what you filled in, live, side by side.
 *
 * WHAT IS ON SCREEN AND WHERE EACH PANE COMES FROM
 *
 *   Message      the file named on the command line, or sample.hl7
 *   Spec         the value in transform.ts, as a form
 *   Output       bench.ts, run as a subprocess, on the real message
 *   ObjectScript emit/iris.ts, the same function `bun emit.ts` calls
 *   Mapping      trace.ts, the same function `bun trace.ts` calls
 *   Source       serialize.ts, exactly the bytes written to transform.ts
 *
 * Four of those six are pure functions of the spec, so they cannot describe an
 * interface the bench does not run. The Output pane deliberately is NOT: it
 * shells out to `bench.ts` so the GUI and PipeHat put the message through the
 * identical code path, and so a stale module can never be what you approved.
 *
 * THE SPEC ON DISK IS STILL THE SOURCE OF TRUTH
 *
 * Every run writes `transform.ts` before it runs, so what PipeHat picks up is
 * what you just looked at, with no export step. The first write of a session
 * leaves `transform.ts.bak` beside it, because the rewrite replaces the spec
 * literal wholesale and comments inside that literal do not survive it. See the
 * header of `serialize.ts` for why that is the right trade and where the
 * reasoning should live instead.
 *
 * Bound to 127.0.0.1 deliberately. That is not decoration: binding 0.0.0.0 is
 * what triggers the Windows Firewall prompt you cannot approve without admin,
 * and this endpoint writes a file and executes it, so it has no business
 * listening anywhere but the loopback interface.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute, dirname, basename } from "node:path";

import { Message } from "./hl7";
import { SOURCE_KINDS, STEP_KINDS, emptyTables, validate, type Spec } from "./spec";
import { rewriteTransform } from "./serialize";
import { trace, inventory } from "./trace";
import { emitIris, routingCondition } from "./emit/iris";
import { logAuthoring } from "./log";

const DIR = import.meta.dir;
const PORT = Number(process.env.BENCH_PORT ?? 7317);
const TRANSFORM = join(DIR, "transform.ts");
const BACKUP = join(DIR, "transform.ts.bak");
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

/**
 * Load the spec fresh from disk.
 *
 * The query string is a cache buster. Bun caches a module by specifier, so a
 * plain re-import after a write serves the spec you already had, and "Reload
 * from disk" would be a button that does nothing -- the exact failure the old
 * GUI avoided by never importing transform.ts at all.
 */
async function loadSpec(): Promise<Spec> {
  const mod = await import(`./transform.ts?t=${Date.now()}`);
  return mod.spec as Spec;
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
 * Everything derived from a spec, in one place.
 *
 * Each of these is wrapped on its own because a spec can be valid enough to
 * emit and still blow up a trace on this particular message. Losing the whole
 * right-hand side of the page to one thrown error would hide the three panes
 * that were fine, and the pane that failed is usually the least interesting.
 */
function derive(spec: Spec, raw: string) {
  const attempt = (fn: () => string) => {
    try {
      return fn();
    } catch (e) {
      return `(could not render: ${e instanceof Error ? e.message : String(e)})`;
    }
  };
  let msg: Message | null = null;
  try {
    msg = new Message(raw);
  } catch {
    msg = null;
  }
  return {
    iris: attempt(() => emitIris(spec)),
    routing: attempt(() => routingCondition(spec)),
    trace: msg ? attempt(() => trace(spec, msg!)) : "(the message did not parse)",
    inventory: msg ? attempt(() => inventory(spec, msg!)) : "",
    emptyTables: emptyTables(spec),
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

/** One backup per session, taken before the first rewrite touches the file. */
let backedUp = false;
function backupOnce() {
  if (backedUp || !existsSync(TRANSFORM)) return;
  copyFileSync(TRANSFORM, BACKUP);
  backedUp = true;
  console.log(`saved a copy of your hand-written transform to ${basename(BACKUP)}`);
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
      let spec: Spec | null = null;
      let specError: string | null = null;
      try {
        spec = await loadSpec();
      } catch (e) {
        specError = e instanceof Error ? (e.stack ?? e.message) : String(e);
      }
      return json({
        message: read(MESSAGE, "MSH|^~\\&|SEND|FAC|RECV|FAC|20260101120000||ADT^A01^ADT_A01|1|P|2.5\r\n"),
        spec,
        specError,
        messageFile: relative(DIR, MESSAGE) || basename(MESSAGE),
        transformFile: basename(TRANSFORM),
        defaultOut: "messages/output.hl7",
        // Served rather than hardcoded in the page so a kind added to spec.ts
        // shows up in the dropdown the moment it exists. The page says plainly
        // when it has no form for one, which is the loud version of the gap.
        sourceKinds: SOURCE_KINDS,
        stepKinds: STEP_KINDS,
      });
    }

    /**
     * Render every derived view of a spec WITHOUT touching disk or running
     * anything. This is what the page calls while you type.
     */
    if (url.pathname === "/preview" && req.method === "POST") {
      const b = await body<{ spec?: Spec; message?: string }>(req);
      if (!b?.spec) return json({ error: "No spec in the request." }, 400);
      const problems = validate(b.spec);
      let source = "";
      try {
        source = rewriteTransform(read(TRANSFORM), b.spec);
      } catch (e) {
        source = `(could not splice into transform.ts: ${e instanceof Error ? e.message : String(e)})`;
      }
      return json({ problems, source, ...derive(b.spec, b.message ?? "") });
    }

    /**
     * Write the spec to transform.ts and run the real bench over it.
     *
     * A spec that does not validate is never written. A file on disk that the
     * CLI would refuse is worse than an unsaved edit, because the next thing
     * anybody does is run the CLI.
     */
    if (url.pathname === "/run" && req.method === "POST") {
      const b = await body<{ spec?: Spec; message?: string }>(req);
      if (!b?.spec) return json({ error: "No spec in the request." }, 400);
      const message = b.message ?? "";
      if (message.trim() === "") return json({ error: "No message to transform." }, 400);

      const problems = validate(b.spec);
      const derived = derive(b.spec, message);

      // The shape currently on disk, read before anything overwrites it, so
      // the log can say what this save actually changed rather than only what
      // it ended up as. `loadSpec` cache-busts its import, so this is the real
      // file and not the copy this process read at startup. A transform.ts
      // that will not import is not an error here: it is the normal state
      // halfway through a hand edit, and it means "before" is unknown.
      let before: Spec | null = null;
      try {
        before = await loadSpec();
      } catch {
        before = null;
      }
      const shape = (s: Spec | null) =>
        s ? { blocks: s.blocks.length, rows: s.blocks.reduce((n, x) => n + x.rows.length, 0) } : null;
      const was = shape(before);
      const now = shape(b.spec)!;

      if (problems.length > 0) {
        // Validation problems name rows and paths, not values, but they are
        // notes for the same reason the bench's are: one rule about what lands
        // on disk, applied everywhere, with no exceptions to remember.
        logAuthoring(
          { spec: b.spec.name, action: "run", blocks: now.blocks, rows: now.rows,
            problems: problems.length, saved: "no", result: "invalid" },
          problems,
        );
        return json({ problems, saved: false, ...derived });
      }

      let source: string;
      try {
        source = rewriteTransform(read(TRANSFORM), b.spec);
      } catch (e) {
        logAuthoring({ spec: b.spec.name, action: "run", saved: "no", result: "serialize-failed" }, [String(e)]);
        return json({ error: `Could not write transform.ts: ${String(e)}` }, 500);
      }

      try {
        backupOnce();
        writeFileSync(TRANSFORM, source, "utf8");
      } catch (e) {
        logAuthoring({ spec: b.spec.name, action: "run", saved: "no", result: "write-failed" }, [String(e)]);
        return json({ error: `Could not write transform.ts: ${String(e)}` }, 500);
      }

      const bench = runBench(message);

      // What changed and what the bench made of it, on one line. The spec
      // itself is not in here: that is what git is for, and a log that
      // duplicated the file would be a worse copy of it.
      logAuthoring({
        spec: b.spec.name,
        action: "run",
        blocksBefore: was?.blocks ?? "unknown",
        rowsBefore: was?.rows ?? "unknown",
        blocks: now.blocks,
        rows: now.rows,
        saved: "yes",
        bytes: source.length,
        exit: bench.exitCode,
        ms: bench.ms,
        result: bench.exitCode === 0 ? "ok" : "bench-failed",
      });

      return json({ problems: [], saved: true, source, ...derived, ...bench });
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

    // Save the generated class. Same bytes as `bun emit.ts > My.cls`, which is
    // the point: the button is a convenience over the CLI, not a second path.
    if (url.pathname === "/save-iris" && req.method === "POST") {
      const b = await body<{ iris?: string; file?: string }>(req);
      if (!b) return json({ error: "Malformed request body." }, 400);
      const target = (b.file ?? "").trim();
      if (!target.endsWith(".cls")) return json({ error: "Class filename must end in .cls" }, 400);
      if (!insideBench(target)) return json({ error: "Refusing to write outside the bench folder." }, 400);
      if (!b.iris) return json({ error: "Nothing to save." }, 400);

      const full = join(DIR, target);
      try {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, b.iris, "utf8");
        return json({ ok: true, file: target, bytes: Buffer.byteLength(b.iris) });
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
console.log(`\n  The page edits the SPEC, not the code. Saving rewrites the spec literal`);
console.log(`  in transform.ts and leaves everything around it alone. Comments INSIDE`);
console.log(`  that literal are lost; put the reasoning in note/description/outOfScope,`);
console.log(`  where the mapping document and the generated DTL both carry it.`);
if (!arg) {
  console.log(`\n  Loading sample.hl7 -- the one .hl7 file git DOES track, because it is`);
  console.log(`  synthetic. Pressing "Save message" with a real message in the pane writes`);
  console.log(`  PHI into it. Pass a file instead:  bun gui.ts messages\\yours.hl7`);
}
console.log(`\nCtrl+C to stop.`);

if (!process.argv.includes("--no-open")) {
  // `start` is a cmd builtin, hence the cmd /c. The empty "" is the window
  // title argument, without which a quoted URL is swallowed as the title.
  Bun.spawn(["cmd", "/c", "start", "", url], { stdout: "ignore", stderr: "ignore" });
}
