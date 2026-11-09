/**
 * My Organization — the phone's chart (its OrgChart.tsx) on the desk: you, Cobra, then each Space
 * as a card (its mark, kind, NEXT routine, what runs or ran, and how many things wait there: design
 * docs/cobra-space-screen.tessel.json frame 01, words lib/spaceScreen.ts); or the list, which is the
 * Agents page as it was. One click on a Space opens its own screen (components/SpaceScreen.tsx), where
 * its crew is when Show the crew is on; click Cobra for her chat. Where everyone sits is the org on the
 * Lead's computer (lib/orgStore.ts); what it means is lib/org.ts and lib/orgChart.ts. Change both
 * apps together.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useApp, useFleet } from "../app/context.ts";
import * as api from "../lib/api.ts";
import * as config from "../lib/config.ts";
import * as crewLib from "../lib/crew.ts";
import type { OrgChange } from "../../../../../packages/contracts/src/org.ts";
import { askCobraWith, NEW_SPACE_DRAFT } from "../lib/cobraDraft.ts";
import { needingSeats, summaryLine, townOf, type Seat } from "../lib/org.ts";
import { chartOf, spaceLine, type ChartSpace } from "../lib/orgChart.ts";
import { changeOrg, refreshOrg, setHiring, useOrg } from "../lib/orgStore.ts";
import { spaceSkillsLine, spacesSummary, useShowCrew, visibleChart } from "../lib/crewVisibility.ts";
import { runningLine, seatMachines, spaceCard, spaceLetter } from "../lib/spaceScreen.ts";
import { Button, Switch, cls } from "../components/ui.tsx";
import { Sprite } from "../components/Sprite.tsx";
import { SpaceScreen } from "../components/SpaceScreen.tsx";
import { useNow, useRoutines } from "../components/useSpaceData.ts";
import { AgentsPage } from "./Agents.tsx";
import "../styles/org.css";
import { LEAD_NAME } from "../lib/appName.ts";

type View = "chart" | "list";
type Panel =
  | { kind: "company"; id: string }
  | { kind: "new" }
  | { kind: "outskirts" }
  | { kind: "peek"; key: string }
  | { kind: "move"; key: string }
  | { kind: "proposal" }
  | { kind: "cobra" }
  | { kind: "house" };

const VIEW_KEY = "cobra.org.view";
const PANEL_W = 340;
// The computers' colours (app.css), for a building's pennant.
const HUE_HEX: Record<string, string> = { blue: "#89b4fa", cyan: "#94e2d5", magenta: "#cba6f7", green: "#a6e3a1", yellow: "#f9e2af", orange: "#fab387", accent: "#89b4fa" };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function rememberedView(): View {
  try {
    // "map" is the choice kept before the chart replaced the town.
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "chart";
  } catch {
    return "chart";
  }
}

// The last conversation request already shown, so coming back to the page keeps the view you chose.
let honoured = 0;

export function OrgPage({ open }: { open: { machine: string; session: string; n: number } | null }) {
  const [view, setView] = useState<View>(() => (open && open.n !== honoured ? "list" : rememberedView()));
  const choose = (next: View) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // A private window keeps the choice for this page only.
    }
  };
  // A conversation asked for (a popup, a notification, HQ) opens on the list.
  useEffect(() => {
    if (open && open.n !== honoured) {
      honoured = open.n;
      setView("list");
    }
  }, [open]);

  const switcher = (
    <div className="org-switch" role="tablist">
      {(["chart", "list"] as const).map((v) => (
        <button key={v} role="tab" aria-selected={view === v} className={cls(view === v && "on")} onClick={() => choose(v)}>
          {v === "chart" ? "Chart" : "List"}
        </button>
      ))}
    </div>
  );
  return view === "chart" ? <OrgChart switcher={switcher} /> : (
    <div className="org-listview">
      <div className="org-listbar">{switcher}</div>
      <AgentsPage open={open} />
    </div>
  );
}

function OrgChart({ switcher }: { switcher: ReactNode }) {
  const app = useApp();
  const fleet = useFleet();
  const { org, home } = useOrg();
  const away = useMemo(() => new Set(config.MACHINES.map((m) => m.machine).filter((m) => fleet.loaded && !fleet.reachable.has(m))), [fleet.loaded, fleet.reachable]);
  const town = useMemo(
    () => townOf({ rows: fleet.rows, orch: fleet.orch, org, approvals: fleet.approvals, away, colorOf: (m) => HUE_HEX[config.hue(m)] ?? HUE_HEX.accent }),
    [fleet.rows, fleet.orch, org, fleet.approvals, away],
  );
  // With the crew hidden (Settings → This app → Show the crew, lib/crewVisibility.ts): Spaces only, tiles by skill.
  const show = useShowCrew();
  const chart = useMemo(() => visibleChart(chartOf(town, org), show), [town, org, show]);
  const [panel, setPanel] = useState<Panel | null>(null);
  // The Space whose own screen is showing (components/SpaceScreen.tsx), or none: the chart.
  const [spacePage, setSpacePage] = useState<string | null>(null);
  // Each card's NEXT and its line under it, from the routines on the computers the Spaces sit on.
  const now = useNow();
  const cardSpaces = useMemo(() => chart.spaces.filter((item) => item.id !== null), [chart.spaces]);
  const { routines } = useRoutines(useMemo(() => seatMachines(cardSpaces), [cardSpaces]));
  const cards = useMemo(() => new Map(cardSpaces.map((item) => [item.id, spaceCard(item, routines, now)])), [cardSpaces, routines, now]);
  const running = runningLine([...cards.values()]);
  const [typing, setTyping] = useState<{ what: "rename-foreman" | "rename-company" | "new-company"; text: string } | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const step = useRef(0);

  useEffect(() => {
    void refreshOrg();
    const t = setInterval(() => void refreshOrg(), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    setTyping(null);
    setArmed(null);
  }, [panel]);

  const leadRow = fleet.rows.find((r) => r.lead && !away.has(r.machine));
  const openCobra = async () => {
    if (leadRow) return app.openChat(leadRow.machine, leadRow.session);
    const where = home ?? config.MACHINES[0]?.machine;
    if (!where) return app.toast(`Add a computer first, and ${LEAD_NAME} runs on it.`);
    try {
      await api.startLead(where);
      fleet.refresh();
      app.openChat(where, "cobra_lead");
    } catch (e) {
      app.toast(`${LEAD_NAME} did not start: ${msg(e)}`);
    }
  };
  const openProject = (seat: Seat) => app.openProject(seat.machine, seat.project);
  const answer = (seat: Seat) => seat.needing && app.openChat(seat.needing.machine, seat.needing.session);

  const change = (what: string, next: OrgChange, then?: () => void) =>
    void changeOrg(next).then(() => then?.()).catch((e) => app.toast(`Not ${what}: ${msg(e)}`));
  const crew = (seat: Seat, body: Record<string, unknown>, what: string) =>
    void api.crew(seat.machine, seat.project, body).then(() => fleet.refresh()).catch((e) => app.toast(`Not ${what}: ${msg(e)}`));
  const hire = (id: string) => {
    const company = org.companies.find((c) => c.id === id);
    if (company) setHiring({ id, name: company.name });
    app.newProject();
  };
  const openCompany = (name: string, seat?: Seat) =>
    void changeOrg({ op: "company", name })
      .then((done) => (seat && done.created ? changeOrg({ op: "assign", seat: seat.key, company: done.created }) : undefined))
      .then(() => setPanel(seat ? { kind: "peek", key: seat.key } : null))
      .catch((e) => app.toast(`Not opened: ${msg(e)}`));

  const needing = needingSeats(town).filter((seat) => show || chart.spaces.some((item) => item.id === seat.company));
  const nextNeeding = () => {
    if (!needing.length) return;
    if (!show) {
      // No Foreman's card with the crew hidden: open the next Space that waits on you.
      const spaces = chart.spaces.filter((item) => item.needs > 0);
      const item = spaces[step.current % spaces.length];
      step.current += 1;
      if (item) (setSpacePage(item.id), setPanel(null));
      return;
    }
    const seat = needing[step.current % needing.length];
    step.current += 1;
    setPanel({ kind: "peek", key: seat.key });
  };
  const seats = [...town.seats.values()];
  const companyName = (id: string | null) => (id ? org.companies.find((c) => c.id === id)?.name ?? id : "New arrivals");

  const field = (placeholder: string, submit: (text: string) => void) =>
    typing && (
      <form className="org-field" onSubmit={(e) => { e.preventDefault(); submit(typing.text); setTyping(null); }}>
        <input className="entry" autoFocus value={typing.text} placeholder={placeholder} maxLength={32}
          onChange={(e) => setTyping({ ...typing, text: e.target.value })} />
        <Button kind="primary" small type="submit">Save</Button>
        <Button kind="flat" small onClick={() => setTyping(null)}>Cancel</Button>
      </form>
    );

  let title = "";
  let sub = "";
  let body: ReactNode = null;
  if (panel?.kind === "peek" || panel?.kind === "move") {
    const seat = town.seats.get(panel.key);
    if (seat) {
      title = seat.name;
      sub = `${seat.label} · ${seat.retired ? "Outskirts" : companyName(seat.company)} · ${config.label(seat.machine)}`;
      body = panel.kind === "peek" ? (
        <>
          <p>{stateWords(seat, config.label(seat.machine))}</p>
          <div className="org-actions">
            <Button kind="primary" onClick={() => openProject(seat)}>Open project</Button>
            {seat.needing && <Button onClick={() => answer(seat)}>Answer</Button>}
          </div>
          {typing?.what === "rename-foreman" ? field("Its given name", (text) => crew(seat, { name: text.trim() ? text : null }, "renamed")) : (
            <div className="org-actions">
              <Button kind="flat" onClick={() => setTyping({ what: "rename-foreman", text: seat.name })}>Rename…</Button>
              <Button kind="flat" onClick={() => crew(seat, { look: "next" }, "changed")}>New look</Button>
            </div>
          )}
          <div className="org-actions">
            <Button kind="flat" onClick={() => setPanel({ kind: "move", key: seat.key })}>Move…</Button>
            {seat.retired
              ? <Button kind="flat" onClick={() => change("brought back", { op: "bring-back", seat: seat.key })}>Bring back</Button>
              : <Button kind="flat" onClick={() => change("retired", { op: "retire", seat: seat.key }, () => setPanel(null))}>Retire</Button>}
          </div>
        </>
      ) : (
        <>
          <p>Which company does {seat.name} work for?</p>
          <div className="org-choices">
            {org.companies.map((c) => (
              <button key={c.id} className={cls("org-choice", seat.company === c.id && !seat.retired && "on")}
                onClick={() => change("moved", { op: "assign", seat: seat.key, company: c.id }, () => setPanel({ kind: "peek", key: seat.key }))}>
                <span className="org-swatch" style={{ background: c.color }} />{c.name}
              </button>
            ))}
            <button className={cls("org-choice", seat.company === null && !seat.retired && "on")}
              onClick={() => change("moved", { op: "assign", seat: seat.key, company: null }, () => setPanel({ kind: "peek", key: seat.key }))}>
              <span className="org-swatch" />New arrivals (no company)
            </button>
          </div>
          {typing?.what === "new-company" ? field("A client or business", (text) => text.trim() && openCompany(text, seat))
            : <Button kind="flat" onClick={() => setTyping({ what: "new-company", text: "" })}>New company…</Button>}
        </>
      );
    }
  } else if (panel?.kind === "company") {
    const company = org.companies.find((c) => c.id === panel.id);
    if (company) {
      const members = seats.filter((s) => s.company === company.id && !s.retired);
      title = company.name;
      sub = show ? `${members.length} ${members.length === 1 ? "Foreman" : "Foremen"}` : spaceSkillsLine({ seats: members, needs: 0 });
      body = (
        <>
          {show && (
            <SeatList seats={members} empty="Nobody works here yet. Hire a Foreman with a new project, or move one in from New arrivals."
              onPick={(s) => setPanel({ kind: "peek", key: s.key })}
              action={(s) => <Button kind="flat" small onClick={() => change("retired", { op: "retire", seat: s.key })}>Retire</Button>} />
          )}
          {typing?.what === "rename-company" ? field("Company name", (text) => text.trim() && change("renamed", { op: "rename", company: company.id, name: text })) : (
            <div className="org-actions">
              {show && <Button kind="primary" onClick={() => hire(company.id)}>Hire…</Button>}
              <Button kind="flat" onClick={() => setTyping({ what: "rename-company", text: company.name })}>Rename…</Button>
            </div>
          )}
          <label className="org-switch">
            <Switch checked={company.sensitive === true} onChange={(on) => change(on ? "marked sensitive" : "unmarked", { op: "sensitive", company: company.id, on })} />
            <span>
              <b>Sensitive</b>
              <span className="dim">Its memory never leaves the computers its projects run on, and {LEAD_NAME} keeps nothing it reads of it.</span>
            </span>
          </label>
          <div className="org-actions">
            <Button kind="danger" onClick={() => (armed === company.id ? change("closed", { op: "remove", company: company.id }, () => setPanel(null)) : setArmed(company.id))}>
              {armed === company.id ? "Click again to close it" : "Close company"}
            </Button>
          </div>
          {armed === company.id && <p className="dim">{show ? "Its Foremen move to New arrivals. Their projects stay as they are." : "Its work and records stay as they are."}</p>}
        </>
      );
    }
  } else if (panel?.kind === "new") {
    title = "New arrivals";
    sub = "Foremen with no company yet";
    body = (
      <>
        <SeatList seats={seats.filter((s) => s.company === null && !s.retired)} empty="Everyone has a company."
          onPick={(s) => setPanel({ kind: "move", key: s.key })}
          action={(s) => <Button kind="flat" small onClick={() => setPanel({ kind: "move", key: s.key })}>Move…</Button>} />
        {typing?.what === "new-company" ? field("A client or business, such as Happy Tails", (text) => text.trim() && openCompany(text))
          : <Button kind="flat" onClick={() => setTyping({ what: "new-company", text: "" })}>New company…</Button>}
      </>
    );
  } else if (panel?.kind === "outskirts") {
    title = "Outskirts";
    sub = "Retired Foremen keep their projects and names";
    body = (
      <SeatList seats={seats.filter((s) => s.retired)} empty={`Nobody is retired. Right-click a building and choose Retire, or ask ${LEAD_NAME}.`}
        onPick={(s) => setPanel({ kind: "peek", key: s.key })}
        action={(s) => <Button kind="flat" small onClick={() => change("brought back", { op: "bring-back", seat: s.key })}>Bring back</Button>} />
    );
  } else if (panel?.kind === "proposal" && town.proposal) {
    const { machine, approval } = town.proposal;
    const o = approval.org as { seat: string };
    const settle = (allow: boolean) =>
      void app.actions.answerApproval(machine, approval, allow).then((sent) => {
        if (!sent) return;
        setPanel(null);
        fleet.refresh();
        void refreshOrg();
      });
    title = String(approval.title || `${LEAD_NAME} suggests a move`);
    sub = `${LEAD_NAME} suggests`;
    body = (
      <>
        <p className="org-pre">{String(approval.body || "")}</p>
        <div className="org-actions">
          <Button kind="primary" onClick={() => settle(true)}>Allow</Button>
          <Button kind="flat" onClick={() => settle(false)}>Not now</Button>
        </div>
        <Button kind="flat" onClick={() => (settle(false), setPanel({ kind: "move", key: o.seat }))}>Another company…</Button>
      </>
    );
  } else if (panel?.kind === "cobra") {
    const briefed = town.data.foremen.filter((f) => f.briefed).map((f) => f.name);
    title = `${LEAD_NAME}`;
    sub = town.data.lead === "away" ? "Not running" : town.data.lead === "working" ? "Working" : "Idle";
    body = (
      <>
        <p>{!show ? `${LEAD_NAME} does the work in your Spaces for you and tells you what needs you.`
          : `${briefed.length ? `Reports from ${briefed.join(", ")} come to ${LEAD_NAME} (the blue lines).` : `No Foreman reports to ${LEAD_NAME} right now.`} The rest report to you.`}</p>
        <Button kind="primary" onClick={() => void openCobra()}>{leadRow ? `Open ${LEAD_NAME}'s chat` : `Start ${LEAD_NAME}`}</Button>
      </>
    );
  } else if (panel?.kind === "house") {
    title = "Your house";
    sub = "Morning brief";
    body = <p>{LEAD_NAME} writes a morning brief each day; it shows at the top of Home.</p>;
  }

  // One click opens a Space's screen; New arrivals (the crew shown) is its panel.
  const chooseSpace = (item: ChartSpace) => (item.id ? (setPanel(null), setSpacePage(item.id)) : setPanel({ kind: "new" }));
  const newSpace = () => {
    askCobraWith(NEW_SPACE_DRAFT);
    app.show("ops");
  };
  // Cobra's box with its Space chip set to this Space (lib/cobraDraft.ts), for a Space with nothing in it yet.
  const askIn = (id: string) => {
    askCobraWith("", id);
    app.show("ops");
  };
  const lead = town.data.lead;
  const pageSpace = spacePage ? chart.spaces.find((item) => item.id === spacePage) ?? null : null;

  return (
    <div className="org">
      {!pageSpace && <div className="org-bar">
        <button className={cls("org-pill", needing.length > 0 && "needs")} disabled={!needing.length} onClick={nextNeeding}
          title={needing.length ? "Show the next one that needs you" : undefined}>
          {needing.length > 0 && <span className="org-dot" />}
          {show ? summaryLine(town) || "No Foremen yet" : spacesSummary(chart)}
        </button>
        <span className="grow" />
        <button className="org-new" onClick={newSpace} aria-label="New Space">+ New Space</button>
        {switcher}
      </div>}
      {pageSpace ? (
        <div className={cls("org-scroll space", body && "with-panel")}>
          <SpaceScreen space={pageSpace} showCrew={show} onBack={() => setSpacePage(null)} onManage={() => setPanel({ kind: "company", id: pageSpace.id! })}
            onHire={() => hire(pageSpace.id!)} onPeek={(seat) => setPanel({ kind: "peek", key: seat.key })} onAsk={() => askIn(pageSpace.id!)} />
        </div>
      ) : (
      <div className={cls("org-scroll", body && "with-panel")}>
        <ul className="org-tree">
          <li>
            <div className="org-node">You</div>
            <ul>
              <li>
                <button className="org-cobra" onClick={() => void openCobra()} onContextMenu={(e) => { e.preventDefault(); setPanel({ kind: "cobra" }); }}
                  aria-label={`${LEAD_NAME}, ${lead === "away" ? "not running" : lead}. Right-click for who reports to it.`}>
                  <Sprite spec={crewLib.COBRA} colour={crewLib.LEAD_COLOR} state={lead === "away" ? "away" : lead === "working" ? "working" : "idle"} size={38} animate={lead === "working"} />
                  <span>
                    <b>{LEAD_NAME}</b>
                    <span className="dim">{lead === "away" ? "Not running" : running ?? (lead === "working" ? "Working" : "Lead")}</span>
                  </span>
                </button>
                {chart.spaces.length > 0 && (
                  <ul>
                    {chart.spaces.map((item) => {
                      const card = item.id ? cards.get(item.id) : undefined;
                      const sub = item.id === null ? "Foremen with no company yet" : item.kindWords ?? (show ? spaceLine(item) : spaceSkillsLine(item));
                      return (
                        <li key={item.id ?? "arrivals"}>
                          <button className={cls("org-space", item.needs > 0 && "needs")} style={{ ["--space" as string]: item.color }} onClick={() => chooseSpace(item)}
                            aria-label={`${item.name}. ${sub}.${card ? ` Next: ${card.next}. ${card.now}.` : ""}${item.needs ? ` ${item.needs} waiting on you.` : ""} Click to open.`}>
                            <span className="org-space-head">
                              <span className="org-mark" aria-hidden>{spaceLetter(item.name)}</span>
                              <span className="org-space-name">
                                <b>{item.name}</b>
                                <span className="dim">{sub}{item.sensitive ? " · sensitive" : ""}</span>
                              </span>
                              {item.needs > 0 && <span className="org-badge">{item.needs}</span>}
                            </span>
                            {card ? (
                              <>
                                <span className="org-next-label">Next</span>
                                <span className="org-next">{card.next}</span>
                                <span className={cls("org-now", `tone-${card.tone}`)}>{card.now}</span>
                              </>
                            ) : (
                              <span className="org-now tone-faint">{show ? spaceLine(item) : spaceSkillsLine(item)}</span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            </ul>
          </li>
        </ul>
        {chart.spaces.length === 0 && <p className="org-empty dim">No Spaces yet. Click New Space and tell {LEAD_NAME} what it is for.</p>}
        {chart.spaces.length > 0 && <p className="org-hint dim">Click a Space to open it</p>}
        <div className="org-foot">
          {show && (
            <button className="org-chip" onClick={() => setPanel({ kind: "outskirts" })}>
              OUTSKIRTS · {chart.outskirts.length} retired {chart.outskirts.length === 1 ? "Foreman" : "Foremen"}
            </button>
          )}
          <button className="org-chip" onClick={() => setPanel({ kind: "house" })}>MORNING BRIEF</button>
        </div>
        {/* Cobra's suggested move is a Foreman's: with the crew hidden it waits on Home like any card. */}
        {show && town.proposal && <button className="org-proposal" onClick={() => setPanel({ kind: "proposal" })}>{LEAD_NAME} suggests: {String(town.proposal.approval.title || "a move")}</button>}
      </div>
      )}
      {body && (
        <aside className="org-panel" style={{ width: PANEL_W }}>
          <div className="org-panel-head">
            <div className="grow">
              <div className="org-panel-title">{title}</div>
              {sub && <div className="dim">{sub}</div>}
            </div>
            <button className="org-close" title="Close" onClick={() => setPanel(null)}>×</button>
          </div>
          <div className="org-panel-body">{body}</div>
        </aside>
      )}
    </div>
  );
}

function stateWords(seat: Seat, where: string): string {
  if (seat.retired) return "Retired to the Outskirts. Its project and name are kept.";
  if (seat.state === "away") return `${where} isn't answering.`;
  if (seat.state === "needs") return "Needs you.";
  if (seat.state === "working") return "Working.";
  return seat.foreman ? "Idle." : "No Foreman running. Open the project to start one.";
}

function SeatList({ seats, empty, onPick, action }: { seats: Seat[]; empty: string; onPick: (s: Seat) => void; action: (s: Seat) => ReactNode }) {
  if (!seats.length) return <p className="dim">{empty}</p>;
  return (
    <div className="org-seats">
      {seats.map((s) => (
        <div key={s.key} className="org-seat" onClick={() => onPick(s)}>
          <span className={cls("org-state", `st-${s.state}`)} />
          <div className="grow">
            <div className="org-seat-name">{s.name}</div>
            <div className="dim">{s.label} · {config.label(s.machine)}</div>
          </div>
          {action(s)}
        </div>
      ))}
    </div>
  );
}
