import { test } from "node:test";
import assert from "node:assert/strict";

import { checkDraft, type SteViolation } from "./check.ts";
import { buildDictionary, type DictionaryEntry } from "./dictionary.ts";
import { reportToMarkdown } from "./markdown.ts";
import { parseDeepMarker, stripDeepMarkers } from "./marker.ts";
import { parseDraft, revisionPrompt } from "./prompt.ts";
import type { SteDraft } from "./report.ts";
import { splitSentences, wordCount } from "./text.ts";

// A tiny dictionary written for these tests. It has the shape of the real
// one, not its content.
const FIXTURE: DictionaryEntry[] = [
  ...["a", "the"].map((word) => ({ word, pos: "article" as const, approved: true })),
  ...["it", "you", "this"].map((word) => ({ word, pos: "pronoun" as const, approved: true })),
  ...["after", "before", "in", "on", "to", "of", "for"].map((word) => ({ word, pos: "preposition" as const, approved: true })),
  ...["and", "when", "if", "then"].map((word) => ({ word, pos: "conjunction" as const, approved: true })),
  ...["agent", "state", "file", "path", "service", "phone", "connection", "door", "step", "morning"].map((word) => ({
    word,
    pos: "noun" as const,
    approved: true,
  })),
  { word: "closed", pos: "adjective", approved: true },
  { word: "during", pos: "preposition", approved: true },
  { word: "is", pos: "verb", approved: true, forms: [] },
  { word: "restart", pos: "verb", approved: true, forms: ["restarts", "restarted"] },
  { word: "connect", pos: "verb", approved: true, forms: ["connects", "connected"] },
  { word: "open", pos: "verb", approved: true, forms: ["opens", "opened"] },
  { word: "turn", pos: "verb", approved: true, forms: ["turns"] },
  { word: "make sure", pos: "verb", approved: true },
  { word: "ensure", pos: "verb", approved: false, use: ["make sure"] },
  { word: "prior to", pos: "preposition", approved: false, use: ["before"] },
  { word: "utilize", pos: "verb", approved: false, use: ["use"] },
];
const dictionary = buildDictionary(FIXTURE);

function draft(parts: Partial<SteDraft>): SteDraft {
  return {
    title: "Test",
    summary: ["This is a test."],
    description: [],
    procedure: [],
    diagrams: [],
    sources: [],
    technicalNames: [],
    technicalVerbs: [],
    ...parts,
  };
}

const checks = (vs: SteViolation[]) => vs.map((v) => v.check);

test("a code span, a quoted label and a number each count as one word; citations do not count", () => {
  assert.equal(wordCount("Type this command: `sudo loginctl enable-linger $USER` [1]"), 4);
  assert.equal(wordCount('Add 2 steps: "Set out clothes" and "Put phone on charger".'), 6);
  assert.equal(wordCount("It starts at 21:00 on cobra-agent.service."), 6);
});

test("sentences split at full stops, but never inside code or a quoted label", () => {
  assert.deepEqual(splitSentences("No output shows. This is correct."), ["No output shows.", "This is correct."]);
  assert.deepEqual(splitSentences("Open `a. b` now. Then stop."), ["Open `a. b` now.", "Then stop."]);
  assert.deepEqual(splitSentences('Tap "Done. Next" to go on.'), ['Tap "Done. Next" to go on.']);
});

test("procedure steps stop at 20 words and descriptive sentences at 25", () => {
  const long20 = `Open ${Array.from({ length: 20 }, () => "it").join(" ")}.`;
  const long25 = `It ${Array.from({ length: 25 }, () => "is").join(" ")}.`;
  const result = checkDraft(draft({ summary: [long25], procedure: [{ text: long20 }] }));
  assert.deepEqual(checks(result.violations).sort(), ["D1", "P1"]);
  assert.equal(result.dictionary, false);
});

test("-ing forms are flagged, but not -ing words that are not verbs or are technical names", () => {
  const result = checkDraft(
    draft({
      summary: ["The agent is starting during the morning.", "With lingering on, it starts at boot."],
      technicalNames: ["lingering"],
    }),
  );
  assert.deepEqual(
    result.violations.map((v) => [v.check, v.word, v.heuristic]),
    [["V2", "starting", true]],
  );
  // With a dictionary the answer is exact: "starting" is no entry's approved form.
  const exact = checkDraft(draft({ summary: ["The agent is starting during the morning."] }), { dictionary });
  assert.deepEqual(
    exact.violations.filter((v) => v.check === "V2").map((v) => [v.word, v.heuristic]),
    [["starting", false]],
  );
});

test("passive voice is a heuristic flag, and an approved adjective is not passive", () => {
  const plain = checkDraft(draft({ summary: ["The service is restarted by the agent."] }));
  assert.deepEqual(checks(plain.violations), ["V3"]);
  assert.equal(plain.violations[0]?.heuristic, true);
  const adjective = checkDraft(draft({ summary: ["The door is closed."] }), { dictionary });
  assert.deepEqual(checks(adjective.violations), []);
});

