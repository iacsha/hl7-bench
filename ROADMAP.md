# Roadmap

Things worth building, why, and what is still unknown about them. Nothing here
is committed to. An item earns its place by naming a failure it prevents.

---

## Scope

Three tools cover this work and they overlap enough that an item can look
obvious here while already existing somewhere else. The split:

| Tool | Owns |
|---|---|
| **PipeHat** | Understand one message. Editor-side, human-facing. Field names, data types, decoded trigger events, navigation, de-identification. |
| **hl7-bench** | Author and prove one transformation. Spec in, transformed message and engine code out. |
| **hl7-toolkit** | Review artifacts before they leave the machine. Export scanning, leak checking, corpus-scale review. |

### Not here

Proposed, then withdrawn. Recorded so they are not proposed again.

**A message scrubber.** PipeHat already has one: fail-closed, Safe Harbor field
coverage, residual scan. Building a corpus starts by running messages through
it.

**Field semantics in the bench tooltip.** PipeHat hovers tell you what a field
*means*. The bench readout tells you what to *type into a spec row*, which is a
different question and the reason both exist. Data types and required flags in
the bench tooltip would be the first step toward two dictionaries that disagree.

**A corpus profiler.** Per-field population rates and distinct values across a
thousand messages is the single most useful thing missing from this toolchain,
and **PipeHat already has it scoped**: "Field population profiler", P1, listed
as unblocked now that MessageIndex supplies per-message iteration. PipeHat also
already owns the parts that make it work, per-message delimiter scope and batch
envelope handling, and the batch file is open in the editor there anyway.
Putting it here turns the bench into a message browser and gives the toolchain
two profilers that will disagree about what counts as populated.

---

## Open

### Spreadsheet to import file: the rough edges

Found walking a one-column facility allowlist from a CSV to an imported table on
2026-10-02. Each one cost a round trip. The rest are settled (see Settled);
this one remains.

**`tables.ts --into-spec`.** `tables.ts` now says the spec is unchanged and
names the file to paste into. Writing the table there itself would remove the
step entirely, through `serialize.ts`, the path a GUI save takes. Not done in
the same commit because that path rewrites the spec literal wholesale and drops
comments inside it; a CLI that quietly strips a hand-written spec's comments is
worse than one more paste. Needs either a comment-preserving insert or a loud
`.bak` and a stated warning. Must refuse to overwrite an existing table of the
same name without `--replace`.

### Promotion diff

From the spec, emit what differs between environments: the processing id in
MSH-11, class names, config item names, and which lookup tables have to be
imported.

The same interface gets promoted through dev, QA and production, and every one
of those is a hand-repeated edit today. A list generated from the spec is a list
that cannot forget the table.

### Vendor mapping document

Export the inventory as something a receiving vendor can read.

Every integration project asks for one. Today that is a spreadsheet maintained
by hand, and a spreadsheet maintained by hand drifts from the DTL the day after
it is sent.

### More than one occurrence of a grouped bundle

`validate()` requires every row target in a block to match the block id, so IN1
and IN2 rows cannot share one repeating block. That makes the second insurance
coverage unreachable: the emitter can do occurrence 1 and nothing further.

IN1 and IN2 are one bundle in the schema. Splitting them across group
occurrences would hand the receiver an IN2 belonging to no coverage, so the
block has to carry both or neither.

### Skip a repetition when a field equals a given value

`repeat` currently skips a repetition when a field is empty. A sender that
writes `UNKNOWN` rather than leaving a field blank defeats that, and the
placeholder crosses to the receiver as though it were data.

Seen in real traffic on NK1 contact names, NK1 employer fields and the guarantor
employer. The receiver creates a contact named UNKNOWN for every patient whose
employer the sender does not know.

### Emit a thin-segment warning

A target segment whose only populated field is a set id or a counter is almost
always a mistake. `IN2|1` shipped to a receiver on a live interface, and IN2 has
no set id field, so field 1 is Insured's Employee ID and the receiver was told
the employee id is `1`.

