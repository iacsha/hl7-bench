# When a feed does not fit the standard schema

## The symptom

The transform runs, reports OK, and delivers a well-formed message with nothing
in it. No error. The test suite is green.

## The cause

A DTL walks the **schema**. `<foreach property='source.{OBX()}'>` asks IRIS to
resolve a structure path, and IRIS answers from the DocType definition, not from
what is in the message.

A script walks the **segments**. `msg.all("OBX")` returns every OBX because that
is what an array scan does.

On a conforming message those agree. On one the schema does not describe they do
not, and the structure walk stops at the first violation. Everything past it is
unreachable by name, and it resolves to EMPTY rather than erroring.

Measured on the site radiology DFT:

| | stock `2.5:DFT_P03` | custom `2.5_SITE:DFT_P03` |
|---|---|---|
| `{OBX()}` | 0 | 143 |
| `{OBR:4.1}` | (empty) | `CHESTPORT` |
| delivered OBX | 0 | 43 |

Same message, same transform. Only the DocType differed.

## Finding it

```
bun navcheck.ts messages/yours.hl7
bun navcheck.ts messages/yours.hl7 --doctype 2.5:DFT_P03
```

Compares, for every path the spec reads, what the schema resolves against what
an array scan finds. Exits non-zero on a mismatch. Run it on a new feed before
building a mapping on top of it.

## Fixing it

A custom schema category. Not a change to the transform, and not index-walking
in generated code.

Derive it from the stock definition rather than typing one:

```objectscript
zwrite ^EnsHL7.Schema("2.5","MS","DFT_P03")
```

Then edit only what the feed forces. For that feed it was two things:

- `EVN` made optional. Stock 2.5 requires it; this sender omits it, which breaks
  the walk at position 3.
- `[{NTE}] [OBR] [{OBX}]` appended after `ACC`. The sender puts the report
  narrative after `GT1`, and `DFT_P03` has no group for it there.

Neither edit invents a segment. Both say where this feed really puts ones the
standard already knows about.

```xml
<Category name="2.5_SITE" base="2.5" description="site radiology DFT P03, as sent">
  <MessageType name="DFT_P03" structure="DFT_P03"/>
  <MessageStructure name="DFT_P03" definition="MSH~[~{~2.5:SFT~}~]~[~2.5:EVN~]~..."/>
</Category>
```

```objectscript
do ##class(EnsLib.HL7.SchemaXML).Import("/lab/site-schema.xml", .cat)
```

Two things that will waste an hour otherwise:

- **Brackets are separate `~`-delimited tokens.** `[~{~SFT~}~]`, not `[{SFT}]`.
  The compact form fails with `Unresolved SS reference '[{SFT}]'`.
- **An XML comment containing `--` is rejected** by the SAX parser, including a
  `--` used as punctuation in prose.

## Telling the engine which category to use

Nothing in the message names it. `MSH-12` is the HL7 **version**, not the schema
**category**, so anything deriving the DocType from `MSH-12` alone lands on the
stock category and fails silently.

- **In a production:** the HL7 Business Service's `MessageSchemaCategory`
  setting. Everything downstream inherits it.
- **In the lab:** `Lab.Runner.ApplySchema` asks the transform, which knows —
  a compiled DTL carries `GetSourceDocType()`.

## The deliverable, now tracked

The category is declared in the spec, so it ships with the interface instead of
living in somebody's memory:

```ts
iris: {
  sourceDocType: "2.5_SITE:DFT_P03",
  schema: {
    category: "2.5_SITE",
    base: "2.5",
    structures: [{ name: "DFT_P03", definition: "...", note: "what changed and why" }],
  },
}
```

`validate()` refuses a spec whose DocType names a non-stock category it does not
declare, refuses a category equal to its base, refuses one that looks like a
stock version (importing `2.5` would overwrite the shipped schema for the whole
namespace), refuses a declared category no DocType uses, and refuses the compact
`[{SFT}]` bracket form before IRIS has to.

## The four commands

```
bun schema-sync.ts --derive DFT_P03 --base 2.5   read the stock definition off the instance
bun emit.ts schema > site-schema.xml              the import document
bun schema-sync.ts --import                      load it into the engine
bun schema-sync.ts                               are they still the same?
```

## Missing is the easy case. Stale is the dangerous one

`navcheck.ts` catches a category the engine does not have: paths resolve to
empty, and it is loud once you look.

A category the engine HAS but which no longer matches the spec passes navcheck.
The walk succeeds, every path resolves, and the message navigates under the
wrong definition. Everything downstream then agrees with a reading nobody chose.

Demonstrated by editing the engine's definition behind the spec:

```
navcheck     exit=0   "OK. Every path this spec reads resolves..."
schema-sync  exit=1   STALE DFT_P03
                      first difference at 24:
                        engine ...~2.5:EVN~2.5:PID~
                        spec   ...~[~2.5:EVN~]~2.5:PID~
```

Two checks, two failure modes. Run both.

## Authoring

Not in the GUI text box. A definition is several hundred characters of bracket
tokens, and one typed by hand cannot be diffed against stock -- which is exactly
what you have to defend to whoever owns the interface. Derive, then edit only
what the feed forces.

The GUI shows the category, its base and each structure's note, so a schema
cannot be lost in a save and cannot be invisible to whoever opens the spec next.
