/**
 * sheet.test.ts -- the mapping document as a spreadsheet.
 *
 * The assertions that matter here are about what Excel does to data it is
 * given, not about what this code emits in isolation. A test that only checked
 * "the cell says 01" would pass while Excel showed 1.
 */

import { describe, expect, test } from "bun:test";
import { csvCell, sheetName, toCsv, toXlsx, type Sheet } from "./sheet";

describe("csv quoting", () => {
  test("quotes a value carrying a comma", () => {
    expect(csvCell("DOE,JOHN")).toBe('"DOE,JOHN"');
  });

  test("doubles an embedded quote", () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  test("quotes a value carrying a newline", () => {
    expect(csvCell("a\nb")).toBe('"a\nb"');
  });

  test("leaves HL7 delimiters alone -- they are not CSV delimiters", () => {
    expect(csvCell("TEST^RECV~SECOND")).toBe("TEST^RECV~SECOND");
  });

  // Excel evaluates a cell beginning with any of these. A mapping document is
  // read by people who did not write it, on machines we do not control.
  for (const lead of ["=", "+", "-", "@"]) {
    test(`defuses a value beginning with ${lead}`, () => {
      expect(csvCell(`${lead}cmd`)).toBe(`'${lead}cmd`);
    });
  }

  test("rows join with CRLF and end with one", () => {
    expect(toCsv([["a", "b"], ["c", "d"]])).toBe("a,b\r\nc,d\r\n");
  });
});

describe("sheet names", () => {
  test("strips what Excel refuses", () => {
    expect(sheetName("A/B:C?")).toBe("A B C");
  });

  test("caps at 31 characters", () => {
    expect(sheetName("x".repeat(40))).toHaveLength(31);
  });

  test("an empty name still produces a sheet", () => {
    expect(sheetName("   ")).toBe("Sheet");
  });
});

describe("xlsx", () => {
  const sheets: Sheet[] = [
    { name: "Mapping", rows: [["Target", "Final"], ["GT1-48", "01"], ["PID-7", "19680101"]] },
    { name: "About", rows: [["Item", "Value"], ["Spec", "Demo"]] },
  ];

  test("is a zip Excel will open", () => {
    const out = toXlsx(sheets);
    // PK\x03\x04 -- a local file header, so it is a zip and not a text file
    // with an .xlsx name on it, which is the failure this replaces.
    expect(out[0]).toBe(0x50);
    expect(out[1]).toBe(0x4b);
    expect(out[2]).toBe(0x03);
    expect(out[3]).toBe(0x04);
  });

  test("carries the parts Excel requires", () => {
    const text = new TextDecoder().decode(toXlsx(sheets));
    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
    ]) {
      expect(text).toContain(part);
    }
  });

  test("every cell is an inline string, so a leading zero survives", () => {
    const text = new TextDecoder().decode(toXlsx(sheets));
    expect(text).toContain('t="inlineStr"');
    expect(text).toContain("<t xml:space=\"preserve\">01</t>");
    // Nothing is written as a number. A numeric cell is where 01 becomes 1
    // and 19680101 becomes a date.
    expect(text).not.toContain('t="n"');
  });

  test("escapes XML rather than producing a file Excel offers to repair", () => {
    const text = new TextDecoder().decode(
      toXlsx([{ name: "S", rows: [["a & b <c>", "d'e"]] }]),
    );
    expect(text).toContain("a &amp; b &lt;c&gt;");
  });

  test("drops control characters XML 1.0 cannot carry", () => {
    const text = new TextDecoder().decode(
      toXlsx([{ name: "S", rows: [["bad\u0003value"]] }]),
    );
    // Not asserted against the whole file: a zip's own local file header is
    // literally PK\x03\x04, so "no 0x03 anywhere" can never hold.
    expect(text).toContain("badvalue");
    expect(text).not.toContain("bad\u0003value");
  });

  test("names both sheets", () => {
    const text = new TextDecoder().decode(toXlsx(sheets));
    expect(text).toContain('name="Mapping"');
    expect(text).toContain('name="About"');
  });

  test("freezes and filters the header row", () => {
    const text = new TextDecoder().decode(toXlsx(sheets));
    expect(text).toContain('state="frozen"');
    expect(text).toContain("<autoFilter");
  });

  test("an empty cell is omitted rather than written empty", () => {
    const text = new TextDecoder().decode(toXlsx([{ name: "S", rows: [["a", "", "c"]] }]));
    expect(text).toContain('r="A1"');
    expect(text).not.toContain('r="B1"');
    expect(text).toContain('r="C1"');
  });
});
