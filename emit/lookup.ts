/**
 * emit/lookup.ts -- `spec.tables` becomes a file the Data Lookup Tables page imports.
 *
 * WHY THIS IS A SEPARATE ARTIFACT AND NOT PART OF THE CLASS
 *
 * A lookup table is namespace DATA. It is not in the class, it is not in the
 * production, and it is not in an export of either. Promote an interface from
 * dev to QA the careful way -- export the classes, export the production, import
 * both -- and the tables do not come with it. Nothing warns you. `Lookup`
 * returns the default for every message, so a translation table silently stops
 * translating and an allowlist silently refuses everything. The interface is
 * green, the queue is empty, and the receiver gets nothing.
 *
 * That is a thing you currently have to REMEMBER. This turns it into a file that
 * travels beside the class export.
 *
 * VERIFY THE SHAPE ONCE, ON YOUR VERSION
 *
 * The element names below are the ones the lookup table import reads. They have
 * been stable for a long time, but "a long time" is not "your namespace", and an
 * import that does not match is rejected with a message about the document
 * rather than about the table. So the first time you use this: export a table
 * you already have from the portal, run this, and diff the two. Thirty seconds,
 * once, and then you trust it.
 *
 *   Interoperability > Configure > Data Lookup Tables > Export
 *
 * WHAT IT REFUSES AND WHY
 *
 * An empty KEY is refused outright: `Lookup` on an empty string is the case the
 * emitted class already guards against, so a row keyed on nothing can only ever
 * be dead weight or a CSV column that shifted.
 *
 * An empty VALUE is warned about loudly and still emitted, because it is
 * sometimes what you mean and it is always dangerous: `Lookup` returns your
 * default when the key is missing AND when the row's value is blank. The two are
 * indistinguishable from inside the interface. In a translation table that is a
 * cosmetic surprise. In an allowlist it is a facility you meant to permit that
 * gets refused as though it were never listed.
 */

import type { Spec } from "../spec";

// ---------------------------------------------------------------------------

/**
 * Escape for XML text and attributes both.
 *
 * Quotes are escaped even in text position, which is more than the spec
 * requires. Lookup values are things like `MOUNT ST. MARY'S` and the cost of
 * being over-careful here is four characters; the cost of being under-careful is
 * a rejected import at 6am with an error that names a line number.
 */
function xml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Characters XML 1.0 cannot carry at all, escaped or otherwise.
 *
 * Tab, newline and carriage return are legal; the rest of C0 is not. They arrive
 * from CSV exports and from copy-paste out of terminal windows, they are
 * invisible in every editor, and they produce an import failure that describes
 * the file rather than the row. Naming the row is the entire value here.
 */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Tab (9), newline (10) and carriage return (13) are the three C0 characters
    // XML allows. Everything else below 0x20 is unrepresentable.
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) return true;
  }
  return false;
}

export interface LookupProblem {
  table: string;
  key: string;
  problem: string;
  /** False when the row is emitted anyway. */
  fatal: boolean;
}

export interface LookupResult {
  xml: string;
  /** Table name to row count, in spec order. */
  counts: Record<string, number>;
  problems: LookupProblem[];
}

// ---------------------------------------------------------------------------

/**
 * Build the import document for some or all of the spec's tables.
 *
 * `only` selects one table by name. Absent, every table in the spec goes into
 * one document, which is what the import page accepts and what you want beside a
 * class export: one file, one import, nothing to forget half of.
 */
export function buildLookup(spec: Spec, only?: string): LookupResult {
  const all = spec.tables ?? {};

  if (only !== undefined && !(only in all)) {
    const known = Object.keys(all);
    throw new Error(
      known.length === 0
        ? `No table named "${only}": this spec declares no tables at all.`
        : `No table named "${only}". This spec has: ${known.join(", ")}`,
    );
  }

  const names = only !== undefined ? [only] : Object.keys(all);
  const problems: LookupProblem[] = [];
  const counts: Record<string, number> = {};

  const lines = [`<?xml version="1.0" encoding="UTF-8"?>`, `<lookupTable>`];

  for (const table of names) {
    const rows = all[table];
    counts[table] = 0;

    if (hasControlChar(table)) {
      problems.push({ table, key: "", problem: "table name holds a control character", fatal: true });
      continue;
    }

    for (const [key, value] of Object.entries(rows)) {
      if (key === "") {
        problems.push({
          table, key,
          problem: `empty key. Lookup is never called with an empty key by the emitted class, so this row can only be a mistake or a shifted CSV column.`,
          fatal: true,
        });
        continue;
      }
      if (hasControlChar(key) || hasControlChar(value)) {
        problems.push({
          table, key,
          problem: `holds a control character XML cannot carry. Invisible in an editor, and the import will reject the whole document without naming this row.`,
          fatal: true,
        });
        continue;
      }
      if (value === "") {
        problems.push({
          table, key,
          problem: `empty value. Lookup returns your default for a blank value exactly as it does for a missing key, so this row is indistinguishable from not being here. In an allowlist that is a permitted code being refused.`,
          fatal: false,
        });
      }

      lines.push(`<entry table="${xml(table)}" key="${xml(key)}">${xml(value)}</entry>`);
      counts[table]++;
    }
  }

  lines.push(`</lookupTable>`, ``);
  return { xml: lines.join("\n"), counts, problems };
}
