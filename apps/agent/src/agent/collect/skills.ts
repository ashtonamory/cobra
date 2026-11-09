import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { Command } from "@cobra/contracts";

/**
 * What slash commands this machine will accept, so the phone can offer them.
 *
 * Claude Code draws its own "/" menu, but that menu cannot be read back: it
 * replaces the status line, and its highlighted row is distinguished only by
 * colour, which `tmux capture-pane -p` discards (captures of 2026-09-21). So
 * the app builds its own menu, and this is where the list comes from.
 *
 * Skills are directories with a SKILL.md, in three places that matter —
 * the user's own, the project's, and every plugin's. On this machine that is
 * three of the user's against roughly 250 from plugins, which is why the
 * `common` flag exists: a phone menu opens on the few that are yours and
 * keeps the rest behind a search rather than scrolling past 250 rows.
 */

/**
 * Claude Code's own commands. They are not files anywhere, so they are listed.
 *
 * Only the ones that say something back. /cost and /context run fine and draw
 * their answer as a full-screen terminal view, which never reaches the
 * transcript — on a phone they produce a row with nothing under it and leave
 * the terminal on a report, so offering them is offering a dead end.
 */
const BUILTIN: ReadonlyArray<{ name: string; description: string }> = [
  { name: "model", description: "Switch the model this session answers with" },
  // A bare /effort sets the level *and* saves it as the default for new
  // sessions, with no picker to confirm it — the description says so,
  // because the menu should not hand over a machine-wide change quietly.
  { name: "effort", description: "Set reasoning effort — also saves it as your default" },
  { name: "code-review", description: "Review the current diff for bugs" },
  { name: "security-review", description: "Review the current diff for vulnerabilities" },
  { name: "simplify", description: "Clean up the changed code for reuse and clarity" },
  { name: "compact", description: "Summarise the conversation so far to free up context" },
  { name: "clear", description: "Start a fresh conversation in this session" },
  { name: "init", description: "Write a CLAUDE.md for this project" },
  { name: "loop", description: "Run a prompt or command on a recurring interval" },
  { name: "schedule", description: "Create or manage scheduled cloud agents" },
];

/** How much of a SKILL.md to read: frontmatter is at the top and is not long. */
const FRONTMATTER_BYTES = 4096;
const DESCRIPTION = 240;

/**
 * Skills synced from a marketplace live under a directory named for two
 * opaque ids, and the CLI addresses them by a namespace that appears nowhere
 * on disk ("anthropic-skills:pdf"). Guessing it would put names in the menu
 * that do not work when tapped, so these are left out until the namespace can
 * be read rather than inferred.
 */
const SYNCED = "synced";

/** Enough nesting to reach a plugin's skills without walking a whole home directory. */
const MAX_DEPTH = 6;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * `name` and `description` out of a SKILL.md's YAML frontmatter. Descriptions
 * are routinely folded across lines with ">", so a line-wise read has to keep
 * taking indented continuations until the next key.
 */
export function readFrontmatter(text: string): { name: string | null; description: string } {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== "---") return { name: null, description: "" };
  let name: string | null = null;
  const description: string[] = [];
  let inDescription = false;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") break;
    const key = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (key) {
      inDescription = false;
      const field = (key[1] ?? "").toLowerCase();
      const value = (key[2] ?? "").trim();
      if (field === "name") name = value.replace(/^["']|["']$/g, "");
      if (field === "description") {
        inDescription = true;
        // ">" and "|" introduce a folded block; the text is on the lines below.
        if (value && value !== ">" && value !== "|" && value !== ">-" && value !== "|-") {
          description.push(value.replace(/^["']|["']$/g, ""));
        }
      }
      continue;
    }
    if (inDescription && line.trim()) description.push(line.trim());
  }
  return { name, description: clip(description.join(" "), DESCRIPTION) };
}

async function skillAt(dir: string): Promise<{ name: string; description: string } | null> {
  try {
    const handle = await readFile(join(dir, "SKILL.md"), "utf8");
    const { name, description } = readFrontmatter(handle.slice(0, FRONTMATTER_BYTES));
    // The directory name is what the CLI addresses; frontmatter only
    // describes. They agree in practice, and the directory wins when not.
    return { name: basename(dir), description: description || (name ?? "") };
  } catch {
    return null;
  }
}

/** The immediate subdirectories of a skills directory, each a candidate skill. */
async function skillsIn(dir: string): Promise<Array<{ name: string; description: string }>> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const found = await Promise.all(
    entries.filter((entry) => entry !== SYNCED).map((entry) => skillAt(join(dir, entry))),
  );
  return found.filter((skill): skill is { name: string; description: string } => skill !== null);
}

/**
 * Every plugin skill under the plugins tree. A plugin's skills sit in
 * "<plugin>/skills/<skill>/SKILL.md" at varying depths — synced plugins nest
 * under an id directory, marketplace ones under the marketplace — so the walk
 * looks for a directory called "skills" and takes its grandparent as the
 * plugin name, rather than assuming one layout.
 */
async function pluginSkills(root: string, depth = 0): Promise<Command[]> {
  if (depth > MAX_DEPTH) return [];
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const out: Command[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry);
      try {
        if (!(await stat(path)).isDirectory()) return;
      } catch {
        return;
      }
      if (entry === "skills") {
        const plugin = basename(dirname(path));
        for (const skill of await skillsIn(path)) {
          out.push({
            name: `${plugin}:${skill.name}`,
            source: "plugin",
            plugin,
            description: skill.description,
          });
        }
        return;
      }
      out.push(...(await pluginSkills(path, depth + 1)));
    }),
  );
  return out;
}

/**
 * Every command the session at `cwd` would accept, most specific first: the
 * project's own, then the user's, then the built-ins, then every plugin's.
 * Duplicate names keep the first, so a project skill shadows a user one the
 * way the CLI resolves them.
 */
export async function collectCommands(cwd: string, home = homedir()): Promise<Command[]> {
  const [project, projectCommands, user, plugins] = await Promise.all([
    skillsIn(join(cwd, ".claude", "skills")),
    commandFiles(join(cwd, ".claude", "commands")),
    skillsIn(join(home, ".claude", "skills")),
    pluginSkills(join(home, ".claude", "plugins")),
  ]);

  const all: Command[] = [
    ...project.map((skill) => ({ ...skill, source: "project" as const, common: true })),
    ...projectCommands.map((skill) => ({ ...skill, source: "project" as const, common: true })),
    ...user.map((skill) => ({ ...skill, source: "user" as const, common: true })),
    ...BUILTIN.map((builtin) => ({ ...builtin, source: "builtin" as const, common: true })),
    ...plugins,
  ];

  const seen = new Set<string>();
  const unique: Command[] = [];
  for (const command of all) {
    if (!command.name || seen.has(command.name)) continue;
    seen.add(command.name);
    unique.push(command);
  }
  return unique;
}

/** A project's own "<name>.md" slash commands, which are files rather than directories. */
async function commandFiles(dir: string): Promise<Array<{ name: string; description: string }>> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const found = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".md"))
      .map(async (entry) => {
        try {
          const text = (await readFile(join(dir, entry), "utf8")).slice(0, FRONTMATTER_BYTES);
          const { description } = readFrontmatter(text);
          return { name: entry.replace(/\.md$/, ""), description };
        } catch {
          return null;
        }
      }),
  );
  return found.filter((entry): entry is { name: string; description: string } => entry !== null);
}
