/**
 * The main window (the desk's app.py + ui/window.py): a sidebar of the
 * phone's tabs and one page at a time. Closing it hides it — the app keeps
 * running in the tray, and so do notifications. It owns the fleet poller and
 * turns its events into popups and notifications.
 */
import { APP_NAME } from "../lib/appName.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { AppContext, useFleet, type AppCtx, type PageKey } from "../app/context.ts";
import { Fleet } from "../lib/fleet.ts";
import { Actions } from "../lib/actions.ts";
import { bridge } from "../lib/bridge.ts";
import * as config from "../lib/config.ts";
import * as model from "../lib/model.ts";
import { nowS } from "../lib/json.ts";
import { onToMain, sendSnapshot, toPopup } from "../lib/surfaces.ts";
import { placeOf, rowProject, useShowCrew, whoWords } from "../lib/crewVisibility.ts";
import { townOf } from "../lib/org.ts";
import { getOrg, refreshOrg } from "../lib/orgStore.ts";
import { cls } from "../components/ui.tsx";
import { HomePage } from "../pages/Home.tsx";
import { OrgPage } from "../pages/Org.tsx";
import { ProjectsPage } from "../pages/Projects.tsx";
import { ProjectPage } from "../pages/ProjectPage.tsx";
import { AllMoneyPage } from "../pages/AllMoney.tsx";
import { SettingsPage } from "../pages/Settings.tsx";
import { SetupPage } from "../pages/Setup.tsx";
import { NotebookPage } from "../pages/Notebook.tsx";
// Shared bits (dialogs, dots, spinners) still live in the old Fleet page's sheet.
import "../styles/fleet.css";

// The phone's tabs and Projects, which the desk keeps. Settings is a page but not a sidebar row: the
// header's gear opens it. Home's page key stays "ops", which `cobra-desktop ops` and the tray still send.
const PAGES: Array<[PageKey, string, string]> = [
  ["ops", "Home", "⌂"],
  ["notebook", "Notebook", "❧"],
  ["agents", "Org", "◌"],
  ["projects", "Projects", "▤"],
  ["money", "All money", "$"],
];
// Names from before the workforce rebuild, still accepted.
const ALIASES: Record<string, PageKey> = { home: "ops", now: "ops", today: "ops", chat: "agents" };
const TITLES: Record<PageKey, string> = { ops: "Home", agents: "My Organization", projects: "Projects", money: "All money", settings: "Settings", notebook: "Notebook" };

