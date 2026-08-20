/**
 * tables.ts -- a spreadsheet becomes a `spec.tables` entry.
 *
 *   bun tables.ts Facilities < facilities.csv
 *   bun tables.ts Facilities --module < facilities.csv > tables.facilities.ts
 *   bun tables.ts Sex --key 2 --value 3 --delim tab < codes.txt
 *
 * WHY THIS GOES TO TYPESCRIPT AND NOT STRAIGHT TO XML
 *
 * Straight to XML is one step shorter and it breaks the thing the bench is for.
 * The rows would live in a file the bench cannot read, so `lookup()` on the
 * bench would translate nothing while the same interface in IRIS translated
 * fine, and the two would disagree exactly where you were relying on them to
 * agree. `spec.tables` stays the single source: the bench runs off it, the
 * emitted class warns about it when it is empty, and `emit/lookup.ts` turns it
 * into the import file. One place to be wrong instead of two.
 *
 * WHAT THIS IS FOR
 *
 * Facility tables, department tables, provider crosswalks. The ones that arrive
 * as a spreadsheet with four hundred rows in it and are otherwise retyped by
 * hand, which is how a code gets a trailing space and a whole facility stops
 * routing.
 *
 * THE TRIM, WHICH IS NOT COSMETIC
 *
 * Keys and values are trimmed, and the count is reported. A trailing space in a
 * key is invisible in every editor and in the portal, survives a copy-paste, and
 * makes `Lookup` miss. It is the single commonest defect in a hand-built table.
 * Trimming is a behaviour change though, not tidying, so it is announced rather
 * than done quietly. `--no-trim` if you have a table whose keys really do carry
 * spaces, which does happen with some free-text department names.
 */

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC4180-ish rows out of a delimited file.
 *
 * Handles what Excel actually writes: quoted fields, doubled quotes inside a
 * quoted field, delimiters and newlines inside quotes, and CRLF. Does not handle
 * a file whose quoting is broken halfway through, because there is no correct
 * answer for that and guessing produces a table that is subtly wrong instead of
 * loudly absent.
 */
