/**
 * A Foreman that needs you, on its Space's screen (design docs/cobra-space-screen.tessel.json frame 05):
 * the context line (who asks, and the routine run that waits) with Exact ▸, the headline, the plain
 * words, and the answer across its foot. A permission prompt is Deny or Allow here (the same call as the
 * popup's and the chat's, bound to the prompt on screen: a 409 says another replaced it); anything else
 * (a question, a trust or model dialog) is Answer, which opens its conversation.
 */
import { useState } from "react";
import { useApp } from "../app/context.ts";
import type { Seat } from "../lib/org.ts";
import { Button } from "./ui.tsx";

/** `context` is the top line (the skill, or the Foreman with the crew shown, and the routine run that waits);
 * without it, `who`, else the Foreman's name and role. */
export function NeedsCard({ seat, role, who, context }: { seat: Seat; role: string; who?: string; context?: string }) {
  const app = useApp();
  const [exact, setExact] = useState(false);
  const row = seat.needing;
  if (!row) return null;
  const permission = row.dialog === "permission";
  const request = row.request;
  const words = request?.headline ?? (row.dialog === "trust" ? "Asks whether to trust its folder" : "Waiting on your answer");
  const open = () => app.openChat(row.machine, row.session);
  return (
    <div className="needs-card">
      <div className="needs-card-top">
        <span className="grow">{context ?? who ?? `${seat.name} · ${role}`}</span>
        {permission && request?.exact && <button className="linkish" onClick={() => setExact(!exact)}>{exact ? "Exact ▾" : "Exact ▸"}</button>}
      </div>
      <b className="needs-card-title">{words}</b>
      {permission && request?.plain && <div className="needs-card-plain">{request.plain}</div>}
      {permission && request?.why && <div className="dim">{request.why}</div>}
      {exact && request?.exact && <pre className="req-exact">{request.exact}</pre>}
      <div className="needs-card-buttons">
        {permission ? (
          <>
            <Button onClick={() => void app.actions.deny(row)}>Deny</Button>
            <Button kind="primary" onClick={() => void app.actions.allow(row)}>Allow</Button>
          </>
        ) : (
          <Button kind="primary" onClick={open}>Answer</Button>
        )}
      </div>
    </div>
  );
}
