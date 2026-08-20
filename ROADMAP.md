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
and it belongs in **hl7-toolkit**, whose stated purpose is small review tools.
Putting it here turns the bench into a message browser.

---

## Open

### Emit the business process class, as a template

The bench already holds every input except one. `gate.permit` holds the trigger
events, `gate.path` holds the field they are read from, and `iris.className`
holds the DTL to call. The only new fact is the name of the outbound config
item to dispatch to.

Proposed shape, optional, absent meaning the bench behaves exactly as it does
now:

```ts
iris: {
  className: "Site.Interface.DTL.AdtToRegistration",
  process: {
    className: "Site.Interface.Process.ToRegistration",
    sendTo: "ToRegistration.ADT.TCP",
    comment: "Custom Business Process to translate ADT bound for the registry",
  },
}
```

New GUI tab beside ObjectScript. The copy button already copies whatever tab is
visible, so that part is free.

The emitted `OnRequest` has three parts in a fixed order: the trigger-event
filter, then the gate requirements, then clone and transform and dispatch. A
refused message returns success with a trace, never an error, because an
excluded facility or an unhandled event is a correct outcome, and an error queue
full of correct outcomes trains people to ignore the error queue.

**The header must not claim what the DTL header claims.** The DTL says *proven
on the bench* and means it: real messages went through that mapping and the
output was shown. There is no `OnRequest` to run and no message to feed it, so
a process class is a template and the file has to say so. If both artifacts
carry the same confident banner, the DTL banner stops meaning anything, and it
is the one line in that file that has to be believed.

Second caution for the same header: the shape being emitted is one shop's
pattern, a custom `Ens.BusinessProcess` that clones the request, calls a DTL,
and dispatches with `SendRequestAsync` by config item name. Plenty of sites
wire a routing engine to a rule with a transform field instead. Say which
pattern the file is modelled on rather than implying it is the pattern.

No longer blocked. The DocType question below is settled, and a `stampDocType`
option is not needed.

### Empty-read report

Dry run a spec against a message and list every source path that resolved to
nothing, before anything is compiled.

`IGNOREMISSINGSOURCE = 1` turns an unresolvable source path into a skipped
assign. Skip every assign for a segment and the segment is never created, so a
whole block of the mapping disappears with no error, no warning, and nothing in
the trace. That cost two days on a live build. The bench can answer it in the
time it takes to paste a message.

### Spec fingerprint in the class header

Stamp a hash of the spec into the emitted class comment.

The hunt above was not a mapping bug. The mapping was correct and the namespace
was running an older compile. Nothing in the portal answers *am I running what I
think I am running*, and a fingerprint in the header turns that into a glance.

### Golden-file regression

Save input and expected output pairs, re-run after any spec change, show what
moved.

The trigger: a working interface got a package rename, a class rename, and a
config item rebuild in one sitting, and the only thing that confirmed it still
worked was a person reading ten segments and comparing them to ten segments from
memory.

### Say what `IGNOREMISSINGSOURCE` costs, in the header

The emitted class sets it to 1, which is right for production and wrong for
diagnosis. Set to 0 it names the path that will not resolve, which is the
fastest way to find a broken mapping and an outage if it ships that way: a
patient with no insurance stops being a skipped segment and becomes a failed
message.

Both halves belong in the header, beside the parameter, because whoever needs
the diagnostic is already looking at the class and not at this file.

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

### Export the lookup tables as loadable XML

`spec.tables` already holds the rows. Emit them in the format the Data Lookup
Tables page imports.

Lookup tables are namespace **data**, not code. They do not travel with a class
export and they do not travel with a production deployment. A table that did not
make it into the next namespace makes `Lookup` return the default for every
message, so an allowlist drops everything, with a trace rather than an error.
Nothing in the error log, interface looks alive, delivers nothing.

Turning that from a thing you remember into a file you deploy is the whole item.

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
