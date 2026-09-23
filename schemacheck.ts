#!/usr/bin/env bun
/**
 * schemacheck.ts -- does the spec agree with the schema the engine will walk?
 *
 *   bun schemacheck.ts schema.zw              check the spec against a dump
 *   bun schemacheck.ts --commands             what to paste to GET that dump
 *   bun schemacheck.ts schema.zw -o found.txt write the report to a file
 *   bun schemacheck.ts --diff a.txt b.txt     have two instances drifted apart?
 *
 * TWO QUESTIONS, TWO MODES
 *
 * The default mode asks "does my spec match this schema". `--diff` asks "do
 * these two instances still have the same schema", takes no spec at all, and is
 * the one that decides whether developing against a local instance means
 * anything: the local box is a valid proxy for the target for exactly as long
 * as their schemas agree, and nothing announces the morning that stops being
 * true. Run it before each deploy.
 *
 * THE FAILURE THIS EXISTS FOR, MEASURED
 *
 * A spec had a `GT1` block with `wholeSegment: true` and no `repeat`. The
 * emitter therefore wrote bare `GT1` paths. In IRIS, `GetValueAt("GT1")` on a
 * segment the schema marks as repeating returns EMPTY:
 *
 *     SRC_GT1_bare|[]
 *     SRC_GT1_idx |[GT1|1||TEST^NOK||1 PT ADDR^^PT CITY^TN^4]
 *
 * The seed came back empty, the absent-seed guard correctly delivered no
 * segment, and the deployed interface silently dropped GT1 and three mapped
 * fields. `bun check.ts` was green throughout, because `run.ts` has a flat
 * message model that finds `GT1` by name whatever the schema says about
 * repeats. `emit.ts` now prints a BARE SEGMENT PATHS warning, and a warning is
 * a prompt you skim past at 4pm on a go-live. This is the gate.
 *
 * WHY IT READS A PASTED DUMP AND NOT AN INSTANCE
 *
 * `navcheck.ts` and `schema-sync.ts` talk to IRIS, and that is the right shape
 * when you can reach IRIS. Often the target is a shared dev instance on another
 * server, reached only over a terminal session.
 * `irisdb.exe -s <mgr>` opens a LOCAL instance only, so there is no connection
 * for those two tools to make and the settings that would configure one are not
 * set.
 *
 * A `zw` dump costs one paste, needs no credential, works from any box, and can
 * sit in the workspace so this gate runs on every emit. That is strictly more
 * available than a connection, which is the property that decides whether a
 * check actually runs.
 *
 *     bun schemacheck.ts --commands          prints the zw lines for THIS spec
 *
 * WHAT IT IS TOLERANT OF, AND WHAT IT REFUSES TO BE TOLERANT OF
 *
 * The input is a terminal paste, so banner lines, a `DEV-NS>` prompt in front
 * of the data, CRLF, blank lines, the echoed `zw` command itself and several
 * structures concatenated are all fine -- anything unrecognised is ignored.
 *
 * What it will NOT do is ignore a line quietly. A `^EnsHL7.Schema` line this
 * parser could not read is COUNTED and PRINTED, because "silently skipped the
 * one line that mattered" is the same class of failure as the bug above and
 * would be committed by the tool built to catch it.
 */

import {
  segmentOf,
  sourcePathsOf,
  type Block,
  type Spec,
} from "./spec";
import { emitIris, newBareRefs, type BareRefs } from "./emit/iris";
import { emitProcess } from "./emit/process";

// ---------------------------------------------------------------------------
// The dump
// ---------------------------------------------------------------------------

/** One `map` entry: where a structure keeps one segment, and whether it repeats. */
export interface SchemaEntry {
  /** "2.3:ADT_A01" -- category and structure, spelled the way a spec spells it. */
  docType: string;
  /** "IN1". Not necessarily three characters: `leftoversegs` is a real entry. */
  segment: string;
  /** The segment's own subscript carried `()`. */
  repeats: boolean;
  /** Enclosing groups, `()` and `(n)` stripped: "IN1grp", or "" at the top level. */
  groupPath: string;
  /** Any enclosing group carried `()`. */
  groupRepeats: boolean;
  /**
   * Each enclosing group and whether IT carried `()`, outermost first.
   *
   * `groupRepeats` collapses this to one boolean, which answers "is this segment
   * reachable without an index somewhere in the path" and cannot answer "which
   * group is the one that needs the index". The bare-group rule needs the second.
   */
  groupParts: { name: string; repeats: boolean }[];
  /** The subscript exactly as the dump spelled it: "IN1grp().IN1". */
  raw: string;
}

export interface SchemaDump {
  /** docType -> segment id -> every place that structure keeps it. */
  structures: Map<string, Map<string, SchemaEntry[]>>;
  /** `map` entries understood. */
  mapEntries: number;
  /** Well-formed `^EnsHL7.Schema` lines that are not `map` entries. Benign. */
  ignored: number;
  /** Echoed `zw ^EnsHL7.Schema(...)` command lines, which carry no value. */
  commands: number;
  /**
   * `^EnsHL7.Schema` lines this parser could not read, verbatim.
   *
   * Never summarised away. One unreadable line can be the segment the whole
   * check was about, and a count of zero is the only count that means the
   * answer below is complete.
   */
  unparsed: string[];
}

const SCHEMA_GLOBAL = "^EnsHL7.Schema(";

interface Subscript {
  text: string;
  quoted: boolean;
}

