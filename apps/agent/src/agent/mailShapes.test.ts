import { test } from "node:test";
import assert from "node:assert/strict";

import { BODY_MAX, countOf, decodeEntities, htmlToText, mailSearchRequest, MAX_MESSAGES, messageId, queryText, readable, ReadRequestError, tidy } from "./mailShapes.ts";

const refused = (work: () => unknown, words: RegExp) => assert.throws(work, (caught: unknown) => caught instanceof ReadRequestError && caught.status === 400 && words.test(caught.message));

test("a search: a query is needed and at most 500 characters, at most 25 messages, 10 when none is said", () => {
  assert.deepEqual(mailSearchRequest({ query: "  from:ana@example.com   newer_than:7d " }), { query: "from:ana@example.com newer_than:7d", max: 10 });
  assert.deepEqual(mailSearchRequest({ query: "in:inbox", max: MAX_MESSAGES }), { query: "in:inbox", max: 25 });
  refused(() => mailSearchRequest({}), /query is needed/);
  refused(() => mailSearchRequest({ query: "   " }), /query is needed/);
  refused(() => mailSearchRequest({ query: 3 }), /query is text/);
  refused(() => mailSearchRequest({ query: "x".repeat(501) }), /at most 500/);
  refused(() => mailSearchRequest({ query: "in:inbox", max: 26 }), /from 1 to 25/);
  refused(() => mailSearchRequest({ query: "in:inbox", max: 1.5 }), /from 1 to 25/);
  assert.equal(queryText(undefined, 10, false), undefined);
  assert.equal(countOf(undefined, 5, 3), 3);
});

test("a message id is letters, digits, _ and -, 8 to 64 of them; anything else never reaches a mailbox", () => {
  assert.equal(messageId(" b1700000000-42-0a1b2c3d "), "b1700000000-42-0a1b2c3d");
  for (const bad of ["../attachments/x", "short", "", 7, undefined, "a".repeat(65), "has space 1234"]) refused(() => messageId(bad), /id is a message id from mail_search/);
});

test("what a model reads has its secrets out and is cut with the cut said", () => {
  const scrubbed = readable("reset with ghp_abcdefghijklmnopqrstuvwxyz0123456789 today", 500);
  assert.doesNotMatch(scrubbed, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  assert.equal(readable("x".repeat(30), 20), `${"x".repeat(20)}… [cut at 20 characters]`);
  assert.equal(readable("short", 20), "short");
  assert.ok(BODY_MAX >= 1000);
});

test("htmlToText and decodeEntities on their own", () => {
  assert.equal(decodeEntities("&lt;b&gt; &#x27;a&#39; &quot;q&quot; &unknown; &#0;"), "<b> 'a' \"q\" &unknown; &#0;");
  assert.equal(htmlToText("Line one<br>Line two<br/><div>Block</div><table><tr><td>a</td><td>b</td></tr></table>"), "Line one\nLine two\nBlock\na b");
  // A link whose words are its address is not said twice; a javascript: link loses its target.
  assert.equal(htmlToText('<a href="https://x.example">https://x.example</a> <a href="javascript:alert(1)">click</a> <a href="mailto:a@example.com">a@example.com</a>'), "https://x.example click a@example.com");
  // No head, script, style or comment reaches the text.
  assert.equal(htmlToText("<head><title>t</title></head><style>p{}</style><script>steal()</script><!-- hidden --><p>Hello</p><p>there</p>"), "Hello\n\nthere");
  assert.equal(tidy("a  \r\n\r\n\r\n\r\n b \t c  "), "a\n\nb c");
});
