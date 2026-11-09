/**
 * Settings — the window's page behind the header's gear (not a sidebar row).
 *
 * A list of sections beside one section at a time (narrow: a select above it), each with its title and
 * a line on what it is for, its groups as titled cards (components/settings/common.tsx Group), at a
 * readable width. Every section is the one agent's on this computer.
 *
 * THIS COMPUTER and THIS APP are this desktop's own: the agent it talks to and linking it, and how
 * the app starts. The rest are the desk's sections, one file each under components/settings/. Every
 * section is read again each time the page is shown, as the desk's `map` did: a binary installed
 * since, a switch flipped by the agent.
 */
import { APP_NAME } from "../lib/appName.ts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "../app/context.ts";
import * as brain from "../lib/brain.ts";
import * as config from "../lib/config.ts";
import * as localmodels from "../lib/localModels.ts";
import * as permissions from "../lib/permissions.ts";
import { cls } from "../components/ui.tsx";
import { useController } from "../components/settings/common.tsx";
import { ComputersSection } from "../components/settings/Computers.tsx";
import { ThisAppSection } from "../components/settings/ThisApp.tsx";
import { AccountsController, AccountsSection } from "../components/settings/Accounts.tsx";
import { BrainController, BrainSection } from "../components/settings/Brain.tsx";
import { PermissionsController, PermissionsSection } from "../components/settings/Permissions.tsx";
import { LocalModelsController, LocalModelsSection } from "../components/settings/LocalModels.tsx";
import { IntegrationsController, IntegrationsSection } from "../components/settings/Integrations.tsx";
import { GoogleController, GoogleSection } from "../components/settings/Google.tsx";
import { CloudflareController, CloudflareSection } from "../components/settings/Cloudflare.tsx";
import { MailboxesSection } from "../components/settings/Mailboxes.tsx";
import { FoldersController, FoldersSection } from "../components/settings/Folders.tsx";
import { AuditLogController, AuditLogSection } from "../components/settings/AuditLog.tsx";
import * as auditLog from "../lib/auditLog.ts";
import * as folders from "../lib/folders.ts";
import "../styles/settings.css";

const ENGINES_BLURB = "Which engine the Lead, the Foremen, your sessions and Workers start on, and the Claude and Codex " +
  "accounts the agent uses.";
const COMPUTERS_BLURB = `The ${APP_NAME} agent on this computer, which this desktop talks to on loopback, and linking it.`;
const APP_BLURB = `How ${APP_NAME} starts and opens on this computer.`;
const INTEGRATIONS_BLURB = `What ${APP_NAME} reaches for you: your Google account, for records, files and ` +
  "email you allow; your Cloudflare account, for your Spaces' websites; and GitHub, for the Lead and Foremen to read.";

type Key = "computers" | "app" | "engines" | "projects" | "brain" | "permissions" | "local" | "integrations" | "audit";
// key, title, glyph, what it is for
const SECTIONS: readonly (readonly [Key, string, string, string])[] = [
  ["computers", "This computer", "▤", COMPUTERS_BLURB],
  ["app", "This app", "◇", APP_BLURB],
  ["engines", "Engines & accounts", "◆", ENGINES_BLURB],
  ["projects", "Projects", "▦", folders.BLURB],
  ["brain", "Brain", "✦", brain.BLURB],
  ["permissions", "Permissions", "◈", permissions.BLURB],
  ["local", "Local models", "▣", localmodels.BLURB],
  ["integrations", "Integrations", "◎", INTEGRATIONS_BLURB],
  ["audit", "Audit log", "≡", auditLog.BLURB],
];
// Below this width the list of sections becomes a select above the section.
const NARROW = 720;

