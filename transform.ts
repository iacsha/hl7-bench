/**
 * transform.ts -- this is the file you edit.
 *
 * You describe the interface ONCE, as the spec below. Three things read it and
 * none of them is a second copy of your decisions:
 *
 *   bun bench.ts     runs it against a message
 *   bun trace.ts     prints the field table you hand the receiving team
 *   bun emit.ts      writes the IRIS DTL class
 *
 * That is the whole point of the shape. The old bench made you write the
 * mapping three times, once as JavaScript because that is what ran, once as a
 * rules table because that is what printed, once as a DTL spec because that is
 * what generated, and nothing checked that the three agreed. Change one and the
 * other two quietly lied.
 *
 * The vocabulary lives in `spec.ts` and it is deliberately small. When it
 * cannot say what your interface does, add a kind there and handle it in
 * `run.ts` and `emit/iris.ts`. Both, always. That is about twenty lines and the
 * completeness test in `spec.test.ts` will tell you if you missed one.
 */

import type { Message } from "./hl7";
import { runSpec } from "./run";
import {
  copy, literal, firstOf, lookup, counter, event, blank,
  upper, date8, defaultTo,
  type Spec,
} from "./spec";

export const spec: Spec = {
  name: "Demo Interface",
  description: "Synthetic ADT to a downstream registration feed. Replace all of this.",

  /**
   * Which messages this interface handles, and what each becomes.
   *
   * A table, never an if/else. An if grows an implicit everything-else branch,
   * and that branch is how a discharge reaches the receiver as a registration.
   * Anything not listed here is REFUSED, loudly, which is what the
   * `.reject.hl7` cases in `check.ts` assert.
   */
  gate: {
    path: "MSH-9.2",
    permit: { A01: "A01", A08: "A08" },
  },

  /**
   * Real schema names out of YOUR namespace. A wrong DocType fails CLOSED in
   * IRIS: paths stop resolving, the message comes out empty, and nothing useful
   * reaches the log. Open the schema browser before you compile.
   */
  iris: {
    className: "Demo.AdtToDownstream",
    sourceDocType: "2.5:ADT_A01",
    targetDocType: "2.5:ADT_A01",
    create: "new",
  },

  /**
   * The twin of Ens.Util.LookupTable. Rows live here so the bench and the
   * engine cannot disagree about a code. An EMPTY table returns the unmapped
   * branch for every message and looks exactly like a working lookup, so both
   * backends call it out rather than letting you find it in a report.
   */
  tables: {
    DemoSex: { M: "MALE", F: "FEMALE" },
  },

  /** Target segments, in delivery order. This IS the output segment order. */
  blocks: [
    {
      id: "MSH",
      rows: [
        { target: "MSH-3", from: literal("BENCH"), label: "Sending Application" },
        { target: "MSH-4", from: copy("MSH-4"), label: "Sending Facility", required: true },
        { target: "MSH-5", from: copy("MSH-5"), label: "Receiving Application" },
        { target: "MSH-6", from: copy("MSH-6"), label: "Receiving Facility" },
        { target: "MSH-7", from: copy("MSH-7"), label: "Message Datetime" },
        { target: "MSH-9.1", from: literal("ADT") },
        { target: "MSH-9.2", from: event(), label: "Trigger Event" },
        { target: "MSH-10", from: copy("MSH-10"), label: "Control ID", required: true },
        { target: "MSH-11", from: copy("MSH-11"), via: [defaultTo("P")] },
        { target: "MSH-12", from: literal("2.5") },
      ],
    },
    {
      id: "EVN",
      rows: [
        { target: "EVN-1", from: event() },
        { target: "EVN-2", from: copy("EVN-2"), label: "Event Datetime" },
      ],
    },
    {
      id: "PID",
      rows: [
        { target: "PID-1", from: literal("1") },
        // firstOf is how you say "PID-4 if the site populates it, else PID-3",
        // rather than discovering at go-live that one site does not.
        { target: "PID-3", from: firstOf("PID-4.1", "PID-3.1"), label: "MRN", required: true },
        { target: "PID-5.1", from: copy("PID-5.1"), via: [upper()], label: "Last Name", required: true },
        { target: "PID-5.2", from: copy("PID-5.2"), via: [upper()], label: "First Name" },
        { target: "PID-7", from: copy("PID-7"), via: [date8()], label: "Date of Birth" },
        // Every lookup states what happens to a code that is not in the table.
        // There is no default for that on purpose.
        { target: "PID-8", from: lookup("DemoSex", "PID-8", blank()), label: "Sex" },
        { target: "PID-11", from: copy("PID-11"), label: "Address" },
      ],
    },
    {
      id: "PV1",
      rows: [
        { target: "PV1-1", from: literal("1") },
        { target: "PV1-2", from: copy("PV1-2"), label: "Patient Class" },
        { target: "PV1-19", from: copy("PV1-19"), label: "Visit Number", required: true },
        { target: "PV1-44", from: copy("PV1-44"), via: [date8()], label: "Admit Date" },
      ],
    },
    {
      // A repeat. `counter()` numbers by OUTPUT ordinal, not by source repeat
      // index, so a skipped occurrence does not leave a hole in the set ids.
      // Receivers that validate set id sequence reject the whole message.
      id: "NK1",
      repeat: { over: "NK1", skipWhenEmpty: "NK1-2", max: 3 },
      rows: [
        { target: "NK1-1", from: counter() },
        { target: "NK1-2", from: copy("NK1-2"), label: "Contact Name" },
        { target: "NK1-3", from: copy("NK1-3"), label: "Relationship" },
      ],
    },
  ],

  /**
   * What the SENDER puts on the wire, mapped or not. Documentation only; no
   * code comes from it. This is the agenda for the call with the sending
   * system, and it is rarely the same list as the one above.
   */
  sourceInventory: [
    { path: "MSH-4", label: "Sending Facility", required: true },
    { path: "PID-3.1", label: "MRN", required: true },
    { path: "PID-4.1", label: "Account Number", note: "empty at some sites, hence firstOf" },
    { path: "PV1-19", label: "Visit Number", required: true },
  ],

  /** Decisions recorded as decisions, so "not sent" is never just an absence. */
  outOfScope: [
    "PID-10 race, receiver does not consume it",
    "PID-16 marital status, no agreed code set yet",
  ],
};

/**
 * The bench contract, unchanged: parsed message in, mutated in place.
 * `bench.ts`, `check.ts`, `gui.ts`, and the PipeHat provider all still call
 * this, so nothing downstream had to change.
 */
export function transform(msg: Message): void {
  const result = runSpec(spec, msg);

  // Per-message diagnostics for the GUI pane. check.ts turns these off so they
  // do not bury its PASS/FAIL lines.
  if (process.env.HL7_BENCH_NOTES === "off") return;
  for (const note of result.notes) process.stderr.write(`  ${note}\n`);
}
