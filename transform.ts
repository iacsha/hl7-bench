/**
 * transform.ts -- this is the file you edit.
 *
 * Same contract as a Mirth transformer step: you get the parsed message, you
 * mutate it, you are done. Throwing anything aborts the run and the message
 * lands in front of you as the error, which is the point.
 *
 * The transformation below is deliberately the same one as the IRIS DTL sample
 * in iris-lab, so you can read the two languages against each other.
 */

import type { Message } from "./hl7";

export function transform(msg: Message): void {
  // Stamp the sending application so you can see at a glance that it ran.
  msg.set("MSH-3", "BENCH");

  // Uppercase the family name.
  msg.set("PID-5.1", msg.get("PID-5.1").toUpperCase());

  // Branching.
  msg.set("PID-8", msg.get("PID-8") === "M" ? "MALE" : "OTHER");

  // Walk every repetition of the patient identifier list. In DTL this is
  // <foreach>; here it is a for loop, which is the whole argument for doing it
  // in a real language.
  const pid = msg.seg("PID");
  if (pid) {
    for (let r = 1; r <= pid.repCount(3); r++) {
      pid.set(`PID-3(${r}).5`, "LAB");
    }
  }

  // Fresh control ID so a downstream dedupe treats this as a new message.
  const now = new Date();
  const stamp =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");
  msg.set("MSH-10", `BENCH${stamp}`);

  // Repeating segments are a plain array. Uncomment to see it:
  // for (const obx of msg.all("OBX")) obx.set("OBX-15.1", "LAB");
}
