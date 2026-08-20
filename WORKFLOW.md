# From a new interface to IRIS, start to finish

The order of operations for building a transform yourself. Eight steps, two of
them with a b and a c. Nothing here needs a second person or a chat window.

`METHOD.md` is the doctrine, the five questions and the traps. This file is the
button-pressing. Read METHOD.md once, keep this one open while you work.

One thing to know before you start: **nothing here figures out the mapping for
you.** Steps 1 through 5 are you deciding what the interface does, as a spec,
where the loop is fast and a golden file can prove you right. Step 6 prints the
IRIS DTL class from that same spec.

You author the interface exactly once. The runner, the document you hand the
receiving team, and the ObjectScript are all derived from that one object, so
they cannot drift apart. The leverage is that the mapping is already correct and
already proven before any ObjectScript exists. Not code generation.

---

## Step 0. Get the current tools onto the work machine

The bench is source files plus a bun binary. No install, no admin, no service.

Files that matter:

```
hl7.ts               the parser. Never edit.
spec.ts              the vocabulary. Grows; rarely edited by hand.
run.ts               the runner. Never edit.
trace.ts             the mapping document. Never edit.
emit.ts + emit\      the ObjectScript and lookup backends. Never edit.
fingerprint.ts       the spec hash both emitted classes carry. Never edit.
serialize.ts         prints a spec back into transform.ts. Never edit.
transform.ts         YOUR WORK. One interface at a time. Holds the spec.
bench.ts             stdin to stdout runner
gui.ts + gui.html    the browser spec editor, 127.0.0.1:7317
check.ts             the golden gate
reads.ts             every source path that resolved to nothing
tables.ts            a spreadsheet becomes a spec.tables entry
classify.ts          the in-versus-want diff
patterns.ts          twelve moves, each with its IRIS DTL
toolbox.ts           flat-record extraction, for non-HL7 targets
log.ts               the log switch. Off unless HL7_BENCH_LOG says otherwise.
METHOD.md            the doctrine
WORKFLOW.md          this file
messages\            gitignored. Real messages live here and nowhere else.
logs\                gitignored. Written only when logging is on.
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

That split also keeps interface work out of this repo. `messages\` is
gitignored for the same reason: the bench and its patterns are general, a
specific feed's mapping is not.

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
is also your DTL outline, because each pattern maps onto a `spec.ts` source kind
in step 6.

Almost every ADT interface is these twelve. When you hit something that is not
here, it is usually two of them composed.

---

## Step 4. Write the spec

What you are writing is one exported object: `spec` in `transform.ts`. Two ways
to write it, and they are the same object either way.

### In the browser

```powershell
bun gui.ts messages\<name>.in.hl7
```

Browser at `http://127.0.0.1:7317`. Three columns:

```
message in          the spec, as a form         message out
diagnostics                                     ObjectScript
                                                mapping document
                                                source inventory
                                                transform.ts
```

**There is no code pane and no JavaScript.** The middle column is the spec as
fields and dropdowns: the gate table, the DocTypes, the lookup tables, the
segments, and one row per target field. Every kind in `spec.ts` has a form, and
the dropdowns are built from the vocabulary the server reports rather than from
a list inside the page, so a kind added to `spec.ts` and not to the page shows
up as a visible gap instead of an option that quietly does nothing.

**`Copy segments to spec`** is the fast way to start. It sits on the Message in
header, reads the message in front of you, and lists every segment id it found
with the number of populated fields and the raw line. Tick the ones you want and
press `Add to spec`. Each ticked segment becomes a block, and every field that
carries something in any occurrence of that segment becomes one `copy()` row.

That output is a first draft, not a mapping. Everything lands as a straight
copy, so the coded fields still need their lookups, `MSH-9` and `MSH-10` still
want `event()` and a real control id, and the fields the receiver never asked
for still need deleting. It saves the typing, not the thinking.

Details worth knowing:

- **A segment that appears more than once gets `repeat: { over: <id> }`.**
  Without it only the first occurrence is ever delivered.
