/**
 * fingerprint.ts -- a short hash of the spec, stamped into what it generates.
 *
 * THE QUESTION THIS ANSWERS
 *
 * "Am I running what I think I am running." Nothing in the portal answers it.
 * A DTL that was saved but not compiled, or compiled but not picked up by a
 * running production, looks byte-identical to the one you are reading in the
 * editor, and it behaves like the version before your change. That cost two
 * days on a live build: the mapping was correct the whole time and the
 * namespace was executing an older compile.
 *
 * So the emitted class carries a fingerprint of the spec it came from, and
 * `bun emit.ts` prints the same fingerprint on stderr. Two strings to compare
 * instead of two mappings to read.
 *
 * WHAT IT COVERS
 *
 * The whole spec, notes and labels included. That is deliberate. The narrow
 * version -- hash only the parts that change the ObjectScript -- sounds tidier
 * and is worse: it would report "same class" after you rewrote every label in
 * the trace document you are about to hand the receiver, which is a change you
 * very much want to see reflected somewhere.
 *
 * WHAT IT IS NOT
 *
 * Not a checksum of the class file. Editing the emitted `.cls` by hand does not
 * change the fingerprint in its header, because the fingerprint describes the
 * SPEC. A hand-edit that the spec does not know about is exactly the state this
 * repo exists to prevent, and a fingerprint cannot detect it. If you hand-edit
 * the class, the spec is now wrong and the fingerprint is now a lie.
 *
 * Not a security property either. It is a short hash for telling two versions
 * apart, not for proving nobody swapped one.
 */

import { createHash } from "node:crypto";
import type { Spec } from "./spec";

/**
 * JSON with every object key in sorted order, at every depth.
 *
 * `JSON.stringify` preserves insertion order, so moving a row's `label` above
 * its `from` would change the hash without changing the interface. Sorting
 * makes the fingerprint describe the CONTENT of the spec rather than the
 * typing order of the file. Arrays keep their order, because block order is
 * segment order and row order is assign order: both are real.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` is what an unset optional field looks like, and it is not the
    // same as the field being present. JSON.stringify drops it; so do we, so
    // that `{ note: undefined }` and `{}` fingerprint alike.
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Twelve hex characters of SHA-256 over the sorted spec.
 *
 * Twelve because it goes in a class header a person compares by eye. Full
 * SHA-256 in a `///` line is 64 characters nobody reads to the end of, and the
 * failure mode here is "these two differ", which the first few characters
 * answer. Collision risk across the handful of versions of one interface is not
 * a real concern; if it ever is, widen it, the callers only print it.
 */
export function fingerprint(spec: Spec): string {
  return createHash("sha256").update(stableStringify(spec)).digest("hex").slice(0, 12);
}
