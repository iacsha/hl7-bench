/**
 * style.ts -- how a generated class READS, kept apart from what it DOES.
 *
 * The spec is the interface: what arrives, what leaves, and why. That is the
 * same wherever the interface runs. How the ObjectScript is laid out -- whether
 * a write is checked, whether Mapping catches, tabs or spaces -- is a SITE
 * preference, and two teams can hold opposite ones for good reasons. Putting
 * those preferences in the spec would make every interface carry one shop's
 * taste; putting them in the emitter would make the tool carry it.
 *
 * So a site keeps a style file, named by HL7_BENCH_STYLE (a path, like
 * HL7_BENCH_TRANSFORM), and gitignored as `*.local.json` so a workplace's
 * conventions never reach the public repo:
 *
 *     { "extends": "lean", "indent": "tab", "keywords": "Set" }
 *
 * With no file, the style is `defensive`, which is exactly what the house
 * backends wrote before this file existed.
 *
 * STYLE NEVER CHANGES THE MESSAGE
 *
 * Every knob below changes how a line is written or whether a failure is
 * reported. None changes what is delivered when nothing fails. That is what
 * lets a site pick its style without re-proving the mapping -- and it is held
 * by a test that emits every vocabulary kind under every preset.
 *
 * Applies to iris.process.transform "patch" and "build", the house-style
 * backends. "dtl" and "inline" are unchanged.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { COMMENT_LEVELS, type CommentLevel } from "./spec";

export interface Style {
  /** Shown in the class header, so a class says which conventions made it. */
  name: string;
  /**
   * `checked` wraps every SetValueAt and RemoveSegmentAt in $$$ThrowOnError,
   * so a write that fails sends the message to the error queue. `unchecked`
   * writes `Do`, and a failed write leaves the field missing and says nothing.
   *
   * THE TRADE, PLAINLY: a write fails when its path does not resolve under the
   * DocType. `unchecked` rests on two claims -- the schema does not change
   * under a deployed class, and the golden gate (`bun engine.ts --check`)
   * catches a path that does not resolve before the class is deployed. Where
   * both hold, the checks are lines that can never fire.
   *
   * `accumulate` is the middle: one plain line per write,
   * `Set tSC = $$$ADDSC(tSC,call)`, no throw and no try, and Mapping returns
   * the sum. A failed write does not stop the mapping; the message is refused
   * at the send, and the error queue lists EVERY write that failed, not the
   * first. Reads like `unchecked`, and nothing is ignored -- a peer review
   * of a lean class flagged the ignored statuses (2026-09-29).
   */
  writes: "checked" | "unchecked" | "accumulate";
  /**
   * Whether Mapping has its own try/catch. Without one, Mapping returns $$$OK
   * and OnRequest calls it with `Do` -- unless writes are `accumulate`, where
   * Mapping returns the summed write status and OnRequest checks it. A runtime
   * error (an exception, not a status) still reaches OnRequest's catch,
   * because exceptions propagate.
   */
  mappingTry: boolean;
  /**
   * The dispatch. `checked` is the only line in the class that can fail at run
   * time for a reason the class does not control -- a config item name that
   * does not resolve, a production that is not running. `unchecked` loses such
   * a message without a trace. Offered because it is a preference; defaulted
   * because it is the one check that pays for itself.
   */
  send: "checked" | "unchecked";
  /**
   * What an event the interface does not handle leaves behind.
   * `trace` is invisible in a production that is not tracing, which is every
   * production; `info` lands in the Event Log as $$$LOGINFO.
   */
  filteredOut: "trace" | "info" | "warning" | "silent";
  indent: "tab" | 2 | 4;
  /** How commands are written: `Set`, `If`, `For` or `set`, `if`, `for`. */
  keywords: "Set" | "set";
  /** `generator` names the tool and the spec fingerprint; `none` omits that line. */
  header: "generator" | "none";
  /** Overrides iris.comments when set. */
  comments?: CommentLevel;
  /**
   * How this site stores a filter expression, with `{expr}` where the
   * expression goes, e.g. `eval = {expr}`. Printed by `bun emit.ts` beside the
   * bare expression. A site's routing convention lives here and not in the
   * tool, so the tracked repo never names one.
   */
  filterWrap?: string;
}

export const PRESETS: Record<string, Style> = {
  defensive: {
    name: "defensive",
    writes: "checked",
    mappingTry: true,
    send: "checked",
    filteredOut: "trace",
    indent: "tab",
    keywords: "Set",
    header: "generator",
  },
  lean: {
    name: "lean",
    writes: "accumulate",
    mappingTry: false,
    send: "checked",
    filteredOut: "info",
    indent: 4,
    keywords: "set",
    header: "generator",
  },
};

export const DEFAULT_STYLE = PRESETS.defensive!;

