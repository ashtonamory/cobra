// @vitest-environment jsdom
/**
 * Smoke: every page and surface rendered for real (React + jsdom) against a rich, contract-shaped
 * fleet, with the Tauri side mocked. Catches what type-checks and unit tests cannot: a render that
 * throws, an effect that loops, a missing key. Any console.error fails the test.
 */
import { act, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

// -- the Tauri side --------------------------------------------------------------------------------

type Handler = (e: { event: string; id: number; payload: unknown }) => void;
const tauri = vi.hoisted(() => ({
  handlers: new Map<string, Set<(e: { event: string; id: number; payload: unknown }) => void>>(),
  emitted: [] as Array<{ target: string; event: string; payload: unknown }>,
  invoked: [] as Array<{ cmd: string; args: unknown }>,
  unknown: new Set<string>(),
  route: null as null | ((cmd: string, args: Record<string, unknown>) => unknown),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    tauri.invoked.push({ cmd, args });
    return tauri.route!(cmd, args);
  },
  convertFileSrc: (p: string) => p,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, fn: Handler) => {
    if (!tauri.handlers.has(event)) tauri.handlers.set(event, new Set());
    tauri.handlers.get(event)!.add(fn);
    return () => void tauri.handlers.get(event)?.delete(fn);
  },
  emit: async () => {},
  emitTo: async (target: string, event: string, payload: unknown) => {
    tauri.emitted.push({ target, event, payload });
  },
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    hide: async () => {}, show: async () => {}, setFocus: async () => {},
    onFocusChanged: async () => () => {}, listen: async () => () => {},
  }),
}));
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: async () => true, requestPermission: async () => "granted", sendNotification: () => {},
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => "/home/me/Pictures/shot.png", save: async () => null, message: async () => {}, ask: async () => false }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {}, openPath: async () => {} }));
vi.mock("@tauri-apps/plugin-autostart", () => ({ isEnabled: async () => false, enable: async () => {}, disable: async () => {} }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: async () => null }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: async () => {} }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.1.7" }));
vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: async () => {}, unregister: async () => {}, unregisterAll: async () => {}, isRegistered: async () => false,
}));

import { AppContext, type AppCtx } from "./app/context.ts";
import { Actions } from "./lib/actions.ts";
import * as config from "./lib/config.ts";
import { Fleet } from "./lib/fleet.ts";
import type { Dict } from "./lib/json.ts";
import * as routines from "./lib/routines.ts";
import * as trust from "./lib/trust.ts";
import type { PopupCard } from "./lib/surfaces.ts";
import { HomePage } from "./pages/Home.tsx";
import { localDay } from "./lib/home.ts";
import { AgentsPage } from "./pages/Agents.tsx";
import { OrgPage } from "./pages/Org.tsx";
import { NeedsCard } from "./components/NeedsCard.tsx";
import * as model from "./lib/model.ts";
import type { Seat } from "./lib/org.ts";
import { currentDraft, NEW_SPACE_DRAFT, takeDraft } from "./lib/cobraDraft.ts";
import { saveShowCrew } from "./lib/crewVisibility.ts";
import { SpaceScreen } from "./components/SpaceScreen.tsx";
import { ProjectsPage } from "./pages/Projects.tsx";
import { ProjectPage } from "./pages/ProjectPage.tsx";
import { AllMoneyPage } from "./pages/AllMoney.tsx";
import { SettingsPage } from "./pages/Settings.tsx";
import { SetupPage } from "./pages/Setup.tsx";
import { PickerSurface } from "./surfaces/Picker.tsx";
import { PopupSurface } from "./surfaces/Popup.tsx";
import { CobraBoxSurface } from "./surfaces/CobraBox.tsx";
import { MainSurface } from "./surfaces/Main.tsx";
import { Menu } from "./components/ui.tsx";

// -- fixtures (packages/contracts/src shapes) ------------------------------------------------------

const NOW = Date.now() / 1000;
const iso = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1000).toISOString();
const day = (daysAgo: number) => new Date((NOW - daysAgo * 86400) * 1000).toISOString().slice(0, 10);
const ahead = (seconds: number) => new Date((NOW + seconds) * 1000).toISOString();

const MACHINES: config.Machine[] = [
  config.testMachine("laptop", { label: "Laptop", title: "Laptop", hue: "blue" }),
  config.testMachine("office", { label: "Office", title: "Office", hue: "cyan" }),
];

const REQUEST = {
  headline: "Run a shell command", plain: "Cobra wants to run the test suite.", why: "To check the fix before committing.",
  exact: "npm test -- --run src/login", by: "Bash", key: "perm-abc123",
};

const gitOf = (extra: Dict = {}): Dict => ({
  branch: "main", dirty: false, ahead: 0, behind: 0, stashes: 0, defaultBranch: "main", localBranches: 3, staleBranches: 0,
  openPrs: 0, fetchedAt: iso(120), fetchError: null, grade: "Clean", ...extra,
});

const project = (id: string, extra: Dict = {}): Dict => ({
  id, name: id, machine: "laptop", path: `/home/me/Projects/${id}`, session: id, activity: "none", lastActivityAt: iso(600),
  command: null, attached: false, source: "tracked", ...extra,
});

const LAPTOP_PROJECTS: Dict[] = [
  // Needs you: a permission dialog with its request.
  project("cobra", {
    name: "Cobra", activity: "agent-working", needsInput: true, dialog: "permission", request: REQUEST, waitingSince: iso(60),
    lastActivityAt: iso(60), command: "claude", tail: ["Bash(npm test -- --run src/login)", "Do you want to proceed?"],
    git: gitOf({ remote: "https://github.com/example/cobra.git", dirty: true, ahead: 2, grade: "Unpushed", dirtySince: iso(3600), openPrs: 1 }),
  }),
  // Working, with a Foreman and a Worker under it.
  project("lookfocus", {
    name: "lookfocus", activity: "agent-working", workingSince: iso(300), lastActivityAt: iso(5), command: "claude",
    tail: ["Editing src/App.tsx"], git: gitOf({ remote: "https://github.com/example/lookfocus.git", openPrs: 2 }),
  }),
  // Idle: Claude done.
  project("corner-bakery", {
    name: "corner-bakery", activity: "agent-idle", lastActivityAt: iso(1800), command: "claude",
    git: gitOf({ remote: "https://github.com/example/corner-bakery.git", behind: 3, grade: "Behind" }),
  }),
  // Not started, made here, diverged.
  project("notes", { name: "notes", source: "local", lastActivityAt: null, git: gitOf({ mainAhead: 1, grade: "Diverged" }) }),
  // A plain folder, not a repository, shell open.
  project("scripts", { name: "scripts", activity: "idle", command: "zsh", git: null }),
  // An extra session with a branch and a title.
  project("cobra-docs", {
    name: "Cobra · docs/lab-ste-guide-setup", parent: "cobra", branch: "docs/lab-ste-guide-setup", title: "Lab STE setup guide",
    session: "cobra_docs", activity: "agent-idle", lastActivityAt: iso(900), command: "claude", localModel: "local:qwen3:4b",
    git: gitOf({ branch: "docs/lab-ste-guide-setup", ahead: 1, grade: "Unpushed" }),
  }),
  // A Worker the Lead started.
  project("w-123", {
    name: "lookfocus · feat/login-form", parent: "lookfocus", branch: "feat/login-form", title: "Login form",
    session: "lookfocus_w123", activity: "agent-working", lastActivityAt: iso(10), command: "claude",
    worker: { owner: "cobra_lead", task: "Build the login form", model: "sonnet" }, tail: ["Writing LoginForm.tsx"],
    git: gitOf({ branch: "feat/login-form", ahead: 3, grade: "Unpushed" }),
  }),
  // The project's Foreman, with its crew.
  project("lookfocus-fm", {
    name: "lookfocus · Foreman", parent: "lookfocus", foreman: true, crew: { name: "Rosa", look: 2, hat: 1 },
    session: "lookfocus_fm", activity: "agent-idle", lastActivityAt: iso(120), command: "claude", foremanTemplate: "website-builder",
  }),
  // A project made for a trade that keeps a database: its Records section.
  project("paws", { name: "paws-paths-payroll", foremanTemplate: "payroll-manager", git: gitOf({ remote: "https://github.com/example/paws.git" }) }),
  // A Space's CRM seat: the People trade ships dashboards.
  project("crm", { name: "Happy Tails CRM", foremanTemplate: "people", git: gitOf({ remote: "https://github.com/example/crm.git" }) }),
  project("crm-fm", { name: "crm · Foreman", parent: "crm", foreman: true, crew: { name: "Mabel", look: 1, hat: 0 }, session: "crm_fm", activity: "agent-idle", lastActivityAt: iso(300), command: "claude", foremanTemplate: "people" }),
  // The Lead.
  project("cobra_lead", {
    name: "Cobra", lead: true, session: "cobra_lead", path: "/home/me", activity: "agent-working", lastActivityAt: iso(20),
    command: "claude", tail: ["Planning the week"],
  }),
  // A headless Worker.
  project("w-456", {
    name: "corner-bakery · fix/tile-cache", parent: "corner-bakery", branch: "fix/tile-cache", session: "corner-bakery_w456",
    headless: true, activity: "agent-working", lastActivityAt: iso(30), command: "claude", engine: "codex",
    worker: { owner: "cobra_lead", task: "Fix the tile cache", model: "codex" },
  }),
];

const OFFICE_PROJECTS: Dict[] = [
  // A second Lead, under the same session name as the first.
  project("cobra_lead", { name: "Cobra", machine: "office", lead: true, session: "cobra_lead", path: "/srv", activity: "agent-idle",
    lastActivityAt: iso(400), command: "claude" }),
  // The same Worker id and Foreman as on laptop, as a second agent would make them.
  project("w-123", { name: "infra · feat/login-form", machine: "office", parent: "infra", branch: "feat/login-form", session: "infra_w123",
    activity: "agent-working", worker: { owner: "cobra_lead", task: "Same id", model: "opus" }, lastActivityAt: iso(50), command: "claude" }),
  project("infra-fm", { name: "infra · Foreman", machine: "office", parent: "infra", foreman: true, crew: { name: "Rosa", look: 2, hat: 1 },
    session: "infra_fm", activity: "agent-working", lastActivityAt: iso(70), command: "claude" }),
  project("cobra", {
    name: "Cobra", machine: "office", path: "/srv/cobra", activity: "none", lastActivityAt: iso(86400 * 2),
    git: gitOf({ remote: "https://github.com/example/cobra.git" }),
  }),
  project("infra", {
    name: "infra", machine: "office", path: "/srv/infra", activity: "agent-idle", command: "claude",
    git: gitOf({ remote: "https://github.com/example/infra.git", grade: "Parked", parked: "wip/2026-10-01" }),
  }),
];

const tmux = (names: string[], extra: Dict[] = []): Dict => ({
  serverRunning: true,
  sessions: [
    ...names.map((name) => ({ name, windows: 1, attached: false, createdAt: iso(7200), lastActivityAt: iso(600), path: "/home/me", command: "claude" })),
    ...extra,
  ],
});

const LAPTOP_TMUX = tmux(["cobra", "lookfocus", "corner-bakery", "scripts", "cobra_docs", "lookfocus_w123", "lookfocus_fm", "cobra_lead"], [
  // A loose session, live, and the desk's own grouped view (hidden).
  { name: "scratch", windows: 2, attached: true, createdAt: iso(3600), lastActivityAt: iso(10), path: "/tmp", command: "htop" },
  { name: "cobra@desk", windows: 1, attached: true, createdAt: iso(3600), lastActivityAt: iso(10), path: "/home/me", command: "tmux" },
]);
const OFFICE_TMUX = tmux(["infra", "cobra_lead", "infra_w123", "infra_fm"], [
  { name: "old-shell", windows: 1, attached: false, createdAt: iso(86400), lastActivityAt: iso(7200), path: "/srv", command: "bash" },
]);

const PR = (number: number, extra: Dict = {}): Dict => ({
  number, title: `PR ${number}`, head: `feat/thing-${number}`, base: "main", createdAt: iso(3600 * number), ageDays: number % 5,
  isDraft: false, author: "me", mergeable: "MERGEABLE", checks: "green", url: `https://github.com/me/lookfocus/pull/${number}`,
  headSha: `abc${number}`, ...extra,
});

const ATTACHMENT = (path: string, bytes: number): Dict => ({ path, name: path.split("/").pop(), bytes, sha256: "ab".repeat(32) });
const LONG_TEXT = "Hi Ann,\n\nHere are this week's pay stubs for the team.\n\nThe totals match the timesheets.\n\n" +
  "Let me know if anything looks off.\n\nThanks,\nPenny";
// A Foreman's actions (contracts ApprovalAction): an email, files for a folder, a note.
const ACTIONS: Dict[] = [
  {
    id: "ap-email", machine: "laptop", kind: "action", title: "Send: Pay stubs for the week", body: "To: ann@example.com", createdAt: iso(100),
    expiresAt: ahead(3600), state: "pending",
    action: { channel: "email", project: "paws", projectName: "paws-paths-payroll", summary: "Pay stubs for the week",
      email: { from: { box: "b1", address: "studio@icloud.com", mailbox: "iCloud Mail" }, to: ["ann@example.com"], cc: ["books@example.com"], subject: "Pay stubs, week 42", text: LONG_TEXT,
        attachments: [ATTACHMENT("out/stubs-week-42.pdf", 182_000), ATTACHMENT("out/summary.csv", 900)] } },
  },
  {
    id: "ap-file", machine: "laptop", kind: "action", title: "Copy: The week's report", body: "To: Bookkeeper", createdAt: iso(90),
    expiresAt: ahead(3600), state: "pending",
    action: { channel: "file", project: "paws", projectName: "paws-paths-payroll", summary: "The week's report",
      files: { to: "books", label: "Bookkeeper", path: "/home/me/Books", items: [ATTACHMENT("out/report.pdf", 2_400_000)],
        text: "For your records." } },
  },
  {
    id: "ap-note", machine: "laptop", kind: "action", title: "Note: Two timesheets are missing", body: "Ben and Cy", createdAt: iso(80),
    expiresAt: ahead(3600), state: "pending",
    action: { channel: "note", project: "paws", projectName: "paws-paths-payroll", summary: "Two timesheets are missing",
      note: { text: "Ben and Cy have not sent their timesheets for week 42.", attachments: [ATTACHMENT("out/missing.md", 300)] } },
  },
];

// A routine the Payroll Foreman proposed, and the project's routines (contracts routines.ts).
const MONTH_END_BRIEF = "Write the month's payroll summary.\nPut it in the sheet's Summary tab.\nPropose the email for my Allow.\n\n" +
  "If a pay run is still open, say so first and stop there.";
const ROUTINE_APPROVAL: Dict = {
  id: "ap-routine", machine: "laptop", kind: "routine", title: "Run “Month-end summary” on the last day of each month at 17:00?", body: "On the last day of each month at 17:00",
  createdAt: iso(70), expiresAt: ahead(3600), state: "pending",
  routine: { project: "paws", projectName: "paws-paths-payroll", name: "Month-end summary", rule: { every: "month", day: "last", at: "17:00" },
    when: "On the last day of each month at 17:00", brief: MONTH_END_BRIEF, firstRun: ahead(86400 * 9) },
};
const ROUTINES: Dict = {
  routines: [
    { id: "rt-payroll", project: "paws", projectName: "paws-paths-payroll", name: "Fortnightly payroll",
      rule: { every: "week", interval: 2, days: ["fri"], at: "09:00" }, when: "Every other Friday at 09:00", brief: "Run payroll.",
      enabled: true, nextRun: ahead(86400 * 3), lastRun: { due: iso(86400 * 11), at: iso(86400 * 11 - 60), outcome: "started" },
      createdAt: iso(86400 * 30), createdBy: "lead" },
    { id: "rt-timesheets", project: "paws", projectName: "paws-paths-payroll", name: "Monday timesheet check",
      rule: { every: "week", days: ["mon"], at: "08:00" }, when: "Every Monday at 08:00", brief: "Check the timesheets.",
      enabled: false, nextRun: null, lastRun: { due: iso(86400 * 4), at: iso(86400 * 4), outcome: "failed", error: "the Foreman could not start" },
      createdAt: iso(86400 * 20), createdBy: "foreman" },
    // The Space's CRM: ran a few minutes ago, and runs again in a few (the Space screen's Today).
    { id: "rt-crm", project: "crm", projectName: "Happy Tails CRM", name: "Morning follow-ups", rule: { every: "day", at: "09:00" }, when: "Every day at 09:00",
      brief: "Check the follow-ups.", enabled: true, nextRun: ahead(300), lastRun: { due: iso(240), at: iso(230), outcome: "started" },
      createdAt: iso(86400 * 5), createdBy: "lead" },
    { id: "rt-other", project: "lookfocus", projectName: "lookfocus", name: "Weekly tidy", rule: { every: "week", days: ["sun"], at: "20:00" },
      when: "Every Sunday at 20:00", brief: "Tidy.", enabled: true, nextRun: ahead(86400), lastRun: null, createdAt: iso(86400), createdBy: "person" },
  ],
};

// Trust Cobra offers, and the project's grants, keys that keep asking and receipts (contracts trust.ts).
const TRUST_SUBJECT: Dict = { key: "k".repeat(64), project: "paws", projectName: "paws-paths-payroll", channel: "email", what: "pay-stub",
  to: ["ana@example.com", "ben@example.com"], templates: ["pay-stub"] };