- **Fields are unioned across every occurrence.** The first `NK1` often carries
  three fields and the second carries ten. Reading only the first would decide
  that seven fields the sender populates do not exist.
- **`MSH-1` and `MSH-2` are never offered.** MSH-1 is the field separator and
  cannot be assigned; MSH-2 is written by whatever emits the message.
- **Rows you already have are left alone.** Run it again after the sender adds a
  field and it adds that field only, leaving the mapping you corrected by hand
  exactly as you left it.
- Nothing reaches disk until `Ctrl+Enter`.

The right column recomputes as you type. Four of its five tabs are pure
functions of the spec in front of you, computed without touching disk, so the
ObjectScript tab is a live answer to "what does this become in IRIS" while you
are still deciding what the interface does. `Save class` writes that tab to a
`.cls`, which is step 6 done early if you want it.

`Ctrl+Enter`, or `Write and run`, is the one action that touches disk. It
validates the spec first and refuses to write a spec that does not validate, so
`transform.ts` never holds something the CLI would reject. Then it rewrites the
spec literal, shells out to `bench.ts`, and fills the Message out tab with a
field-level diff against the message you started from.

Three things to know about that write:

- **Only the spec literal and the `"./spec"` import are regenerated.** Every
  byte above and below is copied through untouched: your doc comment, your
  `transform()` shim, any helper you added.
- **Comments inside the spec literal do not survive.** Nothing else does either
  in a data-driven design, and it points the right way: a `//` comment in the
  spec literal is a copy of your reasoning that only a reader of that one file
  sees. The same sentence in a `note`, `description` or `outOfScope` prints in
  the mapping document AND lands in the emitted DTL as a comment the next
  engineer reads in IRIS. Put it where all three consumers can reach it.
- **The first write of a session leaves a `transform.ts.bak`** beside the file.
  It is gitignored.

#### The draft is not a save

`draft every` in the header picks an interval: off, 1, 5 or 15 minutes. On each
tick, if anything changed, the browser posts the spec to
`logs/autosave/transform.draft.json`. That is the whole of it. `transform.ts` is
untouched, the one-per-session `.bak` is not spent, nothing runs, and the status
line says `draft ... not written` rather than anything green, because a green
`saved` there would be a lie that costs somebody an afternoon.

What it buys you is the crash. Close the laptop lid on an hour of unwritten
mapping and the next load offers it back: `Recover unsaved work from HH:MM?`.
Take it and the spec comes up exactly as you left it, still unwritten, and one
`Ctrl+Enter` away from being real.

Four things worth knowing:

- **A save clears the draft**, and so does anything that moves `transform.ts`.
  Staleness is decided by file mtime, not by a flag the GUI sets, so a hand edit
  in an editor retires the draft the same way `Ctrl+Enter` does. The recovery
  prompt cannot offer you work that is older than the file.
- **An invalid spec is drafted anyway.** This is the exact inversion of the
  `Ctrl+Enter` rule and it is on purpose: half-finished is what work in progress
  looks like, and it is the state most worth getting back.
- **The message pane is never in the file.** Only the spec is. A timer copying a
  live message to disk every five minutes is an exposure nobody asked for.
- **`logs/` is gitignored**, so the draft cannot follow you into a commit.

### In an editor

Open `transform.ts` and type the object. Nothing about the GUI is required, and
for a long spec an editor with multi-line edit is faster. The GUI reads whatever
is on disk when you press `Reload from disk`, so moving between the two is free.

ObjectScript is never something you type in either place. It is step 6, and it
is generated.

### The order to write it in

Write the spec in this order. It is not a style preference, it is the order that
keeps each step's assumptions true for the next:

1. **`gate` first.** Which triggers you accept and what each one is delivered
   as. Anything not in `permit` is refused before any work happens.
2. **`iris` second.** The class name and both DocTypes. Wrong here and the
   engine fails closed later, so write down what the schema browser says.
3. **`blocks` third**, in target segment order. Block order **is** output
   segment order.
4. **`rows` inside each block**, one per target field.
5. **`required: true` last**, on the fields the receiver cannot work without.

