import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect, type Socket } from "node:net";

import { smtpCheck, smtpData, smtpSend, SmtpCutOff, SmtpRefusal, type SmtpDeps } from "./smtp.ts";

/** A fake submission server: answers each command from `script`, keeps what it heard. */
async function fakeServer(script: (line: string, heard: string[]) => string | null | "drop", opts: { startTls?: boolean } = {}) {
  const heard: string[] = [];
  const server = createServer((socket: Socket) => {
    // The client ends and destroys at once, so this end may see a reset: never an uncaught error.
    socket.on("error", () => {});
    let data = false;
    let buffer = "";
    socket.write("220 fake ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (data) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          heard.push(`DATA:${buffer.slice(0, end)}`);
          buffer = buffer.slice(end + 5);
          data = false;
          const said = script("<data>", heard);
          if (said === "drop") return void socket.destroy();
          if (said) socket.write(said);
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        heard.push(line);
        if (/^EHLO/.test(line)) {
          socket.write(`250-fake\r\n${opts.startTls ? "250-STARTTLS\r\n" : ""}250 AUTH PLAIN LOGIN\r\n`);
          continue;
        }
        if (line === "STARTTLS") {
          socket.write("220 go ahead\r\n");
          continue;
        }
        if (line === "DATA") {
          data = true;
          socket.write("354 go\r\n");
          continue;
        }
        const said = script(line, heard);
        if (said === "drop") return void socket.destroy();
        if (said) socket.write(said);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const deps: SmtpDeps = {
    open: (host, p) => new Promise((resolve) => { const s = connect(p, host, () => resolve(s)); }),
    upgrade: async (socket) => socket,
    timeoutMs: 2000,
  };
  return { heard, port, deps, close: () => server.close() };
}

const OK = (line: string): string | null => {
  if (line.startsWith("AUTH PLAIN")) return "235 ok\r\n";
  if (line.startsWith("MAIL FROM")) return "250 ok\r\n";
  if (line.startsWith("RCPT TO")) return "250 ok\r\n";
  if (line === "<data>") return "250 2.0.0 Ok: queued as ABC123\r\n";
  if (line === "QUIT") return "221 bye\r\n";
  return "500 what\r\n";
};

test("dot-stuffing and the end mark", () => {
  assert.equal(smtpData("a\r\n.b\r\n"), "a\r\n..b\r\n.\r\n");
  assert.equal(smtpData(".x"), "..x\r\n.\r\n");
});

test("a message goes: login over STARTTLS, sender, each recipient, the data", async () => {
  const fake = await fakeServer(OK, { startTls: true });
  try {
    const got = await smtpSend({ host: "127.0.0.1", port: fake.port, security: "starttls" }, { user: "me@icloud.com", password: "abcd-efgh" }, { from: "me@icloud.com", recipients: ["a@x.example", "b@x.example"], data: "Subject: hi\r\n\r\n.dot line\r\n" }, fake.deps);
    assert.match(got.accepted, /queued as ABC123/);
    assert.equal(fake.heard.filter((l) => l.startsWith("EHLO")).length, 2, "EHLO again after STARTTLS");
    assert.ok(fake.heard.includes(`AUTH PLAIN ${Buffer.from("\0me@icloud.com\0abcd-efgh").toString("base64")}`));
    assert.deepEqual(fake.heard.filter((l) => l.startsWith("RCPT")), ["RCPT TO:<a@x.example>", "RCPT TO:<b@x.example>"]);
    assert.ok(fake.heard.includes("DATA:Subject: hi\r\n\r\n..dot line"));
  } finally {
    fake.close();
  }
});

test("a wrong password is a refusal without the password in it; a cut after the data may have gone", async () => {
  const wrong = await fakeServer((line) => (line.startsWith("AUTH") ? "535 5.7.8 Authentication failed\r\n" : OK(line)));
  try {
    await assert.rejects(smtpCheck({ host: "127.0.0.1", port: wrong.port, security: "none" }, { user: "me", password: "secret-pass" }, wrong.deps), (caught: unknown) => {
      assert.ok(caught instanceof SmtpRefusal);
      assert.equal(caught.code, 535);
      assert.doesNotMatch(caught.message, /secret-pass/);
      return true;
    });
  } finally {
    wrong.close();
  }
  const noTls = await fakeServer(OK);
  try {
    await assert.rejects(smtpCheck({ host: "127.0.0.1", port: noTls.port, security: "starttls" }, { user: "me", password: "p" }, noTls.deps), /STARTTLS/);
    assert.ok(!noTls.heard.some((l) => l.startsWith("AUTH")), "never logs in unencrypted");
  } finally {
    noTls.close();
  }
  const cut = await fakeServer((line) => (line === "<data>" ? "drop" : OK(line)));
  try {
    await assert.rejects(smtpSend({ host: "127.0.0.1", port: cut.port, security: "none" }, { user: "me", password: "p" }, { from: "me@x", recipients: ["a@x.example"], data: "x\r\n" }, cut.deps), (caught: unknown) => caught instanceof SmtpCutOff && caught.sent);
  } finally {
    cut.close();
  }
  const busy = await fakeServer((line) => (line.startsWith("RCPT") ? "451 4.7.1 try later\r\n" : OK(line)));
  try {
    await assert.rejects(smtpSend({ host: "127.0.0.1", port: busy.port, security: "none" }, { user: "me", password: "p" }, { from: "me@x", recipients: ["a@x.example"], data: "x\r\n" }, busy.deps), (caught: unknown) => caught instanceof SmtpRefusal && caught.code === 451);
  } finally {
    busy.close();
  }
});
