import { test } from "node:test";
import assert from "node:assert/strict";
import { REAL_IDLE, SPINNER_LIVE, WORKING_TYPED, withEmptyBox, withSpinner } from "./fixtures/screens.ts";
import { inputBox, plainLine, readCodexPane, readPane, unwrap } from "./pane.ts";

/**
 * Every fixture here is a verbatim `tmux capture-pane -p` of a real Claude
 * Code session (2026-09-19), not a reconstruction. If Claude Code's UI changes,
 * these should be re-captured the same way rather than edited to pass.
 */

const RULE = "─".repeat(100);

test("a Codex composer reads as an empty input and its working line as active", () => {
  const idle = ["  finished", "› ", "  GPT-6.1 Sol · /work/project", "  ? for shortcuts"];
  assert.deepEqual(readCodexPane(idle), {
    needsInput: false, dialog: null, working: false, box: "empty", inputEmpty: true, recognised: true, tail: ["finished"], dialogText: [], question: null, model: null,
  });
  const busy = ["  • Working (3s · esc to interrupt)", "› change", "  GPT-6.1 Sol · /work/project"];
  assert.equal(readPane(busy).working, true);
  assert.equal(readPane(busy).box, "text");
});

test("a Codex folder prompt stays a trust dialog", () => {
  const pane = ["Folder access", "  /work/project", "› 1. Open restricted", "  2. Trust this folder"];
  assert.equal(readCodexPane(pane)?.dialog, "trust");
  assert.equal(readCodexPane(pane)?.box, "none");
});

test("Codex's empty command center asks dispatch to open a new task", () => {
  const pane = ["  Agent command center  Group: Project", "  No tasks yet", "  ? help  esc back  ↑/↓ move  enter open  n new"];
  assert.equal(readCodexPane(pane)?.codexHome, true);
  assert.equal(readPane(pane).box, "none");
});

const PERMISSION = `✻ Cogitated for 2s · done 7:35 PM

❯ Run touch hello.txt here.

● Bash(touch hello.txt)
  ⎿  Waiting…

${RULE}
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below

   touch hello.txt
   Create empty file hello.txt

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to
      /tmp/claude-1000/-home-sam/26661e7c-a1e7-4e82-97c0-936d26d6e995/scratchpad/probe from this
      project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend


`.split("\n");

const QUESTION = `✻ Cooked for 4s · done 7:34 PM

❯ Use the AskUserQuestion tool to ask me whether I prefer tea or coffee.
${RULE}
 ☐ Beverage

Do you prefer tea or coffee?

❯ 1. Tea
     You prefer tea.
  2. Coffee
     You prefer coffee.
  3. Type something.
${RULE}
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel`.split("\n");

const TRUST = `claude
probe master ❯ claude
${RULE}
 Accessing workspace:
 /tmp/claude-1000/-home-sam/26661e7c-a1e7-4e82-97c0-936d26d6e995/scratchpad/probe
 Quick safety check: Is this a project you created or one you trust? (Like your own code, a
 well-known open source project, or work from your team). If not, take a moment to review what's in
 this folder first.
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel`.split("\n");

const DONE = `● Unchanged from the last run.

  total 0
  drwxr-xr-x 3 sam sam  60 Sep 19 19:33 .
  drwx------ 3 sam sam  60 Sep 19 19:33 ..
  drwxr-xr-x 6 sam sam 180 Sep 19 19:33 .git

  File count: 0 regular files. The only entry is the .git directory, with the same timestamps as
  before, so nothing was added or removed between the two runs.

✻ Worked for 5s · done 7:34 PM

${RULE}
❯ run it once more
${RULE}
  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent      Update available! Run: mise upgrade claude
                                                                                  ● high · /effort`.split("\n");

const WORKING = `● Unchanged from the last run.

  File count: 0 regular files.
  ⎿  Tip: Use /voice to enable push-to-talk dictation

${RULE}
❯ 
${RULE}
  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← 1 agent
                                                        Update available! Run: mise upgrade claude
`.split("\n");

/**
 * A two-question AskUserQuestion (captured 2026-09-20, blank lines dropped by
 * the probe script): the first question up, then the multi-select second one
 * with a row toggled, then the review screen at the end.
 */
const QUESTION_TABS = `❯ Use the AskUserQuestion tool once with TWO questions: (1) header "Drink", question "Tea or
  coffee?", options Tea and Coffee (multiSelect false); (2) header "Extras", question "Which
  extras?", options Milk, Sugar, Lemon (multiSelect true). Do not do anything else.
${RULE}
←  ☐ Drink  ☐ Extras  ✔ Submit  →
Tea or coffee?
❯ 1. Tea
     A cup of tea
  2. Coffee
     A cup of coffee
  3. Type something.
${RULE}
  4. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel`.split("\n");

const MULTI_SELECT = `${RULE}
←  ☒ Drink  ☒ Extras  ✔ Submit  →
Which extras?
❯ 1. [✔] Milk
  Add milk
  2. [ ] Sugar
  Add sugar
  3. [✔] Lemon
  Add lemon
  4. [ ] Type something
     Submit
${RULE}
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel`.split("\n");

const REVIEW = `${RULE}
←  ☒ Drink  ☒ Extras  ✔ Submit  →
Review your answers
 ● Tea or coffee?
   → Coffee
 ● Which extras?
   → Lemon
Ready to submit your answers?
❯ 1. Submit answers
  2. Cancel`.split("\n");

