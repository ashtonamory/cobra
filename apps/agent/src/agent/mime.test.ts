import { test } from "node:test";
import assert from "node:assert/strict";

import { base64Lines, buildMime, encodeHeaderWord, listHeader, MimeError, quotedPrintable, typeForName, validEmail } from "./mime.ts";

const FROM = "penny@example.com";

test("validEmail takes ordinary addresses and refuses the rest", () => {
  for (const ok of ["a@b.co", "first.last+tag@sub.example.org", "x_y-z@example-mail.com"]) assert.equal(validEmail(ok), true, ok);
  for (const bad of ["", "nobody", "@example.com", "a@", "a@localhost", "a b@example.com", "a@-bad.com", "a@bad-.com", "a..b@example.com", "\"quoted\"@example.com", `${"x".repeat(65)}@example.com`]) {
    assert.equal(validEmail(bad), false, bad);
  }
});

test("buildMime: headers, a 7bit body, two recipients and a Cc", () => {
  const built = buildMime(FROM, { to: ["a@example.com", "b@example.com"], cc: ["c@example.com"], subject: "Pay stubs for Friday", text: "Hi,\nattached.\n" }, Date.UTC(2026, 9, 22, 9, 0, 0), "abc123@example.com");
  assert.deepEqual(built.recipients, ["a@example.com", "b@example.com", "c@example.com"]);
  assert.equal(built.from, "penny@example.com");
  const [headers, body] = built.data.split("\r\n\r\n");
  const lines = headers!.split("\r\n");
  assert.equal(lines[0], "Date: Thu, 22 Oct 2026 09:00:00 +0000");
  assert.ok(lines.includes("From: penny@example.com"));
  assert.ok(lines.includes("To: a@example.com, b@example.com"));
  assert.ok(lines.includes("Cc: c@example.com"));
  assert.ok(lines.includes("Subject: Pay stubs for Friday"));
  assert.ok(lines.includes("Message-ID: <abc123@example.com>"));
  assert.ok(lines.includes("MIME-Version: 1.0"));
  assert.ok(lines.includes("Content-Type: text/plain; charset=utf-8"));
  assert.ok(lines.includes("Content-Transfer-Encoding: 7bit"));
  assert.equal(body, "Hi,\r\nattached.\r\n", "newlines become CRLF, the body ends in one");
  assert.ok(!built.data.includes("\n\n"), "every line ends in CRLF");
});

test("buildMime: a non-ASCII subject is RFC 2047 and a non-ASCII body goes base64", () => {
  const built = buildMime(FROM, { to: ["a@example.com"], subject: "Lohnabrechnung für März", text: "Grüße\n" }, 0, "id@example.com");
  assert.ok(built.data.includes(`Subject: ${encodeHeaderWord("Lohnabrechnung für März")}`));
  assert.ok(encodeHeaderWord("Lohnabrechnung für März").startsWith("=?utf-8?B?"));
  assert.equal(Buffer.from(encodeHeaderWord("für").slice(10, -2), "base64").toString("utf8"), "für");
  assert.equal(encodeHeaderWord("plain ascii"), "plain ascii");
  const long = encodeHeaderWord("é".repeat(80));
  for (const line of long.split("\r\n")) assert.ok(line.length <= 76, `${line.length} columns`);
  assert.ok(built.data.includes("Content-Transfer-Encoding: base64"));
  assert.equal(Buffer.from(built.data.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString("utf8"), "Grüße\r\n");
});

test("buildMime: attachments make a multipart/mixed message with base64 parts at 76 columns", () => {
  const data = new Uint8Array(200).map((_, index) => index % 251);
  const built = buildMime(
    FROM,
    { to: ["a@example.com"], subject: "Stubs", text: "See attached.", attachments: [{ name: 'stub "1".pdf', data, type: "application/pdf" }, { name: "notes.txt", data: Buffer.from("hello") }] },
    0,
    "id@example.com",
    "BOUNDARY",
  );
  assert.ok(built.data.includes('Content-Type: multipart/mixed; boundary="BOUNDARY"\r\n'));
  const parts = built.data.split("--BOUNDARY");
  assert.equal(parts.length, 5, "a preamble, three parts and the closing mark");
  assert.ok(parts[1]!.includes("Content-Type: text/plain; charset=utf-8"));
  assert.ok(parts[1]!.includes("See attached.\r\n"));
  assert.ok(parts[2]!.includes('Content-Type: application/pdf; name="stub _1_.pdf"'), "quotes in a name are replaced");
  assert.ok(parts[2]!.includes('Content-Disposition: attachment; filename="stub _1_.pdf"'));
  assert.ok(parts[2]!.includes("Content-Transfer-Encoding: base64"));
  const encoded = parts[2]!.split("\r\n\r\n")[1]!;
  for (const line of encoded.split("\r\n")) assert.ok(line.length <= 76);
  assert.deepEqual(new Uint8Array(Buffer.from(encoded.replace(/\r\n/g, ""), "base64")), data);
  assert.ok(parts[3]!.includes('Content-Type: application/octet-stream; name="notes.txt"'), "no type given");
  assert.equal(parts[4], "--\r\n");
  assert.equal(base64Lines(Buffer.from("hello")), "aGVsbG8=\r\n");
});

test("buildMime: twenty long recipients fold at commas, so no header line nears 998 bytes and every address stays", () => {
  const many = Array.from({ length: 20 }, (_, i) => `person${i}.surname${i}@subsidiary.example-company.co.uk`);
  const built = buildMime(FROM, { to: many, cc: many.slice(0, 3), subject: "Stubs", text: "hi" }, Date.UTC(2026, 9, 22), "fold@example.com");
  const [headers] = built.data.split("\r\n\r\n");
  for (const line of headers!.split("\r\n")) assert.ok(line.length <= 78, `${line.length}: ${line}`);
  const unfolded = headers!.replace(/\r\n[ \t]/g, " ");
  const to = unfolded.split("\r\n").find((line) => line.startsWith("To: "))!;
  assert.equal(to, `To: ${many.join(", ")}`);
  assert.deepEqual(built.recipients.length, 23);
  assert.equal(listHeader("To", ["a@example.com", "b@example.com"]), "To: a@example.com, b@example.com");
});

test("typeForName: known extensions by name, case aside; the rest are octet-stream", () => {
  assert.equal(typeForName("stub-ana.PDF"), "application/pdf");
  assert.equal(typeForName("hours.csv"), "text/csv");
  assert.equal(typeForName("book.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(typeForName("archive.tar.zst"), "application/octet-stream");
  assert.equal(typeForName(".pdf"), "application/octet-stream", "a dot-file has no extension");
  assert.equal(typeForName("README"), "application/octet-stream");
});

test("quotedPrintable keeps lines at 76 and escapes = and non-ASCII", () => {
  const out = quotedPrintable(`<a href="x">${"y".repeat(200)}</a> café =`);
  for (const line of out.split("\r\n")) assert.ok(line.length <= 76, line);
  assert.ok(out.includes("=3D"));
  assert.ok(out.replace(/=\r\n/g, "").includes("caf=C3=A9"));
  const decoded = Buffer.from(
    out
      .replace(/=\r\n/g, "")
      .replace(/\r\n$/, "")
      .replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16))),
    "latin1",
  ).toString("utf8");
  assert.equal(decoded, `<a href="x">${"y".repeat(200)}</a> café =`);
  assert.ok(quotedPrintable("ends in space ").includes("=20"));
});

