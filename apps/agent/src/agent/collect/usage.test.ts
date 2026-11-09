import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectUsage, newestAt, planLabel, readAccounts, readClaudeTier, toAgentUsage } from "./usage.ts";

/** A capture of the real record, trimmed — never hand-tuned to pass. */
const CLAUDE_RECORD = {
  schemaVersion: 1,
  id: "claude",
  name: "Claude Code",
  updatedAt: "2026-09-21T11:56:21.790766+00:00",
  ready: true,
  tierLabel: "Pro",
  usageStatusText: "",
  authHelpText: "Run `claude auth login`.",
  limits: [
    { label: "Session (5-hour)", percent: 0.58, resetsAt: "2026-09-21T12:30:00.680072+00:00" },
    { label: "Weekly (7-day)", percent: 0.55, resetsAt: "2026-09-25T15:00:00.680097+00:00" },
    { label: "Weekly", title: "Fable Weekly", percent: 0.61, resetsAt: "2026-09-25T14:59:59.680335+00:00" },
  ],
  todayPrompts: 22,
  todaySessions: 1,
  todayTotalTokens: 1234,
  recentDays: [
    { date: "2026-09-19", messageCount: 48099087 },
    { date: "2026-09-20", messageCount: 13787163 },
  ],
  totalPrompts: 368,
  totalSessions: 8,
  activeDays: 2,
  activeDates: ["2026-09-19", "2026-09-20"],
  modelUsage: {
    "claude-opus-5": {
      inputTokens: 402,
      outputTokens: 210761,
      cacheReadInputTokens: 39514899,
      cacheCreationInputTokens: 659497,
    },
  },
};

test("plan label prefers the scaled Max tier", () => {
  assert.equal(planLabel("default_claude_max_5x", "claude_max"), "Max 5x");
  assert.equal(planLabel("default_claude_max_20x", ""), "Max 20x");
});

test("plan label falls back to the organisation type when the tier is generic", () => {
  // Exactly the MacBook's case: a Max account whose credentials file says
  // `default_claude_ai`, with ~/.claude.json carrying the truth.
  assert.equal(planLabel("default_claude_ai", "claude_max"), "Max");
  assert.equal(planLabel("", "claude_pro"), "Pro");
  assert.equal(planLabel("", ""), "");
});

test("a record maps onto the contract, renaming messageCount to tokens", () => {
  const agent = toAgentUsage(CLAUDE_RECORD);
  assert.ok(agent);
  assert.equal(agent.id, "claude");
  assert.equal(agent.name, "Claude Code");
  assert.deepEqual(agent.recentDays, [
    { date: "2026-09-19", tokens: 48099087 },
    { date: "2026-09-20", tokens: 13787163 },
  ]);
  assert.equal(agent.totalPrompts, 368);
  assert.equal(agent.modelUsage["claude-opus-5"]?.outputTokens, 210761);
});

test("a scoped limit travels under its settled title, not its label", () => {
  const agent = toAgentUsage(CLAUDE_RECORD);
  assert.ok(agent);
  assert.deepEqual(
    agent.limits.map((limit) => limit.label),
    ["Session (5-hour)", "Weekly (7-day)", "Fable Weekly"],
  );
});

test("authOk is the collector reporting no problem, which is when limits are live", () => {
  const live = toAgentUsage(CLAUDE_RECORD);
  const expired = toAgentUsage({ ...CLAUDE_RECORD, usageStatusText: "Sign-in expired" });
  assert.equal(live?.authOk, true);
  assert.equal(expired?.authOk, false);
  // The expired record still carries its last known limits.
  assert.equal(expired?.limits.length, 3);
});

test("unusable records are dropped rather than half-parsed", () => {
  assert.equal(toAgentUsage(null), null);
  assert.equal(toAgentUsage("claude"), null);
  assert.equal(toAgentUsage({ name: "no id" }), null);
});

test("a limit with no readable percent is dropped, not shown as zero", () => {
  const agent = toAgentUsage({
    ...CLAUDE_RECORD,
    limits: [{ label: "Weekly", percent: -1 }, { label: "", percent: 0.5 }, { label: "Session", percent: 0.2 }],
  });
  assert.deepEqual(agent?.limits, [{ label: "Session", percent: 0.2, resetsAt: "" }]);
});

test("newestAt ignores records with no usable timestamp", () => {
  assert.equal(newestAt([]), 0);
  const agents = [
    toAgentUsage({ ...CLAUDE_RECORD, id: "a", updatedAt: "nonsense" })!,
    toAgentUsage({ ...CLAUDE_RECORD, id: "b", updatedAt: "2026-09-21T11:00:00Z" })!,
  ];
  assert.equal(newestAt(agents), Date.parse("2026-09-21T11:00:00Z"));
});

