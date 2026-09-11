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
// Select and Fold: which occurrences of a repeat participate, and how they merge
//
// `Source` and `Step` both answer "what goes in this field". Neither can answer
// "how many segments are there", so a repeat that has to drop or combine
// occurrences has nowhere to say so and the mapping ends up in the runner,
// invisible to the document and to the emitter. These two are that vocabulary.
//
// `over`, `skipWhenEmpty` and `max` stayed plain scalars because each says one
// thing and there is no second way to say it. These are tagged unions because
// there is obviously more than one way to choose an occurrence, and the kind
// lists are what lets `spec.test.ts` hold every backend to all of them.
// ---------------------------------------------------------------------------

export type Select =
  /**
   * Keep only the occurrences whose `path` holds the highest value present.
   *
   * Written for report versioning. A radiology addendum carries the whole
   * report once per revision IN ONE MESSAGE -- three complete copies in the
   * sample that prompted this -- discriminated by OBX-17, and the receiver
   * wants the newest only. Sending all of them triples the document, and the
   * duplication is invisible in any field-level diff because every individual
   * field is correct.
   *
   * Empty sorts lowest, and a message where every occurrence is empty keeps all
   * of them. That is what makes one rule cover both an addendum and a plain
   * final report instead of needing a flag to tell them apart.
   */
  | { kind: "highest"; path: string }
  /**
   * Keep only the occurrences whose `path` equals `value`.
   *
   * The fixed-value counterpart, for a discriminator you already know: one
   * result status, one document type, one coverage priority.
   */
  | { kind: "equals"; path: string; value: string };

export const SELECT_KINDS = ["highest", "equals"] as const;

export type Fold =
  /**
   * Join an occurrence into its predecessor when `path` begins with a space.
   *
   * Narrative text arrives hard-wrapped, one segment per display line, with
   * continuation lines marked by a leading space. The receiver wants whole
   * paragraphs. 57 segments become 43 on the sample this was written for.
   *
   * `join` defaults to "" and should stay there: the leading space IS the
   * separator. Adding one gives "by  M" and trimming gives "byM", and both read
   * as a typo in a signed clinical report rather than as a mapping defect.
   *
   * A continuation arriving with nothing held becomes a head in its own right,
   * leading space and all. Losing a line of a signed report to a formatting
   * quirk is the worse of the two failures, and the space makes it visible.
   */
  | { kind: "continuation"; path: string; join: string };

export const FOLD_KINDS = ["continuation"] as const;

// ---------------------------------------------------------------------------
// Custom schema: the feed as it is really sent
//
// A DTL walks the SCHEMA, not the segments. On a message the schema does not
// describe, the structure walk stops at the first violation and every path past
// it resolves to EMPTY rather than erroring -- the transform runs, and a
// well-formed message comes out with nothing in it.
//
// The fix is a schema category describing the feed as sent. That category is an
// ARTIFACT: it has to exist on whatever instance runs the transform, or every
// named path silently reads nothing. Declaring it here makes it something the
// spec ships rather than something somebody remembers to import.
// ---------------------------------------------------------------------------

export interface SchemaStructure {
  /** Structure name, e.g. "DFT_P03". */
  name: string;
  /**
   * The `~`-delimited definition. Brackets and braces are their own tokens:
   * `[~{~2.5:SFT~}~]`, never the compact `[{SFT}]`, which IRIS rejects with
   * "Unresolved SS reference".
   *
   * Derive this from the stock definition rather than typing it. On any IRIS:
   *
   *     zwrite ^EnsHL7.Schema("2.5","MS","DFT_P03")
   *
   * then change only what the feed forces, so a conforming message still
   * validates exactly as it did.
   */
  definition: string;
  /** What was changed from the base, and why the feed made you change it. */
  note?: string;
}

export interface CustomSchema {
  /** Category name, e.g. "2.5_EXA". Must differ from `base`. */
  category: string;
  /** Stock category it extends, e.g. "2.5". */
  base: string;
  description?: string;
  structures: SchemaStructure[];
}

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

/**
 * How a repeating source segment becomes repeating target segments.
 *
 * The stages run in this order and the order is load-bearing:
 *
 *     all  ->  skipWhenEmpty  ->  select  ->  fold  ->  max
 *
 * `select` before `fold`, or folding joins the tail of one report revision onto
 * the head of the next. `max` last, because max means "deliver at most n" and
 * delivered is counted after folding, not before.
 */
