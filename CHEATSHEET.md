# hl7-bench cheat sheet

Organised by **what you are holding and what you want next**, not by filename.
If you are mid-call and something is on fire, jump to [Mid-call](#mid-call).

The one file you ever edit is **`transform.ts`**. Everything else reads it.

---

## The loop

```
have a message + a target       ->  bun classify.ts have.hl7 want.hl7
                                        sizes the job before you promise a date
edit the spec in transform.ts   ->  bun gui.ts
                                        or type it; the GUI writes the same file
does it produce the right bytes ->  bun check.ts
                                        golden files in messages\, PASS/FAIL
what does the engine get         ->  bun emit.ts > My.cls
hand the receiver the document   ->  bun trace.ts
```

Nothing downstream of `transform.ts` needs to be kept in sync by hand. That is
the whole design: one spec, six readers.

---

## By question

| You are asking | Run |
|---|---|
| How big is this interface, really? | `bun classify.ts have.hl7 want.hl7` |
| What does my transform do to this message? | `bun bench.ts < messages\in.hl7` |
| Save that output without a BOM | `bun bench.ts -o messages\out.hl7 < messages\in.hl7` |
| Does it still match every golden file? | `bun check.ts` |
| ...just the A01 ones | `bun check.ts a01` |
| Let me edit the spec in a form instead of typing | `bun gui.ts` (http://127.0.0.1:7317) |
| ...against a real message, not sample.hl7 | `bun gui.ts messages\yours.hl7` |
| Give me the DTL | `bun emit.ts > My.cls` |
| Give me the business process | `bun emit.ts process > MyProcess.cls` |
| Give me the lookup tables as loadable data | `bun emit.ts tables > Tables.xml` |
| ...just one table | `bun emit.ts tables --table Facilities` |
| Turn this spreadsheet into a lookup table | `bun tables.ts Facilities < facilities.csv` |
| ...as its own importable module | `bun tables.ts Facilities --module < facilities.csv > tables.facilities.ts` |
| ...odd columns / tab delimited | `bun tables.ts Sex --key 2 --value 3 --delim tab < codes.txt` |
| The mapping document for the receiver | `bun trace.ts` |
| Which source paths came back empty? | `bun reads.ts < messages\real.hl7` |
| ...and fail the run if any did | `bun reads.ts --strict < messages\real.hl7` |
| How do I do <the move>? Show me it running | `bun patterns.ts` |
| ...one of them | `bun patterns.ts P7` |
| ...one of them against my message | `bun patterns.ts P7 my.hl7` |
| Is the bench itself still sound? | `bun test` |

`bench.ts`, `trace.ts` and `reads.ts` all fall back to `sample.hl7` when nothing
is piped in, so a bare `bun trace.ts` works and does not hang.

---

## The two verbs people mix up

**`check.ts` is not `test`.** `bun test` proves the *parser* is right. `bun
check.ts` proves *this interface* is right against a target somebody else
specified. Only the second one is the thing you get paged about.

**`classify.ts` is day one, not day thirty.** Give it the message you HAVE and
the message you WANT, before you have written any spec. It tells you whether you
are holding seven lines of DTL or a fortnight.

---

## Golden files: no registration step

Drop files in `messages\` and name them. Nothing to edit, nothing to register.

```
<name>.in.hl7        the message you receive
<name>.want.hl7      what transform.ts must produce from it
<name>.reject.hl7    a message transform.ts must REFUSE  (no .want file)
```

Rejection cases are not optional. "It permits two events" is an untested
adjective until you have watched it refuse the third.

---

## Where a value comes from: pick the right home

This is the decision that actually costs time, so it is worth the table.

| The value is | Put it | Looks like |
|---|---|---|
| Copied from the inbound message | block row, `copy()` | `{ target: "PID-3", from: copy("PID-3") }` |
| Fixed for every message this interface sends | block row, `literal()` | `{ target: "MSH-4", from: literal("WEST_LAB") }` |
| First non-empty of several paths | block row, `firstOf()` | `firstOf("PID-18", "PV1-19")` |
| A code translation | block row, `lookup()` | `lookup("Facilities", "MSH-4", blank())` |
| Different **per destination**, same DTL | `iris.process.stamp` | see below |
| Genuinely procedural | write a function, not a rule | |

Everything in the first four rows shows up in `bun trace.ts` and is covered by
the fingerprint. A stamp is not, which is why it is last resort.

---

## Mid-call

Things you will want in a hurry, with the shortest correct answer.

**"They need MSH-4 hardcoded."** One spec row, then re-emit:

```ts
{ target: "MSH-4", from: literal("WEST_LAB") }
```
```powershell
bun check.ts ; bun emit.ts > My.cls
```

**"...but only for THIS receiver, the other one keeps its own."** Now it depends
on the destination, which the DTL cannot see. Stamp it in the process:

```ts
process: {
  className: "Site.Interface.Process.AdtToRegistration",
  sendTo: "ToRegistration.ADT.TCP",
  stamp: [{ path: "MSH-4", value: "WEST_LAB", why: "this receiver keys routing on sending facility" }],
},
```
```powershell
bun emit.ts process > MyProcess.cls
```

The generated block sets `IsMutable` before it writes, and you want that: a
transformed or saved message refuses `SetValueAt` at **run time**, per message,
with `<Ens>ErrGeneral: Cannot modify immutable message`. It compiles fine
without it, which is how it eats a morning.

**"A field is empty and nobody knows why."** `bun trace.ts` prints the source
path, the raw value, every step and the final value, per field. Read the row.

**"Is the namespace running what I am reading?"** Compare the fingerprint in the
class header against the one `bun emit.ts` prints on stderr. A DTL that was
saved but not compiled looks byte-identical to the one in your editor.

**"Am I dropping repeats?"** If the target is one flat record and the source has
four FT1 segments, that is four records. `mapEach` in `toolbox.ts` reports the
count. A transform that silently reads only `(1)` drops the rest without a word.

---

## Diagnostics

```powershell
$env:HL7_BENCH_LOG   = "summary"   # or "full", or "off" (default)
$env:HL7_BENCH_NOTES = "off"       # silence per-message stderr notes
```

`bun check.ts` sets `HL7_BENCH_NOTES=off` itself, so PASS/FAIL lines stay
readable.

---

## Two files that are not commands

**`toolbox.ts`** is for mapping to a *non-HL7* target: a flat record, a pipe
file, a billing feed. Declare rules as data, run `mapOne` or `mapEach`, print
`renderTrace()`. It is the sibling of the spec, aimed at record layouts rather
than at IRIS.

**`patterns.ts`** is the one to open when you know the shape of the problem but
not the incantation. Every pattern is runnable, so you see it work before you
copy it.

---

## Gotchas that have actually cost time

- PowerShell `>` writes a UTF-8 BOM. Use `bun bench.ts -o file.hl7`, not `>`,
  whenever the bytes matter.
- The DTL header says *proven on the bench*. The process header says *TEMPLATE*.
  That difference is real and deliberate; do not trust the second one the way
  you trust the first.
- The gate is emitted twice, in the routing rule and in the process filter.
  Decide which one holds it. Both is harmless. Neither is silent.
- `iris.className` and `iris.process.className` are two classes. The same name
  for both replaces the DTL at compile time and the rule then fails at run time
  complaining about a transform that is right there in the portal.
- Hand-editing a generated `.cls` makes the fingerprint in its header a lie. Fix
  the spec and re-emit.
