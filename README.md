# hl7-bench

A portable HL7 v2 transformation bench. No installer, no admin rights, no
service, no container. One `bun.exe` and four files.

Built for the workstation problem every hospital interface engineer knows: the
machine where you actually do the work is the machine where you are not allowed
to install anything. This runs out of a user folder.

```
stdin   <- raw HL7        stdout -> transformed HL7
stderr  -> diagnostics    exit 0  =  success
```

That is the whole interface. Anything that can spawn a process can drive it.

---

## What it is and is not

**Is:** a real transform loop. Edit a JavaScript function, run it, see the
transformed message with every changed field highlighted. The transformer
contract is the one Mirth taught you — you get the parsed message, you mutate
it, you are done.

**Is not:** an interface engine. There is no channel, no queue, no listener, no
persistence. It transforms one message and exits. If you need routing and
delivery, you need an engine; this is the bench you use *before* you get to one,
or when the engine you need cannot be installed where you are sitting.

It is also not a substitute for a vendor's own transformation language. If you
are learning InterSystems DTL, DTL only executes inside IRIS, and IRIS is a
server install. Learn the language on a machine that can run it. Use this where
that machine is not available.

---

## Two ways to run it

### GUI

```powershell
bun gui.ts
```

Opens `http://127.0.0.1:7317` — message on the left, transform below it, output
on the right with changed fields highlighted, `stderr` underneath. `Ctrl+Enter`
runs. Edits save straight back to `transform.ts`, so the transform you tuned in
the browser is the one every other caller gets.

Bound to loopback deliberately. Binding a public interface is what triggers the
Windows Firewall prompt you cannot approve without admin, and this endpoint
writes a file and executes it — it has no business listening anywhere else.

### Notepad++ (with [PipeHat](https://github.com/iacsha/PipeHat-npp))

This repo ships `hl7-bench.provider`, so installing is a copy:

```
<Notepad++>\plugins\Config\PipeHat\providers\hl7-bench\
```

Drop `bun.exe` in the same folder and restart Notepad++. Nothing to edit — the
provider file uses `${DIR}` for its own location, so it contains no username and
works wherever you unzip it. Uninstall by deleting the folder.

`Ctrl+Alt+Shift+X` picks the provider, `Ctrl+Alt+Shift+A` re-runs it. The result
lands in the other view and PipeHat diffs it field by field.

If you would rather declare it by hand, `PipeHat.providers` still works and
takes precedence over any drop-in that reuses the same name.

### Or neither

```powershell
Get-Content message.hl7 -Raw | bun bench.ts
```

---

## Setup

1. Download `bun-windows-x64.zip` from [bun releases](https://github.com/oven-sh/bun/releases).
2. Extract `bun.exe` anywhere writable — `C:\Users\<you>\tools\` is fine.
3. Clone or unzip this repo next to it.
4. `bun test` — 31 tests, no network, no dependencies.

Nothing is installed. Nothing touches the registry. Notepad++ has an official
portable build too, so editor, plugin, and bench all fit on a stick.

If your site blocks unsigned executables from user-writable folders, this
approach will not work and no amount of arguing with the policy will change
that. The same bench logic ports to PowerShell if you need a zero-download
option.

---

## Writing a transform

```ts
import type { Message } from "./hl7";

export function transform(msg: Message): void {
  msg.set("MSH-3", "BENCH");
  msg.set("PID-5.1", msg.get("PID-5.1").toUpperCase());
  msg.set("PID-8", msg.get("PID-8") === "M" ? "MALE" : "OTHER");

  for (const obx of msg.all("OBX")) {
    obx.set("OBX-15.1", "LAB");
  }
}
```

Paths are `SEG-F`, `SEG-F.C`, `SEG-F.C.S`, with an optional repetition index —
`PID-3(2).5` is the identifier type of the second repetition of PID-3.
`msg.seg(id)` gets the first occurrence, `msg.all(id)` gets every one.

Throwing aborts the run and puts the error, with the line number in your file,
in front of you:

```
transform() threw:
Error: No ZZZ segment in this message
    at transform (transform.ts:3:7)
```

That is the feedback loop. Break things on purpose while it is cheap.

---

## The MSH off-by-one

`MSH-1` **is** the field separator and `MSH-2` **is** the encoding characters, so
on the MSH line every field sits one slot left of where a naive split puts it.
Get this wrong and you silently shift message type, control ID, and version —
and it reads fine right up until a receiver rejects everything.

`hl7.ts` handles it and `hl7.test.ts` locks it down. `MSH-2` is additionally
never split by the delimiters, because it is the field that *defines* them;
splitting it returns `^` instead of `^~\&`. The tests caught that one on the
first run of this repo.

Delimiters are read from each message rather than assumed, so a feed that
declares `!` as its field separator parses correctly.

---

## Files

| File | |
|------|--|
| `transform.ts` | **the file you edit** |
| `hl7.ts` | parse, serialize, path lookup |
| `bench.ts` | the stdin/stdout wrapper |
| `gui.ts` + `gui.html` | the local browser UI |
| `hl7.test.ts` | 31 tests |
| `sample.hl7` | synthetic ADT^A01 |

## PHI

`sample.hl7` is synthetic. `.gitignore` excludes every other `.hl7` and a
`messages/` directory, because committed PHI is not recoverable after the fact.
Scrub before you share — [PipeHat](https://github.com/iacsha/PipeHat-npp) has a
fail-closed scrubber if you need one.

## License

MIT.
