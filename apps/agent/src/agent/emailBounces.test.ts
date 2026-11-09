import { test } from "node:test";
import assert from "node:assert/strict";

import { checkBounces, failedAddresses } from "./emailBounces.ts";

const NOW = new Date("2026-11-02T15:00:00Z");

test("only a final failure names its addresses; never the mail system's or the account's own", () => {
  const text = "Address not found\n\nYour message wasn't delivered to ana@example.com because the address couldn't be found. Contact mailer-daemon@googlemail.com. From owner@gmail.com.";
  assert.deepEqual(failedAddresses({ subject: "Delivery Status Notification (Failure)", text }, "owner@gmail.com"), ["ana@example.com"]);
  assert.deepEqual(failedAddresses({ subject: "Delivery Status Notification (Delay)", text }, "owner@gmail.com"), []);
  assert.deepEqual(failedAddresses({ subject: "Re: your class", text }, "owner@gmail.com"), []);
});

test("a notice marks an address bounced only where the ledger sent to it lately, and is read once", async () => {
  let seen: string[] = [];
  const marked: string[] = [];
  const reads: string[] = [];
  const deps = {
    search: async () => [
      { id: "n1", subject: "Delivery Status Notification (Failure)" },
      { id: "n2", subject: "Undeliverable: November news" },
      { id: "n3", subject: "Delivery Status Notification (Delay)" },
    ],
    read: async (id: string) => {
      reads.push(id);
      return { id, subject: id === "n1" ? "Delivery Status Notification (Failure)" : "Undeliverable: November news", text: id === "n1" ? "wasn't delivered to ana@example.com" : "Delivery has failed to these recipients: stranger@example.com" };
    },
    seen: () => seen,
    saveSeen: (ids: string[]) => void (seen = ids),
    sentTo: (email: string) => (email === "ana@example.com" ? ["s1"] : []),
    markBounced: (space: string, email: string) => void marked.push(`${space}:${email}`),
    account: "owner@gmail.com",
    now: () => NOW,
    log: () => {},
  };
  assert.equal(await checkBounces(deps), 1);
  assert.deepEqual(marked, ["s1:ana@example.com"], "a notice about someone the Space never mailed changes nothing");
  assert.deepEqual(reads, ["n1", "n2"], "a delay is never read");
  assert.equal(await checkBounces(deps), 0);
  assert.deepEqual(reads, ["n1", "n2"], "read once");
});
