import { z } from "zod";

/**
 * The person's mailboxes as the desk read them (agent
 * mailboxRoutes.ts): iCloud and Zoho
 * boxes added on a computer, never with their passwords, and the box each of
 * its Spaces sends from (NO_BOX when it names none). The words both apps
 * show are here, so they say the same.
 */

/** A Space's choice when it names no mailbox: it sends no email until it names one. */
export const NO_BOX = "none";

export const Mailbox = z.object({ id: z.string(), provider: z.string(), address: z.string(), user: z.string(), addedAt: z.string(), spaces: z.array(z.string()) });
export type Mailbox = z.infer<typeof Mailbox>;

export const MailboxList = z.object({
  boxes: z.array(Mailbox),
  providers: z.array(z.object({ id: z.string(), name: z.string(), help: z.string() })),
  regions: z.array(z.string()),
  spaces: z.array(z.object({ id: z.string(), name: z.string(), box: z.string() })),
});
export type MailboxList = z.infer<typeof MailboxList>;

export const MAILBOXES_BLURB =
  "A Space sends email from the mailbox you choose for it here. Add an iCloud or Zoho mailbox with an app password: it stays on this computer, and Cobra logs in to check it before keeping it. Gmail and Outlook are not here: for Gmail, add its connector under Integrations.";

/** What a Space's choice reads as: "No mailbox", or the box's address. */
export function boxWord(list: MailboxList, box: string): string {
  if (box === NO_BOX) return "No mailbox";
  return list.boxes.find((b) => b.id === box)?.address ?? "a removed mailbox";
}

/** The choices for a Space, "No mailbox" first. */
export function boxChoices(list: MailboxList): { id: string; label: string }[] {
  return [{ id: NO_BOX, label: "No mailbox" }, ...list.boxes.map((box) => ({ id: box.id, label: `${box.address} (${list.providers.find((p) => p.id === box.provider)?.name ?? box.provider})` }))];
}

/** What is wrong with the add form before it is sent, or null. */
export function addBoxProblem(form: { provider: string; address: string; password: string }): string | null {
  if (!form.provider) return "Choose iCloud Mail or Zoho Mail.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.address.trim())) return "Type the address the email goes from.";
  if (!form.password) return "Paste the app password.";
  return null;
}

/** The line under a box: which Spaces send from it. */
export function boxSpacesLine(list: MailboxList, box: Mailbox): string {
  const names = box.spaces.map((id) => list.spaces.find((s) => s.id === id)?.name ?? id);
  return names.length ? `Sends for ${names.join(", ")}` : "No Space sends from it yet";
}
