import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Project } from "@cobra/contracts";

import type { StoredApproval } from "./approvals.ts";
import {
  BRAND_FONTS,
  brandCard,
  checkBrand,
  DESIGNER_FONTS,
  DESIGNER_TEMPLATES,
  designerFolders,
  designerNote,
  designsEntry,
  ensureDesignerFolders,
  codeFiles,
  findTessel,
  handleDesignerOrch,
  tesselExport,
  pngSize,
  settleBrand,
  tesselServer,
  withTessel,
  type DesignerDeps,
} from "./designer.ts";
import { NO_MCP } from "./mcp.ts";
import type { NewEntry } from "./thread.ts";

const temp = (name: string): string => mkdtempSync(join(tmpdir(), `designer-${name}-`));

/** A real PNG header (signature, IHDR) of the given size; enough for pngSize. */
function png(width: number, height: number): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write("IHDR", 12, "ascii");
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

const KIT = { colors: { brand: "#1F3A5F", accent: "#f2a541", ink: "#14161a", paper: "#f7f3ec" }, fonts: { heading: "montserrat", body: "Inter" } };

test("every brand font ships, with its licence, and every post template is a 1080 x 1350 post on the brand's tokens", () => {
  const files = readdirSync(DESIGNER_FONTS);
  for (const family of BRAND_FONTS) {
    const stem = family.replace(/ /g, "");
    assert.ok(files.some((file) => file.startsWith(stem) && file.endsWith(".ttf")), `${family} has a font file`);
    assert.ok(existsSync(join(DESIGNER_FONTS, "licenses", `${stem.toLowerCase()}-OFL.txt`)), `${family} has its licence`);
  }
  const templates = readdirSync(DESIGNER_TEMPLATES).filter((file) => file.endsWith(".tessel.json")).sort();
  assert.deepEqual(templates, [
    "announcement.tessel.json",
    // The email templates (scripts/email-designs.py): emailDesign.test.ts holds them to the email standard.
    "email-booking.tessel.json",
    "email-form-reply.tessel.json",
    "email-invoice.tessel.json",
    "email-newsletter.tessel.json",
    "email-outreach.tessel.json",
    "email-receipt.tessel.json",
    "event.tessel.json",
    "new-product.tessel.json",
    "quote.tessel.json",
    "sale.tessel.json",
    "website.tessel.json",
  ]);
  for (const file of templates) {
    // Tessel's IDs: a prefix and 10 Crockford base32 characters, so a template loads with no warning.
    const ids = [...readFileSync(join(DESIGNER_TEMPLATES, file), "utf8").matchAll(/"id": "([^"]+)"/g)].map((m) => m[1]!);
    for (const id of ids) assert.match(id, /^[a-z]_[0-9a-hjkmnp-tv-z]{10}$/, `${file}: ${id}`);
    assert.equal(new Set(ids).size, ids.length, `${file}: IDs are unique`);
  }
  for (const file of templates.filter((name) => name !== "website.tessel.json" && !name.startsWith("email-"))) {
    const doc = JSON.parse(readFileSync(join(DESIGNER_TEMPLATES, file), "utf8")) as {
      meta: { title: string; description: string };
      tokens: { colors: Record<string, string>; fonts: Record<string, string> };
      pages: { children: { name: string; width: number; height: number; children: { name: string }[] }[] }[];
    };
    const frame = doc.pages[0]!.children[0]!;
    assert.deepEqual([frame.name, frame.width, frame.height], ["Design", 1080, 1350], file);
    assert.ok(doc.meta.title && doc.meta.description.length > 40, `${file} says what goes where`);
    assert.deepEqual(Object.keys(doc.tokens.colors).sort(), ["color.accent", "color.brand", "color.ink", "color.paper"], file);
    assert.deepEqual(Object.keys(doc.tokens.fonts).sort(), ["font.body", "font.heading"], file);
    for (const family of Object.values(doc.tokens.fonts)) assert.ok(BRAND_FONTS.includes(family), `${file}: ${family} ships`);
    const names = frame.children.map((layer) => layer.name);
    assert.ok(names.includes("Headline") || names.includes("Quote"), `${file} has its words`);
    assert.ok(names.includes("Logo"), `${file} has a Logo layer`);
    // Every layer the description names exists, so the Designer never looks for one that is not there.
    for (const name of names) assert.ok(!/\d/.test(name), `${file}: ${name} is a plain name`);
  }
});

