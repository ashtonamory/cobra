// Voice front timing spike (phase V0): one warm
// headless Haiku process (`claude -p`, stream-json in and out, partial messages
// on), as the voice front will run for a call, and 20 short spoken turns. For
// each turn it records the time to the first text, to the end of the first
// sentence (when the phone can start to speak) and to the end of the reply.
//
//   node apps/agent/scripts/voice-spike/spike.mts                 on this computer's sign-in
//   LANE=key node apps/agent/scripts/voice-spike/spike.mts        on the API key (Cobra's key file)
//   TURNS=5 node …                                                 fewer turns
//
// Context (what waits, what runs) goes into each turn's message, as the voice
// front will pass it, so a status question needs no tool round trip. Runs in a
// throwaway folder with every hook off, so nothing reaches Cobra's records.
// Costs well under a cent a run on the key.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const { SPOKEN, VOICE } = await import("../../src/agent/voice.ts");

const LANE = process.env.LANE === "key" ? "key" : "subscription";
const TURNS = Math.max(1, Math.min(20, Number(process.env.TURNS ?? 20)));

const SYSTEM = `You are Cobra, the person's business partner, on a voice call. A lighter, faster version of Cobra: you answer quick questions yourself from the context given with each message, and anything that changes something or needs real work you hand to the full Cobra with hand_to_cobra (in this test, just say you'll hand it over).
Every message from the person starts with [voice].

${VOICE}

${SPOKEN}`;

const CONTEXT = `<context>
Now: Monday 3:12 PM.
Waiting on the person: 1) Publish the new menu page? (Bakery website) 2) Send the invoice email to Maria Lopez for $240? (Billing)
Working now: the refund page for the Bakery website; the weekly Instagram posts (Designer).
Done today: morning routine found 3 new leads (Prospecting); invoice #1042 paid ($180).
Spaces: Bakery (website, billing, social), Run Club (members, dues).
</context>`;

const QUESTIONS = [
  "What's waiting on me?",
  "Anything done today?",
  "Who paid us today?",
  "What are you working on right now?",
  "Read me the first thing waiting.",
  "How many new leads did we get?",
  "Is the refund page done yet?",
  "What's the invoice to Maria for?",
  "Add a gluten-free section to the menu page.",
  "What Spaces do I have?",
  "Is anything wrong?",
  "What time is it?",
  "Make me a flyer for Saturday's sale.",
  "Thanks, that's all for the bakery.",
  "How's Run Club doing?",
  "Remind me what the Instagram posts are about.",
  "Change the deposit to fifty dollars.",
  "Should I publish the menu page?",
  "What did the morning routine do?",
  "Okay, goodbye.",
];

const args = [
  "-p",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--model", "haiku",
  "--system-prompt", SYSTEM,
  "--tools", "",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--settings", JSON.stringify({ disableAllHooks: true }),
];
const env: NodeJS.ProcessEnv = { ...process.env };
if (LANE === "key") {
  env.ANTHROPIC_API_KEY = readFileSync(join(homedir(), ".config/cobra-agent/anthropic-api-key"), "utf8").trim();
  args.push("--bare");
} else {
  delete env.ANTHROPIC_API_KEY;
}

const cwd = mkdtempSync(join(tmpdir(), "cobra-voice-spike-"));
const started = Date.now();
const child = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "inherit"] });

type Turn = { question: string; firstText: number; firstSentence: number; done: number; reply: string; inTokens: number; cached: number };
const turns: Turn[] = [];
let current: { question: string; t0: number; text: string; firstText?: number; firstSentence?: number } | null = null;
let ready: () => void = () => {};
let buffer = "";

child.stdout.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let newline: number;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!current) continue;
    const now = performance.now();
    if (event.type === "stream_event" && event.event?.type === "content_block_delta" && event.event.delta?.type === "text_delta") {
      current.text += event.event.delta.text;
      current.firstText ??= now - current.t0;
      if (current.firstSentence === undefined && /[.!?](\s|$)/.test(current.text)) current.firstSentence = now - current.t0;
    }
    if (event.type === "result") {
      const usage = event.usage ?? {};
      turns.push({
        question: current.question,
        firstText: current.firstText ?? NaN,
        firstSentence: current.firstSentence ?? now - current.t0,
        done: now - current.t0,
        reply: current.text.trim(),
        inTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        cached: usage.cache_read_input_tokens ?? 0,
      });
      current = null;
      ready();
    }
  }
});

function ask(question: string): Promise<void> {
  return new Promise((resolve) => {
    ready = resolve;
    current = { question, t0: performance.now(), text: "" };
    const content = `[voice] ${question}\n\n${CONTEXT}`;
    child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`);
  });
}

console.log(`lane: ${LANE}, ${TURNS} turns, claude started in ${cwd}`);
for (const question of QUESTIONS.slice(0, TURNS)) {
  await ask(question);
  const turn = turns.at(-1)!;
  console.log(`${(turn.firstSentence / 1000).toFixed(2)} s  ${question}  →  ${turn.reply.replace(/\s+/g, " ").slice(0, 110)}`);
}
child.stdin.end();

const sorted = (key: keyof Turn) => turns.map((turn) => turn[key] as number).filter(Number.isFinite).sort((a, b) => a - b);
const pick = (values: number[], q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))]!;
const line = (label: string, key: keyof Turn) => {
  const values = sorted(key);
  console.log(`${label.padEnd(16)} median ${(pick(values, 0.5) / 1000).toFixed(2)} s   p90 ${(pick(values, 0.9) / 1000).toFixed(2)} s   first ${(values[0]! / 1000).toFixed(2)} s`);
};
console.log(`\nstart to first turn sent: ${((Date.now() - started) / 1000).toFixed(1)} s total run`);
line("first text", "firstText");
line("first sentence", "firstSentence");
line("whole reply", "done");
const warm = turns.slice(1);
console.log(`prompt ~${Math.round(turns.reduce((sum, turn) => sum + turn.inTokens, 0) / turns.length)} tokens a turn, ${warm.filter((turn) => turn.cached > 0).length}/${warm.length} later turns read the cache`);
