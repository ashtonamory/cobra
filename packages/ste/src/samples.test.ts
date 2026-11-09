import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { checkDraft } from "./check.ts";
import { parseDraft } from "./prompt.ts";

// The two worked samples on the design review page. They stay clean, so the
// page never shows an answer the checker would reject.
for (const name of ["legion-linger", "evening-routine"]) {
  test(`the ${name} sample is valid and clean`, () => {
    const parsed = parseDraft(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
    assert.deepEqual(checkDraft(parsed.draft).violations, []);
  });
}