test("the website starter is the editorial standard: a home page at 1440 and 390, a column of sections that flow", () => {
  type Style = { font_family: string; font_weight: number; font_size: number };
  type Node = { name: string; kind: string; width: number; height: number; layout?: { direction: string; padding: number[] }; children?: Node[]; style?: Style; fills?: { color?: string }[] };
  const doc = JSON.parse(readFileSync(join(DESIGNER_TEMPLATES, "website.tessel.json"), "utf8")) as {
    meta: { description: string };
    tokens: { colors: Record<string, string>; fonts: Record<string, string> };
    pages: { children: Node[] }[];
  };
  const [desktop, phone] = doc.pages[0]!.children;
  assert.deepEqual([desktop!.name, desktop!.width, phone!.name, phone!.width], ["Desktop", 1440, "Phone", 390]);
  for (const family of Object.values(doc.tokens.fonts)) assert.ok(BRAND_FONTS.includes(family), `${family} ships`);
  const all = (node: Node): Node[] => [node, ...(node.children ?? []).flatMap(all)];
  for (const frame of [desktop!, phone!]) {
    assert.equal(frame.layout?.direction, "column");
    assert.deepEqual(frame.children!.map((section) => section.name), ["Hero", "Intro", "Band", "Services", "Facts", "Contact", "Footer"]);
    assert.ok(frame.children!.every((section) => section.kind === "frame" && section.layout), "every section flows");
    const nodes = all(frame);
    // Display type is light, never bold; every section but the photo bands opens with an eyebrow.
    for (const text of nodes.filter((node) => node.style?.font_family === "{font.heading}")) assert.ok(text.style!.font_weight <= 400, `${text.name} is not bold`);
    for (const section of frame.children!.filter((s) => !["Hero", "Band", "Footer"].includes(s.name))) {
      assert.ok(all(section).some((node) => /Eyebrow$/.test(node.name)), `${section.name} has an eyebrow`);
      assert.ok(section.layout!.padding[0]! >= 100, `${section.name} has 100 or more above it`);
    }
    const hero = frame.children![0]!;
    assert.ok(hero.height >= (frame === phone ? 0.85 * 844 : 900), "the hero fills the first screen");
    assert.ok(all(hero).some((node) => node.name === "Nav"), "the nav is over the hero");
    // The brand colour never fills a band.
    for (const section of frame.children!) assert.notEqual(section.fills?.[0]?.color, "{color.brand}", `${section.name} is on a neutral ground`);
  }
  assert.match(doc.meta.description, /never a post/);
  assert.match(doc.meta.description, /scale/);
});

test("designerFolders: a Space's folder when the project lives in one, else the project's own", () => {
  assert.deepEqual(designerFolders({ path: "/home/a/Spaces/happy-tails/designer" }, "/home/a/Spaces/happy-tails"), {
    base: "/home/a/Spaces/happy-tails",
    designs: "/home/a/Spaces/happy-tails/designs",
    exports: "/home/a/Spaces/happy-tails/designs/exports",
    brand: "/home/a/Spaces/happy-tails/brand",
  });
  assert.equal(designerFolders({ path: "/home/a/Projects/posts/" }).designs, "/home/a/Projects/posts/designs");
});

