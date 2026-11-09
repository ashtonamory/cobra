import { useEffect, useState } from "react";

import * as api from "../lib/api";
import { copyHeading, copyNote, copyWordsProblem, emailPreviewNote, stepCopy, type BatchCopy } from "../lib/email";
import { PreviewFrame } from "./PreviewFrame.tsx";

type Preview = { subject: string; html: string; text: string; sample: boolean; copy?: BatchCopy };

/**
 * A branded email card's email (agent GET /email/preview), drawn in a frame
 * with no scripts and nowhere to go: its links do nothing here. An outreach
 * batch's card (phase 5) shows one copy at a time with ‹ ›, a tick for whether
 * it goes and Change the words (POST /email/batch), all before Allow. The
 * phone's app/email/[id].tsx draws the same: change both together.
 */
export function EmailPreviewDialog({ machine, approval, onClose }: { machine: string; approval: string; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ subject: string; body: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setError(null);
    api
      .emailPreview(machine, approval, index)
      .then((got) => live && setPreview(got as Preview))
      .catch((caught: unknown) => live && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => {
      live = false;
    };
  }, [machine, approval, index]);

  const copy = preview?.copy;
  const go = (by: 1 | -1) => {
    const next = copy ? stepCopy(copy.index, copy.count, by) : null;
    if (next === null) return;
    setEditing(null);
    setProblem(null);
    setPreview(null);
    setIndex(next);
  };
  const change = async (what: { send: boolean } | { subject: string; body: string }) => {
    if (!copy) return;
    setSaving(true);
    setProblem(null);
    try {
      setPreview((await api.editBatchCopy(machine, approval, copy.index, what)) as Preview);
      setEditing(null);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };
  const save = () => {
    if (!editing) return;
    const wrong = copyWordsProblem(editing.subject, editing.body);
    if (wrong) return setProblem(wrong);
    void change(editing);
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog email-dialog" role="dialog" aria-label="Email" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <div className="grow">
            <h2>{copy ? copyHeading(copy) : (preview?.subject ?? "Email")}</h2>
            {preview && <div className="dim">{copy ? `${preview.subject} · to ${copy.to}. ${copyNote(copy)}` : emailPreviewNote(preview.sample)}</div>}
          </div>
          {copy && (
            <>
              <button className="btn icon" onClick={() => go(-1)} disabled={stepCopy(copy.index, copy.count, -1) === null} aria-label="The copy before">‹</button>
              <button className="btn icon" onClick={() => go(1)} disabled={stepCopy(copy.index, copy.count, 1) === null} aria-label="The next copy">›</button>
            </>
          )}
          <button className="linkish" onClick={onClose}>Done</button>
        </div>
        {copy && !editing && (
          <div className="row">
            <label className="grow">
              <input type="checkbox" checked={copy.send} disabled={saving} onChange={(e) => void change({ send: e.target.checked })} /> Send this one
            </label>
            <button className="btn small" disabled={saving} onClick={() => setEditing({ subject: copy.subject, body: copy.body })}>Change the words</button>
          </div>
        )}
        {problem && <p className="dim">{problem}</p>}
        {error ? (
          <p className="dim">The email could not be drawn: {error}</p>
        ) : !preview ? (
          <p className="dim">Drawing it…</p>
        ) : editing ? (
          <>
            <input className="entry" value={editing.subject} maxLength={150} aria-label="Subject" onChange={(e) => setEditing({ ...editing, subject: e.target.value })} />
            <textarea className="entry grow" rows={14} value={editing.body} maxLength={4000} aria-label="Words" onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
            <div className="buttons">
              <button className="btn flat" disabled={saving} onClick={() => (setEditing(null), setProblem(null))}>Cancel</button>
              <button className="btn primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </>
        ) : (
          <PreviewFrame className="email-frame" title="Email" html={preview.html} />
        )}
      </div>
    </div>
  );
}
