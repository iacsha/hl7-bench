// bun test
//
// The pure half of running a class whole. The engine half -- that the class
// compiles, runs and is judged against the goldens -- was proven on IRIS for
// Health 2026.1 with `engine.ts --check`: eleven cases passing on a generated
// patch class, and ten of them failing when one literal in it was changed.

import { expect, test, describe } from "bun:test";

import { HOST_CLASS, hostClass, hostedCall, instanceCalls, renamedClass } from "./hosted";

const patchClass = `/// A patch class
Class Site.Feed.Process.ToReceiver Extends Ens.BusinessProcess [ ClassType = persistent ]
{

Method OnRequest(pRequest As EnsLib.HL7.Message, Output pResponse As Ens.Response) As %Status
{
	$$$ThrowOnError(..Mapping(pRequest,.tRequest,tEvent))
	$$$ThrowOnError(..SendRequestAsync("ToReceiver.ADT.TCP",tRequest,0))
}

Method Mapping(pRequest As EnsLib.HL7.Message, Output tRequest As EnsLib.HL7.Message, pEvent As %String) As %Status
{
	Quit 1
}

ClassMethod ValueAt(pDoc, pPath) As %String
{
	Quit ""
}

}
`;

const onRequest = `$$$ThrowOnError(..Mapping(pRequest,.tRequest,tEvent)) set x = ..ValueAt(pRequest,"PID") $$$ThrowOnError(..SendRequestAsync("X",tRequest,0))`;

describe("instanceCalls", () => {
  test("finds an instance method the body calls", () => {
    expect(instanceCalls(patchClass, onRequest)).toEqual(["Mapping"]);
  });

  test("ignores a ClassMethod, which a lifted body can still reach", () => {
    expect(instanceCalls(patchClass, onRequest)).not.toContain("ValueAt");
  });

  test("ignores an inherited method the file does not declare", () => {
    expect(instanceCalls(patchClass, onRequest)).not.toContain("SendRequestAsync");
  });

  test("an inline-style class needs nothing hosted", () => {
    const inline = patchClass.replace(/^Method Mapping[\s\S]*?^}\n/m, "");
    expect(instanceCalls(inline, `set x = ..ValueAt(tSource,"PID")`)).toEqual([]);
  });
});

describe("renamedClass", () => {
  test("replaces only the class name, and leaves the rest byte for byte", () => {
    const out = renamedClass(patchClass, "HL7Bench.Scratch");
    expect(out).toContain("Class HL7Bench.Scratch Extends Ens.BusinessProcess [ ClassType = persistent ]");
    expect(out).not.toContain("Site.Feed.Process.ToReceiver");
    expect(out.replace("HL7Bench.Scratch", "Site.Feed.Process.ToReceiver")).toBe(patchClass);
  });

  test("refuses a file with no class line rather than compiling something else", () => {
    expect(() => renamedClass("set x = 1", "HL7Bench.Scratch")).toThrow();
  });
});

describe("the capture subclass", () => {
  const cls = hostClass("HL7Bench.Scratch");

  test("overrides SendRequestAsync with the exact inherited signature", () => {
    // Anything looser and the compile refuses the override: measured.
    expect(cls).toContain(
      "Method SendRequestAsync(pTargetDispatchName As %String, pRequest As Ens.Request, pResponseRequired As %Boolean = 1, pCompletionKey As %String = \"\", pDescription As %String = \"\") As %Status",
    );
    expect(cls).toContain(`Class ${HOST_CLASS} Extends HL7Bench.Scratch`);
  });

  test("keeps the message and queues nothing", () => {
    expect(cls).toContain("set %HL7BenchSent = pRequest");
    expect(cls).not.toMatch(/##super|SendRequestAsync\(pTarget.*\)\s*$/m);
  });
});

describe("the call", () => {
  const call = hostedCall();

  test("clears the last case first, or a class that sends nothing reports the previous message", () => {
    expect(call.startsWith("kill %HL7BenchSent,%HL7BenchSentTo,%HL7BenchSends,tgt ")).toBe(true);
  });

  test("builds the host with a config name, because %New() alone dies in Ens.Host", () => {
    expect(call).toContain(`##class(${HOST_CLASS}).%New("${HOST_CLASS}")`);
  });

  test("calls the real OnRequest and reports what was sent where", () => {
    expect(call).toContain("bp.OnRequest(src,.resp)");
    expect(call).toContain(`write "SENT|"`);
  });
});
