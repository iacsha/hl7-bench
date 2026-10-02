/**
 * emit/promote.ts -- what has to happen in each namespace, from the spec.
 *
 *   bun emit.ts promote -o Promote.md
 *
 * WHY A CHECKLIST AND NOT A DIFF
 *
 * The roadmap asked for "what differs between environments", on the
 * assumption that class names and config items change from DEV to QA to PROD.
 * In practice the same class is promoted unchanged. What differs is everything
 * that does NOT travel with a class: lookup tables, a custom schema category,
 * a router's filter row, a host restart, and the superseded class somebody
 * left behind in DEV. Every one of those is a hand-repeated step per namespace,
 * and a list generated from the spec is a list that cannot forget the table.
 *
 * MSH-11
 *
 * A promoted class is byte-identical in every namespace, so anything it writes
 * as a constant is the same constant in DEV and PROD. A processing id hard-coded
 * as "P", or given a "P" fallback for when the sender leaves it empty, sends
 * production-flagged messages from a test system. That was a review finding on
 * a shipped interface. The rule adopted: copy MSH-11 from the source, never
 * default it, and log it when it arrives empty. `processingId()` says which of
 * those a spec does, and `bun emit.ts` prints the hazard on every run.
 */

import { filterExpression, routingCondition } from "./iris";
import { emptyTables, gateTables, type Row, type Spec } from "../spec";

export interface ProcessingId {
  /** One line: how MSH-11 is set. */
  how: string;
  /** Set when the value would be the same in every namespace, or never logged. */
  hazard?: string;
}

/** Every row in a block for MSH that writes MSH-11. */
function msh11Rows(spec: Spec): { row: Row; whole: boolean }[] {
  const out: { row: Row; whole: boolean }[] = [];
  for (const block of spec.blocks) {
    if (block.id !== "MSH") continue;
    for (const row of block.rows) {
      if (row.target === "MSH-11") out.push({ row, whole: block.wholeSegment === true });
    }
  }
  return out;
}

/** Whether the outbound MSH starts as a copy of the inbound one. */
function mshSeeded(spec: Spec): boolean {
  const transform = spec.iris.process?.transform;
  if (transform === "patch") return true;
  if (spec.iris.create === "copy") return true;
  return spec.blocks.some((b) => b.id === "MSH" && b.wholeSegment === true);
}

export function processingId(spec: Spec): ProcessingId {
  const stamp = (spec.iris.process?.stamp ?? []).find((s) => s.path === "MSH-11");
  if (stamp) {
    return {
      how: `stamped "${stamp.value}" by the process`,
      hazard:
        `MSH-11 is stamped "${stamp.value}", the same in every namespace the class is promoted to. ` +
        `Copy it from the source instead.`,
    };
  }

  const rows = msh11Rows(spec);
  if (rows.length === 0) {
    return mshSeeded(spec)
      ? {
          how: "copied from the source with the MSH segment",
          hazard:
            `MSH-11 is copied with the segment, so an empty one goes out empty and nothing logs it. ` +
            `Add { target: "MSH-11", from: copy("MSH-11"), required: true } to make the empty case visible.`,
        }
      : {
          how: "never written",
          hazard: `MSH-11 is never written, so every message goes out without a processing id.`,
        };
  }

  const { row } = rows[rows.length - 1];
  const fallback = (row.via ?? []).find((s) => s.kind === "defaultTo");
  if (row.from.kind === "literal") {
    return {
      how: `literal "${row.from.value}"`,
      hazard:
        `MSH-11 is the literal "${row.from.value}", the same in every namespace the class is promoted to. ` +
        `Copy it from the source instead.`,
    };
  }
  if (fallback && fallback.kind === "defaultTo") {
    return {
      how: `${row.from.kind}, falling back to "${fallback.value}"`,
      hazard:
        `MSH-11 falls back to "${fallback.value}" when the sender leaves it empty, in every namespace. ` +
        `Drop the defaultTo and mark the row required, so an empty one is logged instead of filled.`,
    };
  }
  if (row.from.kind === "copy" || row.from.kind === "firstOf") {
    const from = row.from.kind === "copy" ? row.from.path : row.from.paths.join(", then ");
    return row.required
      ? { how: `copied from ${from}, required, so an empty one is logged` }
      : {
          how: `copied from ${from}`,
          hazard: `MSH-11 is copied but not required, so an empty one goes out empty and nothing logs it.`,
        };
  }
  return {
    how: `set by ${row.from.kind}`,
    hazard: `MSH-11 is set by ${row.from.kind}. Check that it does not come out the same in every namespace.`,
  };
}