/** Haiku, default permission mode, 2026-09-20: descriptions wrap on a narrow pane. */
/**
 * Claude Code 2.1.284 on a pane the phone's terminal had sized to 52 columns
 * (captured 2026-10-03 with tmux capture-pane, blank lines dropped). The foot
 * of a two-question dialog no longer fits, so "Esc to cancel" is split over
 * two lines, and the reader saw no dialog at all: the chat offered the
 * message box while Claude sat waiting.
 */
const NARROW = "─".repeat(52);
const QUESTION_NARROW = `  options Milk, Sugar, Lemon, multiSelect true. Do
  not do anything else.
${NARROW}
←  ☐ Drink  ☐ Extras  ✔ Submit  →
Tea or coffee?
❯ 1. Tea
     A cup of tea
  2. Coffee
     A cup of coffee
  3. Type something.
${NARROW}
  4. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc
to cancel`.split("\n");

const MULTI_SELECT_NARROW = `  not do anything else.
${NARROW}
←  ☐ Drink  ☐ Extras  ✔ Submit  →
Which extras do you want with it today?
❯ 1. [ ] Milk
         Add milk
  2. [ ] Sugar
         Add sugar
  3. [ ] Lemon
         Add lemon
  4. [ ] Type something
     Submit
${NARROW}
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc
to cancel`.split("\n");

/**
 * A question longer than a line gets a bar down its left (2.1.284, the same
 * capture session), at any width.
 */
const LONG_QUESTION = `  layout."). Do not do anything else.
${"─".repeat(80)}
 ☐ Surface
│ Which MAIN are we improving? The desk web page (8 tiles, allocation bar,
│ net-worth chart, movers, wire, digests, sector board), the phone MAIN (already
│ redone), or the native GTK one?
❯ 1. Desk web MAIN
     On a big screen. Oldest layout of the three.
  2. Phone MAIN
     The newer phone layout.
  3. Type something.
${"─".repeat(80)}
  4. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel`.split("\n");

const LONG_QUESTION_NARROW = `  else.
${NARROW}
 ☐ Surface
│ Which MAIN are we improving? The desk web page (8
│ tiles, allocation bar, net-worth chart, movers,
│ wire, digests, sector board), the phone MAIN
│ (already redone), or the native GTK one?
❯ 1. Desk web MAIN
     On a big screen. Oldest layout of the three.
  2. Phone MAIN
     The newer phone layout.
  3. Type something.
${NARROW}
  4. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel`.split("\n");

/**
 * A question whose options carry previews (2.1.284, captured 2026-10-03 at
 * 52 and 80 columns): the list on the left, the highlighted option's preview
 * boxed on the right from a fixed column, no descriptions, no "Type
 * something" row, and an unnumbered "Chat about this" under the rule.
 */
const PREVIEWS_NARROW = `────────────────────────────────────────────────────
←  ☐ Shape  ☐ Extras  ✔ Submit  →
What shape should the launchpad take?
❯ 1. Doors with status       ┌────────────────┐
  2. Ticker pad              │ ┌───────────── │
  3. Layout launcher         │ ─────────────┐ │
                             │ │ ▶ DOOR 1     │
                             │ [GREEN]      │ │
                             │ │ ▶ DOOR 2     │
                             │ [YELLOW]     │ │
                             │ │ ▶ DOOR 3     │
                             │ [RED]        │ │
                             │ │ ▶ DOOR 4     │
                             │ [GREEN]      │ │
                             │ └───────────── │
                             │ ─────────────┘ │
                             └────────────────┘
                             Notes press n to add
                             :     notes
────────────────────────────────────────────────────
  Chat about this
Enter to select · ↑/↓ to navigate · n to add notes ·
Tab to switch questions · Esc to cancel`.split("\n");

const PREVIEWS = `────────────────────────────────────────────────────────────────────────────────
←  ☐ Shape  ☐ Extras  ✔ Submit  →
What shape should the launchpad take?
❯ 1. Doors with status            ┌──────────────────────────────────────────┐
  2. Ticker pad                   │ ┌──────────────────────────┐             │
  3. Layout launcher              │ │ ▶ DOOR 1    [GREEN]      │             │
                                  │ │ ▶ DOOR 2    [YELLOW]     │             │
                                  │ │ ▶ DOOR 3    [RED]        │             │
                                  │ │ ▶ DOOR 4    [GREEN]      │             │
                                  │ └──────────────────────────┘             │
                                  └──────────────────────────────────────────┘
                                  Notes: press n to add notes
────────────────────────────────────────────────────────────────────────────────
  Chat about this
Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions ·
Esc to cancel`.split("\n");

const WRAPPED = `● Got it! I'll ask a test question to help you
  verify the chat feature is working end-to-end.
${"─".repeat(52)}
 ☐ Test Question
Which feature would you like to test next?
❯ 1. Message delivery
     Test that messages are sent and received
     correctly
  2. File attachments
     Test uploading files or images in chat
  3. Something else
     Test a different aspect of the chat feature
  4. Type something.
${"─".repeat(52)}
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel`.split("\n");

