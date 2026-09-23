/**
 * emit/process.ts -- a spec becomes an Ens.BusinessProcess TEMPLATE.
 *
 * WHY THIS FILE SAYS TEMPLATE AND emit/iris.ts DOES NOT
 *
 * The DTL header says *proven on the bench* and it is entitled to: real messages
 * went through that mapping, on this machine, and you read the output. There is
 * nothing here to run. `OnRequest` takes a request object out of a running
 * production and hands it to a queue, and none of that exists on a laptop. So
 * this is a starting point that compiles, and the file says so in its first
 * line. If both artifacts carried the same confident banner, the DTL's banner
 * would stop meaning anything, and that banner is the one line in that file that
 * has to be believed.
 *
 * ONE SHOP'S PATTERN, NOT THE PATTERN
 *
 * What comes out is a custom business process that clones the request, calls a
 * DTL, and dispatches by config item name with SendRequestAsync. That is a
 * common and perfectly good shape, and it is not the only one. Plenty of sites
 * use EnsLib.HL7.MsgRouter.RoutingEngine with a rule whose transform field names
 * the DTL, and never write a process class at all. If your production already
 * has a routing engine in front of this transform, you probably do not want this
 * file. Read it, take the parts you need.
 *
 * THE GATE IS NOW IN TWO PLACES, AND THAT IS A DECISION
 *
 * `emit/iris.ts` prints a routing rule condition. The class below filters on the
 * same gate. Those are two ways of saying one thing, and you want one of them:
 *
 *   - Routing engine in front? The rule holds the gate. The filter below is
 *     redundant, harmless, and worth keeping as a belt if you like.
 *   - This process wired straight to the service? The filter below IS the gate.
 *     Delete it and every message the sender emits reaches the transform.
 *
 * Emitting it in both places is deliberate. A gate that exists in neither is the
 * failure that matters, and it is silent.
 */

import { comment, irisComments, os, pickNotes, type BareRefs } from "./iris";
import { emitInlineMapping, inlineDeclarations, inlineHelpers } from "./inline";
import { fingerprint } from "../fingerprint";
import type { Spec } from "../spec";

// ---------------------------------------------------------------------------

/**
 * Bench path to the string `GetValueAt` wants. "MSH-9.2" becomes "MSH:9.2".
 *
 * Deliberately not `dtlPath`: the curly form is a DTL compiler feature and this
 * file is plain ObjectScript in a Method body, where a brace is a syntax error
 * rather than a path.
 */
function hl7Ref(path: string): string {
  return path.replace("-", ":");
}

/**
 * A gate read off the inbound request.
 *
 * Inline, this goes through the guarded helper the mapping already installs. A
 * gate path on an optional segment -- a `require` on PV1-2, say -- would
 * otherwise throw on the message that lacks it and kill the process before the
 * gate has decided anything, which is the opposite of what a gate is for.
 *
 * The DTL flavour keeps the bare call. It emits no helper, and inventing one
 * only for the gate would put a second read idiom in a file that has one.
 */
function ref(obj: string, path: string, inline: boolean): string {
  return inline
    ? `..ValueAt(${obj}, ${os(hl7Ref(path))})`
    : `${obj}.GetValueAt(${os(hl7Ref(path))})`;
}

// ---------------------------------------------------------------------------

/**
 * The business process class. Throws when `spec.iris.process` is absent, because
 * there is no sensible default for the one fact it carries that nothing else in
 * the spec does: the name of the config item to dispatch to.
 */
