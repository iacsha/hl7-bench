/**
 * scratch.ts -- the members of a class file that travel with the method under test.
 *
 * WHY THIS EXISTS
 *
 * `engine.ts --script` lifts one method body out of a class and compiles it into
 * `HL7Bench.Scratch`. A body written by hand usually stands alone. A body the
 * bench EMITS with `iris.process.transform: "inline"` does not: every read goes
 * through `..ValueAt(...)`, a ClassMethod declared beside `OnRequest` in the same
 * class, because `GetValueAt` on an absent segment throws. Lift the body alone
 * and the scratch class has no `ValueAt`, so the compile reports fifteen
 * `No such method 'ValueAt'` errors about a class that is fine.
 *
 * So the other ClassMethods come along, whole. Not instance Methods: the body is
 * compiled into a ClassMethod (see engine.ts for why), and `..Foo()` from a
 * ClassMethod cannot reach an instance method however it is copied. A body that
 * calls one fails to compile and names it, which is the honest answer.
 *
 * Brace matching, not a parser -- the same trade `extractBody` makes, for the
 * same reason.
 */

export type Carried = {
  /** Method names, in file order. */
  names: string[];
  /** The declarations, whole, ready to paste into a class body. */
  text: string;
};

/** The name the scratch class gives the lifted body. A helper cannot share it. */
export const SCRATCH_METHOD = "Run";

/**
 * Every ClassMethod in `raw` other than `except`, with its leading `///` lines.
 *
 * Returns nothing for a file that is not a class, because a bare body has no
 * siblings to carry.
 */
export function classMethodsOf(raw: string, except: string): Carried {
  if (!/^\s*Class\s+[\w.%]+\s+Extends/m.test(raw)) return { names: [], text: "" };

  const lines = raw.split(/\r?\n/);
  const names: string[] = [];
  const blocks: string[] = [];
  const sig = /^\s*ClassMethod\s+([\w%]+)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const m = sig.exec(lines[i]!);
    if (!m || m[1] === except) continue;

    // Doc comments above the signature belong to it.
    let start = i;
    while (start > 0 && /^\s*\/\/\//.test(lines[start - 1]!)) start--;

    // Walk to the brace that closes the body.
    let depth = 0;
    let opened = false;
    let end = -1;
    for (let j = i; j < lines.length && end === -1; j++) {
      for (const ch of lines[j]!) {
        if (ch === "{") {
          depth++;
          opened = true;
        } else if (ch === "}") {
          depth--;
          if (opened && depth === 0) {
            end = j;
            break;
          }
        }
      }
    }
    if (end === -1) throw new Error(`ClassMethod ${m[1]} has an unclosed body.`);

    names.push(m[1]!);
    blocks.push(lines.slice(start, end + 1).join("\n"));
    i = end;
  }

  if (names.includes(SCRATCH_METHOD)) {
    throw new Error(
      `The class declares a ClassMethod named ${SCRATCH_METHOD}, which is the name the ` +
        `scratch class gives the method under test. Rename one of them.`,
    );
  }
  return { names, text: blocks.join("\n\n") };
}