const TRUST_APPROVAL: Dict = {
  id: "ap-trust", machine: "laptop", kind: "trust", title: "Let paws-paths-payroll send pay-stub to these 2 addresses without asking?",
  body: "You allowed this 3 times in a row with nothing changed:", createdAt: iso(50), expiresAt: ahead(86400 * 3), state: "pending",
  trust: { ...TRUST_SUBJECT, runs: 3, examples: ["Send: 2 pay stubs, Oct 1 to 15", "Send: 2 pay stubs, Oct 16 to 31", "Send: 2 pay stubs, Nov 1 to 15"] },
};
const RECEIPT: Dict = {
  id: "ap-receipt", machine: "laptop", kind: "action", title: "Send: 2 pay stubs, Nov 16 to 30", body: "", createdAt: iso(40), expiresAt: ahead(86400),
  state: "done", answeredAt: iso(40), results: [{ ok: true, message: "sent to 2 addresses from penny@example.com" }],
  action: { channel: "email", project: "paws", projectName: "paws-paths-payroll", summary: "2 pay stubs, Nov 16 to 30" },
  trusted: { key: "k".repeat(64), grantedAt: iso(86400 * 2) },
};
const TRUST: Dict = {
  grants: [{ ...TRUST_SUBJECT, grantedAt: iso(86400 * 2), runsSince: 1, lastUsed: iso(40) }],
  always: [{ ...TRUST_SUBJECT, key: "a".repeat(64), what: "a message", templates: [], at: iso(86400) }],
  receipts: [RECEIPT],
};

// A project's records and Google's connectors (contracts records.ts).
const JOURNAL: Dict = {
  project: "paws",
  entries: [
    { id: 7, at: iso(60), by: "person", mutation: "undo:add_employee", summary: "Undid adding Dee", undone: false, undoable: false, undoneAt: null, undoOf: 5 },
    { id: 6, at: iso(600), by: "foreman", mutation: "record_hours", summary: "Hours for week 42", changes: 4, undone: false, undoable: true,
      undoneAt: null, undoOf: null },
    { id: 5, at: iso(900), by: "foreman", mutation: "add_employee", summary: "Added Dee", changes: 1, undone: true, undoable: false,
      undoneAt: iso(60), undoOf: null },
    { id: 4, at: iso(86400 * 3), by: "import", mutation: "import:employees", changes: 12, undone: false, undoable: true, undoneAt: null, undoOf: null },
  ],
};
// Laptop's Claude account has Gmail and Calendar connected; Office's has none of the three.
const GOOGLE = (machine: string): Dict => ({
  connectors: ["Gmail", "Google Calendar", "Google Drive"].map((name) => ({ name, connected: machine === "laptop" && name !== "Google Drive" })),
});

// The owner's Cloudflare (contracts cloudflare.ts): Laptop connected with two accounts, Office not.
const CF_BASE = { scopes: ["workers-scripts.admin", "d1.write", "account-settings.read", "offline_access"], problem: null,
  clientId: "ee7d1dfa12f17b55f8e792c0a454de5d", redirect: "https://cobra.example.com/connect/cloudflare" };
const CF_ACCOUNTS = [{ id: "cf1", name: "Pine Yoga" }, { id: "cf2", name: "Paws Studio" }];
const CLOUDFLARE = (machine: string): Dict => machine === "laptop"
  ? { ...CF_BASE, state: "connected", account: CF_ACCOUNTS[0], accounts: CF_ACCOUNTS, connectedAt: iso(3600) }
  : { ...CF_BASE, scopes: [], state: "not-connected", account: null, accounts: [], connectedAt: null };

const APPROVALS: Dict = {
  machine: "laptop",
  approvals: [
    {
      id: "ap-merge", machine: "laptop", kind: "merge", title: "Merge 2 pull requests in lookfocus",
      body: "The Lead wants to merge:\n#11 Login form\n#12 Fix header", createdAt: iso(300), expiresAt: ahead(3600), state: "pending",
      prs: [{ number: 11, title: "Login form", repo: "me/lookfocus", head: "abc11", url: "https://github.com/me/lookfocus/pull/11", worker: "w-123" }],
    },
    {
      id: "ap-plan", machine: "laptop", kind: "plan", title: "Rosa's plan for lookfocus", body: "Three tasks", createdAt: iso(200),
      expiresAt: ahead(3600), state: "pending",
      plan: {
        project: "lookfocus", projectName: "lookfocus", summary: "Ship the login page this week.",
        tasks: [
          { id: "t1", title: "Login form", task: "Build the form", kind: "ui", size: "m", model: "sonnet", pick: "sonnet", runnerUp: "opus",
            reason: "UI work, sonnet wins most", review: true, reviewer: "opus", options: ["sonnet", "opus", "codex"] },
          { id: "t2", title: "Auth API", task: "Add the endpoint", kind: "api", size: "s", model: "codex", pick: "codex", runnerUp: null,
            reason: "Small API change", review: false, reviewer: null, options: ["codex", "sonnet"], after: ["t1"] },
          { id: "t3", title: "Tests", task: "Cover it", kind: "tests", size: "s", model: "local:qwen3:4b", pick: null, runnerUp: null,
            reason: "Cheap", review: false, options: [] },
        ],
      },
    },
    { id: "ap-old", machine: "laptop", kind: "merge", title: "Old", body: "", createdAt: iso(9000), expiresAt: iso(10), state: "denied" },
    ...ACTIONS,
    ROUTINE_APPROVAL,
    TRUST_APPROVAL,
  ],
};

const ALERTS: Dict = {
  host: "laptop", checkedAt: iso(30),
  alerts: [
    { id: "expose:tcp:0.0.0.0:5173", level: "warn", title: "Listening on the LAN", body: "node (vite) on 0.0.0.0:5173 is reachable from your network" },
    { id: "disk-root", level: "critical", title: "Disk almost full", body: "/ is 96% full" },
  ],
};

const SYSTEM = (host: string, extra: Dict = {}): Dict => ({
  host, kernel: "6.17.1-arch1", uptimeSeconds: 86400 * 3, capturedAt: iso(5),
  cpu: { model: "AMD Ryzen 9", threads: 16, usage: 0.72, loadavg: [3.1, 2.4, 2.0] },
  memory: { totalBytes: 32e9, availableBytes: 8e9, usedBytes: 24e9, usage: 0.75, swapTotalBytes: 8e9, swapUsedBytes: 1e9, zram: true },
  disks: [{ mount: "/", device: "/dev/nvme0n1p2", fstype: "btrfs", totalBytes: 1e12, freeBytes: 4e10, usedBytes: 9.6e11, usage: 0.96 }],
  network: [{ iface: "wlan0", rxBytes: 1e9, txBytes: 2e8, rxRate: 120000, txRate: 8000 },
    { iface: "eth1", rxBytes: 1e6, txBytes: 1e6, rxRate: 10, txRate: 10 }],
  thermal: [{ label: "x86_pkg_temp", celsius: 71 }, { label: "BAT0", celsius: 33 }],
  power: { ac: false, battery: 64, lid: "open", lidAwake: { available: true, on: false } },
  ...extra,
});

const USAGE = (host: string): Dict => ({
  host, capturedAt: iso(30), available: true,
  agents: [
    {
      id: "claude", name: "Claude", updatedAt: iso(30), ready: true, authOk: true, scope: "account", tierLabel: "Max 20x",
      account: "me@example.com", statusText: "", helpText: "",
      limits: [{ label: "Session (5-hour)", percent: 0.42, resetsAt: ahead(7200) }, { label: "Week", percent: 0.86, resetsAt: ahead(86400 * 3) }],
      todayPrompts: 31, todaySessions: 4, todayTotalTokens: 1_200_000,
      recentDays: Array.from({ length: 9 }, (_, i) => ({ date: day(8 - i), tokens: 100000 * (i + 1) })),
      totalPrompts: 1400, totalSessions: 210, activeDates: [day(0), day(1), day(3)],
      modelUsage: { "claude-opus-5-5": { inputTokens: 1e6, outputTokens: 2e5, cacheReadInputTokens: 5e6, cacheCreationInputTokens: 1e5 } },
    },
    {
      id: "codex", name: "Codex", updatedAt: iso(60), ready: true, authOk: false, scope: "computer", tierLabel: "Plus",
      statusText: "Signed out.", helpText: "Run codex login.", limits: [{ label: "Weekly", percent: 0.1, resetsAt: ahead(86400) }],
      todayPrompts: 2, todaySessions: 1, todayTotalTokens: 2000, recentDays: [{ date: day(0), tokens: 2000 }],
      totalPrompts: 20, totalSessions: 3, activeDates: [day(0)], modelUsage: {},
    },
    {
      id: "empty", name: "Nothing", updatedAt: iso(60), ready: false, authOk: false, scope: "computer", tierLabel: "", statusText: "",
      helpText: "", limits: [], todayPrompts: 0, todaySessions: 0, todayTotalTokens: 0, recentDays: [], totalPrompts: 0,
      totalSessions: 0, activeDates: [], modelUsage: {},
    },
  ],
  budget: [{ id: "claude", percent: 0.42, label: "Claude · 5-hour", resetsAt: ahead(7200), state: "ok" }],
});

const HISTORY = (host: string): Dict => ({
  host, metric: "disk", scope: "/", hours: 24,
  points: Array.from({ length: 60 }, (_, i) => ({ ts: NOW - 86400 + i * 1440, value: 0.5 + (i % 10) / 25 })),
});

const ORCH: Dict = {
  machine: "laptop", caps: { computer: 6, project: 3 }, live: 2,
  projects: [{
    id: "lookfocus", name: "lookfocus", path: "/home/me/Projects/lookfocus", landing: "pr", maxWorkers: 3,
    foreman: { project: "lookfocus", name: "Rosa", session: "lookfocus_fm", running: true, activity: "agent-idle", needsInput: false, dialog: null, tail: [] },
  }],
  workers: [
    { id: "w-123", machine: "laptop", parent: "lookfocus", parentName: "lookfocus", branch: "feat/login-form", title: "Login form",
      path: "/home/me/wt/w-123", session: "lookfocus_w123", owner: "cobra_lead", task: "Build the login form", model: "sonnet",
      createdAt: iso(900), phase: "working", activity: "agent-working", needsInput: false, dialog: null, tail: ["Writing LoginForm.tsx"] },
    { id: "w-456", machine: "laptop", parent: "corner-bakery", parentName: "corner-bakery", branch: "fix/tile-cache", path: "/home/me/wt/w-456",
      session: "corner-bakery_w456", owner: "cobra_lead", task: "Fix the tile cache", model: "codex", createdAt: iso(1800), phase: "review",
      activity: "agent-working", needsInput: false, dialog: null, tail: [], pr: { number: 7, url: "https://github.com/me/corner-bakery/pull/7" } },
  ],
  localModels: ["qwen3:4b"], codex: { workers: true }, workerDefault: "sonnet",
  budget: [
    { id: "claude", percent: 0.42, label: "Claude · 5-hour", resetsAt: ahead(7200), state: "ok", account: "me@example.com" },
    { id: "codex", percent: 0.97, label: "Codex · week", resetsAt: ahead(86400), state: "hold" },
    { id: "api", percent: 0.2, label: "API credits", resetsAt: ahead(86400 * 10), state: "ok" },
  ],
  queue: [
    { id: "q1", project: "corner-bakery", task: "Write the tile cache tests", model: "sonnet", owner: "cobra_lead", createdAt: iso(100), state: "waiting", waitingFor: "budget" },
    { id: "q2", project: "lookfocus", task: "Started already", owner: "lookfocus-fm", createdAt: iso(500), state: "started", worker: "w-123" },
  ],
};

const ORCH_HISTORY: Dict = {
  capturedAt: iso(10), today: day(0),
  lanes: [
    { id: "cobra_lead", kind: "lead", label: "Cobra", segments: [{ state: "work", from: iso(7200), to: iso(3600) }, { state: "idle", from: iso(3600), to: null }] },
    { id: "lookfocus-fm", kind: "foreman", label: "Rosa", project: "lookfocus", segments: [{ state: "work", from: iso(5000), to: null }] },
    { id: "w-123", kind: "worker", label: "Login form", project: "lookfocus", segments: [{ state: "work", from: iso(900), to: null }] },
    { id: "cobra", kind: "session", label: "Cobra", project: "cobra", segments: [{ state: "wait", from: iso(60), to: null }, { state: "work", from: iso(4000), to: iso(60) }] },
    { id: "notes", kind: "session", label: "notes", project: "notes", segments: [] },
  ],
  days: Array.from({ length: 14 }, (_, i) => ({ date: day(13 - i), started: i % 4, opened: i % 3, merged: i % 2, answered: i % 5 })),
  done: [
    { at: iso(1000), kind: "pr-merged", detail: "https://github.com/me/lookfocus/pull/10", project: "lookfocus", title: "Fix header" },
    { at: iso(2000), kind: "pr-opened", detail: "https://github.com/me/lookfocus/pull/11", project: "lookfocus" },
    { at: iso(2500), kind: "pr-opened", detail: "https://github.com/me/lookfocus/pull/10", project: "lookfocus" },
    // A Space's routine ran (its Activity).
    { at: iso(200), kind: "routine-ran", detail: "rt-crm", project: "crm", title: "Morning follow-ups" },
  ],
};

const PRS: Dict = {
  machine: "laptop", prError: null, at: iso(30),
  repos: [
    { project: "lookfocus", projectName: "lookfocus", remote: "https://github.com/example/lookfocus.git", readAt: iso(30),
      prs: [PR(11), PR(12, { checks: "red" }), PR(13, { checks: "pending" }), PR(14, { mergeable: "CONFLICTING" }), PR(15, { isDraft: true })] },
    { project: "cobra", projectName: "Cobra", remote: "https://github.com/example/cobra.git", readAt: iso(60),
      prs: [PR(3, { url: "https://github.com/me/cobra/pull/3", checks: "none" })] },
    { project: "corner-bakery", projectName: "corner-bakery", remote: "https://github.com/example/corner-bakery.git", readAt: null, prs: null },
  ],
};

const MINI_PRS: Dict = {
  machine: "office", prError: "gh is not logged in", at: iso(30),
  repos: [{ project: "cobra", projectName: "Cobra", remote: "https://github.com/example/cobra.git", readAt: iso(600), prs: [] }],
};

const TRANSCRIPT: Dict = {
  session: "cobra", path: "/home/me/Projects/cobra", file: "/home/me/.claude/projects/x.jsonl", offset: 7, title: "Fix the login bug",
  model: "claude-opus-5-5", effort: "high",
  messages: [
    { kind: "text", id: "m1", at: iso(600), role: "user", text: "Fix the **login** bug, see https://example.com/issue/4" },
    { kind: "text", id: "m2", at: iso(590), role: "assistant",
      text: "Looking at `src/login.ts` now.\n\n```ts\nexport const x = 1;\n```\n\nSee [the docs](https://example.com/docs)." },
    { kind: "tool", id: "t1", at: iso(580), name: "Read", summary: "Read src/login.ts" },
    { kind: "result", id: "r1", at: iso(579), toolUseId: "t1", ok: true, preview: "export function login() {}" },
    { kind: "tool", id: "t2", at: iso(570), name: "Bash", summary: "npm test" },
    { kind: "result", id: "r2", at: iso(560), toolUseId: "t2", ok: false, preview: "1 failing" },
    { kind: "tool", id: "t3", at: iso(500), name: "AskUserQuestion", summary: "Which fix?",
      questions: [{ question: "Which fix do you want?", header: "Fix", options: [{ label: "Small", description: "Patch it" }, { label: "Big" }] }] },
    { kind: "result", id: "r3", at: iso(450), toolUseId: "t3", ok: true, preview: "Small", answers: { "Which fix do you want?": "Small" } },
    { kind: "command", id: "c1", at: iso(400), name: "compact", args: "focus on login", output: "Compacted." },
    { kind: "text", id: "m3", at: iso(100), role: "assistant", text: "I need to run the tests." },
  ],
  screen: { recognised: true, working: false, needsInput: true, dialog: "permission", tail: ["Do you want to proceed?"], request: REQUEST },
};

const QUESTION_TRANSCRIPT: Dict = {
  ...TRANSCRIPT, session: "cobra_docs", title: null,
  messages: [
    { kind: "tool", id: "q1", at: iso(30), name: "AskUserQuestion", summary: "Which colour?",
      questions: [{ question: "Which colour?", header: "Colour", multiSelect: true, options: [{ label: "Red" }, { label: "Blue", description: "calm" }] }] },
  ],
  screen: {
    recognised: true, working: false, needsInput: true, dialog: "question", tail: [],
    question: { text: "Which colour?", header: "Colour", multiSelect: true, submit: false,
      rows: [{ n: 1, label: "Red", description: null, checked: false }, { n: 2, label: "Blue", description: "calm", checked: false }] },
  },
};

// Her thread on the hub: an earlier conversation (faded), the line over the current one, and a digest.
const THREAD: Dict = {
  machine: "laptop", current: "now", more: false,
  entries: [
    { id: 1, at: iso(9000), kind: "session", conversation: "old", text: "", reason: "start" },
    { id: 2, at: iso(8990), kind: "you", conversation: "old", text: "What landed last week?" },
    { id: 3, at: iso(8980), kind: "cobra", conversation: "old", text: "Billing's invoices landed." },
    { id: 4, at: iso(5000), kind: "session", conversation: "now", text: "", reason: "idle" },
    { id: 5, at: iso(4990), kind: "you", conversation: "now", text: "[cobra] Worker w3 finished" },
    { id: 6, at: iso(60), kind: "digest", conversation: "now", text: "While you were out: 2 landed." },
    { id: 7, at: iso(30), kind: "designs", conversation: "now", text: "Two takes on the fall sale.",
      files: [1, 2].map((n) => ({ path: `/home/a/Spaces/acme/designs/exports/sale-${n}.png`, name: `sale-${n}.png`, bytes: 900, width: 1080, height: 1350 })) },
  ],
};

