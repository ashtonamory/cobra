import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importNews, importText, liveImportDeps, MAX_IMPORT_FILES, planImport, removeImports, runImport, type ImportDeps } from "./workerImport.ts";

function world() {
  const home = mkdtempSync(join(tmpdir(), "cobra-import-"));
  const tree = join(home, "Projects", "billing.worktrees", "feat-logo");
  const shipped = join(home, "agent", "templates");
  mkdirSync(join(tree, "assets"), { recursive: true });
  mkdirSync(join(home, "Brand"), { recursive: true });
  mkdirSync(join(home, ".ssh"), { recursive: true });
  mkdirSync(join(shipped, "billing"), { recursive: true });
  mkdirSync(join(home, ".local", "share", "cobra-agent", "templates"), { recursive: true });
  writeFileSync(join(home, "Brand", "logo.svg"), "<svg/>");
  writeFileSync(join(home, "Brand", ".env"), "KEY=1");
  writeFileSync(join(home, ".ssh", "id_ed25519"), "secret");
  writeFileSync(join(home, ".local", "share", "cobra-agent", "templates", "x.html"), "agent");
  writeFileSync(join(shipped, "billing", "index.html"), "<html/>");
  writeFileSync(join(tree, "assets", "old.svg"), "old");
  symlinkSync(join(home, "Brand"), join(tree, "out"));
  const deps: ImportDeps = { ...liveImportDeps([shipped]), home };
  return { home, tree, shipped, deps, worker: { id: "billing_2", path: tree } };
}

test("worker_import: a file under home or a shipped template, checked, sized and hashed onto the card", async () => {
  const { home, shipped, deps, worker } = world();
  const plan = await planImport(deps, "billing", worker, [
    { from: join(home, "Brand", "logo.svg"), to: "assets/logo.svg" },
    { from: join(shipped, "billing", "index.html"), to: "templates/invoice/index.html" },
  ]);
  assert.deepEqual(plan.files.map((file) => [file.to, file.bytes]), [["assets/logo.svg", 6], ["templates/invoice/index.html", 7]]);
  assert.match(plan.files[0]!.sha256, /^[0-9a-f]{64}$/);
  const words = importText(plan, "Billing");
  assert.equal(words.title, "Copy 2 files into Billing?");
  assert.match(words.body, /logo\.svg → assets\/logo\.svg \(6 B\)/);
});

test("worker_import refuses credentials, the agent's folders, a secret's name, links out, .git, .. and a file that is there", async () => {
  const { home, tree, deps, worker } = world();
  const refused = async (from: string, to: string, why: RegExp) =>
    assert.rejects(planImport(deps, "billing", worker, [{ from, to }]), (caught: Error) => why.test(caught.message), `${from} → ${to}`);
  await refused(join(home, ".ssh", "id_ed25519"), "a", /credential/);
  await refused(join(home, ".local", "share", "cobra-agent", "templates", "x.html"), "a", /agent's own/);
  await refused(join(home, "Brand", ".env"), "a", /credential/);
  await refused("/etc/hostname", "a", /outside your home/);
  await refused(join(home, "Brand", "logo.svg"), "../../x.svg", /inside the worktree/);
  await refused(join(home, "Brand", "logo.svg"), "/tmp/x.svg", /relative/);
  await refused(join(home, "Brand", "logo.svg"), ".git/hooks/pre-commit", /never into \.git/);
  await refused(join(home, "Brand", "logo.svg"), "assets/old.svg", /there already/);
  await refused(join(home, "Brand", "logo.svg"), "out/new.svg", /leads out of the worktree/);
  await refused(join(tree, "assets", "old.svg"), "assets/copy.svg", /worktree already/);
  await refused(join(home, "Brand", "missing.svg"), "a", /not there/);
  const many = Array.from({ length: MAX_IMPORT_FILES + 1 }, (_, i) => ({ from: join(home, "Brand", "logo.svg"), to: `a${i}.svg` }));
  await assert.rejects(planImport(deps, "billing", worker, many), /1 to 10/);
});

test("Allow copies exactly the bytes shown, never over a file, and a changed file is left out", async () => {
  const { home, tree, deps, worker } = world();
  writeFileSync(join(home, "Brand", "font.woff2"), "font");
  const plan = await planImport(deps, "billing", worker, [
    { from: join(home, "Brand", "logo.svg"), to: "assets/brand/logo.svg" },
    { from: join(home, "Brand", "font.woff2"), to: "assets/font.woff2" },
  ]);
  writeFileSync(join(home, "Brand", "font.woff2"), "changed");
  const results = await runImport(deps, plan, tree);
  assert.deepEqual(results.map((result) => result.ok), [true, false]);
  assert.match(results[1]!.message, /changed since you were asked/);
  assert.equal(readFileSync(join(tree, "assets", "brand", "logo.svg"), "utf8"), "<svg/>");
  const again = await runImport(deps, plan, tree);
  assert.match(again[0]!.message, /there already/, "a second Allow never writes over the first copy");
  assert.match(importNews("ap_1", plan, true, results), /assets\/brand\/logo\.svg: copied.*worker_send billing_2/);
  assert.match(importNews("ap_1", plan, false), /did not allow/);
});

test("Undo deletes each copied file still as copied, and keeps one the Worker changed or turned into a link", async () => {
  const { home, tree, deps, worker } = world();
  writeFileSync(join(home, "Brand", "font.woff2"), "font");
  writeFileSync(join(home, "Brand", "mark.svg"), "<mark/>");
  const plan = await planImport(deps, "billing", worker, [
    { from: join(home, "Brand", "logo.svg"), to: "assets/logo.svg" },
    { from: join(home, "Brand", "font.woff2"), to: "assets/font.woff2" },
    { from: join(home, "Brand", "mark.svg"), to: "assets/mark.svg" },
  ]);
  await runImport(deps, plan, tree);
  writeFileSync(join(tree, "assets", "font.woff2"), "edited by the Worker");
  // The Worker swaps a copied file for a link to one of yours with the same bytes: it is not deleted through the link.
  rmSync(join(tree, "assets", "mark.svg"));
  symlinkSync(join(home, "Brand", "mark.svg"), join(tree, "assets", "mark.svg"));
  const files = [...plan.files.map((file) => ({ to: file.to, sha256: file.sha256 })), { to: "assets/never.svg", sha256: "00" }, { to: "../../Brand/logo.svg", sha256: plan.files[0]!.sha256 }];
  const results = await removeImports(deps, async (path) => unlinkSync(path), files, tree);
  assert.deepEqual(results.map((result) => result.message), [
    "assets/logo.svg: deleted",
    "assets/font.woff2: not deleted, the Worker changed it, so it was kept",
    "assets/mark.svg: not deleted, it is a link now",
    "assets/never.svg: gone already",
    "../../Brand/logo.svg: not deleted, it is not a path inside the worktree",
  ]);
  assert.equal(existsSync(join(tree, "assets", "logo.svg")), false);
  assert.equal(existsSync(join(tree, "assets", "font.woff2")), true);
  assert.equal(existsSync(join(home, "Brand", "mark.svg")), true);
  assert.equal(existsSync(join(home, "Brand", "logo.svg")), true);
});
