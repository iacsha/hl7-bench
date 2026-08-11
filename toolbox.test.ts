import { expect, test, describe } from "bun:test";
import { Message } from "./hl7";
import {
  mapOne, mapEach, renderTrace, toPipeDelimited,
  date8, truncate, upper, stripDelims, defaultTo,
  lookup, lookupChain, signed,
  literal, join, coalesce, compute,
  type Rule,
} from "./toolbox";

// A charge message with THREE FT1 segments. The count is the point: a mapping
// written against FT1(1) produces one record from this and drops two charges.
const DFT = [
  "MSH|^~\\&|SEND|SENDFAC|RECV|RECVFAC|20260811120000||DFT^P03|MSG1|P|2.5",
  "PID|1||MRN9^^^FAC^MR||doe^john^q||19800115|M|||1 fake st^^rochester^NY^14624",
  "FT1|1|||20260811093000|20260811120000|CH|LAB001^Basic panel^L|||2",
  "FT1|2|||20260811094500|20260811120000|CG|LAB002^Culture^L|||1",
  "FT1|3|||20260811100000|20260811120000|CH|LAB003^Smear^L|||4",
].join("\r\n");

const chargeRules: Rule[] = [
  { to: "Facility",    from: "MSH-6.1", required: true },
  { to: "AccountNumber", from: "PID-3.1", required: true },
  { to: "LastName",    from: "PID-5.1", via: [upper()], required: true },
  { to: "FirstName",   from: join(" ", "PID-5.2", "PID-5.3") },
  { to: "ServiceDate", from: "FT1-4",  via: [date8()], required: true },
  { to: "ChargeDate",  from: "FT1-5",  via: [date8()] },
  { to: "ChargeCode",  from: "FT1-7.1", required: true },
  { to: "Description", from: "FT1-7.2" },
  { to: "Quantity",    from: "FT1-10", via: [signed("FT1-6", ["CH"], ["CG", "R"])] },
];

describe("mapEach vs mapOne", () => {
  test("mapEach produces one record per repeating segment", () => {
    const out = mapEach(new Message(DFT), "FT1", chargeRules);
    expect(out.length).toBe(3);
    expect(out.map((r) => r.record.ChargeCode)).toEqual(["LAB001", "LAB002", "LAB003"]);
  });

  test("mapOne against the same rules silently yields only the first charge", () => {
    // This is the failure being guarded against, asserted so it stays visible.
    const out = mapOne(new Message(DFT), chargeRules);
    expect(out.record.ChargeCode).toBe("LAB001");
  });

  test("each record carries its own segment's values, not the first one's", () => {
    const out = mapEach(new Message(DFT), "FT1", chargeRules);
    expect(out[1]!.record.Description).toBe("Culture");
    expect(out[2]!.record.ServiceDate).toBe("20260811");
  });

  test("message-level paths still resolve inside mapEach", () => {
    const out = mapEach(new Message(DFT), "FT1", chargeRules);
    for (const r of out) expect(r.record.LastName).toBe("DOE");
  });
});

describe("signed", () => {
  test("positive list passes the quantity through", () => {
    const out = mapEach(new Message(DFT), "FT1", chargeRules);
    expect(out[0]!.record.Quantity).toBe("2");
    expect(out[2]!.record.Quantity).toBe("4");
  });

  test("negative list negates it", () => {
    const out = mapEach(new Message(DFT), "FT1", chargeRules);
    expect(out[1]!.record.Quantity).toBe("-1");
  });

  test("a type in neither list throws instead of defaulting", () => {
    const odd = DFT.replace("|CH|LAB001", "|XX|LAB001");
    expect(() => mapEach(new Message(odd), "FT1", chargeRules)).toThrow(/neither the positive/);
  });

  test("does not double-negate an already negative quantity", () => {
    const neg = DFT.replace("LAB002^Culture^L|||1", "LAB002^Culture^L|||-1");
    const out = mapEach(new Message(neg), "FT1", chargeRules);
    expect(out[1]!.record.Quantity).toBe("-1");
  });
});

describe("steps", () => {
  const msg = new Message(DFT);

  test("date8 truncates an HL7 timestamp to the date", () => {
    const r = mapOne(msg, [{ to: "D", from: "FT1-4", via: [date8()] }]);
    expect(r.record.D).toBe("20260811");
  });

  test("truncate keeps n characters", () => {
    const r = mapOne(msg, [{ to: "T", from: "FT1-4", via: [truncate(6)] }]);
    expect(r.record.T).toBe("202608");
  });

  test("stripDelims removes characters that would corrupt the message", () => {
    const r = mapOne(msg, [
      { to: "S", from: literal("a^b|c~d&e"), via: [stripDelims()] },
    ]);
    expect(r.record.S).toBe("abcde");
  });

  test("defaultTo fills only when empty", () => {
    const r = mapOne(msg, [
      { to: "A", from: "PID-99", via: [defaultTo("NONE")] },
      { to: "B", from: "PID-5.1", via: [defaultTo("NONE")] },
    ]);
    expect(r.record.A).toBe("NONE");
    expect(r.record.B).toBe("doe");
  });

  test("lookup passthrough keeps an unmapped code", () => {
    const r = mapOne(msg, [
      { to: "C", from: "PID-8", via: [lookup({ F: "FEMALE" }, "passthrough")] },
    ]);
    expect(r.record.C).toBe("M");
  });

  test("lookup blank drops an unmapped code", () => {
    const r = mapOne(msg, [
      { to: "C", from: "PID-8", via: [lookup({ F: "FEMALE" }, "blank")] },
    ]);
    expect(r.record.C).toBe("");
  });

  test("lookup error refuses an unmapped code", () => {
    expect(() =>
      mapOne(msg, [{ to: "C", from: "PID-8", via: [lookup({ F: "FEMALE" }, { error: true })] }]),
    ).toThrow(/Unmapped code "M"/);
  });

  test("lookupChain takes the first hit and falls through to passthrough", () => {
    const step = lookupChain({ ICU: "CRIT" }, { M: "MEDI" });
    const r = mapOne(msg, [
      { to: "X", from: literal("ICU"), via: [step] },
      { to: "Y", from: literal("M"), via: [step] },
      { to: "Z", from: literal("ZZZ"), via: [step] },
    ]);
    expect([r.record.X, r.record.Y, r.record.Z]).toEqual(["CRIT", "MEDI", "ZZZ"]);
  });
});

