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

/** Every unmapped branch, so a serializer can name them without a second list. */
export const UNMAPPED_KINDS = ["blank", "passthrough", "constant"] as const;

export type Source =
  /** Copy a source path straight across. */
  | { kind: "copy"; path: string }
  /** Stamp a constant. */
  | { kind: "literal"; value: string }
  /** First non-empty of several source paths. Becomes a nested $SELECT. */
  | { kind: "firstOf"; paths: string[] }
  /** Table translation with a stated unmapped branch. */
  /**
   * Table translation with a stated unmapped branch.
   *
   * `path` is the ordinary case: a flat path on the incoming message. `from`
   * supersedes it when the key is not somewhere a flat path can reach -- the
   * relationship code on the NK1 whose NK1-1 is 2, say, which needs a
   * `fromWhere` to find before there is anything to look up.
   *
   * One level only, and deliberately. A source nested inside a source inside a
   * source is a thing nobody can read in a form, and every case seen so far is
   * "find the right occurrence, then translate what is in it".
   */
  | {
      kind: "lookup";
      table: string;
      path?: string;
      from?: KeySource;
      unmapped: Unmapped;
    }
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
   * The occurrence of a repeating segment whose `where` path EQUALS `equals`,
   * read at `read`.
   *
   * `fromFirst` tests for a value being present; this tests for it being a
   * particular value, which is a different question and could not be asked.
   * "The NK1 whose NK1-1 is 2" is the shape that prompted it: set ids are how
   * a sender distinguishes relatives, and neither counting occurrences nor
   * testing for non-emptiness finds the right one.
   *
   * `pickRepeat` is the sibling for the other axis -- it scans the `~`
   * repetitions WITHIN one field, where this walks occurrences of a SEGMENT.
   * Reaching for the wrong one reads nothing and reports nothing.
   *
   * First match wins. A sender that puts the same set id on two segments has a
   * problem this cannot solve, and picking the later one silently would hide
   * it.
   */
  | { kind: "fromWhere"; segment: string; where: string; equals: string; read: string }
  /**
   * Not expressible yet. Delivers empty, traces as TODO, emits a TODO comment
   * and no assign.
   *
   * Deliberately visible in all three backends. A generator that quietly drops
   * what it cannot express is worse than no generator, because the gap is
   * invisible until somebody reads a report.
   */
  | { kind: "todo"; why: string };

/**
 * What a lookup may read its key through.
 *
 * The occurrence-finding kinds, and nothing that would recurse. `copy` is
 * absent because a flat path is what `lookup.path` already is.
 */
export type KeySource =
  | { kind: "firstOf"; paths: string[] }
  | {
      kind: "pickRepeat";
      path: string;
      whereComponent: number;
      equals: string;
      take: number | number[] | "whole";
    }
  | { kind: "fromFirst"; segment: string; nonEmpty: string; path: string }
  | { kind: "fromWhere"; segment: string; where: string; equals: string; read: string };

export const KEY_SOURCE_KINDS = ["firstOf", "pickRepeat", "fromFirst", "fromWhere"] as const;