/**
 * Split `^EnsHL7.Schema(a,b,c)="value"` into its subscripts and its value.
 *
 * Hand-rolled rather than regexed because the subscripts contain the two
 * characters a regex would have to guess about: `"GT1()"` puts parentheses
 * inside a quoted string, and `""` is how ObjectScript escapes a quote inside
 * one. Counting depth outside quotes is the only reading that gets both right.
 *
 * Returns `undefined` when the line does not close, which is the caller's
 * signal to report it rather than drop it. A `value` of `undefined` means the
 * line closed and carried no `=` -- the echoed command, not data.
 */
function tokenize(line: string): { args: Subscript[]; value?: string } | undefined {
  const args: Subscript[] = [];
  let cur = "";
  let quoted = false;
  let inQuote = false;
  let depth = 0;
  let i = SCHEMA_GLOBAL.length;
  let closed = false;

  for (; i < line.length; i++) {
    const c = line[i]!;
    if (inQuote) {
      // `""` inside a string is one literal quote, not the end of the string.
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
          continue;
        }
        inQuote = false;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      quoted = true;
      continue;
    }
    if (c === "(") {
      depth++;
      cur += c;
      continue;
    }
    if (c === ")") {
      if (depth === 0) {
        closed = true;
        break;
      }
      depth--;
      cur += c;
      continue;
    }
    if (c === "," && depth === 0) {
      args.push({ text: cur, quoted });
      cur = "";
      quoted = false;
      continue;
    }
    cur += c;
  }

  if (!closed || inQuote || depth !== 0) return undefined;
  args.push({ text: cur, quoted });

  const rest = line.slice(i + 1).trim();
  if (rest === "") return { args };
  if (!rest.startsWith("=")) return undefined;

  let value = rest.slice(1).trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1).replace(/""/g, '"');
  }
  return { args, value };
}

/** A subscript as text. Only UNQUOTED ones are trimmed; a quoted space is data. */
const subText = (s: Subscript): string => (s.quoted ? s.text : s.text.trim());

interface KeyPart {
  name: string;
  repeats: boolean;
}

/**
 * "IN1grp().IN1" into its parts. The last one is the segment, the rest are the
 * groups it sits inside, outermost first.
 *
 * `()` means repeats. `(1)` -- a fixed occurrence -- does not, and is kept
 * distinct rather than folded into the same answer, because "there is exactly
 * one of these" and "there are many of these" are the two answers this whole
 * file exists to tell apart.
 */
function splitEntryKey(key: string): KeyPart[] | undefined {
  if (key.trim() === "") return undefined;
  const parts: KeyPart[] = [];
  for (const raw of key.split(".")) {
    const m = /^([A-Za-z][A-Za-z0-9_]*)(?:\((\d*)\))?$/.exec(raw.trim());
    if (!m) return undefined;
    parts.push({ name: m[1]!, repeats: m[2] === "" });
  }
  return parts;
}

/**
 * Read a terminal paste.
 *
 * A line is ours if `^EnsHL7.Schema(` appears ANYWHERE in it, and reading
 * starts at that offset -- which is what makes a `DEV-NS>` prompt, an indent
 * or a timestamp in front of the data cost nothing. A line without it is not
 * ours and is not counted: banners, blank lines and the prompt on its own line
 * are the normal contents of a paste, not findings.
 */
export function parseDump(text: string): SchemaDump {
  const structures = new Map<string, Map<string, SchemaEntry[]>>();
  const unparsed: string[] = [];
  let mapEntries = 0;
  let ignored = 0;
  let commands = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const at = rawLine.indexOf(SCHEMA_GLOBAL);
    if (at === -1) continue;

    const t = tokenize(rawLine.slice(at));
    if (!t) {
      unparsed.push(rawLine.trim());
      continue;
    }
    if (t.value === undefined) {
      commands++;
      continue;
    }

    const args = t.args.map(subText);
    // ("<category>","MS","<structure>","map","<entry>"). Anything else is a
    // different part of the global -- names, versions, the category list --
    // and is none of this tool's business.
    if (args.length !== 5 || args[1] !== "MS" || args[3] !== "map") {
      ignored++;
      continue;
    }

    const parts = splitEntryKey(args[4]!);
    if (!parts) {
      unparsed.push(rawLine.trim());
      continue;
    }

    const docType = `${args[0]}:${args[2]}`;
    const seg = parts[parts.length - 1]!;
    const groups = parts.slice(0, -1);

    let bySegment = structures.get(docType);
    if (!bySegment) {
      bySegment = new Map<string, SchemaEntry[]>();
      structures.set(docType, bySegment);
    }
    // A segment can have more than one home in one structure -- an ORU keeps
    // OBX under both OBRgrp and OBXgrp. Keeping every home is what lets the
    // group check name the alternatives instead of asserting the last one read.
    const homes = bySegment.get(seg.name) ?? [];
    homes.push({
      docType,
      segment: seg.name,
      repeats: seg.repeats,
      groupPath: groups.map((g) => g.name).join("."),
      groupRepeats: groups.some((g) => g.repeats),
      groupParts: groups,
      raw: args[4]!,
    });
    bySegment.set(seg.name, homes);
    mapEntries++;
  }

  return { structures, mapEntries, ignored, commands, unparsed };
}

// ---------------------------------------------------------------------------
// Spelling
// ---------------------------------------------------------------------------

/**
 * A spec's group path as the dump spells one: occurrence indices removed.
 *
 * `iris.sourceGroups` is written with them -- "ORCgrp(1).OBXgrp" -- because the
 * emitter writes that string into a path. The schema states structure, not
 * occurrence. Comparing the two without this reports every correct spec.
 */
export function normaliseGroupPath(g: string): string {
  return g
    .split(".")
    .map((p) => p.replace(/\((?:\d*|\*)\)$/, ""))
    .join(".");
}