export interface Repeat {
  /** Source segment id to walk. */
  over: string;
  /** Skip a source occurrence when this path is empty. */
  skipWhenEmpty?: string;
  /** Which occurrences participate at all. Runs after skipWhenEmpty. */
  select?: Select;
  /** How surviving occurrences merge into each other. Runs after select. */
  fold?: Fold;
  /** Stop after this many delivered occurrences. Counted after fold. */
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

/**
 * A fixed value written onto the target by the BUSINESS PROCESS, after the
 * transform has run and before the message is dispatched.
 *
 * WHY THIS IS NOT JUST A literal() ROW
 *
 * Most of the time it should be. A field that carries one value for every
 * message this interface sends belongs in a block as `{ target: "MSH-4", from:
 * literal("X") }`, where the delivered trace shows it, the fingerprint covers
 * it, and there is one place to look.
 *
 * A stamp is for the case the DTL cannot express: the value depends on WHERE
 * the message is going, not on what it contains. One process fanning out to two
 * receivers that each want their own sending facility gets two processes, two
 * sendTo values and two stamps, over one shared DTL. Putting that in the
 * transform means forking the transform.
 *
 * `why` is required for the same reason `lookup`'s unmapped branch is. A stamp
 * with no stated reason is indistinguishable from a leftover somebody was
 * afraid to delete, and the next person deletes it or keeps it by coin flip.
 */
export interface Stamp {
  /** Target path on the OUTBOUND message, e.g. "MSH-4". */
  path: string;
  /** The value, written verbatim. Quotes are escaped for you. */
  value: string;
  /** Why this is here and not a literal() row. Goes in the class as a comment. */
  why: string;
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
    /**
     * A custom schema category this spec depends on, emitted by
     * `bun emit.ts schema` and imported with EnsLib.HL7.SchemaXML.
     *
     * Required whenever sourceDocType or targetDocType names a category that is
     * not a plain HL7 version. validate() enforces that, because the failure it
     * prevents has no symptom: the transform delivers an empty message and
     * every test still passes.
     */
    schema?: CustomSchema;
    /** "new" builds a fresh target, which is what block order below describes. */
    create?: "new" | "copy";
    /**
     * The business process that calls the DTL, if you want one emitted.
     *
     * Optional, and absent means nothing changes: no extra artifact, no extra
     * validation, the bench behaves exactly as it did. Present, `emit/process.ts`
     * writes an Ens.BusinessProcess TEMPLATE that filters on the gate, clones,
     * transforms and dispatches.
     *
     *   className   the process class. NOT the DTL class name: they are two
     *               classes and naming them the same replaces one with the other
     *               at compile time.
     *   sendTo      the config item name to dispatch to, as it is spelled in the
     *               production. This is the one fact the bench cannot derive
     *               from anything it already holds.
     *   comment     the one-line description that goes in the class header.
     *   stamp       fixed values written onto the target after the transform.
     *               See `Stamp`. Absent or empty means the process touches no
     *               fields, which is the right answer unless the value depends
     *               on the destination.
     */
    process?: {
      className: string;
      sendTo: string;
      comment?: string;
      stamp?: Stamp[];
    };
    /**
     * What the GENERATED CLASS logs at run time, inside IRIS. Nothing to do
     * with HL7_BENCH_LOG, which is the bench writing files on your machine.
     *
     *   "off"    the class says nothing
     *   "warn"   $$LOGWARNING on an unmapped lookup code and on a required
     *            target that came out empty. Default.
     *   "trace"  the above plus $$TRACE per assigned field, which shows up in
     *            Visual Trace when tracing is on for the host
     *
     * `warn` is the default because both things it reports are silent failures
     * otherwise: the message is delivered, it looks well formed, and the field
     * is wrong or absent. The cost is real and worth stating -- a sender that
     * routinely emits an unmapped code produces one Event Log warning PER
     * MESSAGE until the table is fixed, which is the point, but it will fill
     * the log while you get around to it.
     *
     * Gate refusals are deliberately not in here. The gate belongs in the
     * routing rule, so a refused message never reaches the transform at all;
     * there is nothing in the DTL to log. `emit.ts` prints the rule condition.
     */
    log?: "off" | "warn" | "trace";
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

export const stamp = (path: string, value: string, why: string): Stamp =>
  ({ path, value, why });

export const date8 = (): Step => ({ kind: "date8" });
export const truncate = (n: number): Step => ({ kind: "truncate", n });
export const upper = (): Step => ({ kind: "upper" });
export const stripDelims = (): Step => ({ kind: "stripDelims" });
export const stripChars = (chars: string): Step => ({ kind: "stripChars", chars });
export const defaultTo = (value: string): Step => ({ kind: "defaultTo", value });

export const highest = (path: string): Select => ({ kind: "highest", path });
// Named for its kind, not for how it reads in a spec. `constructorsUsed` in
// serialize.ts regenerates the import line by collecting KINDS and filtering a
// list of CONSTRUCTOR names, so the two have to spell the same. A mismatch
// writes a transform.ts that does not compile, and it does it at GUI-save time
// rather than at test time.
export const equals = (path: string, value: string): Select =>
  ({ kind: "equals", path, value });
export const continuation = (path: string, join = ""): Fold =>
  ({ kind: "continuation", path, join });

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
 * A short human description of a select, for the trace and the drop notes.
 *
 * These read in the mapping document, not just in the log. A receiver asking
 * "does the addendum contain the original report" is asking what `select` does,
 * and the answer belongs in the document rather than in a conversation.
 */
export function describeSelect(s: Select): string {
  switch (s.kind) {
    case "highest": return `highest ${s.path}`;
    case "equals": return `${s.path} = ${s.value}`;
  }
}

/** A short human description of a fold, for the trace and the drop notes. */
export function describeFold(f: Fold): string {
  switch (f.kind) {
    case "continuation": return `join ${f.path} continuation lines`;
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
/**
 * InterSystems packages a generated class must never be named into.
 *
 * A class definition does not extend the package it is named in, it OCCUPIES
 * it. `Class Ens.BusinessProcess Extends Ens.DataTransformDTL` compiles by
 * replacing the InterSystems system class of that name, taking every business
 * process in the namespace with it.
 *
 * The mistake is easy to make and reasonable to make, because the portal sorts
 * config items into Services / Processes / Operations columns and a name is
 * the obvious lever to reach for. It is not the lever. The column is decided
 * by the class a config item EXTENDS, and a DTL extends Ens.DataTransformDTL,
 * which is not a business host and belongs in no column at all. A DTL is named
 * in a routing rule's transform field and is never a config item.
 */
const RESERVED_PACKAGES = ["Ens.", "EnsLib.", "EnsPortal.", "HS.", "%"];

/** Problems with `iris.className`, worst first. Empty when it is unset. */
function classNameProblems(name: string | undefined): string[] {
  if (name === undefined) return [];
  const problems: string[] = [];

  const reserved = RESERVED_PACKAGES.find((p) => name.startsWith(p));
  if (reserved) {
    problems.push(
      `iris.className "${name}" is in the InterSystems package "${reserved}". ` +
        `Compiling that REPLACES a system class rather than extending it. ` +
        `Use your own package. A DTL is not a config item and its name does not ` +
        `decide which portal column anything lands in.`,
    );
  }
  if (!/^[%A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/.test(name)) {
    problems.push(
      `iris.className "${name}" is not a legal class name. ` +
        `Letters and digits per segment, dot separated, no leading digit.`,
    );
  } else if (!name.includes(".")) {
    problems.push(
      `iris.className "${name}" has no package. A class in the root package is ` +
        `hard to find and easy to overwrite. Use e.g. "Site.Interface.Transform.${name}".`,
    );
  }

  return problems;
}

/** A stock HL7 schema category is a bare version: "2.3", "2.5", "2.3.1". */
const STOCK_CATEGORY = /^\d+(\.\d+)*$/;

/** The category half of a DocType: "2.5_EXA" out of "2.5_EXA:DFT_P03". */
function categoryOf(docType: string): string {
  return docType.includes(":") ? docType.split(":", 1)[0] : "";
}

export function validate(spec: Spec): string[] {
  const problems: string[] = [];

  if (Object.keys(spec.gate.permit).length === 0) {
    problems.push("gate.permit is empty, so this interface would refuse every message");
  }

  // The custom schema, and the deliverable nobody tracks.
  //
  // A DocType naming a category that does not ship with IRIS is a dependency on
  // an artifact that has to be imported before the transform can read anything.
  // Miss it and there is no error: the structure walk finds nothing, every named
  // path resolves to empty, and a well-formed message is delivered with nothing
  // in it. Measured: 143 OBX in, 0 out, whole suite green.
  const sch = spec.iris.schema;
  const used = [spec.iris.sourceDocType, spec.iris.targetDocType]
    .map(categoryOf)
    .filter((c) => c !== "" && !STOCK_CATEGORY.test(c));

  for (const cat of [...new Set(used)]) {
    if (sch?.category === cat) continue;
    problems.push(
      `iris: DocType uses schema category "${cat}", which is not a stock HL7 version, ` +
        `and iris.schema does not declare it. Declare it so \`bun emit.ts schema\` ships it. ` +
        `An undeclared category is imported by somebody remembering to, and when they do not, ` +
        `every named path reads empty and nothing errors.`,
    );
  }

  if (sch) {
    if (sch.category === sch.base) {
      problems.push(
        `iris.schema.category is "${sch.category}", the same as its base. A category cannot ` +
          `extend itself, and importing it would overwrite the stock schema.`,
      );
    }
    if (STOCK_CATEGORY.test(sch.category)) {
      problems.push(
        `iris.schema.category "${sch.category}" looks like a stock HL7 version. Importing it ` +
          `replaces the shipped schema for every interface in the namespace. Use a suffix, ` +
          `e.g. "${sch.category}_SITE".`,
      );
    }
    if (sch.structures.length === 0) {
      problems.push(`iris.schema declares category "${sch.category}" with no structures in it`);
    }
    for (const st of sch.structures) {
      // The compact form is the mistake everybody makes once. IRIS answers
      // "Unresolved SS reference '[{SFT}]'", which does not say what to do.
      if (/\[\{|\}\]/.test(st.definition)) {
        problems.push(
          `iris.schema structure ${st.name}: brackets must be their own "~"-delimited tokens ` +
            `("[~{~${sch.base}:SFT~}~]"), not the compact form ("[{SFT}]"). IRIS rejects the ` +
            `compact form with "Unresolved SS reference".`,
        );
      }
      if (!st.definition.includes("~")) {
        problems.push(
          `iris.schema structure ${st.name}: the definition has no "~" separators at all`,
        );
      }
    }
    if (used.length === 0) {
      problems.push(
        `iris.schema declares "${sch.category}" but no DocType uses it. Either point ` +
          `sourceDocType or targetDocType at it, or drop it -- a schema nothing references ` +
          `is an artifact somebody will keep importing for no reason.`,
      );
    }
  }

  problems.push(...classNameProblems(spec.iris.className));

  const proc = spec.iris.process;
  if (proc) {
    problems.push(...classNameProblems(proc.className).map((p) => p.replace("iris.className", "iris.process.className")));

    // Two classes, so two names. Compiling a business process over the name of
    // the DTL it calls does not fail: the second definition replaces the first,
    // the transform the rule names disappears, and the rule then fails at run
    // time complaining about a transform that is right there in the portal.
    if (spec.iris.className !== undefined && proc.className === spec.iris.className) {
      problems.push(
        `iris.process.className is the same as iris.className ("${proc.className}"). ` +
          `They are two classes. Compiling both under one name replaces the DTL with the process.`,
      );
    }
    if (proc.sendTo.trim() === "") {
      problems.push(
        `iris.process.sendTo is empty. The process would call SendRequestAsync with no target, ` +
          `which fails at run time rather than at compile time.`,
      );
    }

    // Stamps. Every one of these is a field the trace document will not
    // explain, so the bar for keeping one is higher than for a mapped row.
    const stamped = new Map<string, number>();
    for (const st of proc.stamp ?? []) {
      try {
        segmentOf(st.path);
      } catch (e) {
        problems.push(`iris.process.stamp: ${(e as Error).message}`);
        continue;
      }

      if (st.why.trim() === "") {
        problems.push(
          `iris.process.stamp ${st.path} has an empty why. A stamp with no stated reason ` +
            `reads as a leftover, and the next person keeps or deletes it by coin flip.`,
        );
      }

      // Two stamps on one path is the second one winning silently.
      stamped.set(st.path, (stamped.get(st.path) ?? 0) + 1);
      if (stamped.get(st.path) === 2) {
        problems.push(
          `iris.process.stamp writes ${st.path} more than once. The last one wins and the ` +
            `others are dead lines that look live.`,
        );
      }

      // The expensive one. A path the DTL already assigns, stamped again after
      // the transform, is two sources of truth for one field: the trace
      // document shows the mapped value and the receiver gets the stamped one.
      const alsoMapped = spec.blocks.some((b) => b.rows.some((r) => r.target === st.path));
      if (alsoMapped) {
        problems.push(
          `iris.process.stamp writes ${st.path}, which a block row also assigns. The stamp runs ` +
            `after the transform and wins, so the delivered trace documents a value the receiver ` +
            `never sees. Keep one: the block row if the value is fixed for this interface, the ` +
            `stamp if it depends on the destination.`,
        );
      }
    }
  }

  const tables = spec.tables ?? {};
  const seen = new Set<string>();

  // Segments some block walks with a repeat. Reading one of these from OUTSIDE
  // that repeat is the single most expensive mistake this vocabulary allows.
  const repeated = new Set(spec.blocks.filter((b) => b.repeat).map((b) => b.repeat!.over));

  for (const block of spec.blocks) {
    if (seen.has(block.id) && !block.repeat) {
      problems.push(`${block.id}: two non-repeating blocks with the same segment id`);
    }
    seen.add(block.id);

    // A select or fold path that names a different segment reads the message
    // rather than the current occurrence, so it returns the same value for
    // every occurrence: select keeps all or none, fold folds everything or
    // nothing. Both deliver a plausible message and neither raises anything.
    const rep = block.repeat;

    /**
     * What a fold is allowed to be, so both backends can express it.
     *
     * `run.ts` folds the SOURCE and then applies rows to the joined value. The
     * DTL has nowhere to hold a segment across a <foreach>, so it appends into
     * the target field already written. Those two agree only while the folded
     * field goes somewhere with no `via` steps -- otherwise the bench truncates
     * the joined text and the engine truncates each piece and concatenates.
     *
     * Refused here rather than documented, because the difference shows up as
     * a report that reads correctly and is missing the end of every paragraph.
     */
    if (rep?.fold) {
      const carriers = block.rows.filter(
        (row) => row.from.kind === "copy" && row.from.path === rep.fold!.path,
      );
      if (carriers.length === 0) {
        problems.push(
          `${block.id}: repeat.fold joins ${rep.fold.path}, but no row copies it, ` +
            `so the fold would have no effect on the delivered message`,
        );
      }
      for (const row of carriers.filter((c) => c.via?.length)) {
        problems.push(
          `${block.id}: ${row.target} copies the folded field ${rep.fold.path} and has via ` +
            `steps. The bench would apply them to the joined value and the DTL to each ` +
            `piece. Drop the steps, or fold a different field.`,
        );
      }
      if (rep.max !== undefined) {
        problems.push(
          `${block.id}: repeat.fold with repeat.max. The bench applies max after folding; ` +
            `the DTL cannot, and would append continuations of a capped occurrence onto the ` +
            `last one it kept. Use one or the other.`,
        );
      }
    }

    for (const [what, path] of [
      ["select", rep?.select?.path],
      ["fold", rep?.fold?.path],
    ] as const) {
      if (path === undefined) continue;
      try {
        if (segmentOf(path) !== rep!.over) {
          problems.push(
            `${block.id}: repeat.${what} reads ${path}, but the repeat walks ${rep!.over}`,
          );
        }
      } catch (e) {
        problems.push(`${block.id}: repeat.${what}: ${(e as Error).message}`);
      }
    }

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

      // A bare `{OBX:14}` returns EMPTY in IRIS on a message carrying several
      // OBX segments -- not the first one, nothing at all. `run.ts` returns the
      // first, because an array scan has no reason not to. So a copy() of a
      // repeating segment read from outside its loop delivers a value on the
      // bench and an empty field on the engine, and both messages are well
      // formed. `fromFirst` exists precisely for this and says which occurrence
      // it means.
      //
      // Measured: four rows sourced from OBX-14 this way put a datetime in
      // MSH-7, EVN-2, TXA-4 and TXA-22 on the bench and left all four empty in
      // the generated DTL.
      if (row.from.kind === "copy" || row.from.kind === "firstOf") {
        for (const p of sourcePathsOf(row.from)) {
          let ps: string;
          try { ps = segmentOf(p); } catch { continue; }
          if (!repeated.has(ps)) continue;
          if (block.repeat?.over === ps) continue; // inside its own loop, correct
          problems.push(
            `${row.target}: reads ${p}, and ${ps} is a repeating segment this spec walks ` +
              `elsewhere. A bare ${ps} path outside that loop returns the first occurrence ` +
              `in the bench and EMPTY in IRIS. Use fromFirst("${ps}", "${p}", "${p}") to say ` +
              `which occurrence you mean.`,
          );
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