/**
 * The /model picker (capture of 2026-09-21). Before this was recognised it
 * read as an AskUserQuestion — numbered rows and "Esc to cancel" are enough
 * to fool the question path — which put a bogus question card on the phone
 * and left `say` refusing to type into the session.
 */
const MODEL_PICKER = `❯ /model

${RULE}
  Select model
  Switch between Claude models. Your pick becomes the default for new
  sessions. For other/previous model names, specify with --model.

    1. Default (recommended)  Sonnet 5 · Efficient for routine tasks
    2. Sonnet                 Sonnet 5 · Efficient for routine tasks
    3. Fable                  Fable 5.1 · Most capable for your hardest and
                              longest-running tasks
  ❯ 4. Opus ✔                 Opus 5 · Best for everyday, complex tasks
    5. Haiku                  Haiku 4.5 · Fastest for quick answers

  ● High effort (default) ←/→ to adjust

  Use /fast to turn on Fast mode (Opus 5).

  Enter to set as default · s to use this session only · Esc to cancel
`.split("\n");

/** The same picker with Haiku highlighted, which has no effort setting. */
const MODEL_PICKER_HAIKU = `❯ /model

${RULE}
  Select model

    4. Opus ✔                 Opus 5 · Best for everyday, complex tasks
  ❯ 5. Haiku                  Haiku 4.5 · Fastest for quick answers

  ○ Effort not supported for Haiku

  Enter to set as default · s to use this session only · Esc to cancel
`.split("\n");

/**
 * The same picker on a 52-column pane (capture of 2026-09-21, from a session
 * the phone's terminal had been opened on — it sizes the pane to the phone
 * and it stays that way). The foot wraps mid-sentence:
 *
 *     Enter to set as default · s to use this session
 *     only · Esc to cancel
 *
 * which made "to use this session only" miss, so the picker was classified as
 * an AskUserQuestion and the app drew a bogus question card over it.
 */
const MODEL_PICKER_NARROW = `✻ Churned for 2s · done 10:51 AM

❯ /model
  ⎿  Kept model as Sonnet 5

❯ /model

────────────────────────────────────────────────────
  Select model
  Switch between Claude models. Your pick becomes
  the default for new sessions. For other/previous
  model names, specify with --model.

    1. Default (recommended)  Sonnet 5 · Efficient
                              for routine tasks
  ❯ 2. Sonnet ✔               Sonnet 5 · Efficient
                              for routine tasks
    3. Fable                  Fable 5.1 · Most
                              capable for your
                              hardest and
                              longest-running
                              tasks
    4. Opus                   Opus 5 · Best for
                              everyday, complex
                              tasks
    5. Haiku                  Haiku 4.5 · Fastest
                              for quick answers

  ● High effort (default) ←/→ to adjust

  Use /fast to turn on Fast mode (Opus 5).

  Enter to set as default · s to use this session
  only · Esc to cancel
`.split("\n");

const SHELL = ["probe master ❯ ls", "hello.txt", "probe master ❯ "];
const SHELL_RAN = [
  "control-plane hue-full-control ❯ pnpm test",
  "ℹ tests 59",
  "ℹ pass 59",
  "",
  "control-plane hue-full-control ❯",
];

test("a permission prompt is a dialog, and the preview says what it is about", () => {
  const read = readPane(PERMISSION);
  assert.equal(read.recognised, true);
  assert.equal(read.needsInput, true);
  assert.equal(read.dialog, "permission");
  assert.equal(read.working, false);
  assert.deepEqual(read.tail, ["Bash command", "touch hello.txt"]);
});

test("an AskUserQuestion is a dialog, and the preview is the question", () => {
  const read = readPane(QUESTION);
  assert.equal(read.needsInput, true);
  assert.equal(read.dialog, "question");
  assert.deepEqual(read.tail, ["Do you prefer tea or coffee?"]);
});

test("a question screen lists its rows, and knows a single-select from a multi", () => {
  const first = readPane(QUESTION_TABS);
  assert.equal(first.dialog, "question");
  assert.deepEqual(first.question, {
    text: "Tea or coffee?",
    header: null,
    rows: [
      { n: 1, label: "Tea", description: "A cup of tea", checked: null },
      { n: 2, label: "Coffee", description: "A cup of coffee", checked: null },
      { n: 3, label: "Type something.", description: null, checked: null },
      { n: 4, label: "Chat about this", description: null, checked: null },
    ],
    multiSelect: false,
    submit: false,
    previews: false,
  });
  // One question: the strip has one tab, which names it.
  assert.equal(readPane(QUESTION).question?.header, "Beverage");
  assert.deepEqual(readPane(QUESTION).question?.rows.map((row) => row.label), [
    "Tea",
    "Coffee",
    "Type something.",
    "Chat about this",
  ]);

  const multi = readPane(MULTI_SELECT);
  assert.equal(multi.needsInput, true);
  assert.equal(multi.question?.multiSelect, true);
  assert.equal(multi.question?.text, "Which extras?");
  assert.deepEqual(
    multi.question?.rows.filter((row) => row.checked).map((row) => row.n),
    [1, 3],
  );
});

