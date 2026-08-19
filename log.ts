/**
 * log.ts -- an optional run log. Off unless you ask for it.
 *
 * The contract in README.md is: stdin in, stdout out, stderr diagnostics, no
 * install, no side effects. A tool that starts writing files because you ran
 * it breaks that contract silently for anyone piping it from PipeHat or a
 * shell script, so nothing here writes anything until an env var says so.
 *
 *   HL7_BENCH_LOG=summary    one line per run: counts, decisions, timings
 *   HL7_BENCH_LOG=full       the same line plus every diagnostic note verbatim
 *   HL7_BENCH_LOG=off        silence, including the authoring log
 *   HL7_BENCH_LOG_FILE=path  somewhere other than logs/hl7-bench.log
 *
 * `summary` and `full` are two levels for a PHI reason, not a verbosity one.
 * Almost every note the bench raises is a path or a count. One is not: an
 * unmapped lookup interpolates the source VALUE that missed the table
 * (`run.ts`), and nothing stops a table being keyed on PID-3. A gate refusal
 * on a `require` rule does the same with whatever that rule reads. So at
 * `summary` no note text is ever written, only how many there were. Choosing
 * `full` is you deciding the notes on this feed are safe to land on disk.
 * `logs/` is gitignored either way, which is a seatbelt, not permission.
 *
 * Paths resolve against this file, not the working directory, so `logs/` ends
 * up next to the bench no matter where you invoked it from.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export type LogLevel = "off" | "summary" | "full";

const ROOT = import.meta.dir;

// ---------------------------------------------------------------------------

const warned = new Set<string>();

/**
 * Say a thing once per process.
 *
 * A log that cannot be written is worth exactly one line of stderr. Repeating
 * it per record would bury the actual output of a bench run under complaints
 * about the bookkeeping.
 */
function warnOnce(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  process.stderr.write(`hl7-bench: ${msg}\n`);
}

/** Set after a failed write, so a read-only `logs/` is reported once and dropped. */
let dead = false;

// ---------------------------------------------------------------------------

/**
 * What HL7_BENCH_LOG asks for.
 *
 * An unrecognised value warns rather than being read as either extreme.
 * `HL7_BENCH_LOG=true` silently meaning off would hide the log from someone
 * who thinks they turned it on; silently meaning `full` would put note text
 * on disk that nobody asked for.
 */
export function logLevel(): LogLevel {
  const v = (process.env.HL7_BENCH_LOG ?? "").trim().toLowerCase();
  if (v === "summary" || v === "full") return v;
  if (v === "" || v === "off") return "off";
  warnOnce(`HL7_BENCH_LOG="${v}" is not off, summary or full; logging stays off`);
  return "off";
}

/**
 * What the GUI authoring log runs at, which is ON by default.
 *
 * The bench is a filter and defaults to leaving no trace. The GUI is not: a
 * `Ctrl+Enter` already rewrites `transform.ts` and drops a `.bak` beside it.
 * It is already a tool that touches your disk, so a record of what it touched
 * is not a new surprise, it is the missing half of one. An explicit
 * `HL7_BENCH_LOG=off` still silences it.
 */
export function authoringLevel(): LogLevel {
  if ((process.env.HL7_BENCH_LOG ?? "").trim() === "") return "summary";
  return logLevel();
}

/** Where run records go. */
export function benchLogPath(): string {
  const set = process.env.HL7_BENCH_LOG_FILE?.trim();
  if (set) return isAbsolute(set) ? set : join(ROOT, set);
  return join(ROOT, "logs", "hl7-bench.log");
}

/**
 * Where GUI authoring records go.
 *
 * Deliberately not affected by HL7_BENCH_LOG_FILE. The two logs answer
 * different questions -- "what did this message do" and "what did I change" --
 * and someone redirecting the run log into a pipeline does not want spec edits
 * interleaved into it.
 */
export function authoringLogPath(): string {
  return join(ROOT, "logs", "authoring.log");
}

// ---------------------------------------------------------------------------

export interface LogFields {
  [key: string]: string | number | undefined;
}

/** Quote only when a value would otherwise break `key=value` splitting. */
function q(v: string | number): string {
  const s = String(v);
  return s === "" || /[\s"]/.test(s) ? JSON.stringify(s) : s;
}

function line(tool: string, fields: LogFields): string {
  const parts = [new Date().toISOString(), `tool=${tool}`];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${q(v)}`);
  }
  return parts.join("  ");
}

function emit(file: string, level: LogLevel, tool: string, fields: LogFields, notes: string[]): void {
  if (dead) return;
  let text = line(tool, fields) + "\n";
  if (level === "full") {
    for (const n of notes) text += `    note: ${n}\n`;
  }
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, text, "utf8");
  } catch (e) {
    dead = true;
    warnOnce(`could not write ${file}: ${(e as Error).message}; logging off for this run`);
  }
}

/**
 * Record one bench-side event.
 *
 * `notes` is always counted and only written at `full`. Pass the raw notes;
 * do not pre-filter at the call site, or the two levels stop being one
 * decision made in one place.
 */
export function logEvent(tool: string, fields: LogFields, notes: string[] = []): void {
  const level = logLevel();
  if (level === "off") return;
  emit(benchLogPath(), level, tool, { ...fields, notes: notes.length }, notes);
}

/** Record one GUI authoring event. Same shape, different file and default. */
export function logAuthoring(fields: LogFields, notes: string[] = []): void {
  const level = authoringLevel();
  if (level === "off") return;
  emit(authoringLogPath(), level, "gui", { ...fields, notes: notes.length }, notes);
}