function transcriptFor(session: string): Dict {
  const plain = { ...TRANSCRIPT, session, title: null, messages: TRANSCRIPT.messages.slice(0, 3) };
  const screen = (extra: Dict) => ({ recognised: true, working: false, needsInput: true, tail: ["?"], ...extra });
  switch (session) {
    case "cobra_docs": return QUESTION_TRANSCRIPT;
    case "lookfocus": return { ...plain, screen: { ...screen({ dialog: "trust" }) } };
    case "corner-bakery": return { ...plain, screen: screen({ dialog: "model", model: { effort: "high",
      rows: [{ n: 1, label: "Opus", description: null, current: true, selected: true }] } }) };
    case "cobra_lead":
      return { ...plain, model: "claude-sonnet-5", effort: null,
        messages: [{ kind: "tool", id: "lq", at: iso(5), name: "AskUserQuestion", summary: "Which?",
          questions: [{ question: "Which project first?", options: [{ label: "lookfocus" }, { label: "corner-bakery", description: "maps" }] }] }],
        screen: screen({ dialog: "question", question: { text: "Which project first?", header: null, multiSelect: false, submit: false,
          rows: [{ n: 1, label: "lookfocus", description: null, checked: null }, { n: 2, label: "corner-bakery", description: "maps", checked: null }] } }) };
    case "lookfocus_fm":
      return { ...plain, screen: screen({ dialog: "question", question: { text: "Review your answers", header: null, multiSelect: false,
        submit: true, rows: [{ n: 1, label: "Submit answers", description: null, checked: null }] } }) };
    case "lookfocus_w123": return { ...plain, screen: { recognised: true, working: true, needsInput: false, dialog: null, tail: [] } };
    case "infra": return { ...plain, messages: [], screen: null, model: null, effort: null };
    case "scratch": throw { status: 404, message: "no such session" };
    default: return { ...TRANSCRIPT, session };
  }
}

const REPO: Dict = {
  machine: "laptop", at: iso(10),
  project: { id: "lookfocus", name: "lookfocus", machine: "laptop", path: "/home/me/Projects/lookfocus", session: "lookfocus" },
  git: gitOf({ remote: "https://github.com/example/lookfocus.git", openPrs: 2 }),
  branches: [
    { name: "main", local: true, remote: true, current: true, committedAt: iso(100), ageDays: 0, aheadOfMain: 0, behindMain: 0, merged: false, stale: false, gone: false, parked: false },
    { name: "wip/2026-10-01", local: true, remote: true, current: false, committedAt: iso(86400 * 3), ageDays: 3, aheadOfMain: 2, behindMain: 1, merged: false, stale: false, gone: false, parked: true },
    { name: "feat/old", local: true, remote: false, current: false, committedAt: iso(86400 * 40), ageDays: 40, aheadOfMain: 0, behindMain: 9, merged: true, stale: true, gone: true, parked: false },
    { name: "feat/stale", local: true, remote: true, current: false, committedAt: iso(86400 * 30), ageDays: 30, aheadOfMain: 4, behindMain: 20, merged: false, stale: true, gone: false, parked: false },
    { name: "feat/new", local: false, remote: true, current: false, committedAt: null, ageDays: null, aheadOfMain: null, behindMain: null, merged: false, stale: false, gone: false, parked: false },
  ],
  prs: [PR(11), PR(12, { checks: "red" }), PR(13, { checks: "pending" })],
  prError: null,
};

const TIDY = (machine: string): Dict => ({
  machine, at: iso(5),
  rows: [
    { project: "lookfocus", projectName: "lookfocus", kind: "branch", branch: "feat/old", reason: "merged, upstream gone", action: "delete", ageDays: 40 },
    { project: "lookfocus", projectName: "lookfocus", kind: "branch", branch: "feat/stale", reason: "30 days old, 4 commits not in main", action: "ask-claude", ageDays: 30 },
    { project: "lookfocus", projectName: "lookfocus", kind: "branch", branch: "feat/older", reason: "merged", action: "delete", ageDays: 50 },
    { project: "lookfocus", projectName: "lookfocus", kind: "pr", number: 9, title: "Old PR", reason: "open 60 days", action: "close", ageDays: 60 },
    { project: "corner-bakery", projectName: "corner-bakery", kind: "branch", branch: "fix/tile-cache", reason: "Worker finished", action: "discard", ageDays: 1, worker: "w-456" },
  ],
});

const CAPS: Dict = {
  machine: "laptop", gh: "/usr/bin/gh", githubAuth: true, githubUser: "me", roots: ["/home/me/Projects", "/home/me"],
  localModels: ["qwen3:4b", "qwen-tuned:fast96k"],
  localModelInfo: [{ name: "qwen-tuned:fast96k", verdict: "ready", contextTokens: 98304, decodeTps: 41 },
    { name: "crawler", verdict: "slow", contextTokens: 32768, decodeTps: 6 }, { name: "qwen3:4b", verdict: "unchecked", contextTokens: null, decodeTps: null }],
  pi: true, codex: true, engines: { lead: "claude", foreman: "claude", session: "claude", worker: "codex" },
};

const LOCAL_REPOS: Dict = {
  machine: "laptop", roots: ["/home/me/Projects"],
  discovered: [
    { path: "/home/me/Projects/oldthing", id: "oldthing", name: "oldthing", session: "oldthing", git: gitOf({ remote: "https://github.com/example/oldthing.git" }), sessionTaken: false },
    { path: "/home/me/Projects/cobra2", id: "cobra2", name: "cobra2", session: "cobra", git: null, sessionTaken: true },
  ],
};

const GITHUB_REPOS: Dict = {
  machine: "laptop",
  repos: [
    { nameWithOwner: "me/site", name: "site", description: "My website", isPrivate: false, pushedAt: iso(86400), primaryLanguage: "TypeScript", wouldClash: false },
    { nameWithOwner: "me/cobra", name: "cobra", description: null, isPrivate: true, pushedAt: iso(60), primaryLanguage: null, wouldClash: true },
  ],
};

const ACCOUNTS: Dict = {
  accounts: [
    { id: "a1", provider: "claude", label: "Work", email: "work@example.com", addedAt: iso(86400 * 9), active: true },
    { id: "a2", provider: "claude", label: "Personal", email: "home@example.org", addedAt: iso(86400 * 2), active: false },
    { id: "a3", provider: "codex", label: "Codex main", email: "me@example.com", addedAt: iso(86400), active: false },
  ],
  computer: { claude: { email: "work@example.com", active: false }, codex: { email: "me@example.com", saved: false } },
};

const ENGINES: Dict = { machine: "laptop", engines: { lead: "claude", foreman: "claude", session: "claude", worker: "codex" }, codex: true, contained: false };

const BRAIN: Dict = {
  machine: "laptop",
  brain: { revision: 2, rules: [{ when: { kind: "ui" }, prefer: ["opus"], note: "UI wants Opus" }, { when: { project: "corner-bakery", path: "maps/**" }, never: ["local:*"] }, { when: {}, review: "force" }],
    priors: { codex: { tests: 0.9 } } },
  refused: null, kinds: ["tests", "ui", "api"], models: ["opus", "sonnet", "codex", "local:qwen3:4b"],
  defaults: { opus: { tests: 0.7, ui: 0.8 }, codex: { tests: 0.75 } },
  cells: [
    { model: "codex", kind: "tests", runs: 5, wins: 3, seed: 0.75, record: 0.6 },
    { model: "opus", kind: "tests", runs: 0, wins: 0, seed: 0.7, record: 0.7 },
    { model: "opus", kind: "ui", runs: 4, wins: 4, seed: 0.8, record: 0.9 },
  ],
  recent: [{ at: iso(3600), worker: "w-1", project: "lookfocus", model: "opus", kind: "ui", size: "m", win: true, fixRounds: 1, merged: true }],
};

const POLICY = (computer: string, revision: number): Dict => ({
  computer, refused: null,
  policy: {
    version: 1, revision, preset: "balanced", network: { allow: ["pypi.org", "registry.npmjs.org"] },
    judge: { model: "claude-haiku-5-5", fallback: "local:qwen-tuned:fast96k" },
    models: { fallbacks: { opus: ["sonnet", "codex"] } },
    lead: { webTools: true },
    foreman: { maxWorkers: 3, maxWorkersPerComputer: 4, workerModels: ["sonnet", "codex"], mergeOnGreen: false },
    job: { models: ["sonnet"], concurrent: 2 }, local: { slots: 1 },
    computers: { office: { preset: "locked" } }, projects: { "me/lookfocus": { network: { allow: ["docs.expo.dev"] } } },
    apiLane: { enabled: true, monthlyCapUsd: 50 },
  },
  resolved: { preset: "balanced", network: ["pypi.org"], judge: { model: "claude-haiku-5-5", fallback: null }, fallbacks: { opus: ["sonnet"] }, notes: ["The fleet's preset."] },
  presets: [
    { name: "locked", title: "Locked", rows: { network: "none", shell: "ask" } },
    { name: "balanced", title: "Balanced", rows: { network: "allow-list", shell: "judge" } },
    { name: "auto", title: "Auto", rows: { network: "any", shell: "allow" } },
  ],
  floor: ["Never pushes to main", "Never reads ~/.ssh"], blocklist: ["evil.com"],
  capabilities: { "web.fetch": "judge", "git.push": "ask" },
  roles: {
    lead: { webTools: true },
    foreman: { maxWorkers: 3, maxWorkersPerComputer: 4, workerModels: ["sonnet", "codex"], mergeOnGreen: false },
    job: { models: ["sonnet"], concurrent: 2 }, local: { slots: 1 },
  },
  hardCaps: { workersPerProject: 6, workersPerComputer: 8, jobsAtOnce: 4, localSlots: 2 },
  changes: [{ at: NOW * 1000 - 3600_000, revision, by: "desk", lines: [{ text: "Preset: Locked → Balanced", widens: true }] }],
});

const API_LANE: Dict = {
  machine: "laptop", enabled: true, capUsd: 50, key: true, workspace: true, keptToken: false, gateway: true, open: true, why: "",
  month: day(0).slice(0, 7), resetsAt: ahead(86400 * 12), here: { dollars: 4.2, requests: 120, byRole: { worker: 3.1, judge: 1.1 } },
  fleetUsd: 6.5, lastError: null,
};

const REFUSED: Dict = {
  machine: "laptop",
  refused: [{ at: NOW * 1000 - 600_000, worker: "w-123", tool: "Bash", rule: "network", subject: "curl https://evil.com", reason: "not on the allow-list", judge: "haiku" }],
};

const DECIDED: Dict = {
  decided: [
    { id: "jd_merge", at: iso(300), kind: "merge", title: "Merged #42 on green", body: "example/tallgrass#42 Fix the map", undoLabel: "Open a revert PR" },
    { id: "jd_sent", at: iso(400), kind: "action", title: "Sent the invoice", body: "", undoLabel: null, noUndo: "It was sent." },
  ],
  caps: { merge: { used: 1, cap: 10 }, cards: { used: 0, cap: 25 } },
};

const CHECK = { verdict: "ready", contextTokens: 98304, decodeTps: 41.5, prefillTps: 2052.8, checkedAt: NOW * 1000 - 7200_000, ms: 7778 };
const LOCAL: Dict = {
  computer: "laptop",
  ollama: { url: "http://127.0.0.1:11434", remote: false, refused: null, running: true, version: "0.33.3" },
  models: [
    { name: "qwen-tuned:fast96k", tools: true, size: 5_681_599_551, check: CHECK, checking: false },
    { name: "crawler", tools: true, size: null, checking: false, check: { ...CHECK, verdict: "slow", decodeTps: 6.2, reason: "slow" } },
    { name: "qwen3:4b", tools: true, size: null, check: null, checking: true },
    { name: "nomic-embed-text", tools: false, size: null, check: null, checking: false },
  ],
  uses: [{ role: "judge", label: "The judge, at your plan's limit", model: "qwen-tuned:fast96k" }, { role: "titles", label: "Session titles", model: null }],
  fix: null, slots: { limit: 2, running: 1 },
};

const MCP_PIN = { path: "/usr/bin/github-mcp-server", sha256: "ab".repeat(32), version: "v1.4.0", release: "v1.4.0", verifiedAt: iso(86400) };
const MCP: Dict = {
  machine: "laptop", gh: { installed: true, authed: true, user: "me" },
  github: { binary: "/usr/bin/github-mcp-server", pin: MCP_PIN, token: { present: true, login: "me" } },
  entries: [{ name: "github", preset: "github", transport: "stdio", roles: ["lead", "foreman"], readOnly: true, enabled: true, available: true, pin: MCP_PIN }],
  integrations: [
    { id: "github", title: "GitHub", state: "connected", account: "me", enabled: true, methods: ["device", "token"], manageUrl: "https://github.com/settings/apps" },
    { id: "linear", title: "Linear", state: "signing-in", account: null, enabled: false, methods: ["device"],
      signIn: { userCode: "ABCD-1234", verificationUri: "https://linear.app/device", expiresAt: ahead(600) } },
    { id: "notion", title: "Notion", state: "disconnected", account: null, why: "not connected", enabled: false, methods: ["token"], tokenUrl: "https://notion.so/tokens" },
  ],
};

// The morning brief: the Laptop runs the Lead, so it sends today's.
const MORNING = { sends: true, settings: { enabled: true, at: "08:00" },
  latest: { day: localDay(Date.now()), text: "Two PRs landed overnight. Nothing waits on you.", at: iso(3600), by: "model" } };

// My Organization: the Laptop keeps the org; paws works for Happy Tails.
const ORG = { revision: 2, companies: [{ id: "happy-tails", name: "Happy Tails", color: "#c0763a" }], seats: { "laptop/paws": { company: "happy-tails" }, "laptop/crm": { company: "happy-tails" } } };

// Settings → Projects: ~ and ~/Projects built in, and what was added.
// A trade's dashboards (the agent's views.ts): People's, on a few people.
const CRM_PEOPLE = [
  { id: 1, name: "Ava Reed", organization: "Reed Dogs", stage: "Lead", email: "ava@reeddogs.example" },
  { id: 2, name: "Bo Fox", organization: "Fox & Hound", stage: "Won", email: "bo@foxhound.example" },
];
const CRM_VIEWS = {
  project: "crm", trade: "people", currency: "USD",
  views: [
    { id: "summary", title: "People", kind: "tiles", summary: true },
    { id: "people", title: "People", kind: "list", searchable: true, opens: "person", row: { id: "id", title: "name", subtitle: "organization", badge: "stage", trailing: "email" }, actions: [{ mutation: "person_add", label: "Add a person", on: "view" }, { mutation: "import_allow", label: "Allow import", on: "view" }] },
    { id: "board", title: "Board", kind: "board", opens: "person", row: { id: "id", title: "name", lane: "stage" } },
    { id: "followups", title: "Follow-ups", kind: "list", today: true, opens: "person", row: { id: "person_id", title: "name", subtitle: "why", trailing: "due_on", tone: "tone" }, formats: { due_on: "date" } },
    { id: "person", title: "Person", kind: "page", blocks: [{ kind: "fields" }, { kind: "list", title: "To follow up", row: { id: "id", title: "why", trailing: "due_on" }, actions: [{ mutation: "follow_up_done", label: "Done", on: "row", fixed: { id: "id" } }] }],
      actions: [{ mutation: "note_add", label: "Add a note", on: "view", fixed: { person_id: "id" } }] },
  ],
  mutations: {
    import_allow: { name: "import_allow", describe: "Counts a staged file.", personOnly: true, args: [] },
    person_add: { name: "person_add", describe: "Adds a person.", personOnly: false, args: [{ name: "name", kind: "text", required: true, describe: "" }] },
    note_add: { name: "note_add", describe: "Writes a note.", personOnly: false, args: [{ name: "person_id", kind: "integer", required: true, describe: "" }, { name: "body", kind: "text", required: true, describe: "What to remember" }] },
    follow_up_done: { name: "follow_up_done", describe: "Marks it done.", personOnly: false, args: [{ name: "id", kind: "integer", required: true, describe: "" }] },
  },
};
function crmView(viewId: string, id: string | null, q: string): unknown {
  switch (viewId) {
    case "summary": return { view: "summary", kind: "tiles", title: "People", masked: [], more: false, tiles: [{ label: "People", value: 2, caption: "current" }, { label: "To follow up", value: 1, tone: "warn" }] };
    case "people": return { view: "people", kind: "list", title: "People", masked: [], more: false, row: CRM_VIEWS.views[1]!.row,
      rows: CRM_PEOPLE.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase())) };
    case "followups": return { view: "followups", kind: "list", title: "Follow-ups", masked: [], more: false, row: CRM_VIEWS.views[3]!.row, formats: { due_on: "date" },
      rows: [{ person_id: 2, name: "Bo Fox", why: "Send the quote", due_on: "2026-10-30", tone: null }, { person_id: 1, name: "Ava Reed", why: "Call back", due_on: "2026-10-20", tone: "bad" }] };
    case "board": return { view: "board", kind: "board", title: "Board", masked: [], more: false, lanes: [{ name: "Lead", closed: false }, { name: "Won", closed: true }], rows: CRM_PEOPLE, row: CRM_VIEWS.views[2]!.row };
    default: return { view: "person", kind: "page", title: "Person", masked: ["phone"], more: false, blocks: [
      { kind: "fields", rows: [{ name: CRM_PEOPLE.find((p) => String(p.id) === id)?.name ?? "?", phone: "•••• 4477" }], masked: ["phone"] },
      { kind: "list", title: "To follow up", masked: [], row: { id: "id", title: "why", trailing: "due_on" }, actions: [{ mutation: "follow_up_done", label: "Done", on: "row", fixed: { id: "id" } }], rows: [{ id: 5, why: "Send the quote", due_on: "2026-11-02" }] },
    ] };
  }
}

const folderView = (machine: string, added: string[]) => ({ machine, home: "/home/me", roots: ["/home/me", "/home/me/Projects", ...added], added });

