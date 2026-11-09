// API lane spike: what run-live.sh found, scenario by scenario.
//
//   node summarize.ts <run-live.sh's folder>
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Entry = { lane?: string; status?: number; path?: string; model?: string; error?: string; dollars?: number; movedBecause?: string };

const dir = process.argv[2] ?? ".";
let total = 0;
let broke = false;
for (const name of ["A", "B", "C", "D"]) {
  const file = join(dir, `${name}.jsonl`);
  if (!existsSync(file)) continue;
  const entries = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Entry);
  const lanes = entries.map((entry) => `${entry.lane === "api" ? "key" : "sub"}:${entry.status ?? "x"}`).join(" ");
  const spent = entries.reduce((sum, entry) => sum + (entry.dollars ?? 0), 0);
  total += spent;
  const thinking = entries.map((entry) => (entry as { usage?: { output_tokens_details?: { thinking_tokens?: number } } }).usage?.output_tokens_details?.thinking_tokens ?? 0);
  console.log(`\n${name}: ${entries.length} requests  ${lanes}  $${spent.toFixed(4)}  thinking tokens ${thinking.join(",")}`);
  for (const entry of entries) {
    if (entry.movedBecause) console.log(`   moved: ${entry.movedBecause}`);
    if (entry.error) {
      broke = true;
      console.log(`   ${entry.lane} ${entry.status}: ${entry.error.replace(/\s+/g, " ").slice(0, 400)}`);
    }
  }
  const answer = join(dir, `${name}.out`);
  if (existsSync(answer)) console.log(`   answer: ${readFileSync(answer, "utf8").trim().split("\n").slice(-2).join(" / ").slice(0, 200)}`);
}
console.log(`\nAPI spend this run: $${total.toFixed(4)}`);
console.log(broke ? "Something was refused: the lines above say what." : "No request was refused on either lane.");
