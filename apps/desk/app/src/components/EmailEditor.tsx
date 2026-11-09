import { useEffect, useState } from "react";

import * as api from "../lib/api";
import { asTemplate, blankTemplate, KIND_FIELDS, KIND_WORDS, moveBlock, newBlock, readData, removeBlock, setField, slugOf, type Block, type Template } from "../lib/emailEditor";
import { LEAD_NAME } from "../lib/appName.ts";
import { PreviewFrame } from "./PreviewFrame.tsx";

type Listed = { space: { id: string; name: string }; templates: { slug: string; name: string; kind: string; versions: number[]; draft?: unknown }[]; images: string[]; blockKinds: string[]; starters: { id: string; name: string; describe: string }[] };
type Drawn = { subject?: string; html?: string; errors: string[]; warnings?: string[] };
type Open = { slug: string; template: Template; isNew: boolean };

/**
 * The Space's branded email block editor. Pick a template or a starter; move
 * blocks, change their words, pick pictures from the Space's email/images;
 * the right side draws it with sample values as you go. Ask to keep it makes
 * the same template card a Foreman's would, which you allow. Nothing here
 * sends an email.
 */
export function EmailEditorDialog({ machine, project, onClose }: { machine: string; project: string; onClose: () => void }) {
  const [listed, setListed] = useState<Listed | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .emailTemplates(machine, project)
      .then((got) => live && setListed(got as Listed))
      .catch((caught: unknown) => live && setError(caught instanceof Error ? caught.message : String(caught)));
    return () => {
      live = false;
    };
  }, [machine, project]);

  const load = async (from: { slug: string } | { starter: string }) => {
    setError(null);
    try {
      const got = (await api.emailTemplate(machine, project, from)) as { template: unknown };
      const template = asTemplate(got.template);
      if (!template && typeof (got.template as { html?: unknown } | null)?.html === "string") return setError(`That is a designed email, written as its own HTML: ask ${LEAD_NAME} to change it.`);
      if (!template) return setError("That template could not be read.");
      setOpen({ slug: "slug" in from ? from.slug : slugOf(template.name), template, isNew: !("slug" in from) });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog email-editor" role="dialog" aria-label="Email templates" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <div className="grow">
            <h2>{open ? open.template.name : `Email for ${listed?.space.name ?? "this Space"}`}</h2>
            <div className="dim">{open ? `${open.template.kind}${open.isNew ? " · new" : ` · ${open.slug}`}` : "Branded templates. Each change is a card you allow before it is used."}</div>
          </div>
          {open && <button className="linkish" onClick={() => (setOpen(null), setDone(null))}>‹ Templates</button>}
          <button className="linkish" onClick={onClose}>Done</button>
        </div>
        {error && <p className="dim">{error}</p>}
        {done && <p className="dim">{done}</p>}
        {!listed ? (
          !error && <p className="dim">Reading the templates…</p>
        ) : open ? (
          <Editor machine={machine} project={project} images={listed.images} kinds={listed.blockKinds} open={open} onChange={setOpen} onProposed={(words) => (setDone(words), setOpen(null))} />
        ) : (
          <Picker listed={listed} onPick={load} onBlank={(kind) => setOpen({ slug: "new-email", template: blankTemplate(kind), isNew: true })} />
        )}
      </div>
    </div>
  );
}

function Picker({ listed, onPick, onBlank }: { listed: Listed; onPick: (from: { slug: string } | { starter: string }) => void; onBlank: (kind: "transactional" | "marketing") => void }) {
  return (
    <div className="email-picker">
      <h3>Templates</h3>
      {listed.templates.length === 0 && <p className="dim">None yet.</p>}
      {listed.templates.map((t) => (
        <button key={t.slug} className="email-pick" onClick={() => onPick({ slug: t.slug })}>
          <strong>{t.name}</strong>
          <span className="dim">
            {t.kind} · {t.versions.length ? `v${t.versions.at(-1)}` : "not allowed yet"}
            {t.draft ? " · has a draft" : ""}
          </span>
        </button>
      ))}
      <h3>Start from</h3>
      {listed.starters.map((s) => (
        <button key={s.id} className="email-pick" onClick={() => onPick({ starter: s.id })}>
          <strong>{s.name}</strong>
          <span className="dim">{s.describe}</span>
        </button>
      ))}
      <div className="buttons">
        <button className="btn small" onClick={() => onBlank("transactional")}>Blank (one person)</button>
        <button className="btn small" onClick={() => onBlank("marketing")}>Blank (marketing)</button>
      </div>
    </div>
  );
}

