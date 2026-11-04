/**
 * overlay-gui.ts -- the page for overlay.ts. Started by `bun overlay.ts gui`.
 *
 *     bun overlay.ts gui OrigClass.cls messages\real.hl7 --doctype Vendor:ADT_A01
 *
 * Their class on one side, read-only. A form of changes on the other. Preview
 * shows the generated lines in place; Run puts the message through the class
 * before and after in IRIS and lists every field that moved; Save writes the
 * changes file, the modified class and the delivered message.
 *
 * WHAT IT WRITES, AND ONLY THAT
 *
 *   <Class>.changes.local.json   the changes (the thing you edit)
 *   <Class>.modified.cls         their class plus the marked region
 *   <message>.after.hl7          what the modified class sent, from the last Run
 *
 * The base class is never written. Bound to 127.0.0.1.
 */

import { existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { engineLabel } from "./engine-core";
import { describe, type Overlay, type SchemaMap } from "./overlay-core";
import { evaluate, explainRun, loadSchema, openSession, readText, writeOverlay, type Session } from "./overlay";

const argv = process.argv.slice(2).filter((a) => a !== "gui");
const flag = (n: string) => {
  const i = argv.indexOf(n);
  return i === -1 ? undefined : argv[i + 1];
};
const takesValue = new Set(["--doctype", "--schema", "--port"]);
const pos: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (takesValue.has(argv[i]!)) { i++; continue; }
  if (!argv[i]!.startsWith("-")) pos.push(argv[i]!);
}
if (pos.length < 2) {
  process.stderr.write(`usage: bun overlay.ts gui <Class.cls> <message.hl7> [--doctype Cat:Struct] [--schema zw.txt] [--port 7318]\n`);
  process.exit(2);
}

let session: Session;
try {
  session = openSession(pos[0]!, pos[1]!, flag("--doctype"), flag("--schema"));
} catch (e) {
  process.stderr.write(`overlay: ${(e as Error).message}\n`);
  process.exit(2);
}

let schema: SchemaMap | undefined;
let schemaNote = "";
function refreshSchema(): void {
  const r = loadSchema(session);
  schema = r.schema;
  schemaNote = r.schema ? `${r.schema.segments.size} segments, from ${r.from}` : r.error!;
}
refreshSchema();

const modifiedPath = join(dirname(session.basePath), basename(session.basePath).replace(/\.cls$/i, "") + ".modified.cls");
const afterPath = () => session.messagePath.replace(/(\.hl7|\.txt)?$/i, ".after.hl7");

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json; charset=utf-8" } });

async function body<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T; } catch { return null; }
}

/** The overlay the page sent, kept to what an overlay is. */
function fromPage(o: Partial<Overlay> | undefined): Overlay {
  return {
    base: session.overlay.base,
    docType: (o?.docType ?? session.overlay.docType).trim(),
    method: o?.method || session.overlay.method,
    anchor: o?.anchor ?? session.overlay.anchor,
    changes: Array.isArray(o?.changes) ? o!.changes : [],
  };
}

const PORT = Number(flag("--port") ?? 7318);
const page = join(import.meta.dir, "overlay.html");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      return new Response(Bun.file(page), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/state") {
      if (url.searchParams.has("refresh")) refreshSchema();
      return json({
        base: { file: basename(session.basePath), text: readText(session.basePath) },
        changesFile: basename(session.changesPath),
        modifiedFile: basename(modifiedPath),
        message: { file: basename(session.messagePath), text: existsSync(session.messagePath) ? readText(session.messagePath) : "" },
        overlay: session.overlay,
        engine: engineLabel(),
        schema: schema
          ? { ok: true, note: schemaNote, segments: [...schema.segments].sort(), repeats: [...schema.repeats].sort(), groups: schema.groups }
          : { ok: false, note: schemaNote, segments: [], repeats: [], groups: {} },
      });
    }

    if ((url.pathname === "/preview" || url.pathname === "/run") && req.method === "POST") {
      const b = await body<{ overlay?: Partial<Overlay>; message?: string }>(req);
      const o = fromPage(b?.overlay);
      if (o.docType !== session.overlay.docType) {
        session.overlay.docType = o.docType;
        refreshSchema();
      }
      if (!schema) return json({ problems: [schemaNote], notes: [] });
      const run = url.pathname === "/run";
      const t0 = performance.now();
      try {
        const r = evaluate({ ...session, overlay: o }, schema, run, b?.message);
        return json({
          ...r,
          described: o.changes.map((c) => { try { return describe(c); } catch { return ""; } }),
          runNotes: run && r.before && r.after ? [explainRun("Before", r.before), explainRun("After", r.after)].filter(Boolean) : [],
          ms: Math.round(performance.now() - t0),
        });
      } catch (e) {
        return json({ problems: [(e as Error).message], notes: [] });
      }
    }

    if (url.pathname === "/save" && req.method === "POST") {
      const b = await body<{ overlay?: Partial<Overlay>; after?: string[] }>(req);
      const o = fromPage(b?.overlay);
      if (!schema) return json({ error: schemaNote }, 400);
      const r = evaluate({ ...session, overlay: o }, schema, false);
      if (r.problems.length > 0) return json({ error: r.problems.join("\n") }, 400);
      session.overlay = o;
      writeOverlay(session.changesPath, o);
      writeFileSync(modifiedPath, r.modified!, "utf8");
      const wrote = [basename(session.changesPath), basename(modifiedPath)];
      if (Array.isArray(b?.after) && b!.after.length > 0) {
        writeFileSync(afterPath(), b!.after.join("\r\n") + "\r\n", "utf8");
        wrote.push(basename(afterPath()));
      }
      return json({ ok: true, wrote, dir: dirname(session.basePath) });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`hl7-bench overlay  ->  http://127.0.0.1:${server.port}`);
console.log(`class              ->  ${session.basePath}   (never written)`);
console.log(`changes            ->  ${session.changesPath}`);
console.log(`message            ->  ${session.messagePath}`);
console.log(`doctype            ->  ${session.overlay.docType}   schema: ${schemaNote}`);
console.log(`engine             ->  ${engineLabel()}`);
