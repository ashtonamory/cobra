/**
 * Settings → Integrations → MAILBOXES: per computer, the
 * iCloud and Zoho boxes its Spaces can send branded email from, added with an app password the
 * computer checks by logging in, and the box each Space uses (Gmail when it names none). The
 * phone's app/mailboxes.tsx shows the same, with the shared words in contracts mailboxes.ts:
 * change both together.
 */
import { useCallback, useEffect, useState } from "react";
import * as api from "../../lib/api.ts";
import * as config from "../../lib/config.ts";
import { addBoxProblem, boxChoices, boxSpacesLine, MAILBOXES_BLURB, MailboxList } from "../../../../../../packages/contracts/src/mailboxes.ts";
import { Board, BoardRow, Button } from "../ui.tsx";
import { Confirm } from "../Verbs.tsx";
import { Group, Spinner, Toggles, why } from "./common.tsx";

type Read = { list: MailboxList } | { failed: string };

export function MailboxesSection({ only }: { only: string | null }) {
  return (
    <>
      {config.MACHINES.filter((m) => only === null || m.machine === only).map((m) => <Machine key={m.machine} machine={m.machine} />)}
    </>
  );
}

function Machine({ machine }: { machine: string }) {
  const computer = config.label(machine);
  const [read, setRead] = useState<Read | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ id: string; address: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(() => {
    api.mailboxes(machine).then(
      (raw) => {
        // An agent's answer this build cannot read is a failure to show, never a thrown error.
        const got = MailboxList.safeParse(raw);
        setRead(got.success ? { list: got.data } : { failed: "the agent's answer was not a mailbox list" });
      },
      (e) => setRead({ failed: why(e) }),
    );
  }, [machine]);
  useEffect(load, [load]);

  const run = async (act: () => Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    try {
      const got = MailboxList.safeParse(await act());
      if (got.success) setRead({ list: got.data });
      else setProblem("the agent's answer was not a mailbox list");
    } catch (e) {
      setProblem(why(e));
    } finally {
      setBusy(false);
    }
  };

  if (!read) {
    return (
      <Group title="Mailboxes" note={MAILBOXES_BLURB}>
        <div className="row"><Spinner /><span className="dim">Asking {computer}…</span></div>
      </Group>
    );
  }
  if ("failed" in read) {
    return (
      <Group title="Mailboxes" note={MAILBOXES_BLURB}>
        <Board><BoardRow time={null} title="Mailboxes" word="no answer" tone="muted" machine={machine} detail={read.failed} /></Board>
        <div className="row"><Button kind="flat" onClick={load}>Refresh</Button></div>
      </Group>
    );
  }
  const list = read.list;
  const choices = boxChoices(list);
  return (
    <Group title="Mailboxes" note={MAILBOXES_BLURB}>
      {list.boxes.length > 0 && (
        <Board>
          {list.boxes.map((box) => (
            <BoardRow key={box.id} time={null} title={box.address} word={list.providers.find((p) => p.id === box.provider)?.name ?? box.provider} tone="ink" machine={machine} detail={boxSpacesLine(list, box)} keepActions
              actions={<Button kind="flat" small disabled={busy} onClick={() => setRemoving({ id: box.id, address: box.address })}>Remove</Button>} />
          ))}
        </Board>
      )}
      {adding ? (
        <AddBox list={list} busy={busy} onCancel={() => (setAdding(false), setProblem(null))}
          onAdd={async (form) => {
            setBusy(true);
            setProblem(null);
            try {
              await api.addMailbox(machine, form);
              setAdding(false);
              load();
            } catch (e) {
              setProblem(why(e));
            } finally {
              setBusy(false);
            }
          }} />
      ) : (
        <div className="row"><Button kind="primary" disabled={busy} onClick={() => setAdding(true)}>Add a mailbox</Button></div>
      )}
      {problem && <div className="dim">{problem}</div>}
      {list.spaces.length > 0 && (
        <>
          <span className="caps">Spaces send from</span>
          <Board>
            {list.spaces.map((space) => (
              <BoardRow key={space.id} time={null} title={space.name} word="" tone="ink" machine={machine} keepActions
                actions={
                  <select className="entry" value={space.box} disabled={busy} aria-label={`${space.name} sends from`}
                    onChange={(e) => void run(() => api.setSpaceMailbox(machine, space.id, e.target.value))}>
                    {choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                    {!choices.some((c) => c.id === space.box) && <option value={space.box}>a removed mailbox</option>}
                  </select>
                } />
            ))}
          </Board>
        </>
      )}
      {busy && <Spinner />}
      {removing && (
        <Confirm
          title={`Remove ${removing.address} from ${computer}?`}
          body="The computer forgets its app password. Email already sent stays in its Sent folder."
          yes="Remove"
          danger
          onYes={() => void run(() => api.removeMailbox(machine, removing.id))}
          onClose={() => setRemoving(null)}
        />
      )}
    </Group>
  );
}

function AddBox({ list, busy, onAdd, onCancel }: { list: MailboxList; busy: boolean; onAdd: (form: { provider: string; address: string; user?: string; password: string; region?: string }) => Promise<void>; onCancel: () => void }) {
  const [provider, setProvider] = useState("icloud");
  const [address, setAddress] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [region, setRegion] = useState("com");
  const [problem, setProblem] = useState<string | null>(null);
  const submit = () => {
    const wrong = addBoxProblem({ provider, address, password });
    if (wrong) return setProblem(wrong);
    setProblem(null);
    void onAdd({ provider, address: address.trim(), password, ...(user.trim() ? { user: user.trim() } : {}), ...(provider === "zoho" ? { region } : {}) });
  };
  return (
    <div className="col" style={{ gap: 6 }}>
      <Toggles options={list.providers.map((p) => ({ key: p.id, label: p.name }))} active={provider} onPick={setProvider} />
      <div className="dim">{list.providers.find((p) => p.id === provider)?.help}</div>
      <input className="entry" placeholder="Address it sends from" value={address} autoComplete="off" spellCheck={false} disabled={busy} onChange={(e) => setAddress(e.target.value)} />
      {provider === "icloud" ? (
        <input className="entry" placeholder="iCloud address to log in with (if different)" value={user} autoComplete="off" spellCheck={false} disabled={busy} onChange={(e) => setUser(e.target.value)} />
      ) : (
        <Toggles options={list.regions.map((r) => ({ key: r, label: `.${r}` }))} active={region} onPick={setRegion} />
      )}
      <input className="entry" type="password" placeholder="App password" value={password} autoComplete="new-password" disabled={busy} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      {problem && <div className="dim">{problem}</div>}
      <div className="row wrap">
        <Button kind="primary" disabled={busy} onClick={submit}>{busy ? "Checking…" : "Check and add"}</Button>
        <Button kind="flat" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
