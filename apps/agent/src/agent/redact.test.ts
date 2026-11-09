import { test } from "node:test";
import assert from "node:assert/strict";

import { entropy, looksRandom, REDACTED, REDACTED_EMAIL, scrubSecrets } from "./redact.ts";

/** Each secret's line, and what must be left of it. */
const SECRETS: ReadonlyArray<[string, string, string]> = [
  ["Anthropic key", "+ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf0123456789_xyzXYZ-0123456789", "+ANTHROPIC_API_KEY=sk-ant-[redacted]"],
  ["OpenAI key in code", '+const client = new OpenAI({ apiKey: "sk-proj-Ab12Cd34Ef56Gh78Ij90Kl12Mn34" });', '+const client = new OpenAI({ apiKey: "sk-proj-[redacted]" });'],
  ["plain sk- key", "+key sk-0123456789abcdefABCDEF0123", "+key sk-[redacted]"],
  ["GitHub classic PAT", "+  run: git clone https://ghp_AbCdEf0123456789AbCdEf0123456789AbCd@github.com/x/y", "+  run: git clone https://ghp_[redacted]@github.com/x/y"],
  ["GitHub OAuth token", "+ token gho_AbCdEf0123456789AbCdEf0123456789AbCd", "+ token gho_[redacted]"],
  ["GitHub app token", "+ ghs_AbCdEf0123456789AbCdEf0123456789AbCd", "+ ghs_[redacted]"],
  ["fine-grained PAT", "+GH=github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789", "+GH=github_pat_[redacted]"],
  ["AWS key id", "+aws_access_key_id = AKIAIOSFODNN7EXAMPLE", "+aws_access_key_id = AKIA[redacted]"],
  ["AWS key id in prose", "+the key AKIAIOSFODNN7EXAMPLE leaked", "+the key AKIA[redacted] leaked"],
  ["Slack bot token", "+SLACK=xox" + "b-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx", "+SLACK=xoxb-[redacted]"],
  ["Slack user token", "+ xox" + "p-123456789012-abcdefgh", "+ xoxp-[redacted]"],
  ["password=", "+DB_PASSWORD=hunter2hunter2", "+DB_PASSWORD=[redacted]"],
  ["password: quoted", '+  "password": "c0rr3ct-h0rse!"', '+  "password": "[redacted]"'],
  ["secret= with symbols", "+client_secret=Ab!d/ef+gh=ij", "+client_secret=[redacted]"],
  ["token: yaml", "+  token: 9f8e7d6c5b4a39281706", "+  token: [redacted]"],
  ["TS assignment", "+const authToken = 'aB3dE5gH7jK9mN1pQ3sT';", "+const authToken = '[redacted]';"],
  ["URL password", "+DATABASE_URL=postgres://app:s3cretPass@db.internal:5432/app", "+DATABASE_URL=postgres://app:[redacted]@db.internal:5432/app"],
  ["random base64", "+const signingKey = \"q8Zt3Lw9XbVn2Rk7Hy5Jm1Pd4Gf6Sc0AeUo8Ti3W\";", '+const signingKey = "[redacted]";'],
  ["random hex", "+SESSION_SALT=4f9a1c3e8b7d2f6a0c5e9b1d3f7a2c8e", "+SESSION_SALT=[redacted]"],
  ["reset link's token in the query", "Reset it here: https://app.example.com/reset?token=Zk3x9QpL2mV8tR4wY7bN1cD6fH0jK5sA&utm_source=mail", "Reset it here: https://app.example.com/reset?token=[redacted]&utm_source=mail"],
  ["reset link's token in the path", "<https://app.example.com/reset-password/Zk3x9QpL2mV8tR4wY7bN1cD6fH0jK5sA>", "<https://app.example.com/reset-password/[redacted]>"],
  ["magic sign-in link", "https://example.com/auth/magic?code=8a7f6e5d4c3b2a19", "https://example.com/auth/magic?code=[redacted]"],
  ["signed link's signature", "(https://files.example.com/d/report.pdf?X-Amz-Signature=4f9a1c3e8b7d2f6a0c5e9b1d3f7a2c8e&X-Amz-Expires=600)", "(https://files.example.com/d/report.pdf?X-Amz-Signature=[redacted]&X-Amz-Expires=600)"],
  ["token in a fragment", "https://app.example.com/callback#access_token=AbCdEf0123456789xyz&type=bearer", "https://app.example.com/callback#access_token=[redacted]&type=bearer"],
  ["JWT", "+Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "+Authorization: Bearer eyJ[redacted]"],
];

for (const [name, line, kept] of SECRETS) {
  test(`redacts: ${name}`, () => {
    assert.equal(scrubSecrets(line), kept);
  });
}

test("email addresses never reach memory, however they are written; a no-reply or git address names nobody", () => {
  const report = ["Done: sent 2 pay stubs to ana.perez@example.com and Ben <ben+payroll@mail.example.co.uk>.", "Cc: books@example.com; reply from \"Ana\" <ANA@Example.COM> came back.", "The parents list is in out/parents.csv."].join("\n");
  assert.equal(
    scrubSecrets(report),
    [`Done: sent 2 pay stubs to ${REDACTED_EMAIL} and Ben <${REDACTED_EMAIL}>.`, `Cc: ${REDACTED_EMAIL}; reply from "Ana" <${REDACTED_EMAIL}> came back.`, "The parents list is in out/parents.csv."].join("\n"),
  );
  // A clone URL, a commit trailer, a decorator, a scoped package and user@host are not people.
  for (const line of ["git clone git@github.com:octo-org/cobra.git", "Co-Authored-By: Claude <noreply@anthropic.com>", "From: GitHub <no-reply@github.com>", '+import { z } from "@cobra/contracts";', "+@Component({ selector: 'x' })", "ssh sam@mbp", "root@10.0.0.1"]) {
    assert.equal(scrubSecrets(line), line, line);
  }
  assert.equal(scrubSecrets(scrubSecrets(report)), scrubSecrets(report));
});

test("a private key block keeps its fence and the diff markers, never its body", () => {
  const diff = ["+const pem = `", "+-----BEGIN OPENSSH PRIVATE KEY-----", "+b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ", "+AAAAMwAAAAtzc2gtZWQyNTUxOQAAACD", "+-----END OPENSSH PRIVATE KEY-----", "+`;", " const after = 1;"].join("\n");
  const out = scrubSecrets(diff);
  assert.doesNotMatch(out, /b3BlbnNzaC1rZXktdjEA|AAAAMwAAAAtz/);
  assert.equal(out.split("\n").length, 7, "line for line");
  assert.match(out, /^\+-----BEGIN OPENSSH PRIVATE KEY-----\n\+\[redacted\]\n\+\[redacted\]\n\+-----END OPENSSH PRIVATE KEY-----$/m);
  assert.match(out, / const after = 1;$/);
  // One line, as in JSON.
  assert.equal(scrubSecrets('"key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBg\\n-----END PRIVATE KEY-----\\n"'), '"key": "-----BEGIN PRIVATE KEY-----[redacted]-----END PRIVATE KEY-----\\n"');
  // A block whose end never comes: everything after it goes.
  assert.equal(scrubSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\nMIIdef"), "-----BEGIN RSA PRIVATE KEY-----\n[redacted]\n[redacted]");
});

test("ordinary code and prose survive untouched", () => {
  const code = [
    "diff --git a/src/auth.ts b/src/auth.ts",
    "index 3f1a2b4..9c8d7e6 100644",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1,12 +1,14 @@",
    "+const token = process.env.GITHUB_TOKEN;",
    "+const token = await getToken(user);",
    "+export const password = config.auth.password;",
    '+  password: "",',
    '+  placeholder: "Enter your password",',
    '+  password: "Enter 8 characters or more",',
    "+  token: string;",
    '+type Secret = { secret: string; apiKey?: string };',
    "+if (token === expected) return true;",
    '+const tokenType = "access_token";',
    "+const secretName = `${prefix}-key`;",
    '+  "secrets": "${{ secrets.NPM_TOKEN }}",',
    '+  "integrity": "sha512-q8Zt3Lw9XbVn2Rk7Hy5Jm1Pd4Gf6Sc0AeUo8Ti3WabcDEF==",',
    "+const commit = \"a94a8fe5ccb19ba61c4c0873d391e987982fbbd3\";",
    "+const message = 'Ask the person before using tokens';",
    "+const className = \"sk-button-primary-large-outline\";",
    "+const task = desk-0123456789012345678901;",
    "+const url = \"https://docs.example.com/guides/getting-started\";",
    "+import { thisIsAVeryLongFunctionNameForTesting } from \"./components/SomethingLongComponent\";",
    "+  timeoutMs: 20_000,",
    "+API_URL=https://api.example.com/v1",
    "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
    "Claude-Session: https://claude.ai/code/session_01Vi8bYpmRGPKktovrj8A98c",
    "See https://github.com/octo-org/cobra/commit/a94a8fe5ccb19ba61c4c0873d391e987982fbbd3 and https://example.com/search?q=reset+password&page=2",
    "Sign in at https://app.example.com/login?next=/settings/billing-2026",
    "- Fixed #12: the login token now refreshes before expiry.",
  ].join("\n");
  assert.equal(scrubSecrets(code), code);
});

test("two assignments on one line: the second's secret is still hidden, the first name kept", () => {
  assert.equal(scrubSecrets('login: password = "hunter2-Plus-9"'), 'login: password = "[redacted]"');
  assert.equal(scrubSecrets("user=ada password=Tr0ub4dor&3"), "user=ada password=[redacted]");
  assert.equal(scrubSecrets("Subject: token: ghp_abcdefghijklmnopqrstuvwxyz0123"), "Subject: token: ghp_[redacted]");
  // A word followed by a colon is still read as text where nothing secret follows.
  assert.equal(scrubSecrets("Note: see below: nothing here"), "Note: see below: nothing here");
});

test("scrubbing twice changes nothing more", () => {
  const once = scrubSecrets(SECRETS.map(([, line]) => line).join("\n"));
  assert.equal(scrubSecrets(once), once);
  assert.ok(once.includes(REDACTED));
});

test("entropy and randomness: words are not random, keys are", () => {
  assert.ok(entropy("aaaaaaaa") === 0);
  assert.equal(looksRandom("thisIsAVeryLongFunctionNameForTestingThings"), false);
  assert.equal(looksRandom("q8Zt3Lw9XbVn2Rk7Hy5Jm1Pd4Gf6Sc0AeUo8Ti3W"), true);
  assert.equal(looksRandom("4f9a1c3e8b7d2f6a0c5e9b1d3f7a2c8e"), true);
  assert.equal(looksRandom("0123"), false);
});

test("scrubTokens: shapes only, so addresses, links and ids a model needs stay", async () => {
  const { scrubTokens } = await import("./redact.ts");
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";
  const text = `ana@example.com https://example.com/reset?code=abc123def456 commit 3f2a9c8e7d6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f sk-ant-api03-${"x9".repeat(20)} https://bob:hunter2pass@db.example.com\n${key}`;
  const out = scrubTokens(text);
  assert.match(out, /ana@example\.com/);
  assert.match(out, /reset\?code=abc123def456/);
  assert.match(out, /3f2a9c8e7d6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f/);
  assert.doesNotMatch(out, /x9x9/);
  assert.doesNotMatch(out, /hunter2pass/);
  assert.doesNotMatch(out, /b3BlbnNzaC1rZXktdjEAAAAA/);
  assert.match(out, /-----BEGIN OPENSSH PRIVATE KEY-----\[redacted\]-----END OPENSSH PRIVATE KEY-----/);
  // A key block cut off before its end is still taken out to the end.
  assert.doesNotMatch(scrubTokens("-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nmore"), /MIIEow/);
});
