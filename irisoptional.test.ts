/**
 * irisoptional.test.ts -- a spec with no iris key: judged on everything else,
 * emitted for BridgeLink, refused for IRIS by name, and never given one back
 * by a save.
 */

import { expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { validate, copy, literal, type Spec } from "./spec";
import { runSpec } from "./run";
import { Message } from "./hl7";
import { emitBridgelink } from "./emit/bridgelink";
import { specToSource, importLine } from "./serialize";

const spec: Spec = {
  name: "No IRIS",
  gate: { path: "MSH-9.2", permit: { A01: "A01" } },
  bridgelink: { channelName: "ADT out" },
  blocks: [
    { id: "MSH", wholeSegment: true, rows: [{ target: "MSH-3", from: literal("BENCH") }] },
    { id: "PID", rows: [{ target: "PID-3", from: copy("PID-3.1") }] },
  ],
};

test("it validates, runs and emits for BridgeLink", () => {
  expect(validate(spec)).toEqual([]);
  expect(validate(spec, "bridgelink")).toEqual([]);
  const m = new Message("MSH|^~\\&|S|F|R|RF|20261024||ADT^A01|C|T|2.5\rPID|1||MRN7\r");
  runSpec(spec, m);
  expect(m.toString()).toContain("PID|||MRN7");
  expect(emitBridgelink(spec)).toContain("benchSeed(");
});

test("still judged on everything else", () => {
  const bad = { ...spec, blocks: [{ id: "PID", rows: [{ target: "PV1-3", from: literal("x") }] }] };
  expect(validate(bad).join("\n")).toContain("targets PV1");
});

test("IRIS is refused by name, and so is an empty DocType", () => {
  expect(validate(spec, "iris").join("\n")).toContain("has no iris key");
  const empty = { ...spec, iris: { sourceDocType: "", targetDocType: "" } };
  expect(validate(empty, "iris").join("\n")).toContain("empty DocType");
});

test("a save does not grow an iris block, empty or absent", async () => {
  const from = pathToFileURL(join(import.meta.dir, "spec.ts")).href;
  for (const s of [spec, { ...spec, iris: { sourceDocType: "", targetDocType: "" } }]) {
    const text = specToSource(s);
    expect(text).not.toContain("iris:");
    const path = join(tmpdir(), `hl7-bench-noiris-${process.pid}-${Math.random()}.ts`);
    writeFileSync(path, `${importLine(s, from)}\n\n${text}\n`);
    try {
      const back = (await import(pathToFileURL(path).href)).spec;
      expect(back.iris).toBeUndefined();
      expect(validate(back)).toEqual([]);
    } finally {
      rmSync(path, { force: true });
    }
  }
});

test("an iris block that says something is still written", () => {
  expect(specToSource({ ...spec, iris: { sourceDocType: "2.5:ADT_A01", targetDocType: "2.5:ADT_A01" } })).toContain("iris: {");
});