test("a wrapped description is joined back together, and the tab names the question", () => {
  const read = readPane(WRAPPED);
  assert.equal(read.dialog, "question");
  assert.equal(read.question?.header, "Test Question");
  assert.equal(read.question?.text, "Which feature would you like to test next?");
  assert.deepEqual(
    read.question?.rows.slice(0, 2).map((row) => [row.label, row.description]),
    [
      ["Message delivery", "Test that messages are sent and received correctly"],
      ["File attachments", "Test uploading files or images in chat"],
    ],
  );
});

test("a narrow pane wraps a question's foot, and it is still a question", () => {
  const read = readPane(QUESTION_NARROW);
  assert.equal(read.recognised, true);
  assert.equal(read.needsInput, true);
  assert.equal(read.dialog, "question");
  assert.equal(read.question?.text, "Tea or coffee?");
  assert.deepEqual(
    read.question?.rows.map((row) => [row.n, row.label, row.description]),
    [
      [1, "Tea", "A cup of tea"],
      [2, "Coffee", "A cup of coffee"],
      [3, "Type something.", null],
      [4, "Chat about this", null],
    ],
  );

  const multi = readPane(MULTI_SELECT_NARROW);
  assert.equal(multi.needsInput, true);
  assert.equal(multi.question?.multiSelect, true);
  assert.equal(multi.question?.text, "Which extras do you want with it today?");
  assert.deepEqual(
    multi.question?.rows.slice(0, 3).map((row) => [row.label, row.description, row.checked]),
    [
      ["Milk", "Add milk", false],
      ["Sugar", "Add sugar", false],
      ["Lemon", "Add lemon", false],
    ],
  );
});

test("the bar down a long question is drawing, not part of its text", () => {
  const wanted =
    "Which MAIN are we improving? The desk web page (8 tiles, allocation bar, net-worth chart, movers, wire, digests, sector board), the phone MAIN (already redone), or the native GTK one?";
  for (const pane of [LONG_QUESTION, LONG_QUESTION_NARROW]) {
    const read = readPane(pane);
    assert.equal(read.dialog, "question");
    assert.equal(read.question?.header, "Surface");
    assert.equal(read.question?.text, wanted);
    assert.equal(read.tail[0]?.startsWith("Which MAIN"), true);
  }
});

test("options with previews read as the list alone, and say they have previews", () => {
  for (const pane of [PREVIEWS_NARROW, PREVIEWS]) {
    const read = readPane(pane);
    assert.equal(read.needsInput, true);
    assert.equal(read.dialog, "question");
    assert.equal(read.question?.text, "What shape should the launchpad take?");
    assert.equal(read.question?.previews, true);
    assert.deepEqual(
      read.question?.rows.map((row) => [row.n, row.label, row.description]),
      [
        [1, "Doors with status", null],
        [2, "Ticker pad", null],
        [3, "Layout launcher", null],
      ],
    );
  }
  // An ordinary question says it has none.
  assert.equal(readPane(QUESTION_NARROW).question?.previews, false);
});

test("the review screen at the end of a multi-question dialog still needs input", () => {
  const read = readPane(REVIEW);
  assert.equal(read.needsInput, true);
  assert.equal(read.dialog, "question");
  assert.equal(read.question?.submit, true);
  assert.equal(read.question?.rows[0]?.label, "Submit answers");
});

test("a permission prompt has no question screen", () => {
  assert.equal(readPane(PERMISSION).question, null);
  assert.equal(readPane(TRUST).question, null);
});

test("the trust check on a new folder is a dialog", () => {
  const read = readPane(TRUST);
  assert.equal(read.needsInput, true);
  assert.equal(read.dialog, "trust");
  assert.equal(read.tail[0], "Accessing workspace:");
});

test("a finished turn is recognised, not working, and previews the last words", () => {
  const read = readPane(DONE);
  assert.equal(read.recognised, true);
  assert.equal(read.needsInput, false);
  assert.equal(read.dialog, null);
  assert.equal(read.working, false);
  assert.deepEqual(read.tail, [
    "File count: 0 regular files. The only entry is the .git directory, with the same timestamps as",
    "before, so nothing was added or removed between the two runs.",
  ]);
});

test("a running turn is working, and the chrome stays out of the preview", () => {
  const read = readPane(WORKING);
  assert.equal(read.working, true);
  assert.equal(read.needsInput, false);
  assert.deepEqual(read.tail, ["● Unchanged from the last run.", "File count: 0 regular files."]);
});

test("a dialog that was answered and scrolled into history no longer counts", () => {
  const read = readPane([...PERMISSION, ...DONE]);
  assert.equal(read.needsInput, false);
  assert.equal(read.working, false);
});

test("the model picker is its own dialog, not a question", () => {
  const read = readPane(MODEL_PICKER);
  assert.equal(read.needsInput, true);
  assert.equal(read.dialog, "model");
  // Enter on this screen saves a machine-wide default, so nothing may drive
  // it as though it were a question.
  assert.equal(read.question, null);
});

test("the picker lists its models and marks the one in use", () => {
  const read = readPane(MODEL_PICKER);
  assert.deepEqual(
    read.model?.rows.map((row) => [row.n, row.label, row.current, row.selected]),
    [
      [1, "Default (recommended)", false, false],
      [2, "Sonnet", false, false],
      [3, "Fable", false, false],
      // The picker opens with the cursor on the model in use.
      [4, "Opus", true, true],
      [5, "Haiku", false, false],
    ],
  );
  assert.equal(read.model?.rows[3]?.description, "Opus 5 · Best for everyday, complex tasks");
});

