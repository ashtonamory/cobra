import { test } from "node:test";
import assert from "node:assert/strict";

import { blocked, type BlockContext, type BlockRule } from "./blocklist.ts";

const ROOT = "/home/u/Projects/cobra.worktrees/feat-x";
const ctx: BlockContext = { cwd: ROOT, root: ROOT, home: "/home/u", branch: "feat/x", protectedBranches: ["main", "master", "trunk"] };
const rule = (command: string, over: Partial<BlockContext> = {}): BlockRule | null => blocked(command, { ...ctx, ...over })?.rule ?? null;

const REFUSED: Array<[string, BlockRule]> = [
  // rm -rf at /, home, .., the worktree and above, in every spelling.
  ["rm -rf /", "rm-root"],
  ["rm -fr /", "rm-root"],
  ["rm -r -f /", "rm-root"],
  ["rm --recursive --force /", "rm-root"],
  ["rm -rf -- /", "rm-root"],
  ["rm / -rf", "rm-root"],
  ["rm -rf /*", "rm-root"],
  ["rm -rf //", "rm-root"],
  ["rm -rf --no-preserve-root /", "rm-root"],
  ['rm -rf "/"', "rm-root"],
  ["rm -rf '/'", "rm-root"],
  ["rm -Rf /", "rm-root"],
  ["rm -rf ~/..", "rm-root"],
  ['rm -rf "$HOME"/..', "rm-root"],
  ["nohup rm -rf / &", "rm-root"],
  ["sudo -E rm -rf /", "rm-root"],
  ["echo / | xargs -I{} rm -rf {}", "rm-root"],
  ["/bin/rm -rf /", "rm-root"],
  ["\\rm -rf /", "rm-root"],
  ["rm -rf ~", "rm-root"],
  ["rm -rf ~/", "rm-root"],
  ["rm -rf ~/*", "rm-root"],
  ["rm -rf $HOME", "rm-root"],
  ['rm -rf "$HOME"', "rm-root"],
  ['rm -rf "${HOME}/"', "rm-root"],
  ["rm -rf ..", "rm-root"],
  ["rm -rf ../", "rm-root"],
  ["rm -rf ../*", "rm-root"],
  ["rm -rf ../..", "rm-root"],
  ["rm -rf .", "rm-root"],
  ["rm -rf ./", "rm-root"],
  ["rm -rf *", "rm-root"],
  ['rm -rf "$PWD"', "rm-root"],
  [`rm -rf ${ROOT}`, "rm-root"],
  ["rm -rf /home/u/Projects/cobra.worktrees", "rm-root"],
  ["rm -rf /home/u/Projects", "rm-root"],
  ["rm -rf /home", "rm-root"],
  ["rm -rf /usr", "rm-root"],
  ["rm -rf /{usr,etc}", "rm-root"],
  ["sudo rm -rf /", "rm-root"],
  ["sudo -u root rm -rf /", "rm-root"],
  ["env FOO=1 rm -rf ~", "rm-root"],
  ["FOO=1 rm -rf ~", "rm-root"],
  ["timeout 5 nice -n 10 rm -rf ~", "rm-root"],
  ["command rm -rf /", "rm-root"],
  ["pnpm test && rm -rf ~", "rm-root"],
  ["pnpm test; rm -rf ~", "rm-root"],
  ["pnpm test || rm -rf ~", "rm-root"],
  ["false | rm -rf ~", "rm-root"],
  ["echo hi\nrm -rf ~", "rm-root"],
  ["(rm -rf ~)", "rm-root"],
  ["{ rm -rf ~; }", "rm-root"],
  ["if true; then rm -rf ~; fi", "rm-root"],
  ["echo $(rm -rf ~)", "rm-root"],
  ["echo `rm -rf ~`", "rm-root"],
  ['echo "$(rm -rf ~)"', "rm-root"],
  ["bash -c 'rm -rf /'", "rm-root"],
  ['sh -c "rm -rf ~"', "rm-root"],
  ["bash -lc 'cd / && rm -rf *'", "rm-root"],
  ["zsh -c -- 'rm -rf ~'", "rm-root"],
  ["eval 'rm -rf ~'", "rm-root"],
  ["su -c 'rm -rf /'", "rm-root"],
  ["cd / && rm -rf *", "rm-root"],
  ["cd .. && rm -rf feat-x", "rm-root"],
  ["cd ~ && rm -rf .", "rm-root"],
  ["echo / | xargs rm -rf", "rm-root"],
  ["echo ~ | xargs -0 rm -rf", "rm-root"],
  ["xargs rm -rf / < list", "rm-root"],
  ["find / -print0 | xargs -0 rm -rf", "rm-root"],
  ["find / -delete", "rm-root"],
  ["find ~ -name '*' -delete", "rm-root"],
  ["find .. -type f -delete", "rm-root"],
  ["find / -exec rm -rf {} +", "rm-root"],
  ["bash <<'EOF'\nrm -rf ~\nEOF", "rm-root"],
  ["python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['rm', '-rf', '/'])\nEOF", "rm-root"],
  // Force pushes to main, master or the default branch.
  ["git push --force origin main", "force-push-main"],
  ["git push -f origin main", "force-push-main"],
  ["git push origin main --force", "force-push-main"],
  ["git push origin main -f", "force-push-main"],
  ["git push -uf origin master", "force-push-main"],
  ["git push --force-with-lease origin main", "force-push-main"],
  ["git push --force-with-lease=main:abc123 origin main", "force-push-main"],
  ["git push origin +main", "force-push-main"],
  ["git push origin +HEAD:main", "force-push-main"],
  ["git push origin +feat/x:refs/heads/main", "force-push-main"],
  ["git push --force origin HEAD:master", "force-push-main"],
  ["git push --force origin trunk", "force-push-main"],
  ["git push origin :main", "force-push-main"],
  ["git push origin --delete main", "force-push-main"],
  ["git push --mirror origin", "force-push-main"],
  ["git push --force --all", "force-push-main"],
  ["git -C ../other push -f origin main", "force-push-main"],
  ["git push origin '+refs/heads/*:refs/heads/*'", "force-push-main"],
  ["bash -c 'git push -f origin main'", "force-push-main"],
  // Disks.
  ["mkfs.ext4 /dev/sda1", "disk-wipe"],
  ["mkfs -t ext4 /dev/nvme0n1p1", "disk-wipe"],
  ["sudo wipefs -a /dev/sda", "disk-wipe"],
  ["dd if=/dev/zero of=/dev/sda bs=1M", "disk-wipe"],
  ["dd if=image.iso of=/dev/nvme0n1", "disk-wipe"],
  ["cat image > /dev/sda", "disk-wipe"],
  ["echo x >/dev/sdb", "disk-wipe"],
  ["head -c 1M /dev/urandom | sudo tee /dev/mmcblk0", "disk-wipe"],
  // Fork bombs.
  [":(){ :|:& };:", "fork-bomb"],
  [":(){:|:&};:", "fork-bomb"],
  ["bomb() { bomb | bomb & }; bomb", "fork-bomb"],
  ["function f { f | f & }; f", "fork-bomb"],
  ["bash -c ':(){ :|:& };:'", "fork-bomb"],
  ["perl -e 'fork while fork'", "fork-bomb"],
  ["python3 -c 'import os\nwhile True: os.fork()'", "fork-bomb"],
  // Permissions on / and above.
  ["chmod -R 777 /", "chmod-root"],
  ["sudo chmod -R 777 /", "chmod-root"],
  ["chmod --recursive a+w ~", "chmod-root"],
  ["chown -R nobody /", "chmod-root"],
  ["chown -R u:u ..", "chmod-root"],
  ["chgrp -R wheel /home/u", "chmod-root"],
];

