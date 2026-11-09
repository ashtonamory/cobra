import { test } from "node:test";
import assert from "node:assert/strict";

import { addBoxProblem, boxChoices, boxSpacesLine, boxWord, MailboxList } from "./mailboxes.ts";

const LIST = MailboxList.parse({
  boxes: [{ id: "b1", provider: "icloud", address: "studio@icloud.com", user: "studio@icloud.com", addedAt: "2026-11-02T15:00:00Z", spaces: ["s1"] }],
  providers: [{ id: "icloud", name: "iCloud Mail", help: "…" }, { id: "zoho", name: "Zoho Mail", help: "…" }],
  regions: ["com", "eu"],
  spaces: [{ id: "s1", name: "Happy Tails", box: "b1" }, { id: "s2", name: "Run Club", box: "gmail" }],
});

test("mailbox words the phone and the desk share", () => {
  assert.equal(boxWord(LIST, "gmail"), "Gmail");
  assert.equal(boxWord(LIST, "b1"), "studio@icloud.com");
  assert.equal(boxWord(LIST, "gone"), "a removed mailbox");
  assert.deepEqual(boxChoices(LIST), [{ id: "gmail", label: "Gmail" }, { id: "b1", label: "studio@icloud.com (iCloud Mail)" }]);
  assert.equal(boxSpacesLine(LIST, LIST.boxes[0]!), "Sends for Happy Tails");
  assert.equal(addBoxProblem({ provider: "", address: "a@b.co", password: "x" }), "Choose iCloud Mail or Zoho Mail.");
  assert.equal(addBoxProblem({ provider: "zoho", address: "nope", password: "x" }), "Type the address the email goes from.");
  assert.equal(addBoxProblem({ provider: "zoho", address: "a@b.co", password: "" }), "Paste the app password.");
  assert.equal(addBoxProblem({ provider: "zoho", address: "a@b.co", password: "x" }), null);
});
