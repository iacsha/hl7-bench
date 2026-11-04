// bun test
//
// The pure half of the overlay. The engine half -- that a generated region
// compiles inside somebody else's class and moves exactly the fields it says --
// was proven on IRIS for Health 2026.1 (lab, 2026-11-04) with
// `bun overlay.ts ... --run` against a clone-and-patch process shaped like a
// real vendor ADT class: DG1-3 into PV2-3, no PV2 (nothing written), no DG1
// (nothing changed), a pre-admit (still filtered), fromFirst skipping an empty
// first DG1, a grouped IN1, a two-step chain and a lookup.

import { describe, expect, test } from "bun:test";

import {
  BEGIN, END, applyRegion, diffLines, diffMessages, findAnchor, generate, indexBraced,
  keysFromZw, overlayClass, schemaFromKeys, validateOverlay, type Overlay,
} from "./overlay-core";
import { sendsWithoutTarget, writeThrough } from "./engine-core";
import { DEFAULT_STYLE } from "./style";

const KEYS = [
  "ACC", "AL1()", "DG1()", "EVN", "GT1()", "IN1grp().IN1", "IN1grp().IN2", "MSH", "NK1()",
  "PID", "PR1grp().PR1", "PR1grp().ROL()", "PV1", "PV2", "leftoversegs()",
];
const schema = schemaFromKeys("2.3:ADT_A01", KEYS);

const CLASS = `/// A clone-and-patch process
Class Acme.Process.ToReceiver Extends Ens.BusinessProcess [ ClassType = persistent ]
{

Method OnRequest(pRequest As EnsLib.HL7.Message, Output pResponse As Ens.Response) As %Status
{
    #dim tsc As %Status
    s tsc = $$$OK
    try{
        s tRequest = pRequest.%ConstructClone()
        if (##class(Acme.Common.UtilitySet).IsPreAdmit(pRequest)){
            return $$$OK
        }
        $$$ThrowOnError(..SendRequestAsync("ToReceiver.ADT.TCP",tRequest,0))
    } catch e{
        s tsc = e.AsStatus()
    }
    quit tsc
}

Storage Default
{
<Type>%Storage.Persistent</Type>
}

}`;

const SEND_LINE = CLASS.split("\n").findIndex((l) => l.includes("SendRequestAsync"));

const ov = (changes: Overlay["changes"], extra: Partial<Overlay> = {}): Overlay => ({
  base: "Orig.cls", docType: "2.3:ADT_A01", changes, ...extra,
});

describe("schema", () => {
  test("repeats, groups and segments come out of the map keys", () => {
    expect(schema.segments.has("DG1")).toBe(true);
    expect(schema.segments.has("ROL")).toBe(true);
    expect(schema.repeats.has("DG1")).toBe(true);
    expect(schema.repeats.has("PV2")).toBe(false);
    expect(schema.repeats.has("IN1grp")).toBe(true);
    expect(schema.repeats.has("PR1grp.ROL")).toBe(true);
    expect(schema.groups).toMatchObject({ IN1: "IN1grp", IN2: "IN1grp", PR1: "PR1grp", ROL: "PR1grp" });
    // leftoversegs() is not a segment
    expect([...schema.segments].some((s) => s.startsWith("lef"))).toBe(false);
  });

  test("a pasted zw dump reads, prompts and all", () => {
    const paste = [
      `USER>zw ^EnsHL7.Schema("Vendor","MS","ADT_A01","map")`,
      `^EnsHL7.Schema("Vendor","MS","ADT_A01","map","DG1()")="=11,*|2.3:DG1"`,
      `^EnsHL7.Schema("Vendor","MS","ADT_A01","map","PV2")="=07|2.3:PV2"`,
      `^EnsHL7.Schema(2.3,"MS","ADT_A01","map","PID")="=03|2.3:PID"`,
      `USER>`,
    ].join("\r\n");
    const r = keysFromZw(paste);
    expect(r.docType).toBe("Vendor:ADT_A01");
    expect(r.keys).toEqual(["DG1()", "PV2", "PID"]);
  });

  test("indexBraced adds (1) to every repeating level without one, and only those", () => {
    expect(indexBraced("{DG1:3}", schema)).toBe("{DG1(1):3}");
    expect(indexBraced("{PV2:3}", schema)).toBe("{PV2:3}");
    expect(indexBraced("{IN1grp.IN1:4}", schema)).toBe("{IN1grp(1).IN1:4}");
    expect(indexBraced("{PR1grp.ROL:3}", schema)).toBe("{PR1grp(1).ROL(1):3}");
    expect(indexBraced("{DG1(ip900):3}", schema)).toBe("{DG1(ip900):3}");
    expect(indexBraced("{DG1(*)}", schema)).toBe("{DG1(*)}");
    expect(indexBraced("{DG1}", schema)).toBe("{DG1(1)}");
  });
});

