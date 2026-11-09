import type { ForemanTemplateId } from "./projects.ts";

/**
 * The trades Cobra ships, as a zod-free module: the agent runs this file
 * (apps/agent/src/agent/trades.ts imports it by relative path and package.sh
 * ships it beside crew.ts and sessionNames.ts), so nothing here may import
 * zod or another package. The apps import the same names through index.ts.
 */
export type ForemanTemplateInfo = {
  id: ForemanTemplateId;
  name: string;
  summary: string;
};

/** The trades Cobra ships, as the apps and the Lead list them. */
export const FOREMAN_TEMPLATES: readonly ForemanTemplateInfo[] = [
  { id: "website-builder", name: "Website Builder", summary: "Keeps your website in your own Cloudflare account; a change goes live only when you allow it." },
  { id: "payroll-manager", name: "Payroll Manager", summary: "Prepares each pay run, checks the totals and proposes the pay stubs; never moves money or files payroll." },
  { id: "lead-outreach", name: "Lead Outreach", summary: "Builds a respectful outreach pipeline and drafts messages; never contacts people without approval." },
  { id: "billing", name: "Billing", summary: "Prepares invoices, receipts and reminders and proposes them for sending; never takes a payment." },
  { id: "my-day", name: "My day", summary: "Sorts the day from your calendar and proposes a plan; never changes an event." },
  { id: "inbox", name: "Inbox", summary: "Sorts your mail and proposes what to archive, label or trash, a batch at a time; nothing is deleted for good." },
  { id: "sign-ups", name: "Sign-ups", summary: "Keeps rosters and sign-up sheets and proposes confirmations; never changes a record on its own." },
  { id: "projects", name: "Projects", summary: "Tracks dates and what gates what, and proposes the next steps; never commits anyone." },
  { id: "outreach", name: "Outreach", summary: "Writes a Space's messages to the world in its own voice, as drafts you approve; never sends anything itself." },
  { id: "people", name: "People", summary: "Keeps everyone you deal with: who they are, what was said and who to contact next; never contacts anyone itself." },
  { id: "money", name: "Money", summary: "Keeps a Space's books: what is owed, what was spent and what moved through the bank; proposes, never moves money." },
  { id: "designer", name: "Designer", summary: "Designs social posts and flyers in your brand and shows you options to save; never posts anything itself." },
];

/** The trade an id names, or null for one this build does not know: the apps then draw a plain Foreman. */
export function templateInfo(id: string | null | undefined): ForemanTemplateInfo | null {
  if (!id) return null;
  return FOREMAN_TEMPLATES.find((item) => item.id === id) ?? null;
}

/** Whether an id is a trade this build ships; the agent's create routes accept exactly these. */
export function knownTemplate(id: unknown): id is ForemanTemplateId {
  return typeof id === "string" && FOREMAN_TEMPLATES.some((item) => item.id === id);
}
