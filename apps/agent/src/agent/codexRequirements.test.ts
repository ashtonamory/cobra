import assert from "node:assert/strict";
import { test } from "node:test";

import { CODEX_ETC, codexPolicyHook, codexRequirements } from "./codexRequirements.ts";

test("Codex managed requirements require Cobra hooks and prohibit self-approved web access", () => {
  const hook = codexPolicyHook({ node: "/opt/node", policyHook: "/opt/cobra/policy hook.ts" }, "cobra_2");
  assert.deepEqual(hook, { event: "PreToolUse", matcher: "*", command: "/opt/node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON '/opt/cobra/policy hook.ts' cobra_2 --engine codex", timeout: 30 });
  const requirements = codexRequirements({ mode: "api", hooks: [hook] });
  assert.equal(CODEX_ETC, "/etc/codex");
  assert.match(requirements, /allow_managed_hooks_only = true/);
  assert.match(requirements, /allowed_approval_policies = \["never"\]/);
  assert.match(requirements, /allowed_web_search_modes = \["disabled"\]/);
  assert.match(requirements, /allowed_login_methods = \["api"\]/);
  assert.match(requirements, /\[\[hooks\.PreToolUse\]\][\s\S]*--engine codex/);
});