A block that repeats gets a `repeat`:

```ts
{
  id: "IN1",
  group: "INSURANCEgrp",                                   // if the target groups it
  repeat: { over: "IN1", skipWhenEmpty: "IN1-4", max: 3 },
  rows: [
    { target: "IN1-1",  from: counter() },
    { target: "IN1-4",  from: copy("IN1-4"), label: "Insurer", required: true },
    { target: "IN1-22", from: counter(), label: "Coverage Priority" },
  ],
}
```

`skipWhenEmpty` names the field that proves the segment is real, because feeds
send shell segments. `counter()` numbers by **output ordinal**, so a skipped
occurrence leaves no hole in the set ids.

Path syntax is in `METHOD.md` and is the same shape as the DTL:

```
PID-3          field
PID-5.1        component
PID-3(2).5     repetition 2, component 5
MSH-9.2        trigger event
```

Three rules that save the most pain:

- **Every lookup needs a stated unmapped branch.** `blank()`, `passthrough()`,
  `constant(v)` or `{ error: true }`. Pick one on purpose. An unmapped code
  silently becoming an empty field is the bug you find six weeks later in a
  claims report. `lookup()` will not let you leave it out.
- **Never gate on `if/else`.** That is what `gate.permit` is: a table keyed by
  trigger event. An if/else grows an implicit everything-else branch, and that
  branch is how an A03 discharge reaches the receiver as a registration.
- **Say what you left out.** `outOfScope` is a list of strings that prints on
  every run and lands in the emitted class header. "Not sent" and "nobody
  thought about it" look identical to the receiver otherwise.

Anything a human needs to read goes in a `note` on the row or the block, or in
`sourceInventory`. Those print to stderr on every run, show in the GUI's
Diagnostics pane, and `check.ts` mutes them so your PASS lines stay readable.

Run `bun bench.ts` as you go and iterate until the output matches your `.want`
file by eye.

### When the vocabulary is short of something

Grow it. `spec.ts` is a tagged union and a `switch` in each backend, and
`spec.test.ts` fails the build if you teach a kind to one backend and not the
other, so it is a small, safe change with a test that catches the half of it you
forgot.

What you must not do is smuggle raw JavaScript into a row. There is deliberately
no escape hatch, because the moment one exists the bench can express things the
ObjectScript cannot, and the two drift apart silently. That is the exact problem
this whole design closes.

If you genuinely need imperative code for one message, `transform()` still
receives the parsed `Message` and can mutate it after `runSpec` returns. Treat
that as a signal that the vocabulary needs a word, not as a place to live.

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

## Step 5b. Print the mapping document

Before you write any ObjectScript, produce the document that says what the
interface does, field by field, in the receiver's language.

```powershell
bun trace.ts < messages\<name>.in.hl7
```

No second file to write. `trace.ts` walks the same spec through the same
resolver `run.ts` uses, so the table cannot describe an interface the bench does
not actually produce.

It prints two tables, for two different audiences:

**The delivered trace** is what the RECEIVER gets: target field, name, which
source fed it, the raw value, the steps that ran, and the final value. Required
fields are starred and every empty one is listed at the bottom. That is the
mapping document. Attach it to the build ticket.

**The source inventory** is what the SENDER emits, mapped or not, driven by the
`sourceInventory` list in your spec. The READ BY column says which target rows
read each path, gathered from the spec itself. An inventory row nothing reads is
a real finding: either the receiver does not want it, or you missed it.

Those are rarely the same conversation. "We map PID-4" and "PID-4 is empty at
this site" are different statements, and the second one is the reason a go-live
slips.

Underneath both, a NOTES block collects everything the run noticed and nothing
else would show you: which path a `firstOf` actually used, how many repetitions
were skipped or dropped by a cap, every lookup table with no rows in it, and
every row note you wrote. Read it before you call the mapping settled.

---

## Step 5c. Find the reads that came back with nothing

```powershell
bun reads.ts < messages\<name>.in.hl7
```