const CHOICES: Record<string, readonly unknown[]> = {
  writes: ["checked", "unchecked", "accumulate"],
  mappingTry: [true, false],
  send: ["checked", "unchecked"],
  filteredOut: ["trace", "info", "warning", "silent"],
  indent: ["tab", 2, 4],
  keywords: ["Set", "set"],
  header: ["generator", "none"],
  comments: COMMENT_LEVELS,
};

/**
 * A style from a parsed file: its preset, then its own keys on top. Refuses an
 * unknown key or value by name -- a typo taking the default silently would
 * emit the other site's conventions and nobody would read that as a bug.
 */
export function resolveStyle(raw: Record<string, unknown>, from = "style"): Style {
  const base = raw.extends === undefined ? "defensive" : String(raw.extends);
  const preset = PRESETS[base];
  if (!preset) {
    throw new Error(`${from}: "extends" is "${base}". Use one of: ${Object.keys(PRESETS).join(", ")}.`);
  }
  const out: Style = { ...preset, name: raw.extends === undefined && Object.keys(raw).length === 0 ? base : `${base}+local` };
  for (const [k, v] of Object.entries(raw)) {
    if (k === "extends" || k === "$comment") continue;
    if (k === "name") { out.name = String(v); continue; }
    // Free text, so not in CHOICES. Without the placeholder the wrap would
    // print a filter with no expression in it, which reads as a finished one.
    if (k === "filterWrap") {
      if (typeof v !== "string" || !v.includes("{expr}")) {
        throw new Error(`${from}: "filterWrap" must be a string containing {expr}, e.g. "eval = {expr}".`);
      }
      out.filterWrap = v;
      continue;
    }
    const allowed = CHOICES[k];
    if (!allowed) throw new Error(`${from}: "${k}" is not a style setting. Known: ${[...Object.keys(CHOICES), "filterWrap"].join(", ")}.`);
    if (!allowed.includes(v)) {
      throw new Error(`${from}: "${k}" is ${JSON.stringify(v)}. Use one of: ${allowed.map((a) => JSON.stringify(a)).join(", ")}.`);
    }
    (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * The style in force: HL7_BENCH_STYLE's file, or the default. A named file that
 * does not exist is an error, never a quiet fall back to the default.
 */
export function loadStyle(env = process.env.HL7_BENCH_STYLE): Style {
  if (!env || env.trim() === "") return DEFAULT_STYLE;
  if (PRESETS[env]) return PRESETS[env]!;
  const path = resolve(env);
  if (!existsSync(path)) {
    throw new Error(`HL7_BENCH_STYLE names ${path}, which does not exist. Unset it for the default style.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    throw new Error(`HL7_BENCH_STYLE: ${path} is not valid JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`HL7_BENCH_STYLE: ${path} must hold one JSON object.`);
  }
  return resolveStyle(raw as Record<string, unknown>, path);
}

/** A write or remove, as this style writes it. `call` is e.g. `tRequest.SetValueAt(x,"PID:3")`. */
export function styledWrite(style: Style, call: string): string {
  if (style.writes === "checked") return `$$$ThrowOnError(${call})`;
  if (style.writes === "accumulate") return `Set tSC = $$$ADDSC(tSC,${call})`;
  return `Do ${call}`;
}

/**
 * Whether Mapping can return an error status. When it can, OnRequest checks
 * it; a `Do` there would throw the status away, which is the one thing
 * accumulate exists to stop.
 */
export function mappingReturnsStatus(style: Style): boolean {
  return style.mappingTry || style.writes === "accumulate";
}

const COMMANDS = ["Set", "If", "ElseIf", "Else", "For", "While", "Quit", "Return", "Do"];

/**
 * The finished class, laid out: indent and command case. Applied to the whole
 * text last, so every piece of the emitter writes one canonical form (tabs,
 * `Set`) and none of it has to know the site's taste.
 *
 * Commands are recognised only where ObjectScript puts one -- first on a line,
 * or straight after a condition's `)`, a `{` or a `}` -- and never on a
 * comment line, so a word inside a string or a note is left alone.
 */
export function layout(style: Style, text: string): string {
  const unit = style.indent === "tab" ? "\t" : " ".repeat(style.indent);
  const lower = style.keywords === "set";
  const cmd = new RegExp(`(^|[){}] )(${COMMANDS.join("|")})(?=[ {(]|$)`, "g");
  return text
    .split("\n")
    .map((line) => {
      const m = /^(\t*)(.*)$/.exec(line)!;
      let body = m[2]!;
      if (lower && !/^\/\//.test(body)) {
        body = body.replace(cmd, (_all, pre: string, w: string) => pre + w.toLowerCase());
      }
      return unit.repeat(m[1]!.length) + body;
    })
    .join("\n");
}