test("ensureDesignerFolders keeps the folders out of the project's git through its local exclude, once", () => {
  const repo = temp("repo");
  mkdirSync(join(repo, ".git", "info"), { recursive: true });
  writeFileSync(join(repo, ".git", "info", "exclude"), "# git's own\n*.swp");
  const folders = designerFolders({ path: repo });
  ensureDesignerFolders(folders, { path: repo });
  ensureDesignerFolders(folders, { path: repo });
  assert.ok(existsSync(folders.exports) && existsSync(folders.brand));
  const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
  assert.equal(exclude, "# git's own\n*.swp\n# Cobra's Designer\n/designs/\n/brand/\n");
  assert.ok(!existsSync(join(repo, ".gitignore")), "nothing to commit");

  // In a Space the folders are the Space's, and the seat's repository is left alone.
  const space = temp("space");
  const seat = join(space, "designer");
  mkdirSync(join(seat, ".git", "info"), { recursive: true });
  ensureDesignerFolders(designerFolders({ path: seat }, space), { path: seat });
  assert.ok(existsSync(join(space, "designs", "exports")));
  assert.ok(!existsSync(join(seat, ".git", "info", "exclude")));
});

test("findTessel: COBRA_TESSEL only as an absolute path that exists, else the usual places", () => {
  const there = new Set(["/opt/tessel", "/home/a/.local/bin/tessel", "/usr/bin/tessel"]);
  const exists = (path: string) => there.has(path);
  assert.equal(findTessel({ COBRA_TESSEL: "/opt/tessel" }, "/home/a", exists), "/opt/tessel");
  assert.equal(findTessel({ COBRA_TESSEL: "tessel" }, "/home/a", exists), null, "never a PATH search");
  assert.equal(findTessel({ COBRA_TESSEL: "/missing" }, "/home/a", exists), null);
  assert.equal(findTessel({}, "/home/a", exists), "/home/a/.local/bin/tessel");
  assert.equal(findTessel({}, "/home/b", exists), "/usr/bin/tessel");
  assert.equal(findTessel({}, "/home/b", () => false), null);
});

test("the tessel server works on the designs folder, reads photos and the brand, and runs without a prompt", () => {
  const folders = designerFolders({ path: "/s/acme/designer" }, "/s/acme");
  const server = tesselServer("/bin/tessel", folders, ["/home/a/Projects/.cobra-attachments"]);
  assert.deepEqual(server, {
    type: "stdio",
    command: "/bin/tessel",
    args: ["mcp", "--headless", "--root", "/s/acme/designs", "--templates", DESIGNER_TEMPLATES, "--fonts", DESIGNER_FONTS, "--images", "/s/acme/brand", "--images", "/home/a/Projects/.cobra-attachments"],
  });
  const merged = withTessel({ ...NO_MCP, servers: { github: { type: "stdio", command: "g", args: [] } }, names: ["github"], preAllowed: [] }, server);
  assert.deepEqual(Object.keys(merged.servers), ["github", "tessel"]);
  assert.deepEqual(merged.names, ["github", "tessel"]);
  assert.deepEqual(merged.preAllowed, ["tessel"]);
  assert.match(designerNote(folders, true), /\/s\/acme\/designs.*\/s\/acme\/brand\/brand\.json/);
  assert.match(designerNote(folders, false), /not installed/);
});

