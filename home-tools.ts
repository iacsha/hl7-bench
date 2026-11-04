/**
 * home-tools.ts -- the commands the home page can run, as data.
 *
 * WHY A FIXED LIST
 *
 * The page turns form fields into a `bun <tool>.ts ...` command and runs it.
 * A page that ran whatever it was sent would be a shell on a port. So every
 * tool, every argument and every flag it may carry is declared here; `build()`
 * refuses anything else, and the server spawns an argv array, never a shell
 * string. A file argument must resolve inside the workspace. A text argument may
 * not start with "-", so a value can never become a flag.
 *
 * The CLI is still the tool. The page prints the exact command it ran, so the
 * command line is learned by using the page rather than replaced by it.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

export type ArgKind =
  /** An HL7 message file in the workspace. */
  | "message"
  /** An ObjectScript class file in the workspace. */
  | "class"
  /** Any file in the workspace. */
  | "file"
  /** Free text, e.g. a DocType or a case prefix. */
  | "text"
  /** An on/off flag. */
  | "flag"
  /** One of a fixed set. */
  | "choice";

export interface Arg {
  name: string;
  label: string;
  kind: ArgKind;
  /** The flag the value follows ("--doctype"), or the flag itself for kind "flag". Absent = positional. */
  flag?: string;
  required?: boolean;
  placeholder?: string;
  choices?: { value: string; label: string }[];
  help?: string;
  /** Remembered across tools under this key, e.g. one DocType for every form. */
  shared?: string;
}

export interface Tool {
  id: string;
  group: string;
  title: string;
  /** One sentence: what you learn by running it. */
  does: string;
  /** The script, or "test" for `bun test`. */
  script: string;
  /** Arguments that always come first, e.g. the "gui" subcommand. */
  fixed?: string[];
  args: Arg[];
  /** A server that keeps running; the page shows its link and a Stop button. */
  server?: boolean;
}

const DOCTYPE: Arg = {
  name: "doctype", label: "DocType", kind: "text", flag: "--doctype",
  placeholder: "Vendor:ADT_A01", shared: "doctype",
  help: "As the Message Viewer shows it. Category, colon, structure.",
};
const MESSAGE: Arg = { name: "message", label: "Message", kind: "message", required: true, shared: "message" };
const CLASS: Arg = { name: "class", label: "Class file", kind: "class", required: true, shared: "class" };

export const TOOLS: Tool[] = [
  // ---- a class somebody else wrote ----------------------------------------
  {
    id: "overlay-gui", group: "Change an existing class", title: "Overlay page",
    does: "Add changes to their class in a form, run before and after in IRIS, save the modified class.",
    script: "overlay.ts", fixed: ["gui"], server: true,
    args: [CLASS, MESSAGE, { ...DOCTYPE, help: "Needed the first time; remembered in the changes file after that." }],
  },
  {
    id: "overlay-run", group: "Change an existing class", title: "Overlay, no page",
    does: "Apply the saved changes file, run both classes, print the fields that changed.",
    script: "overlay.ts", fixed: ["--run"],
    args: [CLASS, MESSAGE, DOCTYPE],
  },
  {
    id: "engine-script", group: "Change an existing class", title: "Run a class as it is",
    does: "Put the message through their class in IRIS and show what it sends.",
    script: "engine.ts",
    args: [
      MESSAGE,
      { ...CLASS, flag: "--script" },
      DOCTYPE,
      { name: "host", label: "Run the class whole (--host)", kind: "flag", flag: "--host", help: "Automatic for a class that sends tRequest." },
    ],
  },

  // ---- an interface you are building ---------------------------------------
  {
    id: "gui", group: "Build an interface from a spec", title: "Spec editor page",
    does: "Edit the spec in a form with the message, the output and the generated class side by side.",
    script: "gui.ts", server: true,
    args: [{ ...MESSAGE, required: false }],
  },
  {
    id: "bench", group: "Build an interface from a spec", title: "Run the spec",
    does: "What the spec turns this message into.",
    script: "bench.ts", args: [MESSAGE],
  },
  {
    id: "check", group: "Build an interface from a spec", title: "Check the golden files",
    does: "PASS or FAIL for every case in messages\\.",
    script: "check.ts",
    args: [{ name: "prefix", label: "Only cases containing", kind: "text", placeholder: "a01 (blank for all)" }],
  },
  {
    id: "trace", group: "Build an interface from a spec", title: "Mapping document",
    does: "Every field's journey from source to target, for the receiving team.",
    script: "trace.ts", args: [MESSAGE],
  },
  {
    id: "reads", group: "Build an interface from a spec", title: "Empty reads",
    does: "Which source paths came back with nothing on this message.",
    script: "reads.ts",
    args: [MESSAGE, { name: "strict", label: "Fail if a block is at risk (--strict)", kind: "flag", flag: "--strict" }],
  },
  {
    id: "classify", group: "Build an interface from a spec", title: "Size the job",
    does: "The difference between what arrives and what the receiver wants.",
    script: "classify.ts",
    args: [
      { name: "have", label: "Message you have", kind: "message", required: true },
      { name: "want", label: "Message they want", kind: "message", required: true },
    ],
  },
  {
    id: "gate", group: "Build an interface from a spec", title: "Would these get through?",
    does: "Run the spec's gate over a batch of messages.",
    script: "gate.ts", args: [{ ...MESSAGE, label: "Messages (one file)" }],
  },
  {
    id: "emit", group: "Build an interface from a spec", title: "Generate ObjectScript",
    does: "Print the class the spec produces. Copy it, or use the CLI with -o to write a file.",
    script: "emit.ts",
    args: [{
      name: "what", label: "What", kind: "choice", required: true,
      choices: [
        { value: "", label: "DTL class" },
        { value: "process", label: "Business process" },
        { value: "promote", label: "QA / PROD checklist" },
        { value: "tables", label: "Lookup tables (XML)" },
      ],
    }],
  },

  // ---- IRIS and the schema ---------------------------------------------------
  {
    id: "navcheck", group: "IRIS and the schema", title: "Does it navigate?",
    does: "Read the message in IRIS under the DocType and report paths that resolve to nothing.",
    script: "navcheck.ts", args: [MESSAGE, DOCTYPE],
  },
  {
    id: "schemacheck", group: "IRIS and the schema", title: "Spec against a schema dump",
    does: "Offline: check the spec's paths against a pasted zw dump. No IRIS needed.",
    script: "schemacheck.ts",
    args: [{ name: "dump", label: "Schema dump", kind: "file", required: true }],
  },
  {
    id: "schemacommands", group: "IRIS and the schema", title: "What to paste for a dump",
    does: "The zw lines to run in a terminal to produce a schema dump.",
    script: "schemacheck.ts", fixed: ["--commands"], args: [],
  },
  {
    id: "schemasync", group: "IRIS and the schema", title: "Engine schema vs spec",
    does: "Compare the engine's custom schema with the one the spec declares.",
    script: "schema-sync.ts", args: [],
  },
  {
    id: "patterns", group: "Learn", title: "The twelve moves",
    does: "Each common transformation, run, with its IRIS DTL.",
    script: "patterns.ts",
    args: [
      { name: "which", label: "Pattern", kind: "text", placeholder: "P5 (blank for all)" },
      { ...MESSAGE, required: false, label: "Against message" },
    ],
  },
  {
    id: "selftest", group: "Learn", title: "Is the bench sound?",
    does: "The bench's own test suite. Anything but 0 fail means this copy is not the one you think.",
    script: "test", args: [],
  },
];

