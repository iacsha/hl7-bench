#!/usr/bin/env bun
/**
 * patterns.ts -- the moves. Runnable.
 *
 *   bun patterns.ts            run every pattern, show what each one changed
 *   bun patterns.ts P7         run one
 *   bun patterns.ts P7 my.hl7  run one against your own message
 *
 * Every pattern here is a complete, working transform body. Copy the `run`
 * function into transform.ts and you have that behaviour. Each one carries the
 * IRIS DTL that does the same thing, so reading this file is reading both
 * languages against each other -- which is the point, because the bench is
 * where you work it out and IRIS is where it ships.
 *
 * Twelve patterns cover the overwhelming majority of ADT interface work. When
 * you hit something that is not here, it is usually two of these composed.
 */

import { Message, Segment } from "./hl7";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Pattern {
  id: string;
  name: string;
  /** Why you reach for it, and the trap that comes with it. */
  why: string;
  /** The IRIS DTL that does the same job. */
  dtl: string;
  run(msg: Message): void;
}

export const PATTERNS: Pattern[] = [

  // -------------------------------------------------------------------------
  {
    id: "P1",
    name: "Gate on trigger event",
    why:
      "Decides which messages the interface is even willing to handle. Do this " +
      "FIRST and as a table, never as if/else. An if/else grows an implicit " +
      "'everything else' branch, and that branch is how an A03 discharge ends " +
      "up delivered as a person update.",
    dtl:
      "Not a DTL at all -- this is the ROUTING RULE:\n" +
      "  condition: HL7.{MSH:9.2} in (\"A01\",\"A08\")\n" +
      "A message that matches no rule is never delivered. There is nothing to write.",
    run(msg) {
      const PERMITTED: Record<string, string> = { A01: "A28", A08: "A31" };
      const event = msg.get("MSH-9.2");
      if (!(event in PERMITTED)) {
        throw new Error(`Event "${event || "(empty)"}" not permitted. Allowed: ${Object.keys(PERMITTED)}`);
      }
      msg.set("MSH-9.2", PERMITTED[event]!);
      msg.set("EVN-1", PERMITTED[event]!);
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "P2",
    name: "Segment whitelist (keep only these)",
    why:
      "Use when the receiver told you what they WANT. Safer than a blacklist: " +
      "when the sender adds a new segment next year, a whitelist drops it and a " +
      "blacklist forwards it. Receivers reject surprises.",
    dtl:
      "DTL has no keep-only. You write one remove per unwanted segment:\n" +
      "  <assign value='\"\"' property='target.{NK1()}' action='remove'/>\n" +
      "The () removes EVERY repetition. Without it you remove only the first.",
    run(msg) {
      const KEEP = new Set(["MSH", "EVN", "PID", "PV1", "GT1"]);
      for (let i = msg.segments.length - 1; i >= 0; i--) {
        if (!KEEP.has(msg.segments[i]!.id)) msg.segments.splice(i, 1);
      }
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "P3",
    name: "Segment blacklist (drop these)",
    why:
      "Use when the receiver told you what they do NOT want, and you have no " +
      "authority over what else might show up. Walk backwards -- deleting " +
      "forwards shifts the indexes under you and you skip every second match.",
    dtl: "<assign value='\"\"' property='target.{DG1()}' action='remove'/>   (one per segment)",
    run(msg) {
      const DROP = new Set(["NK1", "PV2", "DG1", "PR1", "ROL", "IN1", "UB2", "NTE", "STF", "ZAD"]);
      for (let i = msg.segments.length - 1; i >= 0; i--) {
        if (DROP.has(msg.segments[i]!.id)) msg.segments.splice(i, 1);
      }
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "P4",
    name: "Stamp a literal",
    why:
      "The receiver's own identifier, a constant facility code, a version bump. " +
      "Most common single edit in any interface. If the value came from an email " +
      "rather than the message, it belongs here and it belongs commented.",
    dtl: "<assign value='\"RECVAPP\"' property='target.{MSH:5}' action='set'/>",
    run(msg) {
      msg.set("MSH-5", "RECVAPP");       // receiving application, per the receiver's spec
      msg.set("PID-3.5", "MR");          // identifier type -- MRN
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "P5",
    name: "Copy field to field",
    why:
      "Moving data the receiver keys on into the field they read. Read the " +
      "SOURCE before you have overwritten it -- once you assign, the old value " +
      "is gone and a later read gets your own output back.",
    dtl:
      "<assign value='source.{PID:18}' property='target.{PV1:19}' action='set'/>\n" +
      "Note source.{} on the right, target.{} on the left. Reading target.{} mid-\n" +
      "transform gives you what you already wrote, which is recipe 08's whole point.",
    run(msg) {
      const account = msg.get("PID-18");     // read source first
      if (account !== "") msg.set("PV1-19", account);
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "P6",
    name: "Conditional set",
    why:
      "Branch on a value. The trap is the else: decide what an EMPTY or " +
      "UNEXPECTED value does, out loud, because the sender will produce both.",
    dtl:
      "<if condition='source.{PV1:2}=\"I\"'>\n" +
      "  <true><assign value='\"INPATIENT\"' property='target.{PV1:2}' action='set'/></true>\n" +
      "</if>\n" +
      "The [ operator is 'contains': condition='source.{PID:11.3}[\"ROCH\"'",
    run(msg) {
      const cls = msg.get("PV1-2");
      if (cls === "I") msg.set("PV1-2", "INPATIENT");
      else if (cls === "O") msg.set("PV1-2", "OUTPATIENT");
      // Anything else, including empty, is left exactly as sent. That is a
      // decision, and it is written down here where the next reader sees it.
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "P7",
    name: "Code lookup with an explicit unmapped branch",
    why:
      "The single highest-value habit in this whole file. A lookup ALWAYS needs " +
      "a stated answer for a code that is not in the table. Blanking it is " +
      "silent data loss. Passing it through is a choice. Throwing is a choice. " +
      "Picking one by accident is how a new vendor code reaches the receiver as " +
      "an empty field that nobody notices for six weeks.",
    dtl:
      "<assign value='$case(source.{PID:8},\"M\":\"MALE\",\"F\":\"FEMALE\",:source.{PID:8})'\n" +
      "        property='target.{PID:8}' action='set'/>\n" +
      "The bare : before the last value is the default. Defaulting to source.{}\n" +
      "passes unknown codes through. Production form once codes churn:\n" +
      "  set target.{PID:8} = ..Lookup(\"Sex\", source.{PID:8}, source.{PID:8})\n" +
      "-- a lookup table needs no recompile when a code is added.",
    run(msg) {
      const TABLE: Record<string, string> = { M: "MALE", F: "FEMALE", O: "OTHER", U: "UNKNOWN" };
      const v = msg.get("PID-8");
      // Chosen behaviour: pass unmapped through untouched. Swap to a throw if
      // the receiver would rather fail loudly than receive a raw code.
      msg.set("PID-8", TABLE[v] ?? v);
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "P8",
    name: "Walk every repeating segment",
    why:
      "NK1, DG1, IN1, OBX, FT1. The expensive mistake is writing against the " +
      "FIRST one because the test message only had one. Four FT1 segments are " +
      "four charges. Twenty OBX are twenty results.",
    dtl:
      "DTL <foreach> handles the common case:\n" +
      "  <foreach property='source.{DG1grp()}' key='k'> ... </foreach>\n" +
      "When the group names fight you, walk by POSITION instead (recipe 10):\n" +
      "  for i=2:1:source.SegCount { if source.GetSegmentAt(i).Name=\"NK1\" { ... } }\n" +
      "Start at 2 -- segment 1 is MSH and its numbering does not mean the same thing.",
    run(msg) {
      for (const nk1 of msg.all("NK1")) {
        nk1.set("NK1-2.1", nk1.get("NK1-2.1").toUpperCase());
      }
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "P9",
    name: "Walk every repetition of a field",
    why:
      "Different thing from P8. One PID segment can carry several identifiers " +
      "in PID-3, separated by ~. Assigning PID-3.5 without an index writes only " +
      "the first repetition and leaves the rest untyped.",
    dtl: "  set target.{PID:3(i).5} = \"MR\"     -- inside a for i=1:1:count loop",
    run(msg) {
      const pid = msg.seg("PID");
      if (!pid) throw new Error("No PID segment");
      for (let r = 1; r <= pid.repCount(3); r++) {
        pid.set(`PID-3(${r}).5`, "MR");
      }
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "P10",
    name: "Date and time reshaping",
    why:
      "HL7 TS is YYYYMMDDHHMMSS, truncated anywhere. Plenty of senders emit 12 " +
      "here (no seconds). Receivers vary on what they tolerate. Truncating to 8 " +
      "for a date-only field is the workhorse; padding to 14 is the other half.",
    dtl:
      "  set target.{PID:7} = $extract(source.{PID:7},1,8)\n" +
      "Current timestamp in HL7 TS form:\n" +
      "  set target.{EVN:2} = $translate($zdatetime($horolog,8),\" :\",\"\")",
    run(msg) {
      msg.set("PID-7", msg.get("PID-7").slice(0, 8));      // date only
      const ts = msg.get("MSH-7");
      msg.set("MSH-7", ts.length === 12 ? ts + "00" : ts);  // pad minutes to seconds
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "P11",
    name: "Add a segment that was not there",
    why:
      "Position matters. HL7 segment order is part of the structure, and a " +
      "receiver's parser can reject a segment that appears in the wrong place " +
      "even though every field in it is correct. Decide the index deliberately.",
    dtl:
      " set tSeg = ##class(EnsLib.HL7.Segment).%New()\n" +
      " set tSeg.Separators = target.Separators\n" +
      " do tSeg.SetValueAt(\"NTE\", 0)\n" +
      " do tSeg.SetValueAt(\"1\", 1)\n" +
      " do target.AppendSegment(tSeg)\n" +
      "SetValueAt(...,0) sets the segment NAME. AppendSegment puts it at the end;\n" +
      "InsertSegmentAt puts it where you say.",
    run(msg) {
      const nte = new Segment("NTE", ["NTE", "1", "L", "Derived by interface"], msg.delims);
      const pidAt = msg.segments.findIndex((s) => s.id === "PID");
      msg.segments.splice(pidAt + 1, 0, nte);   // right after PID, on purpose
    },
  },

  // -------------------------------------------------------------------------
  {
    id: "P12",
    name: "Guard a required field",
    why:
      "Collect EVERY missing field, not the first. An operator who has to " +
      "resubmit once per missing field stops telling you about them. And decide " +
      "per field whether missing means reject the message or stamp a default -- " +
      "those are very different promises to the receiver.",
    dtl:
      "<if condition='source.{PID:3.1}=\"\"'>\n" +
      "  <true><code><![CDATA[ $$$ThrowStatus($$$ERROR($$$GeneralError,\"PID-3.1 empty\")) ]]></code></true>\n" +
      "</if>\n" +
      "Parameter REPORTERRORS = 1 is what makes the failure visible in the trace.",
    run(msg) {
      const REQUIRED = ["MSH-3", "MSH-6", "PID-3.1", "PID-5.1", "PID-7", "PV1-2"];
      const missing = REQUIRED.filter((p) => msg.get(p) === "");
      if (missing.length) throw new Error(`Required fields empty: ${missing.join(", ")}`);
    },
  },
];

// ---------------------------------------------------------------------------
// Demo runner -- shows what each pattern actually did to a real message
// ---------------------------------------------------------------------------

function lines(raw: string): string[] {
  return raw.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
}

function show(p: Pattern, raw: string): void {
  console.log(`\n${"=".repeat(78)}\n${p.id}  ${p.name}\n${"=".repeat(78)}`);
  console.log(p.why.replace(/(.{1,76})(\s|$)/g, "$1\n").trimEnd());
  console.log(`\n--- IRIS DTL ---\n${p.dtl}`);

  const before = lines(raw);
  const msg = new Message(raw);
  let after: string[];
  try {
    p.run(msg);
    after = lines(msg.toString());
  } catch (e) {
    console.log(`\n--- result ---\nthrew: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  console.log(`\n--- result: ${before.length} segments in, ${after.length} out ---`);

  // When segments were added or removed, a line-by-line diff is a lie: every
  // line after the insertion point reports as changed. Say what moved instead.
  if (before.length !== after.length) {
    const count = (ls: string[]) =>
      ls.reduce<Record<string, number>>((a, l) => ((a[l.slice(0, 3)] = (a[l.slice(0, 3)] ?? 0) + 1), a), {});
    const b = count(before), a = count(after);
    const ids = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
    for (const id of ids) {
      const d = (a[id] ?? 0) - (b[id] ?? 0);
      if (d < 0) console.log(`  dropped  ${id} x${-d}`);
      if (d > 0) console.log(`  added    ${id} x${d}`);
    }
    return;
  }

  const changes: string[] = [];
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) {
      changes.push(`  - ${before[i]}`.slice(0, 130));
      changes.push(`  + ${after[i]}`.slice(0, 130));
    }
  }
  console.log(changes.length ? changes.join("\n") : "  (no visible change on this message)");
}

const args = process.argv.slice(2);
const wanted = args.find((a) => /^P\d+$/i.test(a));
const file = args.find((a) => a.endsWith(".hl7")) ?? join(import.meta.dir, "sample.hl7");
const raw = readFileSync(file, "utf8");

const chosen = wanted ? PATTERNS.filter((p) => p.id.toLowerCase() === wanted.toLowerCase()) : PATTERNS;
if (chosen.length === 0) {
  console.error(`No pattern "${wanted}". Have: ${PATTERNS.map((p) => p.id).join(" ")}`);
  process.exit(1);
}
console.log(`Message: ${file}`);
for (const p of chosen) show(p, raw);