/** "2.3:ADT_A01" into its two halves, or undefined when it is not that shape. */
export function docTypeParts(docType: string): { category: string; structure: string } | undefined {
  const i = docType.indexOf(":");
  if (i <= 0 || i === docType.length - 1) return undefined;
  return { category: docType.slice(0, i), structure: docType.slice(i + 1) };
}

// ---------------------------------------------------------------------------
// What the spec addresses
// ---------------------------------------------------------------------------

/**
 * Every SOURCE segment one block reads.
 *
 * `sourceInventory` is deliberately absent: it documents fields for the
 * receiving team and the transform does not read it, so a stale entry there is
 * a documentation defect and not a mapping one. Failing an emit over it would
 * make this gate something people turn off.
 */
function blockSourceSegments(b: Block): Set<string> {
  const out = new Set<string>();
  // A seed copies the SOURCE segment of the same id, whole.
  if (b.wholeSegment) out.add(b.id);
  if (b.repeat) {
    const r = b.repeat;
    out.add(r.over);
    // These decide how many segments exist, so a spec can navigate perfectly on
    // every row and still deliver nothing. Same reason navcheck reads them.
    if (r.skipWhenEmpty) out.add(segmentOf(r.skipWhenEmpty));
    if (r.select) out.add(segmentOf(r.select.path));
    if (r.fold) out.add(segmentOf(r.fold.path));
  }
  for (const row of b.rows) {
    for (const p of sourcePathsOf(row.from)) out.add(segmentOf(p));
    // `fromFirst` and `fromWhere` name their segment outright as well as in
    // their paths. Reading both means a spec that disagrees with itself is
    // reported rather than half-checked.
    if (row.from.kind === "fromFirst" || row.from.kind === "fromWhere") out.add(row.from.segment);
    if (row.from.kind === "lookup" && row.from.from) {
      const k = row.from.from;
      if (k.kind === "fromFirst" || k.kind === "fromWhere") out.add(k.segment);
    }
  }
  return out;
}

/** Every SOURCE segment the spec reads, the gate's own path included. */
export function sourceSegments(spec: Spec): Set<string> {
  const out = new Set<string>([segmentOf(spec.gate.path)]);
  for (const b of spec.blocks) for (const s of blockSourceSegments(b)) out.add(s);
  return out;
}

/** Every TARGET segment the spec writes. */
export function targetSegments(spec: Spec): Set<string> {
  return new Set(spec.blocks.map((b) => b.id));
}

/** The blocks that read `segment` on the source side, for attributing a finding. */
function blocksReading(spec: Spec, segment: string): Block[] {
  return spec.blocks.filter((b) => blockSourceSegments(b).has(segment));
}

/**
 * Segment ids the emitter addresses with NO occurrence index, taken from the
 * emitter itself.
 *
 * Not re-derived here, and that is the whole design. The rules that decide
 * whether a reference carries an index -- `sourceGroups`, a loop prefix, the
 * escape branches in `dtlPath` -- live in `emit/iris.ts`. A second opinion
 * about them would be wrong in exactly the cases that matter, and a checker
 * that tests its own spelling gets ignored inside a week.
 *
 * Both artifacts are asked, because a DTL and a business process do not emit
 * the same references and a spec is shipped as whichever one you imported.
 * Either may refuse a spec `validate()` accepted; the caller decides what to do
 * with that, because "the emitter would not build this" is not a schema finding.
 */
