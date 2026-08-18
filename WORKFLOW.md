# From a new interface to IRIS, start to finish

The order of operations for building a transform yourself. Eight steps.
Nothing here needs a second person or a chat window.

`METHOD.md` is the doctrine, the five questions and the traps. This file is the
button-pressing. Read METHOD.md once, keep this one open while you work.

One thing to know before you start: **nothing here figures out the mapping for
you.** Steps 1 through 5 are you deciding what the interface does, in JavaScript,
where the loop is fast and a golden file can prove you right. Step 6 turns that
settled decision into an IRIS DTL class. `dtl.ts` writes the ObjectScript, but
only from a spec you hand it, and it refuses to guess at the rows it cannot
express. The leverage is that the mapping is already correct and already proven
before any ObjectScript exists. Not code generation.

---

## Step 0. Get the current tools onto the work machine

The bench is source files plus a bun binary. No install, no admin, no service.

Files that matter:

```
hl7.ts               the parser. Never edit.
toolbox.ts           the mapping helpers. Rarely edit.
transform.ts         YOUR WORK. One interface at a time.
bench.ts             stdin to stdout runner
gui.ts + gui.html    the browser editor, 127.0.0.1:7317
check.ts             the golden gate
classify.ts          the in-versus-want diff
patterns.ts          twelve moves, each with its IRIS DTL
dtl.ts               the DTL emitter, plus a worked example spec
METHOD.md            the doctrine
WORKFLOW.md          this file
messages\            gitignored. Real messages live here and nowhere else.
```

Copy the whole folder. The PipeHat provider directory on a work box is:

```
%APPDATA%\Notepad++\plugins\config\providers\hl7-bench\
```

Confirm the copy landed by running the tests, not by looking at the folder:

```powershell
bun test
```

Anything other than green means you are looking at a different copy than the one
you edited.

### One folder per interface

Do not edit a live interface's transform in place to start a new one. Copy the
folder:

```powershell
Copy-Item -Recurse C:\opencode\hl7-bench C:\opencode\bench-<newinterface>
```

`transform.ts` holds exactly one interface because `bench.ts` and the GUI both
call the single exported `transform()`. Two interfaces in one file means an `if`
on message type at the top, and that `if` grows an else branch nobody tested.
Separate folders instead.

That split also keeps interface work out of this repo. `messages\`,
`mapping.*.ts` and `dtl.*.ts` are gitignored for the same reason: the bench and
its patterns are general, a specific feed's mapping is not.

---

## Step 1. Get the two messages on disk

You need two files. Everything downstream comes from them.

```
messages\<name>.in.hl7      what the sending system actually emits
messages\<name>.want.hl7    what the receiver says it wants
```

The `.in` file must be a real message off the interface, not one you typed. The
`.want` file comes from the receiver's spec or their sample. If the receiver
gave you a spec table and no sample, hand-build the `.want` from the table, and
write down that you did, because a hand-built want file is your reading of their
spec rather than their statement of it.

Both files: no BOM, no trailing blank lines, CR or CRLF either way. If you saved
from PowerShell with `>` you have a BOM. Use `-o` on `bench.ts` or save from
Notepad++ as UTF-8 without BOM.

**Real messages only ever go in `messages\`.** That folder is gitignored.
`sample.hl7` is the one tracked `.hl7` file and it is synthetic. Pasting a real
message into the GUI and pressing Save with no filename argument writes PHI into
the one file that gets committed. Always name the file:

```powershell
bun gui.ts messages\newthing.in.hl7
```

---

## Step 2. Classify the diff

This is the step that sizes the job. Do it before you have an opinion.

```powershell
bun classify.ts messages\<name>.in.hl7 messages\<name>.want.hl7
```

It reports every difference sorted into five kinds and prints a sizing line.

Read the sizing line and believe it. A diff that comes back as segment set is a
whitelist and roughly seven lines of DTL. A diff full of field value and code
translation is a mapping document and weeks, because every code translation is a
table somebody has to fill in and a decision about what happens to codes that
are not in it.

Every line it prints is a **question to ask**, not a fact to encode. Two
messages cannot tell you whether a difference is a rule or an accident of this
one sample. Only the sending and receiving analysts can. Take the output into
that call and go down it line by line.

That call is where a real interface picks up its lookup tables, its out-of-scope
list, and the discovery that some field both sides assumed was standard carries
a site-local flag instead.

---

## Step 3. Pick the patterns

```powershell
bun patterns.ts
```

Twelve patterns. Each prints why you reach for it, the trap that comes with it,
a working JavaScript body, and **the IRIS DTL that does the same job**.

```
P1   Gate on trigger event                (routing rule, not a DTL)
P2   Segment whitelist
P3   Segment blacklist
P4   Stamp a literal
P5   Copy field to field
P6   Conditional set
P7   Code lookup with an explicit unmapped branch
P8   Walk every repeating segment
P9   Walk every repetition of a field
P10  Date and time reshaping
P11  Add a segment that was not there
P12  Guard a required field
```

Run one on your own message to watch it work:

```powershell
bun patterns.ts P7 messages\<name>.in.hl7
```

Write down which patterns your diff needs. That list is your build plan, and it
is also your DTL outline, because each pattern maps onto a `dtl.ts` source kind
in step 6.

Almost every ADT interface is these twelve. When you hit something that is not
here, it is usually two of them composed.

---

## Step 4. Write `transform.ts` in JavaScript

Open the editor:

```powershell
bun gui.ts messages\<name>.in.hl7
```

Browser at `http://127.0.0.1:7317`. Left pane is the message, right pane is
`transform.ts`, bottom is output and stderr.

