#!/usr/bin/env node
// ste-check: checks a report.json against the STE rules.
//
//   ste-check report.json [--dictionary <file>] [--markdown <out.md>] [--json]
//   ste-check --rules        # the rules and the report format, for a writer
//
// Exit 0 when the report is clean, 1 when it has violations, 2 when the file
// is not a valid report. The dictionary is --dictionary, then
// $COBRA_STE_DICTIONARY, then ~/.config/cobra-agent/ste-dictionary.json,
// then data/dictionary.json in the repo. Without one, the word checks W1, V1
// and N1 do not run, and the output says so.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { checkDraft } from "./check.ts";
import { parseDictionary, type Dictionary } from "./dictionary.ts";
import { reportToMarkdown } from "./markdown.ts";
import { parseDraft, REPORT_FORMAT, STE_RULES } from "./prompt.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dictionary: { type: "string" },
    markdown: { type: "string" },
    json: { type: "boolean", default: false },
    rules: { type: "boolean", default: false },
  },
});

if (values.rules) {
  console.log(`${STE_RULES}\n\n${REPORT_FORMAT}`);
  process.exit(0);
}

const file = positionals[0];
if (!file) {
  console.error("usage: ste-check report.json [--dictionary <file>] [--markdown <out.md>] [--json] | ste-check --rules");
  process.exit(2);
}

function loadDictionary(): Dictionary | undefined {
  const config = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cobra-agent", "ste-dictionary.json");
  const repo = fileURLToPath(new URL("../data/dictionary.json", import.meta.url));
  const path = values.dictionary ?? process.env.COBRA_STE_DICTIONARY ?? [config, repo].find((p) => existsSync(p));
  if (!path) return undefined;
  return parseDictionary(JSON.parse(readFileSync(path, "utf8")));
}

const parsed = parseDraft(readFileSync(file, "utf8"));
if (!parsed.ok) {
  console.error(`ste-check: ${file}: ${parsed.error}`);
  process.exit(2);
}

const check = checkDraft(parsed.draft, { dictionary: loadDictionary() });
if (values.markdown) writeFileSync(values.markdown, reportToMarkdown(parsed.draft, check));

if (values.json) {
  console.log(JSON.stringify(check, null, 2));
} else {
  for (const v of check.violations) {
    const use = v.use?.length ? ` Use: ${v.use.join(" / ")}.` : "";
    console.log(`${v.where}  ${v.check}${v.heuristic ? "?" : ""}  ${v.message}${use}`);
  }
  const n = check.violations.length;
  console.log(
    `${check.sentences} sentences, ${n === 0 ? "no violations" : `${n} violation${n === 1 ? "" : "s"}`}` +
      (check.dictionary ? "." : ". No dictionary loaded, so W1, V1 and N1 did not run."),
  );
}
process.exit(check.violations.length === 0 ? 0 : 1);
