/**
 * bridgelink-session.ts -- how `bridgelink-check.ts` reaches a BridgeLink (or
 * Mirth Connect) server, over the same REST API the Administrator uses.
 *
 * The counterpart of `iris-session.ts`, and for the same reason: a generated
 * step that has only ever been read is a claim. The bench runs on bun against
 * `hl7.ts`; the step runs on Rhino against E4X, and those are two languages
 * that happen to share a name. Only the engine can say what the step does.
 *
 *   BRIDGELINK_URL            https://host:8443  (the server, not WebAdmin)
 *   BRIDGELINK_USER           an Administrator account
 *   BRIDGELINK_PASSWORD       its password, or...
 *   BRIDGELINK_PASSWORD_CMD   ...a command whose first output line is it
 *   BRIDGELINK_TLS_INSECURE   1 to accept a self-signed certificate
 *
 * These belong in `.env`, which is gitignored, and never on a command line
 * where shell history keeps them. Same rule and same `_CMD` escape hatch as
 * IRIS_PASSWORD, for the same reason: the thing that protects the secret is
 * whatever answers the command, not this file.
 *
 * WHY TLS_INSECURE IS OPT-IN
 *
 * Every Mirth install ships a self-signed certificate, so the default that
 * "just works" is to skip verification. That is also the default that sends a
 * password to whoever answers on 8443. Saying so once in `.env` is cheap.
 */

import { spawnSync } from "node:child_process";

export interface Session {
  base: string;
  cookie: string;
  insecure: boolean;
}

/** One request, with the header the API refuses to work without. */
async function call(
  s: Pick<Session, "base" | "insecure"> & { cookie?: string },
  method: string,
  path: string,
  body?: string,
  contentType = "application/xml",
): Promise<{ status: number; text: string; headers: Headers }> {
  const headers: Record<string, string> = {
    // Without it the server answers every call with 400. It is the API's CSRF
    // guard, and it is the first thing a hand-rolled client gets wrong.
    "X-Requested-With": "hl7-bench",
    // XML first, but not ONLY: /server/version answers text/plain and a bare
    // application/xml gets 406 for it.
    Accept: "application/xml, text/plain;q=0.9",
  };
  if (s.cookie) headers.Cookie = s.cookie;
  if (body !== undefined) headers["Content-Type"] = contentType;
  const res = await fetch(`${s.base}/api${path}`, {
    method,
    headers,
    body,
    tls: { rejectUnauthorized: !s.insecure },
  } as RequestInit);
  return { status: res.status, text: await res.text(), headers: res.headers };
}

function password(): string {
  const plain = process.env.BRIDGELINK_PASSWORD;
  if (plain) return plain;
  const cmd = process.env.BRIDGELINK_PASSWORD_CMD?.trim();
  if (!cmd) {
    throw new Error(
      `No BridgeLink password. Set BRIDGELINK_PASSWORD, or BRIDGELINK_PASSWORD_CMD to a ` +
        `command that prints it, in .env.`,
    );
  }
  const r = spawnSync(cmd, { shell: true, encoding: "utf8" });
  const line = (r.stdout ?? "").split(/\r?\n/)[0]?.trim() ?? "";
  if (r.status !== 0 || line === "") {
    throw new Error(`BRIDGELINK_PASSWORD_CMD printed nothing (exit ${r.status}).`);
  }
  return line;
}

/** Log in. Every failure gets the sentence that names its fix. */
export async function connect(): Promise<Session> {
  const base = process.env.BRIDGELINK_URL?.trim().replace(/\/+$/, "");
  const user = process.env.BRIDGELINK_USER?.trim();
  if (!base || !user) {
    throw new Error(
      `Set BRIDGELINK_URL (https://host:8443, the server port, not the 8081 WebAdmin) ` +
        `and BRIDGELINK_USER in .env.`,
    );
  }
  const insecure = process.env.BRIDGELINK_TLS_INSECURE === "1";
  let res;
  try {
    res = await call(
      { base, insecure },
      "POST",
      "/users/_login",
      new URLSearchParams({ username: user, password: password() }).toString(),
      "application/x-www-form-urlencoded",
    );
  } catch (e) {
    const m = (e as Error).message;
    if (/certificate|self.signed|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(m)) {
      throw new Error(
        `${base} has a certificate this machine does not trust (${m}). Every Mirth ` +
          `install ships a self-signed one; set BRIDGELINK_TLS_INSECURE=1 if this is that.`,
      );
    }
    throw new Error(`could not reach ${base}: ${m}`);
  }
  if (res.status !== 200) {
    throw new Error(`login to ${base} as ${user} refused: HTTP ${res.status}`);
  }
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  if (!cookie) throw new Error(`login to ${base} returned no session cookie`);
  return { base, cookie, insecure };
}

