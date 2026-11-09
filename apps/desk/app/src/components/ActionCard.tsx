/**
 * A Foreman's action, drawn wherever approvals are (Ops, the needs-you popup): exactly what Allow
 * sends. An email's To, Cc and Subject, its text (folded when long) and attachments; a file
 * action's destination (your Google Drive's Cobra/<project>, or a local folder) and its files; a
 * note's text and attachments. A routine approval is drawn the same way: when, the first run and
 * the project, then its brief (lib/routines.ts); a trust approval too: who it reaches, the templates,
 * how often you allowed it, then the cards it was (lib/trust.ts). The words are lib/approvalAction.ts's;
 * the buttons stay the approval's own (Allow and Deny; Trust and Keep asking).
 */
import type { ActionView } from "../lib/approvalAction.ts";
import { allowLine } from "../lib/approvalAction.ts";
import { cls } from "./ui.tsx";
import "../styles/action.css";

export function ActionCard({ view, compact }: { view: ActionView; compact?: boolean }) {
  const label = view.channel === "email" ? "Message" : view.channel === "note" ? "Note" : view.channel === "routine" ? "Brief"
    : view.channel === "trust" ? "The cards it was" : "Note from the Foreman";
  return (
    <div className={cls("action-card", compact && "compact")} onClick={(e) => e.stopPropagation()}>
      {view.fields.length > 0 && (
        <div className="action-fields">
          {view.fields.map(([k, v]) => (
            <div key={k} className="action-field">
              <span className="caps">{k}</span>
              <span className="selectable action-value">{v}</span>
            </div>
          ))}
        </div>
      )}
      {view.text && (view.folded ? (
        <details className="action-text">
          <summary>
            <span className="caps">{label}</span> <span className="action-preview">{view.preview}</span>
          </summary>
          <div className="action-body selectable">{view.text}</div>
        </details>
      ) : (
        <div className="action-text">
          <span className="caps">{label}</span>
          <div className="action-body selectable">{view.text}</div>
        </div>
      ))}
      {view.files.length > 0 && (
        <div className="action-files">
          <span className="caps">{`${view.filesLabel} · ${view.files.length}`}</span>
          {view.files.map((f) => (
            <div key={f.path || f.name} className="action-file" title={f.path || undefined}>
              <span className="mono ellipsis grow">{f.name}</span>
              <span className="dim">{f.size}</span>
            </div>
          ))}
        </div>
      )}
      <div className="dim">{allowLine(view)}</div>
    </div>
  );
}
