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

Opens `http://127.0.0.1:7317` — message on the left, transform below it, output
on the right with changed fields highlighted, `stderr` underneath. `Ctrl+Enter`
runs. Edits save straight back to `transform.ts`, so the transform you tuned in
the browser is the one every other caller gets.

Bound to loopback deliberately. Binding a public interface is what triggers the
Windows Firewall prompt you cannot approve without admin, and this endpoint
writes a file and executes it — it has no business listening anywhere else.

### Notepad++ (with [PipeHat](https://github.com/iacsha/PipeHat-npp))

This repo ships `hl7-bench.provider`, so installing is a copy:

```
<Notepad++>\plugins\config\providers\hl7-bench\
```

Drop `bun.exe` in the same folder and restart Notepad++. Nothing to edit — the
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
2. Extract `bun.exe` anywhere writable — `C:\Users\<you>\tools\` is fine.
3. Clone or unzip this repo next to it.
4. `bun test` — 187 tests, no network, no dependencies.

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

Paths are `SEG-F`, `SEG-F.C`, `SEG-F.C.S`, with an optional repetition index —
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

That one object drives four things:

| | |
|---|---|
| `bun bench.ts` | runs it, and the message comes out |
| `bun check.ts` | proves it against golden files |
| `bun trace.ts` | the field table you hand the receiving team |
| `bun emit.ts` | the IRIS DTL class, ObjectScript and all |

Change a row and all four change together, or none of them do. There is no
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
```

The emitter cannot check four things for you, and says so in the class header:
the DocTypes against your own schema browser, whether a target segment sits
inside a group, whether every lookup table has rows, and the routing rule.

A wrong DocType **fails closed**: paths stop resolving, the output comes out
empty, and nothing useful reaches the log. Same for a grouped segment addressed
without its group — `target.{IN1(1):2}` resolves to nothing where
`target.{INSURANCEgrp(1).IN1:2}` works, with the same silence.

### A second engine later

`emit/iris.ts` is the only backend shipped, because IRIS is the engine in front
of us. `emit.ts` dispatches on a name and the completeness test already knows
how to fail a half-finished backend, so adding one is a new file and a new row
in a table, not a rewrite.

---

## The MSH off-by-one

`MSH-1` **is** the field separator and `MSH-2` **is** the encoding characters, so
on the MSH line every field sits one slot left of where a naive split puts it.
Get this wrong and you silently shift message type, control ID, and version —
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

## Files

| File | |
|------|--|
| `transform.ts` | **the file you edit.** Holds the spec |
| `spec.ts` | the vocabulary: source kinds, step kinds, `validate` |
| `run.ts` | the runner. Walks the spec and produces the message |
| `trace.ts` | the same walk, rendered as the mapping document |
| `emit.ts` | picks a backend and writes its transformation language |
| `emit/iris.ts` | the IRIS DTL backend |
| `hl7.ts` | parse, serialize, path lookup |
| `bench.ts` | the stdin/stdout wrapper |
| `check.ts` | the golden gate |
| `gui.ts` + `gui.html` | the local browser UI |
| `toolbox.ts` | flat-record extraction and its field trace |
| `hl7.test.ts` + `toolbox.test.ts` + `spec.test.ts` | 187 tests |
| `sample.hl7` | synthetic ADT^A01 |
| `classify.ts` | diff what you have against what you want |
| `patterns.ts` | twelve moves, each with its IRIS DTL |
| `WORKFLOW.md` | **start here.** New interface to IRIS, eight steps |
| `METHOD.md` | the five questions, path syntax, the traps |

## PHI

`sample.hl7` is synthetic. `.gitignore` excludes every other `.hl7` and a
`messages/` directory, because committed PHI is not recoverable after the fact.
Scrub before you share — [PipeHat](https://github.com/iacsha/PipeHat-npp) has a
fail-closed scrubber if you need one.

## License

MIT.
