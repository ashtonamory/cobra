// The package's import check, run by package.sh after the sources are staged:
//   node staged-imports.mjs <repo root> <stage>
// 1. The contracts files the agent runs: every packages/contracts/src file a
//    staged source imports, and the contracts files those import, copied in.
//    A list kept by hand went stale once (#513 added viewsRead.ts and
//    boards.ts, and the installed agent could not start).
// 2. Every relative import in the staged .ts and .mjs files must find its
//    file, or the package is not written. `import type` and `export type`
//    lines are erased when Node strips types, so they need not resolve; an
//    import with only `type` names inside the braces still loads its file.
// 3. Every package a staged file loads by name (not `node:`) must be in the
//    package's node_modules. #608 imported values from "@cobra/contracts",
//    which only the repo has, and the installed agent could not start.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const [root, stage] = process.argv.slice(2).map((p) => resolve(p));
if (!root || !stage) throw new Error("usage: staged-imports.mjs <repo root> <stage>");

const IMPORT = /^\s*(import|export)\s+(type\s+)?(?:[^"';]*?\sfrom\s+)?["'](\.{1,2}\/[^"']+)["']/gm;

function sources(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") found.push(...sources(path));
    } else if (/\.(ts|mjs)$/.test(entry.name) && !/\.test\.(ts|mjs)$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** The relative imports a file loads at run time, as absolute paths under the same tree. */
function runtimeImports(file) {
  const text = readFileSync(file, "utf8");
  const out = [];
  for (const match of text.matchAll(IMPORT)) {
    if (match[2]) continue;
    out.push(resolve(dirname(file), match[3]));
  }
  return out;
}

// 1. The contracts closure.
const contracts = join("packages", "contracts", "src");
const queue = sources(stage);
const copied = new Set();
while (queue.length) {
  const file = queue.pop();
  for (const target of runtimeImports(file)) {
    const rel = relative(stage, target);
    if (!rel.startsWith(contracts + "/") || copied.has(rel) || existsSync(target)) continue;
    const from = join(root, rel);
    if (!existsSync(from)) continue;
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(from, target);
    copied.add(rel);
    queue.push(target);
  }
}
console.log(`    contracts: ${[...copied].map((rel) => rel.slice(contracts.length + 1)).sort().join(" ")}`);

// 2. Every import resolves inside the package.
const missing = [];
for (const file of sources(stage)) {
  for (const target of runtimeImports(file)) if (!existsSync(target)) missing.push(`${relative(stage, file)} imports ${relative(stage, target)}`);
}
if (missing.length) {
  console.error(`!!  the package is missing files its sources import:\n    ${missing.join("\n    ")}`);
  process.exit(1);
}

// 3. Every package imported by name loads from the package's own node_modules.
const BARE = /^\s*(import|export)\s+(type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^."'/][^"']*)["']/gm;
const unshipped = [];
// The agent's own sources and the shared packages; site-template is the websites'
// code, built on its own. A `scheme:` name (node:, or cloudflare: in the Worker code siteDeploy.ts
// writes out as text) is not looked up in node_modules.
const RUN = ["apps", "packages"].map((dir) => join(stage, dir)).filter((dir) => existsSync(dir));
for (const file of RUN.flatMap(sources)) {
  for (const match of readFileSync(file, "utf8").matchAll(BARE)) {
    if (match[2] || /^[a-z]+:/.test(match[3])) continue;
    const parts = match[3].split("/");
    const name = match[3].startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    if (!existsSync(join(stage, "node_modules", name))) unshipped.push(`${relative(stage, file)} loads "${match[3]}"`);
  }
}
if (unshipped.length) {
  console.error(`!!  the package does not ship packages its sources load (use \`import type\`, or import a zod-free contracts file by path):\n    ${unshipped.join("\n    ")}`);
  process.exit(1);
}
