import { z } from "zod";

import { ApprovalRoutine } from "./routines.ts";
import { DesignFile } from "./thread.ts";
import { ApprovalTrade } from "./tradeDefine.ts";
import { ApprovalTrust, ApprovalTrusted, TrustAsk, TrustGrant } from "./trust.ts";

import { McpEntry, McpPin } from "./mcp.ts";

/**
 * Approvals: something an orchestrator asked for that only you may allow
 * (agent approvals.ts), such as a merge of Workers' PRs. The agent pushes each one with Allow and Deny,
 * Today lists the ones waiting, and only a phone or desktop key may answer.
 *
 * Strings where a list of values would be tempting (kind, state): an enum
 * here could never grow while an older app is in the field.
 */

export const ApprovalPr = z.object({
  number: z.number().int(),
  title: z.string(),
  /** The repository on GitHub, owner/name. */
  repo: z.string(),
  /** The head commit you are shown; the merge is refused if the PR moved on. */
  head: z.string(),
  url: z.string(),
  /** The Worker whose PR it is. */
  worker: z.string().optional(),
});
export type ApprovalPr = z.infer<typeof ApprovalPr>;

/**
 * A Worker's branch to land into main on this computer, in a project with no
 * remote (agent landing.ts): squashed into one commit, nothing pushed.
 */
export const ApprovalLand = z.object({
  worker: z.string(),
  /** The project id on this computer. */
  project: z.string(),
  branch: z.string(),
  /** The squash commit's subject. */
  title: z.string(),
  /** The tip you are shown; Allow lands exactly this commit. */
  head: z.string(),
  /** Main as you were shown it; Allow refuses if main moved. */
  base: z.string(),
  commits: z.number().int(),
  files: z.number().int(),
  insertions: z.number().int(),
  deletions: z.number().int(),
});
export type ApprovalLand = z.infer<typeof ApprovalLand>;

/**
 * One task of a Foreman's plan (agent plans.ts), routed: the model the router picked and why, the runner-up, and
 * every model that could run it, which the person may choose instead.
 */
export const PlanTask = z.object({
  id: z.string(),
  title: z.string(),
  task: z.string(),
  /** tests, docs, bugfix, refactor, feature, ui, infra, security. A string, so a new kind never fails an older app. */
  kind: z.string(),
  size: z.string(),
  /** What it will start on: the router's pick, the Foreman's choice, or yours. */
  model: z.string(),
  pick: z.string().nullable(),
  runnerUp: z.string().nullable(),
  reason: z.string(),
  /** Another engine reviews its work before its PR (phase 3), by `reviewer`. */
  review: z.boolean(),
  reviewer: z.string().nullable().optional(),
  /** The models that can run it here, best first. */
  options: z.array(z.string()),
  /** Task ids whose PRs merge before this one starts. */
  after: z.array(z.string()).optional(),
  /** Planner → doer (phase 4): this task's Worker only plans (PLAN.md and failing tests); this model then implements it on the same branch. */
  doer: z.string().optional(),
  /** A research goal for its Worker's web reads (agent webRuns.ts), judged against the task at its first read. */
  research: z.string().optional(),
  /** Once allowed: the Worker it became, or the queue item it waits as, or why it could not start. */
  worker: z.string().optional(),
  queued: z.string().optional(),
  error: z.string().optional(),
});
export type PlanTask = z.infer<typeof PlanTask>;

export const ApprovalPlan = z.object({
  project: z.string(),
  projectName: z.string(),
  summary: z.string().optional(),
  tasks: z.array(PlanTask),
});
export type ApprovalPlan = z.infer<typeof ApprovalPlan>;

/**
 * An action in the world a Foreman proposed and only you may allow (agent
 * actions.ts): an email, files copied
 * to a folder you chose, or a note that leaves nothing. The content here is
 * exactly what the card shows and exactly what the agent carries out after
 * Allow; a changed draft is a new approval.
 */
