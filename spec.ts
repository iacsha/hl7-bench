/**
 * spec.ts -- the one authoring.
 *
 * An interface is described here, once, as data. Everything else is derived:
 *
 *   run.ts        spec + message  ->  the delivered message      (the bench)
 *   trace.ts      spec + message  ->  the field table            (the deliverable)
 *   emit/iris.ts  spec            ->  an Ens.DataTransformDTL class
 *
 * WHY THIS REPLACED THE OLD SHAPE
 *
 * The bench used to make you write the same mapping three times: once as
 * imperative JavaScript in `transform.ts` because that is what ran, once as a
 * rules table because that is what printed the spec document, and once as a
 * DTL spec because that is what emitted the ObjectScript. Nothing checked that
 * the three agreed. Change one and the other two were quietly lying.
 *
 * So there is one spec now, and the backends are pure functions over it. A
 * second engine is a new file under `emit/`, not a second toolkit, and every
 * interface you have already described comes along the day that file exists.
 *
 * THE RULE THAT KEEPS IT HONEST
 *
 * Every `Source` and `Step` below is plain serializable data, and EVERY kind
 * must be handled by EVERY backend. `spec.test.ts` asserts that mechanically by
 * walking the kind lists, so a vocabulary entry that only one backend
 * understands fails the build rather than failing silently six weeks later at
 * validation.
 *
 * That is also why there is no `raw(javascript)` escape hatch. Smuggling code
 * into the data would mean the JavaScript side could express things the
 * ObjectScript side cannot, which is exactly the split this file exists to
 * close. When the vocabulary cannot say something, GROW THE VOCABULARY: add a
 * kind here, handle it in `run.ts` and `emit/iris.ts`, add a test. It is about
 * twenty lines and the compiler tells you every place you missed.
 */

// ---------------------------------------------------------------------------
// Sources: where a target field's value comes from
// ---------------------------------------------------------------------------

/** What a lookup returns when the code is not in the table. Always explicit. */
export type Unmapped =
  | { kind: "blank" }
  | { kind: "passthrough" }
  | { kind: "constant"; value: string };

export type Source =
  /** Copy a source path straight across. */
  | { kind: "copy"; path: string }
  /** Stamp a constant. */
  | { kind: "literal"; value: string }
  /** First non-empty of several source paths. Becomes a nested $SELECT. */
  | { kind: "firstOf"; paths: string[] }
  /** Table translation with a stated unmapped branch. */
  | { kind: "lookup"; table: string; path: string; unmapped: Unmapped }
  /** The output ordinal of the enclosing repeat. Only valid inside one. */
  | { kind: "counter" }
  /** The target trigger event the gate resolved to. */
  | { kind: "event" }
  /**
   * Scan the repetitions of a field for the one whose component `whereComponent`
   * equals `equals`, then take `take` from it.
   *
   * This exists because doctor fields are the single most common place a
   * position-based read goes wrong. PV1-7 carries the same doctor twice, once
   * qualified MT and once NPI, and which one comes first is not stable across
   * sites. Reading PV1-7(2) works until the day it does not, silently.
   *
   * `take` is a component number, a list of component numbers joined back
   * together with the component separator, or "whole" for the repetition as it
   * arrived. The list form exists because a provider field is usually wanted as
   * id plus name and not as four independent target fields: written as four
   * rows, a message with no matching repetition writes four empty components
   * and puts a bare "^^^" on the wire where the receiver expected nothing.
   */
  | {
      kind: "pickRepeat";
      path: string;
      whereComponent: number;
      equals: string;
      take: number | number[] | "whole";
    }
  /**
   * The first occurrence of a repeating segment whose `nonEmpty` path has a
   * value, read at `path`. Both paths name the same segment.
   *
   * Written for the NK1 to GT1 move: three NK1s arrive, two are shells, and the
   * receiver wants the first real one. Note that a bare `NK1-2` in IRIS returns
   * EMPTY on a message with three NK1s rather than the first repeat, so this is
   * not a convenience, it is the only correct read.
   */
  | { kind: "fromFirst"; segment: string; nonEmpty: string; path: string }
  /**
   * Not expressible yet. Delivers empty, traces as TODO, emits a TODO comment
   * and no assign.
   *
   * Deliberately visible in all three backends. A generator that quietly drops
   * what it cannot express is worse than no generator, because the gap is
   * invisible until somebody reads a report.
   */
  | { kind: "todo"; why: string };

export const SOURCE_KINDS = [
  "copy", "literal", "firstOf", "lookup", "counter",
  "event", "pickRepeat", "fromFirst", "todo",
] as const;

// ---------------------------------------------------------------------------
// Steps: what happens to the value after the source resolves
// ---------------------------------------------------------------------------

