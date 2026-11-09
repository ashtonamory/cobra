import { test } from "node:test";
import assert from "node:assert/strict";

import { MORE_ON_SCREEN, VOICE_PREFIX, isVoiceText, speakable, splitSentences, stripVoice } from "./voiceCall.ts";

test("the voice prefix marks spoken words and comes off cleanly", () => {
  assert.equal(isVoiceText(`${VOICE_PREFIX}What is waiting on me?`), true);
  assert.equal(isVoiceText("  [voice] hi"), true);
  assert.equal(isVoiceText("What is waiting on me?"), false);
  assert.equal(stripVoice("[voice] What is waiting on me?"), "What is waiting on me?");
  assert.equal(stripVoice("Plain words"), "Plain words");
});

test("a short plain reply is read whole", () => {
  assert.deepEqual(speakable("Your booking page is live. Customers can pay the $25.00 deposit."), {
    say: "Your booking page is live. Customers can pay the $25.00 deposit.",
    more: false,
  });
});

test("a long reply is cut to two sentences and points at the screen", () => {
  const out = speakable("The menu page is live. It shows the new prices. I also fixed the phone layout. Want me to add photos?");
  assert.equal(out.more, true);
  assert.equal(out.say, `The menu page is live. It shows the new prices. ${MORE_ON_SCREEN}`);
});

test("links keep their words, bare addresses and code go", () => {
  const out = speakable("See [the preview](https://x.workers.dev/p). It runs `pnpm build` first.", 3);
  assert.equal(out.say, `See the preview. It runs pnpm build first. ${MORE_ON_SCREEN}`);
  assert.equal(speakable("Here it is: https://example.com/menu").say, `Here it is. ${MORE_ON_SCREEN}`);
});

test("markdown marks never reach the voice", () => {
  const out = speakable("## Done\n\n**Your site** is _live_ now.", 3);
  assert.equal(out.say, "Done. Your site is live now.");
  assert.equal(out.more, false);
});

test("a list reads its first items as sentences", () => {
  const out = speakable("Three things wait on you:\n\n- Publish the menu page\n- Allow the invoice email\n- Answer the price question");
  assert.equal(out.say, `Three things wait on you. Publish the menu page. ${MORE_ON_SCREEN}`);
});

test("code blocks and tables are left for the screen", () => {
  const out = speakable("Here is the plan.\n\n```sh\nrm -rf x\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |");
  assert.equal(out.say, `Here is the plan. ${MORE_ON_SCREEN}`);
  assert.equal(speakable("```\nonly code\n```").say, MORE_ON_SCREEN);
  assert.deepEqual(speakable("   "), { say: "", more: false });
});

test("sentences split before a capital or a number, not inside amounts", () => {
  assert.deepEqual(splitSentences("It costs $4.50 a month. 3 people use it! Is that ok? yes."), [
    "It costs $4.50 a month.",
    "3 people use it!",
    "Is that ok? yes.",
  ]);
});