function apiAnswer(machine: string, method: string, path: string, body: Dict | null): unknown {
  const [route, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  const laptop = machine === "laptop";
  if (method === "GET") {
    // A Space's Foremen mode (SpaceScreen.tsx's Crew line).
    if (/^\/spaces\/[^/]+\/foremen$/.test(route!)) return { foremen: "on-call" };
    // All money (pages/AllMoney.tsx, Home's Money card): one business on laptop, the household on office.
    if (route === "/money/all") return {
      machine, month: params.get("month"), currency: params.get("to") ?? (laptop ? "USD" : "XCD"),
      spaces: laptop
        ? [{ space: "happy-tails", name: "Happy Tails", kind: "own", project: "paws-money", home: "USD", setUp: true, in: 108000, out: 27000, kept: 81000, owed: 13500, netWorth: 270000, waiting: 2, months: [{ month: "2026-10", kept: 30000 }, { month: "2026-11", kept: 81000 }] },
           { space: "skn", name: "SKN Villa", kind: "own", project: "skn-money", home: "USD", setUp: false, in: 0, out: 0, kept: 0, owed: 0, netWorth: 0, waiting: 0, months: [] }]
        : [{ space: "personal", name: "Personal", kind: "family", project: "personal-money", home: "XCD", setUp: true, in: 300000, out: 100000, kept: 200000, owed: 0, netWorth: 700000, waiting: 0, months: [] }],
    };
    switch (route) {
      case "/projects": return { machine, projects: laptop ? LAPTOP_PROJECTS : OFFICE_PROJECTS };
      case "/tmux": return laptop ? LAPTOP_TMUX : OFFICE_TMUX;
      case "/approvals": return laptop ? APPROVALS : { machine, approvals: [APPROVALS.approvals[0]] };
      case "/views": return params.get("project") === "crm" ? CRM_VIEWS : { project: params.get("project"), trade: "", views: [], mutations: {}, currency: "USD" };
      case "/boards": return { project: params.get("project"), space: null, currency: "USD", boards: [] };
      case "/view": return crmView(String(params.get("view")), params.get("id"), params.get("q") ?? "");
      case "/org": return laptop ? { org: ORG, home: true } : { org: { revision: 0, companies: [], seats: {} }, home: false };
      case "/notices":
        return { boot: "boot-1", seq: 2, notices: laptop ? [
          { seq: 1, kind: "needs-input", projectId: "cobra", title: "Cobra asks", body: "Run npm test?" },
          { seq: 2, kind: "finished", projectId: "corner-bakery", title: "corner-bakery finished", body: "All done." }] : [] };
      case "/orch/status": return laptop ? ORCH : { ...ORCH, machine, workers: [{ ...ORCH.workers[0], machine, parent: "infra", parentName: "infra" }],
        projects: [], queue: [ORCH.queue[0]], budget: [{ ...ORCH.budget[0], account: "other@example.com" }] };
      case "/orch/history": return laptop ? ORCH_HISTORY : { ...ORCH_HISTORY, done: [ORCH_HISTORY.done[0]] };
      case "/prs": return laptop ? PRS : MINI_PRS;
      case "/alerts": return laptop ? ALERTS : { host: machine, alerts: [ALERTS.alerts[1]] };
      case "/system": return laptop ? SYSTEM(machine) : SYSTEM(machine, { power: { ac: true, battery: null, lid: null, lidAwake: { available: false, on: false } } });
      case "/usage": return USAGE(machine);
      case "/history": return HISTORY(machine);
      case "/transcript": return transcriptFor(String(params.get("session")));
      // Cobra's thread: the hub (laptop) keeps one; any other computer answers 404 not-hub.
      case "/thread":
        if (!laptop) throw { status: 404, message: "not-hub" };
        return THREAD;
      case "/git/repo": return { ...REPO, project: { ...REPO.project, id: params.get("project") } };
      case "/git/tidy": return TIDY(machine);
      case "/capabilities": return { ...CAPS, machine };
      case "/repos/local": return LOCAL_REPOS;
      case "/repos/github": return GITHUB_REPOS;
      case "/templates": return { host: machine, templates: [{ id: "assess-branches", name: "Assess branches", prompt: "…" }, { id: "review", name: "Review", prompt: "…" }] };
      case "/accounts": return ACCOUNTS;
      case "/accounts/codex/status": return { login: { id: params.get("id"), state: "waiting" } };
      case "/settings/engines": return { ...ENGINES, machine };
      case "/settings/folders": return folderView(machine, laptop ? ["/home/me/code/work"] : []);
      case "/brain": return { ...BRAIN, machine, brain: laptop ? BRAIN.brain : { revision: 0, rules: [], priors: {} } };
      case "/policy": return POLICY(machine, laptop ? 3 : 2);
      case "/api-lane": return { ...API_LANE, machine };
      case "/policy/refused": return laptop ? REFUSED : { machine, refused: [] };
      case "/audit/log": return { machine, entries: laptop ? [{ id: "a".repeat(16), at: Date.now(), kind: "merge", actor: "agent", outcome: "ok", subject: { target: "me/r#7" }, text: "Cobra merged me/r#7" }] : [], more: false };
      case "/decided": return laptop ? DECIDED : { decided: [] };
      case "/morning": return laptop ? MORNING : { ...MORNING, sends: false, latest: null };
      case "/local": return { ...LOCAL, computer: machine };
      case "/integrations/google": return GOOGLE(machine);
      case "/integrations/cloudflare": return CLOUDFLARE(machine);
      case "/email/mailboxes": return {
        boxes: laptop ? [{ id: "b1", provider: "icloud", address: "studio@icloud.com", user: "studio@icloud.com", addedAt: "2026-11-02T15:00:00Z", spaces: ["paws"] }] : [],
        providers: [{ id: "icloud", name: "iCloud Mail", help: "Make an app-specific password." }, { id: "zoho", name: "Zoho Mail", help: "Make an app password." }],
        regions: ["com", "eu"],
        spaces: laptop ? [{ id: "paws", name: "Happy Tails", box: "b1" }] : [],
      };
      case "/routines": return laptop ? ROUTINES : { routines: [] };
      case "/trust": return laptop && (params.get("project") ?? "paws") === "paws" ? TRUST : { grants: [], always: [], receipts: [] };
      case "/db/journal": return params.get("project") === "paws" ? JOURNAL : { project: params.get("project"), entries: [] };
      case "/mcp": return laptop ? { ...MCP, machine } : { ...MCP, machine, github: { binary: null, pin: null }, entries: [],
        integrations: [{ id: "github", title: "GitHub", state: "disconnected", account: null, enabled: false, methods: ["device", "token"],
          tokenUrl: "https://github.com/settings/tokens" }] };
    }
  } else {
    switch (route) {
      case "/session": return { ok: true };
      case "/org": return { org: { ...ORG, revision: ORG.revision + 1 } };
      case "/view/write": return { journal: 9, summary: `Ran ${String(body?.mutation)}.`, changes: [] };
      case "/view/reveal": return { value: "555-010-4477" };
      case "/integrations/cloudflare/start": return { url: "https://dash.cloudflare.com/oauth2/auth?client_id=c&state=s1" };
      case "/integrations/cloudflare/finish": return { ...CLOUDFLARE("laptop"), accounts: [CF_ACCOUNTS[0]] };
      case "/integrations/cloudflare/account": return { ...CLOUDFLARE("laptop"), account: CF_ACCOUNTS.find((a) => a.id === body?.id) ?? null };
      case "/integrations/cloudflare/disconnect": return CLOUDFLARE("office");
      case "/git": {
        const did = ({ park: "parked", sync: "synced", resume: "resumed", "delete-branch": "deleted", "merge-pr": "merged", "close-pr": "closed" } as Dict)[String(body?.action)];
        return { ok: true, project: body?.project, action: body?.action, did, branch: body?.action === "park" ? "wip/2026-10-19" : body?.branch, git: null };
      }
      case "/session/new": return { ok: true, project: { ...LAPTOP_PROJECTS[5] }, dispatched: true };
      case "/project/create":
        return { ok: true, project: { id: "site", name: "site", machine, path: "/home/me/Projects/site", session: "site" }, did: "clone",
          started: true, trusted: true, remoteUrl: "https://github.com/example/site.git", warnings: ["gh could not set the default branch"] };
      case "/accounts/codex/start": return { login: { id: "L1", state: "waiting", url: "https://auth.openai.com/codex/device", code: "WXYZ-9876" } };
      case "/accounts/claude": return { ...ACCOUNTS, account: { id: "a4", provider: "claude", label: "New", addedAt: iso(0) } };
      case "/mcp/connect":
        return { integration: body?.method === "device"
          ? { id: "github", title: "GitHub", state: "signing-in", account: null, enabled: false, methods: ["device", "token"],
            signIn: { userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresAt: ahead(600) } }
          : { id: "github", title: "GitHub", state: "connected", account: "me", enabled: true, methods: ["device", "token"] } };
      case "/mcp/disconnect":
        return { integration: { id: "github", title: "GitHub", state: "disconnected", account: null, enabled: false, methods: ["device", "token"] } };
      case "/policy": return { lines: [{ text: "Preset: Balanced → Auto", widens: true }], widens: true, revision: 4 };
      case "/policy/preview": return { lines: [{ text: "Preset: Balanced → Auto", widens: true }], widens: true };
      case "/decided/undo": return { decided: { ...DECIDED.decided[0], undone: iso(0), undoNote: "revert PR #43 opened" } };
      case "/db/undo": return { ...JOURNAL.entries[1], undone: true, undoable: false, undoneAt: iso(0) };
      case "/settings/folders":
        return body?.add
          ? { ...folderView(machine, ["/home/me/code/work", "/home/me/code"]), said: "Looking in ~/code too" }
          : { ...folderView(machine, []), said: "No longer looking in ~/code/work" };
      default: return { ok: true };
    }
  }
  tauri.unknown.add(`${method} ${route}`);
  throw { status: 404, message: `no ${route}` };
}

// The desk's passcode (src-tauri/src/passcode.rs), as the Rust side answers: made once, unlocks for a while, wrong tries are told.
const passcode = { saved: null as string | null, unlocked: false };
const passcodeStatus = () => ({ set: passcode.saved !== null, unlocked: passcode.unlocked, unlockedForS: passcode.unlocked ? 300 : 0, waitS: 0 });
function passcodeRoute(cmd: string, args: Dict): unknown {
  switch (cmd) {
    case "passcode_status": return passcodeStatus();
    case "passcode_set":
      if (passcode.saved !== null && args.old !== passcode.saved) throw "That is not the passcode.";
      passcode.saved = String(args.new);
      passcode.unlocked = true;
      return null;
    case "passcode_unlock":
      if (args.code !== passcode.saved) throw "That is not the passcode.";
      passcode.unlocked = true;
      return null;
    case "passcode_lock": passcode.unlocked = false; return null;
    case "passcode_clear":
      if (args.code !== passcode.saved) throw "That is not the passcode.";
      passcode.saved = null;
      passcode.unlocked = false;
      return null;
  }
  return undefined;
}

tauri.route = (cmd, args) => {
  const passcoded = passcodeRoute(cmd, args);
  if (passcoded !== undefined) return passcoded;
  switch (cmd) {
    case "computers": return MACHINES;
    case "api_owner": return apiAnswer(String(args.machine), String(args.method), String(args.path), (args.body as Dict) ?? null);
    case "api": return apiAnswer(String(args.machine), String(args.method), String(args.path), (args.body as Dict) ?? null);
    case "api_upload": return { path: "/tmp/attach/x.png", size: 10 };
    case "design_image": return "data:image/png;base64,iVBORw0KGgo=";
    case "design_save": return `/home/a/Pictures/Cobra/${String(args.name)}`;
    case "pins": return ["repo:https://github.com/example/lookfocus.git"];
    case "toggle_pin": return true;
    case "settings": return {};
    case "host_state":
      return { os: "linux", hostname: "laptop",
        agentInstalled: true, agentPath: "/home/me/.local/bin/cobra-agent", agentPort: 8787, tmuxSocket: "cobra",
        agentService: true, agentAnswering: true };
    case "link_agent": return "Linked laptop.";
    case "desk_name": return "laptop desktop";
    case "unlink_agent": return "Unlinked the agent.";
    default: return null; // set_setting, open_terminal, set_tray, popup_layout, show_main, …
  }
};

// -- jsdom: what a webview has and jsdom does not ---------------------------------------------------

class FakeIntersectionObserver {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(el: Element) {
    const cb = this.cb;
    setTimeout(() => cb([{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver), 0);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(el: Element) {
    const cb = this.cb;
    setTimeout(() => cb([{ target: el, contentRect: { width: 640, height: 200 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver), 0);
  }
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as Record<string, unknown>).ResizeObserver = FakeResizeObserver;
  (globalThis as Record<string, unknown>).IntersectionObserver = FakeIntersectionObserver;
  // A person who asks for reduced motion: sprites stay still. Moving ones update state on a 160 ms timer, which landed outside
  // act() whenever a test ended between two ticks ("a fleet with no tailnet…" failed in 4 of 5 runs).
  window.matchMedia = (query: string) => ({ matches: query.includes("prefers-reduced-motion"), media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) as MediaQueryList;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1024 });
  Element.prototype.scrollIntoView = function () {};
  // jsdom draws nothing: a canvas has no context.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } });
});

// -- React --------------------------------------------------------------------------------------

const errors: unknown[][] = [];
let roots: Array<{ root: Root; el: HTMLElement }> = [];

beforeEach(() => {
  // The pages as they were, with the crew shown (Settings → This app → Show the crew); "smoke: the crew hidden" turns it off.
  saveShowCrew(true);
  errors.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    errors.push(["[warn]", ...args]);
  });
});

afterEach(async () => {
  for (const { root, el } of roots) {
    await act(async () => root.unmount());
    el.remove();
  }
  roots = [];
  vi.restoreAllMocks();
  const text = errors.map((a) => a.map((x) => (x instanceof Error ? x.stack : String(x))).join(" ")).join("\n---\n");
  expect(text, "console.error / console.warn during render").toBe("");
});

const JUNK = /\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b|Invalid Date|\bInfinity\b/;
const junk = new Set<string>();

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
  }
  // Words a render should never show: a missing field drawn as itself.
  for (const node of document.body.querySelectorAll("*")) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3 && JUNK.test(child.textContent ?? "")) junk.add(`${node.className}: ${child.textContent}`);
    }
    for (const attr of ["title", "placeholder", "aria-label", "style"]) {
      const v = node.getAttribute(attr);
      if (v && JUNK.test(v)) junk.add(`${node.className} [${attr}]: ${v}`);
    }
  }
}

async function mount(node: ReactNode): Promise<HTMLElement> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push({ root, el });
  // As main.tsx renders: effects run, are cleaned up and run again.
  await act(async () => root.render(<StrictMode>{node}</StrictMode>));
  await flush();
  return el;
}

const text = (el: Element) => el.textContent ?? "";

function buttons(el: ParentNode, label: string | RegExp): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>("button, li, [role=radio]")].filter((b) => {
    const t = (b.textContent ?? "").trim();
    return typeof label === "string" ? t === label : label.test(t);
  });
}

function button(el: ParentNode, label: string | RegExp): HTMLElement {
  const found = buttons(el, label);
  if (!found.length) throw new Error(`no button ${label} in:\n${(el as HTMLElement).textContent?.slice(0, 2000)}`);
  return found[0];
}

async function click(target: Element, init: MouseEventInit = {}): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  });
  await flush(3);
}

async function key(target: Element, k: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await flush(2);
}