The trace tells you what the receiver gets. This tells you what the mapping
asked for and did not get, which is a different list and the one that bites in
IRIS rather than on the bench.

The emitted class sets `IGNOREMISSINGSOURCE = 1`. A source path IRIS cannot
resolve becomes a skipped `<assign>` rather than an error. Skip **every** assign
in a block and the target segment is never created at all: no error, no warning,
nothing in the Visual Trace. The delivered message is simply shorter, and it
parses cleanly.

Two headlines, and they are not the same problem:

**AT RISK** means every path that block reads belongs to a segment that is not
in this message. That is the shape that produces no segment. It is usually a
path that is wrong rather than a sender that is quiet, and it is worth ten
seconds in the schema browser before you compile anything.

**DELIVERS EMPTY** means the paths resolved and every row came back blank. IRIS
still creates the segment and the receiver gets an empty one. A different
defect, and often a legitimate one on this particular message.

Run it against every `.in.hl7` you have, not just the happy one. A self-pay
patient with no IN1 is exactly the message that finds this.

```powershell
bun reads.ts --strict < messages\<name>.in.hl7   # exit 1 if a block is at risk
```

`--strict` is opt-in because a legitimately absent optional segment must not
fail a shell by default. Use it in a script once you know which message is which.

One thing it cannot see: **groups**. The bench message model is flat, so a block
with the wrong `group` name reads perfectly here and writes nowhere in IRIS.
That is the same silent failure this report is named after, and the one case it
will tell you is fine. Read the group name off your schema browser.

---

## Step 6. Emit the ObjectScript

Now, and not before. The mapping is settled, the goldens are green, and the
questions have been asked. What is left is translation, and you do not type it.

```powershell
bun emit.ts > MyTransform.cls
```

Diagnostics go to stderr, so the redirected file is clean ObjectScript. The
routing rule condition and the empty-lookup-table warnings land on your screen.