test("a wrapped model description is joined, and the prose below the rows is not one", () => {
  const rows = readPane(MODEL_PICKER).model?.rows ?? [];
  assert.equal(
    rows[2]?.description,
    "Fable 5.1 · Most capable for your hardest and longest-running tasks",
  );
  // "Use /fast to turn on Fast mode" sits under the last row but belongs to
  // the screen, not to Haiku.
  assert.equal(rows[4]?.description, "Haiku 4.5 · Fastest for quick answers");
});

test("the picker reports effort, and reports none when the model has no setting", () => {
  assert.equal(readPane(MODEL_PICKER).model?.effort, "High effort (default)");
  assert.equal(readPane(MODEL_PICKER_HAIKU).model?.effort, null);
  assert.equal(readPane(MODEL_PICKER_HAIKU).model?.rows.length, 2);
  // The cursor has moved off the model in use; "✔" and "❯" are not the same row.
  const haiku = readPane(MODEL_PICKER_HAIKU).model?.rows ?? [];
  assert.deepEqual(haiku.map((row) => [row.label, row.current, row.selected]), [
    ["Opus", true, false],
    ["Haiku", false, true],
  ]);
});

test("a narrow pane wraps the picker's foot, and it is still a picker", () => {
  const read = readPane(MODEL_PICKER_NARROW);
  assert.equal(read.dialog, "model");
  assert.equal(read.needsInput, true);
  // Misread as a question, the app drew a question card over the picker and
  // the drive keys went to the wrong dialog.
  assert.equal(read.question, null);
});

test("a narrow pane's wrapped descriptions are joined back onto their rows", () => {
  const rows = readPane(MODEL_PICKER_NARROW).model?.rows ?? [];
  assert.deepEqual(
    rows.map((row) => [row.n, row.label, row.current, row.selected]),
    [
      [1, "Default (recommended)", false, false],
      [2, "Sonnet", true, true],
      [3, "Fable", false, false],
      [4, "Opus", false, false],
      [5, "Haiku", false, false],
    ],
  );
  // Wrapped over four lines at this width.
  assert.equal(
    rows[2]?.description,
    "Fable 5.1 · Most capable for your hardest and longest-running tasks",
  );
});

test("a plain shell is not recognised, so the caller falls back to timing", () => {
  const read = readPane(SHELL);
  assert.equal(read.recognised, false);
  assert.equal(read.needsInput, false);
  assert.equal(read.working, false);
});

test("a shell previews its last command and output, not the empty prompt", () => {
  assert.deepEqual(readPane(SHELL_RAN).tail, ["ℹ tests 59", "ℹ pass 59"]);
  assert.deepEqual(readPane(SHELL).tail, ["probe master ❯ ls", "hello.txt"]);
});

test("an empty pane reads as nothing at all", () => {
  assert.deepEqual(readPane([]), {
    needsInput: false,
    dialog: null,
    working: false,
    box: "none",
    inputEmpty: false,
    recognised: false,
    tail: [],
    dialogText: [],
    question: null,
    model: null,
  });
});

test("the input box: empty while a turn runs or after it, not with text typed, not under a dialog", () => {
  assert.equal(readPane(WORKING).inputEmpty, true);
  assert.equal(readPane(DONE).inputEmpty, false, "\"run it once more\" sits typed in the box");
  assert.equal(readPane(PERMISSION).inputEmpty, false);
  assert.equal(readPane(SHELL).inputEmpty, false, "a shell has no Claude box");
});

const NETWORK = `✻ Brewed for 1m 21s · done 7:56 AM

${RULE}
 Network request outside of sandbox                                      2 of 2
${"╌".repeat(100)}
 Host: registry.npmjs.org
${"╌".repeat(100)}
 Do you want to allow this connection?
 ❯ 1. Yes
   2. Yes, and don't ask again for registry.npmjs.org in any project (user
      settings)
   3. No, and tell Claude what to do differently (esc)


`.split("\n");

test("the sandbox's network prompt is a permission dialog, about its host", () => {
  const read = readPane(NETWORK);
  assert.equal(read.needsInput, true);
  assert.equal(read.dialog, "permission");
  assert.equal(read.working, false);
  assert.ok(read.tail.some((line) => line.includes("registry.npmjs.org")));
});

/** WebFetch's prompt, captured from Claude Code 2.1.296 on 2026-10-13: no foot, a question of its own. */
const FETCH = `● Fetch(https://example.org/)

${RULE}
 Fetch
 Claude wants to fetch content from example.org
${"╌".repeat(100)}
 url: https://example.org/
 prompt: What is the title of this page? Reply with the title only.
${"╌".repeat(100)}
 Do you want to allow Claude to fetch this content?
 ❯ 1. Yes
   2. Yes, and don't ask again for example.org
   3. No, and tell Claude what to do differently (esc)
`.split("\n");

/** The same prompt on a 46-column pane, as the phone's terminal leaves it: the question wraps. */
const FETCH_NARROW = `● Fetch(https://example.org/)

${"─".repeat(46)}
 Fetch
 Claude wants to fetch content from
 example.org
${"╌".repeat(46)}
 url: https://example.org/
 prompt: What is the title of this page?
 Reply with the title only.
${"╌".repeat(46)}
 Do you want to allow Claude to fetch this
 content?
 ❯ 1. Yes
   2. Yes, and don't ask again for example.org
   3. No, and tell Claude what to do
      differently (esc)
`.split("\n");

