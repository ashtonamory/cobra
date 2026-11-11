import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  accountsView,
  activeCodexCredential,
  activeClaudeToken,
  addClaudeAccount,
  claudeApartUsage,
  codexLoginStatus,
  removeAccount,
  saveLiveCodex,
  codexCredentialFromAuth,
  startCodexLogin,
  useAccount,
  type AccountPaths,
} from "./accounts.ts";
import { claudeToken } from "./workerProxy.ts";

// The live Codex sign-in is read from CODEX_HOME when set: these tests use their own home.
delete process.env.CODEX_HOME;

const ORG = "40dd3fcb-0000-4000-8000-000000000001";
const OTHER_ORG = "99999999-0000-4000-8000-000000000002";
const TOKEN = `sk-ant-oat01-${"a".repeat(40)}`;
const TOKEN_2 = `sk-ant-oat01-${"b".repeat(40)}`;

function setup(): AccountPaths & { done: () => void } {
  const root = mkdtempSync(join(tmpdir(), "cobra-accounts-"));
  const home = join(root, "home");
  mkdirSync(home);
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "me@example.com", organizationUuid: ORG } }));
  return { book: join(root, "accounts.json"), dir: join(root, "accounts"), home, done: () => rmSync(root, { recursive: true, force: true }) };
}

function codexAuth(email: string, account: string): string {
  const claims = Buffer.from(JSON.stringify({ email })).toString("base64url");
  return JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: `h.${claims}.s`, account_id: account, access_token: `at-${account}`, refresh_token: `rt-${account}` } });
}

const quiet = { codexRunning: async () => false, clearLimits: () => {} };

test("a Claude token is kept by who Anthropic says it is, and the one picked is what Cobra sends", async () => {
  const paths = setup();
  try {
    const mine = await addClaudeAccount({ token: TOKEN }, async () => ({ org: ORG }), paths);
    assert.equal(mine.email, "me@example.com", "this computer's own account is named by its email");
    assert.equal(mine.label, "me@example.com");
    const work = await addClaudeAccount({ token: TOKEN_2, label: "Work" }, async () => ({ org: OTHER_ORG }), paths);
    assert.equal(work.email, undefined, "another account's email is not known from its token");
    assert.equal(work.label, "Work");
    assert.equal(statSync(join(paths.dir, work.id, "claude-token")).mode & 0o777, 0o600);
    assert.equal(activeClaudeToken(paths), null, "nothing is picked until you pick it");

    let cleared = 0;
    await useAccount({ provider: "claude", id: work.id }, { ...quiet, clearLimits: () => (cleared += 1) }, paths);
    assert.equal(activeClaudeToken(paths), TOKEN_2);
    assert.equal(cleared, 1, "the last account's windows are dropped");
    assert.equal(claudeToken(join(paths.dir, "none"), paths.home, () => activeClaudeToken(paths)), TOKEN_2);
    assert.deepEqual(
      accountsView(paths).accounts.map((a) => [a.label, a.active]),
      [["me@example.com", false], ["Work", true]],
    );
    await useAccount({ provider: "claude", id: null }, quiet, paths);
    assert.equal(activeClaudeToken(paths), null);
    assert.equal(accountsView(paths).computer.claude.active, true);

    // The same organization again replaces its token rather than adding a second account.
    await addClaudeAccount({ token: `sk-ant-oat01-${"c".repeat(40)}` }, async () => ({ org: OTHER_ORG }), paths);
    assert.equal(accountsView(paths).accounts.length, 2);
  } finally {
    paths.done();
  }
});

test("a pasted Claude token that is not one, or that Anthropic refuses, keeps nothing", async () => {
  const paths = setup();
  try {
    await assert.rejects(addClaudeAccount({ token: "hello" }, async () => ({ org: ORG }), paths), /claude setup-token/);
    await assert.rejects(
      addClaudeAccount({ token: TOKEN }, async () => {
        throw new Error("refused");
      }, paths),
      /refused/,
    );
    assert.deepEqual(accountsView(paths).accounts, []);
  } finally {
    paths.done();
  }
});

test("the Claude gauge of an account apart is the windows its replies carried", async () => {
  const paths = setup();
  try {
    const work = await addClaudeAccount({ token: TOKEN_2, label: "Work" }, async () => ({ org: OTHER_ORG }), paths);
    const limits = join(paths.dir, "limits.json");
    writeFileSync(limits, JSON.stringify({ at: 1, fiveHour: { utilization: 0.18, reset: 2000 }, sevenDay: { utilization: 0.83, reset: 3000 } }));
    assert.equal(claudeApartUsage(paths, limits), null, "none picked: the collector's reading stands");
    await useAccount({ provider: "claude", id: work.id }, quiet, paths);
    const apart = claudeApartUsage(paths, limits);
    assert.equal(apart?.account, "Work");
    assert.deepEqual(apart?.limits.map((l) => [l.label, l.percent]), [["Session (5-hour)", 0.18], ["Weekly (7-day)", 0.83]]);
    const own = await addClaudeAccount({ token: TOKEN }, async () => ({ org: ORG }), paths);
    await useAccount({ provider: "claude", id: own.id }, quiet, paths);
    assert.equal(claudeApartUsage(paths, limits), null, "this computer's own account: the collector reads it");
  } finally {
    paths.done();
  }
});