async function change(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
  await act(async () => {
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
  await flush(2);
}

async function emit(event: string, payload: unknown): Promise<void> {
  await act(async () => {
    for (const fn of tauri.handlers.get(event) ?? []) fn({ event, id: 1, payload });
  });
  await flush(2);
}

/** Escape closes a dialog (ui.tsx Dialog). */
async function escape(): Promise<void> {
  await key(window as unknown as Element, "Escape");
}

// -- the app ------------------------------------------------------------------------------------

let fleet: Fleet;
const toasts: string[] = [];
const nav: string[] = [];

function ctx(): AppCtx {
  const openChat = (m: string, s: string) => void nav.push(`chat ${m}/${s}`);
  return {
    fleet,
    actions: new Actions({ fleet, toast: (t) => void toasts.push(t), openChat }),
    toast: (t) => void toasts.push(t),
    show: (p) => void nav.push(`show ${p}`),
    openChat,
    openProject: (m, p) => void nav.push(`project ${m}/${p}`),
    newProject: () => void nav.push("new project"),
    reloadMachines: async () => config.setMachines(MACHINES),
    machinesVersion: 1,
  };
}

const withApp = (node: ReactNode) => <AppContext.Provider value={ctx()}>{node}</AppContext.Provider>;

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function loadFleet(): Promise<Fleet> {
  config.setMachines(MACHINES);
  const f = new Fleet();
  f.refresh();
  await until(() => f.loaded, "the first poll");
  // The second poll charts the worst gauge the first one read.
  const v = f.version;
  f.refresh();
  await until(() => f.version > v, "the second poll");
  return f;
}

describe("smoke: the fleet", () => {
  it("fleet.refresh() builds rows, approvals and alerts from the mocked agents", async () => {
    fleet = await loadFleet();
    expect(fleet.rows.length).toBeGreaterThan(10);
    expect(fleet.needsYou().map((r) => r.id)).toEqual(["cobra"]);
    expect(fleet.pendingApprovals()).toBe(8);
    expect(fleet.alerts.laptop.length).toBe(2);
    expect(fleet.rows.some((r) => r.name === "scratch")).toBe(true);
    expect(fleet.rows.some((r) => r.name === "cobra@desk")).toBe(false);
    expect([...tauri.unknown]).toEqual([]);
  });
});

describe("smoke: pages", () => {
  beforeEach(async () => {
    if (!fleet?.loaded) fleet = await loadFleet();
    config.setMachines(MACHINES);
  });

  it("Home", async () => {
    try {
      localStorage.clear();
    } catch {
      // no storage here
    }
    const el = await mount(withApp(<HomePage />));
    await flush(5);
    const t = text(el);
    for (const s of ["Cobra", "Good morning", "Two PRs landed overnight.", "need you.", "Today", "Budget", "Two weeks", "Done today",
      "Merge 2 pull requests in lookfocus", "Rosa's plan for lookfocus", "WAITING", "Disk almost full", "Refused by the judge",
      "Ship the login page this week.", "Which project first?"]) {
      expect(t, s).toContain(s);
    }
    for (const s of ["Pull requests", "Work map", "Tell the Lead"]) expect(t, s).not.toContain(s);
    // Her thread: the earlier conversation drawn faded under the line that began it, a digest as her message,
    // and the agent's own status lines never as the person's.
    const log = el.querySelector(".cobra-log")!;
    expect(text(log)).toContain("What landed last week?");
    expect(text(log)).toContain("While you were out: 2 landed.");
    expect(text(log)).toContain("Fresh start");
    expect(log.querySelectorAll(".thread-said.earlier").length).toBe(2);
    expect(log.querySelector(".thread-said:not(.earlier)")?.textContent).toContain("While you were out");
    expect(log.querySelector(".thread-marker.earlier")?.textContent).toContain("Cobra started");
    // Designs a Designer showed: its words, then each PNG fetched from the hub; one opens large to save.
    expect(text(log)).toContain("Two takes on the fall sale.");
    expect(log.querySelectorAll(".designs-grid.two img").length).toBe(2);
    expect(tauri.invoked.some((x) => x.cmd === "design_image" && (x.args as Dict).machine === "laptop")).toBe(true);
    await click(log.querySelector<HTMLButtonElement>(".design-tile")!);
    await click([...el.querySelectorAll<HTMLButtonElement>(".design-large button")].find((b) => b.textContent === "Save to Pictures")!);
    expect(tauri.invoked.some((x) => x.cmd === "design_save" && (x.args as Dict).name === "sale-1.png")).toBe(true);
    await click([...el.querySelectorAll<HTMLButtonElement>(".design-large button")].find((b) => b.textContent === "Close")!);
    // The plan's model dropdown.
    const select = el.querySelector<HTMLSelectElement>(".plan-task select")!;
    await change(select, "opus");
    // Show the exact request.
    await click(button(el, /Show the exact request/));
    expect(text(el)).toContain("npm test -- --run src/login");
    // Answer Cobra's question in her pane, then message her.
    await click(button(el.querySelector(".cobra")!, /corner-bakery/));
    const answered = tauri.invoked.find((x) => x.cmd === "api" && String((x.args as Dict).path).startsWith("/session")
      && (x.args as Dict).body?.action === "answer")!;
    expect((answered.args as Dict).body?.answers).toEqual([{ question: "Which project first?", option: 2 }]);
    const input = el.querySelector<HTMLInputElement>(".cobra-compose input")!;
    await change(input, "Plan the week");
    await click(button(el, "↑"));
    const said = tauri.invoked.find((x) => x.cmd === "api" && (x.args as Dict).body?.action === "say")!;
    expect((said.args as Dict).body?.text).toBe("Plan the week");
    // The brief's ✕ keeps it away, also on the next mount.
    await click(button(el, "✕"));
    expect(text(el)).not.toContain("Two PRs landed overnight.");
    const again = await mount(withApp(<HomePage />));
    await flush(5);
    expect(text(again)).not.toContain("Two PRs landed overnight.");
  });

  it("Home: a Foreman's actions show what Allow sends", async () => {
    const el = await mount(withApp(<HomePage />));
    const t = text(el);
    for (const s of ["Send: Pay stubs for the week", "EMAIL", "ann@example.com", "books@example.com", "Pay stubs, week 42", "Hi Ann,",
      "stubs-week-42.pdf", "178 KB", "Attachments · 2", "studio@icloud.com (iCloud Mail)", "Allow sends exactly this from that mailbox.",
      "FILES", "Bookkeeper (/home/me/Books)", "report.pdf", "2.3 MB", "For your records.", "Allow copies these files there.",
      "NOTE", "Ben and Cy have not sent their timesheets", "missing.md", "Nothing is sent: Allow marks it read."]) {
      expect(t, s).toContain(s);
    }
    // The long message opens folded under its first line, and unfolds.
    const folded = el.querySelector<HTMLDetailsElement>("details.action-text")!;
    expect(folded.open).toBe(false);
    await click(folded.querySelector("summary")!);
    expect(text(folded)).toContain("The totals match the timesheets.");
    const row = [...el.querySelectorAll(".brow")].find((r) => text(r).includes("Send: Pay stubs for the week"))!;
    await click(button(row, "Allow"));
    expect(toasts).toContain("Allowed · Send: Pay stubs for the week");
  });

  it("Agents, with a conversation open", async () => {
    const el = await mount(withApp(<AgentsPage open={{ machine: "laptop", session: "cobra", n: 1 }} />));
    await flush(10);
    const t = text(el);
    for (const s of ["LEAD", "FOREMEN", "WORKERS", "SESSIONS", "Rosa", "Login form", "Write the tile cache tests", "QUEUED",
      "Fix the login bug", "Cobra wants permission", "Run a shell command", "tool call", "Which fix do you want?", "/compact",
      "I need to run the tests."]) {
      expect(t, s).toContain(s);
    }
    expect(el.querySelector(".codeblock")).not.toBeNull();
    // Send a message, then open the question one.
    const input = el.querySelector<HTMLInputElement>(".compose input")!;
    await change(input, "go ahead");
    await key(input, "Enter");
    expect(text(el)).toContain("go ahead");
    await click(button(el, "Allow"));
    const docs = [...el.querySelectorAll(".inbox-row")].find((r) => text(r).includes("Lab STE setup guide"))!;
    expect(docs).toBeDefined();
    await click(docs);
    await flush(10);
    expect(text(el)).toContain("Which colour?");
    // The Lead: its New conversation button arms then clears.
    const leadHead = [...el.querySelectorAll(".list-head")].find((h) => text(h) === "LEAD")!;
    const lead = leadHead.parentElement!.querySelector(".inbox-row")!;
    await click(lead);
    await flush(5);
    // The Lead's chat draws her thread: the earlier conversation faded above the current one.
    expect(text(el.querySelector(".chat-log")!)).toContain("What landed last week?");
    expect(el.querySelectorAll(".chat-log .thread-said.earlier").length).toBe(2);
    await click(button(el, "New conversation"));
    expect(text(el)).toContain("Click again to clear");
    await click(button(el, "Click again to clear"));
    await flush(5);
    expect(toasts).toContain("The Lead starts a new conversation");
    // Nothing she said is wiped from view: the thread stays.
    expect(text(el.querySelector(".chat-log")!)).toContain("What landed last week?");
    // Links and inline code in a message; an image with the next message.
    for (const a of [...el.querySelectorAll(".chat-log a")]) await click(a);
    await click(el.querySelector<HTMLElement>("button[title='Attach an image']")!);
    expect(text(el)).toContain("shot.png");
    await change(el.querySelector<HTMLInputElement>(".compose input")!, "look at this");
    await click(button(el, "Send"));
    await flush(5);
    expect(tauri.invoked.some((x) => x.cmd === "api_upload")).toBe(true);
    expect(text(el)).toContain("look at this");
  });

  it("Projects, its menu and every dialog", async () => {
    const el = await mount(withApp(<ProjectsPage newProjectAsk={0} />));
    const t = text(el);
    for (const s of ["PINNED · ", "ACTIVE · ", "NOT STARTED · ", "Cobra", "lookfocus", "corner-bakery", "notes", "Lab STE setup guide",
      "WAITING", "WORKING", "DONE", "scratch", "DIVERGED"]) {
      expect(t, s).toContain(s);
    }
    const rowOf = (name: string) => [...el.querySelectorAll(".brow")].find((r) => r.querySelector(".btitle")?.textContent === name)!;
    const menu = async (name: string) => {
      const row = rowOf(name);
      expect(row, name).toBeDefined();
      const dots = [...row.querySelectorAll("button")].find((b) => b.textContent === "⋯")!;
      await click(dots);
      return document.body.querySelector(".menu")!;
    };
    // Every row's menu opens.
    for (const r of [...el.querySelectorAll(".brow")]) {
      const dots = [...r.querySelectorAll("button")].find((b) => b.textContent === "⋯");
      if (!dots) continue;
      await click(dots);
      expect(document.body.querySelector(".menu"), text(r)).not.toBeNull();
      await escape();
    }
    // Every item of every row's menu.
    for (const name of [...el.querySelectorAll(".brow .btitle")].map((t) => t.textContent ?? "")) {
      const items = [...(await menu(name)).querySelectorAll("button")].map((b) => b.textContent ?? "");
      await escape();
      for (const item of items) {
        const m = await menu(name);
        await click(button(m, item));
        await flush(3);
        while (document.body.querySelector(".scrim")) await escape();
      }
    }
    // New session…
    await click(button(await menu("Cobra"), "New session…"));
    await flush(5);
    expect(text(document.body)).toContain("New session in Cobra");
    expect(text(document.body)).toContain("qwen-tuned:fast96k");
    const model = document.body.querySelector<HTMLSelectElement>(".dialog select")!;
    await change(model, "local:crawler");
    expect(text(document.body)).toContain("Run in Claude Code instead");
    await click(button(document.body, "Start"));
    // Start with a prompt…
    await click(button(await menu("notes"), "Start with a prompt…"));
    expect(text(document.body)).toContain("Start notes");
    await escape();
    // Kill session…
    await click(button(await menu("corner-bakery"), "Kill session…"));
    expect(text(document.body)).toContain("Kill corner-bakery on Laptop?");
    await click(button(document.body, "Cancel"));
    // Run a template…
    await click(button(await menu("lookfocus"), "Run a template…"));
    expect(text(document.body)).toContain("Run a template in lookfocus");
    await click(button(document.body, "Cancel"));
    // Remove from list…
    await click(button(await menu("notes"), "Remove from list…"));
    expect(text(document.body)).toContain("Remove notes from the list?");
    await click(button(document.body, "Cancel"));
    // A loose session's menu.
    await click(button(await menu("scratch"), "Kill session…"));
    await click(button(document.body, "Cancel"));
    // New project…
    await click(button(el, "New project…"));
    await flush(5);
    const np = document.body.querySelector(".dialog")!;
    expect(np).not.toBeNull();
    expect(text(np)).toContain("oldthing");
    await click(button(np, "GitHub"));
    await flush(5);
    expect(text(np)).toContain("My website");
    expect(text(np)).toContain("ALREADY HERE");
    await change(np.querySelector<HTMLInputElement>("input[type=search]")!, "site");
    await click([...np.querySelectorAll(".brow, [role=option], .pj-list > *")][0]);
    await click(button(np, "New"));
    await change(np.querySelector<HTMLInputElement>("input.entry")!, "My Project");
    expect(text(np)).toContain("my-project");
    await click(button(np, "GitHub"));
    await flush(5);
    await click([...np.querySelectorAll(".pj-list > *")][0]);
    await click(button(np, "Create and open"));
    await flush(5);
    // Tidy
    await click(button(el, "Tidy"));
    await flush(5);
    expect(text(document.body)).toContain("feat/old");
    await escape();
  });

  it("Project page", async () => {
    const el = await mount(withApp(<ProjectPage machine="laptop" project="lookfocus" onClose={() => {}} />));
    await flush(5);
    const t = text(el);
    for (const s of ["lookfocus", "SESSION", "CLAUDE WORKING", "SESSIONS · ", "Rosa", "REPOSITORY", "PULL REQUESTS · 3", "BRANCHES · ",
      "wip/2026-10-01", "READY", "CHECKS FAILING", "Foreman: new conversation"]) {
      expect(t, s).toContain(s);
    }
    await click(button(el, "Merge"));
    expect(text(document.body)).toContain("Merge #11?");
    await click(button(document.body, "Cancel"));
    await click(button(el, "+ New session"));
    await flush(3);
    expect(text(document.body)).toContain("New session in lookfocus");
    await escape();
    await click(button(el, "Kill…"));
    expect(text(document.body)).toContain("Kill lookfocus on Laptop?");
    await escape();
  });

  it("Project page: two checkouts, a needs-you one, a missing one", async () => {
    const el = await mount(withApp(<ProjectPage machine="laptop" project="cobra" onClose={() => {}} />));
    await flush(5);
    expect(text(el)).toContain("WAITING ON YOU");
    expect(text(el)).toContain("2 checkouts");
    await click(button(el, /^Office · /));
    await flush(5);
    expect(text(el)).toContain("NO SESSION");
    const scripts = await mount(withApp(<ProjectPage machine="laptop" project="scripts" onClose={() => {}} />));
    expect(text(scripts)).toContain("Not a git repository.");
    const gone = await mount(withApp(<ProjectPage machine="laptop" project="nope" onClose={() => {}} />));
    expect(text(gone)).toContain("not listed right now");
  });

  it("Project page: a trade's dashboard with its tiles, tabs, search, board, a person's page, Show and a form", async () => {
    const el = await mount(withApp(<ProjectPage machine="laptop" project="crm" onClose={() => {}} />));
    await flush(10);
    expect(text(el)).toContain("Dashboard");
    expect(text(el)).toContain("To follow up");
    expect(el.querySelector(".dash-tab.on")?.textContent).toBe("People");
    expect([...el.querySelectorAll(".dash-row-title")].map(text)).toEqual(["Ava Reed", "Bo Fox"]);
    await change(el.querySelector<HTMLInputElement>(".dash-search")!, "fox");
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    await flush(6);
    expect([...el.querySelectorAll(".dash-row-title")].map(text)).toEqual(["Bo Fox"]);
    await click(button(el, "Board"));
    await flush(4);
    expect([...el.querySelectorAll(".dash-lane-head b")].map(text)).toEqual(["Lead", "Won"]);
    expect(text(el)).toContain("End stage");
    // A card opens the person's page: the number is dots until Show.
    await click(el.querySelector<HTMLElement>(".dash-card")!);
    await flush(6);
    expect(text(el.querySelector(".dash-title")!)).toBe("Ava Reed");
    expect(text(el)).toContain("•••• 4477");
    // Show asks for the passcode; with none made it makes one first, and closing the dialog shows nothing.
    passcode.saved = null;
    passcode.unlocked = false;
    await click(button(el, "Show"));
    await flush(4);
    expect(text(document.body)).toContain("Make a passcode");
    await click(button(document.body, "Cancel"));
    await flush(3);
    expect(text(el)).not.toContain("555-010-4477");
    await click(button(el, "Show"));
    await flush(3);
    const dialog = () => document.querySelector<HTMLElement>(".dialog")!;
    const typeIn = async (i: number, value: string) => change(dialog().querySelectorAll<HTMLInputElement>("input")[i]!, value);
    await typeIn(0, "short");
    await typeIn(1, "short");
    await click(button(dialog(), "Make passcode"));
    expect(text(dialog().querySelector(".dash-error")!)).toBe("A passcode is at least 8 characters.");
    await typeIn(0, "correct horse");
    await typeIn(1, "correct horse");
    await click(button(dialog(), "Make passcode"));
    await flush(4);
    expect(text(el)).toContain("555-010-4477");
    // Locked again: Show asks, a wrong passcode is told and keeps the dialog, the right one shows it.
    passcode.unlocked = false;
    await click(button(el, "‹ Back"));
    await flush(3);
    await click(el.querySelector<HTMLElement>(".dash-card")!);
    await flush(5);
    expect(text(el)).toContain("•••• 4477");
    await click(button(el, "Show"));
    await flush(3);
    await typeIn(0, "not the one");
    await click(button(dialog(), "Unlock"));
    await flush(3);
    expect(text(dialog().querySelector(".dash-error")!)).toBe("That is not the passcode.");
    await typeIn(0, "correct horse");
    await click(button(dialog(), "Unlock"));
    await flush(4);
    expect(document.querySelector(".dialog")).toBeNull();
    expect(text(el)).toContain("555-010-4477");
    // A note's form refuses an empty body, then sends the person's id with what was typed.
    await click(button(el, "Add a note"));
    await click(button(el, "Save"));
    expect(text(el.querySelector(".dash-error")!)).toBe("Body is needed");
    await change(el.querySelector<HTMLTextAreaElement>(".dialog textarea")!, "Likes mornings");
    await click(button(el, "Save"));
    await flush(4);
    const sent = tauri.invoked.filter((x) => x.cmd === "api" && (x.args as Dict).path === "/view/write");
    expect(((sent.at(-1)!.args as Dict).body as Dict)).toMatchObject({ project: "crm", mutation: "note_add", args: { person_id: 1, body: "Likes mornings" } });
    // A row button runs its write on that row's id; Back returns to the list.
    await click(button(el, "Done"));
    await flush(3);
    expect(((tauri.invoked.filter((x) => x.cmd === "api" && (x.args as Dict).path === "/view/write").at(-1)!.args as Dict).body as Dict)).toMatchObject({ mutation: "follow_up_done", args: { id: 5 } });
    await click(button(el, "‹ Back"));
    await flush(4);
    expect(el.querySelector(".dash-lane")).not.toBeNull();
    // A write that is the person's alone goes through the passcode and the owner route; a plain one never asks.
    await click(button(el, "People"));
    await flush(4);
    passcode.unlocked = false;
    tauri.invoked.length = 0;
    await click(button(el, "Allow import"));
    await flush(3);
    expect(text(dialog())).toContain("Allow import: this is yours to allow");
    await click(button(dialog(), "Cancel"));
    await flush(3);
    expect(tauri.invoked.some((x) => x.cmd === "api_owner")).toBe(false);
    await click(button(el, "Allow import"));
    await flush(3);
    await typeIn(0, "correct horse");
    await click(button(dialog(), "Unlock"));
    await flush(5);
    const owned = tauri.invoked.find((x) => x.cmd === "api_owner" && (x.args as Dict).path === "/view/write")!;
    expect((owned.args as Dict).body).toMatchObject({ mutation: "import_allow" });
    await click(button(el, "Add a person"));
    expect(document.querySelector(".dialog")).not.toBeNull();
    await click(button(document.body, "Cancel"));
    // A project whose trade ships none has no dashboard.
    const plain = await mount(withApp(<ProjectPage machine="laptop" project="paws" onClose={() => {}} />));
    await flush(8);
    expect(text(plain)).not.toContain("Dashboard");
  });

  it("Home: a routine approval shows when, the first run, the project and its brief folded", async () => {
    const el = await mount(withApp(<HomePage />));
    const row = [...el.querySelectorAll(".brow")].find((r) => text(r).includes("Run “Month-end summary” on the last day of each month at 17:00?"))!;
    const t = text(row);
    for (const s of ["ROUTINE", "When", "On the last day of each month at 17:00", "First run", "Project", "paws-paths-payroll", "Brief",
      "Write the month's payroll summary.", "Allow sets it up: at each run Cobra gives the Foreman this brief."]) {
      expect(t, s).toContain(s);
    }
    const folded = row.querySelector<HTMLDetailsElement>("details.action-text")!;
    expect(folded.open).toBe(false);
    await click(folded.querySelector("summary")!);
    expect(text(folded)).toContain("If a pay run is still open");
    await click(button(row, "Allow"));
    const sent = tauri.invoked.find((x) => x.cmd === "api" && String((x.args as Dict).path) === "/approvals/answer"
      && (x.args as Dict).body?.id === "ap-routine")!;
    expect((sent.args as Dict).body).toEqual({ id: "ap-routine", allow: true });
  });

  it("Project page: routines with Run now, Pause or Resume, and Remove behind a confirm", async () => {
    const el = await mount(withApp(<ProjectPage machine="laptop" project="paws" onClose={() => {}} />));
    await flush(5);
    const t = text(el);
    // A paused routine says PAUSED even after a failed run; its last run's line says what went wrong.
    for (const s of ["ROUTINES · 2", "Fortnightly payroll", "Every other Friday at 09:00 · Next:", "Ran ", "Monday timesheet check", "PAUSED",
      "Couldn't start", "the Foreman could not start", routines.NOTE]) {
      expect(t, s).toContain(s);
    }
    expect(t).not.toContain("Weekly tidy");
    const api = (path: string) => tauri.invoked.filter((x) => x.cmd === "api" && String((x.args as Dict).path) === path);
    await click(buttons(el, "Run now")[0]);
    await flush(5);
    expect((api("/routines/run")[0].args as Dict).body).toEqual({ id: "rt-payroll" });
    expect(toasts).toContain("Running Fortnightly payroll: the Foreman has its brief");
    await click(button(el, "Pause"));
    await flush(5);
    expect((api("/routines/pause")[0].args as Dict).body).toEqual({ id: "rt-payroll", enabled: false });
    await click(button(el, "Resume"));
    await flush(5);
    expect((api("/routines/pause")[1].args as Dict).body).toEqual({ id: "rt-timesheets", enabled: true });
    await click(buttons(el, "Remove")[0]);
    expect(text(document.body)).toContain("Remove “Fortnightly payroll”?");
    await click(button(document.body, "Cancel"));
    expect(api("/routines/remove").length).toBe(0);
    await click(buttons(el, "Remove")[0]);
    await click(button(document.querySelector(".dialog")!, "Remove"));
    await flush(5);
    expect((api("/routines/remove")[0].args as Dict).body).toEqual({ id: "rt-payroll" });
    // A project whose Foreman runs, with no routine, gets the hint.
    const infra = await mount(withApp(<ProjectPage machine="office" project="infra" onClose={() => {}} />));
    await flush(5);
    expect(text(infra)).toContain("ROUTINES");
    expect(text(infra)).toContain(routines.HINT);
    // One with no Foreman and none: nothing.
    const quiet = await mount(withApp(<ProjectPage machine="office" project="cobra" onClose={() => {}} />));
    await flush(5);
    expect(text(quiet)).not.toContain("ROUTINES");
  });

  it("Home: a trust card shows who, the templates and the cards it was, with Trust and Keep asking", async () => {
    const el = await mount(withApp(<HomePage />));
    const row = [...el.querySelectorAll(".brow")].find((r) => text(r).includes("Let paws-paths-payroll send pay-stub to these 2 addresses without asking?"))!;
    const t = text(row);
    for (const s of ["TRUST", "To", "ana@example.com, ben@example.com", "Templates", "pay-stub", "You allowed", "3 times in a row",
      "Send: 2 pay stubs, Oct 1 to 15", "Trust lets Cobra do these with no card"]) {
      expect(t, s).toContain(s);
    }
    expect(buttons(row, "Allow").length).toBe(0);
    await click(button(row, "Keep asking"));
    const sent = tauri.invoked.find((x) => x.cmd === "api" && String((x.args as Dict).path) === "/approvals/answer"
      && (x.args as Dict).body?.id === "ap-trust")!;
    expect((sent.args as Dict).body).toEqual({ id: "ap-trust", allow: false });
  });

  it("Home: Landed lists what ran on trust today, and Next the soonest routine", async () => {
    const el = await mount(withApp(<HomePage />));
    await flush(5);
    const t = text(el);
    for (const s of ["Landed", "Send: 2 pay stubs, Nov 16 to 30", "SENT", "paws-paths-payroll · sent to 2 addresses from penny@example.com",
      "Next: Morning follow-ups · Happy Tails CRM"]) {
      expect(t, s).toContain(s);
    }
  });

  it("Home: What Cobra did, with Undo on a second press; trusted sends stay under Landed", async () => {
    const el = await mount(withApp(<HomePage />));
    await flush(5);
    const t = text(el);
    for (const s of ["What Cobra did", "Merged #42 on green", "example/tallgrass#42 Fix the map", "1 of 10 merges · 0 of 25 cards"]) {
      expect(t, s).toContain(s);
    }
    expect(t).not.toContain("Sent the invoice");
    const api = (path: string) => tauri.invoked.filter((x) => x.cmd === "api" && String((x.args as Dict).path) === path);
    await click(button(el, "Undo"));
    expect(api("/decided/undo").length).toBe(0);
    expect(text(el)).toContain("GitHub opens a PR that reverts it.");
    await click(button(el, "Press again: Open a revert PR"));
    await flush(5);
    expect((api("/decided/undo")[0].args as Dict).body).toEqual({ id: "jd_merge" });
    expect(toasts).toContain("Undone · Merged #42 on green: revert PR #43 opened");
  });

  it("Project page: trust with Revoke on a second press, Clear, and what landed", async () => {
    const el = await mount(withApp(<ProjectPage machine="laptop" project="paws" onClose={() => {}} />));
    await flush(5);
    const t = text(el);
    for (const s of ["TRUST", "Send pay-stub", "TRUSTED", "To ana@example.com, ben@example.com · from pay-stub", "1 run since",
      "Send a message", "ASKS", "Keeps asking since", "LANDED · 1", "Send: 2 pay stubs, Nov 16 to 30", trust.NOTE]) {
      expect(t, s).toContain(s);
    }
    const api = (path: string) => tauri.invoked.filter((x) => x.cmd === "api" && String((x.args as Dict).path) === path);
    await click(button(el, "Revoke"));
    expect(api("/trust/revoke").length).toBe(0);
    await click(button(el, "Press again to revoke"));
    await flush(5);
    expect((api("/trust/revoke")[0].args as Dict).body).toEqual({ key: "k".repeat(64) });
    expect(toasts).toContain("Send pay-stub: asks again from now on");
    await click(button(el, "Clear"));
    await flush(5);
    expect((api("/trust/clear")[0].args as Dict).body).toEqual({ key: "a".repeat(64) });
    // A project with nothing trusted: no section.
    const quiet = await mount(withApp(<ProjectPage machine="office" project="infra" onClose={() => {}} />));
    await flush(5);
    expect(text(quiet)).not.toContain("TRUST");
  });

  it("Project page: records and Undo behind a confirm", async () => {
    const el = await mount(withApp(<ProjectPage machine="laptop" project="paws" onClose={() => {}} />));
    await flush(5);
    const t = text(el);
    for (const s of ["RECORDS", "JOURNAL · 4", "Hours for week 42",
      "Record hours · by the Foreman · 4 rows", "UNDONE", "UNDO", "Import employees from a file", "by a file import"]) {
      expect(t, s).toContain(s);
    }
    // Cobra keeps no copy of the records in a Google Sheet, so the section offers none.
    for (const gone of ["Open sheet", "The sheet", "No sheet yet", "Last pushed"]) expect(t, gone).not.toContain(gone);
    // Undo is offered on the undoable rows only (not the undone one, not the undo itself).
    expect(buttons(el, "Undo").length).toBe(2);
    await click(buttons(el, "Undo")[0]);
    expect(text(document.body)).toContain("Undo “Hours for week 42”?");
    await click(button(document.body, "Cancel"));
    expect(tauri.invoked.some((x) => x.cmd === "api" && String((x.args as Dict).path) === "/db/undo")).toBe(false);
    await click(buttons(el, "Undo")[0]);
    await click(button(document.querySelector(".dialog")!, "Undo"));
    await flush(5);
    const sent = tauri.invoked.find((x) => x.cmd === "api" && String((x.args as Dict).path) === "/db/undo")!;
    expect((sent.args as Dict).body).toEqual({ project: "paws", journal: 6 });
    expect(toasts).toContain("Undone · Hours for week 42");
    // A project with no trade asks for no records.
    const plain = await mount(withApp(<ProjectPage machine="laptop" project="lookfocus" onClose={() => {}} />));
    expect(text(plain)).not.toContain("RECORDS");
  });

  it("My Organization: the chart, a Space's screen, All routines, a Foreman's card, a move, New Space and the list", async () => {
    const el = await mount(withApp(<OrgPage open={null} />));
    await flush(10);
    // You, Cobra and the Spaces as a tree; each Space a card with its mark, NEXT and what ran.
    expect(el.querySelector("ul.org-tree")).not.toBeNull();
    expect(text(el.querySelector(".org-node")!)).toBe("You");
    const paws = [...el.querySelectorAll<HTMLButtonElement>(".org-space")].find((card) => text(card).includes("Happy Tails"))!;
    expect(text(paws.querySelector(".org-mark")!)).toBe("H");
    expect(text(paws)).toContain("Next");
    expect(text(paws.querySelector(".org-next")!)).toMatch(/^Morning follow-ups · /);
    expect(text(paws.querySelector(".org-now")!)).toMatch(/^✓ Morning follow-ups ran /);
    // One click opens its own screen.
    await click(paws);
    await flush(8);
    const screen = el.querySelector<HTMLElement>(".space-screen")!;
    expect(screen, "the Space's own screen").not.toBeNull();
    expect(el.querySelector(".org-bar"), "no chart bar over a Space's screen").toBeNull();
    for (const w of ["Happy Tails", "Ask Cobra about Happy Tails", "Manage…", "Today", "Dashboards", "To do", "Activity", "Crew", "Hire a Foreman", "To follow up"]) {
      expect(text(screen), w).toContain(w);
    }
    // Today: the run a few minutes ago, then the next one counting down; the paused one counted at the foot.
    const runs = [...screen.querySelectorAll(".tl-row")];
    expect(runs.map((r) => text(r.querySelector(".tl-name")!))).toEqual(["Morning follow-ups", "Morning follow-ups"]);
    expect(runs[0]!.classList.contains("tl-ran")).toBe(true);
    expect(text(runs[1]!.querySelector(".tl-result")!)).toBe("in 5 min");
    expect(text(screen.querySelector(".space-card-foot")!)).toContain("1 more paused");
    // Dashboards: each skill's first tile, the flagged one after it; a click opens its dashboard.
    const dash = [...screen.querySelectorAll<HTMLElement>(".space-dash")];
    expect(dash.map((d) => text(d.querySelector(".space-dash-title")!))).toEqual(["People›", "Payroll›"]);
    expect(text(dash[0]!.querySelector(".space-dash-value")!)).toBe("2");
    expect(text(dash[0]!)).toContain("1 to follow up");
    await click(dash[0]!);
    expect(nav.at(-1)).toBe("project laptop/crm");
    // To do: the rows its trades flag (the late first).
    expect([...screen.querySelectorAll(".dash-row-title")].map((n) => text(n))).toEqual(["Ava Reed", "Bo Fox"]);
    expect(text(screen.querySelector(".dash-row")!)).toContain("Oct 20");
    await click(screen.querySelector<HTMLElement>(".dash-row-main")!);
    expect(nav.at(-1)).toBe("project laptop/crm");
    // Activity: today's history in the Space, with See all on Today.
    expect(text(screen.querySelector(".space-acts")!)).toContain("Morning follow-ups ran");
    expect(text(screen.querySelector(".space-acts")!)).toContain("· People");
    await click(button(screen, "See all on Today ▸"));
    expect(nav.at(-1)).toBe("show ops");
    // All routines: Run now, Resume and Remove behind its confirm, and Ask Cobra to change one.
    await click(button(screen, "All routines ▸"));
    await flush(3);
    const dialog = el.querySelector<HTMLElement>(".routines-dialog")!;
    expect(dialog, "All routines").not.toBeNull();
    for (const w of ["Happy Tails · 3 routines", "Fortnightly payroll", "Every other Friday at 09:00", "Monday timesheet check", "Paused", "Morning follow-ups"]) {
      expect(text(dialog), w).toContain(w);
    }
    expect(text(dialog)).not.toContain("Weekly tidy");
    const card = (name: string) => [...dialog.querySelectorAll<HTMLElement>(".routine-card")].find((c) => text(c).includes(name))!;
    const api = (path: string) => tauri.invoked.filter((x) => x.cmd === "api" && (x.args as Dict).path === path);
    await click(button(card("Fortnightly payroll"), "Run now"));
    await flush(3);
    expect((api("/routines/run").at(-1)!.args as Dict).body).toEqual({ id: "rt-payroll" });
    await click(button(card("Monday timesheet check"), "Resume"));
    await flush(3);
    expect((api("/routines/pause").at(-1)!.args as Dict).body).toEqual({ id: "rt-timesheets", enabled: true });
    const removes = api("/routines/remove").length;
    await click(button(card("Fortnightly payroll"), "Remove"));
    expect(api("/routines/remove").length).toBe(removes);
    await click(button(dialog.querySelector(".dialog")!, "Remove"));
    await flush(3);
    expect((api("/routines/remove").at(-1)!.args as Dict).body).toEqual({ id: "rt-payroll" });
    await click(button(dialog, "Ask Cobra to add or change a routine"));
    expect(currentDraft().text).toBe("[Space: Happy Tails] Change a routine: ");
    expect(nav.at(-1)).toBe("show ops");
    expect(el.querySelector(".routines-dialog")).toBeNull();
    // The crew: Hire, and Manage… for rename, Sensitive and close.
    await click(button(screen, "Hire a Foreman"));
    expect(nav.at(-1)).toBe("new project");
    await click(button(screen, "Manage…"));
    await flush(3);
    expect(text(el.querySelector(".org-panel-title")!)).toBe("Happy Tails");
    await click(el.querySelector<HTMLButtonElement>(".org-close")!);
    await click(button(screen, "‹ Org"));
    await flush(3);
    expect(el.querySelector(".space-screen")).toBeNull();
    expect(el.querySelector("ul.org-tree")).not.toBeNull();
    const pill = el.querySelector<HTMLButtonElement>(".org-pill")!;
    expect(text(pill)).toMatch(/Foremen/);
    expect(pill.disabled, text(pill)).toBe(false);
    {
      await click(pill);
      await flush(3);
      expect(el.querySelector(".org-panel")).not.toBeNull();
      await click(button(el, "Move…"));
      await click([...el.querySelectorAll<HTMLElement>(".org-choice")].find((c) => text(c).includes("Happy Tails"))!);
      await flush(5);
      const sent = tauri.invoked.filter((x) => x.cmd === "api" && (x.args as Dict).path === "/org" && (x.args as Dict).method === "POST");
      expect(((sent.at(-1)!.args as Dict).body as Dict).change).toMatchObject({ op: "assign", company: "happy-tails" });
    }
    // New Space puts the intake's first words in Cobra's box.
    await click(el.querySelector<HTMLButtonElement>(".org-new")!);
    expect(currentDraft().text).toBe(NEW_SPACE_DRAFT);
    await click(button(el, "List"));
    await flush(5);
    expect(text(el)).toContain("LEAD");
    await click(button(el, "Chart"));
    await flush(3);
    expect(el.querySelector("ul.org-tree")).not.toBeNull();
  });

  it("a Foreman that needs you: Allow and Deny on its card, Answer for anything else", async () => {
    const seatOf = (extra: Dict) => ({
      key: "laptop/cobra", name: "Rosa", needing: model.rowForProject({ ...LAPTOP_PROJECTS[0], ...extra }, "laptop"),
    }) as unknown as Seat;
    const el = await mount(withApp(<NeedsCard seat={seatOf({})} role="CRM" context="Rosa · CRM · Morning follow-ups, 9 AM" />));
    expect(text(el)).toContain("Rosa · CRM · Morning follow-ups, 9 AM");
    expect(text(el)).toContain("Run a shell command");
    tauri.invoked.length = 0;
    await click(button(el, "Allow"));
    const sent = tauri.invoked.find((x) => x.cmd === "api" && String((x.args as Dict).path) === "/session")!;
    expect((sent.args as Dict).body).toMatchObject({ session: "cobra", action: "approve", dialogKey: expect.any(String) });
    await click(button(el, "Deny"));
    expect(tauri.invoked.some((x) => x.cmd === "api" && (x.args as Dict).body?.action === "deny")).toBe(true);
    const question = await mount(withApp(<NeedsCard seat={seatOf({ dialog: "question" })} role="CRM" />));
    expect(text(question)).not.toContain("Allow");
    await click(button(question, "Answer"));
    expect(nav.at(-1)).toBe("chat laptop/cobra");
  });

  it("Settings → This app: the passcode is made, changed, locked and removed", async () => {
    passcode.saved = null;
    passcode.unlocked = false;
    const el = await mount(withApp(<SettingsPage />));
    await flush(5);
    await click([...el.querySelectorAll(".settings-nav li")].find((li) => text(li).includes("This app"))!);
    await flush(3);
    const dialog = () => document.querySelector<HTMLElement>(".dialog")!;
    const typeIn = async (i: number, value: string) => change(dialog().querySelectorAll<HTMLInputElement>("input")[i]!, value);
    // Appearance: Light and Dark go on <html> and are kept; System takes the choice off again.
    const radio = (name: string) => [...el.querySelectorAll<HTMLElement>("[role=radio]")].find((r) => text(r) === name)!;
    await click(radio("Light"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("cobra.theme")).toBe("light");
    await click(radio("Dark"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    await click(radio("System"));
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("cobra.theme")).toBeNull();
    expect(text(el)).toContain("None yet");
    await click(button(el, "Make a passcode…"));
    await typeIn(0, "first passcode");
    await typeIn(1, "first passcode");
    await click(button(dialog(), "Make passcode"));
    await flush(4);
    expect(toasts).toContain("Passcode made");
    expect(text(el)).toContain("Unlocked for 5 more minutes");
    await click(button(el, "Lock now"));
    await flush(3);
    expect(text(el)).toContain("Locked.");
    await click(button(el, "Change…"));
    await typeIn(0, "first passcode");
    await typeIn(1, "second passcode");
    await typeIn(2, "second passcode");
    await click(button(dialog(), "Change"));
    await flush(4);
    expect(passcode.saved).toBe("second passcode");
    await click(button(el, "Remove…"));
    await typeIn(0, "wrong wrong");
    await click(button(dialog(), "Remove"));
    await flush(3);
    expect(text(dialog().querySelector(".dash-error")!)).toBe("That is not the passcode.");
    await typeIn(0, "second passcode");
    await click(button(dialog(), "Remove"));
    await flush(4);
    expect(passcode.saved).toBeNull();
    expect(text(el)).toContain("None yet");
  });

  it("Settings, every section", async () => {
    const el = await mount(withApp(<SettingsPage />));
    await flush(10);
    for (const li of [...el.querySelectorAll(".settings-nav li")]) {
      await click(li);
      await flush(5);
      const shown = [...el.querySelectorAll(".settings-scroll")].find((s) => !(s as HTMLElement).hidden)!;
      expect(text(shown).length, text(li)).toBeGreaterThan(40);
      }
    const t = text(el);
    for (const s of ["This computer", "The agent", "Start Cobra when you sign in", "Engines", "Claude accounts", "Work", "Codex accounts",
      "Brain", "Permissions", "Local models", "qwen-tuned:fast96k", "Integrations", "GitHub", "Google", "Audit log", "Cobra merged me/r#7"]) {
      expect(t, s).toContain(s);
    }
    // Integrations → Google: the connectors of Laptop's Claude account, with the way to claude.ai's settings.
    const ints = [...el.querySelectorAll(".settings-nav li")].find((li) => text(li).includes("Integrations"))!;
    await click(ints);
    const shownNow = () => [...el.querySelectorAll<HTMLElement>(".settings-scroll")].find((x) => !x.hidden)!;
    for (const g of ["Google", "Gmail and Google Calendar connected", "Google Drive is not connected.", "What it allows",
      "Sends, replies, trashes or changes an event only when you allow it.", "Claude connectors", "Refresh", "GitHub"]) {
      expect(text(shownNow()), g).toContain(g);
    }
    // Cobra has no Google sign-in of its own: nothing here connects one or turns a read on.
    for (const gone of ["Connect Google", "Turn on", "Manage", "What Cobra can read"]) expect(text(shownNow()), gone).not.toContain(gone);
    await click(button(shownNow(), "Claude connectors"));
    // Cloudflare on Laptop: connected to Pine Yoga, Paws Studio a Use away; Disconnect asks first.
    for (const g of ["Cloudflare", "connected to Pine Yoga", "Accounts this sign-in reaches", "Paws Studio", "in use"]) {
      expect(text(shownNow()), g).toContain(g);
    }
    await click(button(shownNow(), "Use"));
    await flush(3);
    expect(toasts).toContain("Websites from Laptop go in Paws Studio");
    expect(tauri.invoked.some((x) => x.cmd === "api" && (x.args as Dict).path === "/integrations/cloudflare/account" && (x.args as Dict).body?.id === "cf2")).toBe(true);
    await click(button(shownNow(), "Disconnect"));
    expect(text(el)).toContain("Disconnect Cloudflare from Laptop?");
    await click(buttons(el, "Cancel").at(-1)!);
    expect(text(el)).not.toContain("Disconnect Cloudflare from Laptop?");
    // Projects: the folders looked in, Add a folder, Remove an added one.
    const projects = [...el.querySelectorAll(".settings-nav li")].find((li) => text(li).includes("Projects"))!;
    await click(projects);
    for (const f of ["Folders", "~/Projects", "built in", "~/code/work", "added", "Add a folder"]) expect(text(shownNow()), f).toContain(f);
    const box = shownNow().querySelector<HTMLInputElement>("input.entry")!;
    await change(box, "code");
    await click(button(shownNow(), "Add"));
    expect(text(shownNow())).toContain("Give the whole path");
    await change(box, "~/code");
    await click(button(shownNow(), "Add"));
    await flush(3);
    expect(toasts).toContain("Laptop: Looking in ~/code too");
    expect(tauri.invoked.some((x) => x.cmd === "api" && (x.args as Dict).path === "/settings/folders" && (x.args as Dict).body?.add === "~/code")).toBe(true);
    await click(button(shownNow(), "Remove"));
    await flush(3);
    expect(toasts).toContain("Laptop: No longer looking in ~/code/work");
    // Add a Claude account; unlink the agent (cancel first).
    const engines = [...el.querySelectorAll(".settings-nav li")].find((li) => text(li).includes("Engines & accounts"))!;
    await click(engines);
    await click(button(el, "Add a Claude account…"));
    expect(text(el)).toContain("Keep");
    await click(button(el, "Cancel"));
    await click(button(el, "Add a Codex account…"));
    const computers = [...el.querySelectorAll(".settings-nav li")].find((li) => text(li).includes("This computer"))!;
    await click(computers);
    await click(button(el, "Unlink"));
    expect(text(document.body)).toContain("Unlink the agent?");
    await click(button(document.body, "Cancel"));
    await click(button(el, "Unlink"));
    await click(button(document.querySelector(".dialog")!, "Unlink"));
    expect(toasts).toContain("Unlinked the agent.");
  });

  it("Settings → Integrations: Google's connectors and Connect Cloudflare on an agent with neither", async () => {
    const saved = tauri.route!;
    // The agent answers as one with no Google and no Cloudflare yet (the fixtures' Office).
    tauri.route = (cmd, args) => (cmd === "api" && String(args.path).startsWith("/integrations/") && !String(args.path).includes("/finish")
      ? saved(cmd, { ...args, machine: "office" }) : saved(cmd, args));
    try {
      const el = await mount(withApp(<SettingsPage />));
      await flush(10);
      await click([...el.querySelectorAll(".settings-nav li")].find((li) => text(li).includes("Integrations"))!);
      await flush(5);
      const shownNow = () => [...el.querySelectorAll<HTMLElement>(".settings-scroll")].find((x) => !x.hidden)!;
      expect(text(shownNow())).toContain("not connected");
      expect(text(shownNow())).toContain("Your Claude account has none of Gmail, Google Calendar and Google Drive.");
      // Cloudflare on Office: the note first, then the sign-in page, then the code box; a bad code never leaves the desk.
      await click(button(shownNow(), "Connect Cloudflare"));
      expect(text(shownNow())).toContain("only ever changes the ones it made for your Spaces");
      await click(button(shownNow(), "Open Cloudflare"));
      await flush(3);
      expect(toasts).toContain("Sign in on the page that opened, then paste the connection code here");
      expect(text(shownNow())).toContain("Paste the connection code from the page Cloudflare sent you to");
      const codeBox = shownNow().querySelector<HTMLInputElement>("input[placeholder='Connection code']")!;
      await change(codeBox, "not a code");
      await click(button(shownNow(), "Finish"));
      expect(toasts.some((x) => x.startsWith("That is not a connection code"))).toBe(true);
      expect(tauri.invoked.some((x) => x.cmd === "api" && (x.args as Dict).path === "/integrations/cloudflare/finish")).toBe(false);
      await change(codeBox, "s1.the-code");
      await click(button(shownNow(), "Finish"));
      await flush(3);
      expect(toasts).toContain("Laptop is connected to Cloudflare");
      expect(tauri.invoked.some((x) => x.cmd === "api" && (x.args as Dict).path === "/integrations/cloudflare/finish" && (x.args as Dict).body?.connectCode === "s1.the-code")).toBe(true);
      expect(text(shownNow())).toContain("connected to Pine Yoga");
    } finally {
      tauri.route = saved;
    }
  });

  it("Setup", async () => {
    const el = await mount(withApp(<SetupPage />));
    await flush(3);
    expect(text(el)).toContain("Welcome to Cobra");
    expect(text(el)).toContain("Link the agent");
    await click(button(el, "Link the agent"));
    await flush(3);
    expect(toasts).toContain("Linked laptop.");
  });
});

describe("smoke: surfaces", () => {
  beforeEach(async () => {
    if (!fleet?.loaded) fleet = await loadFleet();
  });

  it("Picker, fed a snapshot", async () => {
    const el = await mount(<PickerSurface />);
    await emit("fleet-snapshot", fleet.snapshot());
    const t = text(el);
    for (const s of ["AGENTS", "NEEDS YOU", "RUNNING", "NOT STARTED", "Cobra", "lookfocus", "scratch"]) expect(t, s).toContain(s);
    const input = el.querySelector<HTMLInputElement>(".picker-entry")!;
    await key(input, "ArrowDown");
    await key(input, "Tab");
    await change(input, "office");
    expect(text(el)).toContain("infra");
    await key(input, "Enter");
    await emit("picker-opened", null);
    await key(input, "Enter", { ctrlKey: true });
  });

  it("Cobra box, fed a snapshot", async () => {
    tauri.emitted.length = 0;
    tauri.invoked.length = 0;
    const el = await mount(<CobraBoxSurface />);
    expect(tauri.emitted.some((e) => e.target === "main" && (e.payload as Dict).kind === "refresh")).toBe(true);
    await emit("fleet-snapshot", fleet.snapshot());
    await flush(5);
    // Her conversation, her question, and what else waits on you.
    for (const s of ["Cobra", "Which project first?", "need you."]) expect(text(el), s).toContain(s);
    // Answer her, then message her.
    await click(button(el.querySelector(".cobra")!, /corner-bakery/));
    expect(tauri.invoked.some((x) => x.cmd === "api" && (x.args as Dict).body?.action === "answer")).toBe(true);
    const input = el.querySelector<HTMLInputElement>(".cobra-compose input")!;
    await change(input, "What is left today?");
    await click(button(el, "↑"));
    const said = tauri.invoked.find((x) => x.cmd === "api" && (x.args as Dict).body?.action === "say")!;
    expect((said.args as Dict).body?.text).toBe("What is left today?");
    // Show opens Home in the main window; the shortcut shows it again and Esc hides it.
    await click(button(el.querySelector(".cobra-box-needs")!, "Show"));
    expect(tauri.emitted.some((e) => e.target === "main" && (e.payload as Dict).kind === "show" && (e.payload as Dict).page === "ops")).toBe(true);
    await emit("cobra-opened", null);
    await key(input, "Escape");
  });

  it("Popup, fed popup-add", async () => {
    const el = await mount(<PopupSurface />);
    await emit("fleet-snapshot", fleet.snapshot());
    const project = LAPTOP_PROJECTS[0];
    const cards: PopupCard[] = [
      { key: "laptop:cobra", kind: "needs", machine: "laptop", project, at: NOW - 900 },
      { key: "approval:laptop:ap-merge", kind: "approval", machine: "laptop", approval: APPROVALS.approvals[0], at: NOW - 30 },
      { key: "laptop:cobra-docs", kind: "needs", machine: "laptop", project: { ...LAPTOP_PROJECTS[5], needsInput: true, dialog: "question" }, at: NOW - 10 },
      { key: "laptop:banana", kind: "needs", machine: "laptop", project: { ...LAPTOP_PROJECTS[2], needsInput: true, dialog: "trust" }, at: NOW },
    ];
    for (const c of cards) await emit("popup-add", c);
    // One card in Cobra's voice lists all four, the newest in full.
    let t = text(el);
    for (const s of ["Cobra", "These 4 need you.", "oldest 15m", "TRUST", "PERMISSION", "APPROVE",
      "Merge 2 pull requests in lookfocus"]) expect(t, s).toContain(s);
    expect(el.querySelectorAll(".popup-cobra").length).toBe(1);
    expect(t).not.toContain("more");
    // A Foreman's email joins the same card: its fields and files, Allow and Deny unchanged.
    await emit("popup-add", { key: "approval:laptop:ap-email", kind: "approval", machine: "laptop", approval: ACTIONS[0], at: NOW });
    t = text(el);
    for (const s of ["These 5 need you.", "EMAIL", "Send: Pay stubs for the week", "ann@example.com", "Pay stubs, week 42", "stubs-week-42.pdf"]) {
      expect(t, s).toContain(s);
    }
    expect(el.querySelectorAll(".popup-cobra").length).toBe(1);
    await click(buttons(el, "Details ▸")[0]);
    // ✕ on an item takes it off the card; it still waits.
    await click(buttons(el.querySelector(".popup-scroll")!, "✕")[0]);
    expect(text(el)).toContain("These 4 need you.");
    await emit("popup-remove", "laptop:banana");
    await click(button(el, "Allow"));
    // ✕ on the card hides what it lists; the next new item brings the card back with only itself.
    await click(button(el.querySelector(".popup-cobra-head")!, "✕"));
    expect(el.querySelector(".popup-cobra")).toBeNull();
    await emit("popup-add", { key: "laptop:late", kind: "needs", machine: "laptop", project: { ...LAPTOP_PROJECTS[0], id: "late" }, at: NOW });
    expect(text(el)).toContain("This needs you.");
    // The cards Main itself sent, as they were sent.
    for (const e of tauri.emitted.filter((x) => x.event === "popup-add")) await emit("popup-add", e.payload);
  });

  it("Main", async () => {
    tauri.emitted.length = 0;
    const el = await mount(<MainSurface />);
    await until(() => text(el).includes("Done today"), "Home");
    await flush(10);
    expect(text(el)).toContain("Cobra");
    expect(el.querySelector(".header .title")!.textContent).toBe("Home");
    // Every page from the sidebar, then Settings from the gear.
    for (const name of ["Org", "Projects", "All money", "Home"]) {
      await click(button(el, new RegExp(`^.${name}`)));
      await flush(5);
    }
    await click(el.querySelector<HTMLElement>("button[title=Settings]")!);
    await flush(5);
    expect(el.querySelector(".header .title")!.textContent).toBe("Settings");
    // A tick, a navigate, and the popup cards Main sent from the poll's events.
    await emit("tick", null);
    await emit("navigate", "money");
    expect(el.querySelector(".header .title")!.textContent).toBe("All money");
    // The Fleet page is gone: its old key opens Home.
    await emit("navigate", "fleet");
    expect(el.querySelector(".header .title")!.textContent).toBe("Home");
    await emit("navigate", "home");
    expect(el.querySelector(".header .title")!.textContent).toBe("Home");
    await emit("to-main", { kind: "open-chat", machine: "laptop", session: "cobra" });
    await flush(5);
    // My Organization, on its list, with the conversation open.
    expect(el.querySelector(".header .title")!.textContent).toBe("My Organization");
    expect(text(el)).toContain("LEAD");
    expect(tauri.emitted.some((x) => x.event === "fleet-snapshot")).toBe(true);
    expect(tauri.emitted.some((x) => x.event === "popup-add")).toBe(true);
  });
});

// -- every control, pressed ---------------------------------------------------------------------------

/** Presses every button, flips every switch, picks every option and types in every field, closing
 * whatever opens; a crash or a React warning anywhere fails the test. */
async function fuzz(el: HTMLElement, skip: RegExp = /^$/): Promise<number> {
  let pressed = 0;
  const seen = new Set<Element>();
  for (let pass = 0; pass < 2; pass++) {
    const controls = [...el.querySelectorAll<HTMLElement>("button, select, input, [role=radio], li, .clickable, .brow, details > summary")];
    for (const c of controls) {
      if (seen.has(c) || !c.isConnected || (c as HTMLButtonElement).disabled) continue;
      seen.add(c);
      const label = (c.textContent ?? "").trim() || c.getAttribute("title") || "";
      if (skip.test(label) || label === "×" || (c instanceof HTMLInputElement && c.type === "search")) continue;
      if (c instanceof HTMLSelectElement) {
        for (const o of [...c.options]) if (c.isConnected) await change(c, o.value);
      } else if (c instanceof HTMLInputElement) {
        if (c.type === "checkbox") await click(c);
        else {
          await change(c, c.type === "number" ? "2" : "pypi.org");
          await key(c, "Enter");
        }
      } else {
        await click(c);
      }
      pressed++;
      // A menu or a dialog that opened: press what is in it once, then close it.
      const menu = document.body.querySelector(".menu");
      if (menu) await escape();
      if (document.body.querySelectorAll(".scrim").length > 2) await escape();
    }
  }
  await flush(5);
  return pressed;
}

describe("smoke: every control", () => {
  beforeEach(async () => {
    if (!fleet?.loaded) fleet = await loadFleet();
    config.setMachines(MACHINES);
  });

  it("Home", async () => {
    const el = await mount(withApp(<HomePage />));
    expect(await fuzz(el)).toBeGreaterThan(10);
  });

  it("Agents", async () => {
    const el = await mount(withApp(<AgentsPage open={{ machine: "laptop", session: "cobra_docs", n: 99 }} />));
    await flush(10);
    expect(await fuzz(el)).toBeGreaterThan(10);
  });

  it("Projects", async () => {
    const el = await mount(withApp(<ProjectsPage newProjectAsk={0} />));
    expect(await fuzz(el, /^(New project…|Tidy)$/)).toBeGreaterThan(10);
  });

  it("Project page", async () => {
    for (const p of ["lookfocus", "cobra", "corner-bakery", "notes", "scripts", "cobra-docs", "lookfocus-fm", "w-456"]) {
      const el = await mount(withApp(<ProjectPage machine="laptop" project={p} onClose={() => {}} />));
      await flush(5);
      expect(await fuzz(el), p).toBeGreaterThan(2);
    }
  });

  it("All money: tiles in the household's currency, a row per business, one to set up, and the household", async () => {
    const el = await mount(withApp(<AllMoneyPage />));
    await until(() => text(el).includes("Kept across"), "All money");
    for (const word of ["Kept across 1 business", "Owed to you", "Your net worth", "Happy Tails", "Ask Cobra to set up", "Kept by business", "Personal", "Open Finance"]) expect(text(el)).toContain(word);
    // Laptop answered in US$ and was asked again in EC$.
    const asked = tauri.invoked.filter((x) => x.cmd === "api" && String((x.args as Dict).path).startsWith("/money/all")).map((x) => `${(x.args as Dict).machine} ${(x.args as Dict).path}`);
    expect(asked.some((a) => a.startsWith("laptop") && a.includes("to=XCD"))).toBe(true);
    expect(await fuzz(el, /^Ask Cobra to set up$/)).toBeGreaterThan(0);
  });

  it("Settings", async () => {
    const el = await mount(withApp(<SettingsPage />));
    await flush(10);
    for (const li of [...el.querySelectorAll(".settings-nav li")]) {
      await click(li);
      await flush(5);
      const shown = [...el.querySelectorAll<HTMLElement>(".settings-scroll")].find((s) => !s.hidden)!;
      await fuzz(shown, /^(Remove|Unlink|Link the agent|Add)$/);
    }
  });

  it("Tidy, inside", async () => {
    const el = await mount(withApp(<ProjectsPage newProjectAsk={0} />));
    await click(button(el, "Tidy"));
    await flush(5);
    await fuzz(document.body.querySelector<HTMLElement>(".dialog")!);
  });

  it("Popup", async () => {
    const el = await mount(<PopupSurface />);
    const cards: PopupCard[] = [
      { key: "a", kind: "needs", machine: "laptop", project: LAPTOP_PROJECTS[0], at: NOW - 900 },
      { key: "b", kind: "approval", machine: "laptop", approval: APPROVALS.approvals[0], at: NOW - 30 },
      { key: "d", kind: "needs", machine: "office", project: { ...OFFICE_PROJECTS[1], needsInput: true, dialog: "model" }, at: NOW - 10 },
      { key: "e", kind: "needs", machine: "gone", project: {}, at: NOW },
      { key: "f", kind: "approval", machine: "laptop", approval: {}, at: NOW },
    ];
    for (const c of cards) await emit("popup-add", c);
    await fuzz(el);
  });
});

describe("smoke: other shapes", () => {
  it("Main with no computer shows the welcome", async () => {
    const saved = tauri.route!;
    tauri.route = (cmd, args) => (cmd === "computers" ? [] : saved(cmd, args));
    try {
      const el = await mount(<MainSurface />);
      await until(() => text(el).includes("Welcome to Cobra"), "the welcome");
      expect(el.querySelector(".header .title")!.textContent).toBe("Welcome");
      await click(el.querySelector<HTMLElement>("button[title=Settings]")!);
      expect(el.querySelector(".header .title")!.textContent).toBe("Settings");
      await fuzz(el, /^(Link the agent|Add)$/);
    } finally {
      tauri.route = saved;
    }
  });

  it("a narrow window: Main, Home, Agents, Settings", async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 600 });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 600 });
    try {
      fleet = await loadFleet();
      const main = await mount(<MainSurface />);
      await until(() => text(main).includes("Done today"), "Home");
      const pick = main.querySelector<HTMLSelectElement>(".header select")!;
      for (const v of ["agents", "projects", "money", "settings", "ops"]) await change(pick, v);
      const agents = await mount(withApp(<AgentsPage open={{ machine: "laptop", session: "cobra", n: 1000 }} />));
      await flush(5);
      expect(text(agents)).toContain("Fix the login bug");
      await click(agents.querySelector<HTMLElement>("button[title=Sessions]")!);
      expect(text(agents)).toContain("WORKERS");
      const settings = await mount(withApp(<SettingsPage />));
      await flush(5);
      const sel = settings.querySelector<HTMLSelectElement>(".settings-compact")!;
      for (const o of [...sel.options]) await change(sel, o.value);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 1024 });
    }
  });

  it("Setup when the agent is not ready: the advice, and Check again", async () => {
    const saved = tauri.route!;
    let host: Dict = { os: "linux", hostname: "box", agentInstalled: false, agentPath: "~/.local/bin/cobra-agent", agentPort: 8787,
      tmuxSocket: "cobra", agentService: false, agentAnswering: false };
    tauri.route = (cmd, args) => (cmd === "host_state" ? host : saved(cmd, args));
    try {
      const setup = await mount(withApp(<SetupPage />));
      await flush(3);
      expect(text(setup)).toContain("bash install.sh");
      expect(text(setup)).not.toContain("Link the agent");
      host = { ...host, agentInstalled: true };
      await click(button(setup, "Check again"));
      await flush(3);
      expect(text(setup)).toContain("systemctl --user start cobra-agent");
      host = { ...host, os: "macos", agentService: null, agentAnswering: true };
      await click(button(setup, "Check again"));
      await flush(3);
      expect(text(setup)).toContain("Link the agent");
      expect(text(setup)).not.toContain("service is running");
    } finally {
      tauri.route = saved;
    }
  });

  it("an agent away, and an old agent", async () => {
    const saved = tauri.route!;
    tauri.route = (cmd, args) => {
      if (cmd === "api" && args.machine === "office") throw { status: 0, message: "connection refused" };
      if (cmd === "api" && /^\/(orch|prs|approvals|notices|usage|history|posture|policy|brain|accounts|settings|local|mcp|api-lane)/.test(String(args.path))) {
        throw { status: 404, message: "not found" };
      }
      return saved(cmd, args);
    };
    try {
      fleet = await loadFleet();
      expect(fleet.unreachable).toEqual(["Office"]);
      for (const page of [<HomePage />, <ProjectsPage newProjectAsk={0} />, <SettingsPage />,
        <AgentsPage open={null} />]) {
        const el = await mount(withApp(page));
        await flush(5);
        expect(text(el).length).toBeGreaterThan(20);
      }
    } finally {
      tauri.route = saved;
      fleet = await loadFleet();
    }
  });

  it("agents that answer with junk", async () => {
    const saved = tauri.route!;
    tauri.route = (cmd, args) => {
      if (cmd !== "api") return saved(cmd, args);
      const path = String(args.path).split("?")[0];
      if (path === "/projects") return { machine: args.machine, projects: [{ id: "x" }, { id: "y", activity: "busy", git: {} }] };
      if (path === "/tmux") return { serverRunning: false, sessions: [] };
      return {};
    };
    try {
      fleet = await loadFleet();
      for (const page of [<HomePage />, <ProjectsPage newProjectAsk={0} />, <SettingsPage />,
        <AgentsPage open={{ machine: "laptop", session: "x", n: 2000 }} />, <ProjectPage machine="laptop" project="y" onClose={() => {}} />]) {
        const el = await mount(withApp(page));
        await flush(5);
        expect(text(el).length).toBeGreaterThan(5);
      }
    } finally {
      tauri.route = saved;
      fleet = await loadFleet();
    }
  });
});

