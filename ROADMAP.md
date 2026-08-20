# Roadmap

Things worth building, why, and what is still unknown about them. Nothing here
is committed to. An item earns its place by naming a failure it prevents.

---

## Emit the business process class, as a template

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
    stampDocType: "2.3:ADT_A01",   // only when the clone needs one
  },
}
```

New GUI tab beside ObjectScript. The copy button already copies whatever tab is
visible, so that part is free.

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

**Blocked on:** whether `stampDocType` needs to exist at all. See the open
question below. Building it now means guessing at the only part of the class
that is not boilerplate.

## Settle whether a source-side group path needs a DocType

Unresolved, and asserted too confidently once already.

A target segment inside a schema group must be addressed through the group:
`{IN1group(1).IN1:2}`, not `{IN1:2}`. That much is proven, and the emitter does
it. Writing needs a structural slot and a bare segment id has none.

Reading may be a different operation. A lookup that scans for a segment by name
does not obviously need the structure. Whether `source.{IN1:2}` resolves a
grouped IN1, and whether `source.{IN1group(1).IN1:2}` resolves when the inbound
message carries no DocType, is untested.

It matters because the DocType on an inbound message comes from the business
service's **Message Schema Category**, and that service is often shared by
several downstream interfaces. Changing it to suit one of them changes it for
all of them.

Test: send one message, look at whether the grouped segments came out populated.

If reads do need a DocType, three fixes that leave a shared service alone:

- flatten the source paths and keep the target grouped, which is an emitter flag
- stamp the DocType on a clone inside the process class, which mutates nothing
  anyone else can see
- a dedicated service on its own port, cleanest and usually not available

## `HL7_BENCH_TRANSFORM`

Let `transform.ts` live outside the repo folder, named by an environment
variable. Offered twice, never taken up, still worth having.

The failure it prevents: upgrading by downloading a zip and unpacking it over
the folder. On a machine without git that is the whole upgrade story, and the
spec is the one file in there that cannot be replaced from upstream.

## More than one occurrence of a grouped bundle

`validate()` requires every row target in a block to match the block id, so IN1
and IN2 rows cannot share one repeating block. That makes the second insurance
coverage unreachable: the emitter can do occurrence 1 and nothing further.

IN1 and IN2 are one bundle in the schema. Splitting them across group
occurrences would hand the receiver an IN2 belonging to no coverage, so the
block has to carry both or neither.

## Skip a repetition when a field equals a given value

`repeat` currently skips a repetition when a field is empty. A sender that
writes `UNKNOWN` rather than leaving a field blank defeats that, and the
placeholder crosses to the receiver as though it were data.

## Recover a spec from an emitted class

Either a `--recover` flag or a `.cls` to `transform.ts` importer. For the case
where the class survived and the spec did not.

Lower value than it looks: the emitted class is a lossy view of the spec. Notes,
labels, and the reasoning behind a row do not survive the trip out, so what
comes back is a mapping, not a spec. Worth it only as a rescue, not as a
workflow.

## Gate on membership in a lookup table

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

## Run the gate on the bench

The bench emits the rule condition and never evaluates it. So the one question
worth asking before you compile, *would this message get through*, is the one
question the bench cannot answer.

Print PERMIT or REFUSE for a pasted message, and when refused, say which clause
did it: the trigger event, a required equality, or a table miss.

The commonest allowlist failure is a facility code typed slightly wrong in the
table. That is a laptop-sized problem being diagnosed in a dev namespace today.

## Export the lookup tables as loadable XML

`spec.tables` already holds the rows. Emit them in the format the Data Lookup
Tables page imports.

Lookup tables are namespace **data**, not code. They do not travel with a class
export and they do not travel with a production deployment. A table that did not
make it into the next namespace makes `Lookup` return the default for every
message, so an allowlist drops everything, with a trace rather than an error.
Nothing in the error log, interface looks alive, delivers nothing.

Turning that from a thing you remember into a file you deploy is the whole item.