test("a step must start with a command, after an optional condition or Do not", () => {
  const result = checkDraft(
    draft({
      procedure: [
        { text: "You open the file." },
        { text: "Before you log in, open Fleet." },
        { text: "Do not restart the agent." },
        { text: "Type this command: `ls`" },
      ],
    }),
  );
  assert.deepEqual(
    result.violations.map((v) => [v.check, v.where]),
    [["P3", "procedure[0].text"]],
  );
});

test("one instruction per step", () => {
  const result = checkDraft(
    draft({
      procedure: [
        { text: "Open Settings and tap Computers." },
        { text: 'Add 2 steps: "Set out clothes" and "Put phone on charger".' },
        { text: "Restart the service. Then open the file." },
      ],
      technicalVerbs: ["tap"],
    }),
  );
  assert.deepEqual(
    result.violations.map((v) => [v.check, v.where]),
    [
      ["P2", "procedure[0].text"],
      ["P2", "procedure[2].text"],
    ],
  );
});

test("a CAUTION starts with a command; a paragraph has no more than 6 sentences", () => {
  const result = checkDraft(
    draft({
      summary: Array.from({ length: 7 }, () => "It is."),
      procedure: [
        { text: "Restart the agent.", before: [{ kind: "CAUTION", sentences: ["The session stops.", "Save your work."] }] },
      ],
    }),
  );
  assert.deepEqual(checks(result.violations).sort(), ["D2", "X1"]);
});

test("with the dictionary: unapproved words and phrases, unknown words, and verb forms", () => {
  const result = checkDraft(
    draft({
      summary: ["Ensure the agent is closed prior to the restart."],
      procedure: [{ text: "Make sure the phone turned the frobulator." }],
    }),
    { dictionary },
  );
  const found = result.violations.map((v) => [v.check, v.word, v.use?.join("/")]);
  assert.deepEqual(found, [
    ["W1", "Ensure", "make sure"],
    ["W1", "prior to", "before"],
    ["V1", "turned", undefined],
    ["W1", "frobulator", undefined],
  ]);
  assert.equal(result.dictionary, true);
});

test("technical names pass the dictionary, but an unapproved word cannot be declared one", () => {
  const result = checkDraft(
    draft({ summary: ["The phone connects to the agent in systemd."], technicalNames: ["systemd", "utilize"] }),
    { dictionary },
  );
  assert.deepEqual(
    result.violations.map((v) => [v.check, v.where, v.word]),
    [["W1", "technicalNames", "utilize"]],
  );
});

test("noun clusters of more than 3 words", () => {
  const result = checkDraft(draft({ summary: ["Open the agent state file path."] }), { dictionary });
  assert.deepEqual(
    result.violations.map((v) => [v.check, v.word]),
    [["N1", "agent state file path"]],
  );
});

test("the deep marker parses and always strips", () => {
  const reply = "Short answer.\n[Deep: It has a failure path | diagrams=2]";
  assert.deepEqual(parseDeepMarker(reply), { reason: "It has a failure path", diagrams: 2 });
  assert.equal(stripDeepMarkers(reply), "Short answer.");
  assert.deepEqual(parseDeepMarker("[deep: Needs a search]"), { reason: "Needs a search", diagrams: 0 });
  assert.equal(parseDeepMarker("No marker here."), null);
});

test("a draft parses from a fenced reply, and a bad one says why", () => {
  const body = JSON.stringify(draft({}));
  const ok = parseDraft(`Here it is:\n\`\`\`json\n${body}\n\`\`\``);
  assert.equal(ok.ok, true);
  const bad = parseDraft('{"title": "x"}');
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.error, /summary/);
  assert.equal(parseDraft("no json").ok, false);
});

test("the revision prompt lists each violation with its fix and the draft", () => {
  const d = draft({ summary: ["Ensure the phone is ready."] });
  const { violations } = checkDraft(d, { dictionary });
  const prompt = revisionPrompt(d, violations);
  assert.match(prompt, /summary\[0\] \[W1\]: "Ensure" is not approved\. Use: make sure\./);
  assert.ok(prompt.endsWith(JSON.stringify(d)));
});

test("markdown puts a CAUTION before its step and diagrams in mermaid fences", () => {
  const md = reportToMarkdown(
    draft({
      procedure: [{ text: "Restart the agent.", result: "It shows online.", before: [{ kind: "CAUTION", sentences: ["Save your work."] }] }],
      diagrams: [{ kind: "flowchart", caption: "Boot", mermaid: "flowchart TD\n  A --> B" }],
      sources: [{ title: "loginctl(1)", url: "https://www.freedesktop.org/software/systemd/man/latest/loginctl.html" }],
    }),
    { violations: [], sentences: 3, dictionary: false },
  );
  assert.ok(md.indexOf("> **CAUTION:** Save your work.") < md.indexOf("1. Restart the agent."));
  assert.match(md, /```mermaid\nflowchart TD\n {2}A --> B\n```/);
  assert.match(md, /STE check: no violations, dictionary not loaded\./);
});
