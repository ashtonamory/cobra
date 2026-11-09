import { test } from "node:test";
import assert from "node:assert/strict";

import { notificationsOn, notifyCommand } from "./push.ts";

const message = { title: "web-app needs you", body: 'Bash command: echo "hi"' };

test("Linux shows a notification with notify-send, the text after --", () => {
  assert.deepEqual(notifyCommand(message, "linux"), {
    command: "notify-send",
    args: ["--app-name=Cobra", "--", message.title, message.body],
  });
});

test("macOS shows one with osascript, quotes escaped", () => {
  const shown = notifyCommand(message, "darwin");
  assert.equal(shown?.command, "osascript");
  assert.equal(shown?.args[1], 'display notification "Bash command: echo \\"hi\\"" with title "web-app needs you"');
});

test("a platform with no notifier shows none", () => {
  assert.equal(notifyCommand(message, "win32"), null);
});

test("COBRA_NOTIFY=0 turns notifications off", () => {
  assert.equal(notificationsOn({ COBRA_NOTIFY: "0" }), false);
  assert.equal(notificationsOn({}), true);
});
