# hl7-bench

A portable HL7 v2 transformation bench. No installer, no admin rights, no
service, no container. One `bun.exe` and four files.

Built for the workstation problem every hospital interface engineer knows: the
machine where you actually do the work is the machine where you are not allowed
to install anything. This runs out of a user folder.

```
stdin   <- raw HL7        stdout -> transformed HL7
stderr  -> diagnostics    exit 0  =  success
```

That is the whole interface. Anything that can spawn a process can drive it.

---

## What it is and is not

**Is:** a real transform loop. Write the interface as a spec, run it, see the
transformed message with every changed field highlighted, and generate the
engine's own transformation language from the same spec. The escape hatch is
still there: `transform()` receives the parsed message and may mutate it
directly, which is the contract Mirth taught you.

**Is not:** an interface engine. There is no channel, no queue, no listener, no
persistence. It transforms one message and exits. If you need routing and
delivery, you need an engine; this is the bench you use *before* you get to one,
or when the engine you need cannot be installed where you are sitting.

It is also not a substitute for a vendor's own transformation language. If you
are learning InterSystems DTL, DTL only executes inside IRIS, and IRIS is a
server install. Learn the language on a machine that can run it. Use this where
that machine is not available.

---

## Two ways to run it

### GUI

```powershell
bun gui.ts
```

Opens `http://127.0.0.1:7317`. Message on the left with `stderr` under it, the
spec in the middle as a form, and on the right the transformed message with
changed fields highlighted, the generated ObjectScript, the mapping document,
the source inventory, and the `transform.ts` that is about to be written.

The middle column is the spec, not code. There is no JavaScript pane, because
the artifact you are after is ObjectScript and typing one language to produce
another is the thing this design removes. Every kind in `spec.ts` has a form,
and the right column recomputes as you type without touching disk, so the
ObjectScript tab answers "what does this become in IRIS" while you are still
deciding what the interface does.

`Copy segments to spec`, on the Message in header, reads the message in front of
you and lists the segments it found. Tick some, press `Add to spec`, and each
becomes a block with one `copy()` row per field that is populated in any
occurrence of it. A segment that appears more than once gets a `repeat`. Rows
you already have are left alone, so a second run adds only what the message
grew. It is a first draft: every row is a straight copy, and the lookups, the
control id and the deletions are still yours.

`Ctrl+Enter` validates, rewrites the spec literal in `transform.ts`, and runs
it. A spec that does not validate is not written. Everything above and below
the literal survives byte for byte, comments inside it do not, and the first
write of a session leaves a `transform.ts.bak`.

`draft every` in the header is autosave, and it is deliberately not a save. On
the interval you pick, off / 1 / 5 / 15 minutes, the browser posts the spec to
`logs/autosave/transform.draft.json` and nothing else happens: `transform.ts` is
not touched, the `.bak` is not spent, and no `bench.ts` run is triggered. If the
laptop dies with unsaved work, the next load offers it back. A real save clears
it. The message pane is never in that file, because a timer copying a live
message to disk every few minutes is an exposure nobody asked for. Your choice
of interval is remembered per browser.

**copy**, on the right of the tab bar, copies the visible tab. `Ctrl+C` does the
same when the browser would otherwise copy nothing: a real selection still wins,
and so does a focused input, so `Ctrl+C` inside a spec field behaves as it always
did. The ObjectScript tab is the one this is for. That class exists to be pasted
into Studio, and a drag-selection that stops one line short of the closing brace
produces a class that will not compile for a reason nothing on screen explains.

**Both message panes tell you where you are.** Put the caret anywhere in the
message on the left and the pane heading reads back the position: `PV1-7[2].1
· PV1 #1 of 1 · line 5`. Hover a field on the right and the same label
appears in a tooltip. Repetition and component are shown only when the field
actually has them, so a path that is all ones stays short. The MSH line is
handled the way HL7 defines it rather than the way it splits: `MSH-1` **is** the
field separator and `MSH-2` **is** the encoding characters, so everything after
the segment id sits one slot left of a naive pipe count, and `MSH-2` is never
broken into components because it is the field that defines what a component
separator even is. Counting pipes by eye is how a mapping ends up one field off.

Bound to loopback deliberately. Binding a public interface is what triggers the
Windows Firewall prompt you cannot approve without admin, and this endpoint
writes a file and executes it. It has no business listening anywhere else.