export const SOURCE_KINDS = [
  "copy", "literal", "firstOf", "lookup", "counter",
  "event", "pickRepeat", "fromFirst", "fromWhere", "todo",
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
  | { kind: "defaultTo"; value: string }
  /**
   * Put fixed text in front of the value.
   *
   * Written for the composite field a row cannot otherwise build. A target of
   * `MSH-9` with `event()` delivers "A28"; the receiver wants "ADT^A28", and
   * there is no other way to say that -- assigning MSH-9.1 and MSH-9.2 as two
   * rows leaves whatever the seed put in MSH-9.3, and blanking THAT leaves a
   * trailing "^" because emptying a component does not shorten the field.
   * Writing the whole field at once is the only form that produces exactly two
   * components, and this is how the first one gets there.
   *
   * THE DELIMITER IS YOURS TO GET RIGHT. Text here is written verbatim: a "^"
   * in it is a component separator only because almost every message declares
   * "^" in MSH-2. A feed that declares something else would need the text
   * changed, and neither backend will notice. `stripDelims` exists for the
   * opposite problem and is the one to reach for when the text is data.
   */
  | { kind: "prefix"; text: string };

export const STEP_KINDS = [
  "date8", "truncate", "upper", "stripDelims", "stripChars", "defaultTo", "prefix",
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
  /** Category name, e.g. "2.5_SITE". Must differ from `base`. */
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
   * This block's target segment CONTINUES the occurrence numbering of the
   * nearest earlier block with the same id, instead of starting at 1.
   *
   * For one more segment after a repeat: a radiology feed whose narrative
   * arrives as 143 OBX and whose receiver wants the CPT appended as one final
   * OBX after it. Without this the block writes OBX(1) and overwrites the first
   * line of the report, which reads as a mangled report rather than as a
   * mapping fault.
   *
   * `counter()` inside such a block reports the continued ordinal, so the CPT
   * segment is numbered 44 rather than 1.
   */
  continuesNumbering?: boolean;
  /**
   * IRIS group name when the target segment sits inside one, e.g.
   * "INSURANCEgrp". Ignored by the JavaScript runner, which has no groups, and
   * load-bearing in the DTL, where `target.{IN1(1):2}` resolves to nothing but
   * `target.{INSURANCEgrp(1).IN1:2}` works. Both fail closed. Check the schema
   * browser rather than guessing.
   */
  group?: string;
  /**
   * Seed this target segment from the SOURCE segment of the same id, whole,
   * before any row runs. The rows then overwrite fields on top of the copy.
   *
   * This is the passthrough ADT shape: "send them the PID they sent us, minus
   * PID-9, PID-19 and PID-20". In ObjectScript that is one call --
   * `tTarget.SetValueAt(tSource.GetValueAt("PID"),"PID")` -- and enumerating
   * the fifty fields it copies is not the same statement. Enumeration is a list
   * of the fields that existed the day it was written; a field the sender adds
   * next quarter flows under this and silently does not under that.
   *
   * WHAT IT COSTS, SAID PLAINLY
   *
   * `bun trace.ts` cannot name fields nobody enumerated. A seeded block prints
   * one COPIED row for the segment and then the rows that override it, and the
   * receiving team gets "PID: sent as received, except..." instead of a field
   * table. That is an honest document and a thinner one. Use a seed where the
   * agreement really is "pass it through", and enumerate where the agreement is
   * a mapping -- the difference is what you told the receiver, not what is less
   * typing.
   *
   * SAME ID ONLY. A seed is the identity copy; a cross-segment whole copy would
   * carry the wrong segment id in the first field and IRIS would deliver it.
   * `validate()` refuses a repeat whose `over` is not this block's id.
   *
   * NOT COMPATIBLE WITH `repeat.fold`. A fold appends a continuation onto the
   * segment already written, and re-seeding on the continuation would overwrite
   * the head it is supposed to extend. `validate()` refuses the pair.
   */
  wholeSegment?: true;
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
    /**
     * Where the SOURCE schema keeps a segment, when it is not at the top level.
     * Segment id to the group path that contains it:
     *
     *   sourceGroups: { OBX: "ORCgrp(1).OBXgrp", OBR: "ORCgrp(1).OBRgrp" }
     *
     * This is the source-side twin of `Block.group`, and they are genuinely two
     * facts. A 2.5 DFT keeps OBX inside ORCgrp while a 2.3 MDM keeps it flat, so
     * one spec needs the source grouped and the target not. Deriving either from
     * the other writes a transform that resolves nothing on one side.
     *
     * Read these off YOUR namespace's schema, not off the standard:
     *
     *   zw ^EnsHL7.Schema("<category>","MS","<structure>","map")
     *
     * Every entry there is the path IRIS will accept -- "ORCgrp().OBXgrp().OBX"
     * becomes "ORCgrp(1).OBXgrp" here, because the outer group is fixed and the
     * inner one is what repeats. A group name that is wrong resolves to empty
     * and reports nothing, exactly like a wrong DocType.
     *
     * The occurrence index on an outer group is an ASSUMPTION. "ORCgrp(1)" reads
     * the first group and only the first. That is right for a feed that sends
     * one, which is most of them, and wrong in silence for a feed that sends
     * two. Confirm it against a real message before trusting it.
     *
     * Ignored by the JavaScript runner, whose message model is flat -- same rule
     * as `Block.group`. The bench will read a wrongly grouped spec perfectly and
     * IRIS will read nothing, so this is one of the few things the golden gate
     * cannot catch for you.
     */
    sourceGroups?: Record<string, string>;
    /**
     * Schema categories this interface READS but does not ship -- ones the
     * namespace already provides because another interface brought them.
     *
     * Reusing one is usually the right call: no import, no write to a shared
     * global, no change control, and the receiving service is already stamping
     * that DocType so nothing has to coerce it. What you give up is control.
     * `bun schema-sync.ts` cannot help here -- it compares the engine against
     * THIS spec, and this spec does not define the category -- so the note is
     * the only baseline anyone will have.
     *
     * Put the real definition in the note:
     *
     *   externalSchemas: [{
     *     category: "FromVendor",
     *     note: "Owned by the charges interface. Captured 2026-09-17 from " +
     *           "DEV: 2.5:MSH~[~{~2.5:SFT~}~]~[~2.5:EVN~]~... (full string)",
     *   }]
     *
     * Missing is the easy case; it resolves to empty and it is loud once you
     * look. STALE is the dangerous one: the walk succeeds, every path resolves,
     * and the message navigates under a definition nobody here chose.
     */
    externalSchemas?: { category: string; note: string }[];
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

export const lookup = (
  table: string,
  path: string | KeySource,
  unmapped: Unmapped,
): Source =>
  typeof path === "string"
    ? { kind: "lookup", table, path, unmapped }
    : { kind: "lookup", table, from: path, unmapped };

export const pickRepeat = (
  path: string,
  whereComponent: number,
  equals: string,
  take: number | number[] | "whole" = "whole",
): Source => ({ kind: "pickRepeat", path, whereComponent, equals, take });

export const fromFirst = (segment: string, nonEmpty: string, path: string): Source =>
  ({ kind: "fromFirst", segment, nonEmpty, path });

export const fromWhere = (
  segment: string,
  where: string,
  equals: string,
  read: string,
): Source => ({ kind: "fromWhere", segment, where, equals, read });

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
export const prefix = (text: string): Step => ({ kind: "prefix", text });

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
    case "lookup":
      return `${from.from ? describeSource(from.from as Source) : from.path} via ${from.table}`;
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
    case "fromWhere": return `${from.segment} where ${from.where}=${from.equals}, read ${from.read}`;
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
    case "lookup":
      return from.from ? sourcePathsOf(from.from as Source) : from.path ? [from.path] : [];
    case "pickRepeat": return [from.path];
    case "fromFirst": return [from.nonEmpty, from.path];
    case "fromWhere": return [from.where, from.read];
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

/** The category half of a DocType: "2.5_SITE" out of "2.5_SITE:DFT_P03". */
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

  const external = new Map((spec.iris.externalSchemas ?? []).map((e) => [e.category, e]));

  for (const cat of [...new Set(used)]) {
    if (sch?.category === cat) continue;
    if (external.has(cat)) continue;
    problems.push(
      `iris: DocType uses schema category "${cat}", which is not a stock HL7 version, ` +
        `and neither iris.schema nor iris.externalSchemas declares it. Ship it with ` +
        `iris.schema, or record it in iris.externalSchemas if the namespace already has it. ` +
        `An undeclared category is imported by somebody remembering to, and when they do not, ` +
        `every named path reads empty and nothing errors.`,
    );
  }

  for (const e of spec.iris.externalSchemas ?? []) {
    if (sch?.category === e.category) {
      problems.push(
        `iris.externalSchemas lists "${e.category}", which iris.schema also ships. It is ` +
          `either yours or theirs; declaring both means an import can overwrite a category ` +
          `another interface resolves against.`,
      );
    }
    if (!used.includes(e.category)) {
      problems.push(
        `iris.externalSchemas lists "${e.category}", which no DocType on this spec names. ` +
          `A dependency nothing uses reads as a leftover.`,
      );
    }
    if (!e.note.trim()) {
      problems.push(
        `iris.externalSchemas.${e.category} has an empty note. The note is the only record ` +
          `of where the definition came from and what it looked like, and a category you do ` +
          `not own can be edited without you. Stale passes every check you have.`,
      );
    }
  }

  for (const [seg, path] of Object.entries(spec.iris.sourceGroups ?? {})) {
    if (!/^[A-Z0-9]{3}$/.test(seg)) {
      problems.push(
        `iris.sourceGroups key "${seg}" is not a segment id. Keys are the segment being ` +
          `placed, e.g. "OBX", and the value is the group path that contains it.`,
      );
    }
    // The segment's own id belongs on the read, not in the group path. Writing
    // "ORCgrp(1).OBXgrp.OBX" here produces "...OBXgrp.OBX.OBX:5", which
    // resolves to nothing and reports nothing.
    if (new RegExp(`(^|\\.)${seg}(\\(|$)`).test(path)) {
      problems.push(
        `iris.sourceGroups.${seg} is "${path}", which already names ${seg}. The value is the ` +
          `group path only; the emitter appends ".${seg}" to it.`,
      );
    }
    if (path === "" || /^\.|\.$/.test(path)) {
      problems.push(`iris.sourceGroups.${seg} is "${path}", which is not a group path`);
    }
    // Every element but the last must carry a fixed occurrence, because only
    // the innermost group is the one a loop walks. "ORCgrp.OBXgrp" leaves the
    // outer one unsubscripted and IRIS resolves it to nothing.
    const parts = path.split(".");
    for (const outer of parts.slice(0, -1)) {
      if (!/^\w+\(\d+\)$/.test(outer)) {
        problems.push(
          `iris.sourceGroups.${seg} is "${path}", but the outer group "${outer}" carries no ` +
            `fixed occurrence. Write e.g. "${outer}(1)" -- an unsubscripted outer group ` +
            `resolves to empty, silently. Confirm the index against a real message.`,
        );
      }
    }
    if (/\(\)$/.test(parts[parts.length - 1]!)) {
      problems.push(
        `iris.sourceGroups.${seg} is "${path}". Leave the innermost group bare ("OBXgrp"); ` +
          `the emitter adds "()" or the loop variable depending on where it is read.`,
      );
    }
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
    if (seen.has(block.id) && !block.repeat && !block.continuesNumbering) {
      problems.push(
        `${block.id}: two non-repeating blocks with the same segment id. If the second is ` +
          `meant to follow the first rather than replace it, set continuesNumbering.`,
      );
    }
    if (block.continuesNumbering && !seen.has(block.id)) {
      problems.push(
        `${block.id}: continuesNumbering, but no earlier block targets ${block.id}. There is ` +
          `nothing to continue, and the segment would be written at occurrence 1 anyway.`,
      );
    }
    seen.add(block.id);

    // A seed is the identity copy and nothing else. The three refusals below
    // are the three ways it can be written to look right and deliver wrong.
    if (block.wholeSegment) {
      // The source id has to be this block's id, or the copied text carries the
      // wrong segment id in its first field and IRIS delivers it as that
      // segment. Nothing errors -- the message is well formed and mislabelled.
      if (block.repeat && block.repeat.over !== block.id) {
        problems.push(
          `${block.id}: wholeSegment with repeat.over "${block.repeat.over}". A seed is the ` +
            `identity copy; copying a ${block.repeat.over} whole into a ${block.id} writes ` +
            `"${block.repeat.over}" into the segment id and delivers it under that name. ` +
            `Enumerate the fields instead, or make the block target ${block.repeat.over}.`,
        );
      }
      // A fold appends onto the segment already written. Re-seeding on the
      // continuation replaces the head the continuation exists to extend, so
      // the delivered report is the LAST line of each paragraph.
      if (block.repeat?.fold) {
        problems.push(
          `${block.id}: wholeSegment with repeat.fold. The fold appends onto the segment ` +
            `already written and the seed would overwrite it, delivering only the last ` +
            `continuation of each group. Use one or the other.`,
        );
      }
      // A block that continues an earlier one's numbering has no source
      // occurrence of its own: the seed would read the FIRST source segment of
      // that id into occurrence n+1. Both backends agree about it, and both are
      // wrong in the same way -- the extra segment is a duplicate of the first
      // one wearing a later set id, which reads as real data.
      if (block.continuesNumbering) {
        problems.push(
          `${block.id}: wholeSegment with continuesNumbering. The extra occurrence has no ` +
            `source occurrence of its own, so the seed would copy the FIRST source ${block.id} ` +
            `again under a later set id. Enumerate the fields this one carries instead.`,
        );
      }
      // MSH-2 defines the delimiters and MSH-1 is the field separator. Seeding
      // MSH carries both across unchanged, which is what you want, but a row
      // that then assigns MSH-2 re-encodes a message already written with the
      // old delimiters.
      if (block.id === "MSH" && block.rows.some((r) => r.target === "MSH-2")) {
        problems.push(
          `MSH: wholeSegment seeds MSH-2 from the source, and a row also assigns it. ` +
            `MSH-2 defines the delimiters the rest of the message is already encoded with; ` +
            `changing it after the copy re-labels the separators without re-encoding anything.`,
        );
      }
    }

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

    // The same trap as select and fold, and it was not checked. A
    // skipWhenEmpty naming another segment is read off the CURRENT occurrence
    // of `over`, where it resolves to nothing on every one -- so either every
    // occurrence is skipped or none is, and the delivered message is plausible
    // either way. Usually a leftover from a copied block.
    if (rep?.skipWhenEmpty) {
      try {
        if (segmentOf(rep.skipWhenEmpty) !== rep.over) {
          problems.push(
            `${block.id}: repeat.skipWhenEmpty is "${rep.skipWhenEmpty}", which is not a ${rep.over} ` +
              `path. It is read off the current ${rep.over}, so it resolves to nothing on every ` +
              `occurrence -- skipping all of them or none, with no error either way.`,
          );
        }
      } catch (e) {
        problems.push(`${block.id}: repeat.skipWhenEmpty: ${(e as Error).message}`);
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

      if (row.from.kind === "counter" && !block.repeat && !block.continuesNumbering) {
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