**The code pane is JavaScript.** It writes straight into `transform.ts` and runs
it with bun. Pasting an ObjectScript class in there gives you a bun parse error
naming the first token of the class line, and nothing else. That is the only
thing that error ever means. ObjectScript comes later and it goes in Studio, not
here.

Write in this order. It is not a style preference, it is the order that keeps
each step's assumptions true for the next:

1. **Gate first.** Refuse messages you do not handle, before doing any work.
2. **Structure second.** Which segments exist in the target.
3. **Values third.** Field by field.
4. **Guards last.** Check the things that must be non-empty, and say so loudly.

Path syntax is in `METHOD.md` and is the same shape as the DTL:

```
PID-3          field
PID-5.1        component
PID-3(2).5     repetition 2, component 5
MSH-9.2        trigger event
```

Two rules that save the most pain:

- **Every lookup needs a stated unmapped branch.** Blank, passthrough, or throw.
  Pick one on purpose. An unmapped code silently becoming an empty field is the
  bug you find six weeks later in a claims report.
- **Never gate on `if/else`.** Use a table, a `PERMITTED` set keyed by trigger
  event. An if/else grows an implicit everything-else branch, and that branch is
  how an A03 discharge reaches the receiver as a registration.

Use stderr for anything a human needs to read. It shows in the GUI's bottom
pane, and `check.ts` mutes it so your PASS lines stay readable:

```js
process.stderr.write("PV1-3 empty: department table has no row for X\n");
```

Iterate until the output pane matches your `.want` file by eye.

---

## Step 5. Lock it with a golden file

Eyeballing is not proof. Turn it into a test:

```powershell
bun bench.ts -o messages\<name>.want.hl7 < messages\<name>.in.hl7
bun check.ts
```

Only do that generate-the-want-from-the-output step once you have confirmed the
output is right. Otherwise you have frozen a bug.

`check.ts` needs no registration. Convention only:

```
<name>.in.hl7      +  <name>.want.hl7    = a case that must match
<name>.reject.hl7                        = a message that must be REFUSED
```

**Add at least one reject case.** An interface that "permits two events" is an
untested adjective until you have watched it refuse the third. Save a message
your gate should turn away as `<name>.reject.hl7` and confirm `check.ts` reports
it as refused.

From here on, `bun check.ts` is your regression suite. Run it after every edit.
Green means you changed what you meant to change and nothing else.

---

## Step 5b. Print the spec trace

Before you write any ObjectScript, produce the document that says what the
interface does, field by field, in the receiver's language.

Copy the `mapping.*.ts` shape from `toolbox.ts`'s header comment into
`mapping.<interface>.ts` and write two rule lists: one against the source paths,
one against the target paths. Run it:

```powershell
bun mapping.<interface>.ts messages\<name>.in.hl7
```

That prints source path, target path, raw value, transformation steps, final
value, plus a MISSING REQUIRED list, once per audience. The inbound MISSING list
is the conversation you owe the sending system. The delivered MISSING list is
the one you owe the receiver. They are rarely the same list. Attach both to the
build ticket.

Run it against **two parses of the message, not one.** If `transform()` builds a
fresh target, reading the same `Message` object before and after gives you the
transformed message twice and a trace that agrees with itself for the wrong
reason.

---

## Step 6. Emit the ObjectScript

Now, and not before. The mapping is settled, the goldens are green, and the
questions have been asked. What is left is translation.

```powershell
bun dtl.ts                      # print the worked example
```

Copy `EXAMPLE` out of `dtl.ts` into `dtl.<interface>.ts`, import `emitDtl` from
`./dtl`, and rewrite the rows straight off your step 5b trace, one row per line
of the table. Then:

```powershell
bun dtl.<interface>.ts > MyTransform.cls
```

The spec is data. Each row says where a target field's value comes from:

| Source | What it emits | Pattern |
|---|---|---|
| `copy("PID-3")` | a straight assign | P5 |
| `literal("VALUE")` | a quoted constant | P4 |
| `firstOf("PID-4", "PID-3")` | nested `$SELECT`, first non-empty | P6 |
| `lookup("Table", "PID-8", passthrough())` | `..Lookup` with a stated unmapped branch | P7 |
| `counter()` | the loop's output ordinal | P8 |
| `raw("...")` | ObjectScript verbatim, the escape hatch | any |
| `manual("why")` | a TODO comment and no assign | none |

