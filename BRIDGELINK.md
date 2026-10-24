# hl7-bench for BridgeLink and Mirth

You write the interface once as a spec. The bench runs it against real messages
on your own machine. From the same spec it gives you the channel's source
filter, its JavaScript transformer step, or the whole channel ready for
Import Channel. Everything below works without IRIS.

The step is ES5 JavaScript for the Rhino that BridgeLink and Mirth bundle,
written against the standard HL7 v2 XML (`msg['PID']['PID.5']['PID.5.1']`).
There is no Java to compile and nothing to install on the server.

## What has been proven, and where

On **BridgeLink 26.9.0**, 2026-10-24. Every case below was sent through a
deployed channel and compared line for line with the bench's own output:

| Run | Result |
|---|---|
| `conformance/spec.ts`: every source, step, repeat stage and block option | 5/5 agree |
| Six real site specs (ADT passthrough, DFT to MDM with select and fold) | 9/9 agree |
| `bridgelink:channel` file stamped 4.5.0, imported into 26.9.0 | imported, deployed, transformed |
| Same channel with an MLLP listener and an MLLP sender | deployed, STARTED |

Not yet proven: an older Mirth (3.x or 4.x) in the engine, and messages sent
over MLLP rather than through the API.

## Setup

1. Install [bun](https://bun.sh). It is one executable, and no admin rights
   are needed.
2. Clone the repo and run `bun test` once. It should report 0 fail.
3. Copy `transform.ts` to `transform.mysite.local.ts`. Any `*.local.ts` is
   gitignored. Then point the bench at it in `.env`:

   ```
   HL7_BENCH_TRANSFORM=transform.mysite.local.ts
   ```

## The smallest BridgeLink spec

```ts
export const spec: Spec = {
  name: "ADT to Downstream",
  gate: { path: "MSH-9.2", permit: { A01: "A01", A08: "A08" } },

  bridgelink: {
    channelName: "ADT to Downstream",
    log: "warn",
    // Optional. Leave both out for a Channel Reader in and a Channel Writer
    // to none, then wire it up in the Administrator.
    listenPort: 6661,
    sendTo: { host: "receiver.example", port: 7001 },
  },

  // Required by the spec type even for a BridgeLink-only interface. Two
  // stock DocTypes are enough; nothing on this side reads them.
  iris: { sourceDocType: "2.5:ADT_A01", targetDocType: "2.5:ADT_A01" },

  blocks: [
    { id: "MSH", wholeSegment: true, rows: [{ target: "MSH-3", from: literal("BENCH") }] },
    { id: "PID", wholeSegment: true, rows: [{ target: "PID-19", from: literal("") }] },
  ],
};
```

`WORKFLOW.md` covers the whole vocabulary. Every item in it works on
BridgeLink except `bundle`, which is refused by name rather than dropping the
companion segments.

## The loop

```
bun gui.ts                          spec as a form; the BridgeLink tab shows filter and step
bun bench.ts message.hl7            run one message
bun check.ts                        golden cases in messages\
bun emit.ts bridgelink              the transformer step, to paste
bun emit.ts bridgelink:channel > ADT.xml    the whole channel, for Import Channel
bun bridgelink-check.ts             run every case in a real engine, diff against the bench
```

`emit` prints the source filter on stderr when you ask for the step alone.
When you ask for the channel, the filter is already inside it.

## Running against your engine

`bridgelink-check.ts` creates one scratch channel named `hl7-bench check`,
deploys it, sends every case, and compares what the engine delivered with
what the bench delivers. It clears the channel's messages and undeploys it
afterwards; `--keep` leaves it deployed for a look. Nothing else on the
server is touched. Settings go in `.env`:

```
BRIDGELINK_URL=https://your-server:8443
BRIDGELINK_USER=admin-account
BRIDGELINK_PASSWORD_CMD=command that prints the password
BRIDGELINK_TLS_INSECURE=1
```

- `BRIDGELINK_URL` is the server API port (8443), not a WebAdmin UI.
- `BRIDGELINK_PASSWORD` works too, but `_CMD` keeps the secret out of the
  file.
- `BRIDGELINK_TLS_INSECURE=1` accepts the self-signed certificate every
  install ships with. It's opt-in on purpose.

Cases are the spec module's exported `cases` when it has them, `messages\`
otherwise: `<name>.in.hl7` to transform, `<name>.reject.hl7` for the gate to
refuse. To prove your server against the whole vocabulary:

```
HL7_BENCH_TRANSFORM=conformance/spec.ts bun bridgelink-check.ts
```

## XML interfaces

The same vocabulary works over XML, in either direction or both. An XML path
starts with `/` and is written from the document element. An HL7 path never
starts with `/`, so that leading slash is the only way the bench tells them
apart. The gate path's syntax sets the format the spec reads, and the block
ids set the format it writes:

| Spec | Gate path | Block ids |
|---|---|---|
| XML to XML | `/Order/Header/Type` | `/Order/Person`, `/Order/Kin/Person` |
| HL7 to XML | `MSH-9.2` | `/Registration/Patient` |
| XML to HL7 | `/Order/Header/Type` | `MSH`, `PID`, `NK1` |

```ts
{ target: "/Registration/Patient/@mrn", from: copy("PID-3.1") }
{ id: "/Order/Kin/Person", repeat: { over: "/Order/Contacts/Contact",
    skipWhenEmpty: "/Order/Contacts/Contact/Name" }, rows: [...] }
```

- **Paths.** `/Order/Items/Item[2]/Code` reads the second Item;
  `/Order/Patient/@id` reads an attribute, which can only be the last step.
  A step with no index means the first match on a read and every match on a
  walk.
- **Records.** A block delivers one element, or one per occurrence when it
  repeats. Rows write under it, and parents are created once, the first time
  a record needs them. Inside a repeat over `/Order/Contacts/Contact`, a path
  under that prefix means this occurrence's Contact, the same rule as PID-3
  inside a PID loop.
- **Text.** An element's value is all its text, CDATA and entities decoded.
  A leading space is kept, so `fold` still finds continuation lines.
- **Namespaces are matched by local name** on both sides, and the delivered
  document carries none. A prefixed root or a default namespace reads the same
  as plain names.
- **HL7 only:** `pickRepeat` (use `fromWhere` on the record), `bundle`, and
  `wholeSegment` across formats. Each is refused by name.
- **Cases** are `<name>.in.xml`, `<name>.want.xml` and `<name>.reject.xml`
  beside the `.hl7` ones. Each file uses the format of its own side, and XML is
  compared in canonical form.

Proven on BridgeLink 26.9.0, comparing namespaces strictly:
`conformance/xml-to-xml.ts` 5/5, `hl7-to-xml.ts` 3/3, `xml-to-hl7.ts` 3/3.
IRIS emits HL7 v2 only and refuses an XML spec by name.

## Engine facts the step handles for you

Each was found by running the step, not by reading it.

1. **Every field arrives nested.** The parser writes even a one-piece field as
   `<MSH.11><MSH.11.1>T</MSH.11.1></MSH.11>`. A bare `.toString()` on that
   returns markup. The filter once filtered every message because of it.
2. **A composite written whole has to be split.** Write `1234^N^M` into TXA-22
   as one text node, then write TXA-22.19 on top, and the component lands two
   places to the right. Writes are split on the message's separators, the way
   the parser splits them.
3. **XML namespaces fight both ways.** With the XML data type's Strip
   Namespaces on, BridgeLink removes the `xmlns:ns` declaration and leaves the
   prefix, so `<ns:Order>` no longer parses. With it off, `child('Header')`
   misses a namespaced child, and elements the step builds inherit the
   inbound default namespace. The channel keeps namespaces. The step matches
   names locally, resets the default namespace, and rebuilds seeded records
   without one.
4. **The separators come from MSH.** A sender declaring `#` as its component
   separator is handled. Any fixed text you write with `prefix("ADT^")` is
   yours to get right, on both engines.

## What it does not do yet

- **Lookup tables live inside the step.** A table change means redeploying
  the channel; nothing is edited in the Administrator.
- **Groups do not exist in this XML.** `group` matters only to the IRIS DTL,
  and the step says so in a comment.
- **XML in the GUI form, the mapping document and IRIS.** The GUI previews
  the BridgeLink tab and runs the bench on XML. Its form, `trace.ts` and the
  IRIS emitters are HL7 v2 only. See ROADMAP.md.