export const ApprovalActionAttachment = z.object({
  /** Repository-relative; the agent reads it at send time and refuses one that moved out. */
  path: z.string(),
  name: z.string(),
  bytes: z.number().int(),
  /** Of the file's bytes when the card was made; Allow refuses a file whose bytes changed since. */
  sha256: z.string(),
});
export type ApprovalActionAttachment = z.infer<typeof ApprovalActionAttachment>;

export const ApprovalAction = z.object({
  /** email, file, note or mailbox. A string, so a new channel never fails an older app: it shows as a plain approval with its title and body. */
  channel: z.string(),
  /** The project whose Foreman proposed it, on this computer. */
  project: z.string(),
  projectName: z.string(),
  /** One line for the card and the push. */
  summary: z.string(),
  email: z
    .object({
      to: z.array(z.string()),
      cc: z.array(z.string()).optional(),
      subject: z.string(),
      text: z.string(),
      attachments: z.array(ApprovalActionAttachment).optional(),
      /** The Space's own mailbox (agent mailboxes.ts) it goes from, frozen when proposed; absent, the person's Gmail. */
      from: z.object({ box: z.string(), address: z.string(), mailbox: z.string() }).optional(),
    })
    .optional(),
  /** Channel file: repository files copied, after Allow, into a folder the person chose in files.json (agent files.ts `exports`). */
  files: z
    .object({
      /** The export folder's key in files.json; Allow refuses if it is gone. */
      to: z.string(),
      /** Its label, for the card. */
      label: z.string(),
      /** Its absolute path when the card was made, so the card says where the files land; Allow refuses if it changed since. */
      path: z.string(),
      /** The files, hashed when the card was made and checked again at copy time. */
      items: z.array(ApprovalActionAttachment),
      /** A short note for the card, if the Foreman wrote one. */
      text: z.string().optional(),
    })
    .optional(),
  /** A note leaves nothing; its attachments are files on the computer the person can open from the card. */
  note: z.object({ text: z.string(), attachments: z.array(ApprovalActionAttachment).optional() }).optional(),
  /**
   * Channel mailbox: one operation on a frozen batch of the person's Gmail
   * messages (agent gmailOrganize.ts). `ids` are exactly the messages Allow
   * changes, worked out when the card was made and never searched for again;
   * the rest is what the card shows, counted by the agent from Gmail's own
   * metadata, never written by a model.
   */
  /**
   * Channel branded: one branded email from an
   * allowed template version, with the values the card showed. Allow queues
   * exactly this job; the agent on the Space home sends it. An app that does
   * not know the channel shows the card's title and body.
   */
  branded: z
    .object({
      space: z.string(),
      /** The template's slug and allowed version, with that version's hash. */
      template: z.string(),
      name: z.string(),
      version: z.number().int(),
      templateSha: z.string(),
      /** transactional (marketing comes with campaigns, phase 3). */
      emailKind: z.string(),
      to: z.string(),
      personId: z.number().int().optional(),
      subject: z.string(),
      values: z.record(z.string(), z.unknown()),
      /** The hash of the email as the card drew it. */
      sha256: z.string(),
      /** Every link with its real address (never a redirect). */
      links: z.array(z.object({ href: z.string(), label: z.string() })),
      /** Merge fields with no value: drawn empty. */
      missing: z.array(z.string()),
      /** The email's plain-text part as drawn, and the person's name in People: the card's words. */
      text: z.string().optional(),
      personName: z.string().optional(),
    })
    .optional(),
  /**
   * Channel campaign: one marketing
   * template version to everyone in a topic (and segment) when Allow is
   * given, from the send time. Never trusted. Allow makes one job each for
   * the audience as it is then; each is checked again right before it goes.
   */
  campaign: z
    .object({
      space: z.string(),
      template: z.string(),
      name: z.string(),
      /** The Space's campaign (People's campaigns id) its sends count for, on the Marketing board. */
      marketingCampaign: z.number().int().optional(),
      version: z.number().int(),
      templateSha: z.string(),
      topic: z.string(),
      /** The saved segment, when one narrows the topic. */
      segment: z.string().optional(),
      /** Values every copy shares (the template's own fields); People fills the rest per person. */
      values: z.record(z.string(), z.unknown()),
      /** When the first copy may go (ISO); the card expires then if sooner than its 3 days. */
      sendAt: z.string(),
      /** The audience when the card was drawn, and its hash (sorted addresses). */
      count: z.number().int(),
      audienceSha: z.string(),
      /** The daily cap and what was left of it when drawn, and the day the last copy should go (YYYY-MM-DD). */
      cap: z.number().int(),
      leftToday: z.number().int(),
      lastDay: z.string(),
      /** The website its links and unsubscribe page go through. */
      site: z.string(),
      /** A few copies as drawn: to whom and the subject; the first is the preview's. */
      samples: z.array(z.object({ to: z.string(), personName: z.string().optional(), subject: z.string() })),
      sampleValues: z.record(z.string(), z.unknown()),
      sha256: z.string(),
      links: z.array(z.object({ href: z.string(), label: z.string() })),
      missing: z.array(z.string()),
      text: z.string().optional(),
    })
    .optional(),
  /**
   * Channel sequence: an email sequence
   * the person allows once. Allow saves exactly this draft as its next version
   * and starts it; it then runs by itself, with a digest in the morning brief
   * and a pause on People's dashboard. Never trusted; a change asks again.
   */
  sequence: z
    .object({
      space: z.string(),
      slug: z.string(),
      name: z.string(),
      /** The version Allow writes, and the one it replaces, if any. */
      version: z.number().int(),
      previous: z.number().int().optional(),
      sha256: z.string(),
      /** What starts it, in words. */
      trigger: z.string(),
      steps: z.array(
        z.object({
          template: z.string(),
          name: z.string(),
          version: z.number().int(),
          /** transactional or marketing. */
          emailKind: z.string(),
          subject: z.string(),
          /** When, in words: "at once", "2 days later". */
          after: z.string(),
        }),
      ),
      /** Every link of every step, with its real address. */
      links: z.array(z.object({ href: z.string(), label: z.string() })),
      /** The website its links and unsubscribe page go through, when a step is marketing. */
      site: z.string().optional(),
      /** The first step's plain text, drawn with sample values. */
      text: z.string().optional(),
    })
    .optional(),
  /**
   * Channel batch: an outreach batch,
   * 1 to 50 emails each written for its person (Outreach drafts) on one
   * marketing template with no topic. The card keeps each copy's hash, never
   * its text; the person may untick a copy or change its words before Allow
   * (POST /email/batch), and Allow sends only copies whose drafts still hash
   * to what the card holds. Never trusted.
   */
  batch: z
    .object({
      space: z.string(),
      template: z.string(),
      name: z.string(),
      /** The Space's campaign (People's campaigns id) its sends count for, on the Marketing board. */
      marketingCampaign: z.number().int().optional(),
      version: z.number().int(),
      templateSha: z.string(),
      /** The template's own values every copy shares; subject and body are each copy's. */
      values: z.record(z.string(), z.unknown()),
      copies: z.array(
        z.object({
          draft: z.number().int(),
          personId: z.number().int(),
          to: z.string(),
          name: z.string(),
          subject: z.string(),
          /** sha256 of the draft's subject and body as the card holds them. */
          sha256: z.string(),
          /** Unticked by the person: not sent. */
          skip: z.boolean().optional(),
          /** Its words changed by the person. */
          edited: z.boolean().optional(),
        }),
      ),
      /** Drafts left off at proposal, and why. */
      left: z.array(z.object({ draft: z.number().int(), why: z.string() })),
      /** The website its links and unsubscribe page go through. */
      site: z.string(),
      links: z.array(z.object({ href: z.string(), label: z.string() })),
    })
    .optional(),
  mailbox: z
    .object({
      /** archive, unarchive, mark_read, mark_unread, star, unstar, label, unlabel, trash or untrash. */
      op: z.string(),
      /** label and unlabel: the label's name. */
      label: z.string().optional(),
      /** label: the label does not exist yet and Allow creates it. */
      newLabel: z.boolean().optional(),
      /** The Gmail search the messages came from, when they did. */
      query: z.string().optional(),
      ids: z.array(z.string()),
      /** How many messages the search or the ids found, the skipped ones included. */
      matched: z.number().int(),
      /** Found, but already as asked (alreadyDone), starred and so never trashed (starred), or gone (missing). */
      skipped: z.object({ alreadyDone: z.number().int(), starred: z.number().int(), missing: z.number().int() }),
      /** The search had more matches than this card holds: the newest were taken. */
      more: z.boolean(),
      /** The most frequent senders among `ids`. */
      senders: z.array(z.object({ from: z.string(), count: z.number().int() })),
      /** A few of the messages, for a look. */
      samples: z.array(z.object({ from: z.string(), subject: z.string() })),
      /** A Space's own mailbox (Settings → Mailboxes) the batch is in, over IMAP; absent for the person's Gmail. Allow changes this box and no other. */
      box: z.object({ id: z.string(), address: z.string(), mailbox: z.string() }).optional(),
    })
    .optional(),
});
export type ApprovalAction = z.infer<typeof ApprovalAction>;

