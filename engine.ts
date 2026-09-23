/**
 * engine.ts -- run ObjectScript you already have against a message, and read
 * what it did.
 *
 * WHY THIS EXISTS
 *
 * Every other tool here reads the spec. That is the point of the spec, and it
 * is also a wall: a class somebody wrote in Studio cannot be read by any of
 * them, so the only way to learn what it does to a message used to be to put it
 * in a production and open Visual Trace. That is a slow loop for a question as
 * small as "what does this do to MSH-9".
 *
 * This runs the ObjectScript itself, in a real engine, on a real message, and
 * prints the message that came out. It does NOT read a class back into a spec
 * and it never will -- that would be a second source of truth for every
 * decision, which is the thing the spec exists to prevent. This is a
 * microscope, not an importer.
 *
 *     bun engine.ts msg.hl7 --class Site.Interface.Dtl.Bar
 *     bun engine.ts msg.hl7 --script AdtToReceiver.cls
 *     bun engine.ts msg.hl7 --script AdtToReceiver.cls --diff
 *     bun engine.ts --check --script AdtToReceiver.cls
 *
 * KEEPING THE CLASS AS THE ARTIFACT YOU MAINTAIN
 *
 * `--check` runs the class against every golden file in `messages\\`, the same
 * ones `check.ts` runs the spec against. That is the whole regression gate for
 * somebody who writes the class in Studio and wants the bench to keep it
 * honest rather than to generate it. Without it there is a runner and no gate:
 * you could put one message through and learn nothing about the other six.
 *
 * TWO SHAPES, BECAUSE A DTL AND A BUSINESS PROCESS ARE NOT THE SAME THING
 *
 * `--class` calls `Transform(source, .target)`. That is a DTL, and a DTL runs
 * anywhere.
 *
 * `--script` takes THE CLASS FILE you already have -- the one Studio shows you,
 * whole -- finds its `OnRequest` (or whatever `--method` names), and compiles
 * that body into a scratch class here. It compiles rather than runs in a
 * session because `$$$OK` and `$$$ThrowOnError` are macros, and a piped session
 * has no include file. A business process cannot be called standalone at all:
 * `..SendRequestAsync` needs a running production, and there is not one.
 *
 * A file that is already just a body works too; the result says which it read.
 *
 * The body is given `pRequest` and is expected to leave the message it built in
 * `tTarget`, which is what a hand-written OnRequest already does.
 *
 * WHAT GETS NEUTRALISED, AND WHY IT IS ANNOUNCED
 *
 * Two kinds of line are removed from a `--script` body before it is compiled:
 * a dispatch (`SendRequestAsync`) and a trace (`$$$TRACE`). Both need a
 * production this is not running in. Each removal is PRINTED with its line
 * number, because quietly editing somebody's code and then reporting on its
 * behaviour is how a tool earns distrust it cannot get back.
 *
 * `--diff` runs the spec over the same message and compares the two outputs
 * segment by segment. That is the question worth asking after a transcription:
 * does the spec I wrote do what the class I proved does.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { Message } from "./hl7";
import { spec } from "./specfile";
import { readMessage, outArg, deliverText, decodeText } from "./input";
import { NAMESPACE, REMOTE, runIris, engineLabel } from "./iris-session";
import { classMethodsOf, type Carried } from "./scratch";

const argv = process.argv.slice(2);

/** The value after a flag, or undefined. Its own function because `namedArg`
 * in input.ts answers a different question: which POSITIONAL is the file. */
function flag(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith("-")) die(2, `${name} needs a value after it.`);
  return v;
}

function die(code: number, ...lines: string[]): never {
  for (const l of lines) process.stderr.write(`engine: ${l}\n`);
  process.exit(code);
}

const className = flag("--class");
const scriptFile = flag("--script");
const docTypeArg = flag("--doctype");
const methodName = flag("--method") ?? "OnRequest";
const wantDiff = argv.includes("--diff");

if (className && scriptFile) {
  die(
    2,
    `--class and --script are two ways to name the same thing: the code to run.`,
    `Pick one. --class calls Transform on a DTL; --script compiles a method body.`,
  );
}