test("WebFetch's prompt is a permission dialog, wide or wrapped, with its page in the text", () => {
  for (const screen of [FETCH, FETCH_NARROW]) {
    const read = readPane(screen);
    assert.equal(read.needsInput, true);
    assert.equal(read.dialog, "permission");
    assert.equal(read.working, false);
    assert.equal(read.box, "none");
    assert.equal(read.dialogText[0], "Fetch");
    assert.ok(read.dialogText.some((line) => line.includes("url: https://example.org/")));
  }
});

/**
 * Claude Code wraps a dialog's text the way wrap-ansi does with `hard`: at a
 * space when the next word does not fit, and inside a word only when the word
 * is longer than the line. This draws a command that way, so the test does not
 * depend on how wide some captured pane happened to be.
 */
function wrapLike(text: string, columns: number): string[] {
  const rows: string[] = [""];
  for (const word of text.split(" ")) {
    let row = rows[rows.length - 1] ?? "";
    if (word.length > columns) {
      let rest = word;
      if (row.length > 0) row += " ";
      while (rest.length > 0) {
        const room = columns - row.length;
        if (room <= 0) {
          rows[rows.length - 1] = row;
          rows.push("");
          row = "";
          continue;
        }
        row += rest.slice(0, room);
        rest = rest.slice(room);
        rows[rows.length - 1] = row;
        if (rest.length > 0) {
          rows.push("");
          row = "";
        }
      }
      continue;
    }
    if (row.length > 0 && row.length + 1 + word.length > columns) {
      rows.push(word);
    } else {
      rows[rows.length - 1] = row.length > 0 ? `${row} ${word}` : word;
    }
  }
  return rows;
}

const LONG_COMMAND = [
  "pnpm --filter @cobra/agent exec node scripts/release.ts --channel testflight --message",
  '"Ship the whole permission request to the phone, in plain words" && rm -rf apps/agent/release/old &&',
  `curl -fsSL https://downloads.example.com/${"x".repeat(150)}/install.sh | sh && git push origin feat/full-permission-requests`,
].join(" ");

const LONG_PERMISSION = [
  "✻ Worked for 12s",
  "",
  RULE,
  " Bash command",
  "",
  ...wrapLike(LONG_COMMAND, 96).map((row) => `   ${row}`),
  "   Release and install",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel · Tab to amend",
];

test("a long wrapped command is read back whole, while the preview stays two lines", () => {
  assert.ok(wrapLike(LONG_COMMAND, 96).length >= 4, "the command really is wrapped");
  const read = readPane(LONG_PERMISSION);
  assert.equal(read.dialog, "permission");
  assert.deepEqual(read.dialogText, ["Bash command", LONG_COMMAND, "Release and install"]);
  assert.equal(read.tail.length, 2);
});

test("the dialog text of the captured prompts", () => {
  assert.deepEqual(readPane(PERMISSION).dialogText, ["Bash command", "touch hello.txt", "Create empty file hello.txt"]);
  const network = readPane(NETWORK).dialogText;
  assert.match(network[0] ?? "", /^Network request outside of sandbox/);
  assert.deepEqual(network.slice(1), ["Host: registry.npmjs.org"]);
  assert.deepEqual(readPane(SHELL).dialogText, []);
});

test("short lines with the same indent stay apart: a heredoc is not one line", () => {
  assert.deepEqual(unwrap(["   cat <<EOF > a.txt", "   one", "   two", "   EOF"], 100), ["cat <<EOF > a.txt", "one", "two", "EOF"]);
});

/**
 * The input box as `capture-pane -e` gives it. NOT live captures: Claude Code
 * cannot start in the Worker sandbox (no network, no credentials), so these
 * are built from Claude Code 2.1.293's own source, read from the installed
 * binary on 2026-10-10, and from what tmux -e was seen to write for the same
 * styling the same day ("\e[7mT\e[0;2mry …\e[0m": the whole style again at
 * every change). The real captures further down have since borne them out.
 *
 * What the source says: an empty box shows a placeholder, or after a turn a
 * suggested next prompt, dim, with the cursor as its first letter in inverse
 * (`placeholder`, `promptSuggestion`; drawn by `ge.dim(t)` and `invert(t[0])`).
 * In default mode the line under the box is "⏸ manual mode on · ? for
 * shortcuts", the same as in 2.1.2xx, and "esc to interrupt" while a turn runs.
 */
const ESC = "\x1b";
const FOREMAN_ABOVE = ["● Done: the brief is planned. PRs: none. Blocked: nothing.", "", "✻ Worked for 12s · done 1:02 AM", ""];
const boxed = (box: string, footer = "  ⏸ manual mode on · ? for shortcuts") => [...FOREMAN_ABOVE, RULE, box, RULE, footer];