### Notepad++ (with [PipeHat](https://github.com/iacsha/PipeHat-npp))

This repo ships `hl7-bench.provider`, so installing is a copy:

```
<Notepad++>\plugins\config\providers\hl7-bench\
```

Drop `bun.exe` in the same folder and restart Notepad++. Nothing to edit. The
provider file uses `${DIR}` for its own location, so it contains no username and
works wherever you unzip it. Uninstall by deleting the folder.

`Ctrl+Alt+Shift+X` picks the provider, `Ctrl+Alt+Shift+A` re-runs it. The result
lands in the other view and PipeHat diffs it field by field.

If you would rather declare it by hand, `PipeHat.providers` still works and
takes precedence over any drop-in that reuses the same name.

### Or neither

```powershell
Get-Content message.hl7 -Raw | bun bench.ts
```

---

## Setup

1. Download `bun-windows-x64.zip` from [bun releases](https://github.com/oven-sh/bun/releases).
2. Extract `bun.exe` anywhere writable. `C:\Users\<you>\tools\` is fine.
3. Clone or unzip this repo next to it.
4. `bun test`, 422 tests, no network, no dependencies.

Nothing is installed. Nothing touches the registry. Notepad++ has an official
portable build too, so editor, plugin, and bench all fit on a stick.

If your site blocks unsigned executables from user-writable folders, this
approach will not work and no amount of arguing with the policy will change
that. The same bench logic ports to PowerShell if you need a zero-download
option.

---

## Writing a transform

```ts
import type { Message } from "./hl7";

export function transform(msg: Message): void {
  msg.set("MSH-3", "BENCH");
  msg.set("PID-5.1", msg.get("PID-5.1").toUpperCase());
  msg.set("PID-8", msg.get("PID-8") === "M" ? "MALE" : "OTHER");

  for (const obx of msg.all("OBX")) {
    obx.set("OBX-15.1", "LAB");
  }
}
```

Paths are `SEG-F`, `SEG-F.C`, `SEG-F.C.S`, with an optional repetition index.
`PID-3(2).5` is the identifier type of the second repetition of PID-3.
`msg.seg(id)` gets the first occurrence, `msg.all(id)` gets every one.

Throwing aborts the run and puts the error, with the line number in your file,
in front of you:

```
transform() threw:
Error: No ZZZ segment in this message
    at transform (transform.ts:3:7)
```

That is the feedback loop. Break things on purpose while it is cheap.

---

## The spec is the interface

Writing the transform as code works, and for a one-off it is the shortest path.
It stops working the moment the same interface has to exist in three places at
once: running on the bench, written down for the receiving team, and built in
the engine. Three copies, hand-synced, with nothing checking that they agree.

So the interface is declared as data, and everything else is derived from it.

```ts
export const spec: Spec = {
  name: "Registration ADT to downstream",
  gate: {
    path: "MSH-9.2",
    permit: { A01: "A28", A08: "A31" },
    require: [{ path: "MSH-9.1", equals: "ADT" }],
  },
  iris: {
    className: "Demo.DTL.AdtToDownstream",
    sourceDocType: "2.3:ADT_A01",
    targetDocType: "2.3.1:ADT_A05",
  },
  tables: { Department: { "S45": "2^TEST DEPT" } },
  blocks: [
    {
      id: "PID",
      rows: [
        { target: "PID-3", from: firstOf("PID-4", "PID-3"), label: "MRN", required: true },
        { target: "PID-5", from: copy("PID-5"), label: "Patient Name", required: true },
        { target: "PID-19", from: copy("PID-19"), via: [stripChars("- ")], label: "SSN" },
      ],
    },
    {
      id: "IN1",
      group: "INSURANCEgrp",
      repeat: { over: "IN1", skipWhenEmpty: "IN1-4", max: 3 },
      rows: [
        { target: "IN1-1",  from: counter() },
        { target: "IN1-4",  from: copy("IN1-4"), label: "Insurer", required: true },
        { target: "IN1-22", from: counter(), label: "Coverage Priority" },
      ],
    },
  ],
};
```

That one object drives everything else:

| | |
|---|---|
| `bun bench.ts` | runs it, and the message comes out |
| `bun check.ts` | proves it against golden files |
| `bun trace.ts` | the field table you hand the receiving team |
| `bun reads.ts` | every source path that came back with nothing |
| `bun emit.ts` | the IRIS DTL class, ObjectScript and all |
| `bun emit.ts process` | a business process template that calls it |
| `bun emit.ts tables` | the lookup table rows as an IRIS import file |

Change a row and all of them change together, or none of them do. There is no
second copy to keep in step.

### Why data and not closures

A rule could just as easily be a function. It is a tagged union instead, so the
spec stays serializable: the GUI can edit it as a form rather than as code, and
a backend for a second engine is a pure function over the same object.

There is deliberately no `raw(javascript)` escape hatch inside a spec. The
moment one exists, the JavaScript side can express things the ObjectScript side
cannot, which is precisely the split this design closes. When the vocabulary is
short of something, the vocabulary grows.

### The completeness test

`spec.test.ts` walks `SOURCE_KINDS` and `STEP_KINDS` and asserts that **every**
backend handles **every** kind. Add a source kind, teach it to the runner only,
and the build fails naming the backend you forgot. A vocabulary that one backend
understands and another silently ignores is the failure this design exists to
prevent, so it is a compile-time failure rather than a production one.

### What is in the vocabulary

| | |
|---|---|
| Sources | `copy`, `literal`, `firstOf`, `lookup`, `counter`, `event`, `pickRepeat`, `fromFirst`, `todo` |
| Steps | `date8`, `truncate`, `upper`, `stripDelims`, `stripChars`, `defaultTo` |
| Unmapped branches | `blank()`, `passthrough()`, `constant(v)`, `{ error: true }` |
| Block controls | `group`, `repeat.over`, `repeat.skipWhenEmpty`, `repeat.max` |

### Things it says out loud

Every one of these is silent in a hand-written transform, and each one has cost
somebody a go-live:

- **An empty lookup table returns the unmapped branch for every message.** It
  looks exactly like a working lookup. Both backends flag it on every run.
- **Assigning an empty value creates the field.** That is what `<assign>` does
  in a DTL, so the bench does it too. Skipping empty assigns produces a shorter
  segment than the engine, and a receiver reading by ordinal position sees a
  different message than the one that was signed off.
- **Set ids number by output ordinal, not source repeat index.** A skipped
  first coverage would otherwise deliver a lone `IN1` numbered 2, with priority
  2 and no priority 1.
- **`firstOf` says which path it actually used.** "We map PID-4" and "PID-4 is
  empty at this site" are different statements.
- **Skipped and capped repetitions are counted.** Nothing else on the wire shows
  that three coverages arrived and one was dropped.
- **`||` binds looser than `&&`**, so the emitted routing condition parenthesises
  the trigger group. Unparenthesised, one requirement term lets everything else
  through.

### Generating the ObjectScript

```powershell
bun emit.ts > MyTransform.cls        # diagnostics go to stderr, so the file stays clean
bun emit.ts iris                     # same thing, named explicitly
bun emit.ts process > MyProcess.cls  # a business process that calls the DTL
bun emit.ts tables > Tables.xml      # the lookup rows, as an IRIS import file
```

The emitter cannot check four things for you, and says so in the class header:
the DocTypes against your own schema browser, whether a target segment sits
inside a group, whether every lookup table has rows, and the routing rule.

A wrong DocType **fails closed**: paths stop resolving, the output comes out
empty, and nothing useful reaches the log. Same for a grouped segment addressed
without its group. `target.{IN1(1):2}` resolves to nothing where
`target.{INSURANCEgrp(1).IN1:2}` works, with the same silence.

### The fingerprint in the header

Both emitted classes carry the same twelve-character hash of the spec:

```
/// Spec fingerprint: 9a62d97231a1
```

`bun emit.ts` prints it to stderr as well. If the string in the class you are
reading in the portal does not match the one the bench prints, the namespace is
running an older compile than the mapping you are looking at, and every minute
spent debugging the mapping is wasted. That is the whole point of it. It covers
the spec, including labels and notes, so a cosmetic edit moves it too. It does
**not** cover the class file: hand-edit the generated `.cls` and the fingerprint
becomes a lie.

### The business process is a TEMPLATE, and says so

The DTL header says *proven on the bench* and has earned it: real messages went
through that mapping and you read the output. `bun emit.ts process` has executed
nothing, because there is no production on a laptop, so it says TEMPLATE in its
first line instead.

It emits one shop's shape: a custom `Ens.BusinessProcess` that clones the
request, calls the DTL, and dispatches by config item name with
`SendRequestAsync`. Plenty of sites use a routing engine with a rule whose
transform field names the DTL and never write a process class at all. If that is
you, read it and take the parts you need.

`iris.process.sendTo` is the config item name as the production spells it, and
it is the one fact in the whole spec that cannot be derived from the mapping. A
name that does not resolve fails at run time, per message, not at compile time.

Note the gate then exists in two places: the routing rule condition the DTL
header prints, and the filter in the process. That is deliberate. A gate that
exists in neither is the failure that matters, and it is silent.

### Lookup tables as a loadable file

Lookup tables are namespace **data**, not code. They do not travel with a class
export and they do not travel with a production deployment, which is how a
transform arrives in production correct and translates nothing.

```powershell
bun emit.ts tables > Tables.xml           # every table in the spec
bun emit.ts tables --table Facilities     # just the one
```

Import it in the portal at **Interoperability > Configure > Data Lookup
Tables**, or with `##class(Ens.Util.LookupTable).%Import("Tables.xml")`. Verify
the document shape once against your own version by exporting an existing table
and diffing.

An empty key is refused. A control character anywhere is refused, because the
import error names a line number in the file rather than the row that caused it.
An empty **value** is warned about and still written: `Lookup` returns your
default for a blank value exactly as it does for a missing key, so the row
behaves as if it is not there, which in an allowlist is a permitted code being
silently refused.

### Building a big table from a spreadsheet

Facility tables, department tables, provider crosswalks. The ones that arrive as
four hundred rows in Excel and are otherwise retyped by hand.

```powershell
Get-Content facilities.csv -Raw | bun tables.ts Facilities
bun tables.ts Facilities --module < facilities.csv > tables.facilities.ts
bun tables.ts Sex --key 2 --value 3 --delim tab < codes.txt
```

It writes TypeScript, not XML, on purpose. Straight to XML is one step shorter
and puts the rows somewhere the bench cannot read, so `lookup()` on the bench
would translate nothing while the same interface in IRIS translated fine.
`spec.tables` stays the single source and `bun emit.ts tables` makes the import
file from it.

Keys and values are trimmed and **the count is reported**. A trailing space in a
key is invisible in every editor and in the portal, survives a copy-paste, and
makes `Lookup` miss. It is the commonest defect in a hand-built table. `--no-trim`
if your keys really do carry spaces.

The same key twice with the same value is a warning. The same key twice with
**different** values is a refusal: that is two people who disagree about what a
code means, and picking one silently is how the wrong one reaches production.

### The empty-read report

```powershell
Get-Content real.hl7 -Raw | bun reads.ts
bun reads.ts --strict < real.hl7     # exit 1 if a block is at risk
```

The emitted class sets `IGNOREMISSINGSOURCE = 1`, which turns a source path IRIS
cannot resolve into a skipped `<assign>` rather than an error. Skip **every**
assign in a block and the target segment is never created, so a whole section of
the mapping disappears with no error, no warning, and nothing in the Visual
Trace to look at. The delivered message is shorter, parses cleanly, and looks
fine. Two days on a live build, four seconds here.

Two headlines, and they are not the same problem:

| | |
|---|---|
| **AT RISK** | every path the block reads belongs to a segment that is not in this message. This is the shape that creates no segment at all |
| **DELIVERS EMPTY** | the paths resolved and every row came back blank. IRIS still creates the segment, and the receiver gets an empty one |

It cannot see groups. The bench message model is flat, so a block with the wrong
`group` name reads perfectly here and writes nowhere in IRIS. That is the exact
failure this report is named after and the one case it will tell you is fine.
Read the group name off your schema browser.

### A second engine later

`emit/iris.ts` is the only backend shipped, because IRIS is the engine in front
of us. `emit.ts` dispatches on a name and the completeness test already knows
how to fail a half-finished backend, so adding one is a new file and a new row
in a table, not a rewrite.

---

## The MSH off-by-one

`MSH-1` **is** the field separator and `MSH-2` **is** the encoding characters, so
on the MSH line every field sits one slot left of where a naive split puts it.
Get this wrong and you silently shift message type, control ID, and version,
and it reads fine right up until a receiver rejects everything.

`hl7.ts` handles it and `hl7.test.ts` locks it down. `MSH-2` is additionally
never split by the delimiters, because it is the field that *defines* them;
splitting it returns `^` instead of `^~\&`. The tests caught that one on the
first run of this repo.

Delimiters are read from each message rather than assumed, so a feed that
declares `!` as its field separator parses correctly.

---

## Flat-record extraction: `toolbox.ts`

The spec above targets HL7 out. `toolbox.ts` targets everything else: a CSV, a
billing record, a REST payload, anything where the destination is a flat list of
named fields rather than segments. Same idea, different shape, and it does the
one thing the spec deliberately does not, which is turn **one message into N
records**.

Use `spec.ts` when the output is HL7 and an engine has to run it. Use this when
you are pulling a flat extract out of a message, or reverse-engineering a feed
before you know what the interface is yet.

```ts
import { Message } from "./hl7";
import { mapEach, renderTrace, date8, upper, signed, join, type Rule } from "./toolbox";

const rules: Rule[] = [
  { to: "Facility",      from: "MSH-6.1", required: true },
  { to: "AccountNumber", from: "PID-3.1", required: true },
  { to: "LastName",      from: "PID-5.1", via: [upper()], required: true },
  { to: "FirstName",     from: join(" ", "PID-5.2", "PID-5.3") },
  { to: "ServiceDate",   from: "FT1-4",   via: [date8()], required: true },
  { to: "ChargeCode",    from: "FT1-7.1", required: true },
  { to: "Quantity",      from: "FT1-10",  via: [signed("FT1-6", ["CH"], ["CG","R"])] },
];

console.log(renderTrace(mapEach(msg, "FT1", rules)));
```

```
--- record 1 of 2 ---
TARGET           SOURCE                       RAW             STEPS                        FINAL
---------------  ---------------------------  --------------  ---------------------------  -----------
Facility *       MSH-6.1                      RECVFAC                                      RECVFAC
AccountNumber *  PID-3.1                      MRN9                                         MRN9
LastName *       PID-5.1                      doe             uppercase                    DOE
FirstName        join(" ", PID-5.2, PID-5.3)  john q                                       john q
ServiceDate *    FT1-4                        20260811093000  date8 (YYYYMMDD)             20260811
ChargeCode *     LAB001                       LAB001                                       LAB001
Quantity         FT1-10                       2               signed by FT1-6 (+CH -CG/R)  2
```

Rules are data, so they print. That table is the artifact you hand an analyst.

### `mapEach` is the point

`mapEach(msg, "FT1", rules)` maps once per repeating segment. A DFT with four
FT1 segments is four charges; an ORU with twenty OBX is twenty results. If your
target is one flat record, **one message legitimately becomes N records**, and
a mapping written against the first segment drops the rest without a word.

The record count in the output tells you immediately whether you are looking at
a 1:1 or a 1:N interface. That question is cheap to ask here and expensive to
discover in production.

### `signed` refuses to guess

Signing a quantity off a transaction type is usually written:

```ts
qty = type === "CH" ? q : "-" + q;   // don't
```

Every type that is not `CH` now becomes a credit: blank, unknown, a new code the
vendor shipped last month, a typo at the sender. Flip the branches and unknown
types silently become charges instead. Two feeds into one billing system with
opposite defaults is not hypothetical.

`signed(typePath, positive[], negative[])` takes both lists explicitly and
throws on anything in neither. If you want a default, say so with `defaultTo`
before it, where the next reader can see it. The same reasoning is why `lookup`
makes you pass `"passthrough" | "blank" | { error: true }` rather than picking
one for you.

### What is in there

| | |
|---|---|
| Runners | `mapOne`, `mapEach` |
| Getters | `literal`, `join`, `coalesce`, `compute` |
| Steps | `date8`, `truncate`, `upper`, `stripDelims`, `defaultTo`, `lookup`, `lookupChain`, `signed` |
| Output | `renderTrace`, `toPipeDelimited` |

`required: true` collects **every** missing field, not the first one. An
operator who has to resubmit a record once per missing field will stop telling
you about them.

## Logs

There are two different logs here and they answer two different questions. One
is this bench writing files on your machine. The other is the generated class
writing to the IRIS Event Log on a server. They share nothing.

### What the bench writes

Off by default, and that is deliberate. The contract is stdin in, stdout out,
stderr for diagnostics, nothing installed and nothing left behind. A tool that
starts dropping files because you ran it breaks that quietly for anyone piping
it out of PipeHat or a script.

| `HL7_BENCH_LOG` | |
|---|--|
| unset | nothing is written |
| `summary` | one line per event in `logs/hl7-bench.log`: timestamp, tool, spec, gate decision, fields written, missing count, how many notes, result |
| `full` | the same line, plus every diagnostic note verbatim |

`HL7_BENCH_LOG_FILE=<path>` moves the bench log somewhere else. `run.ts`,
`bench.ts`, `check.ts`, `emit.ts` and `trace.ts` all write to it.

**The split is about PHI, not about verbosity.** Most notes are paths and
counts. Two are not. An unmapped lookup names the source value that missed the
table, and a gate refusal on a `require` rule names whatever that rule read.
Nothing stops a table or a rule being keyed on `PID-3`, and then the log has
MRNs in it. `summary` never writes note text. `full` is a choice you make.
`logs/` is gitignored either way, which is a seatbelt and not permission.

The GUI keeps its own log, `logs/authoring.log`, and that one is **on by
default**, because `Ctrl+Enter` already rewrites `transform.ts` and leaves a
`.bak`. It records what happened, not what you wrote: spec name, whether it
validated, blocks and rows before and after, saved or not, and the bench exit
code. The spec content itself is what git is for. `HL7_BENCH_LOG=off` silences
it along with everything else.

An autosave tick lands there too, as `action=draft saved=draft-only`, which is
how you tell a draft from a save when reading the file back.

### What the generated class writes

That is a property of the interface, so it lives in the spec:

```ts
iris: {
  sourceDocType: "2.3:ADT_A01",
  targetDocType: "2.3.1:ADT_A05",
  log: "warn",              // "off" | "warn" | "trace", default "warn"
},
```

`warn` emits `$$LOGWARNING` at exactly two places: a lookup code with no row in
its table, and a `required` target that came out empty after the assign. Both
are the questions you actually get asked at 2am. `trace` adds `$$TRACE` per
assigned field, which shows up in Visual Trace when tracing is on for that host.
`off` emits neither, and skips `Include Ensemble` entirely.

Gate refusals are not in there on purpose. The gate is a routing rule, so a
refused message never reaches the transform at all. `bun emit.ts` prints the
rule condition above the class.

One thing to know before you leave it on `warn`: a sender that routinely emits
an unmapped code writes one Event Log warning **per message** until the table is
fixed. That is usually what you want, right up until it is not.

## Files

| File | |
|------|--|
| `transform.ts` | **the file you edit.** Holds the spec |
| `spec.ts` | the vocabulary: source kinds, step kinds, `validate` |
| `run.ts` | the runner. Walks the spec and produces the message |
| `trace.ts` | the same walk, rendered as the mapping document |
| `emit.ts` | picks a backend and an artifact, and writes it |
| `emit/iris.ts` | the IRIS DTL backend |
| `emit/process.ts` | the business process template backend |
| `emit/lookup.ts` | `spec.tables` as an IRIS lookup table import file |
| `tables.ts` | a spreadsheet becomes a `spec.tables` entry |
| `reads.ts` | every source path that resolved to nothing |
| `fingerprint.ts` | the spec hash both emitted classes carry |
| `hl7.ts` | parse, serialize, path lookup |
| `bench.ts` | the stdin/stdout wrapper |
| `check.ts` | the golden gate |
| `serialize.ts` | prints a spec back into `transform.ts`, so the GUI can save |
| `gui.ts` + `gui.html` | the local browser spec editor |
| `toolbox.ts` | flat-record extraction and its field trace |
| `log.ts` | the log switch. Off unless `HL7_BENCH_LOG` says otherwise |
| `*.test.ts` + `emit/*.test.ts` | 422 tests across 13 files |
| `sample.hl7` | synthetic ADT^A01 |
| `classify.ts` | diff what you have against what you want |
| `patterns.ts` | twelve moves, each with its IRIS DTL |
| `WORKFLOW.md` | **start here.** New interface to IRIS, eight steps |
| `METHOD.md` | the five questions, path syntax, the traps |

## PHI

`sample.hl7` is synthetic. `.gitignore` excludes every other `.hl7` and a
`messages/` directory, because committed PHI is not recoverable after the fact.
Scrub before you share. [PipeHat](https://github.com/iacsha/PipeHat-npp) has a
fail-closed scrubber if you need one.

## License

MIT.
