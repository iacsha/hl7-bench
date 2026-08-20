/**
 * draft.ts -- crash-safe autosave for the GUI, deliberately NOT a save.
 *
 * The GUI has exactly one way to write `transform.ts`, and that is Ctrl+Enter.
 * That single door is load-bearing: it validates first, it takes the one
 * `transform.ts.bak` of the session before the first rewrite, and it means the
 * file on disk is always something a person looked at and approved. An autosave
 * that wrote `transform.ts` on a timer would quietly take all three away -- the
 * backup slot would be spent on whatever half-finished state existed five
 * minutes in, and the file PipeHat picks up would become something nobody
 * chose.
 *
 * So the timer writes somewhere else. A draft is a copy of the spec you are
 * editing, parked under `logs/autosave/`, that the page offers back to you if
 * the browser, the machine or the power goes away mid-edit. Recovering it is a
 * decision you make on the next load. Nothing here ever touches `transform.ts`.
 *
 * WHY A DRAFT IS WRITTEN EVEN WHEN THE SPEC IS INVALID
 *
 * `/run` refuses an invalid spec on purpose: a file on disk the CLI would
 * reject is worse than an unsaved edit. A draft is the mirror image of that
 * argument. Half-finished work is invalid almost by definition -- an empty
 * target, a lookup with no table yet -- and that is precisely the state you
 * most want back after a crash. Validating here would throw away the only
 * copies worth having.
 *
 * WHAT IS AND IS NOT IN THE FILE
 *
 * The spec, and nothing else. In particular NOT the message pane. That pane is
 * the one place in this GUI where a real message sits, and a timer that copied
 * it to disk every five minutes would be a PHI leak nobody asked for and
 * nobody would notice. Message text is saved only when you press "Save
 * message" and name the file. `logs/` is gitignored, which is a seatbelt, not
 * permission.
 *
 * STALENESS IS DECIDED BY MTIME, NOT BY BOOKKEEPING
 *
 * A draft is stale when `transform.ts` has been modified since the draft was
 * taken. That single rule covers both ways a draft stops being interesting:
 * you pressed Ctrl+Enter (the GUI wrote the file), or you edited transform.ts
 * in another editor. Tracking it with a flag instead would be correct only for
 * the first case, and the second is the one that bites, because a hand edit
 * leaves no trace the GUI could see.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { Spec } from "./spec";

const ROOT = import.meta.dir;

/** Bumped if the on-disk shape changes. A draft from an older version is dropped, not guessed at. */
export const DRAFT_VERSION = 1;

export interface Draft {
  version: number;
  /** Which transform.ts this belongs to, for the human reading the folder. */
  transformFile: string;
  /** The spec's own name at the time, same reason. */
  specName: string;
  savedAt: string;
  savedAtMs: number;
  spec: Spec;
}

/**
 * Where the draft for a given transform file lives.
 *
 * Keyed on the FILE, not on `spec.name`. The case that matters most is a
 * `transform.ts` that no longer imports -- a hand edit gone wrong -- and in
 * that case there is no spec and therefore no name to key on. The file path is
 * always known.
 */
export function draftPath(transformPath: string): string {
  const stem = basename(transformPath).replace(/\.ts$/i, "");
  return join(ROOT, "logs", "autosave", `${stem}.draft.json`);
}

/** Said once per process, for the same reason log.ts says its failures once. */
let warned = false;
function warnOnce(msg: string): void {
  if (warned) return;
  warned = true;
  process.stderr.write(`hl7-bench: ${msg}\n`);
}

/**
 * Take a draft. Returns what was written, or null if the disk refused.
 *
 * A failed draft write is reported once and then ignored. The alternative is a
 * timer that throws every five minutes into a page that is working fine, which
 * trains you to ignore the status line -- and the status line is where the
 * "edited, not written" reminder lives.
 */
export function writeDraft(transformPath: string, spec: Spec, now = new Date()): Draft | null {
  const draft: Draft = {
    version: DRAFT_VERSION,
    transformFile: basename(transformPath),
    specName: spec?.name ?? "(unnamed)",
    savedAt: now.toISOString(),
    savedAtMs: now.getTime(),
    spec,
  };
  const file = draftPath(transformPath);
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(draft, null, 2), "utf8");
    return draft;
  } catch (e) {
    warnOnce(`could not write ${file}: ${(e as Error).message}; autosave off for this session`);
    return null;
  }
}

export interface DraftLookup {
  draft: Draft | null;
  /** True when a draft exists but transform.ts has moved on since it was taken. */
  stale: boolean;
}

/**
 * Read the draft for a transform file and say whether it still means anything.
 *
 * Every failure mode returns `{draft: null}` rather than throwing. This is
 * called from `/state`, which is the request that renders the whole page: a
 * corrupt JSON file in a log folder must not be able to stop the GUI from
 * loading. It is a recovery aid, not a dependency.
 */
export function readDraft(transformPath: string): DraftLookup {
  const file = draftPath(transformPath);
  if (!existsSync(file)) return { draft: null, stale: false };

  let draft: Draft;
  try {
    draft = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    warnOnce(`ignoring unreadable draft ${file}: ${(e as Error).message}`);
    return { draft: null, stale: false };
  }

  if (draft?.version !== DRAFT_VERSION || !draft.spec || typeof draft.savedAtMs !== "number") {
    return { draft: null, stale: false };
  }

  // A transform.ts younger than the draft means the file was written after the
  // draft was taken -- by Ctrl+Enter, or by an editor. Either way the draft
  // describes a past that has been superseded, and offering it would invite
  // undoing a real save. A missing transform.ts is not stale: there is nothing
  // for the draft to be older than, and the draft may be all that is left.
  let stale = false;
  try {
    if (existsSync(transformPath)) stale = statSync(transformPath).mtimeMs > draft.savedAtMs;
  } catch {
    stale = false;
  }

  return { draft, stale };
}

/** Throw the draft away. Missing file is success: the point is that it is gone. */
export function discardDraft(transformPath: string): boolean {
  try {
    rmSync(draftPath(transformPath), { force: true });
    return true;
  } catch (e) {
    warnOnce(`could not remove ${draftPath(transformPath)}: ${(e as Error).message}`);
    return false;
  }
}