/** A call that must succeed, or throw naming what was being attempted. */
async function must(s: Session, what: string, method: string, path: string, body?: string, ct?: string) {
  const r = await call(s, method, path, body, ct);
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`${what}: HTTP ${r.status}\n${r.text.slice(0, 2000)}`);
  }
  return r.text;
}

export async function serverVersion(s: Session): Promise<string> {
  return (await must(s, "server version", "GET", "/server/version")).trim();
}

/** Create the channel, or replace it when one with this id exists. */
export async function putChannel(s: Session, id: string, channelXml: string): Promise<void> {
  const existing = await call(s, "GET", `/channels/${id}`);
  if (existing.status === 200 && existing.text.trim() !== "") {
    await must(s, "update channel", "PUT", `/channels/${id}?override=true`, channelXml);
  } else {
    await must(s, "create channel", "POST", "/channels", channelXml);
  }
}

/** Deploy, and wait until the dashboard says STARTED. */
export async function deploy(s: Session, id: string, timeoutMs = 30000): Promise<void> {
  await must(s, "deploy channel", "POST", `/channels/${id}/_deploy?returnErrors=true`);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await call(s, "GET", `/channels/${id}/status`);
    const state = /<state>([^<]+)<\/state>/.exec(r.text)?.[1];
    if (state === "STARTED") return;
    await Bun.sleep(500);
  }
  throw new Error(`channel ${id} did not reach STARTED within ${timeoutMs / 1000}s`);
}

export async function undeploy(s: Session, id: string): Promise<void> {
  await call(s, "POST", `/channels/${id}/_undeploy`);
}

/** What the engine did with one message at the source connector. */
export interface Processed {
  /** RECEIVED, FILTERED, TRANSFORMED, ERROR ... */
  status: string;
  /** The transformer's output, serialized back to ER7. Empty when filtered. */
  encoded: string;
  /** The engine's own error text, when the step threw. */
  error: string;
}

function unxml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#xd;|&#13;/gi, "\r")
    .replace(/&#xa;|&#10;/gi, "\n")
    .replace(/&amp;/g, "&");
}

/**
 * The content of one type on the SOURCE connector (metaDataId 0).
 *
 * Read off the message XML with patterns rather than a parser: bun has no DOM,
 * and adding a dependency to read three fields is the wrong trade for a tool
 * whose whole install is "copy four files".
 */
function sourceContent(messageXml: string, type: string): string {
  const src = /<entry>\s*<int>0<\/int>\s*<connectorMessage>([\s\S]*?)<\/connectorMessage>\s*<\/entry>/.exec(
    messageXml,
  )?.[1];
  if (!src) return "";
  const re = new RegExp(
    `<contentType>${type}</contentType>\\s*<content>([\\s\\S]*?)</content>`,
  );
  return unxml(re.exec(src)?.[1] ?? "");
}

/** Send one raw message through the channel and read back what it became. */
export async function processMessage(s: Session, id: string, raw: string, timeoutMs = 15000): Promise<Processed> {
  const sent = await must(s, "send message", "POST", `/channels/${id}/messages`, raw, "text/plain");
  const mid = /<long>(\d+)<\/long>/.exec(sent)?.[1] ?? sent.trim();
  if (!/^\d+$/.test(mid)) throw new Error(`send message: no message id in reply: ${sent.slice(0, 200)}`);

  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await call(s, "GET", `/channels/${id}/messages/${mid}?includeContent=true`);
    if (r.status === 200 && /<processed>true<\/processed>/.test(r.text)) return processed(r.text);
    await Bun.sleep(300);
  }
  throw new Error(`message ${mid} on channel ${id} was not processed within ${timeoutMs / 1000}s`);
}

/** The source connector's outcome, off one message's XML. */
function processed(text: string): Processed {
  const src = /<entry>\s*<int>0<\/int>\s*<connectorMessage>([\s\S]*?)<\/connectorMessage>/.exec(text)?.[1] ?? "";
  const status = /<status>([^<]+)<\/status>/.exec(src)?.[1] ?? "UNKNOWN";
  return {
    status,
    encoded: sourceContent(text, "ENCODED"),
    error: sourceContent(text, "PROCESSING_ERROR") || (/<processingError>([\s\S]*?)<\/processingError>/.exec(src)?.[1] ?? ""),
  };
}

/**
 * The newest message on the channel, once processed: what an MLLP send turned
 * into, since a send over the wire returns an ACK and not a message id.
 */
export async function latestMessage(s: Session, id: string, timeoutMs = 10000): Promise<Processed | null> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await call(s, "GET", `/channels/${id}/messages?limit=1&includeContent=true`);
    if (r.status === 200 && /<processed>true<\/processed>/.test(r.text)) return processed(r.text);
    await Bun.sleep(300);
  }
  return null;
}

/** Clear the harness channel's stored messages, so the lab does not fill up. */
export async function clearMessages(s: Session, id: string): Promise<void> {
  await call(s, "DELETE", `/channels/${id}/messages/_removeAll?clearStatistics=true`);
}
