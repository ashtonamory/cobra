import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "cobra-voice-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { OWNER_JARGON, PLAIN_WORDS, SPOKEN, VOICE, ownerJargon } = await import("./voice.ts");
const { speakable } = await import("../../../../packages/contracts/src/voiceCall.ts");
const { EXPLAIN_SYSTEM, RUN_PLAIN, whyOf } = await import("./permissionRequest.ts");
const approvals = await import("./approvals.ts");
const morning = await import("./morning.ts");
const chats = await import("./chats.ts");
const lead = await import("./lead.ts");
const foreman = await import("./foreman.ts");

/** docs/voice.md's examples: each heading with its New line. */
function examples(): Array<{ heading: string; text: string }> {
  const doc = readFileSync(join(import.meta.dirname, "../../../../docs/voice.md"), "utf8");
  return doc
    .split(/^### /m)
    .slice(1)
    .map((block) => ({ heading: block.split("\n")[0]!, text: /^New: (.+)$/m.exec(block)?.[1] ?? "" }));
}

test("ownerJargon names the software words in a text, and passes plain words", () => {
  assert.deepEqual(ownerJargon("Merged PR #12 from feat/menu into main; CI green."), ["PR", "Merged", "CI"]);
  assert.deepEqual(ownerJargon("The Foreman asked a Worker to push the branch."), ["branch", "Foreman", "Worker"]);
  assert.deepEqual(ownerJargon("Your booking page is live. Customers can pay the deposit."), []);
  // A word that only starts like one is not one: "report" is not "repo".
  assert.deepEqual(ownerJargon("Here is the report on prices and the deployment plan."), ["deployment"]);
  assert.ok(OWNER_JARGON.length >= 10);
});

test("docs/voice.md holds 15 reference examples, and every New line is plain", () => {
  const all = examples();
  assert.equal(all.length, 15);
  for (const { heading, text } of all) {
    assert.ok(text, `example "${heading}" has a New line`);
    // A V6 example answers the technical question the person asked.
    if (/\(V6\)/.test(heading)) continue;
    assert.deepEqual(ownerJargon(text), [], `example "${heading}"`);
  }
});

test("the voice carries the rules the plan names, with the word list in it", () => {
  for (const rule of [/business partner/, /two to four short sentences/, /one thing you need from them/, /Never a link to a pull request/, /Never paste error text/, /mark your pick with one reason/, /at most one per reply/, /go deeper for that conversation/, /Never name a Foreman, a Worker/]) {
    assert.match(VOICE, rule);
  }
  assert.ok(VOICE.includes(PLAIN_WORDS));
  for (const word of [/"publish" or "put live", not merge/, /not pull request, PR or commit/, /your web address \(the domain\)/]) assert.match(PLAIN_WORDS, word);
});

test("the card explainer keeps its own rules and takes the shared word list", () => {
  assert.ok(EXPLAIN_SYSTEM.includes(PLAIN_WORDS));
  assert.match(EXPLAIN_SYSTEM, /No jargon/);
  assert.match(EXPLAIN_SYSTEM, /starting with "Cobra wants to"/);
});

test("Cobra's prompt talks in the voice and reports results, never PR links", () => {
  for (const engine of ["claude", "codex"] as const) {
    const prompt = lead.leadPrompt([], false, engine);
    assert.ok(prompt.includes(VOICE), engine);
    assert.ok(prompt.includes(SPOKEN), `${engine}: spoken rules for [voice] messages`);
    assert.doesNotMatch(prompt, /the PR links/);
    assert.match(prompt, /never a PR link/);
    assert.match(prompt, /from the report's Owner line/);
  }
});

test("a Foreman's report ends with an Owner line, and its questions are written for the person", () => {
  const prompt = foreman.foremanPrompt({ id: "bakery-site", name: "Bakery site", path: "/home/u/Spaces/bakery/website" });
  assert.match(prompt, /Owner: one plain sentence on what changed for the person's business/);
  assert.match(prompt, /never a PR\), or "nothing yet"/);
  assert.match(prompt, /reaches the person only if she cannot answer it, so write it for them/);
});

test("the cards say what goes live, in the person's words", () => {
  const pr = { number: 24, title: "feat(site): booking page with deposits", repo: "o/imagine-yoga", head: "abc", url: "u" };
  const land = { worker: "w", project: "studio", branch: "feat/a", title: "t", head: "a1b2c3d4", base: "b", commits: 3, files: 4, insertions: 120, deletions: 8 };
  for (const text of [
    approvals.mergeText([pr]),
    approvals.mergeText([pr, { ...pr, number: 25 }], "the new booking page"),
    approvals.landText([], [land]),
    approvals.landText([pr], [land], "the booking page"),
    approvals.publishedText([pr], 1),
    approvals.publishedText([pr, pr], 1),
  ]) {
    assert.deepEqual(ownerJargon(`${text.title}\n${text.body}`), [], `${text.title} / ${text.body}`);
    assert.doesNotMatch(`${text.title}\n${text.body}`, /#\d/, "no PR number");
  }
  assert.deepEqual(ownerJargon(RUN_PLAIN), []);
  for (const rule of ["merge-deploy-publish", "install", "network", "outside-worktree", "local-model:network", "local-model:mcp"]) {
    assert.deepEqual(ownerJargon(whyOf("ask", rule, "")), [], rule);
  }
});

test("the morning brief and the chat speak in the voice", () => {
  assert.match(morning.MORNING_SYSTEM, new RegExp(PLAIN_WORDS.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(morning.MORNING_SYSTEM, /Foremen/);
  const brief = morning.plainBrief([
    { computer: "legion", day: "2026-10-23", landed: [{ project: "payroll", report: "sent" }], counts: { merged: 2, actions: 1, routines: 0 }, today: [], waiting: [] },
  ]);
  assert.deepEqual(ownerJargon(brief), [], brief);
  assert.ok(chats.SYSTEM_PROMPT.includes(VOICE));
  assert.deepEqual(ownerJargon(chats.SYSTEM_PROMPT.replace(VOICE, "")), [], "the chat names no crew or software words outside the voice's own rule");
});

test("Cobra's and a Foreman's tmux start fit tmux's limit, with the prompt read from a private file", () => {
  const written = new Map<string, string>();
  const write = (path: string, text: string) => void written.set(path, text);
  const project = { id: "cobra", name: "Cobra", machine: "legion", path: "/p/cobra", session: "cobra" } as never;
  const full = lead.leadCommand(undefined, lead.leadTools(true));
  for (const [command, file] of [
    [full, "/l/system-prompt.md"],
    [foreman.foremanCommand(project), "/f/system-prompt.md"],
  ] as const) {
    const started = lead.promptViaFile(command, file, write);
    assert.ok(!started.includes("--append-system-prompt"), "the prompt is not on the command line");
    assert.equal(started[started.indexOf("--append-system-prompt-file") + 1], file);
    assert.equal(written.get(file), command[command.indexOf("--append-system-prompt") + 1], "the file holds the prompt word for word");
    assert.ok(started.join(" ").length < lead.TMUX_COMMAND_LIMIT / 4, "room to spare under tmux's limit for the environment");
  }
  assert.ok(full.join(" ").length > lead.TMUX_COMMAND_LIMIT / 2, "the prompt alone is why: on the command line it nears the limit");
  assert.deepEqual(lead.promptViaFile(["codex", "--sandbox", "read-only"], "/x", write), ["codex", "--sandbox", "read-only"]);
});

/**
 * Ten spoken replies as SPOKEN wants them (Talk and Call):
 * each reads whole through speakable(), with nothing cut, and names no software word.
 */
const SPOKEN_REFERENCE = [
  "Your booking page is live. Customers can now pay the twenty-five dollar deposit when they book.",
  "Two things wait on you: the new menu page and an invoice email. Want me to read the first one?",
  "I'm adding the refund page now. I'll tell you when it's ready.",
  "Nothing waits on you right now. Your morning routine ran at eight and found three new leads.",
  "The website check found a broken photo on the about page. I'm fixing it, and the rest of the site is fine.",
  "Your invoice to Maria went out at two this afternoon. She hasn't paid yet.",
  "Do you want the deposit at twenty-five or fifty dollars? I'd pick twenty-five, so fewer people walk away.",
  "The new prices are on your screen. Say yes and I'll open the card to publish them.",
  "That card is waiting for when you've stopped the car. I'll keep it for you.",
  "Your Instagram posts for next week are ready to look at. They're on your screen.",
];

test("SPOKEN keeps a spoken reply short, plain and fit to hear", () => {
  for (const rule of [/starts with \[voice\]/, /One or two short sentences/, /No links, lists, tables, code/, /it is on your screen/, /at most one question/]) assert.match(SPOKEN, rule);
  assert.deepEqual(ownerJargon(SPOKEN), []);
  assert.equal(SPOKEN_REFERENCE.length, 10);
  for (const reply of SPOKEN_REFERENCE) {
    assert.deepEqual(ownerJargon(reply), [], reply);
    assert.deepEqual(speakable(reply), { say: reply, more: false }, reply);
  }
});