// ---------------------------------------------------------------------------
// The body, and what had to come out of it
// ---------------------------------------------------------------------------

/**
 * Take the body out of a whole class file, or hand back what was given.
 *
 * `--script` used to demand that you paste the INSIDE of a method, which is a
 * silly thing to ask: the file you have on disk is a class, the file Studio
 * shows you is a class, and cutting the body out by hand before every run is
 * both tedious and a place to introduce a difference. Worse, pasting the whole
 * class produced a compile error about `QUIT argument not allowed` -- the class
 * header ended up nested inside a generated method, and nothing in that message
 * points at the actual mistake.
 *
 * So: if the file declares a class, find the method and take its body. If it
 * does not, it already IS a body and goes through untouched. Either way the
 * result says which, because a tool that silently reinterprets its input is one
 * you cannot trust a diff from.
 *
 * Brace matching, not a parser. An ObjectScript string containing an unbalanced
 * brace would defeat it, which is rare enough to be worth the simplicity and
 * loud enough when it happens -- the compile fails and names the line.
 */
function extractBody(raw: string, method: string): { body: string; found: string; firstLine: number } {
  if (!/^\s*Class\s+[\w.%]+\s+Extends/m.test(raw)) {
    // A file that clearly IS a class but did not match is worth saying out
    // loud. Falling through to "a method body" compiles a class header inside a
    // generated method and reports something unrelated, which is a long way to
    // walk from the real problem.
    if (/\bExtends\b|\bClassMethod\b|^\s*Method\s/m.test(raw)) {
      die(
        2,
        `${scriptFile} looks like a class file, but no "Class <name> Extends <super>"`,
        `line could be found in it. The first line reads:`,
        `  ${(raw.split(/\r?\n/).find((l) => l.trim() !== "") ?? "(empty)").slice(0, 100)}`,
        ``,
        `If the class line is there and this still fires, the file is probably not the`,
        `encoding it looks like -- see the UTF-16 note above.`,
      );
    }
    return { body: raw, found: "a method body", firstLine: 1 };
  }

  const sig = new RegExp(`^\\s*(?:Class)?Method\\s+${method}\\s*\\(`, "m");
  const m = sig.exec(raw);
  if (!m) {
    die(
      2,
      `${scriptFile} declares a class, but no method named "${method}" in it.`,
      `Name the one to run with --method, e.g. --method OnRequest.`,
    );
  }

  const open = raw.indexOf("{", m.index + m[0].length);
  if (open === -1) die(2, `Found ${method} in ${scriptFile} but no body after it.`);

  let depth = 0;
  for (let i = open; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) {
        return {
          body: raw.slice(open + 1, i),
          found: `the body of ${method} in the class file`,
          // So a removed line is reported at ITS line number in the file you
          // opened, not at its offset inside an extract you never saw.
          firstLine: raw.slice(0, open + 1).split(/\r?\n/).length,
        };
      }
    }
  }
  die(2, `${method} in ${scriptFile} has an unclosed body.`);
}

/** A line that cannot run outside a production, and the reason in one clause. */
const NEUTRALISE: { re: RegExp; why: string }[] = [
  { re: /SendRequestAsync|SendRequestSync/, why: "dispatch needs a running production" },
  { re: /\$\$\$TRACE/, why: "trace needs a production session" },
];

function prepareBody(raw: string, firstLine = 1): { body: string; removed: string[] } {
  const removed: string[] = [];
  const body = raw
    .split(/\r?\n/)
    .map((line, i) => {
      const hit = NEUTRALISE.find((n) => n.re.test(line));
      if (!hit) return line;
      removed.push(`line ${firstLine + i}: ${hit.why} -- ${line.trim()}`);
      // Commented rather than dropped, so the line numbers the engine reports
      // in a compile error still match the file on disk.
      return `    // [engine.ts removed] ${line.trim()}`;
    })
    .join("\n");
  return { body, removed };
}

/**
 * The scratch class.
 *
 * It extends `Ens.BusinessProcess` and not `%RegisteredObject` for one reason:
 * the Ensemble macros only compile inside a class that has the Ensemble
 * include, and a body copied out of a real OnRequest is full of them. The class
 * is never registered in a production and never dispatches anything.
 */