/**
 * An email template version to save (kind `email_template`): Allow writes exactly the draft with this hash
 * as the next version of the Space's template. Sends name a version.
 */
export const ApprovalEmailTemplate = z.object({
  space: z.string(),
  /** The Foreman that proposed it. */
  project: z.string(),
  slug: z.string(),
  name: z.string(),
  /** transactional or marketing. */
  emailKind: z.string(),
  /** The version Allow writes, and the one it follows, if any. */
  version: z.number().int(),
  previous: z.number().int().optional(),
  sha256: z.string(),
  subject: z.string(),
  /** The merge fields it uses, People's first. */
  fields: z.array(z.string()),
  links: z.array(z.object({ href: z.string(), label: z.string() })),
  warnings: z.array(z.string()),
});
export type ApprovalEmailTemplate = z.infer<typeof ApprovalEmailTemplate>;

/** GET /email/preview?approval=: a card's email drawn for a WebView (images inline). `sample` when its values are made up. */
export const EmailPreview = z.object({
  subject: z.string(),
  html: z.string(),
  text: z.string(),
  sample: z.boolean(),
  /** An outreach batch's copy (phase 5): which one of how many, for whom, whether it goes, and its words to edit. */
  copy: z
    .object({ index: z.number().int(), count: z.number().int(), to: z.string(), name: z.string(), send: z.boolean(), edited: z.boolean(), subject: z.string(), body: z.string() })
    .optional(),
});
export type EmailPreview = z.infer<typeof EmailPreview>;