function Editor({ machine, project, images, kinds, open, onChange, onProposed }: { machine: string; project: string; images: string[]; kinds: string[]; open: Open; onChange: (open: Open) => void; onProposed: (words: string) => void }) {
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  const [adding, setAdding] = useState("text");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const t = open.template;
  // A stable key per block, so a moved block keeps its own half-typed fields.
  const [ids, setIds] = useState<number[]>(() => t.blocks.map((_, i) => i));
  const [nextId, setNextId] = useState(t.blocks.length);

  // A live draw, a moment after the last change.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      api
        .drawEmailTemplate(machine, project, t)
        .then((got) => live && setDrawn(got as Drawn))
        .catch((caught: unknown) => live && setDrawn({ errors: [caught instanceof Error ? caught.message : String(caught)] }));
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [machine, project, t]);

  const set = (template: Partial<Template>) => onChange({ ...open, template: { ...t, ...template } });
  const setBlocks = (blocks: Block[]) => set({ blocks });
  const add = () => {
    const block = newBlock(adding, images);
    if (!block) return setProblem(`Add a picture to the Space's email/images first (ask ${LEAD_NAME}).`);
    setProblem(null);
    setIds([...ids, nextId]);
    setNextId(nextId + 1);
    setBlocks([...t.blocks, block]);
  };
  const move = (i: number, by: 1 | -1) => {
    setIds(moveBlock(ids.map((id) => ({ kind: "", id })), i, by).map((b) => b.id as number));
    setBlocks(moveBlock(t.blocks, i, by));
  };
  const remove = (i: number) => {
    setIds(ids.filter((_, j) => j !== i));
    setBlocks(removeBlock(t.blocks, i));
  };
  const propose = async () => {
    const slug = open.isNew ? slugOf(t.name) : open.slug;
    if (!slug) return setProblem("Give it a name.");
    setSaving(true);
    setProblem(null);
    try {
      await api.proposeEmailTemplate(machine, project, slug, t);
      onProposed(`"${t.name}" is a card now. Allow it there and it can be used.`);
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="email-editor-body">
      <div className="email-blocks">
        <label className="email-field">
          Name
          <input className="entry" value={t.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="email-field">
          Subject
          <input className="entry" value={t.subject} onChange={(e) => set({ subject: e.target.value })} />
        </label>
        <label className="email-field">
          Preview line
          <input className="entry" value={t.preheader ?? ""} onChange={(e) => set({ preheader: e.target.value || undefined })} />
        </label>
        {t.blocks.map((block, i) => (
          <div key={ids[i] ?? `x${i}`} className="email-block">
            <div className="row">
              <strong className="grow">{KIND_WORDS[block.kind] ?? block.kind}</strong>
              <button className="btn icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
              <button className="btn icon" disabled={i === t.blocks.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
              <button className="btn icon" onClick={() => remove(i)} aria-label="Remove">×</button>
            </div>
            {(KIND_FIELDS[block.kind] ?? []).map(([name, kind]) => (
              <BlockField key={name} name={name} kind={kind} block={block} images={images} onChange={(next) => setBlocks(t.blocks.map((b, j) => (j === i ? next : b)))} />
            ))}
          </div>
        ))}
        <div className="row">
          <select className="entry grow" value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Block to add">
            {kinds.map((k) => (
              <option key={k} value={k}>
                {KIND_WORDS[k] ?? k}
              </option>
            ))}
          </select>
          <button className="btn small" onClick={add}>Add</button>
        </div>
        {problem && <p className="dim">{problem}</p>}
        <div className="buttons">
          <button className="btn primary" disabled={saving || !!drawn?.errors.length} onClick={() => void propose()}>
            {saving ? "Asking…" : "Ask to keep it"}
          </button>
        </div>
      </div>
      <div className="email-live">
        {!drawn ? (
          <p className="dim">Drawing it…</p>
        ) : drawn.errors.length ? (
          <ul className="dim">
            {drawn.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : (
          <>
            <div className="dim">
              {drawn.subject}
              {drawn.warnings?.length ? ` · ${drawn.warnings.join("; ")}` : ""}
            </div>
            <PreviewFrame className="email-frame" title="Email" html={drawn.html ?? ""} />
          </>
        )}
      </div>
    </div>
  );
}

function BlockField({ name, kind, block, images, onChange }: { name: string; kind: string; block: Block; images: string[]; onChange: (block: Block) => void }) {
  const value = block[name];
  const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 1)));
  const [wrong, setWrong] = useState<string | null>(null);
  const label = name[0]!.toUpperCase() + name.slice(1);
  switch (kind) {
    case "toggle":
      return (
        <label className="email-field">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(setField(block, name, e.target.checked))} /> {label}
        </label>
      );
    case "align":
      return (
        <label className="email-field">
          {label}
          <select className="entry" value={typeof value === "string" ? value : "left"} onChange={(e) => onChange(setField(block, name, e.target.value === "left" ? "" : e.target.value))}>
            <option value="left">Left</option>
            <option value="center">Centre</option>
          </select>
        </label>
      );
    case "image": {
      const image = (value ?? {}) as { src?: string; alt?: string };
      return (
        <div className="email-field">
          Picture
          <select className="entry" value={image.src?.replace(/^images\//, "") ?? ""} onChange={(e) => onChange(setField(block, name, e.target.value ? { src: `images/${e.target.value}`, alt: image.alt ?? "" } : null))}>
            {block.kind === "product" && <option value="">None</option>}
            {images.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          {image.src && <input className="entry" placeholder="What it shows (for people who cannot see it)" value={image.alt ?? ""} onChange={(e) => onChange(setField(block, name, { src: image.src, alt: e.target.value }))} />}
        </div>
      );
    }
    case "words":
      return (
        <label className="email-field">
          {label}
          <textarea className="entry" rows={4} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(setField(block, name, e.target.value))} />
        </label>
      );
    case "data":
      return (
        <label className="email-field">
          {label} (JSON)
          <textarea
            className="entry mono"
            rows={4}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              const read = readData(e.target.value);
              setWrong(read.ok ? null : read.why);
              if (read.ok) onChange(setField(block, name, read.value));
            }}
          />
          {wrong && <span className="dim">{wrong}</span>}
        </label>
      );
    default:
      return (
        <label className="email-field">
          {label}
          <input className="entry" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(setField(block, name, e.target.value))} />
        </label>
      );
  }
}