// ---------------------------------------------------------------------------

export type Values = Record<string, string | boolean | undefined>;

export interface Built {
  /** The argv after `bun`. */
  argv: string[];
  /** The command as you would type it, for the page and for learning. */
  display: string;
}

/** A path argument, inside the workspace or refused. */
function inside(root: string, value: string): string | null {
  const abs = resolve(root, value);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel;
}

const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/**
 * Turn form values into argv, or refuse with one sentence per problem.
 * `root` is the workspace; file arguments are made relative to it.
 */
export function build(tool: Tool, values: Values, root: string): Built | { problems: string[] } {
  const problems: string[] = [];
  const argv: string[] = tool.script === "test" ? ["test"] : [tool.script, ...(tool.fixed ?? [])];
  for (const a of tool.args) {
    const raw = values[a.name];
    if (a.kind === "flag") {
      if (raw === true || raw === "true") argv.push(a.flag!);
      continue;
    }
    const v = typeof raw === "string" ? raw.trim() : "";
    if (a.kind === "choice") {
      if (!a.choices!.some((c) => c.value === v)) { problems.push(`${a.label}: "${v}" is not one of the choices.`); continue; }
      if (v !== "") argv.push(v);
      continue;
    }
    if (v === "") {
      if (a.required) problems.push(`${a.label} is required.`);
      continue;
    }
    let out = v;
    if (a.kind === "message" || a.kind === "class" || a.kind === "file") {
      const rel = inside(root, v);
      if (rel === null) { problems.push(`${a.label}: ${v} is outside the workspace.`); continue; }
      out = rel.split(sep).join(sep === "\\" ? "\\" : "/");
    } else if (v.startsWith("-")) {
      problems.push(`${a.label} may not start with "-".`);
      continue;
    } else if (/[\r\n\0]/.test(v)) {
      problems.push(`${a.label} must be one line.`);
      continue;
    }
    if (a.flag) argv.push(a.flag);
    argv.push(out);
  }
  if (problems.length > 0) return { problems };
  return { argv, display: ["bun", ...argv].map(quote).join(" ") };
}

export function toolById(id: string): Tool | undefined {
  return TOOLS.find((t) => t.id === id);
}

/** The port a server tool will announce, so the page can link to it. */
export function serverUrl(line: string): string | undefined {
  return /(https?:\/\/127\.0\.0\.1:\d+)/.exec(line)?.[1];
}
