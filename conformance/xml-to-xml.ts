/**
 * conformance/xml-to-xml.ts -- the vocabulary over an XML message, delivered
 * as XML.
 *
 *   HL7_BENCH_TRANSFORM=conformance/xml-to-xml.ts bun bridgelink-check.ts
 *
 * SYNTHETIC-DEMO-SPEC. Every name, number and code here is invented.
 *
 * The cases carry what an XML reader gets wrong quietly: a namespace prefix,
 * an entity, a CDATA section, an attribute read and written, and a
 * continuation line whose leading space is the only thing that marks it.
 */

import {
  copy, literal, firstOf, lookup, counter, event, fromFirst, fromWhere, sameAs,
  blank, passthrough, constant,
  date8, truncate, upper, stripChars, defaultTo, prefix,
  highest, continuation,
  type Spec,
} from "../spec";

const C = "/Order/Contacts/Contact";
const N = "/Order/Notes/Note";

export const spec: Spec = {
  name: "XML Conformance",
  description: "Synthetic: an XML order reshaped into XML, using every source, step and repeat stage XML can say.",

  gate: {
    path: "/Order/Header/Type",
    permit: { NEW: "NEW", UPD: "UPDATE" },
    require: [{ path: "/Order/@version", equals: "2" }],
  },

  bridgelink: { channelName: "hl7-bench xml conformance", log: "warn" },


  tables: {
    Sex: { M: "MALE", F: "FEMALE" },
    Relation: { SPO: "SPOUSE", FTH: "FATHER" },
  },

  blocks: [
    {
      id: "/Order/Meta",
      rows: [
        { target: "/Order/Meta/Kind", from: literal("ORDER") },
        { target: "/Order/Meta/Event", from: event(), via: [prefix("ORD-")] },
        { target: "/Order/Meta/Sent", from: copy("/Order/Header/Sent"), via: [date8()] },
        { target: "/Order/Meta/Facility", from: firstOf("/Order/Header/Site", "/Order/Header/Facility") },
      ],
    },
    {
      id: "/Order/Person",
      rows: [
        { target: "/Order/Person/@mrn", from: copy("/Order/Patient/Mrn"), required: true },
        { target: "/Order/Person/@ref", from: copy("/Order/Patient/@id") },
        { target: "/Order/Person/Name/Last", from: copy("/Order/Patient/Name/Family"), via: [upper()] },
        { target: "/Order/Person/Name/First", from: copy("/Order/Patient/Name/Given"), via: [upper(), truncate(3)] },
        { target: "/Order/Person/Sex", from: lookup("Sex", "/Order/Patient/Sex", passthrough()) },
        { target: "/Order/Person/Race", from: lookup("Sex", "/Order/Patient/Race", blank()) },
        { target: "/Order/Person/Born", from: copy("/Order/Patient/BirthDate"), via: [date8()] },
        { target: "/Order/Person/Phone", from: copy("/Order/Patient/Phone"), via: [stripChars("()- ")] },
        { target: "/Order/Person/Email", from: copy("/Order/Patient/Email"), via: [defaultTo("NONE")] },
        { target: "/Order/Person/Display", from: sameAs("/Order/Person/Name/Last") },
      ],
    },
    {
      id: "/Order/Kin/Person",
      repeat: { over: C, skipWhenEmpty: `${C}/Name`, skipValues: ["UNKNOWN"], max: 2 },
      rows: [
        { target: "/Order/Kin/Person/@seq", from: counter() },
        { target: "/Order/Kin/Person/Name", from: copy(`${C}/Name`) },
        { target: "/Order/Kin/Person/Relation", from: lookup("Relation", `${C}/@rel`, constant("OTHER")) },
      ],
    },
    {
      id: "/Order/Summary",
      rows: [
        { target: "/Order/Summary/FirstRelation", from: fromFirst(C, `${C}/Name`, `${C}/@rel`) },
        { target: "/Order/Summary/FatherSeq", from: fromWhere(C, `${C}/@rel`, "FTH", `${C}/Seq`) },
        {
          target: "/Order/Summary/FatherLabel",
          from: lookup("Relation", fromWhere(C, `${C}/Seq`, "4", `${C}/@rel`), constant("OTHER")),
        },
      ],
    },
    {
      // Newest revision only, continuation lines joined back into paragraphs.
      id: "/Order/Report/Line",
      repeat: { over: N, select: highest(`${N}/@rev`), fold: continuation(N) },
      rows: [
        { target: "/Order/Report/Line/@n", from: counter() },
        { target: "/Order/Report/Line", from: copy(N) },
      ],
    },
    {
      id: "/Order/Report/Line",
      continuesNumbering: true,
      rows: [
        { target: "/Order/Report/Line/@n", from: counter() },
        { target: "/Order/Report/Line", from: literal("END") },
      ],
    },
    {
      // Passed through whole, then one attribute added on top.
      id: "/Order/Items",
      wholeSegment: true,
      rows: [{ target: "/Order/Items/@checked", from: literal("yes") }],
    },
  ],
};

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export const cases = [
  {
    name: "xml-full",
    input: `<?xml version="1.0" encoding="UTF-8"?>
<ns:Order xmlns:ns="urn:example:order" version="2">
  <!-- a comment the reader must not see -->
  <Header>
    <Type>NEW</Type>
    <Facility>FAC1</Facility>
    <Sent>20261024101500</Sent>
  </Header>
  <Patient id="P-77">
    <Mrn>MRN1</Mrn>
    <Name><Family>o'brien</Family><Given>maryanne</Given></Name>
    <Sex>F</Sex>
    <BirthDate>19750301120000</BirthDate>
    <Phone>(585) 555-0100</Phone>
  </Patient>
  <Contacts>
    <Contact rel="SPO"><Name>Roe &amp; Jane</Name><Seq>1</Seq></Contact>
    <Contact rel="BRO"><Name>UNKNOWN</Name><Seq>2</Seq></Contact>
    <Contact rel="FTH"><Name/><Seq>3</Seq></Contact>
    <Contact rel="FTH"><Name>Poe</Name><Seq>4</Seq></Contact>
    <Contact rel="SON"><Name>Doe</Name><Seq>5</Seq></Contact>
  </Contacts>
  <Notes>
    <Note rev="1">first draft</Note>
    <Note rev="2">Findings are</Note>
    <Note rev="2"> unremarkable.</Note>
    <Note rev="2"><![CDATA[Impression: <normal> & stable.]]></Note>
  </Notes>
  <Items>
    <Item code="A">one</Item>
    <Item code="B">two</Item>
  </Items>
</ns:Order>
`,
  },
  {
    // Everything optional missing: no contacts, notes or items, an unmapped
    // sex code passed through, and the fallback facility.
    name: "xml-sparse",
    input: `<Order version="2"><Header><Type>UPD</Type><Site>SITE9</Site><Facility>FAC1</Facility></Header>` +
      `<Patient><Mrn>MRN2</Mrn><Name><Family>single</Family></Name><Sex>U</Sex></Patient></Order>`,
  },
  {
    // A DEFAULT namespace, so every element is in it without a prefix, and a
    // seeded record carrying it. The delivered document must carry none.
    name: "xml-default-ns",
    input: `<Order xmlns="urn:example:order" version="2"><Header><Type>NEW</Type><Facility>F2</Facility></Header>` +
      `<Patient id="P2"><Mrn>MRN3</Mrn><Name><Family>lee</Family><Given>ann</Given></Name></Patient>` +
      `<Items><Item code="Z">zed</Item></Items></Order>`,
  },
  {
    name: "xml-reject-type",
    reject: true,
    input: `<Order version="2"><Header><Type>DEL</Type></Header><Patient><Mrn>M</Mrn></Patient></Order>`,
  },
  {
    name: "xml-reject-version",
    reject: true,
    input: `<Order version="1"><Header><Type>NEW</Type></Header><Patient><Mrn>M</Mrn></Patient></Order>`,
  },
];