/** Cobra's suggested move (kind `org`, contracts org.ts `OrgProposal`): one seat to one company; `company` null with `companyName` opens a new one. */
export const ApprovalOrg = z.object({
  seat: z.string(),
  foreman: z.string(),
  company: z.string().nullable(),
  companyName: z.string().optional(),
});
export type ApprovalOrg = z.infer<typeof ApprovalOrg>;

/** A Space Cobra proposes to open (kind `space`): what it is, its three Foremen and what the intake learned. Allow opens exactly this. */
export const ApprovalSpace = z.object({
  name: z.string(),
  /** client, own, team or family (contracts spaces.ts); a string so a new kind never fails an older app. */
  spaceKind: z.string(),
  sensitive: z.boolean(),
  /** The company it becomes a Space of, when the person already has it; absent opens a new one. */
  adopt: z.string().optional(),
  seats: z.array(z.object({ role: z.string(), name: z.string(), trade: z.string() })),
  /** The intake's answers, as the card shows them. */
  profile: z.object({ purpose: z.string(), people: z.string(), voice: z.string().optional(), tools: z.string().optional(), money: z.string().optional(), notes: z.string().optional() }),
});
export type ApprovalSpace = z.infer<typeof ApprovalSpace>;

/**
 * A brand kit a Designer drafted (kind `brand`): its colours (`#rrggbb`) and
 * fonts, as the card shows them, and the logo by path and hash. Allow saves
 * exactly this into `folder` (the company's brand folder), the logo only if
 * its bytes are still the ones shown.
 */
