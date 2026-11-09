/**
 * The desk's email block editor: the
 * template as plain data, edited block by block. Pure: the component draws
 * it, the agent checks and draws it (POST /email/template/draw) and makes the
 * template card (POST /email/template/propose).
 */

export type Block = { kind: string; [key: string]: unknown };
export type Template = { version: 1; name: string; kind: string; topic?: string; subject: string; preheader?: string; fields?: Record<string, unknown>; blocks: Block[] };

/** How a block's field is edited. */
export type FieldKind = "line" | "words" | "image" | "align" | "toggle" | "data";

/** Each kind's fields, in the order the editor shows them (contracts emailTemplate.ts). */
export const KIND_FIELDS: Readonly<Record<string, readonly [string, FieldKind][]>> = {
  header: [["text", "line"], ["logo", "toggle"]],
  hero: [["image", "image"], ["href", "line"]],
  text: [["heading", "line"], ["body", "words"], ["align", "align"]],
  button: [["label", "line"], ["href", "line"], ["align", "align"]],
  image: [["image", "image"], ["href", "line"], ["caption", "line"], ["align", "align"]],
  columns: [["items", "data"]],
  product: [["name", "line"], ["image", "image"], ["price", "line"], ["body", "words"], ["button", "data"]],
  details: [["heading", "line"], ["rows", "data"]],
  receipt: [["heading", "line"], ["rows", "line"], ["total", "line"], ["note", "line"]],
  divider: [],
  signature: [["name", "line"], ["role", "line"], ["body", "words"]],
  footer: [["text", "line"]],
};

/** The words a person reads for a block kind. */
export const KIND_WORDS: Readonly<Record<string, string>> = {
  header: "Header",
  hero: "Large picture",
  text: "Text",
  button: "Button",
  image: "Picture",
  columns: "Columns",
  product: "Product",
  details: "Details",
  receipt: "Receipt lines",
  divider: "Line",
  signature: "Signature",
  footer: "Footer",
};

/** A new block of a kind, filled enough to draw; null for a picture block when the Space has no images. */
export function newBlock(kind: string, images: readonly string[]): Block | null {
  const image = images[0] ? { src: `images/${images[0]}`, alt: "" } : null;
  switch (kind) {
    case "hero":
      return image ? { kind, image } : null;
    case "image":
      return image ? { kind, image } : null;
    case "text":
      return { kind, body: "Your words here." };
    case "button":
      return { kind, label: "Book now", href: "https://example.com/" };
    case "columns":
      return { kind, items: [{ heading: "One", body: "Words." }, { heading: "Two", body: "Words." }] };
    case "product":
      return { kind, name: "Product" };
    case "details":
      return { kind, rows: [{ label: "When", value: "{date}" }] };
    case "receipt":
      return { kind, rows: "items", total: "{total}" };
    case "signature":
      return { kind, name: "Your name" };
    default:
      return KIND_FIELDS[kind] ? { kind } : null;
  }
}

/** The blocks with one moved up (-1) or down (1); unchanged at either end. */
export function moveBlock(blocks: readonly Block[], index: number, by: 1 | -1): Block[] {
  const to = index + by;
  if (index < 0 || index >= blocks.length || to < 0 || to >= blocks.length) return [...blocks];
  const next = [...blocks];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

export function removeBlock(blocks: readonly Block[], index: number): Block[] {
  return blocks.filter((_, i) => i !== index);
}

/** A block with one field set; empty text, false or null takes the field away. */
export function setField(block: Block, name: string, value: unknown): Block {
  const next: Block = { ...block };
  if (value === "" || value === null || value === undefined || value === false) delete next[name];
  else next[name] = value;
  return next;
}

/** A data field's JSON, read back: the value, or why it is not JSON. */
export function readData(text: string): { ok: true; value: unknown } | { ok: false; why: string } {
  if (!text.trim()) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (caught) {
    return { ok: false, why: caught instanceof Error ? caught.message : "not JSON" };
  }
}

/** A slug from a name, as the agent's slugs are (lowercase letters, digits and dashes, at most 48). */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

/** A template the editor reads from the agent, or null when it is not one. */
export function asTemplate(value: unknown): Template | null {
  const t = value as Template | null;
  return t && typeof t === "object" && typeof t.name === "string" && Array.isArray(t.blocks) ? t : null;
}

/** An empty template to start from. */
export function blankTemplate(kind: "transactional" | "marketing"): Template {
  return { version: 1, name: "New email", kind, subject: "Hello {first_name}", blocks: [{ kind: "header" }, { kind: "text", body: "Your words here." }, { kind: "footer" }] };
}