function scratchClass(body: string, docType: string, carried = ""): string {
  return [
    `Include Ensemble`,
    ``,
    `/// Generated by hl7-bench engine.ts. Not part of any production.`,
    `Class HL7Bench.Scratch Extends Ens.BusinessProcess [ ClassType = persistent, ProcedureBlock ]`,
    `{`,
    ``,
    // A ClassMethod, deliberately. `Ens.BusinessProcess.%New()` returns "" --
    // a host is built by a production, not by a caller, and an instance method
    // therefore dies with <INVALID OREF> before the body runs. The class still
    // extends the host so that `Include Ensemble` and the macros a real
    // OnRequest is full of compile. A body that genuinely needs `..` instance
    // context will fail to compile, loudly, and that is the right answer.
    `ClassMethod Run(pRequest As EnsLib.HL7.Message, Output tTarget As EnsLib.HL7.Message) As %Status`,
    `{`,
    // The body goes in BARE. It used to be wrapped in a generated try/catch,
    // which broke every real OnRequest: a hand-written one already carries its
    // own `try`, its own `catch`, and a closing `quit tsc` -- and ObjectScript
    // refuses `QUIT` with an argument inside a TRY block. The generated wrapper
    // put that quit inside a try that was not there when the code was written,
    // and the compiler said `#1043: QUIT argument not allowed : 'tsc'` about a
    // line the author never wrote wrong.
    //
    // A body that is a fragment rather than a whole method simply falls off the
    // end and returns "", which reads as an empty status and is not an error.
    // `tTarget` is what this is here to collect, and it comes back either way.
    body,
    `}`,
    ``,
    // The class's own ClassMethods, so a body that calls `..ValueAt` finds it.
    // See scratch.ts.
    ...(carried ? [carried, ``] : []),
    `Storage Default`,
    `{`,
    `<Type>%Storage.Persistent</Type>`,
    `}`,
    ``,
    `}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------

const checkMode = argv.includes("--check");
// --check reads the messages\ folder, not a named message, so asking for one
// would refuse a run that needs nothing.
const input = checkMode
  ? { raw: "", source: "sample.hl7" }
  : await readMessage("engine", argv);
const raw = input.raw;
// Parsed only when there IS a message. `--check` reads the goldens itself and
// names none, and `new Message("")` throws "Empty message".
const local = checkMode ? null : new Message(raw);

// The spec supplies the DocType and, with --diff, its own output. `--doctype`
// is there for a class the spec does not describe.
const docType = docTypeArg ?? spec.iris.sourceDocType;

/** What the engine will open. It reads REMOTE/<basename>, not the path typed. */
const remoteFile = `${REMOTE}/${basename(input.source)}`;

const preamble = [
  `zn "${NAMESPACE}"`,
  `set st=##class(%Stream.FileCharacter).%New(), sc=st.LinkToFile("${remoteFile}")`,
  `set src=##class(EnsLib.HL7.Message).ImportFromLibraryStream(st,.sc)`,
  `if '$IsObject($G(src)) { write "ERR|could not read ${remoteFile}",! halt }`,
  `do src.PokeDocType("${docType}")`,
  `write "DOCTYPE|",src.DocType,!`,
  `write "INCOUNT|",src.SegCount,!`,
];

// One marker per delivered segment. The segment text itself carries "|", so
// everything after the FIRST marker pipe is the segment and nothing parses
// further than that.
const dump = (v: string, before: string[] = []) =>
  [
    // `before` is the cleanup, repeated on this branch on purpose: a filtered
    // event halts here, and a halt must never be the thing that skips a delete
    // on somebody else's server.
    `if '$IsObject($G(${v})) { write "NONE|the code produced no target message",! ${before.join(" ")} halt }`,
    `for i=1:1:${v}.SegCount { write "OUT|",${v}.GetSegmentAt(i).OutputToString(),! }`,
  ];

/**
 * Remove the scratch class after the run, unless asked not to.
 *
 * `--script` compiles a class into the namespace it is pointed at, and that
 * namespace is often a SHARED dev server. Leaving `HL7Bench.Scratch` compiled
 * there is litter somebody else has to wonder about, and the next person to
 * search the class list for "Scratch" has no way to know whose it is or whether
 * deleting it breaks something. So it goes, every run.
 *
 * `--keep-scratch` is for the case that matters: a compile error you want to
 * open in Studio, where the class on disk is the thing you need to read.
 */
const keepScratch = argv.includes("--keep-scratch");
const cleanup = keepScratch
  ? [`write "KEPT|HL7Bench.Scratch and ${REMOTE}/HL7Bench.Scratch.cls left in place",!`]
  : [
      `do $system.OBJ.Delete("HL7Bench.Scratch","-d")`,
      `do ##class(%File).Delete("${REMOTE}/HL7Bench.Scratch.cls")`,
    ];


/** Flag names whose VALUE follows, so a --check filter is not read as one. */
const VALUES = new Set(["--class", "--script", "--doctype", "--method", "-o", "--out"]);

/** Segments of a golden file, compared the way check.ts compares them. */
function segmentsOf(raw: string): string[] {
  return raw.split(/\r\n|\r|\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
}

let removed: string[] = [];

/**
 * Write the scratch class into the engine and compile it.
 *
 * Hoisted out of the single-message path so `--check` can run a whole golden
 * suite in ONE session: the class is built once and every case calls it.
 */
function buildScratch(): string[] {
  let bodyRaw: string;
  try {
    // Read as BYTES first. PowerShell 5.1's `>` writes UTF-16LE, so a class
    // saved with `bun emit.ts process > My.cls` arrives with a NUL between
    // every character -- not text with a problem, text that matches no pattern
    // at all.
    const decoded = decodeText(readFileSync(scriptFile!));
    if (decoded.note) {
      process.stderr.write(`\n  ${scriptFile} is ${decoded.note}; decoded it as text\n`);
    }
    bodyRaw = decoded.text;
  } catch (e) {
    die(
      2,
      `--script names ${scriptFile}, which could not be read.`,
      `  it said        ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const extracted = extractBody(bodyRaw, methodName);
  process.stderr.write(`\n  read ${scriptFile} as ${extracted.found}\n`);
  const prepared = prepareBody(extracted.body, extracted.firstLine);
  removed = prepared.removed;
  if (removed.length > 0) {
    process.stderr.write(`\n  ${removed.length} line(s) removed before compiling:\n`);
    for (const r of removed) process.stderr.write(`    ${r}\n`);
    process.stderr.write(`\n`);
  }

  let carried: Carried;
  try {
    carried = classMethodsOf(bodyRaw, methodName);
  } catch (e) {
    die(2, `${scriptFile}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (carried.names.length > 0) {
    process.stderr.write(`  carried along from the class: ${carried.names.join(", ")}\n`);
  }

  const literal = scratchClass(prepared.body, docType, carried.text)
    .split(/\r?\n/)
    .map((l) => `do sf.WriteLine(${osLiteral(l)})`)
    .join("\n");

  return [
    `set sf=##class(%Stream.FileCharacter).%New()`,
    `set sc=sf.LinkToFile("${REMOTE}/HL7Bench.Scratch.cls")`,
    literal,
    `do sf.%Save()`,
    // `$system.Status.IsOK` and not `$$$ISERR`. This is a piped TERMINAL
    // session, and a session has no include file: a `$$$` macro here is not a
    // macro, it is a syntax error, and the session carries on past it.
    `set sc=$system.OBJ.Load("${REMOTE}/HL7Bench.Scratch.cls","ck-d")`,
    `if '$system.Status.IsOK(sc) { write "ERR|",$system.Status.GetErrorText(sc),! halt }`,
    `if '##class(%Dictionary.CompiledClass).%ExistsId("HL7Bench.Scratch") { write "ERR|HL7Bench.Scratch did not compile",! ${cleanup.join(" ")} halt }`,
  ];
}

const scratchSetup = scriptFile ? buildScratch() : [];


// ---------------------------------------------------------------------------
// --check: the golden gate, run by the ENGINE instead of by the spec
// ---------------------------------------------------------------------------

/**
 * `check.ts` proves the SPEC against the golden files. This proves the CLASS
 * against the same ones.
 *
 * That matters for the case where the class is the artifact you actually
 * maintain -- written in Studio, deployed from Studio -- and the bench is here
 * to keep it honest rather than to generate it. Without this there is no
 * regression gate for that way of working at all: you could run one message
 * through `engine.ts`, eyeball it, and learn nothing about the other six.
 *
 * Same file convention as `check.ts`, same folder, so a golden set serves both:
 *
 *     <name>.in.hl7  +  <name>.want.hl7     must produce exactly that
 *     <name>.reject.hl7                     must produce no message at all
 *
 * One engine session for every case, not one per case. A session costs a second
 * or two on Windows and a suite of eight would spend most of its time starting.
 */
if (checkMode) {
  const DIR = join(import.meta.dir, "messages");
  if (!existsSync(DIR)) die(2, `No messages\\ folder to check against.`);

  const files = readdirSync(DIR);
  // The first bare word that is not a flag's VALUE. Skipping only the flag
  // names would read "--script My.cls" as a case filter of "my.cls".
  let filter: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (VALUES.has(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    filter = a.toLowerCase();
    break;
  }

  type Case = { name: string; input: string; want: string[] | null };
  const cases: Case[] = [];
  for (const f of files) {
    if (f.endsWith(".in.hl7")) {
      const name = f.slice(0, -".in.hl7".length);
      const want = `${name}.want.hl7`;
      if (!files.includes(want)) {
        process.stderr.write(`SKIP  ${name}  -- has ${f} but no ${want}\n`);
        continue;
      }
      cases.push({ name, input: f, want: segmentsOf(decodeText(readFileSync(join(DIR, want))).text) });
    } else if (f.endsWith(".reject.hl7")) {
      cases.push({ name: f.slice(0, -".reject.hl7".length), input: f, want: null });
    }
  }

  const chosen = filter ? cases.filter((c) => c.name.toLowerCase().includes(filter)) : cases;
  if (chosen.length === 0) {
    die(2, filter ? `No cases matching "${filter}".` : `No cases in messages\\.`);
  }

  const call = className
    ? `set tsc = ##class(${className}).Transform(src,.tgt)`
    : `set tsc = ##class(HL7Bench.Scratch).Run(src,.tgt)`;

  const body: string[] = [];
  for (const c of chosen) {
    body.push(
      // `kill tgt` first, or a case that produces nothing reports the PREVIOUS
      // case's message and passes for the wrong reason.
      `kill tgt,src,st`,
      `set st=##class(%Stream.FileCharacter).%New(), sc=st.LinkToFile("${REMOTE}/${c.input}")`,
      `set src=##class(EnsLib.HL7.Message).ImportFromLibraryStream(st,.sc)`,
      `write "CASE|${c.name}",!`,
      `if '$IsObject($G(src)) { write "CASEERR|could not read ${REMOTE}/${c.input}",! } else {`,
      `  do src.PokeDocType("${docType}")`,
      `  ${call}`,
      `  if $IsObject($G(tgt)) { for i=1:1:tgt.SegCount { write "SEG|",tgt.GetSegmentAt(i).OutputToString(),! } } else { write "REFUSED|",! }`,
      `}`,
    );
  }

  const script = [
    `zn "${NAMESPACE}"`,
    ...(className ? [] : scratchSetup),
    ...body,
    ...(className ? [] : cleanup),
    `halt`,
  ].join("\n");

  const { out } = runIris("engine", script, (o) => o.includes("CASE|"));
  const raw = out.split(/\r?\n/).map((l) => l.replace(/\r+$/, ""));

  let failed = 0;
  let current: string | null = null;
  const got = new Map<string, string[] | null>();
  for (const l of raw) {
    if (l.startsWith("CASE|")) { current = l.slice(5); got.set(current, null); continue; }
    if (current === null) continue;
    if (l.startsWith("SEG|")) {
      const list = got.get(current) ?? [];
      list.push(l.slice(4));
      got.set(current, list);
    } else if (l.startsWith("CASEERR|")) {
      got.set(current, ["\u0000" + l.slice(8)]);
    }
  }

  for (const c of chosen) {
    const actual = got.get(c.name);
    if (actual === undefined) {
      process.stdout.write(`FAIL  ${c.name}  the engine reported nothing for this case\n`);
      failed++;
      continue;
    }
    if (actual && actual[0]?.startsWith("\u0000")) {
      process.stdout.write(`FAIL  ${c.name}  ${actual[0].slice(1)}\n`);
      failed++;
      continue;
    }
    if (c.want === null) {
      if (actual === null) process.stdout.write(`PASS  ${c.name}  refused, as a reject case must be\n`);
      else { process.stdout.write(`FAIL  ${c.name}  delivered ${actual.length} segment(s); a reject case must produce none\n`); failed++; }
      continue;
    }
    if (actual === null) {
      process.stdout.write(`FAIL  ${c.name}  produced no message, but ${c.name}.want.hl7 expects ${c.want.length} segment(s)\n`);
      failed++;
      continue;
    }
    const n = Math.max(c.want.length, actual.length);
    const bad: string[] = [];
    for (let i = 0; i < n; i++) {
      const a = c.want[i] ?? "(no segment)";
      const b = actual[i] ?? "(no segment)";
      if (a !== b) bad.push(`    ${i + 1}\n      want   ${a}\n      got    ${b}${invisible(a, b, "want", "got")}`);
    }
    if (bad.length === 0) process.stdout.write(`PASS  ${c.name}  ${actual.length} segments identical\n`);
    else { process.stdout.write(`FAIL  ${c.name}  ${bad.length} of ${n} segment(s) differ\n` + bad.join("\n") + `\n`); failed++; }
  }

  process.stdout.write(`\n${chosen.length - failed}/${chosen.length} cases passed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

let objectScript: string;

if (className) {
  objectScript = [
    ...preamble,
    `set tsc = ##class(${className}).Transform(src,.tgt)`,
    `write "STATUS|",$system.Status.GetErrorText(tsc),!`,
    ...dump("tgt"),
    `halt`,
  ].join("\n");
} else if (scriptFile) {
  objectScript = [
    `zn "${NAMESPACE}"`,
    ...scratchSetup,
    ...preamble,
    `set tsc = ##class(HL7Bench.Scratch).Run(src,.tgt)`,
    `write "STATUS|",$system.Status.GetErrorText(tsc),!`,
    // Dump BEFORE the cleanup, because `dump` halts on a missing target and a
    // halt must not be what skips the delete.
    ...dump("tgt", cleanup),
    ...cleanup,
    `halt`,
  ].join("\n");
} else {
  die(
    2,
    `Name the code to run: --class for a DTL, --script for a method body.`,
    ``,
    `  --class  Site.Interface.Dtl.Bar        calls Transform(source, .target)`,
    `  --script OnRequest.body             compiles the body into a scratch class`,
  );
}

/** An ObjectScript string literal. Quotes double; nothing else is special. */
function osLiteral(s: string): string {
  return `"${s.split('"').join('""')}"`;
}

// ---------------------------------------------------------------------------

const { out } = runIris("engine", objectScript, (o) => o.includes("OUT|") || o.includes("ERR|") || o.includes("NONE|"));

const lines = out.split(/\r?\n/);
const marked = (tag: string) =>
  lines
    .filter((l) => l.startsWith(tag + "|"))
    // Trailing CR only, never trailing spaces. `irisdb.exe` on Windows echoes a
    // carriage return of its own and the pipe adds CRLF, so a line arrives as
    // "...\r\r\n"; splitting on /\r?\n/ eats one and leaves the other. Measured
    // on the work PC: every one of eight segments differed from the bench by a
    // single U+000D and by nothing else.
    //
    // A trailing SPACE is left alone. It is legal content in an HL7 field, and
    // a comparison that quietly trims it would hide a real difference in the
    // one tool whose whole job is to find them.
    .map((l) => l.slice(tag.length + 1).replace(/\r+$/, ""));

const err = marked("ERR");
if (err.length > 0) {
  const aboutTheFile = err.some((e) => e.includes("could not read"));
  die(
    1,
    `The engine refused before it could run anything.`,
    ...err.map((e) => `  ${e}`),
    ...(aboutTheFile
      ? [
          ``,
          `A message is read from ${remoteFile} INSIDE the engine, not from the path`,
          `you typed. Point IRIS_LAB_DIR at a folder the engine can see -- on a native`,
          `Windows instance that is the messages folder of THIS workspace.`,
        ]
      : [
          ``,
          `That is a compile error in the code you gave --script, not a problem with`,
          `the message. Re-run with --keep-scratch and open ${REMOTE}/HL7Bench.Scratch.cls`,
          `in Studio; its line numbers match what was compiled.`,
        ]),
  );
}

const none = marked("NONE");
if (none.length > 0) {
  process.stdout.write(`\n  ${none[0]}\n`);
  process.stdout.write(`  For a gate that filters this event, that is the correct answer.\n\n`);
  process.exit(0);
}

const status = marked("STATUS")[0] ?? "";
const segments = marked("OUT");

const engineOut = segments.join("\n");
// deliverText prints to stdout when there is no -o, so this is the only write.
await deliverText(engineOut + "\n", outArg("engine", argv));

process.stderr.write(
  `\n  engine   ${engineLabel()}\n` +
    `  doctype  ${docType}\n` +
    `  ran      ${className ? `##class(${className}).Transform` : `${scriptFile} as HL7Bench.Scratch`}\n` +
    `  in       ${local!.segments.length} segment(s)   out  ${segments.length} segment(s)\n` +
    (status.trim() ? `  status   ${status}\n` : ``),
);

// ---------------------------------------------------------------------------
// --diff: does the spec agree with the code?
// ---------------------------------------------------------------------------

/**
 * Where two segments diverge, when they LOOK the same.
 *
 * A diff that prints two identical-looking lines and calls them different is
 * worse than no diff: it reads as a bug in the comparison. The difference is
 * real and invisible -- a trailing carriage return, a non-breaking space, a
 * padded line off a console transport -- so the first differing position gets
 * named with the character code on each side.
 */
function invisible(a: string, b: string, left = "spec", right = "engine"): string {
  const show = (s: string, i: number) => {
    if (i >= s.length) return "(end of line)";
    const c = s.charCodeAt(i);
    const printable = c >= 0x20 && c !== 0x7f;
    return `${printable ? `"${s[i]}" ` : ""}U+${c.toString(16).toUpperCase().padStart(4, "0")}`;
  };

  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) continue;
    return (
      `\n    differ at character ${i + 1} of ${Math.max(a.length, b.length)}` +
      ` -- ${left} ${show(a, i)}, ${right} ${show(b, i)}` +
      (a.length !== b.length ? `  (lengths ${a.length} and ${b.length})` : "")
    );
  }
  return "";
}

if (wantDiff) {
  const { runSpec } = await import("./run");
  const mine = new Message(raw);
  let specOut: string[];
  try {
    runSpec(spec, mine);
    specOut = mine.segments.map((s) => s.toString());
  } catch (e) {
    process.stderr.write(
      `\n  The spec refused this message: ${e instanceof Error ? e.message : String(e)}\n` +
        `  Nothing to compare. The gate is a decision, not a failure.\n\n`,
    );
    process.exit(0);
  }

  const n = Math.max(specOut.length, segments.length);
  const bad: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = specOut[i] ?? "(no segment)";
    const b = segments[i] ?? "(no segment)";
    if (a !== b) bad.push(`  ${i + 1}\n    spec   ${a}\n    engine ${b}${invisible(a, b)}`);
  }

  process.stderr.write(`\n  DIFF  spec vs engine\n`);
  if (bad.length === 0) {
    process.stderr.write(
      `  identical -- ${segments.length} segment(s), byte for byte\n\n`,
    );
  } else {
    process.stderr.write(
      `  ${bad.length} of ${n} segment(s) differ\n\n` + bad.join("\n") + `\n\n`,
    );
    process.exit(1);
  }
}