async function fixture(records: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cp-usage-"));
  for (const [name, body] of Object.entries(records)) {
    await writeFile(join(dir, `${name}.json`), JSON.stringify(body));
  }
  return dir;
}

test("fresh records are served without spawning the collector", async () => {
  const dir = await fixture({ claude: CLAUDE_RECORD });
  let updates = 0;
  const snapshot = await collectUsage({
    dir,
    home: dir,
    now: () => Date.parse("2026-09-21T11:58:00Z"),
    update: async () => {
      updates += 1;
    },
  });
  assert.equal(updates, 0);
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.agents.length, 1);
});

test("stale records regenerate once, then are re-read", async () => {
  const dir = await fixture({ claude: { ...CLAUDE_RECORD, updatedAt: "2026-09-21T09:00:00Z" } });
  let updates = 0;
  const snapshot = await collectUsage({
    dir,
    home: dir,
    now: () => Date.parse("2026-09-21T11:58:00Z"),
    update: async () => {
      updates += 1;
      await writeFile(join(dir, "claude.json"), JSON.stringify({ ...CLAUDE_RECORD, totalPrompts: 999 }));
    },
  });
  assert.equal(updates, 1);
  assert.equal(snapshot.agents[0]?.totalPrompts, 999);
});

test("a machine with no collector reports unavailable rather than failing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cp-usage-empty-"));
  const snapshot = await collectUsage({
    dir: join(dir, "absent"),
    home: dir,
    now: () => Date.parse("2026-09-21T11:58:00Z"),
    update: async () => {},
  });
  assert.equal(snapshot.available, false);
  assert.deepEqual(snapshot.agents, []);
});

test("the account tier overrides a stale per-machine credentials label", async () => {
  const dir = await fixture({ claude: CLAUDE_RECORD });
  await writeFile(
    join(dir, ".claude.json"),
    JSON.stringify({
      oauthAccount: { organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_5x" },
    }),
  );
  const snapshot = await collectUsage({
    dir,
    home: dir,
    now: () => Date.parse("2026-09-21T11:58:00Z"),
    update: async () => {},
  });
  // The record says "Pro"; the account says Max 5x, and one account is one tier.
  assert.equal(snapshot.agents[0]?.tierLabel, "Max 5x");
});

test("with no profile on disk the collector's own label stands", async () => {
  const dir = await fixture({ claude: CLAUDE_RECORD });
  assert.equal(await readClaudeTier(dir), "");
  const snapshot = await collectUsage({
    dir,
    home: dir,
    now: () => Date.parse("2026-09-21T11:58:00Z"),
    update: async () => {},
  });
  assert.equal(snapshot.agents[0]?.tierLabel, "Pro");
});

test("only claude takes the account tier; other collectors keep theirs", async () => {
  const dir = await fixture({
    claude: CLAUDE_RECORD,
    fireworks: { id: "fireworks", name: "Fireworks", tierLabel: "Prepaid", scope: "account", usageStatusText: "" },
  });
  await writeFile(
    join(dir, ".claude.json"),
    JSON.stringify({ oauthAccount: { organizationRateLimitTier: "default_claude_max_5x" } }),
  );
  const snapshot = await collectUsage({
    dir,
    home: dir,
    now: () => Date.parse("2026-09-21T11:58:00Z"),
    update: async () => {},
  });
  const byId = Object.fromEntries(snapshot.agents.map((agent) => [agent.id, agent]));
  assert.equal(byId.claude?.tierLabel, "Max 5x");
  assert.equal(byId.fireworks?.tierLabel, "Prepaid");
  assert.equal(byId.fireworks?.scope, "account");
});

test("each subscription's account is read from its own sign-in on disk, and none is made up", async () => {
  const home = mkdtempSync(join(tmpdir(), "usage-accounts-"));
  try {
    assert.deepEqual(await readAccounts(home), {});
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com", organizationName: "x" } }));
    mkdirSync(join(home, ".codex"));
    const claims = Buffer.from(JSON.stringify({ email: "me@openai.example", name: "Me" })).toString("base64url");
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: `h.${claims}.s` } }));
    assert.deepEqual(await readAccounts(home), { claude: "me@example.com", codex: "me@openai.example" });
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-secret" }));
    assert.deepEqual((await readAccounts(home)).codex, "API key");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