/** Which classes a namespace compiles for this spec, in compile order. */
function classes(spec: Spec): { name: string; how: string; note: string }[] {
  const out: { name: string; how: string; note: string }[] = [];
  const proc = spec.iris.process;
  const transform = proc?.transform ?? "dtl";
  // Inline, patch and build carry the mapping in the process. The DTL is only
  // a class this namespace needs when the process calls it, or when there is no
  // process and a routing rule calls it directly.
  if (!proc || transform === "dtl") {
    out.push({ name: spec.iris.className, how: "bun emit.ts", note: "the transform" });
  }
  if (proc) {
    out.push({
      name: proc.className,
      how: "bun emit.ts process",
      note: `dispatches to "${proc.sendTo}", which must exist in this production under exactly that name`,
    });
  }
  return out;
}

export function emitPromote(spec: Spec, fingerprint: string, filterWrap?: string): string {
  const box = (s: string) => `- [ ] ${s}`;
  const out: string[] = [
    `# Promotion checklist: ${spec.name}`,
    ``,
    `Generated by hl7-bench from the spec. Spec fingerprint \`${fingerprint}\`.`,
    `Work through it once per namespace, in promotion order.`,
    ``,
    `## Classes`,
    ``,
  ];

  for (const c of classes(spec)) out.push(box(`Compile \`${c.name}\` (\`${c.how}\`): ${c.note}.`));
  out.push(
    box(`Check each class header shows fingerprint \`${fingerprint}\`. A different one is an older compile.`),
    box(`Delete superseded classes from earlier builds before promoting. The spec does not track them.`),
    ``,
    `## Namespace data`,
    ``,
    `None of this travels with a class export or a production deployment.`,
    ``,
  );

  const tables = Object.keys(spec.tables ?? {});
  const empty = new Set(emptyTables(spec));
  if (tables.length > 0) {
    out.push(box(`Import lookup tables \`${tables.join("`, `")}\` (\`bun emit.ts tables -o Tables.xml\`, Import button).`));
    for (const t of tables.filter((n) => empty.has(n))) {
      out.push(`  - **${t} is empty in the spec.** It returns the unmapped branch, or refuses every message if it gates.`);
    }
  } else {
    out.push(`- No lookup tables.`);
  }

  const sch = spec.iris.schema;
  if (sch) {
    out.push(box(`Import schema category \`${sch.category}\` (\`bun emit.ts schema\`) before the class runs. Without it every path reads empty and nothing errors.`));
  }
  for (const e of spec.iris.externalSchemas ?? []) {
    // The note can carry a whole captured structure string. A checklist line
    // wants the first sentence; the spec keeps the rest.
    const first = e.note.split(/(?<=\.)\s/)[0] ?? "";
    const note = first.length > 160 ? `${first.slice(0, 157)}...` : first;
    out.push(box(`Confirm schema category \`${e.category}\` already exists here. ${note}`));
  }

  out.push(``, `## Routing`, ``);
  const gt = gateTables(spec);
  out.push(
    box(`Routing rule condition: \`${routingCondition(spec)}\``),
    box(`Or, for a router that stores its filter as text: \`${filterWrap ? filterWrap.replace("{expr}", () => filterExpression(spec)) : filterExpression(spec)}\``),
  );
  if (gt.length > 0) {
    out.push(`  - The gate reads \`${gt.join("`, `")}\`. Import it first, then change the filter. Out of order refuses every message.`);
  }
  out.push(box(`Restart the router and the process host. A router that caches its filters keeps the old one until restarted.`));

  const pid = processingId(spec);
  out.push(``, `## Processing id (MSH-11)`, ``, `- ${pid.how}.`);
  if (pid.hazard) out.push(`- **${pid.hazard}**`);

  out.push(
    ``,
    `## After`,
    ``,
    box(`Send one message the gate permits and one it refuses (\`bun gate.ts\` says which is which), and see each land where it should.`),
    box(`Read MSH-11 on the delivered message.`),
    ``,
  );
  return out.join("\n");
}