export function bareSegments(spec: Spec): { bare: BareRefs; refused: string[] } {
  const bare = newBareRefs();
  const refused: string[] = [];

  try {
    emitIris(spec, bare);
  } catch (e) {
    refused.push(`the DTL emitter refused this spec: ${(e as Error).message}`);
  }

  if (spec.iris.process) {
    try {
      emitProcess(spec, bare);
    } catch (e) {
      refused.push(`the process emitter refused this spec: ${(e as Error).message}`);
    }
  }

  return { bare, refused };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type Severity = "error" | "warn";

export interface Finding {
  severity: Severity;
  /** Stable tag, so a test asserts the RULE and not its current wording. */
  code:
    | "doctype-missing"
    | "bare-repeating"
    | "segment-absent"
    | "group-mismatch"
    | "source-group-mismatch"
    | "bare-repeating-group"
    | "repeat-not-repeating";
  /** The segment or doctype the finding is about. Sorted on, so it is stable. */
  subject: string;
  text: string;
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warn: 1 };

/** Every home the structure gives a segment, or an empty list when it has none. */
function homesOf(dump: SchemaDump, docType: string, segment: string): SchemaEntry[] {
  return dump.structures.get(docType)?.get(segment) ?? [];
}

/**
 * The group names one structure marks as repeating: `IN1grp()` but not `PIDgrp`.
 *
 * Read off every entry's own group parts rather than off a group index, because
 * a group only appears in this global as a prefix on the segments inside it --
 * there is no row that describes `IN1grp` on its own.
 */
export function repeatingGroups(dump: SchemaDump, docType: string): Set<string> {
  const out = new Set<string>();
  const bySegment = dump.structures.get(docType);
  if (!bySegment) return out;
  for (const homes of bySegment.values()) {
    for (const h of homes) {
      for (const g of h.groupParts) if (g.repeats) out.add(g.name);
    }
  }
  return out;
}

/** The segments a spec routes through one group name, for attributing a finding. */
function segmentsInGroup(spec: Spec, group: string): string[] {
  const groups = spec.iris.sourceGroups ?? {};
  return Object.keys(groups)
    .filter((seg) => normaliseGroupPath(groups[seg]!) === group)
    .sort();
}

/** How a home reads in a sentence: "repeats, inside IN1grp". */
function describeHome(h: SchemaEntry): string {
  const where = h.groupPath === "" ? "at the top level" : `inside ${h.groupPath}`;
  return `${h.repeats ? "repeats" : "appears once"}, ${where}`;
}

/**
 * Compare the spec against the dump. Every problem, not the first.
 *
 * An operator who has to re-run once per fault stops running it, so the report
 * is the full list and the exit code is the only thing that is binary.
 */
export function checkSpec(spec: Spec, dump: SchemaDump, bare: BareRefs): Finding[] {
  const out: Finding[] = [];
  const add = (severity: Severity, code: Finding["code"], subject: string, text: string): void => {
    out.push({ severity, code, subject, text });
  };

  const src = spec.iris.sourceDocType;
  const tgt = spec.iris.targetDocType;
  const known = [...dump.structures.keys()].sort();
  const haveSrc = dump.structures.has(src);
  const haveTgt = dump.structures.has(tgt);

  // A dump that does not cover the spec's doctypes cannot answer anything
  // below, and a check that ran on a structure nobody asked about and reported
  // OK would be worse than no check at all.
  for (const [role, dt, have] of [
    ["sourceDocType", src, haveSrc],
    ["targetDocType", tgt, haveTgt],
  ] as const) {
    if (have) continue;
    add(
      "error",
      "doctype-missing",
      dt,
      `${role} ${dt} is not in this dump. It carries ${
        known.length === 0 ? "no structures at all" : known.join(", ")
      }. Dump the missing one -- \`bun schemacheck.ts --commands\` prints the line -- ` +
        `or fix the doctype. A doctype the namespace does not have fails CLOSED: every ` +
        `path resolves empty and nothing says why.`,
    );
  }

  // ---- source side ------------------------------------------------------

  if (haveSrc) {
    for (const seg of [...sourceSegments(spec)].sort()) {
      const homes = homesOf(dump, src, seg);
      if (homes.length === 0) {
        add(
          "error",
          "segment-absent",
          seg,
          `${seg} is not in ${src} at all. Either the spec reads a segment this ` +
            `structure does not define, or sourceDocType names the wrong structure ` +
            `-- both deliver an empty field and neither is logged.`,
        );
        continue;
      }

      // The GT1 bug. A bare read of a repeating segment returns EMPTY.
      if (bare.segments.has(seg) && homes.some((h) => h.repeats)) {
        const blocks = blocksReading(spec, seg);
        const needsRepeat = blocks.filter((b) => b.repeat?.over !== seg).map((b) => b.id);
        const fix =
          needsRepeat.length > 0
            ? `Give ${
                needsRepeat.length === 1 ? `block ${needsRepeat[0]}` : `blocks ${needsRepeat.join(", ")}`
              } a \`repeat: { over: "${seg}" }\`.`
            : `Every block that reads it already repeats over it, so the bare read is ` +
              `somewhere else in the spec -- the gate path, or a row reading ${seg} from ` +
              `outside its own block.`;
        const grouped = homes.find((h) => h.groupPath !== "");
        const also = grouped
          ? ` The schema also keeps it inside ${grouped.groupPath}, so ` +
            `\`iris.sourceGroups: { ${seg}: "${grouped.groupPath}" }\` is needed as well.`
          : "";
        add(
          "error",
          "bare-repeating",
          seg,
          `${seg} repeats in ${src} (${homes.map((h) => h.raw).join(", ")}), and the ` +
            `emitter reads it with no occurrence index. GetValueAt("${seg}") on a ` +
            `repeating segment returns EMPTY in IRIS -- measured, not assumed -- so the ` +
            `mapping delivers nothing for it and \`bun check.ts\` stays green. ${fix}${also}`,
        );
      }

      // Where the schema really keeps it, against what sourceGroups claims.
      const declared = spec.iris.sourceGroups?.[seg];
      const wantOne = homes.map((h) => h.groupPath);
      if (declared === undefined) {
        if (wantOne.every((g) => g !== "")) {
          add(
            "error",
            "source-group-mismatch",
            seg,
            `${src} keeps ${seg} inside ${[...new Set(wantOne)].join(" or ")}, and the ` +
              `spec declares no \`iris.sourceGroups\` entry for it. A read of a grouped ` +
              `segment addressed at the top level resolves to nothing, silently. Add ` +
              `\`iris.sourceGroups: { ${seg}: "${wantOne[0]}" }\`.`,
          );
        }
      } else {
        const want = normaliseGroupPath(declared);
        if (!wantOne.includes(want)) {
          const shown = wantOne.map((g) => (g === "" ? "the top level" : g));
          const caseOnly = wantOne.some((g) => g.toLowerCase() === want.toLowerCase());
          add(
            "error",
            "source-group-mismatch",
            seg,
            `\`iris.sourceGroups.${seg}\` says ${declared}; ${src} says ${shown.join(" or ")}.` +
              (caseOnly ? ` The difference is CASE only, which a schema browser will not show you.` : "") +
              ` A wrong group resolves to empty and reports nothing.`,
          );
        }
      }
    }

    // The same bug one level up, on the same evidence footing. Measured on IRIS
    // for Health, 2.3:ADT_A01, one IN1 inside IN1grp:
    //
    //   GRP_NO_OCC |[]                                GetValueAt("IN1grp.IN1")
    //   GRP_OCC    |[IN1|1|PLAN1|PAY1|PAYER NAME]     GetValueAt("IN1grp(1).IN1")
    //
    // Keyed on the group name rather than the segment, because one group holds
    // several segments and the fix is per group, not per read.
    const repeating = repeatingGroups(dump, src);
    for (const group of [...bare.groups].sort()) {
      if (!repeating.has(group)) continue;
      const segs = segmentsInGroup(spec, group);
      const blocks = spec.blocks.filter(
        (b) => segs.includes(b.id) && b.repeat?.over !== b.id,
      );
      const fix =
        blocks.length > 0
          ? `Give ${
              blocks.length === 1 ? `block ${blocks[0]!.id}` : `blocks ${blocks.map((b) => b.id).join(", ")}`
            } a \`repeat\` over its own segment, which makes the emitter walk the group ` +
            `occurrence -- or pin one with \`iris.sourceGroups: { ${
              segs[0] ?? "SEG"
            }: "${group}(1)" }\` if only the first is wanted.`
          : `Pin the occurrence in \`iris.sourceGroups\` -- "${group}(1)" -- or give the ` +
            `block that reads through it a \`repeat\`.`;
      add(
        "error",
        "bare-repeating-group",
        group,
        `${group} repeats in ${src}, and the emitter reads through it with no occurrence ` +
          `index${segs.length > 0 ? ` (it carries ${segs.join(", ")})` : ""}. ` +
          `GetValueAt("${group}.${segs[0] ?? "SEG"}") returns EMPTY where ` +
          `GetValueAt("${group}(1).${segs[0] ?? "SEG"}") returns the segment -- measured, ` +
          `not assumed -- so the mapping delivers nothing for everything inside this ` +
          `group, as silently as the bare-segment case. ${fix}`,
      );
    }

    // A defensive repeat is cheap; being wrong about it is only confusing, so
    // this warns. It is still worth saying: a `repeat` over a segment that
    // appears once means the spec and the schema disagree about the feed.
    for (const b of spec.blocks) {
      const over = b.repeat?.over;
      if (!over) continue;
      const homes = homesOf(dump, src, over);
      if (homes.length === 0) continue; // already an error above
      if (homes.some((h) => h.repeats || h.groupRepeats)) continue;
      add(
        "warn",
        "repeat-not-repeating",
        over,
        `block ${b.id} repeats over ${over}, and ${src} says ${over} ${homes
          .map(describeHome)
          .join(" / ")}. A defensive repeat over a segment that appears once is ` +
          `harmless -- it runs once -- so this is a note, not a gate.`,
      );
    }
  }

  // ---- target side ------------------------------------------------------

  if (haveTgt) {
    for (const b of spec.blocks) {
      const homes = homesOf(dump, tgt, b.id);
      if (homes.length === 0) {
        add(
          "error",
          "segment-absent",
          b.id,
          `block ${b.id} writes a segment ${tgt} does not define. A target path the ` +
            `structure cannot place is dropped, not errored, so the segment simply ` +
            `does not arrive.`,
        );
        continue;
      }
      const want = homes.map((h) => h.groupPath);
      if (b.group === undefined) {
        if (want.every((g) => g !== "")) {
          add(
            "error",
            "group-mismatch",
            b.id,
            `${tgt} keeps ${b.id} inside ${[...new Set(want)].join(" or ")}, and block ` +
              `${b.id} declares no \`group\`. \`target.{${b.id}(1):2}\` resolves to nothing ` +
              `where \`target.{${want[0]}(1).${b.id}:2}\` works, and both fail closed. ` +
              `Set \`group: "${want[0]}"\`.`,
          );
        }
      } else {
        const have = normaliseGroupPath(b.group);
        if (!want.includes(have)) {
          const shown = want.map((g) => (g === "" ? "the top level" : g));
          const caseOnly = want.some((g) => g.toLowerCase() === have.toLowerCase());
          add(
            "error",
            "group-mismatch",
            b.id,
            `block ${b.id} declares group ${b.group}; ${tgt} says ${shown.join(" or ")}.` +
              (caseOnly ? ` The difference is CASE only, which a schema browser will not show you.` : "") +
              ` A wrong group writes nowhere and says nothing.`,
          );
        }
      }
    }
  }

  out.sort(
    (a, z) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[z.severity] ||
      a.subject.localeCompare(z.subject) ||
      a.code.localeCompare(z.code) ||
      a.text.localeCompare(z.text),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** What the spec claims about one source segment, for the table. */
function specSays(spec: Spec, seg: string): string {
  const repeating = spec.blocks.find((b) => b.repeat?.over === seg);
  const grp = spec.iris.sourceGroups?.[seg];
  const where = grp ? `, in ${grp}` : "";
  return repeating ? `repeat over ${seg}${where}` : `read once${where}`;
}

/**
 * What the dump says about one source segment, for the table.
 *
 * Says when the GROUP repeats as well as when the segment does. "appears once,
 * inside IN1grp" is true and reads as settled, and on a repeating IN1grp it is
 * the row the reader most needs to stop at.
 */
function schemaSays(dump: SchemaDump, docType: string, seg: string): string {
  const homes = homesOf(dump, docType, seg);
  if (homes.length === 0) return "not in this structure";
  return homes
    .map((h) => `${describeHome(h)}${h.groupRepeats ? ", which repeats" : ""}`)
    .join(" / ");
}

/** The group names a segment sits inside, so a group finding flags its row. */
function groupNamesOf(dump: SchemaDump, docType: string, seg: string): string[] {
  return homesOf(dump, docType, seg).flatMap((h) => h.groupParts.map((g) => g.name));
}

export interface Report {
  text: string;
  errors: number;
  warnings: number;
  /**
   * The dump carried `^EnsHL7.Schema` lines this parser could not read, so the
   * verdict is about the rest of it.
   *
   * Kept OUT of `errors`, because it is not a disagreement between the spec and
   * the schema -- and it still fails the run. Every other refusal in this repo
   * fails closed for the same reason: an answer computed from input that was
   * partly unreadable, reported as OK, is the failure shape the whole tool
   * exists to refuse.
   */
  incomplete: boolean;
}

export function renderReport(
  spec: Spec,
  dump: SchemaDump,
  findings: Finding[],
  dumpSource: string,
): Report {
  const out: string[] = [];
  const src = spec.iris.sourceDocType;
  const structures = [...dump.structures.keys()].sort();

  out.push(`spec      ${spec.name}`);
  out.push(`dump      ${dumpSource}`);
  out.push(
    `          ${dump.mapEntries} map entr${dump.mapEntries === 1 ? "y" : "ies"}, ` +
      `${structures.length} structure${structures.length === 1 ? "" : "s"}, ` +
      `${dump.unparsed.length} unparsed`,
  );
  out.push(`structures ${structures.length === 0 ? "(none)" : structures.join(", ")}`);
  out.push(`source    ${src}${dump.structures.has(src) ? "" : "   <-- NOT IN THIS DUMP"}`);
  out.push(
    `target    ${spec.iris.targetDocType}${
      dump.structures.has(spec.iris.targetDocType) ? "" : "   <-- NOT IN THIS DUMP"
    }`,
  );
  out.push("");

  // The table only means anything when the source structure is here to compare
  // against. Printing it against nothing would read as "checked, fine".
  if (dump.structures.has(src)) {
    const segs = [...sourceSegments(spec)].sort();
    out.push("SEGMENT   the spec reads it as        the schema says");
    out.push("-------   -------------------------   ----------------------------");
    for (const seg of segs) {
      // A bare-group error is filed under the GROUP, and the row that has to
      // change is the segment inside it. Flag both, or the reader scans the
      // table, sees nothing marked, and stops before the errors.
      const subjects = new Set([seg, ...groupNamesOf(dump, src, seg)]);
      const flag = findings.some((f) => subjects.has(f.subject) && f.severity === "error")
        ? "   <-- see below"
        : "";
      out.push(
        `${seg.padEnd(9)} ${specSays(spec, seg).padEnd(27)} ${schemaSays(dump, src, seg)}${flag}`,
      );
    }
    out.push("");
  }

  // Said before the verdict, not after it. An answer computed from a dump that
  // lost lines is not an answer, and it must not be read as one.
  if (dump.unparsed.length > 0) {
    out.push(
      `${dump.unparsed.length} ^EnsHL7.Schema line(s) could not be read, so this run is NOT ` +
        `a pass whatever\nthe verdict below says. One of these may be the entry the check ` +
        `was about:`,
    );
    for (const l of dump.unparsed) out.push(`  ${l}`);
    out.push("");
  }

  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warn");

  if (errors.length === 0 && warnings.length === 0) {
    out.push(
      dump.unparsed.length === 0
        ? "OK. Every segment this spec addresses sits where the schema says it sits,\n" +
          "and nothing is read with an occurrence index the schema does not allow."
        : "Nothing disagrees among the entries that were read -- but the lines above were\n" +
          "not read, so this is not an OK. Re-paste the dump and run it again.",
    );
  } else {
    if (errors.length > 0) {
      out.push(`${errors.length} error(s). The emitted class will silently drop something:\n`);
      for (const f of errors) out.push(`  ERROR  ${f.text}\n`);
    }
    if (warnings.length > 0) {
      out.push(`${warnings.length} warning(s):\n`);
      for (const f of warnings) out.push(`  WARN   ${f.text}\n`);
    }
  }

  return {
    text: out.join("\n") + "\n",
    errors: errors.length,
    warnings: warnings.length,
    incomplete: dump.unparsed.length > 0,
  };
}

// ---------------------------------------------------------------------------
// --diff: has the target drifted from what I develop against?
//
// A different question from "does my spec match this schema", and the one that
// decides whether a local green means anything. Development happens on a LOCAL
// instance because the target namespace is not reachable from the bench; the
// local instance is a valid proxy for exactly as long as its schema matches the
// target's, and nothing announces the morning it stops being one.
//
// No spec is involved. Two dumps, taken from two instances, compared.
// ---------------------------------------------------------------------------

export type DiffCode = "structure-only" | "segment-only" | "shape-differs";

export interface DiffFinding {
  code: DiffCode;
  /** The doctype the difference is in. Sorted on, so the report is stable. */
  structure: string;
  /** The segment, or the doctype itself for `structure-only`. */
  subject: string;
  text: string;
}

/**
 * How a structure keeps one segment, as one comparable string.
 *
 * The raw subscripts, sorted. They already encode both questions this cares
 * about -- `GT1()` against `GT1` is the repeat, `IN1grp().IN1` against `IN1` is
 * the group -- so comparing them compares the shape without a second model of
 * it that could disagree with the parser.
 */
function shapeKey(homes: SchemaEntry[]): string {
  return homes
    .map((h) => h.raw)
    .sort()
    .join(", ");
}

/** The same thing in a sentence, for the report. */
function shapeText(homes: SchemaEntry[]): string {
  return homes
    .map(describeHome)
    .sort()
    .join(" / ");
}

/**
 * Every way two dumps disagree. Every one of them, not the first.
 *
 * A structure present in one file and absent from the other is a difference and
 * is reported as one -- it is the likeliest real drift, an instance that never
 * had the structure imported, and treating it as a reason to stop would hide
 * the rest of the comparison.
 */
export function diffDumps(
  a: SchemaDump,
  b: SchemaDump,
  labelA: string,
  labelB: string,
): DiffFinding[] {
  const out: DiffFinding[] = [];
  const structures = [...new Set([...a.structures.keys(), ...b.structures.keys()])].sort();

  for (const dt of structures) {
    const sa = a.structures.get(dt);
    const sb = b.structures.get(dt);

    if (!sa || !sb) {
      const [have, missing] = sa ? [labelA, labelB] : [labelB, labelA];
      out.push({
        code: "structure-only",
        structure: dt,
        subject: dt,
        text:
          `${dt} is in ${have} and not in ${missing}. Either the two instances are on ` +
          `different schema versions, or one of them never imported it -- and a doctype ` +
          `an instance does not have fails CLOSED: every path resolves empty, and nothing ` +
          `in the log says why.`,
      });
      continue;
    }

    for (const seg of [...new Set([...sa.keys(), ...sb.keys()])].sort()) {
      const ha = sa.get(seg);
      const hb = sb.get(seg);

      if (!ha || !hb) {
        const [have, missing] = ha ? [labelA, labelB] : [labelB, labelA];
        const homes = (ha ?? hb)!;
        out.push({
          code: "segment-only",
          structure: dt,
          subject: seg,
          text:
            `${dt}: ${seg} is in ${have} (${shapeText(homes)}) and not in ${missing} at all. ` +
            `A mapping proved against ${have} reads nothing for it on ${missing}.`,
        });
        continue;
      }

      if (shapeKey(ha) === shapeKey(hb)) continue;

      // Say which of the two things differs, because they have different
      // consequences and a message that names the wrong one gets distrusted.
      // A repeat decides whether the read carries an occurrence index; a group
      // decides what the path is prefixed with. Both fail closed, separately.
      const set = (homes: SchemaEntry[], f: (h: SchemaEntry) => string) =>
        [...new Set(homes.map(f))].sort().join(",");
      const repeatDiffers = set(ha, (h) => String(h.repeats)) !== set(hb, (h) => String(h.repeats));
      const groupDiffers = set(ha, (h) => h.groupPath) !== set(hb, (h) => h.groupPath);
      const why = [
        repeatDiffers
          ? `A segment that repeats on one and not the other is read with an occurrence ` +
            `index on one and without it on the other, and the wrong one returns EMPTY.`
          : "",
        groupDiffers
          ? `A path prefixed with the wrong group name resolves to nothing, silently, ` +
            `so \`group\` and \`iris.sourceGroups\` cannot be right for both instances.`
          : "",
      ]
        .filter((s) => s !== "")
        .join(" ");

      out.push({
        code: "shape-differs",
        structure: dt,
        subject: seg,
        text: `${dt}: ${seg} ${shapeText(ha)} in ${labelA}, and ${shapeText(hb)} in ${labelB}. ${why}`,
      });
    }
  }

  out.sort(
    (x, y) =>
      x.structure.localeCompare(y.structure) ||
      x.subject.localeCompare(y.subject) ||
      x.code.localeCompare(y.code),
  );
  return out;
}

export function renderDiff(
  a: SchemaDump,
  b: SchemaDump,
  labelA: string,
  labelB: string,
  findings: DiffFinding[],
): Report {
  const out: string[] = [];

  const line = (label: string, d: SchemaDump): string =>
    `${label}\n          ${d.mapEntries} map entr${d.mapEntries === 1 ? "y" : "ies"}, ` +
    `${d.structures.size} structure${d.structures.size === 1 ? "" : "s"}, ` +
    `${d.unparsed.length} unparsed`;

  out.push(`A         ${line(labelA, a)}`);
  out.push(`B         ${line(labelB, b)}`);
  out.push("");

  // Said before the verdict. A diff's clean answer is a pure negative claim,
  // and a line neither file could be read from is the one way that claim is
  // wrong without anything looking wrong.
  const lost = [
    ...a.unparsed.map((l) => [labelA, l] as const),
    ...b.unparsed.map((l) => [labelB, l] as const),
  ];
  if (lost.length > 0) {
    out.push(
      `${lost.length} ^EnsHL7.Schema line(s) could not be read. A difference hiding in one of\n` +
        `these looks exactly like no difference at all, so this run is NOT a pass:`,
    );
    for (const [label, l] of lost) out.push(`  ${label}: ${l}`);
    out.push("");
  }

  if (findings.length === 0) {
    out.push(
      lost.length === 0
        ? "OK. The two dumps describe the same structures, the same segments, the same\n" +
          "repeats and the same groups. A green build against one is a green build\n" +
          "against the other."
        : "Nothing differs among the entries that were read -- but the lines above were\n" +
          "not read, so this is not an OK. Re-paste and run it again.",
    );
  } else {
    out.push(`${findings.length} difference(s). These two instances are not interchangeable:\n`);
    for (const f of findings) out.push(`  ${f.text}\n`);
  }

  return {
    text: out.join("\n") + "\n",
    errors: findings.length,
    warnings: 0,
    incomplete: lost.length > 0,
  };
}

// ---------------------------------------------------------------------------
// --commands
// ---------------------------------------------------------------------------

/**
 * The `zw` lines that produce a dump for THIS spec, ready to paste.
 *
 * This closes the loop: the tool that reads the dump is the tool that tells you
 * how to make one, so the two can never describe different doctypes.
 */
export function commandsFor(spec: Spec): { lines: string[]; problems: string[] } {
  const lines: string[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const dt of [spec.iris.sourceDocType, spec.iris.targetDocType]) {
    if (seen.has(dt)) continue;
    seen.add(dt);
    const p = docTypeParts(dt);
    if (!p) {
      problems.push(`"${dt}" is not a doctype. Expected <category>:<structure>, e.g. 2.3:ADT_A01.`);
      continue;
    }
    lines.push(`zw ^EnsHL7.Schema("${p.category}","MS","${p.structure}","map")`);
  }

  return { lines, problems };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { existsSync, readFileSync } = await import("node:fs");
  const { decodeText, outArg, deliverText } = await import("./input");
  const { logEvent } = await import("./log");

  const argv = process.argv.slice(2);
  const outFile = outArg("schemacheck", argv);

  const die = (code: number, msg: string): never => {
    process.stderr.write(`schemacheck: ${msg}\n`);
    process.exit(code);
  };

  // `-o` takes a filename, and that filename is not a dump.
  const oIndex = argv.findIndex((a) => a === "-o" || a === "--out");
  const positional = argv.filter(
    (a, i) => !a.startsWith("-") && (oIndex === -1 || (i !== oIndex && i !== oIndex + 1)),
  );

  /** A named dump, decoded and parsed, or a refusal that names the file. */
  const readDump = (file: string): SchemaDump => {
    if (!existsSync(file)) {
      die(
        2,
        `no such file.\n  looked for   ${file}\n` +
          `Refusing to continue with no dump: a check that ran against nothing would ` +
          `report OK.`,
      );
    }
    const decoded = decodeText(readFileSync(file));
    if (decoded.note) process.stderr.write(`schemacheck: ${file} is ${decoded.note}; decoded it\n`);
    const dump = parseDump(decoded.text);
    if (dump.mapEntries === 0) {
      die(
        2,
        `that file holds no ^EnsHL7.Schema map entries.\n` +
          `  read           ${file}\n` +
          `  unreadable     ${dump.unparsed.length} line(s)\n` +
          `A dump looks like:\n` +
          `  ^EnsHL7.Schema(2.3,"MS","ADT_A01","map","GT1()")="=14,*|2.3:GT1"\n` +
          `Get one with: bun schemacheck.ts --commands`,
      );
    }
    return dump;
  };

  // --diff first, and deliberately before the spec is loaded. No spec is
  // involved in comparing two instances, and `specfile.ts` fails closed -- so
  // loading it here would make "are these two namespaces the same" impossible
  // to ask on a box where HL7_BENCH_TRANSFORM is unset or broken.
  if (argv.includes("--diff")) {
    const [fileA, fileB] = positional;
    if (!fileA || !fileB) {
      die(
        2,
        `--diff needs two dumps.\n` +
          `  bun schemacheck.ts --diff schema-target.txt schema-local.txt\n` +
          `The first is the instance you deploy to, the second the one you build on.`,
      );
    }
    const a = readDump(fileA);
    const b = readDump(fileB);
    const findings = diffDumps(a, b, fileA, fileB);
    const report = renderDiff(a, b, fileA, fileB, findings);

    logEvent("schemacheck", {
      mode: "diff",
      a: fileA,
      b: fileB,
      aEntries: a.mapEntries,
      bEntries: b.mapEntries,
      unparsed: a.unparsed.length + b.unparsed.length,
      differences: report.errors,
      result: report.errors > 0 ? "differs" : report.incomplete ? "incomplete" : "same",
    });

    await deliverText(report.text, outFile);
    process.exit(report.errors > 0 || report.incomplete ? 1 : 0);
  }

  const { spec } = await import("./specfile");
  const { validate } = await import("./spec");

  if (argv.includes("--commands")) {
    const { lines, problems } = commandsFor(spec);
    if (problems.length > 0) {
      for (const p of problems) process.stderr.write(`schemacheck: ${p}\n`);
      process.exit(2);
    }
    process.stderr.write(
      `Paste these into a terminal session on the namespace this spec targets, then\n` +
        `save the output and hand the file back:\n\n` +
        `  bun schemacheck.ts <that-file>\n\n`,
    );
    await deliverText(lines.join("\n") + "\n", outFile);
    if (spec.iris.schema) {
      process.stderr.write(
        `\nThis spec also ships a custom schema category (${spec.iris.schema.category}).\n` +
          `Its structures only exist on an instance that has imported it -- \`bun emit.ts schema\`\n` +
          `then \`bun schema-sync.ts --import\`. A zw of a category nobody imported comes back\n` +
          `empty, which reads exactly like a spec with the wrong doctype.\n`,
      );
    }
    process.exit(0);
  }

  const file = positional[0];
  if (!file) {
    die(
      2,
      `name the zw dump to check against.\n` +
        `  bun schemacheck.ts schema.zw\n` +
        `Do not have one? This prints the lines to paste into the terminal:\n` +
        `  bun schemacheck.ts --commands\n` +
        `Comparing two instances instead of a spec?\n` +
        `  bun schemacheck.ts --diff schema-target.txt schema-local.txt`,
    );
  }

  // A spec the emitter would refuse cannot produce a trustworthy bare set, and
  // reporting schema findings for it would bury the real problem.
  const problems = validate(spec);
  if (problems.length > 0) {
    process.stderr.write(`schemacheck: spec "${spec.name}" has ${problems.length} problem(s):\n`);
    for (const p of problems) process.stderr.write(`  - ${p}\n`);
    process.stderr.write(`These are not schema findings. Fix them, then re-run.\n`);
    process.exit(2);
  }

  const dump = readDump(file);

  const { bare, refused } = bareSegments(spec);
  if (refused.length > 0) {
    // validate() passed and an emitter still refused: that is a bug in the spec
    // the validator does not model, and it is not a schema finding.
    for (const r of refused) process.stderr.write(`schemacheck: ${r}\n`);
    process.exit(2);
  }

  const findings = checkSpec(spec, dump, bare);
  const report = renderReport(spec, dump, findings, file);

  logEvent("schemacheck", {
    mode: "spec",
    spec: spec.name,
    dump: file,
    sourceDocType: spec.iris.sourceDocType,
    targetDocType: spec.iris.targetDocType,
    mapEntries: dump.mapEntries,
    structures: dump.structures.size,
    unparsed: dump.unparsed.length,
    errors: report.errors,
    warnings: report.warnings,
    result: report.errors > 0 ? "fail" : report.incomplete ? "incomplete" : "ok",
  });

  await deliverText(report.text, outFile);
  process.exit(report.errors > 0 || report.incomplete ? 1 : 0);
}