describe("anchor", () => {
  test("finds the one send, its variable and the request parameter", () => {
    const a = findAnchor(CLASS);
    if ("error" in a) throw new Error(a.error);
    expect(a.line).toBe(SEND_LINE);
    expect(a.sendVar).toBe("tRequest");
    expect(a.requestVar).toBe("pRequest");
    expect(a.indent).toBe("        ");
  });

  test("a renamed request parameter is the one reads come from", () => {
    const a = findAnchor(CLASS.replace("OnRequest(pRequest", "OnRequest(pInput"));
    if ("error" in a) throw new Error(a.error);
    expect(a.requestVar).toBe("pInput");
  });

  test("no send is refused by name", () => {
    const a = findAnchor(CLASS.replace(/.*SendRequestAsync.*\n/, ""));
    expect("error" in a && a.error).toContain("never calls SendRequestAsync");
  });

  test("two sends need an anchor, and the anchor must be a send", () => {
    const two = CLASS.replace(/(.*SendRequestAsync.*\n)/, "$1$1");
    const a = findAnchor(two);
    expect("error" in a && a.error).toContain(`sends on 2 lines`);
    const b = findAnchor(two, "OnRequest", SEND_LINE + 2);
    expect("error" in b).toBe(false);
    const c = findAnchor(two, "OnRequest", 1);
    expect("error" in c && c.error).toContain("not a send");
  });

  test("a commented-out send is not a send", () => {
    const a = findAnchor(CLASS.replace(/(\s*)\$\$\$ThrowOnError\(\.\.Send/, "$1// old: do ..SendRequestAsync(\"X\",tOld,0)\n$1$$$$$$ThrowOnError(..Send"));
    if ("error" in a) throw new Error(a.error);
    expect(a.sendVar).toBe("tRequest");
  });
});

describe("validation", () => {
  test("kinds that mean nothing outside a spec are refused", () => {
    const p = validateOverlay(ov([{ target: "PV2-3", from: { kind: "event" } }]), schema);
    expect(p.join()).toContain(`"event" means nothing outside a spec`);
  });

  test("a segment the structure does not have is refused, source or target", () => {
    expect(validateOverlay(ov([{ target: "ZZ1-3", from: { kind: "copy", path: "DG1-3" } }]), schema).join()).toContain("ZZ1 is not in 2.3:ADT_A01");
    expect(validateOverlay(ov([{ target: "PV2-3", from: { kind: "copy", path: "OBR-4" } }]), schema).join()).toContain("OBR is not in");
  });

  test("bad paths and a bare DocType are refused", () => {
    expect(validateOverlay(ov([{ target: "PV2.3", from: { kind: "copy", path: "DG1-3" } }])).join()).toContain("field path like PV2-3");
    expect(validateOverlay(ov([], { docType: "ADT_A01" })).join()).toContain("<category>:<structure>");
  });
});

describe("generation", () => {
  const anchor = () => {
    const a = findAnchor(CLASS);
    if ("error" in a) throw new Error(a.error);
    return a;
  };

  test("DG1-3 into PV2-3: indexed read, guarded write, empty skipped", () => {
    const g = generate(ov([{ target: "PV2-3", from: { kind: "copy", path: "DG1-3" } }]), anchor(), schema, CLASS, DEFAULT_STYLE);
    const text = g.lines.join("\n");
    expect(g.lines[0]!.trim().startsWith(BEGIN)).toBe(true);
    expect(g.lines.at(-1)!.trim()).toBe(END);
    expect(text).toContain(`If (tRequest.GetValueAt("PV2") '= "") {`);
    expect(text).toContain(`pRequest.GetValueAt("DG1(1):3")`);
    expect(text).toContain(`If (hb900 '= "") $$$ThrowOnError(tRequest.SetValueAt(hb900,"PV2:3"))`);
    expect(g.notes.join()).toContain("DG1 repeats");
  });

  test("ifEmpty write and createSegment drop their guards", () => {
    const g = generate(
      ov([{ target: "PV2-3", from: { kind: "literal", value: "" }, ifEmpty: "write", createSegment: true }]),
      anchor(), schema, CLASS, DEFAULT_STYLE,
    );
    const text = g.lines.join("\n");
    expect(text).not.toContain(`GetValueAt("PV2")`);
    expect(text).toContain(`        $$$ThrowOnError(tRequest.SetValueAt(hb900,"PV2:3"))`);
    expect(g.notes.join()).toContain("BLANKS PV2-3");
    expect(g.notes.join()).toContain("creates it");
  });

  test("MSH is never guarded; a grouped segment is addressed through its group", () => {
    const g = generate(
      ov([
        { target: "MSH-5", from: { kind: "literal", value: "RCV" } },
        { target: "IN1-4", from: { kind: "literal", value: "X" } },
      ]),
      anchor(), schema, CLASS, DEFAULT_STYLE,
    );
    const text = g.lines.join("\n");
    expect(text).not.toContain(`GetValueAt("MSH")`);
    expect(text).toContain(`If (tRequest.GetValueAt("IN1grp(1).IN1") '= "") {`);
    expect(text).toContain(`"IN1grp(1).IN1:4"`);
  });

  test("fromFirst walks the occurrences and steps wrap the value", () => {
    const g = generate(
      ov([{ target: "PV2-3", from: { kind: "fromFirst", segment: "DG1", nonEmpty: "DG1-3", path: "DG1-3" }, via: [{ kind: "upper" }] }]),
      anchor(), schema, CLASS, DEFAULT_STYLE,
    );
    const text = g.lines.join("\n");
    expect(text).toContain(`pRequest.GetValueAt("DG1(*)")`);
    expect(text).toContain(`pRequest.GetValueAt("DG1("_ip901_"):3")`);
    expect(text).toContain(`$ZCONVERT(p901,"U")`);
    // A loop read is not reported as an implicit (1).
    expect(g.notes.join()).not.toContain("DG1 repeats");
  });

  test("temp names step clear of names the class already uses", () => {
    const busy = CLASS.replace("s tsc = $$$OK", "s tsc = $$$OK, hb900 = 1");
    const a = findAnchor(busy);
    if ("error" in a) throw new Error(a.error);
    const g = generate(ov([{ target: "PV2-3", from: { kind: "copy", path: "DG1-3" } }]), a, schema, busy, DEFAULT_STYLE);
    expect(g.lines.join("\n")).toContain("hb1000");
  });

  test("an unchecked style writes with Do; accumulate does not guess the status name", () => {
    const g = generate(ov([{ target: "PV2-3", from: { kind: "copy", path: "DG1-3" } }]), anchor(), schema, CLASS, { ...DEFAULT_STYLE, writes: "unchecked" });
    expect(g.lines.join("\n")).toContain(`Do tRequest.SetValueAt(`);
    const h = generate(ov([{ target: "PV2-3", from: { kind: "copy", path: "DG1-3" } }]), anchor(), schema, CLASS, { ...DEFAULT_STYLE, writes: "accumulate" });
    expect(h.lines.join("\n")).not.toContain("tSC");
  });
});

describe("applying", () => {
  const change = ov([{ target: "PV2-3", from: { kind: "copy", path: "DG1-3" } }]);

  test("their class is untouched outside the region", () => {
    const r = overlayClass(change, CLASS, schema, { style: DEFAULT_STYLE });
    expect(r.problems).toEqual([]);
    const d = diffLines(CLASS.split("\n"), r.text!.split("\n"));
    expect(d.filter((x) => x.op === "-")).toEqual([]);
    const added = d.filter((x) => x.op === "+").map((x) => x.text);
    expect(added[0]!.trim().startsWith(BEGIN)).toBe(true);
    expect(added.at(-1)!.trim()).toBe(END);
    // The region sits directly above the send.
    const lines = r.text!.split("\n");
    expect(lines[lines.findIndex((l) => l.trim() === END) + 1]).toContain("SendRequestAsync");
  });

  test("re-applying onto a modified class replaces the region, not adds another", () => {
    const once = overlayClass(change, CLASS, schema, { style: DEFAULT_STYLE }).text!;
    const twice = overlayClass(ov([{ target: "PV2-4", from: { kind: "literal", value: "Y" } }]), once, schema, { style: DEFAULT_STYLE }).text!;
    expect(twice.split(BEGIN).length - 1).toBe(1);
    expect(twice).toContain(`"PV2:4"`);
    expect(twice).not.toContain(`"PV2:3"`);
  });

  test("CRLF in, CRLF out", () => {
    const crlf = CLASS.replace(/\n/g, "\r\n");
    const r = overlayClass(change, crlf, schema, { style: DEFAULT_STYLE });
    expect(r.text!.includes("\n") && !/[^\r]\n/.test(r.text!)).toBe(true);
  });

  test("no changes is the base, byte for byte", () => {
    expect(overlayClass(ov([]), CLASS, schema).text).toBe(CLASS);
  });

  test("applyRegion inserts above the send", () => {
    const a = findAnchor(CLASS);
    if ("error" in a) throw new Error(a.error);
    const out = applyRegion(CLASS, a, ["X"]).split("\n");
    expect(out[SEND_LINE]).toBe("X");
  });
});

describe("message diff", () => {
  test("fields by number, MSH one ahead of its split index", () => {
    const f = diffMessages(
      ["MSH|^~\\&|A|B", "PV2||SPV||", "DG1|1"],
      ["MSH|^~\\&|A|C", "PV2||SPV|E11^DM|", "DG1|1"],
    );
    expect(f.map((x) => [x.field, x.before, x.after])).toEqual([
      ["MSH-4", "B", "C"],
      ["PV2-3", "", "E11^DM"],
    ]);
  });

  test("an added segment is added, not a shift of everything after it", () => {
    const f = diffMessages(["MSH|^~\\&", "PV1|1", "DG1|1"], ["MSH|^~\\&", "PV1|1", "PV2||X", "DG1|1"]);
    expect(f).toHaveLength(1);
    expect(f[0]!.field).toBe("(segment added)");
  });

  test("occurrences pair by number", () => {
    const f = diffMessages(["DG1|1|A", "DG1|2|B"], ["DG1|1|A", "DG1|2|C"]);
    expect(f).toEqual([{ segment: "DG1", occurrence: 2, field: "DG1-2", before: "B", after: "C" }]);
  });
});

describe("engine fixes from the 2026-11-04 work-PC session", () => {
  test("a body that sends tRequest and never sets tTarget is named, so it runs whole", () => {
    expect(sendsWithoutTarget(`s tRequest = pRequest.%ConstructClone()\n$$$ThrowOnError(..SendRequestAsync("X",tRequest,0))`)).toBe("tRequest");
    expect(sendsWithoutTarget(`set tTarget = pRequest.%ConstructClone()\ndo ..SendRequestAsync("X",tTarget,0)`)).toBeUndefined();
    expect(sendsWithoutTarget(`set tTarget = 1`)).toBeUndefined();
  });

  test("scratch writes check both statuses", () => {
    const lines = writeThrough("/lab/X.cls", "a\nb", "sf");
    expect(lines.filter((l) => l.includes("WRITEFAIL|"))).toHaveLength(2);
    expect(lines.some((l) => l === `set sc=sf.%Save()`)).toBe(true);
  });
});