export function parseCsv(input: string, delim = ","): string[][] {
  if (delim.length !== 1) throw new Error(`Delimiter must be one character, got "${delim}"`);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  // A UTF-8 BOM in front of the first header cell is what Excel writes by
  // default, and it makes column 1's name silently not match anything.
  if (input.charCodeAt(0) === 0xfeff) i = 1;

  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  while (i < input.length) {
    const c = input[i];

    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }

    if (c === '"' && field === "") { quoted = true; i++; continue; }
    if (c === delim) { endField(); i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { endRow(); i++; continue; }

    field += c; i++;
  }

  // A file with no trailing newline still has a last row, and it is usually the
  // one that matters least and annoys most when it goes missing.
  if (field !== "" || row.length > 0) endRow();

  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

// ---------------------------------------------------------------------------
// Rows to a table
// ---------------------------------------------------------------------------

export interface TableOptions {
  /** 1-based column number for the key. */
  key: number;
  /** 1-based column number for the value. */
  value: number;
  /** Drop the first row. */
  header: boolean;
  trim: boolean;
}

export interface TableResult {
  rows: Record<string, string>;
  /** Fatal: refuse to emit. */
  errors: string[];
  /** Worth saying, not worth stopping for. */
  warnings: string[];
  /** How many keys or values had surrounding whitespace removed. */
  trimmed: number;
  /** Input rows considered, header excluded. */
  read: number;
}

export function toTable(csv: string[][], opts: TableOptions): TableResult {
  const result: TableResult = { rows: {}, errors: [], warnings: [], trimmed: 0, read: 0 };
  const body = opts.header ? csv.slice(1) : csv;

  const k = opts.key - 1;
  const v = opts.value - 1;
  if (k < 0 || v < 0) {
    result.errors.push("Column numbers are 1-based; --key 0 is not a column.");
    return result;
  }

  let blanks = 0;

  for (const [n, cells] of body.entries()) {
    // Line number as the person would count it in Excel, header included.
    const line = n + 1 + (opts.header ? 1 : 0);
    result.read++;

    if (cells.length <= Math.max(k, v)) {
      result.errors.push(
        `line ${line}: only ${cells.length} column(s), need at least ${Math.max(opts.key, opts.value)}. ` +
          `Usually the wrong --delim, or a stray delimiter inside an unquoted cell.`,
      );
      continue;
    }

    const rawKey = cells[k];
    const rawValue = cells[v];
    const key = opts.trim ? rawKey.trim() : rawKey;
    const value = opts.trim ? rawValue.trim() : rawValue;
    if (key !== rawKey || value !== rawValue) result.trimmed++;

    if (key === "") {
      result.errors.push(`line ${line}: empty key. Lookup is never called with an empty key.`);
      continue;
    }
    if (value === "") blanks++;

    if (key in result.rows) {
      // Same key twice with the same value is a spreadsheet with duplicate rows
      // in it, which is untidy. With DIFFERENT values it is two people who
      // disagree about what a code means, and picking one silently is how the
      // wrong one ends up in production.
      if (result.rows[key] === value) {
        result.warnings.push(`line ${line}: "${key}" appears more than once with the same value`);
      } else {
        result.errors.push(
          `line ${line}: "${key}" is already mapped to "${result.rows[key]}" and this row says "${value}". ` +
            `Decide which is right in the source file; this tool will not pick one.`,
        );
      }
      continue;
    }

    result.rows[key] = value;
  }

  if (blanks > 0) {
    result.warnings.push(
      `${blanks} row(s) have an empty value. Lookup returns your default for a blank value ` +
        `exactly as it does for a missing key, so those rows behave as though they are not there.`,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A legal bare identifier does not need quoting; anything else does. */
function propName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/**
 * The property block to paste into `spec.tables`.
 *
 * Keys are always quoted even when they look like identifiers, because lookup
 * keys are codes and a code that happens to be `01` is not the number 1. Quoting
 * uniformly also means a column of codes stays visually a column.
 */
export function renderTable(name: string, rows: Record<string, string>): string {
  const entries = Object.entries(rows);
  const body = entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  return [`${propName(name)}: {`, ...body, `},`].join("\n") + "\n";
}

/** A standalone importable file, for a table too big to sit inside a spec. */
export function renderModule(name: string, rows: Record<string, string>, source: string): string {
  const entries = Object.entries(rows);
  return [
    `/**`,
    ` * ${name} -- ${entries.length} row(s), generated by tables.ts from ${source}.`,
    ` *`,
    ` * Regenerate rather than editing by hand, and keep the source file with it:`,
    ` * a hand-edit here is a row that no longer exists anywhere else.`,
    ` *`,
    ` *   bun tables.ts ${name} --module < ${source} > ${"<this file>"}`,
    ` *`,
    ` * Used from the spec as:`,
    ` *`,
    ` *   import { ${propName(name)} } from "./<this file without .ts>";`,
    ` *   tables: { ${propName(name)} },`,
    ` */`,
    ``,
    `export const ${propName(name)}: Record<string, string> = {`,
    ...entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`),
    `};`,
    ``,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** `--delim tab` is here because a tab is not typeable as an argument. */
function delimiterFrom(word: string): string {
  const named: Record<string, string> = {
    tab: "\t", comma: ",", semicolon: ";", pipe: "|", bar: "|",
  };
  const d = named[word.toLowerCase()] ?? word;
  if (d.length !== 1) throw new Error(`Delimiter must be one character or a name (tab, comma, semicolon, pipe), got "${word}"`);
  return d;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);

  // Flags that consume the next argument. Anything else beginning with "--" is
  // a switch, and the first bare word is the table name. Spelled out rather
  // than inferred, so `--delim tab Facilities` reads the same as
  // `Facilities --delim tab` instead of taking "tab" for the table name.
  const TAKES_VALUE = new Set(["--delim", "--key", "--value", "--from"]);
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const bare: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (TAKES_VALUE.has(a)) { values.set(a.slice(2), argv[++i] ?? ""); continue; }
    if (a.startsWith("--")) { switches.add(a.slice(2)); continue; }
    bare.push(a);
  }

  const flag = (name: string) => values.get(name);
  const has = (name: string) => switches.has(name);
  const name = bare[0];

  if (!name || has("help")) {
    process.stderr.write(
      [
        `Usage: bun tables.ts <TableName> [options] < file.csv`,
        ``,
        `  --module          a complete importable .ts file instead of a paste block`,
        `  --delim <c|name>  column separator: a character, or tab/comma/semicolon/pipe`,
        `  --key <n>         1-based key column, default 1`,
        `  --value <n>       1-based value column, default 2`,
        `  --no-header       the first row is data, not column names`,
        `  --no-trim         keep surrounding whitespace in keys and values`,
        `  --from <name>     source file name to record in --module output`,
        ``,
        `The first row is treated as a header unless you pass --no-header.`,
        ``,
      ].join("\n"),
    );
    process.exit(has("help") ? 0 : 2);
  }

  const input = process.stdin.isTTY ? "" : await Bun.stdin.text();
  if (input.trim() === "") {
    process.stderr.write(`Nothing on stdin. Pipe a file: bun tables.ts ${name} < file.csv\n`);
    process.exit(2);
  }

  let delim = ",";
  try {
    if (flag("delim") !== undefined) delim = delimiterFrom(flag("delim")!);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
  }

  const csv = parseCsv(input, delim);
  const result = toTable(csv, {
    key: Number(flag("key") ?? 1),
    value: Number(flag("value") ?? 2),
    header: !has("no-header"),
    trim: !has("no-trim"),
  });

  for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);

  if (result.errors.length > 0) {
    process.stderr.write(`\n${result.errors.length} problem(s), nothing written:\n`);
    // Capped: a wrong --delim produces one error per line, and four hundred
    // copies of the same sentence buries the sentence.
    for (const e of result.errors.slice(0, 20)) process.stderr.write(`  - ${e}\n`);
    if (result.errors.length > 20) {
      process.stderr.write(`  ... and ${result.errors.length - 20} more, all likely the same cause\n`);
    }
    process.exit(1);
  }

  const count = Object.keys(result.rows).length;
  const source = flag("from") ?? "the piped file";

  process.stdout.write(
    has("module") ? renderModule(name, result.rows, source) : renderTable(name, result.rows),
  );

  process.stderr.write(`\n${count} row(s) from ${result.read} line(s).\n`);
  if (result.trimmed > 0) {
    process.stderr.write(
      `${result.trimmed} row(s) had surrounding whitespace removed. That is a behaviour change, ` +
        `not tidying: an untrimmed key never matches. --no-trim to keep it.\n`,
    );
  }
}