export const ApprovalBrand = z.object({
  project: z.string(),
  /** Whose brand: the company's name, or the project's. */
  name: z.string(),
  folder: z.string(),
  colors: z.object({ brand: z.string(), accent: z.string(), ink: z.string(), paper: z.string() }),
  fonts: z.object({ heading: z.string(), body: z.string() }),
  logo: z.object({ from: z.string(), bytes: z.number().int(), sha256: z.string() }).optional(),
  /** Where the Designer drafted it from (a website, "the logo you sent"), as one line. */
  source: z.string().optional(),
});
export type ApprovalBrand = z.infer<typeof ApprovalBrand>;

/**
 * A board Cobra made for a Space (kind `board`):
 * what it shows, what it reads, its widgets as the apps draw them (contracts views.ts PublicView,
 * read by viewsRead.ts parsePublicView, so an unknown widget is dropped, not a failed parse) and
 * each widget's rows when she made it, for the card's preview. Allow adds exactly it to the Space
 * (or replaces the board `change` names). Boards only read, so this is the only gate.
 */
export const ApprovalBoard = z.object({
  space: z.string(),
  spaceName: z.string(),
  title: z.string(),
  describe: z.string(),
  /** The board it replaces, by id, for a change; absent adds a new one. */
  change: z.string().optional(),
  /** The Space store's tables its widgets read, as the card says them. */
  reads: z.array(z.string()),
  currency: z.string(),
  views: z.array(z.unknown()),
  /** One ViewResult per widget, in order, run when the card was made. */
  preview: z.array(z.unknown()),
  /** Files Allow adds to the Space's data as tables (agent spaceData.ts), each by its name, its file and how many rows. */
  imports: z.array(z.object({ table: z.string(), file: z.string(), rows: z.number() })).optional(),
});
export type ApprovalBoard = z.infer<typeof ApprovalBoard>;

/**
 * Receipts Cobra read for a Space (kind `expenses`, agent receipts.ts): one
 * proposed expense in Money per receipt, with its photo (`file`, a path on the
 * Space's computer the apps fetch with /fs/get) and a bank line it may be.
 * Allow records each (Money's person-only `expense_allow`) and matches its
 * line; Deny ("Not mine") voids them. `unread` names the photos it could not
 * read, and why.
 */
export const ApprovalExpenses = z.object({
  space: z.string(),
  spaceName: z.string(),
  project: z.string(),
  currency: z.string(),
  items: z.array(z.object({
    expense: z.number(),
    vendor: z.string(),
    date: z.string(),
    totalCents: z.number(),
    taxCents: z.number().nullable(),
    category: z.string(),
    file: z.string(),
    /** The photo's size, which /fs/get is checked against. */
    bytes: z.number(),
    match: z.object({ id: z.number(), description: z.string(), postedOn: z.string() }).optional(),
    /** The account Cobra thinks paid it (from the receipt, else the only one); the person may pick another on the card. */
    account: z.number().optional(),
    /** A receipt in another currency than the Space's: its own amount and currency. totalCents is then what its account was charged. */
    paid: z.object({ cents: z.number(), currency: z.string() }).optional(),
    /** That receipt in the Space's currency, at the rate of its day (absent when this computer had no rate). */
    homeCents: z.number().optional(),
  })),
  unread: z.array(z.object({ file: z.string(), why: z.string() })),
  /** The Space's open accounts, for "Paid from" on each receipt. Absent before accounts, or when it has none. */
  accounts: z.array(z.object({ id: z.number(), name: z.string(), kind: z.string() })).optional(),
});
export type ApprovalExpenses = z.infer<typeof ApprovalExpenses>;