test("checkBrand: four colours, two shipped fonts, a logo only from the photos the person sent", () => {
  const space = temp("brand");
  const folders = designerFolders({ path: join(space, "designer") }, space);
  const sent = temp("sent");
  writeFileSync(join(sent, "logo.png"), png(200, 80));
  const brand = checkBrand({ ...KIT, logo: join(sent, "logo.png"), source: "  happytails.co.uk\nand the logo  " }, { id: "acme-designer" }, "Happy Tails", folders, [sent]);
  assert.deepEqual(brand.colors, { brand: "#1f3a5f", accent: "#f2a541", ink: "#14161a", paper: "#f7f3ec" });
  assert.deepEqual(brand.fonts, { heading: "Montserrat", body: "Inter" });
  assert.equal(brand.logo?.bytes, 33);
  assert.equal(brand.logo?.sha256, createHash("sha256").update(png(200, 80)).digest("hex"));
  assert.equal(brand.source, "happytails.co.uk and the logo");
  assert.equal(brand.folder, join(space, "brand"));

  const refused = (input: Record<string, unknown>, why: RegExp) => assert.throws(() => checkBrand(input, { id: "p" }, "P", folders, [sent]), why);
  refused({ ...KIT, colors: { ...KIT.colors, ink: "black" } }, /colors\.ink is a #rrggbb/);
  refused({ ...KIT, fonts: { heading: "Comic Sans", body: "Inter" } }, /fonts\.heading is one of Inter/);
  const elsewhere = temp("elsewhere");
  writeFileSync(join(elsewhere, "logo.png"), png(1, 1));
  refused({ ...KIT, logo: join(elsewhere, "logo.png") }, /must be in/);
  symlinkSync(join(elsewhere, "logo.png"), join(sent, "link.png"));
  refused({ ...KIT, logo: join(sent, "link.png") }, /symlink/);
  writeFileSync(join(sent, "notes.txt"), "x");
  refused({ ...KIT, logo: join(sent, "notes.txt") }, /PNG, JPEG or WebP/);
  refused({ ...KIT, logo: "logo.png" }, /absolute path/);

  const card = brandCard(brand);
  assert.equal(card.title, "Brand kit for Happy Tails");
  assert.match(card.body, /main #1f3a5f, accent #f2a541, text #14161a, background #f7f3ec/);
  assert.match(card.body, /Montserrat for headings, Inter for text/);
  assert.match(card.body, /Logo: logo\.png \(1 KB\)/);
});

function approvalOf(brand: ReturnType<typeof checkBrand>, state: string): StoredApproval {
  return { id: "ap_1", machine: "legion", kind: "brand", title: "Brand kit", body: "", createdAt: "", expiresAt: "", state, requestedBy: "foreman:p", brand };
}

test("settleBrand: Allow writes exactly the card, and the logo only if its bytes are unchanged", () => {
  const space = temp("settle");
  const folders = designerFolders({ path: join(space, "designer") }, space);
  const sent = temp("settle-sent");
  writeFileSync(join(sent, "logo.webp"), png(10, 10));
  const brand = checkBrand({ ...KIT, logo: join(sent, "logo.webp") }, { id: "p" }, "P", folders, [sent]);

  const allowed = settleBrand(approvalOf(brand, "allowed"), new Date("2026-10-31T12:00:00Z"));
  assert.equal(allowed.approval.state, "done");
  assert.match(allowed.news, /allowed the brand kit/);
  assert.deepEqual(JSON.parse(readFileSync(join(folders.brand, "brand.json"), "utf8")), {
    colors: brand.colors,
    fonts: brand.fonts,
    logo: "logo.webp",
    allowedAt: "2026-10-31T12:00:00.000Z",
  });
  assert.deepEqual(readFileSync(join(folders.brand, "logo.webp")), png(10, 10));

  writeFileSync(join(sent, "logo.webp"), png(11, 11));
  const changed = settleBrand(approvalOf(brand, "allowed"));
  assert.equal(changed.approval.state, "failed");
  assert.match(changed.news, /changed since the card was made/);

  const denied = settleBrand(approvalOf(brand, "denied"));
  assert.equal(denied.approval.state, "denied");
  assert.match(denied.news, /did not allow/);
});

test("designsEntry: 1 to 6 PNGs from the exports folder, with their sizes, and a caption", () => {
  const space = temp("show");
  const folders = designerFolders({ path: join(space, "designer") }, space);
  mkdirSync(folders.exports, { recursive: true });
  writeFileSync(join(folders.exports, "a.png"), png(1080, 1350));
  writeFileSync(join(folders.exports, "b.png"), png(1080, 1080));
  const entry = designsEntry({ files: ["exports/a.png", join(folders.exports, "b.png")], caption: " Two takes. Which one? " }, folders, "conv-1", new Date("2026-10-31T09:00:00Z"));
  assert.deepEqual(entry, {
    at: "2026-10-31T09:00:00.000Z",
    kind: "designs",
    conversation: "conv-1",
    text: "Two takes. Which one?",
    files: [
      { path: join(folders.exports, "a.png"), name: "a.png", bytes: 33, width: 1080, height: 1350 },
      { path: join(folders.exports, "b.png"), name: "b.png", bytes: 33, width: 1080, height: 1080 },
    ],
  });
  const refused = (input: Record<string, unknown>, why: RegExp) => assert.throws(() => designsEntry(input, folders, "c"), why);
  refused({ files: [], caption: "x" }, /1 to 6 PNGs/);
  refused({ files: Array(7).fill("exports/a.png"), caption: "x" }, /1 to 6 PNGs/);
  refused({ files: ["exports/a.png"] }, /caption is 1 to 600/);
  writeFileSync(join(folders.designs, "draft.png"), png(1, 1));
  refused({ files: ["draft.png"], caption: "x" }, /must be in/);
  refused({ files: ["exports/../../../etc/hostname"], caption: "x" }, /must be in|does not exist/);
  writeFileSync(join(folders.exports, "c.png"), "not a png at all, just words that go on and on");
  refused({ files: ["exports/c.png"], caption: "x" }, /not a PNG/);
  assert.deepEqual(pngSize(png(3, 4)), { width: 3, height: 4 });
  assert.equal(pngSize(Buffer.from("nope")), null);
});

function deps({ space, entries = [], approvals = [], website }: { space: string; entries?: NewEntry[]; approvals?: StoredApproval[]; website?: string | null }): DesignerDeps {
  const designer: Project = { id: "acme-designer", name: "Designer", path: join(space, "designer"), machine: "legion", session: "acme_designer", foremanTemplate: "designer" } as Project;
  const billing: Project = { ...designer, id: "acme-billing", foremanTemplate: "billing" } as Project;
  return {
    project: async (id) => [designer, billing].find((project) => project.id === id),
    place: () => ({ space, name: "Acme" }),
    images: () => [],
    website: async () => (website === null ? { none: "No Website Builder works for this company on this computer" } : { dir: website ?? join(space, "website") }),
    approvals: { load: () => approvals, save: (list) => approvals.splice(0, approvals.length, ...list) },
    notify: async () => {},
    thread: () => ({ append: (list) => entries.push(...list), current: () => "conv" }),
    log: () => {},
    now: () => Date.parse("2026-10-31T10:00:00Z"),
  };
}

test("only a Designer Foreman here proposes a brand kit or shows designs; one card waits at a time", async () => {
  const space = temp("routes");
  const approvals: StoredApproval[] = [];
  const d = deps({ space, approvals });
  const body = JSON.stringify(KIT);
  const foreman = { id: "foreman:acme-designer", kind: "lead", project: "acme-designer" };
  assert.equal((await handleDesignerOrch("/orch/brand/propose", body, { id: "lead", kind: "lead" }, d)).status, 403, "not the Lead");
  assert.equal((await handleDesignerOrch("/orch/brand/propose", body, { ...foreman, project: "acme-billing" }, d)).status, 403, "not another trade");
  assert.equal((await handleDesignerOrch("/orch/brand/propose", "[1]", foreman, d)).status, 400);

  const made = await handleDesignerOrch("/orch/brand/propose", body, foreman, d);
  assert.equal(made.status, 202);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.kind, "brand");
  assert.equal(approvals[0]!.title, "Brand kit for Acme");
  assert.equal(approvals[0]!.brand?.folder, join(space, "brand"));
  assert.equal((await handleDesignerOrch("/orch/brand/propose", body, foreman, d)).status, 409, "one waits at a time");
  const bad = await handleDesignerOrch("/orch/brand/propose", JSON.stringify({ ...KIT, fonts: { heading: "Papyrus", body: "Inter" } }), foreman, d);
  assert.equal(bad.status, 400);

  const entries: NewEntry[] = [];
  const shows = deps({ space, entries });
  mkdirSync(join(space, "designs", "exports"), { recursive: true });
  writeFileSync(join(space, "designs", "exports", "post.png"), png(1080, 1350));
  const show = JSON.stringify({ files: ["exports/post.png"], caption: "Here it is." });
  const shown = await handleDesignerOrch("/orch/designs/show", show, foreman, shows);
  assert.equal(shown.status, 200);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.kind, "designs");
  assert.equal(entries[0]!.conversation, "conv");
  // The entry names a copy, so exporting over post.png later leaves what was shown as it was.
  const kept = entries[0]!.files![0]!;
  assert.match(kept.path, new RegExp(`^${join(space, "designs", "shown")}/2026-10-31T10-00-00-000Z/post\\.png$`));
  writeFileSync(join(space, "designs", "exports", "post.png"), png(10, 10));
  assert.deepEqual(readFileSync(kept.path), png(1080, 1350));
  const offHub = await handleDesignerOrch("/orch/designs/show", show, foreman, { ...shows, thread: () => ({ notHub: "Cobra's thread is on the hub, legion" }) });
  assert.deepEqual(offHub, { status: 409, body: { error: "Cobra's thread is on the hub, legion" } });
});

