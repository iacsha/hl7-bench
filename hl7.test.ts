// bun test
//
// The MSH off-by-one is the reason this file exists. MSH-1 is the field
// separator and MSH-2 is the encoding characters, so on the MSH line every
// field sits one slot left of where a naive split puts it. Getting this wrong
// silently shifts message type, control ID, and version -- and it reads fine
// until a receiver rejects everything.

import { expect, test, describe } from "bun:test";
import { Message, stripMllp } from "./hl7";

const SAMPLE =
  "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260804120000||ADT^A01^ADT_A01|MSG00001|P|2.5\r\n" +
  "PID|1||MRN12345^^^LABMRN^MR~SSN999999999^^^LABSSN^SS||doe^john^q||19800115|M\r\n" +
  "OBX|1|ST|GLU^Glucose||99|mg/dL\r\n" +
  "OBX|2|ST|NA^Sodium||140|mmol/L\r\n";

describe("MSH off-by-one", () => {
  const m = new Message(SAMPLE);
  test("MSH-1 is the field separator itself", () => expect(m.get("MSH-1")).toBe("|"));
  test("MSH-2 is the encoding characters", () => expect(m.get("MSH-2")).toBe("^~\\&"));
  test("MSH-3 is the sending application", () => expect(m.get("MSH-3")).toBe("SENDAPP"));
  test("MSH-9 is the message type", () => expect(m.get("MSH-9.1")).toBe("ADT"));
  test("MSH-9.2 is the trigger event", () => expect(m.get("MSH-9.2")).toBe("A01"));
  test("MSH-10 is the control ID", () => expect(m.get("MSH-10")).toBe("MSG00001"));
  test("MSH-12 is the version", () => expect(m.get("MSH-12")).toBe("2.5"));
  test("MSH-1 cannot be assigned", () => expect(() => m.set("MSH-1", "!")).toThrow());
});

describe("non-MSH segments are not shifted", () => {
  const m = new Message(SAMPLE);
  test("PID-1", () => expect(m.get("PID-1")).toBe("1"));
  test("PID-5.1", () => expect(m.get("PID-5.1")).toBe("doe"));
  test("PID-5.2", () => expect(m.get("PID-5.2")).toBe("john"));
  test("PID-8", () => expect(m.get("PID-8")).toBe("M"));
  test("empty field reads as empty string", () => expect(m.get("PID-2")).toBe(""));
});

describe("fieldCount finds the end of a segment", () => {
  const m = new Message(SAMPLE);

  // The GUI walks 1..fieldCount to offer a copy() row per populated field.
  // getField returns "" past the end and cannot tell absent from empty, so
  // without a real edge the walk is a guess about how far to probe.
  test("MSH counts to 12, its last field", () => expect(m.seg("MSH")!.fieldCount).toBe(12));
  test("and MSH-12 is the last thing on the line", () => expect(m.get("MSH-12")).toBe("2.5"));
  test("PID counts to 8", () => expect(m.seg("PID")!.fieldCount).toBe(8));
  test("OBX counts to 6", () => expect(m.seg("OBX")!.fieldCount).toBe(6));

  test("one past the end reads empty", () => {
    const pid = m.seg("PID")!;
    expect(pid.getField(pid.fieldCount + 1)).toBe("");
  });

  test("the last counted field is not empty on any segment here", () => {
    for (const s of m.segments) expect(s.getField(s.fieldCount)).not.toBe("");
  });

  test("a segment with nothing but an id counts zero", () => {
    const bare = new Message("MSH|^~\\&|A\r\nZZZ\r\n");
    expect(bare.seg("ZZZ")!.fieldCount).toBe(0);
  });
});

describe("repetitions", () => {
  const m = new Message(SAMPLE);
  test("counts them", () => expect(m.seg("PID")!.repCount(3)).toBe(2));
  test("first rep by default", () => expect(m.get("PID-3.1")).toBe("MRN12345"));
  test("second rep by index", () => expect(m.get("PID-3(2).1")).toBe("SSN999999999"));
  test("component inside a rep", () => expect(m.get("PID-3(2).5")).toBe("SS"));
  test("writes into a rep without disturbing its sibling", () => {
    const w = new Message(SAMPLE);
    w.set("PID-3(2).5", "LAB");
    expect(w.get("PID-3(2).5")).toBe("LAB");
    expect(w.get("PID-3(1).5")).toBe("MR");
    expect(w.get("PID-3(1).1")).toBe("MRN12345");
  });
});