/**
 * A budget's monthly limits Cobra proposed for a Space (kind `budget`, agent
 * budgetCard.ts): one line per category
 * with what it averaged over the last three full months and the limit, all in
 * home cents. Allow makes that proposal (`batch`) count from `fromMonth`
 * (Money's person-only `limits_allow`); Deny drops it.
 */
export const ApprovalBudget = z.object({
  space: z.string(),
  spaceName: z.string(),
  project: z.string(),
  batch: z.number(),
  fromMonth: z.string(),
  currency: z.string(),
  lines: z.array(z.object({ category: z.string(), avgCents: z.number(), limitCents: z.number() })),
  totalCents: z.number(),
  /** What came in a month on average over the same three months, when anything did. */
  payCents: z.number().optional(),
});
export type ApprovalBudget = z.infer<typeof ApprovalBudget>;

/**
 * Bills Cobra found or Money's Foreman proposed for a Space (kind `bills`,
 * agent billsCard.ts): each with its
 * amount in its own currency, how often and when it is next due, and how many
 * times it was seen paid. Every bill comes ticked; the person unticks the ones
 * that are not theirs, and the answer's `skip` names them. Allow makes the rest
 * active (Money's person-only `bills_allow`); Deny drops the proposal.
 */
export const ApprovalBills = z.object({
  space: z.string(),
  spaceName: z.string(),
  project: z.string(),
  batch: z.number(),
  /** The Space's home currency. */
  currency: z.string(),
  items: z.array(
    z.object({
      bill: z.number(),
      name: z.string(),
      amountCents: z.number(),
      currency: z.string(),
      every: z.string(),
      nextOn: z.string(),
      category: z.string().optional(),
      account: z.string().optional(),
      seen: z.number().optional(),
      /** The person unticked it: Allow leaves it off. */
      skipped: z.boolean().optional(),
    }),
  ),
  /** found by Cobra, or said by the person to Money's Foreman. */
  source: z.string(),
  /** What the bills come to a month, in home cents (a yearly one as a twelfth). */
  monthlyCents: z.number(),
});
export type ApprovalBills = z.infer<typeof ApprovalBills>;

/**
 * A version of a Space's website the Website Builder asks to put live (kind
 * `site`, agent site.ts): Allow makes exactly `versionId` live in exactly the
 * Worker `worker` the agent made for the site. `previewUrl` is that version's
 * own address, for the person to look at first.
 */