describe("smoke: every dialog the chat's dock can show", () => {
  beforeEach(async () => {
    if (!fleet?.loaded) fleet = await loadFleet();
    config.setMachines(MACHINES);
  });

  it("trust, model, a question, a submit, working, not running, unreachable", async () => {
    const cases: Array<[string, string, string]> = [
      ["laptop", "lookfocus", "trust this folder"], ["laptop", "corner-bakery", "can't drive"],
      ["laptop", "cobra_lead", "Which project first?"], ["laptop", "lookfocus_fm", "Submit answers"],
      ["laptop", "lookfocus_w123", "working"], ["office", "infra", "not running"], ["laptop", "scratch", ""],
    ];
    let n = 5000;
    for (const [machine, session, said] of cases) {
      const el = await mount(withApp(<AgentsPage open={{ machine, session, n: n++ }} />));
      await flush(10);
      expect(text(el), session).toContain(said);
      const dock = el.querySelector<HTMLElement>(".dock");
      if (dock) await fuzz(dock);
    }
  });
});

describe("smoke: a menu's listeners", () => {
  it("a menu drawn again before its first tick leaves no click listener behind", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    const items = [{ label: "One" }];
    const closed = vi.fn();
    // Drawn twice before its timer runs, each time with a new onClose (as useMenu passes one), then gone.
    act(() => root.render(<Menu x={1} y={1} items={items} onClose={() => closed()} />));
    act(() => root.render(<Menu x={1} y={1} items={items} onClose={() => closed()} />));
    act(() => root.unmount());
    el.remove();
    await new Promise((r) => setTimeout(r, 10));
    window.dispatchEvent(new MouseEvent("click"));
    expect(closed, "a closed menu still hears clicks on the window").not.toHaveBeenCalled();
  });
});

