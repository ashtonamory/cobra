import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "cobra-migrate-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");

const memory = await import("./memory.ts");
const migrate = await import("./memoryMigrate.ts");

const NOW = new Date(2026, 9, 24, 15).getTime();
const KEYS = ["octo-org/cobra", "octo-org/plant-shop", "local/happy-tails", "octocat/corner-bakery"];

const DAILY = `# laptop · daily · 2026-10-23

The day was mostly Cobra's build-out.

### By project
**octo-org/cobra**
- Merged #367 and #368.

**local/happy-tails**
- Billing for Tony drafted.

**local/inbox-manager**
- Sorted 200 emails.

### Open threads
- Sam: merge #280.
`;

const WEEKLY = `# laptop · weekly · 2026-W42

A week.

### By project

**corner-bakery**
- Bayou Hollow maps.

**plant-shop / Telegram**
- Lab wired.

**Others**
- Small things.

### Carried over
- #280.
`;

test("an old note's By project block becomes one section per project, what names none under Fleet", () => {
  assert.equal(
    migrate.splitOldNote(DAILY, KEYS),
    `# laptop · daily · 2026-10-23

The day was mostly Cobra's build-out.

### Fleet
**local/inbox-manager**
- Sorted 200 emails.

### octo-org/cobra
- Merged #367 and #368.

### local/happy-tails
- Billing for Tony drafted.

### Open threads
- Sam: merge #280.
`,
  );
  const weekly = migrate.splitOldNote(WEEKLY, KEYS)!;
  assert.match(weekly, /### Fleet\n- Small things\.\n\n### octocat\/corner-bakery\n- Bayou Hollow maps\.\n\n### octo-org\/plant-shop\n- Lab wired\./);
  assert.equal(migrate.splitOldNote(migrate.splitOldNote(DAILY, KEYS)!, KEYS), null, "a split note is left alone");
  assert.equal(migrate.splitOldNote("# a note\n\n- with no block", KEYS), null);
});

test("a heading's key: itself, else the one key with that repository name, an octo-org/ one first", () => {
  assert.equal(migrate.keyFor("cobra", KEYS), "octo-org/cobra");
  assert.equal(migrate.keyFor("cobra", ["octocat/cobra", "octo-org/cobra"]), "octo-org/cobra");
  assert.equal(migrate.keyFor("game-on-design / Tessel", KEYS), null);
  assert.equal(migrate.keyFor("Local/Happy-Tails", KEYS), "local/happy-tails");
});

test("an hourly note is rebuilt from its own bullets under the projects the model named; the text is never rewritten", () => {
  const text = "# laptop · 13:00 – 14:00\n\n- Merged #381.\n  (commit 43b19b8)\n- Dale's invoice question.\n- Everyone idle.";
  const { head, items } = migrate.bullets(text);
  assert.equal(head, "# laptop · 13:00 – 14:00");
  assert.equal(items.length, 3);
  const tags = migrate.parseTags("H13.1 octo-org/cobra\nH13.2 local/happy-tails\nH13.3 Fleet\nH13.4 evil/key\nignore this", KEYS);
  assert.deepEqual([...tags], [["H13.1", "octo-org/cobra"], ["H13.2", "local/happy-tails"], ["H13.3", "Fleet"]]);
  assert.equal(
    migrate.sectionedHourly(head, items, new Map([[1, "octo-org/cobra"], [2, "local/happy-tails"]])),
    "# laptop · 13:00 – 14:00\n\n### Fleet\n- Everyone idle.\n\n### octo-org/cobra\n- Merged #381.\n  (commit 43b19b8)\n\n### local/happy-tails\n- Dale's invoice question.\n",
  );
});

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "cobra-migrate-root-"));
  const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  const w = (path: string, text: string) => memory.writeMemoryFile(dir, path, text);
  w(memory.memoryPaths.state("laptop", "octo-org/cobra"), "# octo-org/cobra\n\nGoal: memory");
  w(memory.memoryPaths.state("laptop", "local/happy-tails"), "# local/happy-tails\n\nGoal: billing");
  w(memory.memoryPaths.lessons("laptop", "local/happy-tails"), "# local/happy-tails · lessons\n\n## Active\n- 2026-10-20 · decision · Card payments use a Stripe Payment Link. (from: lead)\n- 2026-10-22 · decision · No Stripe Payment Link: cards go through Square. (from: lead)\n\n## Retired\n");
  w(memory.memoryPaths.daily("laptop", "2026-10-23"), DAILY.replace("local/inbox-manager", "Inbox"));
  w("computers/laptop/hourly/2026-10-24/13.md", "# laptop · 13:00\n\n- Merged #381.\n- Dale's invoice.");
  w("computers/laptop/hourly/2026-10-24/14.md", "# laptop · 14:00\n\n### Fleet\n- Already split.\n");
  w("computers/office/daily/2026-10-23.md", "# office");
  git("add", "-A");
  git("commit", "-q", "-m", "synced");
  git("remote", "add", "origin", "https://github.com/octo-org/cobra-memory.git");
  return { dir, git };
}

