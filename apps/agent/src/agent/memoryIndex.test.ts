import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "cobra-memory-index-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");

const memory = await import("./memory.ts");
const index = await import("./memoryIndex.ts");
const { parseOrg } = await import("../../../../packages/contracts/src/org.ts");

const NOW = new Date(2026, 9, 24, 15).getTime();

const ORG = parseOrg({
  revision: 4,
  companies: [
    { id: "cobra-northwind", name: "Cobra/Northwind", color: "#3f86c4" },
    { id: "happy-tails", name: "Happy Tails", color: "#c0763a", sensitive: true },
  ],
  seats: { "omarchy/cobra": { company: "cobra-northwind" }, "omarchy/happy-tails": { company: "happy-tails" }, "omarchy/money-paws": { company: "happy-tails" } },
});

function root() {
  const dir = mkdtempSync(join(tmpdir(), "cobra-memory-index-root-"));
  const state = (key: string, text: string) => memory.writeMemoryFile(dir, memory.memoryPaths.state("laptop", key), text);
  state("octo-org/cobra", "# octo-org/cobra\n\n_Updated 2026-10-24 14:00 by laptop._\n\nGoal: memory\nBlocked / waiting: PR #384 waits for your merge\nNext: wave 2");
  state("local/notes", "# local/notes\n\n_Updated 2026-10-20 end of day by laptop._\n\nGoal: notes\nBlocked / waiting: none\nNext: tidy the inbox");
  state("local/happy-tails", "# local/happy-tails\n\n_Updated 2026-10-23 by laptop._\n\nBlocked / waiting: Tony's invoice MP-1004 needs your OK");
  state("local/money-paws", "# local/money-paws\n\n_Updated 2026-10-22 by laptop._\n\nNext: payroll run");
  memory.writeMemoryFile(dir, "computers/laptop/hourly/2026-10-24/14.md", "# laptop · 14:00\n\n### Fleet\n- Cobra briefed the cobra Foreman.\n- Two PRs wait on you.\n\n### octo-org/cobra\n- Opened #384.");
  return dir;
}

const PROJECTS = [
  { id: "cobra", key: "octo-org/cobra" },
  { id: "notes", key: "local/notes" },
  { id: "happy-tails", key: "local/happy-tails" },
  { id: "money-paws", key: "local/money-paws" },
];

test("an index line is what waits, else what is next; 'none' waits for nothing", () => {
  assert.deepEqual(index.entryOf("k/k", "_Updated 2026-10-24 by x._\n\nBlocked / waiting: your merge of #12\nNext: ship"), { day: "2026-10-24", line: "Waiting: your merge of #12", waits: true });
  assert.deepEqual(index.entryOf("k/k", "Blocked / waiting: None.\nNext: ship"), { day: "", line: "Next: ship" });
  assert.equal(index.entryOf("k/k", `Next: ${"x".repeat(400)}`).line.length, index.INDEX_LINE_MAX);
});

test("the index lists each project with its company; a sensitive company is counted, never listed", () => {
  const dir = root();
  const built = index.buildIndex(dir, "laptop", "omarchy", PROJECTS, ORG, NOW);
  // This computer's own index lists everything, for its own Foremen.
  assert.equal(built.entries.length, 4);
  assert.equal(built.entries.find((entry) => entry.key === "local/happy-tails")?.company?.sensitive, true);
  const shared = index.shareIndex(built);
  assert.deepEqual(
    shared.entries.map((entry) => [entry.key, entry.company?.name ?? null, entry.line]),
    [
      ["local/notes", null, "Next: tidy the inbox"],
      ["octo-org/cobra", "Cobra/Northwind", "Waiting: PR #384 waits for your merge"],
    ],
  );
  assert.deepEqual(shared.sensitive, [{ id: "happy-tails", name: "Happy Tails", projects: 2, waiting: 1 }]);
  assert.doesNotMatch(JSON.stringify(shared), /Tony|MP-1004|payroll|local\/happy-tails|money-paws/, "no detail of a sensitive company leaves in the shared index");
  assert.deepEqual(built.headlines, ["- Cobra briefed the cobra Foreman.", "- Two PRs wait on you."]);
});

test("the Lead's computer reads its own index and the others' it collected, its own first; junk is dropped", () => {
  const dir = root();
  index.writeIndex(dir, index.buildIndex(dir, "laptop", "omarchy", PROJECTS, ORG, NOW));
  index.saveFleetIndex(dir, { computer: "office", host: "office", at: new Date(NOW).toISOString(), entries: [{ key: "octo-org/example.com", day: "2026-10-24", line: "Next: deploy" }], sensitive: [], headlines: [] });
  writeFileSync(join(dir, index.FLEET_INDEX, "junk.json"), "{nope");
  const all = index.readIndexes(dir, "laptop");
  assert.deepEqual(
    all.map((one) => one.computer),
    ["laptop", "office"],
  );
  assert.equal(index.parseIndex({ computer: "x" }), null);
  assert.deepEqual(index.parseIndex({ computer: "x", host: "x", at: "t", entries: [{ key: "../etc", day: "", line: "" }, { key: "a/b", day: "bad", line: "Next: y" }] })?.entries, [{ key: "a/b", day: "", line: "Next: y" }]);
});

test("the org mirror keeps the newest revision the Lead's computer sent", () => {
  const dir = mkdtempSync(join(tmpdir(), "cobra-org-mirror-"));
  const mirror = join(dir, "org-mirror.json");
  const own = join(dir, "org.json");
  assert.equal(index.orgForMemory(mirror, own), null);
  writeFileSync(own, JSON.stringify({ ...ORG, revision: 1 }));
  assert.equal(index.orgForMemory(mirror, own)?.revision, 1, "the Lead's own org.json when nothing was sent");
  assert.equal(index.saveOrgMirror(ORG, mirror), true);
  assert.equal(index.saveOrgMirror({ ...ORG, revision: 2 }, mirror), false, "an older revision is refused");
  assert.equal(index.orgForMemory(mirror, own)?.revision, 4);
  assert.equal(index.orgForMemory(mirror, own)?.companies[1]?.sensitive, true);
});

test("projectSensitive: a seat's company marked sensitive, on this computer's host only", () => {
  const org = parseOrg({ ...ORG, companies: ORG.companies.map((company) => (company.id === "happy-tails" ? { ...company, sensitive: true } : company)) });
  assert.equal(index.projectSensitive(org, "omarchy", "money-paws"), true);
  assert.equal(index.projectSensitive(org, "omarchy", "cobra"), false);
  assert.equal(index.projectSensitive(org, "office", "money-paws"), false, "another computer's seat");
  assert.equal(index.projectSensitive(org, "omarchy", "unseated"), false);
  assert.equal(index.projectSensitive(null, "omarchy", "money-paws"), false);
});