test("switching Codex swaps this computer's sign-in, saving the one it replaces first, and never while codex runs", async () => {
  const paths = setup();
  const live = join(paths.home, ".codex", "auth.json");
  try {
    mkdirSync(join(paths.home, ".codex"));
    writeFileSync(live, codexAuth("laptop@example.com", "acct-laptop"), { mode: 0o600 });
    const laptop = saveLiveCodex(paths);
    assert.equal(laptop?.email, "laptop@example.com");
    assert.equal(accountsView(paths).computer.codex.saved, true);

    // A second account, signed in elsewhere and saved here.
    mkdirSync(join(paths.dir, "codex-mbp00001", "codex"), { recursive: true });
    writeFileSync(join(paths.dir, "codex-mbp00001", "codex", "auth.json"), codexAuth("mbp@example.com", "acct-mbp"), { mode: 0o600 });
    const book = JSON.parse(readFileSync(paths.book, "utf8")) as { active: object; accounts: object[] };
    book.accounts.push({ id: "codex-mbp00001", provider: "codex", label: "MacBook's", email: "mbp@example.com", ref: "acct-mbp", addedAt: "x" });
    writeFileSync(paths.book, JSON.stringify(book), { mode: 0o600 });

    await assert.rejects(useAccount({ provider: "codex", id: "codex-mbp00001" }, { ...quiet, codexRunning: async () => true }, paths), /codex is running/);
    assert.match(readFileSync(live, "utf8"), /acct-laptop/, "nothing changed while codex ran");

    // codex refreshed the live sign-in since it was saved: switching away keeps the fresher one.
    writeFileSync(live, codexAuth("laptop@example.com", "acct-laptop").replace("rt-acct-laptop", "rt-fresher"), { mode: 0o600 });
    await useAccount({ provider: "codex", id: "codex-mbp00001" }, quiet, paths);
    assert.match(readFileSync(live, "utf8"), /acct-mbp/);
    assert.equal(statSync(live).mode & 0o777, 0o600);
    assert.match(readFileSync(join(paths.dir, laptop!.id, "codex", "auth.json"), "utf8"), /rt-fresher/);
    assert.deepEqual(
      accountsView(paths).accounts.map((a) => [a.label, a.active]),
      [["laptop@example.com", false], ["MacBook's", true]],
    );

    await useAccount({ provider: "codex", id: laptop!.id }, quiet, paths);
    assert.match(readFileSync(live, "utf8"), /rt-fresher/);

    // Removing the one in use keeps this computer signed in; only the saved copy goes.
    removeAccount({ id: laptop!.id }, paths);
    assert.match(readFileSync(live, "utf8"), /acct-laptop/);
    assert.equal(accountsView(paths).accounts.length, 1);
  } finally {
    paths.done();
  }
});

test("the Codex broker gets only request headers from the active sign-in", () => {
  const paths = setup();
  try {
    assert.deepEqual(codexCredentialFromAuth(codexAuth("me@example.com", "acct-me")), {
      authorization: "Bearer at-acct-me",
      "chatgpt-account-id": "acct-me",
    });
    assert.equal(codexCredentialFromAuth(JSON.stringify({ tokens: { refresh_token: "never enough" } })), null);
    mkdirSync(join(paths.home, ".codex"));
    writeFileSync(join(paths.home, ".codex", "auth.json"), codexAuth("me@example.com", "acct-me"), { mode: 0o600 });
    assert.deepEqual(activeCodexCredential(paths.home), {
      authorization: "Bearer at-acct-me",
      "chatgpt-account-id": "acct-me",
    });
  } finally {
    paths.done();
  }
});

test("a new Codex account signs in with codex's device code, shown to you, and is kept when it finishes", async () => {
  const paths = setup();
  const bin = join(paths.home, "fake-codex.cjs");
  // Prints what codex prints, waits for "the browser", then writes the sign-in into its CODEX_HOME.
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'console.log("1. Open this link in your browser and sign in to your account\\n   \\u001b[94mhttps://auth.openai.com/codex/device\\u001b[0m\\n\\n2. Enter this one-time code (expires in 15 minutes)\\n   ABCD-EFGHI");',
      `setTimeout(() => { fs.writeFileSync(process.env.CODEX_HOME + "/auth.json", ${JSON.stringify(codexAuth("new@example.com", "acct-new"))}, { mode: 0o600 }); process.exit(0); }, 300);`,
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  try {
    const login = await startCodexLogin({ label: "Side project" }, paths, bin);
    assert.equal(login.url, "https://auth.openai.com/codex/device");
    assert.equal(login.code, "ABCD-EFGHI");
    for (let i = 0; i < 40 && codexLoginStatus(login.id).state === "waiting"; i += 1) await new Promise((r) => setTimeout(r, 100));
    const done = codexLoginStatus(login.id);
    assert.equal(done.state, "done");
    assert.equal(done.account?.label, "Side project");
    assert.equal(done.account?.email, "new@example.com");
    assert.equal(accountsView(paths).accounts.length, 1);
  } finally {
    paths.done();
  }
});