Cheap check, real defect, and it fires on exactly the case where a block was
mapped out of completeness rather than because the source had anything in it.

### Recover a spec from an emitted class

Either a `--recover` flag or a `.cls` to `transform.ts` importer. For the case
where the class survived and the spec did not.

Lower value than it looks: the emitted class is a lossy view of the spec. Notes,
labels, and the reasoning behind a row do not survive the trip out, so what
comes back is a mapping, not a spec. Worth it only as a rescue, not as a
workflow.

---

## Settled

### `HL7_BENCH_TRANSFORM`

Done. `specpath.ts` resolves the variable, `specfile.ts` loads it, and every
reader follows: bench, check, emit, navcheck, schema-sync, trace, reads, and the
GUI, which also saves there. Unset, the spec is `transform.ts` and nothing
changed.

The shape is `*.local.ts` **in this folder**, not a sibling folder. That was wrong
on the first try and a dry run on the work-PC drop caught it: a spec imports
`./spec` and `./run`, which resolve against the spec file, so a file one directory
over dies with `Cannot find module './run'` and reads like a broken install.
Gitignored and absent from the zip removes both original failures anyway.

It fails closed, which was the part worth getting right. A path with a typo, or a
module with no `spec` export, stops the run. Falling back to the demo spec would
exit 0 and produce a message that looks like work.

The third failure, the one that made it urgent rather than tidy: a tracked
`transform.ts` holding a real interface put a customer's name, their vendor and
two accession numbers one `git push` from being public. `hooks/pre-push` now
refuses a push whose `transform.ts` has lost its SYNTHETIC-DEMO-SPEC marker, one
that adds a `.hl7` other than `sample.hl7` or any `.cls`, and one whose added
lines match a pattern in the gitignored `.publish-denylist`.

Leak checking at corpus scale is still hl7-toolkit's. This is a git hook on one
repo, not a scanner.

### The business process class, as a template

`emit/process.ts`, reached as `bun emit.ts process`. `iris.process` is optional
and carries the one fact the mapping cannot supply: `sendTo`, the config item
name as the production spells it. `validate()` refuses a reserved package, an
illegal name, the same name as the DTL, and an empty `sendTo`.

The header says TEMPLATE and says why: nothing in it has been executed, because
`OnRequest` needs a production. It also names which shop's pattern it models
rather than implying it is the pattern.

The gate is now emitted twice, as the routing rule condition and as a filter at
the top of `OnRequest`. Both headers say so. A gate in neither place is the
failure that matters and it is silent, so two is the safe side of that trade.

`iris.process.stamp` writes fixed values onto the target between the transform
and the dispatch. It exists for the value that depends on the destination rather
than on the message -- one DTL, two receivers, two sending facility codes --
and everything else still belongs in a block as `literal()`. Each stamp carries
a required `why`, which lands in the class as a comment and in the header as a
list, because the delivered trace does not account for stamped fields.

The generated block always sets `IsMutable` first. That is the reason this is a
generator feature and not two lines you type: a transformed or saved message
refuses `SetValueAt` at run time, per message, and the class compiles without
it. `validate()` refuses an empty `why`, two stamps on one path, and a stamp on
a path a block row already assigns.

Still open: the GUI tab, which does not yet edit stamps.

### Empty-read report

`reads.ts`. Runs the spec through the same `walk` and `resolve` the runner uses,
so it cannot describe a read the bench does not perform.

Two headlines, deliberately separate. **AT RISK** is the shape that produces no
segment: every path the block reads belongs to a segment that is not in the
message. **DELIVERS EMPTY** is a segment that gets created with nothing in it,
which is a different defect. One resolvable assign is the whole difference.

`--strict` exits 1 on at-risk, opt-in, because a legitimately absent optional
segment must not fail a shell by default.

Its own blind spot is printed on every run including the clean ones: groups are
not checked, the bench model being flat, and a wrong `block.group` reads
perfectly here and writes nowhere in IRIS.