/** An idle Foreman (--permission-mode default) after a turn, a suggestion in its box. */
const FOREMAN_SUGGESTS = boxed(`❯ ${ESC}[7mR${ESC}[0;2meview the Worker's PR${ESC}[0m`);
/** The same, while no client is attached: no cursor drawn, so all of it is dim. */
const FOREMAN_SUGGESTS_DETACHED = boxed(`❯ ${ESC}[2mReview the Worker's PR${ESC}[0m`);
/** Nothing in the box at all: the cursor alone. */
const FOREMAN_EMPTY = boxed(`❯ ${ESC}[7m ${ESC}[0m`);
/** Typed by someone, the cursor at the end. */
const FOREMAN_TYPED = boxed(`❯ wait, not yet${ESC}[7m ${ESC}[0m`);

test("ghost text in the box is empty when the capture keeps its styling", () => {
  for (const screen of [FOREMAN_SUGGESTS, FOREMAN_SUGGESTS_DETACHED, FOREMAN_EMPTY]) {
    const read = readPane(screen);
    assert.equal(read.box, "empty");
    assert.equal(read.inputEmpty, true);
    assert.equal(read.recognised, true);
    assert.equal(read.working, false);
    assert.equal(read.needsInput, false);
    assert.equal(inputBox(screen), "empty");
  }
});

test("without the styling, ghost text is indistinguishable from typing: the bug -e fixes", () => {
  assert.equal(inputBox(FOREMAN_SUGGESTS.map(plainLine)), "text");
});

test("text typed in the box is text, wherever the cursor is", () => {
  assert.equal(readPane(FOREMAN_TYPED).box, "text");
  assert.equal(readPane(FOREMAN_TYPED).inputEmpty, false);
  assert.equal(inputBox(boxed(`❯ wa${ESC}[7mi${ESC}[0mt`)), "text", "the cursor moved back into it");
  assert.equal(inputBox(boxed(`❯ ${ESC}[7mw${ESC}[0mait`)), "text", "the cursor at the start of typed text");
  assert.equal(inputBox(boxed(`❯ ${ESC}[7mw${ESC}[0m`)), "text", "one letter under the cursor");
  assert.equal(inputBox(FOREMAN_TYPED.map(plainLine)), "text");
});

test("a colour's own parameters are not attributes: 38;2;… is grey, not dim", () => {
  assert.equal(inputBox(boxed(`❯ ${ESC}[38;2;153;153;153mgrey words${ESC}[39m`)), "text");
  assert.equal(inputBox(boxed(`❯ ${ESC}[38;5;2mgreen${ESC}[39m`)), "text");
  assert.equal(inputBox(boxed(`❯ ${ESC}[38;5;246;2mdim grey${ESC}[0m`)), "empty");
  assert.equal(inputBox(boxed(`❯ ${ESC}[2mdim${ESC}[22m then typed`)), "text", "22 ends dim");
});

test("text on the lines a long input wrapped onto counts", () => {
  const wrapped = [...FOREMAN_ABOVE, RULE, "❯ ", "  the second line of what was typed", RULE, "  ⏸ manual mode on · ? for shortcuts"];
  assert.equal(inputBox(wrapped), "text");
  assert.equal(inputBox([...FOREMAN_ABOVE, RULE, `❯ ${ESC}[2mTry "fix the tests in`, `  ${ESC}[2msrc/agent"${ESC}[0m`, RULE]), "empty");
});

test("the box is the ❯ line under a rule: past prompts and a missing box are none", () => {
  assert.equal(inputBox(["❯ an earlier prompt", "", "● An answer."]), "none", "a past prompt has no rule over it");
  assert.equal(inputBox([RULE, "❯ ", "no rule beneath"]), "none");
  assert.equal(inputBox(SHELL), "none");
  assert.equal(inputBox(["❯ an earlier prompt", "  ⎿  (ran)", RULE, "❯ ", RULE]), "empty");
  assert.equal(readPane(PERMISSION).box, "none", "a dialog replaces the box");
  assert.equal(readPane(QUESTION).box, "none");
  assert.equal(readPane(DONE).box, "text");
  assert.equal(readPane(WORKING).box, "empty");
});

test("a default-mode Foreman mid-turn: working, its box still there", () => {
  const read = readPane(boxed("❯ ", "  ⏸ manual mode on · esc to interrupt"));
  assert.equal(read.recognised, true);
  assert.equal(read.working, true);
  assert.equal(read.box, "empty");
});

test("the box alone is recognisable chrome, and a footer read nowhere else still says working", () => {
  // A status line this reader does not know (a later version, a custom one).
  const read = readPane(boxed("❯ ", "  something new · esc to interrupt"));
  assert.equal(read.recognised, true);
  assert.equal(read.working, true);
  assert.equal(readPane(boxed("❯ ", "  something new")).working, false);
});

test("the styling never reaches the preview or a dialog's text", () => {
  const read = readPane(FOREMAN_SUGGESTS.map((line, i) => (i === 0 ? `${ESC}[1m${line}${ESC}[0m` : line)));
  assert.deepEqual(read.tail, ["● Done: the brief is planned. PRs: none. Blocked: nothing."]);
  const styled = PERMISSION.map((line) => (line.includes("touch hello.txt") ? `${ESC}[38;5;12m${line}${ESC}[0m` : line));
  assert.deepEqual(readPane(styled).dialogText, readPane(PERMISSION).dialogText);
  assert.equal(plainLine(`${ESC}]8;;file:///tmp/a${ESC}\\a.txt${ESC}]8;;${ESC}\\ done`), "a.txt done");
});

// REAL_IDLE, WORKING_TYPED and the screens derived from them: fixtures/screens.ts.

