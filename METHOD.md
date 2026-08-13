# Building a transform: the method

How a real ADT transform was derived, generalised so you can run the same
procedure on the next interface without help.

The code is not the skill. The skill is the derivation. Twelve patterns cover
almost every move you will need — `bun patterns.ts` runs all of them against a
real message and shows what each one did, with the IRIS DTL that does the same
job printed beside it.

---

## The derivation: five questions, in order

Do not open an editor until you have answered all five. Each answer becomes a
specific piece of the transform, and answering them out of order is how you end
up writing field mappings for a job that only needed a segment whitelist.

### Q1. Which messages are even allowed in?

Not "what does the transform do" — **what does it refuse**. Write the permitted
list before anything else.

For this interface: A01 and A08. Everything else is not an error, it is simply
not this interface's business.

> This becomes the **routing rule**, not the DTL. In IRIS a message that matches
> no rule is never delivered and there is nothing to write. On the bench it
> throws, because a rejected message must be impossible to confuse with a
> transformed one when you are staring at two panes.

### Q2. What does the diff actually say?

Put the source message and the target mock-up in the two Notepad++ views and let
PipeHat diff them field by field. Then **read the diff before theorising**.

`classify.ts` does the sorting for you:

```
bun classify.ts have.hl7 want.hl7
```

It reports every difference under the five headings below and ends with a sizing
line. Use PipeHat's diff to *see* the messages side by side; use this to get the
classification written down.

Classify every difference into exactly one of five kinds:

| Kind | Looks like | Costs you |
|---|---|---|
| Segment set | segments present in one, absent in the other | one `remove` per segment |
| Metadata | MSH-9, MSH-12, doctype, structure | two or three assigns, plus a schema question |
| Field value | same field, different content | one assign each |
| Code translation | same field, same meaning, different vocabulary | a lookup table each |
| Structural | repeats, components, segment order | a loop each |

On the interface this was written for, the answer came back: **ten segment-set differences, two
metadata differences, zero field-value differences, zero translations, zero
structural**. That single line sizes the whole build. It is a whitelist plus two
writes, and the DTL is about seven lines.

You cannot get that answer from a spec document. You get it from the diff.

### Q3. Which differences are rules, and which are accidents of this sample?

One message cannot tell you. `PV1-19` is empty here — is that always empty, or
empty because this dev patient was registered oddly? `GT1-11` holds `18`, which
is a relationship code sitting in a Guarantor Type field — is that the sending
system's convention or a one-off?

**Do not encode a guess.** Flag it and ask. The `note:` field on a toolbox rule
exists exactly for this, and the `MISSING REQUIRED` list at the bottom of
a toolbox mapping run is that list of questions, generated rather than typed.

The cost asymmetry is what matters: a flagged question costs a five-minute call.
A guessed rule costs a validation cycle, and you find out during go-live.

### Q4. What happens to the values you did not plan for?

Every branch has an implicit "everything else". Name it, out loud, in the code.

- An unmapped code: pass through, blank, or throw. Pick one and write down why.
- An empty required field: reject the message or stamp a default. Different
  promises to the receiver — pick per field.
- A trigger event not on the list: not this interface's problem.

This is the difference between an interface that fails on day one and one that
fails silently for six weeks. `if (type === "CH") ... else ...` is how every
transaction type that is not `CH` quietly becomes a credit.

### Q5. How will you know it still works in a year?

A golden file. Source message in, expected output committed beside it, one
command that diffs them.

Include a **negative case**. An interface that "permits two events" is an
untested adjective until you have watched it reject the third — so the harness
runs the two permitted events *and* one that must be refused.

When the DTL is written, dump the IRIS output and diff it against the same
expected files. The bench becomes the reference implementation, and any
divergence is an IRIS bug rather than an argument about what the spec meant.

---

## Writing order inside the transform

Order the body this way. It reads top to bottom as the story of the message and
it avoids two real bugs.

```
1. GATE       reject what does not belong here          (P1, P12)
2. READ       capture source values you will need       (P5)
3. WRITE      set fields                                (P4, P6, P7, P9, P10)
4. STRUCTURE  add / drop / reorder segments             (P2, P3, P11)
```