### Spec fingerprint in the class header

`fingerprint.ts`. Twelve hex characters of a SHA-256 over a stable stringify of
the whole spec, in both emitted class headers and on `emit.ts` stderr.

Covers everything including labels and notes, so a cosmetic edit moves it. That
is the deliberate side of the trade: a fingerprint that holds still through a
real change is worse than none, and one that drifts on a rewritten label costs a
second look. It describes the spec, not the file, and the header says a
hand-edit makes it a lie.

### `IGNOREMISSINGSOURCE`, stated in the header

A `///` block above the parameter: 1 skips, 0 throws and names the path, 0 is
the fastest diagnosis in the file, and shipping at 0 is an outage because a
self-pay patient with no IN1 becomes a failed message. What 1 costs is a segment
that is never created, and the header points at `bun reads.ts` for that.

### Lookup tables as loadable XML

`emit/lookup.ts`, reached as `bun emit.ts tables [--table NAME]`. Empty keys and
control characters are refused outright, since a document that imports cleanly
with the wrong rows in it is the failure the artifact exists to prevent. An
empty value warns and is written, because that is sometimes meant and always
worth saying.

`tables.ts` is the other half: a spreadsheet becomes a `spec.tables` entry, with
quoted fields, embedded delimiters, CRLF and a BOM handled, trims counted and
reported, and a duplicate key with two different values refused rather than
resolved. It writes TypeScript, not XML, on purpose: straight to XML would put
the rows where the bench cannot read them, and the bench and IRIS would disagree
exactly where you were relying on them to agree.

**Verified against a real export.** The document is the portal's own Export
shape, one `<Document name="<Table>.LUT">` per table, checked by exporting a
probe table off IRIS for Health 2026.1 and diffing (see the header of
`emit/lookup.ts`). Confirmed end to end on 2026-10-02: a 62-row allowlist built
with `tables.ts`, emitted with `emit.ts tables --table`, imported with the
Import button (not Import Legacy), and used by a live router filter that passed
a listed code and refused an unlisted one.

### Gate on membership in a lookup table

`gate.require` takes `{ path, inTable }` beside `{ path, equals }`. The bench
refuses a code that is not a key in the table and names the table. IRIS gets
`Exists("T",HL7.{...})` in the rule and `##class(Ens.Util.FunctionSet).Exists`
in the process and patch classes; a channel filter carries the keys inline,
since a filter script has no tables.

`Exists`, not `Lookup(...) != ""`: membership is key presence, so a blank
value still admits its code and there is no default-on-a-miss argument to get
backwards and fail open. That removed both traps the open entry listed rather
than guarding them, so the "refuse a blank value in a gate table" rule it
proposed was not needed. An undeclared gate table is a validate() refusal, and
an empty one is on the class header's go-live list, because both refuse every
message.