export const ApprovalSite = z.object({
  project: z.string(),
  /** The site's own key on its computer (its Space's or project's). */
  key: z.string(),
  /** The business's name, as the card says it. */
  name: z.string(),
  worker: z.string(),
  versionId: z.string(),
  previewUrl: z.string(),
  liveUrl: z.string(),
  message: z.string(),
  /** The site's first time live. */
  first: z.boolean().optional(),
  /** An older version than the newest: going back. */
  rollback: z.boolean().optional(),
  /** Phase 4b: whether this version's contact form has Cloudflare's spam check (Turnstile). Absent before it. */
  spamCheck: z.boolean().optional(),
  /**
   * Phase 4b: the inquiry email site.json asks for, and whether this version
   * sends it (false until Cloudflare's setup is finished). `addressChecked`
   * false: Cobra could not read whether `to` is verified, so the card asks
   * the owner to make sure it is.
   */
  email: z.object({ to: z.string(), from: z.string(), sending: z.boolean(), addressChecked: z.boolean().optional() }).optional(),
  /**
   * Phase 3b: Allow also saves this version's source to the owner's GitHub
   * (the computer's gh login): `repo` is the recorded repository, or with
   * `newRepo` the name a new private one is made under (-2, -3 when taken).
   * Absent: GitHub is not connected on the site's computer, and nothing is saved.
   */
  github: z.object({ repo: z.string(), newRepo: z.boolean().optional() }).optional(),
  /**
   * The site check's screenshots of this version's home page, desktop then phone, JPEGs in the site's folder that an app fetches
   * with GET /fs/get?path=. Absent before it, or when the computer could not check.
   */
  shots: z.array(DesignFile).max(2).optional(),
  /**
   * Phase 5: a card about the owner's own domain, not a version. Allow
   * attaches exactly `hosts` (in the zone `zone`, active in the site's
   * account) to the site's Worker as custom domains, or with `remove` takes
   * them off. `replaceRecords`: the card said the names' DNS records in
   * Cloudflare are replaced; never otherwise. `versionId` is then the live
   * version, `previewUrl` the site's workers.dev address (it keeps working)
   * and `liveUrl` its address once Allow is done.
   */
  domains: z
    .object({ hosts: z.array(z.string()), zone: z.string(), zoneId: z.string().optional(), remove: z.boolean().optional(), replaceRecords: z.boolean().optional() })
    .optional(),
  /**
   * A change to a website someone else coded:
   * a Worker's PR in the site's own repository. Allow squash-merges PR
   * `number` at exactly `head`; the site's host puts it live when
   * `deploysOnMerge`, else the person does as before (`deploy`, how, when the
   * files say). `versionId` is then `head`, `worker` the repository, and
   * `previewUrl` the host's preview of that head, else the PR.
   */
  outside: z
    .object({
      project: z.string(),
      repo: z.string(),
      number: z.number().int(),
      head: z.string(),
      prUrl: z.string(),
      workerId: z.string(),
      host: z.string(),
      deploysOnMerge: z.boolean(),
      deploy: z.string().optional(),
    })
    .optional(),
  /**
   * A coded site's version: built from `head` of
   * the site's own repository `repo`, in Cobra's sandbox. `services` are the
   * outside services its cobra.json names, each in the card's words (`new`:
   * not in the live version). With `number`, Allow also squash-merges that
   * Worker PR at exactly `head`, after the deploy.
   */
  coded: z
    .object({
      repo: z.string(),
      head: z.string(),
      number: z.number().int().optional(),
      prUrl: z.string().optional(),
      workerId: z.string().optional(),
      services: z.array(z.object({ name: z.string(), why: z.string(), hosts: z.array(z.string()), kinds: z.array(z.string()), new: z.boolean().optional() })),
    })
    .optional(),
});
export type ApprovalSite = z.infer<typeof ApprovalSite>;

/** One file a Foreman asks to copy into its Worker's worktree (kind `import`): from where, to where in the worktree, its size and hash as shown. */
export const ImportFile = z.object({
  from: z.string(),
  to: z.string(),
  bytes: z.number().int(),
  sha256: z.string(),
});
export type ImportFile = z.infer<typeof ImportFile>;

export const ApprovalImport = z.object({
  project: z.string(),
  worker: z.string(),
  files: z.array(ImportFile),
});
export type ApprovalImport = z.infer<typeof ApprovalImport>;

/**
 * On a card made in a tainted turn (agent taint.ts): the session had read text
 * from outside, so it asks whatever trust or Instinct would allow alone.
 */
export const ApprovalTaint = z.object({
  /** What was read, in the person's words: "an email from outside", "web pages (example.com)". */
  read: z.array(z.string()),
  /** The line the card shows: why it asks. */
  note: z.string(),
});
export type ApprovalTaint = z.infer<typeof ApprovalTaint>;