`loops` handles repeating segments: `foreach` over the source, an emptiness
guard, and a counter that numbers by **output ordinal** rather than source
repeat index. That distinction matters. A message whose second IN1 is a shell
and gets skipped delivers a single coverage numbered `2` if you number from the
source, and a receiver reading priority ordinally sees a secondary with no
primary.

`manual()` is not a failure. It is the emitter refusing to fake a row it cannot
express, so the gap shows up as a TODO in the right place in the file rather
than as a silent hole you find at validation. Branching, string surgery and date
arithmetic all land there. Write those by hand, take the ObjectScript from the
pattern you noted in step 3.

Four things `dtl.ts` cannot know, and you must check before compiling:

**Version.** Your bench does not care about HL7 versions. IRIS does. Set
`sourceDocType` and `targetDocType` to the real schema names in your namespace,
and check them in the schema browser rather than assuming. A wrong DocType
**fails closed**: paths stop resolving, you get an empty message, and nothing
useful appears in the log. That failure mode is `iris-lab/recipes/18`, and it is
the single most common way an hour disappears.

**Grouped segments.** In some structures, segments sit inside groups. IN1 inside
`INSURANCE` means `target.{IN1(1):2}` resolves to nothing where
`target.{INSURANCEgrp(1).IN1:2}` works. Same fail-closed silence. Set `group` on
the loop when it applies. If a segment you assigned is missing from the output
and there is no error, this is why. Check the structure in the schema browser.

**`create='new'` versus editing the source.** If your bench transform builds a
fresh target, the DTL needs `create='new'`, which is the emitter's default. If
it edits the message in place, set `create: "copy"`. Mismatch here means fields
you never assigned show up in the output because they rode along from the
source.

**Lookup table rows.** A `$case` in ObjectScript needs a recompile every time a
code is added. `Ens.Util.LookupTable` does not, which is why the emitter uses
it. But an empty table returns the default for every message, and that looks
exactly like a working lookup. Populate the table before go-live and check the
row count.

---

## Step 7. Into IRIS Dev

1. Import the emitted `.cls` into Studio or VS Code, compile it.
2. Work down the TODO comments the emitter left. Nothing else in the file needs
   touching.
3. Build the routing rule. The gate from step 4 becomes a rule condition, for
   example `HL7.{MSH:9.2}` in `("A01","A08")`. It belongs in the rule, not in
   the DTL, so a message you do not handle is never delivered rather than
   delivered wrong.
4. Create the lookup tables and load their rows. Verify the row count.
5. Use the DTL editor's Test button with your `.in.hl7` pasted in. This is the
   fastest loop in IRIS and it does not need the interface running.

---

## Step 8. Prove IRIS matches the bench

The golden file is the referee.

1. Take the DTL Test output, or pull the delivered message out of the message
   viewer.
2. Save it as `messages\<name>.iris.hl7`.
3. Diff it against the golden:

```powershell
bun classify.ts messages\<name>.iris.hl7 messages\<name>.want.hl7
```

Empty diff means IRIS and the bench agree, and both agree with the receiver's
spec. Any difference is a DTL bug with a named field attached, rather than an
argument three months later about what the spec meant.

Keep the bench green through the whole build. It stays the reference
implementation for as long as the interface is alive, and it is the thing you
can hand somebody who asks what this interface does.

---

## When something goes wrong

| Symptom | Cause |
|---|---|
| `error: Expected ";" but found "<word>"` from the GUI | ObjectScript pasted into the JavaScript pane |
| Golden diff fails on byte one, output looks identical | UTF-8 BOM from a PowerShell `>` redirect. Use `bench.ts -o` |
| A segment you assigned is missing from IRIS output, no error | Wrong DocType, or a grouped path. Fails closed. Schema browser |
| A lookup returns empty for every message | Table exists with zero rows |
| Fields appear in the output that you never assigned | Missing `create='new'`, source riding along |
| `check.ts` says SKIP | You have an `.in.hl7` with no matching `.want.hl7` |
| A code you never saw before arrives blank at the receiver | A lookup with no stated unmapped branch |
| A repeating segment delivers set id 2 with no set id 1 | Numbering from the source repeat index instead of the output ordinal |
| The spec trace says every field is populated and the receiver disagrees | One `Message` parsed once and read as both source and target |

## Where the rest lives

- `METHOD.md`: the five questions, path syntax card, the traps collected
- `patterns.ts`: the twelve moves, each with its IRIS DTL
- `dtl.ts`: the spec types, the emitter, and a worked example
- `iris-lab/recipes/`: numbered ObjectScript recipes, 01 through 18
