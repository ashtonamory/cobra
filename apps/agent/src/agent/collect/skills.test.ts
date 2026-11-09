import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectCommands, readFrontmatter } from "./skills.ts";

/** A SKILL.md with a folded description, which is how most of them are written. */
const FOLDED = `---
name: omarchy
description: >
  REQUIRED for end-user customization of Linux desktop, window manager,
  or system config. Triggers: Hyprland, window rules, keybindings.
---

# Omarchy
`;

const INLINE = `---
name: diagnose-crash
description: Diagnose why a program crashed on this machine.
---
`;

test("a folded description is joined back into one line", () => {
  const read = readFrontmatter(FOLDED);
  assert.equal(read.name, "omarchy");
  assert.equal(
    read.description,
    "REQUIRED for end-user customization of Linux desktop, window manager, or system config. Triggers: Hyprland, window rules, keybindings.",
  );
});

test("an inline description is taken as it stands", () => {
  assert.deepEqual(readFrontmatter(INLINE), {
    name: "diagnose-crash",
    description: "Diagnose why a program crashed on this machine.",
  });
});

test("a file with no frontmatter yields nothing rather than throwing", () => {
  assert.deepEqual(readFrontmatter("# Just a heading\n"), { name: null, description: "" });
});

async function skill(dir: string, name: string, description: string): Promise<void> {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
}

test("skills are found in the project, the home directory and every plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-skills-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");

  await skill(join(cwd, ".claude", "skills"), "deploy", "Deploy this project");
  await skill(join(home, ".claude", "skills"), "omarchy", "Desktop config");
  await skill(join(home, ".claude", "plugins", "synced", "abc", "sales", "skills"), "forecast", "Forecast");
  await skill(join(home, ".claude", "plugins", "marketplaces", "mp", "plugins", "data", "skills"), "analyze", "Analyze");

  const commands = await collectCommands(cwd, home);
  const byName = new Map(commands.map((command) => [command.name, command]));

  assert.equal(byName.get("deploy")?.source, "project");
  assert.equal(byName.get("omarchy")?.source, "user");
  // A plugin's skills are namespaced by the directory above their "skills".
  assert.equal(byName.get("sales:forecast")?.source, "plugin");
  assert.equal(byName.get("sales:forecast")?.plugin, "sales");
  assert.equal(byName.get("data:analyze")?.plugin, "data");
  // The built-ins are not files anywhere, so they come from the list.
  assert.equal(byName.get("model")?.source, "builtin");
});

test("only the project's, the user's and the built-ins open the menu", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-skills-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  await skill(join(cwd, ".claude", "skills"), "deploy", "Deploy this project");
  await skill(join(home, ".claude", "plugins", "synced", "abc", "sales", "skills"), "forecast", "Forecast");

  const commands = await collectCommands(cwd, home);
  // 250-odd plugin skills would bury the handful that get used; they are
  // reachable by search instead.
  assert.equal(commands.find((command) => command.name === "deploy")?.common, true);
  assert.equal(commands.find((command) => command.name === "sales:forecast")?.common, undefined);
});

test("a project skill shadows a user skill of the same name", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-skills-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  await skill(join(cwd, ".claude", "skills"), "notes", "The project's");
  await skill(join(home, ".claude", "skills"), "notes", "The user's");

  const commands = await collectCommands(cwd, home);
  const notes = commands.filter((command) => command.name === "notes");
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.source, "project");
});

test("a project's .md commands are listed alongside its skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-skills-"));
  const cwd = join(root, "repo");
  await mkdir(join(cwd, ".claude", "commands"), { recursive: true });
  await writeFile(
    join(cwd, ".claude", "commands", "ship.md"),
    "---\ndescription: Push the branch and open its PR\n---\n",
  );

  const commands = await collectCommands(cwd, join(root, "home"));
  const ship = commands.find((command) => command.name === "ship");
  assert.equal(ship?.source, "project");
  assert.equal(ship?.description, "Push the branch and open its PR");
});

test("a missing directory is not an error, it is no commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "cp-skills-"));
  const commands = await collectCommands(join(root, "nowhere"), join(root, "nohome"));
  // The built-ins always survive: they do not come from disk.
  assert.deepEqual(new Set(commands.map((command) => command.source)), new Set(["builtin"]));
});