export const Approval = z.object({
  id: z.string(),
  machine: z.string(),
  /** merge, land (any approval with `lands`), mcp-verify, plan, or action. */
  kind: z.string(),
  title: z.string(),
  body: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  /** pending, allowed, denied, expired, done, failed. */
  state: z.string(),
  answeredAt: z.string().optional(),
  prs: z.array(ApprovalPr).optional(),
  /** Branches to land into local main; an approval may carry these and `prs` together. */
  lands: z.array(ApprovalLand).optional(),
  /** What happened after Allow: one line per PR, then one per land (no number). */
  results: z.array(z.object({ number: z.number().int().optional(), ok: z.boolean(), message: z.string() })).optional(),
  /** The MCP server an `mcp-add` would write. */
  mcp: McpEntry.optional(),
  /** The github-mcp-server file an `mcp-verify` would pin; Allow pins exactly this path and hash. */
  mcpPin: McpPin.optional(),
  /** The sha256 of the pin an `mcp-verify` replaces, or null when there was none; Allow is refused if the current pin differs. */
  mcpReplaces: z.string().nullable().optional(),
  /** A Foreman's plan (kind `plan`): Allow starts its Workers on the models shown, or the ones you chose. */
  plan: ApprovalPlan.optional(),
  /** A Foreman's action (kind `action`): Allow sends exactly this, through the agent. */
  action: ApprovalAction.optional(),
  /** A routine the Lead or a Foreman proposed (kind `routine`): Allow writes exactly this. */
  routine: ApprovalRoutine.optional(),
  /** Trust Cobra proposes for an action key (kind `trust`): Allow grants exactly it. */
  trust: ApprovalTrust.optional(),
  /** An action that ran on trust, with no card: a receipt under Landed. */
  trusted: ApprovalTrusted.optional(),
  /** A trade Cobra defined (kind `trade`): Allow installs exactly it. */
  trade: ApprovalTrade.optional(),
  /** A move Cobra suggests in My Organization (kind `org`): Allow makes exactly it. */
  org: ApprovalOrg.optional(),
  /** A Space Cobra proposes to open from an intake (kind `space`): Allow opens exactly it and starts its Foremen. */
  space: ApprovalSpace.optional(),
  /** Files a Foreman asks to copy into its Worker's worktree (kind `import`): Allow copies exactly these, by hash. */
  imports: ApprovalImport.optional(),
  /** A brand kit a Designer drafted (kind `brand`): Allow saves exactly it for the company. */
  brand: ApprovalBrand.optional(),
  /** A website version to put live (kind `site`): Allow makes exactly it live. */
  site: ApprovalSite.optional(),
  /** A board Cobra made for a Space (kind `board`): Allow adds exactly it. */
  board: ApprovalBoard.optional(),
  expenses: ApprovalExpenses.optional(),
  /** A budget's limits Cobra proposed (kind `budget`): Allow makes exactly that proposal count. */
  budget: ApprovalBudget.optional(),
  /** Bills Cobra found or Money proposed (kind `bills`): Allow makes the ticked ones count. */
  bills: ApprovalBills.optional(),
  /** An email template version a Foreman drafted (kind `email_template`): Allow saves exactly it. */
  emailTemplate: ApprovalEmailTemplate.optional(),
  /** Made in a turn that had read text from outside: why it asks (ApprovalTaint). */
  taint: ApprovalTaint.optional(),
});
export type Approval = z.infer<typeof Approval>;

/** GET /trust: this computer's grants, the keys that always ask, and the receipts of actions that ran on trust (newest first). */
export const TrustList = z.object({
  grants: z.array(TrustGrant),
  always: z.array(TrustAsk),
  receipts: z.array(Approval),
});
export type TrustList = z.infer<typeof TrustList>;

export const ApprovalList = z.object({
  machine: z.string(),
  approvals: z.array(Approval),
});
export type ApprovalList = z.infer<typeof ApprovalList>;

/** What rides on an approval's push: the app answers it from the lock screen. */
export const ApprovalPushData = z.object({
  machine: z.string(),
  approval: z.string(),
  kind: z.string(),
});
export type ApprovalPushData = z.infer<typeof ApprovalPushData>;