describe("smoke: the crew hidden", () => {
  // Every crew name in the fixtures: none may show with the switch off.
  const CREW = ["Rosa", "Mabel"];
  beforeEach(async () => {
    if (!fleet?.loaded) fleet = await loadFleet();
    config.setMachines(MACHINES);
    saveShowCrew(false);
  });

  it("Settings → This app: Show the crew can be turned off, and that is kept", async () => {
    const el = await mount(withApp(<SettingsPage />));
    await flush(5);
    await click([...el.querySelectorAll(".settings-nav li")].find((li) => text(li).includes("This app"))!);
    await flush(3);
    expect(text(el)).toContain("Show the crew");
    expect(text(el)).toContain("Turn it off to talk only to Cobra.");
    const row = [...el.querySelectorAll(".settings-scroll:not([hidden]) input.switch")].at(-1) as HTMLInputElement;
    // This block turned it off before each test; on is what nothing kept means.
    expect(row.checked).toBe(false);
    expect(localStorage.getItem("cobra.showCrew")).toBe("off");
    await click(row);
    expect(localStorage.getItem("cobra.showCrew")).toBeNull();
    await click(row);
    expect(localStorage.getItem("cobra.showCrew")).toBe("off");
  });

  it("My Organization: you, Cobra and Spaces; skills only; no crew, Hire, New arrivals or Outskirts", async () => {
    const el = await mount(withApp(<OrgPage open={null} />));
    await flush(10);
    const t = text(el);
    for (const name of [...CREW, "New arrivals", "OUTSKIRTS", "Foremen", "Foreman"]) expect(t, name).not.toContain(name);
    expect(text(el.querySelector(".org-pill")!)).toBe("1 Space");
    expect(el.querySelectorAll(".org-space svg").length).toBe(0);
    // One click on the Space opens its screen: skills only, no Hire, cap or crew.
    const paws = [...el.querySelectorAll<HTMLButtonElement>(".org-space")].find((card) => text(card).includes("Happy Tails"))!;
    expect(text(paws)).toContain("People and Payroll");
    expect(text(paws)).toContain("Next");
    await click(paws);
    await flush(8);
    const screen = el.querySelector<HTMLElement>(".space-screen")!;
    for (const w of ["Dashboards", "People", "Payroll", "Manage…", "Today", "Activity", "Ask Cobra about Happy Tails"]) expect(text(screen), w).toContain(w);
    for (const w of ["Hire a Foreman", "Cobra hires without asking", "Crew", "Foreman", ...CREW]) expect(text(screen), w).not.toContain(w);
    expect(screen.querySelectorAll("svg.sprite, .space-foreman-head svg").length).toBe(0);
    await click(screen.querySelectorAll<HTMLElement>(".space-dash")[0]!);
    expect(nav.at(-1)).toBe("project laptop/crm");
    // All routines names no Foreman, and Ask Cobra sets the box's Space chip.
    await click(button(screen, "All routines ▸"));
    await flush(3);
    const dialog = el.querySelector<HTMLElement>(".routines-dialog")!;
    expect(text(dialog)).toContain("Morning follow-ups");
    expect(text(dialog)).not.toContain("Foreman");
    await click(button(dialog, "Ask Cobra to add or change a routine"));
    expect(currentDraft()).toMatchObject({ text: "Change a routine: ", space: "happy-tails" });
    takeDraft(); // as Cobra's box would, so the next page starts with no Space picked
    // The list is Cobra alone.
    await click(button(el, "‹ Org"));
    await click(button(el, "List"));
    await flush(5);
    expect(text(el)).toContain("LEAD");
    for (const w of ["FOREMEN", "WORKERS", "SESSIONS", "QUEUED", ...CREW]) expect(text(el), w).not.toContain(w);
    await click(button(el, "Chart"));
  });

  it("a Space with nothing in it asks you to ask Cobra", async () => {
    let asked = 0;
    const space = { id: "fern", name: "Fern & Field", color: "#4a7", kindWords: "My own business", sensitive: false, seats: [], needs: 0, working: 0 };
    const el = await mount(withApp(<SpaceScreen space={space} showCrew={false} onBack={() => {}} onManage={() => {}} onHire={() => {}}
      onPeek={() => {}} onAsk={() => (asked += 1)} />));
    expect(text(el)).toContain("Nothing here yet. Ask Cobra for something in Fern & Field.");
    expect(text(el)).not.toContain("Hire");
    await click(button(el, "Ask Cobra"));
    expect(asked).toBe(1);
    // With the crew shown, today's words.
    const shown = await mount(withApp(<SpaceScreen space={space} onBack={() => {}} onManage={() => {}} onHire={() => {}} onPeek={() => {}} />));
    expect(text(shown)).toContain("Nobody works in Fern & Field yet. Hire a Foreman, or ask Cobra to.");
  });

  it("Home: one activity line, the Space chip and its prefix, and no crew in what needs you", async () => {
    const el = await mount(withApp(<HomePage />));
    await flush(8);
    // Her pane names no crew; Today lists only a Space's projects (an approval's own title is the agent's words).
    for (const name of CREW) expect(text(el.querySelector(".home-chat")!), name).not.toContain(name);
    const today = [...el.querySelectorAll(".home-card")].find((c) => text(c.querySelector(".home-card-title")!) === "Today")!;
    for (const code of ["lookfocus", "corner-bakery", "cobra"]) expect(text(today), code).not.toContain(code);
    expect(text(el.querySelector(".cobra-activity")!)).toMatch(/^Working /);
    const chip = el.querySelector<HTMLButtonElement>(".space-chip")!;
    expect(text(chip)).toBe("Space: All ▾");
    await click(chip);
    await click(button(el.querySelector(".space-chip-menu")!, "Happy Tails"));
    expect(text(el.querySelector(".space-chip")!)).toBe("Space: Happy Tails ▾");
    tauri.invoked.length = 0;
    await change(el.querySelector<HTMLInputElement>(".cobra-compose input")!, "Plan the week");
    await click(button(el, "↑"));
    const said = tauri.invoked.find((x) => x.cmd === "api" && (x.args as Dict).body?.action === "say")!;
    expect((said.args as Dict).body?.text).toBe("[Space: Happy Tails] Plan the week");
    // Back to All: as typed.
    await click(el.querySelector<HTMLButtonElement>(".space-chip")!);
    await click(button(el.querySelector(".space-chip-menu")!, "All"));
    tauri.invoked.length = 0;
    await change(el.querySelector<HTMLInputElement>(".cobra-compose input")!, "Thanks");
    await click(button(el, "↑"));
    expect((tauri.invoked.find((x) => (x.args as Dict).body?.action === "say")!.args as Dict).body?.text).toBe("Thanks");
  });

  it("the popup names Cobra or the Space, never a Foreman", async () => {
    const el = await mount(<PopupSurface />);
    await emit("fleet-snapshot", fleet.snapshot());
    const crmFm = LAPTOP_PROJECTS.find((p) => p.id === "crm-fm")!;
    await emit("popup-add", { key: "laptop:crm-fm", kind: "needs", machine: "laptop", who: "Happy Tails · People",
      project: { ...crmFm, needsInput: true, dialog: "question" }, at: NOW } satisfies PopupCard);
    expect(text(el)).toContain("Happy Tails · People");
    for (const name of CREW) expect(text(el), name).not.toContain(name);
  });
});

describe("smoke: what the app said", () => {
  it("no toast carries a JavaScript error, and every path the app asked for exists", () => {
    expect([...tauri.unknown], "API paths the fixtures do not answer").toEqual([]);
    expect([...junk]).toEqual([]);
    const bad = toasts.filter((t) => /TypeError|ReferenceError|undefined|null|NaN|\[object Object\]/.test(t));
    expect(bad).toEqual([]);
  });
});
