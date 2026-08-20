// bun test
//
// This is the tool that turns four hundred spreadsheet rows into a lookup
// table, so the failures worth testing are the quiet ones. A wrong delimiter
// that produces a one column table. A key with a trailing space that is
// invisible in every editor and never matches. The same code appearing twice
// with two different meanings, where picking one silently is how the wrong one
// reaches production.

import { expect, test, describe } from "bun:test";

import { parseCsv, toTable, renderTable, renderModule, type TableOptions } from "./tables";

const opts = (over: Partial<TableOptions> = {}): TableOptions => ({
  key: 1,
  value: 2,
  header: true,
  trim: true,
  ...over,
});

describe("parseCsv", () => {
  test("plain rows", () => {
    expect(parseCsv("a,b\nc,d\n")).toEqual([["a", "b"], ["c", "d"]]);
  });

  test("a last row with no trailing newline is still a row", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([["a", "b"], ["c", "d"]]);
  });

  test("CRLF, which is what a Windows export writes", () => {
    expect(parseCsv("a,b\r\nc,d\r\n")).toEqual([["a", "b"], ["c", "d"]]);
  });

  test("a delimiter inside quotes is data, not a column break", () => {
    expect(parseCsv(`"SMITH, JOHN",x\n`)).toEqual([["SMITH, JOHN", "x"]]);
  });

  test("a doubled quote inside a quoted field is one quote", () => {
    expect(parseCsv(`"say ""hi""",x\n`)).toEqual([[`say "hi"`, "x"]]);
  });

  test("a newline inside quotes stays in the field", () => {
    expect(parseCsv(`"two\nlines",x\n`)).toEqual([["two\nlines", "x"]]);
  });

  // Excel writes this by default and it makes column 1's header silently not
  // match anything, which reads as "my file is fine, the tool is broken".
  test("a UTF-8 BOM is not part of the first cell", () => {
    expect(parseCsv("﻿code,name\n")).toEqual([["code", "name"]]);
  });

  test("blank lines are dropped rather than becoming empty rows", () => {
    expect(parseCsv("a,b\n\nc,d\n")).toEqual([["a", "b"], ["c", "d"]]);
  });

  test("a tab delimited file", () => {
    expect(parseCsv("a\tb\n", "\t")).toEqual([["a", "b"]]);
  });

  test("a delimiter of more than one character is refused, not guessed", () => {
    expect(() => parseCsv("a,b", ",,")).toThrow(/one character/);
  });

  test("an empty cell is an empty string, not a missing column", () => {
    expect(parseCsv("a,,c\n")).toEqual([["a", "", "c"]]);
  });
});

describe("toTable", () => {
  test("header row is dropped and the rest becomes the table", () => {
    const r = toTable([["code", "name"], ["M", "MALE"]], opts());
    expect(r.rows).toEqual({ M: "MALE" });
    expect(r.read).toBe(1);
    expect(r.errors).toEqual([]);
  });

  test("--no-header keeps the first row", () => {
    const r = toTable([["M", "MALE"]], opts({ header: false }));
    expect(r.rows).toEqual({ M: "MALE" });
  });

  test("key and value columns can be anywhere", () => {
    const r = toTable([["x", "M", "MALE"]], opts({ header: false, key: 2, value: 3 }));
    expect(r.rows).toEqual({ M: "MALE" });
  });

  test("column numbers are 1-based and 0 is refused", () => {
    const r = toTable([["M", "MALE"]], opts({ header: false, key: 0 }));
    expect(r.errors[0]).toContain("1-based");
    expect(r.rows).toEqual({});
  });

  // The commonest real failure: a semicolon file read as comma. Every line
  // becomes one column, and the error says which knob to turn.
  test("a row too short to hold both columns names the likely cause", () => {
    const r = toTable([["M;MALE"]], opts({ header: false }));
    expect(r.errors[0]).toContain("only 1 column");
    expect(r.errors[0]).toContain("--delim");
  });

  test("line numbers count the way Excel counts, header included", () => {
    const r = toTable([["code", "name"], ["a", "1"], [""]], opts());
    expect(r.errors[0]).toStartWith("line 3:");
  });

  test("an empty key is an error and the row is dropped", () => {
    const r = toTable([["", "MALE"], ["F", "FEMALE"]], opts({ header: false }));
    expect(r.errors[0]).toContain("empty key");
    expect(r.rows).toEqual({ F: "FEMALE" });
  });

  test("empty values warn once with a count, and are kept", () => {
    const r = toTable([["A", ""], ["B", ""]], opts({ header: false }));
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual({ A: "", B: "" });
    expect(r.warnings.filter((w) => w.includes("empty value"))).toHaveLength(1);
    expect(r.warnings.join(" ")).toContain("2 row(s)");
  });
});

