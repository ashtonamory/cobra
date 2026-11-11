import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Before the agent's modules load: paths.ts reads these once.
const ROOT = mkdtempSync(join(tmpdir(), "cobra-email-editor-"));
process.env.COBRA_AGENT_CONFIG_DIR = join(ROOT, "config");
process.env.COBRA_AGENT_STATE_DIR = join(ROOT, "state");
process.env.COBRA_AGENT_DATA_DIR = join(ROOT, "data");

const { EmailQueue } = await import("./emailQueue.ts");
const { emailFolders, readDraft } = await import("./emailFiles.ts");
const { handleEmailEditor } = await import("./emailRoutes.ts");

type StoredApproval = import("./approvals.ts").StoredApproval;
type EmailRouteDeps = import("./emailRoutes.ts").EmailRouteDeps;
type Project = import("@cobra/contracts").Project;

const BRAND = { colors: { brand: "#0b1f3a", accent: "#f5b301", ink: "#0b1220", paper: "#f6f4ee" }, fonts: { heading: "Inter", body: "Inter" } };
const PERSON = new Set(["desk"]);
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

function world() {
  const dir = mkdtempSync(join(tmpdir(), "cobra-editor-space-"));
  mkdirSync(join(dir, "brand"));
  writeFileSync(join(dir, "brand", "brand.json"), JSON.stringify(BRAND));
  mkdirSync(join(dir, "email", "images"), { recursive: true });
  writeFileSync(join(dir, "email", "images", "studio.png"), PNG);
  writeFileSync(join(dir, "email", "images", ".hidden.png"), PNG);
  const space = { id: "s1", dir, name: "Happy Tails" };
  const project = { id: "p1", name: "Studio", path: join(dir, "studio") } as Project;
  let approvals: StoredApproval[] = [];
  const told: string[] = [];
  const deps: EmailRouteDeps = {
    project: async (id) => (id === "p1" ? project : undefined),
    space: () => space,
    spaceById: (id) => (id === "s1" ? space : null),
    place: () => ({ brand: BRAND as never, business: "Happy Tails", address: "1 High St, Leeds" }),
    queue: () => new EmailQueue(join(dir, "q.db")),
    person: () => null,
    approvals: { load: () => structuredClone(approvals), save: (list) => void (approvals = structuredClone(list)) },
    notify: async (a) => void told.push(a.title),
    log: () => {},
    now: () => Date.parse("2026-11-02T15:00:00Z"),
    hookStart: () => null,
  };
  const get = (route: string, query: string, kind = "desk") => handleEmailEditor(route, "GET", new URL(`http://x${route}?${query}`), "", { kind }, deps, PERSON);
  const post = (route: string, body: Record<string, unknown>) => handleEmailEditor(route, "POST", new URL(`http://x${route}`), JSON.stringify(body), { kind: "desk" }, deps, PERSON);
  return { dir, get, post, approvals: () => approvals, told };
}

test("phase 6: the desk lists a Space's templates and images, starts from a starter, draws live, and proposes a template card", async () => {
  const w = world();
  assert.equal((await w.get("/email/templates", "project=p1", "lead")).status, 403, "a phone's or desk's key only");
  assert.equal((await w.get("/email/templates", "project=nope")).status, 404);
  const listed = (await w.get("/email/templates", "project=p1")).body as { space: { name: string }; templates: unknown[]; images: string[]; blockKinds: string[]; starters: { id: string }[] };
  assert.equal(listed.space.name, "Happy Tails");
  assert.deepEqual(listed.images, ["studio.png"]);
  assert.equal(listed.blockKinds.length, 12);
  assert.ok(listed.starters.some((s) => s.id === "receipt"));

  const started = (await w.get("/email/template", "project=p1&starter=form-reply")).body as { template: Record<string, unknown>; from: string };
  assert.equal(started.from, "starter");

  // The editor moved an image block in and changed the words; each draw checks it.
  const template = { ...started.template, name: "Thanks for writing", blocks: [{ kind: "header" }, { kind: "image", image: { src: "images/studio.png", alt: "The studio" } }, { kind: "text", body: "Thanks, {first_name}. We will write back today." }, { kind: "footer" }] };
  const bad = (await w.post("/email/template/draw", { project: "p1", template: { ...template, blocks: [{ kind: "hero" }] } })).body as { errors: string[] };
  assert.ok(bad.errors.length > 0);
  const drawn = (await w.post("/email/template/draw", { project: "p1", template })).body as { html: string; errors: string[]; subject: string };
  assert.deepEqual(drawn.errors, []);
  assert.match(drawn.html, /Thanks, Alex\. We will write back today\./);

  const proposed = await w.post("/email/template/propose", { project: "p1", slug: "thanks", template });
  assert.equal(proposed.status, 202, JSON.stringify(proposed.body));
  const card = w.approvals()[0]!;
  assert.equal(card.kind, "email_template");
  assert.equal(card.title, "New email: Thanks for writing");
  assert.equal(card.emailTemplate!.project, "p1", "its Foreman hears the answer");
  assert.equal(card.requestedBy, "person");
  assert.ok(readDraft(emailFolders(w.dir), "thanks"));
  assert.deepEqual(w.told, ["New email: Thanks for writing"]);
  assert.equal((await w.get("/email/template", "project=p1&slug=thanks")).status, 200);
});
