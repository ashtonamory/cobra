import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, connect, type Socket } from "node:net";

import { imapAppendSent, imapCheck, imapDate, imapLook, ImapRefusal, listedFolders, quoted, searchCriteria, sentFolder, uidSet, withImap, type ImapDeps } from "./imap.ts";

/** A fake IMAP server with two inbox messages and a Sent folder. */
async function fakeImap(opts: { password?: string } = {}) {
  const heard: string[] = [];
  const appended: string[] = [];
  const messages = new Map<number, string>([
    [7, "From: Ana <ana@x.example>\r\nSubject: Re: Hi\r\nIn-Reply-To: <m1@icloud.com>\r\n\r\nYes please\r\n"],
    [9, "From: MAILER-DAEMON@icloud.com\r\nSubject: Undelivered\r\n\r\nFinal-Recipient: rfc822; gone@x.example\r\n"],
  ]);
  const server = createServer((socket: Socket) => {
    // The client ends and destroys at once, so this end may see a reset: never an uncaught error.
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let waiting: { tag: string; size: number } | null = null;
    socket.write("* OK fake IMAP ready\r\n");
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (waiting) {
          if (buffer.length < waiting.size + 2) return;
          appended.push(buffer.subarray(0, waiting.size).toString("utf8"));
          buffer = buffer.subarray(waiting.size + 2);
          socket.write(`${waiting.tag} OK APPEND done\r\n`);
          waiting = null;
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 2);
        heard.push(line);
        const [tag, command, ...rest] = line.split(" ");
        const args = rest.join(" ");
        switch (command) {
          case "LOGIN":
            socket.write(args.endsWith(quoted(opts.password ?? "pw")) ? `${tag} OK logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
            break;
          case "EXAMINE":
            socket.write(`* 2 EXISTS\r\n* OK [UIDVALIDITY 4242] ok\r\n${tag} OK [READ-ONLY] done\r\n`);
            break;
          case "UID":
            if (rest[0] === "SEARCH") socket.write(`* SEARCH 9 7\r\n${tag} OK done\r\n`);
            else {
              for (const uid of rest[1]!.split(",").map(Number)) {
                const raw = Buffer.from(messages.get(uid)!, "utf8");
                socket.write(`* ${uid - 6} FETCH (UID ${uid} BODY[]<0> {${raw.length}}\r\n`);
                socket.write(raw);
                socket.write(")\r\n");
              }
              socket.write(`${tag} OK done\r\n`);
            }
            break;
          case "LIST":
            socket.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren \\Sent) "/" "Sent Messages"\r\n${tag} OK done\r\n`);
            break;
          case "APPEND": {
            const size = Number(/\{(\d+)\}$/.exec(line)![1]);
            waiting = { tag: tag!, size };
            socket.write("+ go\r\n");
            break;
          }
          case "LOGOUT":
            socket.write(`* BYE\r\n${tag} OK bye\r\n`);
            break;
          default:
            socket.write(`${tag} BAD what\r\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const deps: ImapDeps = { open: (host, p) => new Promise((resolve) => { const s = connect(p, host, () => resolve(s)); }), upgrade: async (s) => s, timeoutMs: 2000 };
  return { server: { host: "127.0.0.1", port, security: "none" as const }, heard, appended, deps, close: () => server.close() };
}

test("search words: dates, FROM alternatives, quoting", () => {
  assert.equal(imapDate(new Date("2026-11-02T23:00:00Z")), "2-Nov-2026");
  assert.equal(searchCriteria({ since: new Date("2026-10-30T00:00:00Z"), from: ["mailer-daemon", "postmaster"], max: 5 }), 'SINCE 30-Oct-2026 OR FROM "mailer-daemon" FROM "postmaster"');
  assert.equal(searchCriteria({ since: new Date("2026-10-30T00:00:00Z"), notFrom: "me@icloud.com", max: 5 }), 'SINCE 30-Oct-2026 NOT FROM "me@icloud.com"');
  assert.equal(quoted('a"b\\c'), '"a\\"b\\\\c"');
  assert.throws(() => quoted("a\r\nJ9 DELETE"), ImapRefusal);
  assert.equal(sentFolder([{ text: '* LIST () "/" "Sent"', literals: [] }], ["Sent Messages", "Sent"]), "Sent");
  assert.equal(sentFolder([], ["Sent Messages"]), "Sent Messages");
});

test("a look reads the newest messages without marking them, and a sent copy goes to the folder marked \\Sent", async () => {
  const fake = await fakeImap();
  try {
    const login = { user: "me@icloud.com", password: "pw" };
    const got = await imapLook(fake.server, login, { since: new Date("2026-10-30T00:00:00Z"), max: 25 }, fake.deps);
    assert.equal(got.validity, "4242");
    assert.deepEqual(got.messages.map((m) => m.uid).sort(), [7, 9]);
    assert.match(got.messages.find((m) => m.uid === 7)!.raw, /Yes please/);
    assert.ok(fake.heard.some((l) => /UID FETCH 7,9 \(UID BODY\.PEEK\[\]<0\.65536>\)/.test(l)), "BODY.PEEK: nothing is marked read");
    assert.ok(fake.heard.some((l) => l.includes('EXAMINE "INBOX"')), "read-only select");
    const folder = await imapAppendSent(fake.server, login, "Subject: x\r\n\r\nhello\r\n", ["Sent"], fake.deps);
    assert.equal(folder, "Sent Messages");
    assert.deepEqual(fake.appended, ["Subject: x\r\n\r\nhello\r\n"]);
  } finally {
    fake.close();
  }
});

test("a wrong password is refused without the password in the words", async () => {
  const fake = await fakeImap({ password: "right" });
  try {
    await assert.rejects(imapCheck(fake.server, { user: "me", password: "wrong-secret" }, fake.deps), (caught: unknown) => {
      assert.ok(caught instanceof ImapRefusal);
      assert.match(caught.message, /AUTHENTICATIONFAILED/);
      assert.doesNotMatch(caught.message, /wrong-secret/);
      return true;
    });
  } finally {
    fake.close();
  }
});

/** A scripted IMAP server: `answer` gives the untagged lines (and raw bytes) for each command after LOGIN; every line heard is kept. */
async function scripted(caps: string, answer: (command: string, args: string) => Array<string | Buffer>) {
  const heard: string[] = [];
  const server = createServer((socket: Socket) => {
    socket.on("error", () => {});
    let buffer = "";
    socket.write("* OK ready\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let end = buffer.indexOf("\r\n"); end >= 0; end = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        heard.push(line);
        const [tag, command, ...rest] = line.split(" ");
        if (command === "LOGIN") socket.write(`${tag} OK in\r\n`);
        else if (command === "LOGOUT") socket.write(`* BYE\r\n${tag} OK bye\r\n`);
        else if (command === "CAPABILITY") socket.write(`* CAPABILITY ${caps}\r\n${tag} OK done\r\n`);
        else {
          for (const piece of answer(command!, rest.join(" "))) socket.write(piece);
          socket.write(`${tag} OK done\r\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const deps: ImapDeps = { open: (host, p) => new Promise((resolve) => { const s = connect(p, host, () => resolve(s)); }), upgrade: async (s) => s, timeoutMs: 2000 };
  return { server: { host: "127.0.0.1", port, security: "none" as const }, heard, deps, close: () => server.close() };
}

test("a session lists folders (a name sent as a literal too), fetches flags, size, structure and a peek, and never marks read", async () => {
  const raw = Buffer.from("From: a@x.example\r\nSubject: Hi\r\n\r\nHello\r\n", "utf8");
  const fake = await scripted("IMAP4rev1 MOVE UIDPLUS", (command, args) => {
    if (command === "LIST") return ['* LIST (\\HasNoChildren) "/" "INBOX"\r\n', '* LIST (\\HasNoChildren \\Trash) "/" "Trash"\r\n', '* LIST (\\HasNoChildren) "/" {9}\r\n', "Caf\u00e9 Box\r\n"];
    if (command === "EXAMINE" || command === "SELECT") return ["* 3 EXISTS\r\n", "* OK [UIDVALIDITY 777] ok\r\n"];
    if (command === "UID" && args.startsWith("FETCH")) {
      return [`* 1 FETCH (UID 5 FLAGS (\\Seen \\Flagged) RFC822.SIZE ${raw.length} BODYSTRUCTURE (("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 5 1 NIL NIL NIL)("APPLICATION" "PDF" ("NAME" {7}\r\n`, "q 1.pdf", `) NIL NIL "BASE64" 4000 NIL ("ATTACHMENT" ("FILENAME" "q 1.pdf")) NIL) "MIXED") BODY[]<0> {${raw.length}}\r\n`, raw, ")\r\n"];
    }
    if (command === "UID" && args.startsWith("SEARCH")) return ["* SEARCH 5 3\r\n"];
    return [];
  });
  try {
    await withImap(fake.server, { user: "u", password: "pw" }, async (box) => {
      assert.ok(box.capabilities.has("MOVE"));
      const folders = await box.folders();
      assert.deepEqual(folders.map((f) => f.name), ["INBOX", "Trash", "Caf\u00e9 Box"]);
      assert.equal(folders[1]!.flags, "\\hasnochildren \\trash");
      assert.deepEqual(await box.open("INBOX", false), { validity: "777" });
      assert.deepEqual(await box.search("ALL"), [3, 5]);
      const [got] = await box.fetch([5], 4096);
      assert.equal(got!.uid, 5);
      assert.deepEqual(got!.flags, ["\\seen", "\\flagged"]);
      assert.equal(got!.raw, raw.toString("utf8"));
      assert.match(got!.structure, /"q 1\.pdf"/);
    }, fake.deps);
    assert.ok(fake.heard.some((l) => / UID FETCH 5 \(UID FLAGS RFC822\.SIZE BODYSTRUCTURE BODY\.PEEK\[\]<0\.4096>\)$/.test(l)));
    assert.ok(fake.heard.some((l) => l.endsWith('EXAMINE "INBOX"')));
  } finally {
    fake.close();
  }
});

test("a move is UID MOVE when the server has it, else COPY then UID EXPUNGE of exactly those UIDs, and never a bare EXPUNGE", async () => {
  for (const [caps, expect] of [
    ["IMAP4rev1 MOVE", ['UID MOVE 3,5 "Trash"']],
    ["IMAP4rev1 UIDPLUS", ['UID COPY 3,5 "Trash"', "UID STORE 3,5 +FLAGS.SILENT (\\Deleted)", "UID EXPUNGE 3,5"]],
  ] as const) {
    const fake = await scripted(caps, (command) => (command === "SELECT" ? ["* OK [UIDVALIDITY 1] ok\r\n"] : []));
    try {
      await withImap(fake.server, { user: "u", password: "pw" }, async (box) => {
        await box.open("INBOX", true);
        await box.move([5, 3], "Trash");
        await box.store([3], "+", ["\\Seen"]);
      }, fake.deps);
      const said = fake.heard.map((l) => l.replace(/^J\d+ /, ""));
      for (const line of expect) assert.ok(said.includes(line), `${caps}: ${line}`);
      assert.ok(said.includes("UID STORE 3 +FLAGS.SILENT (\\Seen)"));
      assert.ok(!said.includes("EXPUNGE"));
    } finally {
      fake.close();
    }
  }
  const bare = await scripted("IMAP4rev1", (command) => (command === "SELECT" ? ["* OK [UIDVALIDITY 1] ok\r\n"] : []));
  try {
    await assert.rejects(withImap(bare.server, { user: "u", password: "pw" }, async (box) => box.move([1], "Trash"), bare.deps), /cannot move messages safely/);
    assert.ok(!bare.heard.some((l) => /EXPUNGE|COPY/.test(l)));
  } finally {
    bare.close();
  }
  assert.throws(() => uidSet([]), ImapRefusal);
  assert.throws(() => uidSet([1, 0]), ImapRefusal);
  assert.deepEqual(listedFolders([{ text: '* LIST (\\Noselect) "/" "[Gmail]"', literals: [] }]), [{ name: "[Gmail]", flags: "\\noselect" }]);
});
