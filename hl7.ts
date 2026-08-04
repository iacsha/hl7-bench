/**
 * A small HL7 v2 reader/writer. No dependencies, no install.
 *
 * Path syntax: SEG-F, SEG-F.C, SEG-F.C.S, with an optional repetition index:
 *   PID-5.1        family name
 *   PID-3(2).5     identifier type of the SECOND repetition of PID-3
 *   MSH-9.1        message code
 *
 * The MSH off-by-one is handled for you. MSH-1 *is* the field separator and
 * MSH-2 *is* the encoding characters, so a naive split puts everything on the
 * MSH line one position out. Every HL7 tool gets this wrong at least once.
 */

export interface Delims {
  field: string;
  comp: string;
  rep: string;
  esc: string;
  sub: string;
}

const DEFAULT_DELIMS: Delims = { field: "|", comp: "^", rep: "~", esc: "\\", sub: "&" };

const PATH_RE = /^([A-Z][A-Z0-9]{2})-(\d+)(?:\((\d+)\))?(?:\.(\d+))?(?:\.(\d+))?$/;

interface ParsedPath {
  seg: string;
  field: number;
  rep: number;
  comp: number | null;
  sub: number | null;
}

function parsePath(path: string): ParsedPath {
  const m = PATH_RE.exec(path.trim());
  if (!m) throw new Error(`Not a valid HL7 path: "${path}" (expected something like PID-5.1)`);
  return {
    seg: m[1],
    field: Number(m[2]),
    rep: m[3] ? Number(m[3]) : 1,
    comp: m[4] ? Number(m[4]) : null,
    sub: m[5] ? Number(m[5]) : null,
  };
}

export class Segment {
  constructor(
    readonly id: string,
    private parts: string[],
    private d: Delims,
  ) {}

  private get isMSH() {
    return this.id === "MSH";
  }

  /**
   * Array index holding field number `f`.
   *
   * Non-MSH: parts = ["PID", <PID-1>, <PID-2>, ...] so field f is at index f.
   * MSH:     parts = ["MSH", <MSH-2>, <MSH-3>, ...] because MSH-1 is the field
   *          separator itself and never appears in the split. So field f is at
   *          index f-1, and MSH-1 has no slot at all.
   */
  private indexOf(f: number): number {
    return this.isMSH ? f - 1 : f;
  }

  getField(f: number): string {
    if (this.isMSH && f === 1) return this.d.field;
    const i = this.indexOf(f);
    return i > 0 && i < this.parts.length ? this.parts[i] : "";
  }

  setField(f: number, value: string): void {
    if (this.isMSH && f === 1) throw new Error("MSH-1 is the field separator; it cannot be assigned");
    const i = this.indexOf(f);
    if (i <= 0) throw new Error(`Cannot assign ${this.id}-${f}`);
    while (this.parts.length <= i) this.parts.push("");
    this.parts[i] = value;
  }

  get(path: ParsedPath | string): string {
    const p = typeof path === "string" ? parsePath(path) : path;
    let v = this.getField(p.field);
    // MSH-2 *defines* the delimiters, so splitting it by them is circular:
    // "^~\&" contains the repetition separator and would come back as "^".
    if (this.isMSH && p.field === 2) return v;
    if (p.rep > 1 || v.includes(this.d.rep)) {
      v = v.split(this.d.rep)[p.rep - 1] ?? "";
    }
    if (p.comp === null) return v;
    v = v.split(this.d.comp)[p.comp - 1] ?? "";
    if (p.sub === null) return v;
    return v.split(this.d.sub)[p.sub - 1] ?? "";
  }

  set(path: ParsedPath | string, value: string): void {
    const p = typeof path === "string" ? parsePath(path) : path;

    if (p.comp === null && p.rep === 1 && !this.getField(p.field).includes(this.d.rep)) {
      this.setField(p.field, value);
      return;
    }

    const reps = this.getField(p.field).split(this.d.rep);
    while (reps.length < p.rep) reps.push("");

    if (p.comp === null) {
      reps[p.rep - 1] = value;
    } else {
      const comps = reps[p.rep - 1].split(this.d.comp);
      while (comps.length < p.comp) comps.push("");
      if (p.sub === null) {
        comps[p.comp - 1] = value;
      } else {
        const subs = comps[p.comp - 1].split(this.d.sub);
        while (subs.length < p.sub) subs.push("");
        subs[p.sub - 1] = value;
        comps[p.comp - 1] = subs.join(this.d.sub);
      }
      reps[p.rep - 1] = comps.join(this.d.comp);
    }
    this.setField(p.field, reps.join(this.d.rep));
  }

  /** How many repetitions field `f` currently has. */
  repCount(f: number): number {
    const v = this.getField(f);
    return v === "" ? 0 : v.split(this.d.rep).length;
  }

  toString(): string {
    return this.parts.join(this.d.field);
  }
}

export class Message {
  readonly delims: Delims;
  readonly segments: Segment[];

  constructor(raw: string) {
    const lines = raw
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length === 0) throw new Error("Empty message");

    const head = lines[0];
    if (!/^(MSH|FHS|BHS)/.test(head)) {
      throw new Error(`First segment is "${head.slice(0, 3)}", expected MSH/FHS/BHS`);
    }

    // Read the real delimiters out of the message rather than assuming them.
    // A message declaring "!" as its field separator is legal and does happen.
    const field = head[3] ?? "|";
    const enc = head.slice(4, head.indexOf(field, 4) === -1 ? 8 : head.indexOf(field, 4));
    this.delims = {
      field,
      comp: enc[0] ?? "^",
      rep: enc[1] ?? "~",
      esc: enc[2] ?? "\\",
      sub: enc[3] ?? "&",
    };

    this.segments = lines.map((line) => {
      const parts = line.split(this.delims.field);
      return new Segment(parts[0], parts, this.delims);
    });
  }

  /** First segment with this id, or undefined. */
  seg(id: string): Segment | undefined {
    return this.segments.find((s) => s.id === id);
  }

  /** Every segment with this id, in order. Use for OBX, NK1, DG1, IN1... */
  all(id: string): Segment[] {
    return this.segments.filter((s) => s.id === id);
  }

  get(path: string): string {
    const p = parsePath(path);
    const s = this.seg(p.seg);
    return s ? s.get(p) : "";
  }

  set(path: string, value: string): void {
    const p = parsePath(path);
    const s = this.seg(p.seg);
    if (!s) throw new Error(`No ${p.seg} segment in this message`);
    s.set(p, value);
  }

  toString(): string {
    return this.segments.map((s) => s.toString()).join("\r\n") + "\r\n";
  }
}
