// The V4 gate on a computer: a real voice front
// (claude -p on Haiku, cobra-voice's tools, this computer's real status)
// answering a few spoken turns, timed from the turn to its first part.
//
//   node apps/agent/scripts/voice-spike/front.mts            # the subscription
//   LANE=key node apps/agent/scripts/voice-spike/front.mts   # the API key in ~/.config/cobra-agent
//
// Nothing reaches Cobra: the thread is kept in memory and hand_to_cobra
// only prints what it would have sent.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const { collectProjects, DEFAULT_CONFIG_PATH } = await import("../../src/agent/collect/projects.ts");
const { createThreadStore } = await import("../../src/agent/thread.ts");
const { createVoiceCalls } = await import("../../src/agent/voiceFront.ts");
const { liveVoiceDeps, spawnVoiceFront } = await import("../../src/agent/voiceLive.ts");

const key = process.env.LANE === "key";
const real = createThreadStore();
const kept: unknown[] = [];
const sent: string[] = [];
const log = (line: string) => console.log(`  [log] ${line}`);
const deps = liveVoiceDeps({
  projects: async () => (await collectProjects(process.env.COBRA_PROJECTS ?? DEFAULT_CONFIG_PATH, { git: false })).projects,
  leadWorking: async () => false,
  recent: (limit) => real.page({ limit }).entries,
  thread: { append: (entries) => void kept.push(...entries), conversation: () => "spike" },
  handOff: async (text) => void sent.push(text),
  log,
});
if (key) {
  const apiKey = readFileSync(join(homedir(), ".config/cobra-agent/anthropic-api-key"), "utf8").trim();
  deps.spawn = (call, tools, onLine, onExit) => spawnVoiceFront(call, { env: { ANTHROPIC_API_KEY: apiKey, CLAUDE_CODE_OAUTH_TOKEN: "" }, lane: "key" }, tools, onLine, onExit, log);
}

const TURNS = (process.env.TURNS ?? "What's waiting on me?|Anything done today?|What Spaces do I have?|Add a gluten-free section to the menu page.|Okay, thanks. Goodbye.").split("|");

const calls = createVoiceCalls(deps);
let at = performance.now();
const start = await calls.start();
console.log(`call ${start.call} on the ${key ? "API key" : "subscription"}, warm in ${((performance.now() - at) / 1000).toFixed(2)} s (ends ${start.endsAt ?? "at the lane's cap"})`);
// Let the warm-up's reply finish, as the person's first words would take a moment.
await new Promise((resolve) => setTimeout(resolve, Number(process.env.WARM_MS ?? 4000)));

const firsts: number[] = [];
for (const words of TURNS) {
  at = performance.now();
  let reply = await calls.turn(start.call, words);
  const first = (performance.now() - at) / 1000;
  firsts.push(first);
  const parts = [...reply.parts];
  while (!reply.done) {
    reply = await calls.next(start.call, reply.turn, parts.length);
    parts.push(...reply.parts);
  }
  const whole = (performance.now() - at) / 1000;
  console.log(`\n> ${words}\n  first part ${first.toFixed(2)} s, whole ${whole.toFixed(2)} s${reply.handedOff ? `, handed off ${reply.handedOff}` : ""}${reply.ended ? `, ended ${reply.ended}` : ""}`);
  for (const part of parts) console.log(`  · ${part}`);
  if (reply.ended) break;
}
const sorted = [...firsts].sort((a, b) => a - b);
console.log(`\nfirst part: median ${sorted[Math.floor(sorted.length / 2)]!.toFixed(2)} s over ${firsts.length} turns`);
console.log(`hand_to_cobra would have sent: ${JSON.stringify(sent)}`);
console.log(`thread entries kept: ${kept.length}`);
calls.end(start.call);
process.exit(0);