test("the picked website concept goes to design/concept/ with its images and renders, replacing the last", async () => {
  const space = temp("concept");
  const foreman = { id: "foreman:acme-designer", kind: "lead", project: "acme-designer" };
  const designs = join(space, "designs");
  mkdirSync(join(designs, "site", "b.assets"), { recursive: true });
  mkdirSync(join(designs, "exports"), { recursive: true });
  writeFileSync(join(designs, "site", "b.tessel.json"), "{}");
  writeFileSync(join(designs, "site", "b.assets", "0123abcd.png"), png(8, 8));
  writeFileSync(join(designs, "exports", "b-desktop.png"), png(1440, 3200));
  writeFileSync(join(designs, "exports", "b-phone.png"), png(780, 5600));
  mkdirSync(join(space, "website"), { recursive: true });
  writeFileSync(join(space, "website", "site.json"), "{}");
  const call = (body: Record<string, unknown>, d = deps({ space })) => handleDesignerOrch("/orch/designs/website", JSON.stringify(body), foreman, d);
  const pick = { file: "site/b.tessel.json", desktop: "exports/b-desktop.png", phone: join(designs, "exports", "b-phone.png") };

  const placed = await call(pick);
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  const concept = join(space, "website", "design", "concept");
  assert.deepEqual(readdirSync(concept).sort(), ["b.assets", "b.tessel.json", "concept-desktop.png", "concept-phone.png"]);
  assert.deepEqual(readFileSync(join(concept, "b.assets", "0123abcd.png")), png(8, 8));
  const { codeNote, ...body } = placed.body as Record<string, unknown>;
  assert.deepEqual(body, { website: join(space, "website"), files: ["b.tessel.json", "b.assets/ (1 images)", "concept-desktop.png", "concept-phone.png"], replaced: false, templateSite: true });
  assert.match(String(codeNote), /not exported \(Tessel is not on this computer\); the Website Builder builds from the renders/);
  assert.deepEqual(readdirSync(join(space, "website")).sort(), ["design", "site.json"], "nothing left beside it");

  writeFileSync(join(designs, "site", "c.tessel.json"), "{}");
  const again = await call({ ...pick, file: "site/c.tessel.json" });
  assert.equal((again.body as { replaced: boolean }).replaced, true);
  assert.deepEqual(readdirSync(concept).sort(), ["c.tessel.json", "concept-desktop.png", "concept-phone.png"], "the last concept is gone, its images too");

  const refused = async (body: Record<string, unknown>, status: number, error: RegExp) => {
    const reply = await call(body);
    assert.equal(reply.status, status, JSON.stringify(reply.body));
    assert.match((reply.body as { error: string }).error, error);
  };
  await refused({ ...pick, desktop: "exports/b-phone.png" }, 400, /export the Desktop frame/);
  await refused({ ...pick, phone: "exports/b-desktop.png" }, 400, /export the Phone frame/);
  await refused({ ...pick, file: "exports/b-desktop.png" }, 400, /\.tessel\.json/);
  await refused({ ...pick, file: "/etc/hostname" }, 400, /must be in/);
  writeFileSync(join(designs, "draft.png"), png(1440, 900));
  await refused({ ...pick, desktop: "draft.png" }, 400, /must be in/);
  symlinkSync("/etc", join(designs, "site", "d.assets"));
  writeFileSync(join(designs, "site", "d.tessel.json"), "{}");
  await refused({ ...pick, file: "site/d.tessel.json" }, 400, /not a folder/);
  const none = await call(pick, deps({ space, website: null }));
  assert.equal(none.status, 409);
  assert.deepEqual(readdirSync(concept).sort(), ["c.tessel.json", "concept-desktop.png", "concept-phone.png"], "a refused pick changes nothing");
});