export function MainSurface() {
  const fleet = useMemo(() => new Fleet(), []);
  const [page, setPage] = useState<PageKey>("ops");
  const [chat, setChat] = useState<{ machine: string; session: string; n: number } | null>(null);
  const [project, setProject] = useState<{ machine: string; project: string } | null>(null);
  const [newProjectAsk, setNewProjectAsk] = useState(0);
  const [toasts, setToasts] = useState<Array<{ id: number; text: string }>>([]);
  const [machinesVersion, setMachinesVersion] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const toastId = useRef(0);

  const toast = useCallback((text: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const show = useCallback((p: string) => {
    const key = (ALIASES[p] ?? p) as PageKey;
    setProject(null);
    setPage(TITLES[key] ? key : "ops");
  }, []);

  const openChat = useCallback((machine: string, session: string) => {
    setProject(null);
    setPage("agents");
    setChat((c) => ({ machine, session, n: (c?.n ?? 0) + 1 }));
  }, []);

  const reloadMachines = useCallback(async () => {
    config.setMachines(await bridge.computers());
    setMachinesVersion((v) => v + 1);
    fleet.refreshSlow();
  }, [fleet]);

  const actions = useMemo(() => new Actions({ fleet, toast, openChat }), [fleet, toast, openChat]);

  const ctx: AppCtx = useMemo(
    () => ({
      fleet, actions, toast, show, openChat, reloadMachines, machinesVersion,
      openProject: (machine, p) => setProject({ machine, project: p }),
      newProject: () => {
        setProject(null);
        setPage("projects");
        setNewProjectAsk((n) => n + 1);
      },
    }),
    [fleet, actions, toast, show, openChat, reloadMachines, machinesVersion],
  );

  // Start: the computers, then the clock, the tray and the other windows.
  useEffect(() => {
    let stop = false;
    const unlisten: Array<Promise<() => void>> = [];
    (async () => {
      config.setMachines(await bridge.computers());
      if (stop) return;
      setLoaded(true);
      setMachinesVersion((v) => v + 1);
      fleet.refresh();
      // An agent installed with --name reads by that name, even when it was linked before it said so.
      const renamed = await bridge.learnNames().catch(() => 0);
      if (stop || !renamed) return;
      config.setMachines(await bridge.computers());
      setMachinesVersion((v) => v + 1);
    })();
    unlisten.push(listen("tick", () => fleet.tick()));
    unlisten.push(listen<string>("navigate", (e) => show(e.payload)));
    unlisten.push(
      onToMain((m) => {
        if (m.kind === "refresh") fleet.refresh();
        else if (m.kind === "open-chat") {
          openChat(m.machine, m.session);
          bridge.showMain();
        } else if (m.kind === "show") bridge.showMain(m.page);
        else if (m.kind === "toast") {
          // From the popup or the picker while this window is hidden: a toast nobody sees is lost.
          if (document.visibilityState === "hidden") notify(APP_NAME, m.text);
          else toast(m.text);
        }
      }),
    );
    const offChange = fleet.subscribe(() => {
      const needs = fleet.needsYou().length + fleet.pendingApprovals();
      const working = fleet.rows.filter((r) => r.state === "working").length;
      const alerts = Object.values(fleet.alerts).reduce((n, v) => n + v.length, 0);
      bridge.setTray(needs, working, alerts).catch(() => {});
      sendSnapshot(fleet.snapshot()).catch(() => {});
    });
    // The org, so a popup can name the Space that asks instead of a Foreman (lib/crewVisibility.ts).
    void refreshOrg().catch(() => {});
    const offEvents = fleet.onEvents((events) => onEvents(events, { show, openChat }, (row) => {
      const { org } = getOrg();
      const town = townOf({ rows: fleet.rows, orch: fleet.orch, org, approvals: {}, away: new Set(), colorOf: () => "" });
      return whoWords(row.lead ? null : placeOf(town, org, row.machine, rowProject(row)));
    }));
    (async () => {
      if (!(await isPermissionGranted())) await requestPermission();
    })().catch(() => {});
    return () => {
      stop = true;
      offChange();
      offEvents();
      unlisten.forEach((p) => p.then((f) => f()));
    };
  }, [fleet, show, openChat, toast]);

  // Alt+1..4 switch pages, as on Omarchy.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.altKey && e.key >= "1" && e.key <= String(PAGES.length)) {
        show(PAGES[Number(e.key) - 1][0]);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [show]);

  if (!loaded) return null;
  const needsSetup = config.MACHINES.length === 0;

  return (
    <AppContext.Provider value={ctx}>
      <Shell page={page} show={show} needsSetup={needsSetup}>
        {needsSetup && page !== "settings" ? (
          <SetupPage />
        ) : project ? (
          <ProjectPage key={`${project.machine}:${project.project}`} machine={project.machine} project={project.project} onClose={() => setProject(null)} />
        ) : page === "ops" ? (
          <HomePage />
        ) : page === "agents" ? (
          <OrgPage open={chat} />
        ) : page === "projects" ? (
          <ProjectsPage newProjectAsk={newProjectAsk} />
        ) : page === "money" ? (
          <AllMoneyPage />
        ) : page === "notebook" ? (
          <NotebookPage />
        ) : (
          <SettingsPage />
        )}
      </Shell>
      <div className="toasts">
        {toasts.map((t) => (
          <div className="toast" key={t.id}>{t.text}</div>
        ))}
      </div>
    </AppContext.Provider>
  );
}

function Shell({ page, show, needsSetup, children }: { page: PageKey; show: (p: string) => void; needsSetup: boolean; children: React.ReactNode }) {
  const fleet = useFleet();
  // Code projects are the crew's: with it hidden (lib/crewVisibility.ts) the sidebar has no Projects.
  const showCrew = useShowCrew();
  const pages = showCrew ? PAGES : PAGES.filter(([key]) => key !== "projects");
  const [compact, setCompact] = useState(window.innerWidth < 720);
  useEffect(() => {
    const r = () => setCompact(window.innerWidth < 720);
    window.addEventListener("resize", r);
    return () => window.removeEventListener("resize", r);
  }, []);
  const needs = fleet.needsYou().length + fleet.pendingApprovals();
  const alerts = Object.values(fleet.alerts).reduce((n, v) => n + v.length, 0);
  const badges: Partial<Record<PageKey, number>> = { ops: needs };
  const foot = [
    ...config.MACHINES.map((m) => (fleet.reachable.has(m.machine) ? "● " : "○ ") + m.label),
    ...(fleet.unreachable.length ? ["no agent: " + fleet.unreachable.join(", ")] : []),
    ...(alerts ? [`${alerts} alert${alerts === 1 ? "" : "s"}`] : []),
  ].join("\n");
  return (
    <div className={cls("shell", compact && "compact")}>
      {!compact && (
        <aside className="sidebar">
          <div className="brand">{APP_NAME}</div>
          <ul className="nav">
            {pages.map(([key, title, glyph]) => (
              <li key={key} className={cls(page === key && "active")} onClick={() => show(key)}>
                <span className="glyph">{glyph}</span>
                <span className="grow">{title}</span>
                {badges[key] ? <span className="pill p-needs">{badges[key]}</span> : null}
              </li>
            ))}
          </ul>
          <div className="foot">{foot}</div>
        </aside>
      )}
      <main className="content">
        <div className="header">
          {compact && (
            <select className="entry" value={page} onChange={(e) => show(e.target.value)}>
              {pages.map(([k, t]) => (
                <option key={k} value={k}>{t}{badges[k] ? ` (${badges[k]})` : ""}</option>
              ))}
              <option value="settings">Settings</option>
            </select>
          )}
          <span className="title">{needsSetup && page !== "settings" ? "Welcome" : TITLES[page]}</span>
          <button className="btn icon flat" title="Find a session (Ctrl+Shift+Space)" onClick={() => bridge.togglePicker()}>⌕</button>
          <button className="btn icon flat" title="Ask the agent now" onClick={() => fleet.refreshSlow()}>⟳</button>
          <button className={cls("btn icon flat")} title="Settings" onClick={() => show("settings")}>⚙</button>
        </div>
        {children}
      </main>
    </div>
  );
}

/** Each event as the desk shows it: a popup for what you answer, a notification for the rest. */
function onEvents(events: model.Event[], nav: { show: (p: string) => void; openChat: (m: string, s: string) => void },
  who: (row: model.Row) => string) {
  void nav;
  for (const e of events) {
    if (e.kind === "cleared") {
      toPopup.remove(e.key);
    } else if (e.kind === "needs" && e.row) {
      toPopup.add({ key: e.key, kind: "needs", machine: e.row.machine, project: e.row.project ?? undefined, who: who(e.row), at: nowS() });
    } else if (e.kind === "approval") {
      toPopup.add({ key: e.key, kind: "approval", machine: e.machine, approval: e.approval ?? {}, at: nowS() });
    } else if (e.kind === "alert") {
      // The agent sends alerts to the desktop's notifications itself; the count stays in the sidebar.
    } else if (e.kind === "finished") {
      if (e.notice) {
        const n = e.notice;
        notify(`${n.title || APP_NAME} · ${e.row ? e.row.label : config.label(e.machine)}`, String(n.body ?? "").slice(0, 200));
      } else if (e.row) {
        const tail = ((e.row.project?.tail ?? []) as string[]).filter((t) => t.trim());
        notify(`${e.row.name} finished · ${e.row.label}`, tail.length ? tail[tail.length - 1].slice(0, 200) : "");
      }
    }
  }
}

function notify(title: string, body: string) {
  try {
    sendNotification({ title, body });
  } catch (e) {
    console.error("notification failed", e);
  }
}