describe("trimming, which is a behaviour change and so is counted", () => {
  test("surrounding whitespace comes off and the count is reported", () => {
    const r = toTable([[" M ", " MALE"]], opts({ header: false }));
    expect(r.rows).toEqual({ M: "MALE" });
    expect(r.trimmed).toBe(1);
  });

  test("a clean table reports no trims, so the number means something", () => {
    expect(toTable([["M", "MALE"]], opts({ header: false })).trimmed).toBe(0);
  });

  test("--no-trim keeps the space, for department names that really carry one", () => {
    const r = toTable([[" M ", "MALE"]], opts({ header: false, trim: false }));
    expect(r.rows).toEqual({ " M ": "MALE" });
    expect(r.trimmed).toBe(0);
  });

  // Without the trim these are two different keys, and the second silently
  // wins nothing while the first silently never matches.
  test("trimming can turn two rows into a duplicate, and that is caught", () => {
    const r = toTable([["M ", "MALE"], ["M", "FEMALE"]], opts({ header: false }));
    expect(r.errors[0]).toContain("already mapped");
  });
});

describe("duplicate keys", () => {
  test("the same value twice is untidy, so a warning", () => {
    const r = toTable([["M", "MALE"], ["M", "MALE"]], opts({ header: false }));
    expect(r.errors).toEqual([]);
    expect(r.warnings[0]).toContain("more than once");
    expect(r.rows).toEqual({ M: "MALE" });
  });

  test("two different values is two people disagreeing, so a refusal", () => {
    const r = toTable([["M", "MALE"], ["M", "MAN"]], opts({ header: false }));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain(`"M" is already mapped to "MALE"`);
    expect(r.errors[0]).toContain("will not pick one");
  });

  test("the first mapping is the one kept, so the report and the rows agree", () => {
    const r = toTable([["M", "MALE"], ["M", "MAN"]], opts({ header: false }));
    expect(r.rows.M).toBe("MALE");
  });
});

describe("rendering", () => {
  test("a paste block for spec.tables", () => {
    expect(renderTable("Sex", { M: "MALE" })).toBe(`Sex: {\n  "M": "MALE",\n},\n`);
  });

  // A code that happens to be 01 is not the number 1, and an unquoted key would
  // make it one. Quoting is unconditional for that reason.
  test("numeric-looking keys stay quoted strings", () => {
    expect(renderTable("T", { "01": "x" })).toContain(`"01": "x",`);
  });

  test("a table name that is not an identifier gets quoted", () => {
    expect(renderTable("has-dash", { a: "b" })).toStartWith(`"has-dash": {`);
  });

  test("a quote in a value cannot break out of the generated source", () => {
    expect(renderTable("T", { k: `a"b` })).toContain(`"k": "a\\"b",`);
  });

  test("an empty table still renders as valid syntax", () => {
    expect(renderTable("T", {})).toBe(`T: {\n},\n`);
  });

  test("the module records the row count and the source file", () => {
    const mod = renderModule("Facilities", { A: "1", B: "2" }, "facilities.csv");
    expect(mod).toContain("2 row(s)");
    expect(mod).toContain("facilities.csv");
    expect(mod).toContain(`export const Facilities: Record<string, string> = {`);
    expect(mod).toContain("Regenerate rather than editing by hand");
  });
});

describe("end to end, the way it is actually used", () => {
  test("a quoted spreadsheet with a comma in a name survives the round trip", () => {
    const csv = `code,name\r\n001,"MOUNT ST. MARY'S, WEST"\r\n002, GENERAL \r\n`;
    const r = toTable(parseCsv(csv), opts());
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual({ "001": "MOUNT ST. MARY'S, WEST", "002": "GENERAL" });
    expect(r.trimmed).toBe(1);
    expect(renderTable("Facilities", r.rows)).toContain(`"001": "MOUNT ST. MARY'S, WEST",`);
  });
});
