# Changing a class somebody else wrote

The rest of the bench builds an interface from a spec you write. This is the
other job: **a class already exists, it works, and you need to add something
to it.** Clone field A into field B. Stamp a value. Translate a code.

You don't rewrite their class or translate it into a spec. You list your
changes. The bench writes the code for them, puts it in one marked block just
above the line that sends the message, and shows you the message before and
after.

```
their class  +  your changes  ->  their class with one marked block added
                                   the message it sent before, and after
                                   every field that changed
```

## What you need, once per machine

1. **A local IRIS the bench can run code on.** Not DEV. The bench compiles a
   scratch copy of the class to run it, then deletes it. `.env` points at the
   instance (`IRIS_CMD`, `IRIS_NAMESPACE`, `IRIS_USER`, `IRIS_PASSWORD_CMD`,
   `IRIS_LAB_DIR`); see LOCAL-LAB.md.
2. **Whatever their class calls**, exported from DEV and loaded locally. A
   utility class (`Site.Common.UtilitySet`) is the usual one. The
   class won't compile without it, and the error says which one is missing.
3. **The schema the messages use**, if it's a custom one (`Vendor:ADT_A01`
   is). Export the category from DEV and load it locally. Without it, every
   path reads empty, so the bench refuses to start and tells you why.

`HL7_BENCH_TRANSFORM` is not needed for any of this. Clear it or leave it.

## Each change

```powershell
bun overlay.ts gui .\OrigClass.cls messages\real.hl7 --doctype Vendor:ADT_A01
```

Open http://127.0.0.1:7318.

1. **+ add change.** In *write field*, put the field you're filling (`PV2-3`). In
   *value from*, choose where the value comes from (*copy a field*: `DG1-3`).
2. **Read "What the new code does".** It says in plain words what the
   generated code will do, including the cases people forget: what happens when
   DG1-3 is empty, when the message has no PV2, and when DG1 repeats.
3. **Run in IRIS.** Their class runs once as it is and once with your block.
   You get both messages, with the changed fields highlighted and listed.
4. **Try the awkward messages.** Edit the *Message in* box: delete the PV2,
   delete the DG1s, make it a pre-admit. Run again after each. The field list
   should say what you expect every time.
5. **Save.** This writes three files beside the class:

| File | What it is |
|---|---|
| `OrigClass.changes.local.json` | Your changes. Reopen later and keep editing. |
| `OrigClass.modified.cls` | Their class plus your block. This is what you deploy. |
| `real.after.hl7` | The message the modified class sent on the last Run. |

`OrigClass.cls` itself is never written.

The class name inside `OrigClass.modified.cls` is unchanged, so it imports
over the original in Studio. Review it there like any change: the diff is the
marked block and nothing else.

## Without the page

```powershell
bun overlay.ts .\OrigClass.cls messages\real.hl7 --run
bun overlay.ts .\OrigClass.cls messages\real.hl7 --run -o .\OrigClass.modified.cls
```

This prints the added lines, what they do, the message after, and the fields
that changed. Edit `OrigClass.changes.local.json` by hand for anything the
form doesn't show.

No IRIS on this box? Paste the schema map instead of asking the engine:

```powershell
bun overlay.ts .\OrigClass.cls messages\real.hl7 --schema vendor-adt-map.txt
```

`vendor-adt-map.txt` is the terminal output of
`zw ^EnsHL7.Schema("Vendor","MS","ADT_A01","map")` on DEV. That still shows
you the generated code, but nothing runs.

## What the block looks like

```objectscript
        // >>> hl7-bench changes (1) from OrigClass.changes.local.json. Edit there and re-apply; do not edit by hand.
        //PV2-3 <- DG1-3
        If (tRequest.GetValueAt("PV2") '= "") {
        	Set hb900 = pRequest.GetValueAt("DG1(1):3")
        	If (hb900 '= "") $$$ThrowOnError(tRequest.SetValueAt(hb900,"PV2:3"))
        }
        // <<< hl7-bench changes
        $$$ThrowOnError(..SendRequestAsync("ToReceiver.ADT.TCP",tRequest,0))
```

Reading it line by line:

- **Reads come from `pRequest`**, the message as it arrived. Writes go to
  whatever the class sends (`tRequest` here). The bench finds both by reading
  the method signature and the send line.
- **`DG1(1)`, not `DG1`.** DG1 repeats in the schema. A bare `DG1:3` reads
  empty in IRIS and nothing reports it. The bench adds the `(1)` because the
  schema says so, and the notes tell you it did. For "the first DG1 that has a
  code", choose *first occurrence with a value*.
- **The `If ... "PV2"` guard.** Writing to a segment the message doesn't have
  creates it. Tick *create the segment* if that's what you want.
- **The `hb900 '= ""` test.** An empty source leaves the field alone. Tick
  *write even when empty* to blank it instead.
- **`hb900`.** The bench picks a variable name that doesn't appear anywhere in
  their class.

## What it refuses

- **A class with more than one send.** Set `"anchor"` in the changes file to
  the line number of the send your changes belong to.
- **A field on a segment the schema doesn't have.** In IRIS it would read and
  write nothing, without an error.
- **`event`, `counter`, `sameAs`, `todo`.** These only mean something inside a
  spec.

## What it is not

- **It can't change their logic.** It can't put a change inside their
  `IsPreAdmit` branch or alter the filter. The block always goes above the
  send. Anything else is a hand edit, which you can still check with
  `bun engine.ts <msg> --script <class>`. The engine now runs any class that
  sends something other than `tTarget` whole, as it will deploy.
- **The changes are not a spec.** `trace.ts`, `check.ts` and the golden files
  don't read them.
