/**
 * mllp.ts -- the minimum MLLP for bridgelink-check.ts --mllp: send one framed
 * message and read the ACK, and receive framed messages and ACK them.
 *
 * MLLP is <VT> message <FS><CR>: 0x0B, the bytes, 0x1C 0x0D. Nothing else, and
 * nothing here is more than that. It exists so the harness can prove the
 * channel's real connectors -- the listener a sender connects to, the sender
 * that reaches the receiver -- and not only the REST path into the channel.
 */

const START = "\x0b";
const END = "\x1c\x0d";

export function frame(raw: string): string {
  return START + raw + END;
}

/** Every complete frame in a buffer, and what is left over. */
export function unframe(buf: string): { messages: string[]; rest: string } {
  const messages: string[] = [];
  let rest = buf;
  for (;;) {
    const s = rest.indexOf(START);
    const e = rest.indexOf(END, s + 1);
    if (s === -1 || e === -1) break;
    messages.push(rest.slice(s + 1, e));
    rest = rest.slice(e + END.length);
  }
  return { messages, rest };
}

/** A plain ACK for a received message: MSA|AA with its control id. */
export function ack(received: string): string {
  const msh = received.split(/\r\n|\r|\n/)[0] ?? "";
  const ctl = msh.startsWith("MSH") ? (msh.split("|")[9] ?? "") : "";
  return `MSH|^~\\&|BENCH|BENCH|||${stamp()}||ACK|${ctl}|P|2.5\rMSA|AA|${ctl}\r`;
}

function stamp(): string {
  return new Date().toISOString().replace(/\D/g, "").slice(0, 14);
}

/** Send one message and wait for the reply frame, or "" on timeout. */
export async function send(host: string, port: number, raw: string, timeoutMs = 10000): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let buf = "";
    let done = false;
    const finish = (v: string, sock?: { end(): void }) => {
      if (done) return;
      done = true;
      sock?.end();
      resolve(v);
    };
    const timer = setTimeout(() => finish(""), timeoutMs);
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(sock) {
          sock.write(frame(raw));
        },
        data(sock, chunk) {
          buf += chunk.toString("latin1");
          const { messages } = unframe(buf);
          if (messages.length > 0) {
            clearTimeout(timer);
            finish(messages[0], sock);
          }
        },
        close() {
          clearTimeout(timer);
          finish(buf);
        },
        error(_sock, e) {
          clearTimeout(timer);
          if (!done) {
            done = true;
            reject(e);
          }
        },
      },
    }).catch((e) => {
      clearTimeout(timer);
      if (!done) {
        done = true;
        reject(new Error(`MLLP connect to ${host}:${port} failed: ${(e as Error).message}`));
      }
    });
  });
}

/** A receiver that ACKs every frame and queues it for `next`. */
export function receiver(port: number) {
  const queue: string[] = [];
  const waiting: ((m: string | null) => void)[] = [];
  const server = Bun.listen<{ buf: string }>({
    hostname: "0.0.0.0",
    port,
    socket: {
      open(sock) {
        sock.data = { buf: "" };
      },
      data(sock, chunk) {
        sock.data.buf += chunk.toString("latin1");
        const { messages, rest } = unframe(sock.data.buf);
        sock.data.buf = rest;
        for (const m of messages) {
          sock.write(frame(ack(m)));
          const w = waiting.shift();
          if (w) w(m);
          else queue.push(m);
        }
      },
    },
  });
  return {
    /** The next delivered message, or null if none arrives in time. */
    next(timeoutMs: number): Promise<string | null> {
      const q = queue.shift();
      if (q !== undefined) return Promise.resolve(q);
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          const i = waiting.indexOf(done);
          if (i >= 0) waiting.splice(i, 1);
          resolve(null);
        }, timeoutMs);
        const done = (m: string | null) => {
          clearTimeout(t);
          resolve(m);
        };
        waiting.push(done);
      });
    },
    /** Anything delivered that nobody asked for: a duplicate is a failure too. */
    drain(): string[] {
      return queue.splice(0, queue.length);
    },
    close() {
      server.stop(true);
    },
  };
}