describe("repeating segments", () => {
  const m = new Message(SAMPLE);
  test("all() returns each occurrence", () => expect(m.all("OBX").length).toBe(2));
  test("each keeps its own values", () => {
    expect(m.all("OBX")[0].get("OBX-3.1")).toBe("GLU");
    expect(m.all("OBX")[1].get("OBX-3.1")).toBe("NA");
  });
  test("seg() returns the first", () => expect(m.seg("OBX")!.get("OBX-1")).toBe("1"));
});

describe("non-default delimiters are read from the message", () => {
  // A message is entitled to declare its own separators, and real feeds do.
  const odd = "MSH!@~\\&!SEND!FAC!R!RF!20260804!!ADT@A01!ID1!P!2.5\rPID!1!!X!!doe@john\r";
  const m = new Message(odd);
  test("field separator", () => expect(m.delims.field).toBe("!"));
  test("component separator", () => expect(m.delims.comp).toBe("@"));
  test("MSH-9.1 with odd delimiters", () => expect(m.get("MSH-9.1")).toBe("ADT"));
  test("PID-5.2 with odd delimiters", () => expect(m.get("PID-5.2")).toBe("john"));
});

describe("round trip", () => {
  test("untouched message re-serializes to the same segments", () => {
    const m = new Message(SAMPLE);
    const out = m.toString().trim().split("\r\n");
    expect(out).toEqual(SAMPLE.trim().split("\r\n"));
  });
  test("writes past the end of a segment pad rather than throw", () => {
    const m = new Message(SAMPLE);
    m.set("PID-20", "NEW");
    expect(m.get("PID-20")).toBe("NEW");
    expect(m.get("PID-8")).toBe("M");
  });
});

describe("bad input is rejected loudly", () => {
  test("empty", () => expect(() => new Message("")).toThrow());
  test("does not start with MSH", () => expect(() => new Message("PID|1|\r")).toThrow());
  test("nonsense path", () => expect(() => new Message(SAMPLE).get("nonsense")).toThrow());
  test("missing segment on write", () =>
    expect(() => new Message(SAMPLE).set("ZZZ-1", "x")).toThrow());
});

describe("MLLP framing", () => {
  const VT = "\x0b", FS = "\x1c";

  test("a fully framed message parses as if it were not framed", () => {
    const m = new Message(VT + SAMPLE + FS + "\r");
    expect(m.segments[0].id).toBe("MSH");
    expect(m.get("MSH-3")).toBe(new Message(SAMPLE).get("MSH-3"));
  });

  test("a trailing FS does not land in the last field", () => {
    // The real defect this was written for. A capture with a trailing 0x1C and
    // no opening 0x0B put the control character in the last segment's last
    // field, where nothing reads as wrong until something ranks or compares it.
    const framed = new Message(SAMPLE + FS + "\r");
    const plain = new Message(SAMPLE);
    const last = (m: Message) => m.segments.at(-1)!;
    expect(last(framed).toString()).toBe(last(plain).toString());
  });

  test("a leading VT alone is removed", () => {
    expect(new Message(VT + SAMPLE).segments[0].id).toBe("MSH");
  });

  test("an FS inside a field is left alone, because that is corruption", () => {
    // Stripping positionally rather than globally is the whole point: a message
    // damaged in the middle must keep reading as damaged.
    const dirty = SAMPLE.replace("19800115", `1980${FS}0115`);
    expect(new Message(dirty).get("PID-7")).toBe(`1980${FS}0115`);
  });

  test("an FS mid-message survives even when the message is also framed", () => {
    const dirty = SAMPLE.replace("19800115", `1980${FS}0115`);
    expect(new Message(VT + dirty + FS + "\r").get("PID-7")).toBe(`1980${FS}0115`);
  });

  test("an unframed message is returned untouched", () => {
    expect(stripMllp(SAMPLE)).toBe(SAMPLE);
  });
});
