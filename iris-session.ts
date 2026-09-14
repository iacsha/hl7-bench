/**
 * iris-session.ts -- how `navcheck.ts` and `schema-sync.ts` reach an instance,
 * and what they say when they cannot.
 *
 * Shared because the two of them fail in exactly the same three ways, and each
 * used to report only stderr:
 *
 *   could not reach IRIS (local): no output
 *
 * True, and useless. The thing that explains the commonest failure is on STDOUT.
 * An instance with password authentication on the terminal service answers a
 * piped script with `Username:`, reads the first line of ObjectScript as the
 * username, exits, and writes nothing to stderr at all. Seen on a native Windows
 * install 2026-09-14; never here, because the lab container does not prompt.
 *
 * The three ways:
 *
 *   1. The command will not start -- wrong IRIS_EXE, or `docker` not installed.
 *      spawnSync THROWS for this, so it has to be caught rather than checked.
 *   2. It starts and refuses -- the credentials prompt above.
 *   3. It starts, runs, and the script itself fails.
 *
 * Each gets a different sentence, because they have different fixes.
 */

const MODE = (process.env.IRIS_MODE ?? "docker").toLowerCase();
const CONTAINER = process.env.IRIS_CONTAINER ?? "iris-lab";
const INSTANCE = process.env.IRIS_INSTANCE ?? "IRIS";
const IRIS_EXE = process.env.IRIS_EXE ?? "iris";

/**
 * Credentials for an instance whose console asks for them.
 *
 * A piped session CAN answer the prompts: the terminal reads the first line as
 * the username and the second as the password, which is exactly why a script
 * sent to a prompting instance loses its first line and dies. Sending them
 * deliberately costs nothing and changes no security setting on the instance.
 *
 * Leave unset for an instance that does not prompt -- sending a username to one
 * that is not asking would feed it to the ObjectScript interpreter instead.
 *
 * These belong in `.env`, which is gitignored, and never on a command line where
 * a shell history would keep them.
 */
const IRIS_USER = process.env.IRIS_USER?.trim();
const IRIS_PASSWORD = process.env.IRIS_PASSWORD ?? "";

export const NAMESPACE = process.env.IRIS_NAMESPACE ?? "USER";
/** Where a message is readable FROM INSIDE the engine. */
export const REMOTE = process.env.IRIS_LAB_DIR ?? "/lab";
export { MODE, CONTAINER, INSTANCE };

export function irisCommand(): string[] {
  return MODE === "docker"
    ? ["docker", "exec", "-i", CONTAINER, "iris", "session", INSTANCE]
    : [IRIS_EXE, "session", INSTANCE];
}

export type IrisResult = { out: string; err: string; code: number | null };

const head = (s: string, n = 6) =>
  s
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(0, n)
    .map((l) => `    ${l}`)
    .join("\n");

/**
 * Run ObjectScript and hand back the transcript, or explain the silence.
 *
 * `onFailure` decides whether a transcript counts as an answer: navcheck accepts
 * any run that produced its DOCTYPE line even on a non-zero exit, because a
 * `halt` can exit oddly while the writes already landed.
 */
export function runIris(
  toolName: string,
  objectScript: string,
  answered: (out: string) => boolean,
): IrisResult {
  const cmd = irisCommand();

  const script = objectScript.endsWith("\n") ? objectScript : objectScript + "\n";
  const stdin = IRIS_USER ? `${IRIS_USER}\n${IRIS_PASSWORD}\n${script}` : script;

  let p: { exitCode: number | null; stdout: Buffer; stderr: Buffer };
  try {
    p = Bun.spawnSync(cmd, {
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    }) as typeof p;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    const hint =
      MODE === "docker"
        ? `IRIS_MODE is "docker" and docker is not here. On a native install set IRIS_MODE=local.`
        : `Check IRIS_EXE. On Windows it is usually <install dir>\\bin\\iris.exe, and\n` +
          `"iris" alone is not on PATH unless somebody put it there.`;
    fail(toolName, [`could not start the engine command.`, `  ran            ${cmd.join(" ")}`, `  it said        ${detail}`, ``, hint]);
  }

  const out = p.stdout.toString();
  const err = p.stderr.toString();

  if (answered(out)) return { out, err, code: p.exitCode };

  const lines = [
    `could not reach IRIS (${MODE}).`,
    `  ran            ${cmd.join(" ")}`,
    `  namespace      ${NAMESPACE}`,
    `  exit code      ${p.exitCode}`,
  ];
  if (out.trim()) lines.push(`  it printed`, head(out));
  if (err.trim()) lines.push(`  on stderr`, head(err));
  if (!out.trim() && !err.trim()) lines.push(`  it printed nothing at all`);

  if (/username:/i.test(out)) {
    lines.push(
      ``,
      IRIS_USER
        ? `It asked again with IRIS_USER=${IRIS_USER} already being sent, so the credentials\n` +
          `were refused rather than missing. Check the username and password, and that the\n` +
          `account is not disabled or expired.`
        : `That "Username:" is the whole problem. This instance's console service wants\n` +
          `credentials, so it read the first line of the script as a username.\n` +
          `\n` +
          `Set them in .env, which is gitignored:\n` +
          `  IRIS_USER=_system\n` +
          `  IRIS_PASSWORD=<the password>\n` +
          `\n` +
          `A piped session answers the prompts with its first two lines, so nothing about\n` +
          `the instance's security has to change. The alternative, on a local dev box you\n` +
          `own, is to allow Unauthenticated on %Service_Console -- but that session logs in\n` +
          `as UnknownUser, which will not have the privileges to import a schema or compile\n` +
          `a class until you grant them.`,
    );
  } else if (/<PROTECT>/.test(out)) {
    lines.push(
      ``,
      `<PROTECT> is a privilege refusal, not a connection problem. The account that`,
      `logged in cannot do what the script asked -- writing a schema category and`,
      `compiling a class both need more than a default user has.`,
    );
  } else if (/<NAMESPACE>/.test(out)) {
    lines.push(
      ``,
      `<NAMESPACE> means IRIS_NAMESPACE names a namespace this instance does not have.`,
      `Check the spelling against the list in the Management Portal.`,
    );
  }

  fail(toolName, lines);
}

function fail(toolName: string, lines: string[]): never {
  process.stderr.write(`${toolName}: ${lines.join("\n")}\n`);
  process.exit(2);
  throw new Error("unreachable");
}