export type Step =
  /** Keep the first 8 characters. HL7 datetime down to a date. */
  | { kind: "date8" }
  /** Keep the first n characters. */
  | { kind: "truncate"; n: number }
  | { kind: "upper" }
  /** Remove characters that would be read as delimiters. */
  | { kind: "stripDelims" }
  /**
   * Remove every character in `chars`. Written for punctuated identifiers: a
   * sender that formats an SSN as 000-00-0000 and a receiver that wants nine
   * bare digits will both call the field correct and neither will match.
   */
  | { kind: "stripChars"; chars: string }
  /** Substitute a value when the input is empty. */
  | { kind: "defaultTo"; value: string };

export const STEP_KINDS = [
  "date8", "truncate", "upper", "stripDelims", "stripChars", "defaultTo",
] as const;

// ---------------------------------------------------------------------------
// Rows, blocks, and the spec itself
// ---------------------------------------------------------------------------

export interface Row {
  /** Target path. Its segment id must match the enclosing block. */
  target: string;
  from: Source;
  via?: Step[];
  /**
   * Empty here is a problem worth stopping for. Collects into the trace's
   * MISSING list and into a runtime note. Every missing field is reported, not
   * just the first, because making somebody resubmit once per missing field is
   * how a go-live afternoon disappears.
   */
  required?: boolean;
  /** Name for the trace. Receivers read this column, not your path syntax. */
  label?: string;
  note?: string;
}

export interface Repeat {
  /** Source segment id to walk. */
  over: string;
  /** Skip a source occurrence when this path is empty. */
  skipWhenEmpty?: string;
  /** Stop after this many delivered occurrences. */
  max?: number;
}

export interface Block {
  /** Target segment id. */
  id: string;
  /**
   * IRIS group name when the target segment sits inside one, e.g.
   * "INSURANCEgrp". Ignored by the JavaScript runner, which has no groups, and
   * load-bearing in the DTL, where `target.{IN1(1):2}` resolves to nothing but
   * `target.{INSURANCEgrp(1).IN1:2}` works. Both fail closed. Check the schema
   * browser rather than guessing.
   */
  group?: string;
  repeat?: Repeat;
  rows: Row[];
  note?: string;
}

/** A source field worth documenting whether or not it is mapped. */
export interface InventoryItem {
  path: string;
  label: string;
  required?: boolean;
  note?: string;
}

export interface Spec {
  name: string;
  description?: string;
  /**
   * Which messages this interface handles, and what each becomes. A table and
   * never an if/else: an if grows an implicit everything-else branch, and that
   * branch is how a discharge reaches the receiver as a registration.
   *
   * In IRIS this belongs in the routing rule, not the DTL, so an event you do
   * not handle is never delivered rather than delivered wrong. `emit/iris.ts`
   * prints the rule condition for you.
   */
  gate: {
    path: string;
    permit: Record<string, string>;
    /**
     * Extra equalities every accepted message must satisfy, on top of the
     * permit table. A feed that sends ORU in MSH-9.1 with an A08 in MSH-9.2 is
     * real, and the receiver believes MSH-9.2, so the interface has to disagree
     * loudly rather than transform whatever arrived. These join the routing
     * rule condition with AND.
     */
    require?: { path: string; equals: string }[];
  };
  iris: {
    /** Class name for the generated DTL. Defaults to a name built from `name`. */
    className?: string;
    sourceDocType: string;
    targetDocType: string;
    /** "new" builds a fresh target, which is what block order below describes. */
    create?: "new" | "copy";
  };
  /**
   * The twin of Ens.Util.LookupTable. Rows live here so the bench and the
   * engine cannot disagree, and so the emitter can warn about an empty table:
   * an empty table returns the default for every message and looks exactly like
   * a working lookup.
   */
  tables?: Record<string, Record<string, string>>;
  /** Target segments, in delivery order. */
  blocks: Block[];
  /**
   * What the SENDER emits, mapped or not. Documentation only, no code comes
   * from it. This is the other half of the deliverable: the delivered trace is
   * the conversation you owe the receiver, and this one is the conversation you
   * owe the sending system. They are rarely the same list.
   */
  sourceInventory?: InventoryItem[];
  /** Decisions recorded as decisions, so "not sent" is never just an absence. */
  outOfScope?: string[];
}

// ---------------------------------------------------------------------------
// Constructors. Sugar over the unions above, so a spec reads like a spec.
// ---------------------------------------------------------------------------

export const copy = (path: string): Source => ({ kind: "copy", path });
export const literal = (value: string): Source => ({ kind: "literal", value });
export const firstOf = (...paths: string[]): Source => ({ kind: "firstOf", paths });
export const counter = (): Source => ({ kind: "counter" });
export const event = (): Source => ({ kind: "event" });
export const todo = (why: string): Source => ({ kind: "todo", why });

export const lookup = (table: string, path: string, unmapped: Unmapped): Source =>
  ({ kind: "lookup", table, path, unmapped });

export const pickRepeat = (
  path: string,
  whereComponent: number,
  equals: string,
  take: number | number[] | "whole" = "whole",
): Source => ({ kind: "pickRepeat", path, whereComponent, equals, take });