**Read before write.** Once you assign a field, the original is gone — reading
it back later returns your own output. This is what iris-lab recipe 08 is about.

**Write before drop.** Setting `EVN-1` after a whitelist that removed EVN throws.
Setting it first and dropping after cannot.

---

## Path syntax card

```
SEG-F            PID-5        whole field
SEG-F.C          PID-5.1      component
SEG-F.C.S        PID-3.4.2    subcomponent
SEG-F(r).C       PID-3(2).5   component of the SECOND repetition
```

```ts
msg.get("PID-5.1")            // "" when absent -- never throws
msg.set("PID-5.1", "SMITH")   // throws when the SEGMENT is absent
msg.seg("PID")                // first PID, or undefined
msg.all("NK1")                // every NK1, in order
msg.segments                  // the raw array -- splice to add/drop
seg.repCount(3)               // how many repetitions field 3 has
msg.delims                    // this message's actual delimiters
```

**The MSH off-by-one.** `MSH-1` *is* the field separator and `MSH-2` *is* the
encoding characters, so on the MSH line every field sits one slot left of where
a naive split puts it. `hl7.ts` handles it. Every tool you ever use gets this
wrong once, and it reads fine right up until a receiver rejects everything.

**Bench to IRIS translation.** `PID-5.1` on the bench is `{PID:5.1}` in DTL.
`PID-3(2).5` is `{PID:3(2).5}`. Same idea, different punctuation.

---

## The pattern catalog

`bun patterns.ts` runs all twelve against `sample.hl7`. `bun patterns.ts P7`
runs one. `bun patterns.ts P7 my.hl7` runs it against your own message.

| | Pattern | Reach for it when |
|---|---|---|
| P1 | Gate on trigger event | deciding what the interface accepts |
| P2 | Segment whitelist | the receiver told you what they want |
| P3 | Segment blacklist | the receiver told you what they don't want |
| P4 | Stamp a literal | the value came from an email, not the message |
| P5 | Copy field to field | receiver keys on a different field than the sender fills |
| P6 | Conditional set | behaviour branches on a value |
| P7 | Code lookup | same meaning, different vocabulary |
| P8 | Walk repeating segments | NK1, DG1, IN1, OBX, FT1 |
| P9 | Walk field repetitions | PID-3 with several identifiers |
| P10 | Date/time reshaping | TS length mismatches |
| P11 | Add a segment | receiver needs something the sender never sends |
| P12 | Guard a required field | missing data must not go quietly |

Each pattern in `patterns.ts` carries three things: the working bench code, the
IRIS DTL that does the same job, and the trap that comes with it. Read the traps
first — they are the part you cannot get from a reference manual.

---

## The traps, collected

The ones that cost real time, in the order you are likely to hit them:

1. **Field mapping when it was a whitelist.** Diff first. Q2 exists for this.
2. **Writing against the first repeating segment** because the test message only
   had one. Four FT1 segments are four charges. Twenty OBX are twenty results.
3. **Deleting forwards through an array**, which shifts indexes under you and
   skips every second match. Walk backwards.
4. **Reading a target field mid-transform** and getting your own output back.
5. **An unmapped code with no stated behaviour.** Blanking is silent data loss.
6. **The `else` branch you never named.** Every branch has an implicit
   everything-else. Two feeds into one system with opposite defaults is not
   hypothetical.
7. **Wrong `targetDocType` in IRIS.** Fails closed, no warning, empty output.
   iris-lab recipe 18.
8. **Forgetting `MSH-9.3`** when the structure changes — or setting it when the
   receiver only wanted two components, which is this interface's case.
9. **`()` left off a DTL remove**, so only the first repetition goes.
10. **The MSH off-by-one**, once, forever.

---

## Where the rest lives

| | |
|---|---|
| `classify.ts` | answers Question 2 — feed it have.hl7 and want.hl7 |
| `patterns.ts` | the twelve moves, runnable, with DTL beside each |
| `transform.ts` | the file you edit — your interface lives here |
| `toolbox.ts` | mapping tables as data, and the field trace you hand an analyst |
| `README.md` | the bench itself — `mapEach`, `signed`, the trace table |
