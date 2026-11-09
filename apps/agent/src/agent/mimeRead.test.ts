import { test } from "node:test";
import assert from "node:assert/strict";

import { buildMime } from "./mime.ts";
import { attachmentsOf, decodeWords, htmlWords, readBody, readMessage } from "./mimeRead.ts";

test("headers: encoded words, folding, ids and references", () => {
  assert.equal(decodeWords("=?utf-8?Q?Caf=C3=A9_au_lait?="), "Café au lait");
  assert.equal(decodeWords("=?UTF-8?B?w6l0w6k=?= =?UTF-8?B?IDIwMjY=?="), "été 2026");
  assert.equal(decodeWords("=?iso-8859-1?Q?Gr=FC=DFe?="), "Grüße");
  const raw = "From: =?utf-8?Q?Ana_S=C3=ADlva?= <ana@x.example>\r\nSubject: Re: Coffee\r\nMessage-ID: <r1@x.example>\r\nIn-Reply-To: <m1@studio.example>\r\nReferences: <m0@studio.example>\r\n <m1@studio.example>\r\n\r\nYes!\r\n";
  const got = readMessage(raw);
  assert.equal(got.from, "Ana Sílva <ana@x.example>");
  assert.equal(got.messageId, "r1@x.example");
  assert.deepEqual(got.refs, ["m1@studio.example", "m0@studio.example"]);
  assert.equal(got.text, "Yes!");
});

test("the text of a message the agent's own MIME writer made: plain, not the HTML", () => {
  const built = buildMime("me@icloud.com", { to: ["a@x.example"], subject: "Hi", text: "Hello Ana,\nCafé on Friday?", html: "<p>Hello <b>Ana</b></p>" }, Date.parse("2026-11-02T10:00:00Z"), "m1@icloud.com");
  const got = readMessage(built.data);
  assert.equal(got.text, "Hello Ana,\nCafé on Friday?");
  assert.equal(got.messageId, "m1@icloud.com");
});

test("HTML only, base64, and a bounce report with the returned headers", () => {
  const html = "Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + Buffer.from("<html><style>p{}</style><p>Thanks &amp; see you</p><p>Ana</p></html>").toString("base64") + "\r\n";
  assert.equal(readMessage(`Subject: x\r\n${html}`).text, "Thanks & see you\nAna");
  assert.equal(htmlWords("a<br>b&#233;"), "a\nbé");
  const bounce = [
    "From: Mail Delivery System <MAILER-DAEMON@icloud.com>",
    "Subject: Undelivered Mail Returned to Sender",
    'Content-Type: multipart/report; report-type=delivery-status; boundary="B1"',
    "",
    "--B1",
    "Content-Type: text/plain",
    "",
    "I'm sorry to have to inform you that your message could not be delivered.",
    "--B1",
    "Content-Type: message/delivery-status",
    "",
    "Final-Recipient: rfc822; gone@x.example",
    "Status: 5.1.1",
    "--B1",
    "Content-Type: message/rfc822",
    "",
    "To: gone@x.example",
    "Subject: Hi",
    "",
    "body not wanted",
    "--B1--",
    "",
  ].join("\r\n");
  const got = readMessage(bounce);
  assert.match(got.text, /could not be delivered/);
  assert.match(got.text, /Final-Recipient: rfc822; gone@x.example/);
  assert.match(got.text, /To: gone@x.example/);
  assert.doesNotMatch(got.text, /body not wanted/);
});

test("BODYSTRUCTURE gives the files by name, type and size (base64 counted back), never a text part, and survives nesting", () => {
  const structure = '(("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 12 1 NIL NIL NIL)(("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 40 2 NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "b2") NIL NIL)("APPLICATION" "PDF" ("NAME" "quote.pdf") NIL NIL "BASE64" 4000 NIL ("ATTACHMENT" ("FILENAME" "=?utf-8?Q?Caf=C3=A9_menu.pdf?=")) NIL)("IMAGE" "PNG" NIL NIL NIL "BASE64" 800 NIL ("ATTACHMENT" NIL) NIL) "MIXED" ("BOUNDARY" "b1") NIL NIL)';
  assert.deepEqual(attachmentsOf(structure), [
    { name: "Café menu.pdf", bytes: 3000, type: "application/pdf" },
    { name: "(no name)", bytes: 600, type: "image/png" },
  ]);
  assert.deepEqual(attachmentsOf('("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 12 1 NIL NIL NIL)'), []);
  assert.deepEqual(attachmentsOf(""), []);
});

test("readBody keeps the plain part, else the HTML itself for the reader to turn into words", () => {
  assert.deepEqual(readBody("Content-Type: text/plain\r\n\r\nHi there\r\n"), { text: "Hi there", from: "plain" });
  const html = readBody("Content-Type: text/html\r\n\r\n<p>Hi <b>there</b></p>\r\n");
  assert.equal(html.from, "html");
  assert.match(html.text, /<b>there<\/b>/);
  assert.deepEqual(readBody("Content-Type: image/png\r\n\r\nxxxx"), { text: "", from: "none" });
});