test("an HTML message is text and HTML as alternatives, images as related parts", () => {
  const { data } = buildMime(FROM, {
    to: ["a@example.com"],
    subject: "Hi",
    text: "Plain words",
    html: "<p>Rich words <img src=\"cid:logo@cobra\"></p>",
    inline: [{ cid: "logo@cobra", name: "logo.png", data: Uint8Array.from([1, 2, 3]), type: "image/png" }],
    headers: [{ name: "List-Unsubscribe", value: "<https://example.com/u/x>" }, { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" }],
    fromName: "Example.com",
  }, 0, "id1@example.com", "B");
  assert.match(data, /^From: "Example.com" <penny@example.com>\r\n/m);
  assert.match(data, /^List-Unsubscribe: <https:\/\/example.com\/u\/x>\r\n/m);
  assert.match(data, /Content-Type: multipart\/alternative; boundary="B_a"/);
  assert.match(data, /--B_a\r\nContent-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nPlain words\r\n--B_a\r\nContent-Type: multipart\/related; boundary="B_r"; type="text\/html"/);
  assert.match(data, /Content-ID: <logo@cobra>\r\nContent-Disposition: inline; filename="logo.png"\r\n\r\nAQID\r\n--B_r--\r\n--B_a--\r\n$/);
  for (const line of data.split("\r\n")) assert.ok(line.length <= 998);
});

test("an HTML message with attachments nests the alternatives in mixed", () => {
  const { data } = buildMime(FROM, { to: ["a@example.com"], subject: "Hi", text: "t", html: "<p>h</p>", attachments: [{ name: "r.pdf", data: Uint8Array.from([1]), type: "application/pdf" }] }, 0, "id2@example.com", "M");
  assert.match(data, /Content-Type: multipart\/mixed; boundary="M"\r\n\r\n--M\r\nContent-Type: multipart\/alternative; boundary="M_a"/);
  assert.match(data, /--M_a--\r\n--M\r\nContent-Type: application\/pdf; name="r.pdf"/);
});

test("buildMime refuses headers, content ids and image types it does not write", () => {
  const base = { to: ["a@example.com"], subject: "Hi", text: "t", html: "<p>h</p>" };
  assert.throws(() => buildMime(FROM, { ...base, headers: [{ name: "Bcc", value: "x@example.com" }] }, 0, "i@x.com"), MimeError);
  assert.throws(() => buildMime(FROM, { ...base, headers: [{ name: "List-Unsubscribe", value: "a\r\nBcc: x@example.com" }] }, 0, "i@x.com"), MimeError);
  assert.throws(() => buildMime(FROM, { ...base, inline: [{ cid: "bad cid>", name: "x.png", data: Uint8Array.from([1]), type: "image/png" }] }, 0, "i@x.com"), MimeError);
  assert.throws(() => buildMime(FROM, { ...base, inline: [{ cid: "a@b", name: "x.svg", data: Uint8Array.from([1]), type: "image/svg+xml" }] }, 0, "i@x.com"), MimeError);
  assert.throws(() => buildMime(FROM, { to: ["a@example.com"], subject: "Hi", text: "t", inline: [{ cid: "a@b", name: "x.png", data: Uint8Array.from([1]), type: "image/png" }] }, 0, "i@x.com"), MimeError);
  const named = buildMime(FROM, { ...base, fromName: "Café \"Q\"\r\nBcc: x" }, 0, "i@x.com").data;
  assert.match(named, /^From: =\?utf-8\?B\?[^\r\n]+\?= <penny@example.com>\r\n/m);
  assert.ok(!/^Bcc:/m.test(named));
});