export function SettingsPage() {
  const { machinesVersion } = useApp();
  const [key, setKey] = useState<Key>("computers");
  // The agent the sections show (the sections take one, as the desk's did).
  const [only, setOnly] = useState<string | null>(config.MACHINES[0]?.machine ?? null);
  const [narrow, setNarrow] = useState(false);
  const frame = useRef<HTMLDivElement>(null);

  // PERMISSIONS: kept here, as LOCAL MODELS edits the policy through it.
  const perms = useController((draw) => new PermissionsController(draw));
  // ACCOUNTS (the agent's accounts.ts) and engines (engines.ts): each computer's, read on its own.
  const accounts = useController((draw) => new AccountsController(draw));
  // LOCAL MODELS (the agent's localCheck.ts): its helper choices go through PERMISSIONS' review.
  const local = useController((draw) => new LocalModelsController(draw, perms));
  // BRAIN (the agent's brain/): the router's scoreboard, seeds and rules, read on its own.
  const brainC = useController((draw) => new BrainController(draw));
  // INTEGRATIONS: Google, Cloudflare, Mailboxes and GitHub, one block each per computer.
  const googleC = useController((draw) => new GoogleController(draw));
  const cloudflareC = useController((draw) => new CloudflareController(draw));
  const github = useController((draw) => new IntegrationsController(draw));
  // PROJECTS (the agent's folders.ts): where each computer looks for repositories.
  const foldersC = useController((draw) => new FoldersController(draw));
  // AUDIT LOG (the agent's auditTrail.ts): read only, read again when shown.
  const auditC = useController((draw) => new AuditLogController(draw));

  // Read again each time the page is shown, and when the agent is linked or unlinked.
  useEffect(() => {
    if (!config.MACHINES.some((m) => m.machine === only)) setOnly(config.MACHINES[0]?.machine ?? null);
    perms.reload();
    accounts.reload();
    local.reload();
    brainC.reload();
    googleC.reload();
    cloudflareC.reload();
    github.reload();
    foldersC.reload();
    auditC.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machinesVersion]);

  // A hidden section does not poll; Local models starts again when it is shown.
  local.mapped = key === "local";
  useEffect(() => {
    if (key === "local") local.keepPolling();
  }, [key, local]);
  // The audit log grows as the agent acts: read again each time its section is opened.
  useEffect(() => {
    if (key === "audit") auditC.reload();
  }, [key, auditC]);

  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const watch = new ResizeObserver(() => setNarrow(el.clientWidth <= NARROW));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const bodies: Record<Key, ReactNode> = {
    computers: <ComputersSection />,
    app: <ThisAppSection />,
    engines: <AccountsSection c={accounts} only={only} />,
    projects: <FoldersSection c={foldersC} only={only} />,
    brain: <BrainSection c={brainC} />,
    audit: <AuditLogSection c={auditC} only={only} />,
    permissions: <PermissionsSection p={perms} />,
    local: <LocalModelsSection c={local} only={only} />,
    integrations: (
      <>
        <GoogleSection c={googleC} only={only} />
        <CloudflareSection c={cloudflareC} only={only} />
        <MailboxesSection only={only} />
        <IntegrationsSection c={github} only={only} />
      </>
    ),
  };

  return (
    <div className={cls("settings-page board-page", narrow && "narrow")} ref={frame}>
      {!narrow && (
        <nav className="settings-nav">
          <ul className="nav">
            {SECTIONS.map(([k, title, glyph]) => (
              <li key={k} className={cls(k === key && "active")} onClick={() => setKey(k)}>
                <span className="nav-glyph">{glyph}</span>
                <span className="grow">{title}</span>
              </li>
            ))}
          </ul>
        </nav>
      )}
      <div className="settings-main">
        {narrow && (
          <select className="entry settings-compact" value={key} onChange={(e) => setKey(e.target.value as Key)}>
            {SECTIONS.map(([k, title]) => <option key={k} value={k}>{title}</option>)}
          </select>
        )}
        {SECTIONS.map(([k, title, , blurb]) => (
          // Every section stays drawn, as the desk's stack kept them: a draft or a paste survives a visit elsewhere.
          <div key={k} className="settings-scroll" hidden={k !== key}>
            <div className="settings-inner">
              <div className="settings-head">
                <div className="page-title">{title}</div>
                <div className="page-blurb">{blurb}</div>
              </div>
              {bodies[k]}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