test("codeFiles: only plain relative paths, base64 decoded, a bounded count", () => {
  assert.deepEqual(codeFiles([{ path: "index.html", language: "html", content: "<p>" }, { path: "assets/a.png", content: Buffer.from("png").toString("base64"), encoding: "base64" }]), [
    { path: "index.html", data: Buffer.from("<p>") },
    { path: "assets/a.png", data: Buffer.from("png") },
  ]);
  for (const path of ["../x.html", "/etc/passwd", "a/../../b", ".hidden", "a//b", "a\\b"]) assert.match(String(codeFiles([{ path, content: "" }])), /exported a file named/, path);
  assert.match(String(codeFiles([])), /no files/);
  assert.match(String(codeFiles(Array.from({ length: 121 }, (_, i) => ({ path: `f${i}.css`, content: "" })))), /at most 120/);
});

test("a placed concept's code goes to design/concept/code/desktop and phone; a failed export is a note, never a refusal", async () => {
  const space = temp("concept-code");
  const foreman = { id: "foreman:acme-designer", kind: "lead", project: "acme-designer" };
  const designs = join(space, "designs");
  mkdirSync(join(designs, "exports"), { recursive: true });
  writeFileSync(join(designs, "a.tessel.json"), "{}");
  writeFileSync(join(designs, "exports", "a-desktop.png"), png(1440, 3200));
  writeFileSync(join(designs, "exports", "a-phone.png"), png(780, 5600));
  mkdirSync(join(space, "website"), { recursive: true });
  const pick = { file: "a.tessel.json", desktop: "exports/a-desktop.png", phone: "exports/a-phone.png" };
  const asked: string[] = [];
  const d: DesignerDeps = {
    ...deps({ space }),
    conceptCode: async (file) => {
      asked.push(file);
      return { desktop: [{ path: "index.html", data: Buffer.from("<main>") }, { path: "styles.css", data: Buffer.from("main{}") }], phone: [{ path: "index.html", data: Buffer.from("<main class=p>") }] };
    },
  };
  const placed = await handleDesignerOrch("/orch/designs/website", JSON.stringify(pick), foreman, d);
  const concept = join(space, "website", "design", "concept");
  assert.equal((placed.body as { code: string }).code, join(concept, "code"));
  assert.deepEqual(asked, [join(concept, "a.tessel.json")], "the export reads the placed copy");
  assert.equal(readFileSync(join(concept, "code", "desktop", "styles.css"), "utf8"), "main{}");
  assert.equal(readFileSync(join(concept, "code", "phone", "index.html"), "utf8"), "<main class=p>");
  const failed = await handleDesignerOrch("/orch/designs/website", JSON.stringify(pick), foreman, { ...d, conceptCode: async () => ({ failed: "the concept has no Phone frame" }) });
  assert.equal(failed.status, 200);
  assert.match((failed.body as { codeNote: string }).codeNote, /no Phone frame/);
  assert.equal(existsSync(join(concept, "code")), false, "a new concept never keeps the last one's code");
});

test("tesselExport: the real Tessel exports the website starter's Desktop and Phone as HTML and CSS", { skip: findTessel() === null ? "Tessel is not on this computer" : false }, async () => {
  const dir = temp("tessel-export");
  writeFileSync(join(dir, "w.tessel.json"), readFileSync(join(DESIGNER_TEMPLATES, "website.tessel.json")));
  const code = await tesselExport(findTessel()!)(join(dir, "w.tessel.json"));
  assert.ok(!("failed" in code), JSON.stringify(code));
  for (const key of ["desktop", "phone"] as const) {
    const names = code[key].map((file) => file.path).sort();
    assert.ok(names.includes("index.html") && names.includes("styles.css"), `${key}: ${names.join(", ")}`);
    assert.match(code[key].find((file) => file.path === "index.html")!.data.toString(), /<html|<body|<div/);
  }
});
