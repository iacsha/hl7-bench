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

### The process class needs a GUI tab

`bun emit.ts process` writes the class; the GUI cannot show it. A tab beside
ObjectScript, with the same copy button, which already copies whatever tab is
visible.

Small, and worth doing before anyone builds a process from the command line
twice.

### Golden-file regression

Save input and expected output pairs, re-run after any spec change, show what
moved.

The trigger: a working interface got a package rename, a class rename, and a
config item rebuild in one sitting, and the only thing that confirmed it still
worked was a person reading ten segments and comparing them to ten segments from
memory.

### `HL7_BENCH_TRANSFORM`

Let `transform.ts` live outside the repo folder, named by an environment
variable.

Offered twice and never taken up, and no longer speculative: there is now a
second full copy of the tool on disk holding one site's spec. That is the
workaround this item removes. Two copies of the same tool means fixes land in
one of them, which is the state today.

The other failure it prevents: upgrading by downloading a zip and unpacking it
over the folder. On a machine without git that is the whole upgrade story, and
the spec is the one file in there that cannot be replaced from upstream.

### Gate on membership in a lookup table

`gate.require` does exact equality only, `{ path, equals }`. An interface that
should run for some facilities and not others cannot say so.

```ts
gate: {
  path: "MSH-9.2",
  permit: { A01: "A28", A08: "A28" },
  require: [{ path: "PV1-39", inTable: "PermittedFacilities" }],
}
```

emitting `Lookup("PermittedFacilities",HL7.{PV1:39},"") != ""` into the rule
condition.

The emitted string is the small half. The real payoff is that
`referencedTables()` would then see the gate's table, so the existing *EMPTY IN
THE SPEC, a go-live gate* warning fires on an empty allowlist. An empty
allowlist refuses every message, and refuses it quietly, which is exactly the
silent failure that warning was written for.

Two things the emitter must not get wrong. A blank value in a row is
indistinguishable from a missing key, because `Lookup` returns the default for
both, so the spec should refuse a table row with an empty value when that table
is used as a gate. And `Lookup` has an optional fourth argument that changes
what a miss returns; getting it backwards turns an allowlist into a passthrough,
which fails open.

### Run the gate on the bench

The bench emits the rule condition and never evaluates it. So the one question
worth asking before you compile, *would this message get through*, is the one
question the bench cannot answer.

Print PERMIT or REFUSE for a pasted message, and when refused, say which clause
did it: the trigger event, a required equality, or a table miss.

The commonest allowlist failure is a facility code typed slightly wrong in the
table. That is a laptop-sized problem being diagnosed in a dev namespace today.

### Verify the lookup document shape against a real export

`emit/lookup.ts` writes `<lookupTable><entry table= key=>value</entry></lookupTable>`,
which is the documented shape and has never been imported into an actual
namespace from this tool. Export an existing table out of the portal, diff the
two, and either confirm it or fix it once.

Until that happens the emitter is right on paper. That is not the same thing.

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

Not yet verified against a real portal export. See Open.

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