**The filter expression.** `emit.ts` prints the gate as one ObjectScript
boolean over `pRequest`, for a router that stores its filter as text and
evaluates it per message. `checkExpression` reads it back for closed strings
and balanced parens before it is printed. Every comparison is parenthesised,
because ObjectScript has no operator precedence. A site's wrapper (`eval =
{expr}`) is `filterWrap` in the style file, so the tracked repo names no
site's routing convention. When the gate reads a table, the deploy order is
printed with it. Built 2026-10-02 after a hand-typed filter one `)` short
passed its UPDATE and failed on the host.

Paths are symbolic, so the expression assumes a DocType by the time the filter
runs. A numeric `1:6.1` form for a router that sees untyped messages is not
built; nobody has needed it yet.

### Run the gate on the bench

`bun gate.ts` prints PERMIT or REFUSE for each message in a file, one per MSH,
with every clause of the gate under it: the trigger, each equality, each table
lookup. `explainGate()` in `run.ts` evaluates all of them rather than stopping
at the first, and `gate()` is now that plus a throw, so the refusal text the
golden cases assert did not change.

A table miss lists near keys (`nearKeys()`): the same code apart from case or
space first, then one character added, dropped, changed or swapped, for codes
of two characters or more. That is the "facility code typed slightly wrong"
failure the entry was written for.

Fixed on the way: the permit table was indexed directly, so a trigger of
`constructor` read an inherited property and passed. Key presence now uses
`hasOwn` there as well as on gate tables.

### The process class has a GUI tab

A **Process class** tab beside ObjectScript shows `emitProcess` output from the
same preview as every other pane, so the copy button copies it like the rest.
When the spec has no `iris.process` the pane says what to set instead of
showing the CLI's throw. The ObjectScript pane now carries the filter
expression under the routing rule condition. Checked in a real browser
(Interceptor on a lab container, 2026-10-02): the tab renders, selects, and
shows the class.

### Golden-file regression

Already there under another name. `check.ts` is the input and expected-output
pair runner: `<name>.in.hl7` beside `<name>.want.hl7`, plus `.reject.hl7` for
messages that must be refused, re-run with one command after any spec change,
and a failure prints the segments that differ. `engine.ts --check` runs the
compiled class in a real namespace against the same files, which is the check
the original trigger needed after a package rename, a class rename and a config
item rebuild. The entry was written before either existed and is closed rather
than rebuilt.

Not built: a field-level diff. A failing case prints whole differing segments,
and finding the one field that moved in a long OBX is still a read.

### Spreadsheet to import file, the settled half

The rough edges found on 2026-10-02, fixed in two commits:

- **An unknown `--table` names the spec it read** and why that file
  (`specSource()` in `specpath.ts`: `.env.local`, `.env`, the shell, or the
  default), and names any sibling `transform*.ts` that does declare the table
  (`specsDeclaring()` in `emit/lookup.ts`, a text search, so a spec that does
  not compile can still be found).
- **`tables.ts` says the spec is unchanged**, names the active spec, and prints
  the `emit.ts tables --table` that follows.
- **`--table` as PowerShell completes it.** A leading `.\` or `./` is dropped;
  a `.csv`, `.txt`, `.tsv` or `.xlsx` is refused with the name it probably
  meant, not stripped, since file and table names only usually match
  (`tableArg()`).
- **`--module` with a dotted name** exports an identifier (`identName()`) and
  wires it in under the real name: `tables: { "A.B.C": ABC }`. It used to write
  `export const "A.B.C"`, which does not parse, for every IRIS-style name.
- **A one-column file is an allowlist** (`oneColumn()`): each code maps to
  itself, said on stderr. `--value-literal <v>` stores a fixed value instead.
  A one-column file whose cells hold another delimiter is `"suspect"`, not an
  allowlist, because that is the wrong `--delim` gluing columns together, and
  the likely delimiter is named. The active delimiter is exempt: if it survived
  into a cell it was quoted on purpose.
- **Same-value repeats collapse into one warning** with a count and the first
  ten keys. A repeat with a different value is still refused, one line per key.

### Source-side group paths and DocType

Asked whether reading a grouped segment needs the inbound message to carry a
DocType, and whether a shared business service would have to have its Message
Schema Category changed to provide one. Both answered on a live interface.

**A grouped source path resolves.** `source.{IN1group(1).IN1:2}` reads correctly
when the inbound message arrives with a DocType, and `IN1group` is the right
group name for IRIS's 2.3 ADT_A01 schema. No stamp on the clone was needed and
the shared service's schema category was never touched.

**The original failure was not a path problem at all.** It was a stale compiled
DTL. The paths had been correct through the entire investigation.

**Still untested:** whether a flat `source.{IN1:2}` also resolves against a
grouped schema. Never tried, because the grouped form worked. Anyone tempted to
flatten source paths as an optimisation should measure first.

The diagnostic that settled it: set `IGNOREMISSINGSOURCE = 0`, resend, and read
the error. Running clean at 0 proves every source path resolves, because at 0 an
unresolvable path throws. Revert to 1 before the change leaves dev.
