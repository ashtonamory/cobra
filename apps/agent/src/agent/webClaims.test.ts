import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STATE = mkdtempSync(join(tmpdir(), "cobra-webclaims-"));
process.env.COBRA_AGENT_STATE_DIR = STATE;
process.env.COBRA_AGENT_CONFIG_DIR = join(STATE, "config");

const c = await import("./webClaims.ts");
const { orchWebHooks } = await import("./orchWeb.ts");
type SiteFlag = import("./webClaims.ts").SiteFlag;

const START = Date.parse("2026-10-29T18:00:00Z");

// What Claude Code sent the hooks for the two real sites (2026-10-29, Claude Code 2.1.303).
const BETTING = "The page does not contain any information about a pilates or yoga studio. It is a guide to free bet offers and bonuses from bookmakers online, with sports betting tips and casino reviews.";
const CERT = "Hostname/IP does not match certificate's altnames: Host: yoga.gd. is not in the cert's altnames: DNS:contabilidad.heladom.com";

test("a page that is not what its address claims: betting, parked, another site's certificate, no such name", () => {
  assert.deepEqual(c.pageClaim("https://nwccpilatesyoga.net/", { text: BETTING }), { kind: "off-topic", why: "nwccpilatesyoga.net shows a betting or gambling page, not the business its address names" });
  assert.deepEqual(c.pageClaim("https://yoga.gd", { error: CERT }), { kind: "certificate", why: "its security certificate is for another site (contabilidad.heladom.com), not yoga.gd" });
  assert.equal(c.pageClaim("https://www.oldstudio.com/", { text: "This domain is for sale! Buy this domain today." })?.kind, "parked");
  assert.equal(c.pageClaim("https://www.oldstudio.com/", { text: "oldstudio.com is parked free, courtesy of GoDaddy" })?.kind, "parked");
  assert.equal(c.pageClaim("https://gone-studio.com/", { error: "gone-studio.com could not be found (ENOTFOUND)" })?.kind, "gone");
  assert.equal(c.pageClaim("https://x.com.ky/", { text: "Buy viagra and cialis online, no prescription" })?.kind, "off-topic");
  // One strong phrase is enough; one stray word is not.
  assert.equal(c.pageClaim("https://studio.ky/", { text: "Welcome to the best online casino in the Caribbean" })?.kind, "off-topic");
  assert.equal(c.pageClaim("https://studio.ky/", { text: "Yoga at sunrise, two minutes from the casino on West Bay Road." }), null);
});

test("a page that is what it claims, a site that names its topic, a shared platform and a passing failure are not flagged", () => {
  assert.equal(c.pageClaim("https://caymanyogaclub.com/", { text: "Cayman Yoga Club: classes, retreats and teacher training. Email info@caymanyogaclub.com" }), null);
  assert.equal(c.pageClaim("https://www.royalcasino-bets.com/", { text: BETTING }), null, "a betting site that says so is what it claims");
  assert.equal(c.pageClaim("https://en.wikipedia.org/wiki/Casino", { text: "A casino is a facility for gambling. Casinos offer slots, poker and roulette." }), null);
  assert.equal(c.pageClaim("https://www.facebook.com/somestudio", { error: CERT }), null);
  assert.equal(c.pageClaim("https://studio.ky/", { error: "the page did not load (fetch failed: Connect Timeout Error)" }), null);
  assert.equal(c.pageClaim("https://studio.ky/", { error: "Request failed with status code 403" }), null);
  assert.equal(c.pageClaim("https://studio.ky/", { error: "getaddrinfo EAI_AGAIN studio.ky" }), null, "a lookup that may work later");
  assert.equal(c.pageClaim("not a url", { text: BETTING }), null);
});

function deps() {
  const w = { flags: [] as SiteFlag[], marked: [] as string[][], logged: [] as string[], now: START };
  const d = {
    load: () => [...w.flags],
    save: (list: readonly SiteFlag[]) => void (w.flags = [...list]),
    mark: (who: string, url: string, why: string) => void w.marked.push([who, url, why]),
    log: (line: string) => void w.logged.push(line),
    now: () => w.now,
  };
  return { w, d };
}