export function emitProcess(spec: Spec, collect?: BareRefs): string {
  const proc = spec.iris.process;
  if (!proc) {
    throw new Error(
      `This spec has no iris.process. Add it to emit a business process:\n` +
        `  iris: { process: { className: "Site.Interface.Process.X", sendTo: "ToTarget.ADT.TCP" } }\n` +
        `sendTo is the config item name as it is spelled in the production, and it is the ` +
        `one fact the bench cannot work out for itself.`,
    );
  }

  const notes = irisComments(spec);
  const inline = (proc.transform ?? "dtl") === "inline";
  // The DTL is only a fact about this class when this class calls it. Inline,
  // naming it in the header would read as a dependency that is not one.
  const dtl = inline ? undefined : spec.iris.className;
  const triggers = Object.keys(spec.gate.permit);
  const requires = spec.gate.require ?? [];
  const out: string[] = [];

  // $$$TRACE and $$$ISERR are Ensemble macros. Without this line the class does
  // not compile, and the error names the macro rather than the missing include.
  out.push(`Include Ensemble`, ``);

  // The header stands at every level. It carries the fingerprint and the
  // TEMPLATE claim, and a generated file that cannot be matched back to its
  // spec -- or that reads as if it had been proven when it has not -- is worse
  // than a verbose one. What drops below `full` is the prose about this tool's
  // opinions, which belongs in the repo's docs rather than in every class it
  // writes.
  out.push(
    ...(notes === "full"
      ? [
          `/// ${comment(proc.comment ?? `Business process for ${spec.name}`)}`,
          `///`,
          `/// Spec fingerprint: ${fingerprint(spec)}`,
          `///   The same string the DTL carries. Two classes out of one spec, and this`,
          `///   is how you tell whether they are still the same one.`,
          `///`,
          `/// TEMPLATE generated by hl7-bench. NOT proven on the bench: there is no`,
          `/// production on a laptop and nothing here has been executed. The DTL this`,
          `/// calls was proven; this file is a starting point that compiles.`,
          `///`,
          `/// The pattern below is a custom business process that clones the request,`,
          inline
            ? `/// maps the message inline, and dispatches by config item name. It is one`
            : `/// calls a DTL, and dispatches by config item name. It is one shop's shape,`,
          inline
            ? `/// shop's shape, not the only one. A routing engine with a rule whose`
            : `/// not the only one. A routing engine with a rule whose transform field names`,
          inline
            ? `/// transform field names a DTL does the same work with no class at all.`
            : `/// the DTL does the same work with no class at all.`,
          `///`,
          `/// Before this does anything in a namespace:`,
          `///   1. Add it to the production as a Business Process.`,
          `///   2. Confirm "${comment(proc.sendTo)}" is spelled exactly as the config item is.`,
          `///      A name that does not resolve fails at RUN time, per message, not at`,
          `///      compile time.`,
          `///   3. Decide where the gate lives. If a routing rule already filters these`,
          `///      messages, the filter below is a second copy of it.`,
        ]
      : [
          `/// ${comment(proc.comment ?? `Business process for ${spec.name}`)}`,
          `///`,
          `/// TEMPLATE generated by hl7-bench. NOT proven on the bench -- nothing here`,
          `///   has been executed, because a business process needs a production.`,
          `/// Spec fingerprint: ${fingerprint(spec)}`,
          `/// Dispatches to "${comment(proc.sendTo)}" -- spell it as the production does; a name`,
          `///   that does not resolve fails at RUN time, per message, not at compile time.`,
          `/// The gate below is a second copy of the routing rule's. Keep one.`,
        ]),
  );

  if (dtl) out.push(`///`, `/// Calls: ${comment(dtl)}`);
  if (inline) {
    out.push(
      `///`,
      ...pickNotes(
        notes,
        [
          `/// SELF-CONTAINED. The mapping is written into OnRequest below as plain`,
          `/// ObjectScript and no DataTransform is called, so this class is the whole`,
          `/// interface and the only artifact to deploy. That is what`,
          `/// iris.process.transform = "inline" asks for.`,
          `///`,
          `///   What it buys:  one class, and nothing for a team that will not deploy`,
          `///                  a DTL to refuse.`,
          `///   What it costs: a DTL is visible in the portal and this is not. No`,
          `///                  Visual Trace of the mapping, no DTL test page, and the`,
          `///                  next person reads ObjectScript instead of a diagram.`,
          `///`,
          `/// Do not hand-edit the body. Fix the spec and re-emit -- the fingerprint`,
          `/// above describes the SPEC, and an edit here makes it a lie.`,
        ],
        [
          `/// SELF-CONTAINED: the mapping is in OnRequest below and no DTL is called, so`,
          `/// this class is the whole interface. Fix the spec and re-emit, never this file.`,
        ],
      ),
    );
  }
  // Stamps survive `brief`: each is a field the delivered trace does not
  // account for, and the `why` is the author's own words. `off` drops them
  // with everything else.
  if ((proc.stamp ?? []).length > 0 && notes !== "off") {
    out.push(
      `///`,
      ...pickNotes(
        notes,
        [
          `/// Stamps (written here, NOT in the DTL, so the delivered trace does not`,
          `/// account for them -- say so when you hand the trace over):`,
        ],
        [`/// Stamps, written here and NOT in the DTL, so the delivered trace omits them:`],
      ),
      ...(proc.stamp ?? []).map((st) => `///   ${st.path} = "${comment(st.value)}" -- ${comment(st.why)}`),
    );
  }
  out.push(
    `///`,
    `/// Handles: ${triggers.join(", ")} from ${spec.gate.path}`,
    ``,
    `Class ${proc.className} Extends Ens.BusinessProcess [ ClassType = persistent, ProcedureBlock ]`,
    `{`,
    ``,
    `Method OnRequest(pRequest As EnsLib.HL7.Message, Output pResponse As Ens.Response) As %Status`,
    `{`,
    `    #dim tSC As %Status = $$$OK`,
    `    #dim tEvent As %String`,
    `    #dim tSource As EnsLib.HL7.Message`,
    `    #dim tTarget As EnsLib.HL7.Message`,
    ...(inline ? inlineDeclarations(spec) : []),
    ``,
  );

  // ---- trigger event filter -------------------------------------------------
  const eventRef = ref("pRequest", spec.gate.path, inline);
  out.push(
    // The gate rationale survives `brief` by name. "quit $$$OK" on a message
    // this interface is not for reads like a swallowed error until somebody
    // says it is deliberate, and that is exactly the line a maintainer
    // "fixes" into an error queue full of correct outcomes.
    ...pickNotes(
      notes,
      [
        `    // The events this interface handles. Anything else returns SUCCESS with a`,
        `    // trace, deliberately, and never an error. A message this interface is not`,
        `    // for is a correct outcome, and an error queue full of correct outcomes`,
        `    // teaches everyone to stop reading the error queue.`,
      ],
      [`    // Refused, not failed: a message this interface is not for is a correct outcome.`],
    ),
    `    set tEvent = ${eventRef}`,
  );
  if (triggers.length === 1) {
    out.push(`    if tEvent '= ${os(triggers[0])} {`);
  } else {
    const arms = triggers.map((t) => `(tEvent '= ${os(t)})`).join(" && ");
    out.push(`    if ${arms} {`);
  }
  out.push(
    `        $$$TRACE(${os(`${spec.gate.path} is `)}_tEvent_${os(`, which this interface does not handle`)})`,
    `        quit $$$OK`,
    `    }`,
    ``,
  );

  // ---- required equalities --------------------------------------------------
  if (requires.length > 0) {
    out.push(
      ...pickNotes(
        notes,
        [
          `    // Everything else the gate requires. Same rule: refused, not failed.`,
          `    // A feed that puts an A08 in ${spec.gate.path} while ${requires[0].path} says`,
          `    // something else is real, and the receiver believes one of them.`,
        ],
        [`    // Everything else the gate requires. Same rule: refused, not failed.`],
      ),
    );
    for (const r of requires) {
      out.push(
        `    if ${ref("pRequest", r.path, inline)} '= ${os(r.equals)} {`,
        `        $$$TRACE(${os(`${r.path} is not `)}_${os(r.equals)}_${os(`, refusing`)})`,
        `        quit $$$OK`,
        `    }`,
      );
    }
    out.push(``);
  }

  // ---- clone ----------------------------------------------------------------
  const create = spec.iris.create ?? "new";
  out.push(
    ...pickNotes(
      notes,
      [
        `    // The request object is shared with every other target the router handed`,
        `    // this message to. Anything written to it is written to THEIR copy as well,`,
        create === "copy"
          ? `    // and create='copy' means the transform starts from this object, so the`
            + `\n    // clone here is load-bearing rather than cautious.`
          : `    // and while create='new' builds a fresh target and touches nothing, that`
            + `\n    // is a property of today's spec and not of this class. Clone anyway.`,
      ],
      // Why the clone exists is not re-derivable: the object looks private and
      // is not. Deleting this line is a one-character edit that corrupts every
      // other subscriber's copy of the message. Under create='copy' the
      // transform starts FROM this object, so the clone stops being caution and
      // becomes the thing holding the mapping up -- a distinction worth its own
      // line even here.
      // Both branches survive `brief`, because both stop the same edit. Under
      // 'copy' the clone is holding the mapping up; under 'new' it looks unused
      // TODAY and a reader who deletes it has coupled this class to one version
      // of the spec.
      create === "copy"
        ? [
            `    // The request is SHARED with every other target the router handed it to,`,
            `    // and create='copy' starts the target from it. This clone is load-bearing.`,
          ]
        : [
            `    // The request is SHARED with every other target the router handed it to.`,
            `    // create='new' touches nothing today, but that is today's spec. Clone anyway.`,
          ],
    ),
    `    set tSource = pRequest.%ConstructClone(1)`,
    ``,
  );

  // ---- transform ------------------------------------------------------------
  if (inline) {
    out.push(...emitInlineMapping(spec, "    ", collect), ``);
  } else if (dtl) {
    out.push(
      `    set tSC = ##class(${dtl}).Transform(tSource, .tTarget)`,
      `    if $$$ISERR(tSC) quit tSC`,
      ``,
    );
  } else {
    // Printed at EVERY level, `off` included. This block replaces the only
    // statement that would have built tTarget, so it is the code's absence
    // speaking rather than a comment about the code. Dropping it leaves a
    // class that dispatches an unassigned object and says nothing about why.
    out.push(
      ...pickNotes(
        notes === "off" ? "brief" : notes,
        [
          `    // iris.className is not set in the spec, so the transform class cannot be`,
          `    // named here. Set it and regenerate rather than typing a name in: a name`,
          `    // typed here is a name the spec does not know about. Until it is set,`,
          `    // tTarget is never assigned and everything below it addresses nothing.`,
        ],
        [`    // iris.className is not set, so tTarget is never assigned. Set it and re-emit.`],
      ),
      `    // set tSC = ##class(Your.Transform.Class).Transform(tSource, .tTarget)`,
      `    // if $$$ISERR(tSC) quit tSC`,
      ``,
    );
  }

  // ---- stamps ---------------------------------------------------------------
  const stamps = proc.stamp ?? [];
  if (stamps.length > 0) {
    out.push(
      ...pickNotes(
        notes,
        [
          `    // Fixed values written after the transform, each for the reason on its`,
          `    // own line. A value that is fixed for this interface belongs in the DTL`,
          `    // as a literal() row instead, where the delivered trace shows it and the`,
          `    // fingerprint covers it. These are here because they depend on WHERE the`,
          `    // message is going, which the transform cannot see.`,
          `    //`,
          `    // IsMutable is load bearing. A message that has been through a DTL or has`,
          `    // been saved refuses SetValueAt, and it refuses at RUN time, per message,`,
          `    // with <Ens>ErrGeneral: Cannot modify immutable message. The class`,
          `    // compiles without this line, which is what makes leaving it out cost a`,
          `    // morning rather than a compile.`,
        ],
        // The IsMutable reason is the one a maintainer cannot re-derive: the
        // class compiles without the line and dies at RUN time, per message.
        [`    // Without IsMutable, SetValueAt fails at RUN time: Cannot modify immutable message.`],
      ),
      `    set tTarget.IsMutable = 1`,
    );
    for (const st of stamps) {
      if (notes !== "off") out.push(`    // ${comment(st.why)}`);
      out.push(`    do tTarget.SetValueAt(${os(st.value)}, ${os(hl7Ref(st.path))})`);
    }
    out.push(``);
  }

  // ---- dispatch -------------------------------------------------------------
  out.push(
    ...pickNotes(
      notes,
      [
        `    // The 0 is pResponseRequired. Fire and forget: no OnResponse method, no`,
        `    // reply correlated back to this process. An ACK from the receiving`,
        `    // operation is handled by the operation, not here. Pass 1 instead and this`,
        `    // class needs an OnResponse or it will sit waiting.`,
      ],
      [`    // The 0 is pResponseRequired. Pass 1 and this class needs an OnResponse.`],
    ),
    `    set tSC = ..SendRequestAsync(${os(proc.sendTo)}, tTarget, 0)`,
    ``,
    `    quit tSC`,
    `}`,
    ``,
  );

  // The guarded read the inline body is built on. Emitted only when something
  // calls it: a helper nobody calls is dead code in a generated file, and dead
  // code in a generated file is how the next person stops trusting the rest.
  if (inline) out.push(...inlineHelpers(notes));

  out.push(`}`, ``);

  return out.join("\n");
}
