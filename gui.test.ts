/**
 * gui.test.ts -- the browser module has to parse, and its position maths has
 * to be right.
 *
 * Nothing else in the repo covers `gui.html`. Its script is one inline module,
 * and a module with a syntax error does not execute AT ALL -- no error in the
 * page, no half-working GUI, just a set of controls that quietly do nothing.
 * That is exactly how a stray real newline inside a string literal shipped once
 * and took the whole GUI with it. So the first test here parses the module, and
 * the rest lift the pure position helpers out of it and run them, because
 * parsing proves only that the file is JavaScript.
 *
 * The helpers are pulled out by source text rather than imported, since an
 * inline module has nothing to import from. That is ugly and it is deliberate:
 * the alternative is a build step in a repo whose whole point is that it has
 * no dependencies and no build step.
 */

import { expect, test, describe } from "bun:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./gui.html", import.meta.url), "utf8");

/** The one inline module, without its script tag. */
function moduleSource(): string {
  const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("gui.html has no inline module");
  return m[1];
}

/** One top-level `function name(...)` declaration, braces balanced. */
function declaration(js: string, name: string): string {
  const start = js.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`gui.html has no function ${name}`);
  let depth = 0;
  for (let i = js.indexOf("{", start); i < js.length; i++) {
    if (js[i] === "{") depth++;
    else if (js[i] === "}" && --depth === 0) return js.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

describe("the inline module", () => {
  test("parses", async () => {
    // Bun's transpiler is the same parser the browser would use closely enough
    // to catch the failure that matters: a literal that never closes.
    const out = new Bun.Transpiler({ loader: "js" }).transformSync(moduleSource());
    expect(out.length).toBeGreaterThan(0);
  });

  test("has no string literal broken across a line", () => {
    // The specific damage, named. A backslash-n that became a real newline
    // parses as an unterminated string, and the message the parser gives points
    // at the line AFTER the mistake, which is why it went unnoticed.
    const offenders: string[] = [];
    for (const line of moduleSource().split("\n")) {
      const code = line.split("//")[0];
      for (const q of ['"', "'"]) {
        const n = (code.match(new RegExp(String.raw`(?<!\\)(?<!\\\\\\\\)` + q, "g")) ?? []).length;
        if (n % 2 === 1 && code.trimEnd().endsWith(q)) offenders.push(line.trim());
      }
    }
    expect(offenders).toEqual([]);
  });
});

// The position helpers, evaluated out of the page. `delimsOf` is stubbed
// because it reaches for the HL7 parser, which the pure maths does not need.
const helpers = (() => {
  const js = moduleSource();
  const stub = `function delimsOf() { return { field: "|", comp: "^", rep: "~", esc: "\\\\", sub: "&" }; }`;
  const src = [stub, ...["occurrences", "sliceAt", "hl7Path", "positionLabel"].map((n) => declaration(js, n))].join("\n\n");
  return new Function(`${src}; return { hl7Path, positionLabel };`)() as {
    hl7Path: (line: string, d: Delims, field: number, charInField?: number) => string;
    positionLabel: (raw: string, line: number, field: number, charInField?: number) => string;
  };
})();

type Delims = { field: string; comp: string; rep: string; esc: string; sub: string };
const D: Delims = { field: "|", comp: "^", rep: "~", esc: "\\", sub: "&" };

const MSH = "MSH|^~\\&|SEND|SFAC|RECV|RFAC|20260101||ADT^A28|1|D|2.3";
const PID = "PID|1||MRN123^^^SITE^MR||LAST^FIRST^M||19800101|M|||1 ST^^CITY^ST^12345";
const NK1 = "NK1|1|KIN^ONE|SPO~ALT";

describe("MSH is numbered the way HL7 defines it, not the way it splits", () => {
  // MSH-1 IS the field separator and MSH-2 IS the encoding characters, so the
  // segment id occupies the slot MSH-1 would take and every later field sits
  // one left of a naive pipe count. Getting this wrong is the single most
  // common off-by-one in a hand-written mapping.

  test("the id alone is the segment", () => {
    expect(helpers.hl7Path(MSH, D, 0)).toBe("MSH");
  });

  test("the first split field is MSH-2, not MSH-1", () => {
    expect(helpers.hl7Path(MSH, D, 1)).toBe("MSH-2");
  });

  test("MSH-2 is never broken into components", () => {
    // It is the field that DEFINES the component separator. Splitting it on ^
    // would report a component number for the character doing the splitting.
    expect(helpers.hl7Path(MSH, D, 1, 3)).toBe("MSH-2");
  });

  test("sending application is MSH-3", () => {
    expect(helpers.hl7Path(MSH, D, 2)).toBe("MSH-3");
  });

  test("message type components are numbered inside MSH-9", () => {
    expect(helpers.hl7Path(MSH, D, 8)).toBe("MSH-9.1");
    expect(helpers.hl7Path(MSH, D, 8, 4)).toBe("MSH-9.2");
  });
});

describe("an ordinary segment splits straight", () => {
  test("a component index appears when the field has components", () => {
    expect(helpers.hl7Path(PID, D, 5)).toBe("PID-5.1");
    expect(helpers.hl7Path(PID, D, 3, 12)).toBe("PID-3.4");
  });

  test("a field with no components gets no trailing dot", () => {
    // A path that is all ones is noise, and this is the one readout that gets
    // copied straight into a spec row.
    expect(helpers.hl7Path(PID, D, 7)).toBe("PID-7");
  });

  test("repetition shows only when the field repeats", () => {
    expect(helpers.hl7Path(NK1, D, 3)).toBe("NK1-3[1]");
    expect(helpers.hl7Path(NK1, D, 3, 5)).toBe("NK1-3[2]");
    expect(helpers.hl7Path(NK1, D, 2)).toBe("NK1-2.1");
  });
});

describe("the occurrence tail", () => {
  const msg = [MSH, PID, NK1, NK1].join("\n");

  test("a segment that appears once is named without a count", () => {
    expect(helpers.positionLabel(msg, 1, 5)).toBe("PID-5.1 · PID · line 2");
  });

  test("a repeated segment says which one it is", () => {
    // Which NK1 you are looking at is the question a repeat block is answering,
    // so it belongs in the readout rather than in a mental line count.
    expect(helpers.positionLabel(msg, 3, 1)).toBe("NK1-1 · NK1 #2 of 2 · line 4");
  });

  test("a blank line has no position", () => {
    expect(helpers.positionLabel("MSH|x\n\nPID|1", 1, 0)).toBe("");
  });

  test("a line index past the end has no position", () => {
    expect(helpers.positionLabel(msg, 99, 0)).toBe("");
  });
});