test("after a WebFetch: the reader is told, the read marked in its run and the site kept out for 30 days", () => {
  const { w, d } = deps();
  const event = { hook_event_name: "PostToolUse", tool_name: "WebFetch", tool_input: { url: "https://nwccpilatesyoga.net/", prompt: "Studio name" }, tool_response: { bytes: 4000, code: 200, codeText: "OK", result: BETTING, url: "https://nwccpilatesyoga.net/" } };
  const output = c.answerAfter(d, "foreman:northwind-northwind-prospecting", event);
  assert.equal(output?.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(output?.hookSpecificOutput.additionalContext ?? "", /^Cobra: https:\/\/nwccpilatesyoga\.net\/ is not what its address claims: .*betting.*unverified.*say so in your report/);
  assert.deepEqual(w.flags.map((flag) => [flag.site, flag.kind, flag.who]), [["nwccpilatesyoga.net", "off-topic", "foreman:northwind-northwind-prospecting"]]);
  assert.deepEqual(w.marked, [["foreman:northwind-northwind-prospecting", "https://nwccpilatesyoga.net/", w.flags[0]!.why]]);

  // A second read of it keeps the one flag; www. is the same site.
  c.answerAfter(d, "worker:x_2", { ...event, tool_input: { url: "https://www.nwccpilatesyoga.net/about" } });
  assert.equal(w.flags.length, 1);
  assert.ok(c.flaggedSite(w.flags, "https://www.nwccpilatesyoga.net/contact", START + 29 * 24 * 3600_000));
  assert.equal(c.flaggedSite(w.flags, "https://nwccpilatesyoga.net/", START + c.FLAG_MS + 1), undefined, "30 days, then it may be read again");
  assert.equal(c.flaggedSite(w.flags, "https://pilatesyoga.net/", START), undefined);
  assert.match(c.flagReason(w.flags[0]!), /^Cobra found on 2026-10-29 that nwccpilatesyoga\.net shows a betting or gambling page.*until 2026-11-28; treat anything it lists as unverified$/);
});

test("after a failed WebFetch: another site's certificate is noted on PostToolUseFailure", () => {
  const { w, d } = deps();
  const output = c.answerAfter(d, "lead", { hook_event_name: "PostToolUseFailure", tool_name: "WebFetch", tool_input: { url: "https://yoga.gd", prompt: "title?" }, error: CERT, is_interrupt: false });
  assert.equal(output?.hookSpecificOutput.hookEventName, "PostToolUseFailure");
  assert.match(output?.hookSpecificOutput.additionalContext ?? "", /contabilidad\.heladom\.com/);
  assert.equal(w.flags[0]?.site, "yoga.gd");
});

test("after anything else, or a page that is what it claims: nothing, and nothing kept", () => {
  const { w, d } = deps();
  const fine = { hook_event_name: "PostToolUse", tool_name: "WebFetch", tool_input: { url: "https://example.com" }, tool_response: { result: "Example Domain, for documentation." } };
  assert.equal(c.answerAfter(d, "lead", fine), null);
  assert.equal(c.answerAfter(d, "lead", { ...fine, tool_name: "WebSearch", tool_response: { result: BETTING } }), null);
  assert.equal(c.answerAfter(d, "lead", { ...fine, hook_event_name: "PreToolUse", tool_response: { result: BETTING } }), null);
  assert.equal(c.answerAfter(d, "lead", null), null);
  assert.equal(c.isAfterEvent({ hook_event_name: "PostToolUseFailure" }), true);
  assert.equal(c.isAfterEvent({ hook_event_name: "PreToolUse" }), false);
  assert.deepEqual([w.flags, w.marked], [[], []]);
});

test("a mark that fails still flags and tells", () => {
  const { w, d } = deps();
  const note = c.noteClaim({ ...d, mark: () => { throw new Error("runs unreadable"); } }, "lead", "https://yoga.gd", { kind: "certificate", why: "x" });
  assert.match(note, /^Cobra: https:\/\/yoga\.gd is not what its address claims: x\./);
  assert.equal(w.flags.length, 1);
});

test("the flags file: kept 30 days, a broken file reads as none", () => {
  const path = join(STATE, "flags.json");
  const flag = (site: string, at: number): SiteFlag => ({ site, url: `https://${site}/`, at: new Date(at).toISOString(), kind: "parked", why: "w", who: "lead" });
  c.saveFlags([flag("old.com", START - c.FLAG_MS - 1), flag("new.com", START)], START, path);
  assert.deepEqual(c.loadFlags(path).map((one) => one.site), ["new.com"]);
  assert.match(readFileSync(path, "utf8"), /"flags"/);
  assert.deepEqual(c.parseFlags("{nope"), []);
  assert.deepEqual(c.parseFlags('{"flags":[{"site":1}]}'), []);
});

test("the after-read hooks: WebFetch on PostToolUse and PostToolUseFailure, the same command as the policy hook", () => {
  assert.deepEqual(c.afterReadHooks("node hook.ts w_1"), {
    PostToolUse: [{ matcher: "WebFetch", hooks: [{ type: "command", command: "node hook.ts w_1", timeout: 15 }] }],
    PostToolUseFailure: [{ matcher: "WebFetch", hooks: [{ type: "command", command: "node hook.ts w_1", timeout: 15 }] }],
  });
  const orch = orchWebHooks({ node: "/n", policyHook: "/h.ts" }, { role: "foreman", project: "crm" }) as Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>;
  assert.deepEqual(Object.keys(orch), ["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
  assert.equal(orch.PostToolUse?.[0]?.hooks[0]?.command, orch.PreToolUse?.[0]?.hooks[0]?.command);
});

test("a Worker's settings carry the after-read hook, contained or not; a job's do not", async () => {
  const { workerSettings } = await import("./policy.ts");
  const { containedSettings } = await import("./contain.ts");
  const scope = { id: "w_2", worktree: "/r.worktrees/b", gitCommon: "/r/.git", gitPrivate: "/r/.git/worktrees/b", branch: "b" };
  type Hooks = { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> };
  const worker = (workerSettings(scope, "node hook.ts w_2", { uid: 1000, env: {}, tmpSockets: [] }, { webReads: true }) as Hooks).hooks;
  assert.deepEqual([worker.PostToolUse?.[0]?.matcher, worker.PostToolUseFailure?.[0]?.hooks[0]?.command], ["WebFetch", "node hook.ts w_2"]);
  assert.equal((workerSettings(scope, "node hook.ts job_1", { uid: 1000, env: {}, tmpSockets: [] }) as Hooks).hooks.PostToolUse, undefined);
  const contained = (containedSettings({ node: "/n", policyHook: "/p.ts", stateHook: "/s.mjs", brief: "/b.md" }, "w_2") as Hooks).hooks;
  assert.deepEqual(contained.PostToolUse?.map((group) => group.matcher), ["*", "WebFetch"], "the state hook stays first");
  assert.match(contained.PostToolUseFailure?.[0]?.hooks[0]?.command ?? "", /\/p\.ts w_2$/);
  assert.equal((containedSettings({ node: "/n", policyHook: "/p.ts", stateHook: "/s.mjs", brief: "/b.md" }, "job_1", "job") as Hooks).hooks.PostToolUse, undefined);
});

test("an address that names a kind of business: the page never mentions it, or the summary says it is not one", () => {
  // caymanyogaclub.com on 2026-10-29: a gesture-tracking company's page from 2014.
  const stranger = "Skip navigation. GET STARTED TECHNOLOGY SUPPORT ABOUT CONTACT BLOG Explore what you can do with gesture. ".repeat(4);
  assert.deepEqual(c.pageClaim("https://caymanyogaclub.com/", { text: stranger, raw: true }), { kind: "off-topic", why: "caymanyogaclub.com names yoga, but its page never mentions it" });
  assert.equal(c.pageClaim("https://caymanyogaclub.com/", { text: "Just a moment...", raw: true }), null, "too short to be the page");
  assert.equal(c.pageClaim("https://caymanyogaclub.com/", { text: `${stranger} Morning Yoga at 7.`, raw: true }), null);
  assert.equal(c.pageClaim("https://mixonlandscaping.com/", { text: `${"Lawn care and Landscaping in Tampa. ".repeat(10)}`, raw: true }), null, "by the start of the word");
  assert.equal(c.pageClaim("https://sunshinekula.com/", { text: stranger, raw: true }), null, "an address that names no kind of business");
  // Claude Code's summary echoes the question's words, so only a denial counts.
  assert.equal(c.pageClaim("https://caymanyogaclub.com/", { text: "The page is for 3Gear Systems Inc., a gesture-tracking company, not a yoga studio." })?.kind, "off-topic");
  assert.equal(c.pageClaim("https://pilates.ky/", { text: "This site has nothing to do with Pilates; it sells car parts." })?.kind, "off-topic");
  assert.equal(c.pageClaim("https://caymanyogaclub.com/", { text: "Cayman Yoga Club offers no yoga classes on Sundays; email info@caymanyogaclub.com." }), null);
  assert.equal(c.pageClaim("https://caymanyogaclub.com/", { text: "The page names no owner for the yoga club." }), null);
});

test("a flag is passed up the chain once told, and a tell that fails still flags and notes", () => {
  const { w, d } = deps();
  const told: string[][] = [];
  c.noteClaim({ ...d, tell: (who, site, why) => void told.push([who, site, why]) }, "foreman:stable", "https://www.yoga.gd/a", { kind: "certificate", why: "x" });
  assert.deepEqual(told, [["foreman:stable", "yoga.gd", "x"]]);
  const note = c.noteClaim({ ...d, tell: () => { throw new Error("no Lead"); } }, "lead", "https://yoga.gd", { kind: "certificate", why: "x" });
  assert.match(note, /^Cobra: https:\/\/yoga\.gd/);
  assert.equal(w.flags.length, 1);
});