The GUI's ObjectScript tab is the same class from the same emitter, and `Save
class` writes it to a `.cls`. Use whichever is in front of you. The command line
is the one to put in a script.

The spec drives the whole class. Each row's source becomes an expression:

| Source | What it emits | Pattern |
|---|---|---|
| `copy("PID-3")` | a straight assign | P5 |
| `literal("VALUE")` | a quoted constant | P4 |
| `firstOf("PID-4", "PID-3")` | nested `$SELECT`, first non-empty | P6 |
| `lookup("Table", "PID-8", passthrough())` | `..Lookup` with a stated unmapped branch | P7 |
| `event()` | a `$SELECT` over the permit table | P1 |
| `counter()` | the loop's output ordinal | P8 |
| `pickRepeat("PV1-7", 13, "NPI", 1)` | a `<code>` scan over the repetitions | P9 |
| `fromFirst("IN1", "IN1-4")` | the first non-shell occurrence | P8 |
| `todo("why")` | a TODO comment and no assign | none |

A block with a `repeat` becomes a `<foreach>` with an emptiness guard and a
counter that numbers by **output ordinal** rather than source repeat index. That
distinction matters. A message whose first IN1 is a shell and gets skipped
delivers a single coverage numbered `2` if you number from the source, and a
receiver reading priority ordinally sees a secondary with no primary.

`todo()` is not a failure. It is the spec refusing to fake a row nobody has
decided yet, so the gap shows up as a TODO in the right place in the file rather
than as a silent hole you find at validation. Take the ObjectScript for it from
the pattern you noted in step 3.

Four things the emitter cannot know, and you must check before compiling. It
prints all four in the class header so they are in front of you:

**Version.** Your bench does not care about HL7 versions. IRIS does. Set
`sourceDocType` and `targetDocType` to the real schema names in your namespace,
and check them in the schema browser rather than assuming. A wrong DocType
**fails closed**: paths stop resolving, you get an empty message, and nothing
useful appears in the log. That failure mode is `iris-lab/recipes/18`, and it is
the single most common way an hour disappears.

**Grouped segments.** In some structures, segments sit inside groups. IN1 inside
`INSURANCE` means `target.{IN1(1):2}` resolves to nothing where
`target.{INSURANCEgrp(1).IN1:2}` works. Same fail-closed silence. Set `group` on
the block when it applies. If a segment you assigned is missing from the output
and there is no error, this is why. Check the structure in the schema browser.

**`create='new'` versus editing the source.** The default is `create: "new"`,
which matches what the bench does: block order is the output, and nothing rides
along. Set `create: "copy"` only if you mean to edit the message in place.
Mismatch here means fields you never assigned show up in the output.

**Lookup table rows.** A `$case` in ObjectScript needs a recompile every time a
code is added. `Ens.Util.LookupTable` does not, which is why the emitter uses
it. But an empty table returns the default for every message, and that looks
exactly like a working lookup. `emit.ts` names every empty table on stderr as a
go-live gate. Populate them and check the row count.

### The fingerprint

The class header carries a twelve-character hash of the spec, and `emit.ts`
prints the same string on stderr:

```
/// Spec fingerprint: 9a62d97231a1
```

When something in the namespace does not match what you are reading, check that
first. A stale compile looks exactly like a mapping bug and costs days. It
covers the spec, not the file: hand-edit the generated `.cls` and the
fingerprint stops being true.

### The business process, if you need one

```powershell
bun emit.ts process > MyProcess.cls
```

This one says **TEMPLATE** in its first line and means it. Nothing in it has run
here, because `OnRequest` needs a production and there is no production on a
laptop. The DTL earned its "proven on the bench"; this did not.

It needs one fact the mapping cannot supply, so add it to the spec:

```ts
iris: {
  process: {
    className: "Site.Interface.Process.AdtToRegistration",
    sendTo: "ToRegistration.ADT.TCP",
  },
},
```

`sendTo` is the config item name exactly as the production spells it. A name
that does not resolve fails at **run time**, per message, not at compile time.

What comes out clones the request, calls the DTL, and dispatches with
`SendRequestAsync(..., 0)`. That is one shop's shape. If your production already
has an `EnsLib.HL7.MsgRouter.RoutingEngine` in front of this transform with a
rule whose transform field names the DTL, you probably do not want this file at
all. Read it and take the parts you need.

Note that the gate now exists in two places: the routing rule condition below,
and a filter at the top of `OnRequest`. Pick which one holds it. Both is
harmless. Neither is the failure that matters, and it is silent.

### The lookup tables, as a file you can import

```powershell
bun emit.ts tables > Tables.xml           # every table in the spec
bun emit.ts tables --table Facilities     # just the one
```

Lookup tables are namespace **data**. They do not travel with a class export and
they do not travel with a production deployment. That is how a transform arrives
in Test correct and translates nothing.

Import at **Interoperability > Configure > Data Lookup Tables**, or:

```
Do ##class(Ens.Util.LookupTable).%Import("C:\path\Tables.xml")
```

Verify the document shape against your own version once, by exporting an
existing table from the portal and diffing. Then trust it.

Empty keys and control characters are refused outright, because a document that
imports cleanly with the wrong rows in it is the exact failure this artifact
exists to prevent. An empty **value** is warned about and still written, since
`Lookup` returns your default for a blank value exactly as it does for a missing
key, which in an allowlist is a permitted code being quietly refused.

### Building a big table without retyping it

Four hundred facilities in a spreadsheet:

```powershell
bun tables.ts Facilities < facilities.csv                       # a paste block
bun tables.ts Facilities --module < facilities.csv > tables.facilities.ts
bun tables.ts Sex --key 2 --value 3 --delim tab < codes.txt
```

It writes TypeScript into `spec.tables`, not XML, so the bench and IRIS read the
same rows. `bun emit.ts tables` then makes the import file. One place to be
wrong instead of two.

It trims keys and values and **reports the count**. A trailing space in a key is
invisible in every editor and in the portal, survives a copy-paste, and makes
`Lookup` miss. `--no-trim` if your keys genuinely carry spaces. The same key
twice with different values is refused rather than resolved, because that is two
people disagreeing about a code and picking one silently is how the wrong one
ships.

### The routing rule

`emit.ts` also prints the condition your routing rule needs, built from
`gate.permit` and `gate.require`:

```
HL7.{MSH:9.1}="ADT" && (HL7.{MSH:9.2}="A01" || HL7.{MSH:9.2}="A08")
```

The gate belongs in the rule, not in the DTL, so a message you do not handle is
never delivered rather than delivered wrong. Note the parentheses: `||` binds
looser than `&&`, and unparenthesised, that condition would deliver every ADT
message regardless of trigger.

### What the class logs once it is running

The generated class carries its own run-time logging, set in the spec so it
travels with the interface instead of living in somebody's memory:

```ts
iris: { sourceDocType: "...", targetDocType: "...", log: "warn" },
```

Default is `"warn"`, and it puts `$$LOGWARNING` at exactly two places: a lookup
code with no row in its table, and a `required` target that came out empty after
the assign. Those are the two questions you get asked when a message looks wrong
in production, and neither is answerable from the message itself.

`"trace"` adds `$$TRACE` per assigned field, which appears in Visual Trace when
tracing is enabled on that host. Good for a bring-up, expensive to leave on.
`"off"` emits neither, and skips `Include Ensemble`.

Set it in the GUI's IRIS section, or in `transform.ts`. Either way it lands in
the class header so whoever opens the `.cls` in Studio can see what it does
before they run it.

Two things worth knowing. A sender that routinely emits an unmapped code writes
one Event Log warning **per message** until you fix the table, which is the
point right up until it is noise. And gate refusals are deliberately not in
here: the gate is a routing rule, so a refused message never reaches the
transform at all.

---

## Step 7. Into IRIS Dev

1. Import the emitted `.cls` into Studio or VS Code, compile it.
2. Work down the TODO comments the emitter left. Nothing else in the file needs
   touching.
3. Build the routing rule, pasting the condition `emit.ts` printed on stderr.
4. Import `Tables.xml` and verify the row count against what `emit.ts tables`
   reported. The tables are data and do not arrive with the class; promote them
   with it, every time, including to Production.
5. If you emitted a business process, add it to the production as a Business
   Process and confirm `sendTo` matches a real config item name.
6. Check the fingerprint in the compiled class against what `emit.ts` printed.
   Same string, same mapping. Different, and you are looking at an old compile.
7. Use the DTL editor's Test button with your `.in.hl7` pasted in. This is the
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

Before the table: the bench can keep a record of its own runs, which is worth
turning on when a failure will not reproduce on demand.

```powershell
$env:HL7_BENCH_LOG = "summary"   # one line per run into logs\hl7-bench.log
$env:HL7_BENCH_LOG = "full"      # the same, plus every diagnostic note
Remove-Item Env:\HL7_BENCH_LOG   # back off
```

It is off unless you set it, so a scripted `bench.ts` leaves nothing behind by
default. Use `summary` freely. Think before you use `full`: a note can name a
source value, so a table keyed on `PID-3` puts MRNs in that file. `logs/` is
gitignored either way. The GUI's own `logs\authoring.log` is on by default and
records shapes and outcomes rather than content. Full detail in `README.md`.

| Symptom | Cause |
|---|---|
| The GUI says the spec does not validate and nothing was written | Working as designed. `transform.ts` is left alone until the listed problems are fixed |
| A comment you wrote inside the spec literal is gone after a GUI save | Expected. Put it in a `note`, `description` or `outOfScope`, where the document and the DTL both carry it |
| The GUI shows `no form for "<kind>"` on a row | A kind exists in `spec.ts` with no form in `gui.html`. Edit that row in `transform.ts` and add the form |
| A GUI save deleted an import your transform needed | `serialize.ts` regenerates only the `"./spec"` import. Restore from `transform.ts.bak` and open an issue, because that is a serializer bug |
| `bun gui.ts` exits with `EADDRINUSE` | An older GUI still holds 7317. Close that terminal |
| Golden diff fails on byte one, output looks identical | UTF-8 BOM from a PowerShell `>` redirect. Use `bench.ts -o` |
| A segment you assigned is missing from IRIS output, no error | Wrong DocType, a grouped path, or every assign in the block skipped by `IGNOREMISSINGSOURCE`. Run `bun reads.ts` first, then the schema browser |
| You fixed the mapping, recompiled, and the behaviour did not change | Compare the fingerprint in the class with what `emit.ts` prints. An old compile is indistinguishable from a mapping bug except by that string |
| A lookup returns empty for every message | Table exists with zero rows, or the tables were never promoted with the class. They are data, not code |
| One facility code out of four hundred never matches | A trailing space in the key. Invisible everywhere. Rebuild the table with `bun tables.ts`, which trims and reports the count |
| Fields appear in the output that you never assigned | Missing `create='new'`, source riding along |
| `check.ts` says SKIP | You have an `.in.hl7` with no matching `.want.hl7` |
| A code you never saw before arrives blank at the receiver | A lookup with no stated unmapped branch |
| A repeating segment delivers set id 2 with no set id 1 | Numbering from the source repeat index instead of the output ordinal |
| The bench segment is shorter than the one IRIS produces | Skipping empty assigns. `<assign>` creates the field either way, so `run.ts` always sets |
| Every ADT reaches the receiver, whatever the trigger | Routing condition missing the parentheses around the `||` group |
| `bun emit.ts` exits 1 and lists problems | `validate()` caught a row in the wrong block, an unknown table, a `counter()` outside a repeat, or a malformed path |
| `bun test` fails naming a backend and a kind | A source or step kind taught to one backend and not the other. That test exists for exactly this |
| The Event Log fills with the same unmapped-code warning | Working as designed, and it is telling you the table is short a row. Fix the table, or set `iris.log` to `"off"` if that sender is known bad and out of scope |
| `HL7_BENCH_LOG` is set and no file appears | The value has to be `summary` or `full`. Anything else is treated as off and says so once on stderr |
| Studio says `invalid name $LENGTH(target.{MSH.10})` on the emitted class | A `{PID:5.1}` reference inside a `<code>` body. The curly form is a DTL compiler feature and only works in a DTL attribute; a code body goes straight to the ObjectScript compiler. The in-code form is `GetValueAt("PID:5.1")`. Fixed in the emitter and held there by `emit/iris.test.ts`, so re-emit rather than hand-patching |
| A segment writes nothing and nothing is logged | The target segment sits inside a schema group. IRIS names the group after its first segment, so IN1 lives in `IN1group` and a bare `{IN1:2}` resolves to nothing. `Parameter IGNOREMISSINGSOURCE = 1` keeps it quiet by design. Set `group` on the block. Confirm the exact group name in **Interoperability > Interoperate > HL7 v2.x > HL7 v2.x Schema Structures**, or by expanding the target tree in the DTL editor, which prints the path IRIS wants |
| A required field warns on every single message | The guard is doing its job: the source field really is empty. Decide between dropping `required`, stamping a `literal()`, or reading the value from wherever the sender actually puts it. Do not silence it without picking one |

## Where the rest lives

- `METHOD.md`: the five questions, path syntax card, the traps collected
- `patterns.ts`: the twelve moves, each with its IRIS DTL
- `spec.ts`: the vocabulary, with the reasoning for each kind in its doc comment
- `emit/iris.ts`: the DTL backend. The only engine shipped, and not the only
  shape the seam allows
- `emit/process.ts`: the business process template, and why it says TEMPLATE
- `emit/lookup.ts`: `spec.tables` as an import file, and what it refuses
- `tables.ts`: CSV to `spec.tables`, and why it does not go straight to XML
- `reads.ts`: what `IGNOREMISSINGSOURCE = 1` costs and how to see it early
- `serialize.ts`: how a GUI save becomes `transform.ts` again, and exactly what
  it does and does not preserve
- `log.ts`: the log switch, what each level writes and why the split exists
- `toolbox.ts`: flat-record extraction, for targets that are not HL7
- `iris-lab/recipes/`: numbered ObjectScript recipes, 01 through 18