const ALLOWED: string[] = [
  "rm -rf node_modules",
  "rm -rf ./dist",
  "rm -rf dist build",
  "rm -rf {dist,build}",
  "rm -rf apps/*/dist",
  "rm -rf /tmp/cobra-test-x",
  "rm -rf ~/.cache/cobra-test",
  "rm -rf $HOME/.cache/x",
  'rm -rf "$TMPDIR/x"',
  'rm -rf "$DIR"',
  "rm -f /",
  "rm ..",
  "rm -rf ../sibling",
  "cd apps/web && rm -rf *",
  "cd dist && rm -rf ./*",
  "find . -name '*.log' -delete",
  "find . -type d -name node_modules -prune -exec rm -rf {} +",
  "find dist -delete",
  "find /tmp/x -delete",
  "find . -name '*.o' | xargs rm -f",
  "echo 'rm -rf /' > notes.md",
  "git commit -m 'never rm -rf /'",
  "cat > notes.md <<'EOF'\nrm -rf ~\nEOF",
  "grep -r 'rm -rf' .",
  "git push origin feat/x",
  "git push --force origin feat/x",
  "git push -f",
  "git push --force-with-lease origin HEAD",
  "git push -u origin feat/x",
  "git push origin main",
  "git push origin feat/x:feat/y --force",
  "git log --force-with-lease",
  "dd if=/dev/zero of=./disk.img bs=1M count=10",
  "dd if=/dev/urandom of=/dev/null count=1",
  "echo hi > /dev/null",
  "pnpm test 2>&1 | tee /dev/stderr",
  "echo x >&2",
  "chmod -R 755 .",
  "chmod -R u+x scripts",
  "chmod 755 /",
  "chown -R u:u ./data",
  "make() { echo hi; }; make",
  "build() { tsc | tee log & }; build",
  "pnpm test",
];

test("the blocklist refuses each destructive shape, however it is spelled", () => {
  for (const [command, expected] of REFUSED) assert.equal(rule(command), expected, command);
});

test("the blocklist leaves everyday commands to the rest of the rules", () => {
  for (const command of ALLOWED) assert.equal(rule(command), null, command);
});

test("the worktree and its parents count from where the chain is", () => {
  // From a folder in the worktree, `..` is still a bare `..`; `../x` is inside.
  assert.equal(rule("rm -rf ..", { cwd: `${ROOT}/apps` }), "rm-root");
  assert.equal(rule("rm -rf ../dist", { cwd: `${ROOT}/apps/web` }), null);
  // A Worker on main itself: a bare force push pushes main.
  assert.equal(rule("git push -f", { branch: "main" }), "force-push-main");
  assert.equal(rule("git push --force origin HEAD", { branch: "trunk" }), "force-push-main");
});

test("every refusal says why, so the Worker can carry on", () => {
  const found = blocked("rm -rf ~", ctx);
  assert.ok(found);
  assert.match(found.reason, /no setting allows it/);
});
