/**
 * sheet.ts -- a grid of strings becomes a CSV or an XLSX, with no dependency.
 *
 * WHY XLSX AND NOT JUST CSV
 *
 * Excel rewrites a CSV as it opens it, and every rewrite it performs is wrong
 * for HL7. `01` becomes `1`, which is a relationship code that no longer
 * matches the lookup table it came from. `19680101` becomes a date and is
 * reformatted to the locale. A value beginning `=`, `+`, `-` or `@` is read as
 * a formula. The reviewer then signs off on values the interface never sends,
 * and nothing in the document says it happened.
 *
 * An XLSX cell written as `t="inlineStr"` is a string and stays a string. That
 * is the whole reason this file exists: the mapping document is handed to
 * somebody who will not verify it against the wire, so it has to be right in
 * the tool they open it with.
 *
 * `--csv` still ships, because plenty of things downstream of this are not
 * Excel. Its help text carries the warning rather than leaving it to be
 * discovered.
 *
 * WHY THIS IS HAND-ROLLED
 *
 * An XLSX is a zip of a few XML parts. The parts below are the minimum Excel
 * will open: content types, two relationship files, a workbook, one worksheet
 * per sheet, and a style table holding exactly one bold font. Writing them is
 * about two hundred lines. Taking a dependency to avoid those two hundred
 * lines would end the "no installer, no admin rights" property this tool is
 * built around, on the machine where it matters most -- a locked-down work
 * laptop that cannot reach npm.
 *
 * The zip entries are STORED, not deflated. Excel accepts stored entries, a
 * mapping document is small, and a CRC32 plus a header is a great deal less
 * code than a compressor.
 */

// ---------------------------------------------------------------------------
// The grid
// ---------------------------------------------------------------------------

export interface Sheet {
  /** Tab name. Excel refuses > 31 chars and the characters in SHEET_BAD. */
  name: string;
  /** First row is the header. Every cell is written as text, deliberately. */
  rows: string[][];
}

/** Excel refuses these in a sheet name, and refuses a name over 31 chars. */
const SHEET_BAD = /[\\/?*[\]:]/g;

export function sheetName(raw: string): string {
  const cleaned = raw.replace(SHEET_BAD, " ").trim() || "Sheet";
  return cleaned.slice(0, 31);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180 quoting: wrap when the value carries a comma, a quote or a newline,
 * and double an embedded quote.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a single quote. Excel treats
 * those as formulas otherwise, and a mapping document that executes anything is
 * a mapping document nobody should open. The prefix is visible in the cell,
 * which is ugly and is the correct trade -- a visibly odd value gets asked
 * about, a silently evaluated one does not.
 */
export function csvCell(value: string): string {
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function toCsv(rows: string[][]): string {
  // CRLF, because that is what RFC 4180 says and what Excel expects on the
  // platform this runs on.
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry {
  name: string;
  data: Uint8Array;
}

/**
 * A zip with stored entries.
 *
 * Local header, then the payload, then a central directory, then the end
 * record. No data descriptors, no zip64: a mapping document is kilobytes and
 * the formats that need either are formats this will never produce.
 */
function zip(entries: Entry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const crc = crc32(e.data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, 0, true); // time
    lv.setUint16(12, 0x0021, true); // date: 1980-01-01, so output is byte-stable
    lv.setUint32(14, crc, true);
    lv.setUint32(18, e.data.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);

    const dir = new Uint8Array(46 + name.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true); // central directory header
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint16(14, 0x0021, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, e.data.length, true);
    dv.setUint32(24, e.data.length, true);
    dv.setUint16(28, name.length, true);
    dv.setUint32(42, offset, true);
    dir.set(name, 46);

    chunks.push(local, e.data);
    central.push(dir);
    offset += local.length + e.data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central directory
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of [...chunks, ...central, end]) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** XML text escaping. `&` first, or the others get double-escaped. */
function xml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Strip what XML 1.0 cannot carry.
 *
 * HL7 is 7-bit in practice but a field can pick up a control character from a
 * sending system, and one of those in a worksheet makes Excel declare the whole
 * file unreadable and offer to repair it -- which reads as "this tool produces
 * corrupt files", not "MSH-3 has a 0x03 in it".
 */
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

/** A1, B1 ... Z1, AA1. */
function cellRef(col: number, row: number): string {
  let name = "";
  let n = col;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return `${name}${row}`;
}

function worksheet(sheet: Sheet): string {
  const widths = columnWidths(sheet.rows);
  const cols = widths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join("");

  const rows = sheet.rows
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          const v = clean(value ?? "");
          if (v === "") return "";
          // Every cell is an inline string. That is the entire point: `01` is
          // the code the interface sends, not the number one.
          const style = r === 0 ? ` s="1"` : "";
          return `<c r="${cellRef(c, r + 1)}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(v)}</t></is></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");

  const lastCol = cellRef(Math.max(0, (sheet.rows[0]?.length ?? 1) - 1), sheet.rows.length || 1);
  // Freeze the header and put an autofilter on it, so a reviewer can sort by
  // block or filter to the rows that came out empty without being taught how.
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${rows}</sheetData><autoFilter ref="A1:${lastCol}"/></worksheet>`;
}

/** Wide enough to read, capped so one long PV1 does not push everything off. */
function columnWidths(rows: string[][]): number[] {
  const n = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const widths: number[] = [];
  for (let c = 0; c < n; c++) {
    let w = 8;
    for (const r of rows) w = Math.max(w, (r[c] ?? "").length + 2);
    widths.push(Math.min(w, 60));
  }
  return widths;
}

export function toXlsx(sheets: Sheet[]): Uint8Array {
  const enc = new TextEncoder();
  const used = sheets.map((s, i) => ({ ...s, name: sheetName(s.name || `Sheet${i + 1}`) }));

  const sheetEntries = used.map((s, i) => ({
    name: `xl/worksheets/sheet${i + 1}.xml`,
    data: enc.encode(worksheet(s)),
  }));

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${used
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join("")}</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${used
    .map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("")}</sheets></workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${used
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
    )
    .join("")}<Relationship Id="rId${used.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

  // Two fonts, two cell formats: plain, and bold for the header row (s="1").
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;

  return zip([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rels) },
    { name: "xl/workbook.xml", data: enc.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(workbookRels) },
    { name: "xl/styles.xml", data: enc.encode(styles) },
    ...sheetEntries,
  ]);
}
