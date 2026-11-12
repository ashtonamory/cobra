/**
 * The projects one specialist is attached to besides its own, in its panel
 * on My Organization: the list, Detach beside each, and "Attach a project…"
 * to pick another the person already has. These are the person's own acts,
 * so the agent asks no card (agent specialistAttach.ts). When the agent has a
 * warning to give (another Space's project, or a Space that keeps people's
 * details here and a project with a copy online), it attaches nothing until
 * the person has read it here and said to go on.
 */
import { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api.ts";
import { ATTACH_MAX, ATTACH_NOTE, attachChoices, attachedTo, attachWarnings, rosterOf, type RosterEntry } from "../lib/specialistProjects.ts";
import { Button } from "./ui.tsx";

const words = (caught: unknown): string => (caught instanceof Error ? caught.message : typeof caught === "object" && caught && "message" in caught ? String((caught as { message: unknown }).message) : String(caught));

/** A project the person picked that the agent warned about: nothing is attached until they confirm. */
export type AttachAsk = { project: string; warnings: string[] };

/** The list and its controls, drawn from a roster already read. */
export function AttachedList({ roster, id, name, picking, busy, ask = null, onPick, onAttach, onDetach, onConfirm = () => {}, onCancel = () => {} }: {
  roster: readonly RosterEntry[];
  id: string;
  name: string;
  picking: boolean;
  busy: boolean;
  ask?: AttachAsk | null;
  onPick: (open: boolean) => void;
  onAttach: (project: string) => void;
  onDetach: (project: string) => void;
  onConfirm?: () => void;
  onCancel?: () => void;
}) {
  const attached = attachedTo(roster, id);
  const choices = attachChoices(roster, id);
  const full = attached.length >= ATTACH_MAX;
  // Hired on its own, it has no project until the person attaches one.
  const standalone = roster.find((entry) => entry.id === id)?.standalone === true;
  return (
    <div className="org-attached">
      <div className="caps dim">{standalone ? "Works on" : "Also works on"}</div>
      {attached.length === 0 && <p className="dim">{standalone ? `No project yet. Attach ${name} to a project you already have, and it can work there.` : `Only its own project. Attach ${name} to another project you already have, and it can work there too.`}</p>}
      {attached.map((repo) => (
        <div key={repo.id} className="org-attached-row">
          <span className="grow ellipsis" title={repo.path}>{repo.name}</span>
          <Button kind="flat" small disabled={busy} onClick={() => onDetach(repo.id)} title={`Detach ${name} from ${repo.name}`}>Detach</Button>
        </div>
      ))}
      {ask ? (
        <div className="org-attach-warning" role="alert">
          <div className="caps">Before you attach {name} to {roster.find((entry) => entry.id === ask.project)?.project ?? "this project"}</div>
          {ask.warnings.map((warning) => <p key={warning}>{warning}</p>)}
          <div className="org-actions">
            <Button kind="flat" disabled={busy} onClick={onConfirm}>Attach anyway</Button>
            <Button kind="flat" small disabled={busy} onClick={onCancel}>Cancel</Button>
          </div>
        </div>
      ) : picking ? (
        <>
          <p className="dim">{ATTACH_NOTE(name)}</p>
          <div className="org-choices">
            {choices.map((choice) => (
              <button key={choice.id} className="org-choice" disabled={busy} onClick={() => onAttach(choice.id)}>{choice.name}</button>
            ))}
          </div>
          <Button kind="flat" small onClick={() => onPick(false)}>Cancel</Button>
        </>
      ) : full ? (
        <p className="dim">{name} is attached to {ATTACH_MAX} projects, the most one specialist has. Detach one to attach another.</p>
      ) : choices.length > 0 ? (
        <div className="org-actions">
          <Button kind="flat" disabled={busy} onClick={() => onPick(true)}>Attach a project…</Button>
        </div>
      ) : attached.length > 0 ? (
        <p className="dim">{name} is attached to every other project on this computer.</p>
      ) : null}
    </div>
  );
}

export function AttachedProjects({ machine, id, name, toast }: { machine: string; id: string; name: string; toast: (text: string) => void }) {
  const [roster, setRoster] = useState<RosterEntry[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState<AttachAsk | null>(null);

  const read = useCallback(
    () => api.specialists(machine).then((answer) => setRoster(rosterOf(answer))).catch(() => setRoster(null)),
    [machine],
  );
  useEffect(() => {
    setRoster(null);
    setPicking(false);
    setAsk(null);
    void read();
  }, [read, id]);

  const act = (what: "attach" | "detach", project: string, confirmed = false) => {
    setBusy(true);
    void (what === "attach" ? api.specialistAttach(machine, id, project, confirmed) : api.specialistDetach(machine, id, project))
      .then((answer) => {
        setPicking(false);
        // The agent attached nothing yet: it has something for the person to read first.
        const warnings = what === "attach" ? attachWarnings(answer) : null;
        setAsk(warnings ? { project, warnings } : null);
        if (warnings) return;
        toast(what === "attach" ? `Attached. ${name} reads the project's files from its next conversation.` : "Detached.");
      })
      .catch((caught) => toast(`Not ${what}ed: ${words(caught)}`))
      .then(() => read())
      .finally(() => setBusy(false));
  };

  // An agent that cannot say (unreachable, or older than this) shows nothing rather than a wrong list.
  if (!roster) return null;
  return <AttachedList roster={roster} id={id} name={name} picking={picking} busy={busy} onPick={setPicking} ask={ask} onAttach={(project) => act("attach", project)} onDetach={(project) => act("detach", project)} onConfirm={() => ask && act("attach", ask.project, true)} onCancel={() => setAsk(null)} />;
}