export const fromFirst = (segment: string, nonEmpty: string, path: string): Source =>
  ({ kind: "fromFirst", segment, nonEmpty, path });

export const blank = (): Unmapped => ({ kind: "blank" });
export const passthrough = (): Unmapped => ({ kind: "passthrough" });
export const constant = (value: string): Unmapped => ({ kind: "constant", value });

export const date8 = (): Step => ({ kind: "date8" });
export const truncate = (n: number): Step => ({ kind: "truncate", n });
export const upper = (): Step => ({ kind: "upper" });
export const stripDelims = (): Step => ({ kind: "stripDelims" });
export const stripChars = (chars: string): Step => ({ kind: "stripChars", chars });
export const defaultTo = (value: string): Step => ({ kind: "defaultTo", value });

// ---------------------------------------------------------------------------
// Shared helpers. Both backends need these and must agree on them.
// ---------------------------------------------------------------------------

const PATH_RE = /^([A-Z][A-Z0-9]{2})-(\d+)(?:\((\d+)\))?(?:\.(\d+))?(?:\.(\d+))?$/;

/** Segment id of a path, or a thrown error naming the bad path. */
export function segmentOf(path: string): string {
  const m = PATH_RE.exec(path.trim());
  if (!m) throw new Error(`Not a valid HL7 path: "${path}" (expected something like PID-5.1)`);
  return m[1];
}

/** The part after the segment id: "5.1" from "PID-5.1". */
export function fieldOf(path: string): string {
  const m = /^[A-Z][A-Z0-9]{2}-(.+)$/.exec(path.trim());
  if (!m) throw new Error(`Not a valid HL7 path: "${path}"`);
  return m[1];
}

/** A short human description of a source, for the trace's SOURCE column. */
export function describeSource(from: Source): string {
  switch (from.kind) {
    case "copy": return from.path;
    case "literal": return `"${from.value}"`;
    case "firstOf": return from.paths.join(" or ");
    case "lookup": return `${from.path} via ${from.table}`;
    case "counter": return "(output ordinal)";
    case "event": return "(target event)";
    case "pickRepeat": {
      const take =
        from.take === "whole" ? ""
        : Array.isArray(from.take) ? `, components ${from.take.join("+")}`
        : `, component ${from.take}`;
      return `${from.path} where .${from.whereComponent}=${from.equals}${take}`;
    }
    case "fromFirst": return `first ${from.segment} with ${from.nonEmpty}`;
    case "todo": return "(TODO)";
  }
}

/**
 * Every source path a row reads, for validation and for the inventory. A row
 * that reads nothing (literal, counter, event, todo) returns an empty list.
 */
export function sourcePathsOf(from: Source): string[] {
  switch (from.kind) {
    case "copy": return [from.path];
    case "firstOf": return from.paths;
    case "lookup": return [from.path];
    case "pickRepeat": return [from.path];
    case "fromFirst": return [from.nonEmpty, from.path];
    case "literal":
    case "counter":
    case "event":
    case "todo":
      return [];
  }
}

/**
 * Structural problems that would otherwise surface as an empty field. Called by
 * every backend before it does anything, so the same spec is rejected the same
 * way whichever direction you are heading.
 */
export function validate(spec: Spec): string[] {
  const problems: string[] = [];

  if (Object.keys(spec.gate.permit).length === 0) {
    problems.push("gate.permit is empty, so this interface would refuse every message");
  }

  const tables = spec.tables ?? {};
  const seen = new Set<string>();

  for (const block of spec.blocks) {
    if (seen.has(block.id) && !block.repeat) {
      problems.push(`${block.id}: two non-repeating blocks with the same segment id`);
    }
    seen.add(block.id);

    for (const row of block.rows) {
      let targetSeg: string;
      try {
        targetSeg = segmentOf(row.target);
      } catch (e) {
        problems.push(String((e as Error).message));
        continue;
      }
      if (targetSeg !== block.id) {
        problems.push(`${row.target} is in the ${block.id} block but targets ${targetSeg}`);
      }

      for (const p of sourcePathsOf(row.from)) {
        try {
          segmentOf(p);
        } catch (e) {
          problems.push(`${row.target}: ${(e as Error).message}`);
        }
      }

      if (row.from.kind === "counter" && !block.repeat) {
        problems.push(`${row.target}: counter() outside a repeat has no ordinal to report`);
      }
      if (row.from.kind === "lookup" && !(row.from.table in tables)) {
        problems.push(`${row.target}: no table named "${row.from.table}" in spec.tables`);
      }
    }
  }

  return problems;
}

/** Tables declared but carrying no rows. A warning, never fatal. */
export function emptyTables(spec: Spec): string[] {
  return Object.entries(spec.tables ?? {})
    .filter(([, rows]) => Object.keys(rows).length === 0)
    .map(([name]) => name);
}