function deps(dir: string, done: string[] = []) {
  const asked: Array<{ model: string; input: string }> = [];
  return {
    asked,
    d: {
      dir,
      computer: "laptop",
      git: async (cwd: string, args: string[]) => {
        const out = spawnSync("git", args, { cwd, encoding: "utf8" });
        return { code: out.status ?? 1, stdout: out.stdout, stderr: out.stderr };
      },
      async ask(model: "haiku" | "sonnet", _system: string, input: string) {
        asked.push({ model, input });
        if (model === "haiku") return "H13.1 octo-org/cobra\nH13.2 local/happy-tails";
        if (input.includes("<lessons")) return "- L1 — L2 replaces it: cards go through Square.";
        return "# x\n\n## What it is\nA company.";
      },
      tidy: async () => [],
      brains: { home: () => true, org: () => null },
      done: { load: () => done, save: (steps: string[]) => void done.splice(0, done.length, ...steps) },
      log: () => undefined,
      now: () => NOW,
    },
  };
}

test("the dry run says every move and changes nothing", async () => {
  const { dir, git } = folder();
  const { d, asked } = deps(dir);
  const steps = await migrate.migrate(d, true);
  const said = steps.flatMap((step) => step.lines).join("\n");
  assert.match(said, /tag before-local/);
  assert.match(said, /remove the origin remote/);
  assert.match(said, /remove computers\/office\//);
  assert.match(said, /split computers\/laptop\/daily\/2026-10-23\.md: octo-org\/cobra, local\/happy-tails/);
  assert.match(said, /sort 1 hourly note of 2026-10-24 by project/);
  assert.match(said, /check 2 lessons of local\/happy-tails/);
  assert.equal(asked.length, 0);
  assert.equal(git("status", "--porcelain").stdout, "");
  assert.match(git("remote").stdout, /origin/);
});

test("the migration: local only, notes and hourlies split, the replaced lesson retired, and nothing done twice", async () => {
  const { dir, git } = folder();
  const done: string[] = [];
  const { d, asked } = deps(dir, done);
  await migrate.migrate(d, false);
  assert.equal(git("remote").stdout.trim(), "");
  assert.equal(git("rev-parse", "before-local").status, 0);
  assert.equal(existsSync(join(dir, "computers/office")), false);
  assert.match(readFileSync(join(dir, memory.memoryPaths.daily("laptop", "2026-10-23")), "utf8"), /### local\/happy-tails\n- Billing for Tony drafted\./);
  assert.equal(readFileSync(join(dir, "computers/laptop/hourly/2026-10-24/13.md"), "utf8"), "# laptop · 13:00\n\n### octo-org/cobra\n- Merged #381.\n\n### local/happy-tails\n- Dale's invoice.\n");
  assert.equal(readFileSync(join(dir, "computers/laptop/hourly/2026-10-24/14.md"), "utf8"), "# laptop · 14:00\n\n### Fleet\n- Already split.\n");
  const lessons = readFileSync(join(dir, memory.memoryPaths.lessons("laptop", "local/happy-tails")), "utf8");
  assert.match(lessons, /## Active\n- 2026-10-22 · decision · No Stripe Payment Link/);
  assert.match(lessons, /## Retired\n[^\n]*Stripe Payment Link\. \(from: lead\)[^\n]*L2 replaces it/);
  assert.deepEqual(done, ["hourlies", "lessons"]);
  const runs = asked.length;
  const again = await migrate.migrate(d, false);
  assert.equal(asked.length, runs, "a second run asks no model again");
  assert.deepEqual(again.find((step) => step.step === "notes")?.lines, []);
});
