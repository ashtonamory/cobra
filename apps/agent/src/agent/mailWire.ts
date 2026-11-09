import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

/**
 * A mail server connection read line by line, or by a byte count (an IMAP
 * literal), for the SMTP and IMAP clients (smtp.ts, imap.ts). Every read has
 * a time limit; a closed or silent connection rejects with WireClosed, so a
 * caller can tell "cut off" from "said no".
 */

export class WireClosed extends Error {}

/** "tls" from the first byte (465, 993); "starttls" upgrades after the greeting (587); "none" is for tests only, never a mailbox. */
export type Security = "tls" | "starttls" | "none";

export type WireOpen = (host: string, port: number, security: Security) => Promise<Socket | TLSSocket>;
export type WireUpgrade = (socket: Socket | TLSSocket, host: string) => Promise<Socket | TLSSocket>;

export const OPEN_TIMEOUT_MS = 20_000;

export const liveOpen: WireOpen = (host, port, security) =>
  new Promise((resolve, reject) => {
    const socket = security === "tls" ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
    const fail = (caught: Error) => reject(new WireClosed(`${host}:${port} could not be reached: ${caught.message}`));
    socket.setTimeout(OPEN_TIMEOUT_MS, () => (socket.destroy(), fail(new Error("no answer"))));
    socket.once("error", fail);
    socket.once(security === "tls" ? "secureConnect" : "connect", () => {
      socket.setTimeout(0);
      socket.off("error", fail);
      resolve(socket);
    });
  });

export const liveUpgrade: WireUpgrade = (socket, host) =>
  new Promise((resolve, reject) => {
    const secure = tlsConnect({ socket, servername: host });
    const fail = (caught: Error) => reject(new WireClosed(`TLS with ${host} failed: ${caught.message}`));
    secure.once("error", fail);
    secure.once("secureConnect", () => {
      secure.off("error", fail);
      resolve(secure);
    });
  });

export class Wire {
  private socket: Socket | TLSSocket;
  private buffer = Buffer.alloc(0);
  private closed: string | null = null;
  private wake: (() => void) | null = null;
  private readonly onData = (chunk: Buffer) => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.poke();
  };
  private readonly onEnd = () => {
    this.closed ??= "the server closed the connection";
    this.poke();
  };
  private readonly onError = (caught: Error) => {
    this.closed ??= caught.message;
    this.poke();
  };

  private readonly timeoutMs: number;

  constructor(socket: Socket | TLSSocket, timeoutMs = 60_000) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.listen();
  }

  private listen(): void {
    this.socket.on("data", this.onData);
    this.socket.on("end", this.onEnd);
    this.socket.on("close", this.onEnd);
    this.socket.on("error", this.onError);
  }

  private unlisten(): void {
    this.socket.off("data", this.onData);
    this.socket.off("end", this.onEnd);
    this.socket.off("close", this.onEnd);
    this.socket.off("error", this.onError);
  }

  private poke(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private async more(): Promise<void> {
    if (this.closed !== null) throw new WireClosed(this.closed);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.wake = null;
        reject(new WireClosed("the server stopped answering"));
      }, this.timeoutMs);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  /** One line without its CRLF. */
  async line(): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf("\r\n");
      if (end >= 0) {
        const text = this.buffer.subarray(0, end).toString("utf8");
        this.buffer = this.buffer.subarray(end + 2);
        return text;
      }
      if (this.buffer.length > 1_000_000) throw new WireClosed("a line from the server was too long");
      await this.more();
    }
  }

  /** Exactly `count` bytes. */
  async bytes(count: number): Promise<Buffer> {
    while (this.buffer.length < count) await this.more();
    const out = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    return Buffer.from(out);
  }

  write(text: string | Buffer): void {
    if (this.closed !== null) throw new WireClosed(this.closed);
    this.socket.write(text);
  }

  /** STARTTLS: the same connection, now encrypted. Anything the server sent early is dropped, as RFC 3207 asks. */
  async upgrade(upgrade: WireUpgrade, host: string): Promise<void> {
    this.unlisten();
    this.buffer = Buffer.alloc(0);
    this.socket = await upgrade(this.socket, host);
    this.listen();
  }

  close(): void {
    this.unlisten();
    this.socket.on("error", () => {});
    this.socket.end();
    this.socket.destroy();
  }
}