describe("getters", () => {
  const msg = new Message(DFT);

  test("join concatenates and trims a trailing separator", () => {
    const r = mapOne(msg, [{ to: "N", from: join(" ", "PID-5.2", "PID-5.3") }]);
    expect(r.record.N).toBe("john q");
  });

  test("coalesce takes the first non-empty path", () => {
    const r = mapOne(msg, [{ to: "F", from: coalesce("MSH-4.1", "MSH-6.1") }]);
    expect(r.record.F).toBe("SENDFAC");
  });

  test("coalesce falls through when the first is empty", () => {
    const noFac = DFT.replace("|SEND|SENDFAC|", "|SEND||");
    const r = mapOne(new Message(noFac), [{ to: "F", from: coalesce("MSH-4.1", "MSH-6.1") }]);
    expect(r.record.F).toBe("RECVFAC");
  });

  test("compute runs arbitrary logic and still describes itself", () => {
    const r = mapOne(msg, [
      { to: "K", from: compute("segment count", ({ msg }) => String(msg.segments.length)) },
    ]);
    expect(r.record.K).toBe("5");
    expect(r.trace[0]!.source).toBe("segment count");
  });
});

describe("required and missing", () => {
  test("collects EVERY missing required field, not just the first", () => {
    const blank = [
      "MSH|^~\\&|SEND||RECV||20260811120000||DFT^P03|MSG1|P|2.5",
      "PID|1|||||||||",
      "FT1|1|||20260811093000|20260811120000|CH|LAB001^x^L|||2",
    ].join("\r\n");
    const out = mapOne(new Message(blank), chargeRules);
    expect(out.missing).toEqual(["Facility", "AccountNumber", "LastName"]);
  });

  test("a populated message reports nothing missing", () => {
    const out = mapEach(new Message(DFT), "FT1", chargeRules);
    for (const r of out) expect(r.missing).toEqual([]);
  });
});

describe("rendering", () => {
  test("trace names the source path and both ends of every step", () => {
    const out = mapEach(new Message(DFT), "FT1", chargeRules)[1]!;
    const t = out.trace.find((x) => x.to === "LastName")!;
    expect(t.source).toBe("PID-5.1");
    expect(t.raw).toBe("doe");
    expect(t.steps[0]!.describe).toBe("uppercase");
    expect(t.steps[0]!.before).toBe("doe");
    expect(t.steps[0]!.after).toBe("DOE");
    expect(t.final).toBe("DOE");
  });

  test("renderTrace labels each record when given several", () => {
    const text = renderTrace(mapEach(new Message(DFT), "FT1", chargeRules));
    expect(text).toContain("record 1 of 3");
    expect(text).toContain("record 3 of 3");
    expect(text).toContain("TARGET");
  });

  test("renderTrace flags missing required fields", () => {
    const blank = [
      "MSH|^~\\&|SEND||RECV||20260811120000||DFT^P03|MSG1|P|2.5",
      "PID|1|||||||||",
      "FT1|1|||20260811093000|20260811120000|CH|LAB001^x^L|||2",
    ].join("\r\n");
    const text = renderTrace(mapOne(new Message(blank), chargeRules));
    expect(text).toContain("MISSING");
    expect(text).toContain("MISSING REQUIRED: Facility, AccountNumber, LastName");
  });

  test("notes survive into the rendered trace", () => {
    const text = renderTrace(
      mapOne(new Message(DFT), [
        { to: "Cpt4", from: literal(""), note: "blanked deliberately -- confirm with billing" },
      ]),
    );
    expect(text).toContain("note Cpt4: blanked deliberately");
  });

  test("toPipeDelimited emits fields in rule order", () => {
    const out = mapEach(new Message(DFT), "FT1", chargeRules)[0]!;
    // MSH-6 is the RECEIVING facility, so Facility is RECVFAC here. The
    // coalesce test above reads MSH-4 and gets SENDFAC -- worth keeping both
    // in the suite, because mixing those two up is a real interface bug and
    // the field names do not stop you.
    expect(toPipeDelimited(out)).toBe("RECVFAC|MRN9|DOE|john q|20260811|20260811|LAB001|Basic panel|2");
  });
});