test("the real idle capture: the suggestion in the box is empty, and the Foreman takes a line", () => {
  const read = readPane(REAL_IDLE);
  assert.equal(read.box, "empty", "\"idle capture done\" is Claude Code's dim suggestion, not typing");
  assert.equal(read.inputEmpty, true);
  assert.equal(read.working, false);
  assert.equal(read.recognised, true);
  assert.equal(read.needsInput, false);
  assert.equal(inputBox(REAL_IDLE.map(plainLine)), "text", "read as -p would, it looks typed: the bug");
  assert.ok(read.tail.every((line) => !line.includes("\x1b")), "no styling in the preview");
  assert.ok(REAL_IDLE.filter((row) => row.includes("\x1b[48;5;237m")).length >= 1, "it has past prompts, on grey");
});

test("the working capture: words in the box are text, and the live spinner is working", () => {
  const read = readPane(WORKING_TYPED);
  assert.equal(read.box, "text");
  assert.equal(read.inputEmpty, false);
  assert.equal(read.working, true, "no \"esc to interrupt\" anywhere: the spinner says so");
  assert.equal(read.recognised, true);
  assert.equal(read.needsInput, false);
  assert.equal(inputBox(WORKING_TYPED.map(plainLine)), "text");
  const empty = readPane(withEmptyBox(WORKING_TYPED));
  assert.equal(empty.box, "empty");
  assert.equal(empty.working, true);
});

test("past prompts on a grey background are history, not the box", () => {
  const at = WORKING_TYPED.findIndex((row) => row.includes("\x1b[48;5;237m"));
  assert.equal(inputBox(WORKING_TYPED.slice(0, at + 4)), "none", "no rule over it");
});

test("a finished turn's line is not a live spinner, with or without its time", () => {
  for (const done of ["\x1b[38;5;246m✻\x1b[39m \x1b[38;5;246mChurned for 2m 10s · done 4:08 PM\x1b[39m", "✻ Baked for 9s"]) {
    const read = readPane(withEmptyBox(withSpinner(done)));
    assert.equal(read.working, false, done);
    assert.equal(read.box, "empty");
  }
});

test("the live spinner in its other frames and forms is working", () => {
  for (const live of [
    "* Musing… (15s · ↓ 584 tokens)",
    "· Musing… (3s)",
    "✢ Running the tests… (10m 16s · ↓ 2.1k tokens · thinking)",
    "✳ Fix the a · b case… (1h 2m · ↓ 9k tokens)",
    "✽ Waiting for API response · will retry in 4s · check your network",
  ]) {
    assert.equal(readPane(withSpinner(live)).working, true, live);
  }
  // With the task list a spinner carries under it, indented.
  const at = WORKING_TYPED.indexOf(SPINNER_LIVE);
  assert.equal(readPane([...WORKING_TYPED.slice(0, at + 1), "  ⎿  ☐ Read the brief", "     ☐ Plan the Workers", ...WORKING_TYPED.slice(at + 1)]).working, true);
  assert.equal(readPane(withSpinner("* a list item… not a spinner")).working, false);
});

test("what only looks like a spinner over the box is not working", () => {
  // A markdown bullet wrapped to column 0: the frame and the "…", no time.
  for (const line of ["* Loading… stuff", "* Loading…", "✶ Musing…"]) {
    assert.equal(readPane(withSpinner(line)).working, false, line);
  }
  // A tool still running, its status indented under it, with no live spinner.
  for (const status of ["  ⎿  Running…", "  ⎿  Waiting…"]) {
    const rows = withSpinner("\x1b[38;5;246m●\x1b[39m Bash(pnpm test)");
    const at = rows.indexOf("\x1b[38;5;246m●\x1b[39m Bash(pnpm test)");
    assert.equal(readPane([...rows.slice(0, at + 1), status, ...rows.slice(at + 1)]).working, false, status);
  }
});

test("a list item with a \"…\" in it stays in the preview", () => {
  const rows = [...FOREMAN_ABOVE, "* item with … in it", "", RULE, "❯ ", RULE, "  ⏸ manual mode on · ? for shortcuts"];
  assert.deepEqual(readPane(rows).tail, ["● Done: the brief is planned. PRs: none. Blocked: nothing.", "* item with … in it"]);
  // While the live "*" spinner is kept out of it.
  const live = [...FOREMAN_ABOVE, "* Musing… (15s · ↓ 584 tokens)", "", RULE, "❯ ", RULE, "  ⏸ manual mode on · ? for shortcuts"];
  assert.deepEqual(readPane(live).tail, ["● Done: the brief is planned. PRs: none. Blocked: nothing."]);
});

test("a paste or an image in the box is text, even drawn dim", () => {
  assert.equal(inputBox(boxed(`❯ ${ESC}[2m[Pasted text #1 +12 lines]${ESC}[0m`)), "text");
  assert.equal(inputBox(boxed(`❯ ${ESC}[2m[Image #2]${ESC}[0m`)), "text");
  assert.equal(inputBox(boxed("❯ [Pasted text #3]")), "text");
  assert.equal(inputBox(boxed(`❯ ${ESC}[7mT${ESC}[0;2mry "summarise [the] brief"${ESC}[0m`)), "empty", "brackets alone are not a paste");
});
