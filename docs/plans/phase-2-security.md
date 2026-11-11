# Phase 2: security

Phase 2 closes the known gaps in [SECURITY.md](../../SECURITY.md) before the
public launch. Each step is one pull request, in this order.

## Decisions

- **Taint always asks.** After an agent reads untrusted text in a turn, every
  action in that turn that sends, spends, deletes or publishes needs an
  approval. Trust and Instinct do not skip it, and there is no list of
  trusted senders.
- **Keychain first, passphrase second.** The vault key is kept in the OS
  keychain. When there is none (a headless Linux computer), the person sets
  a passphrase and types it with `cobra-agent vault unlock` after each boot.

## Threat model

The vault protects secrets **at rest**: in backups, synced dotfiles, a lost
disk, or a support bundle someone shares. It does not protect against
malware that runs as the same user while the vault is unlocked; nothing on a
desktop does. Steps 2 and 3 limit what a misled agent can do with secrets it
can reach.

## Step 1: the vault (secrets encrypted at rest) (done)

- A 256-bit vault key encrypts each secret file with AES-256-GCM. The file
  name is the associated data, so a sealed file cannot be swapped for
  another. A sealed file reads `cobra-vault:v1:<base64 nonce|tag|ciphertext>`.
- **Where the key is kept** (`vault.json` in the config folder records the
  mode):
  - `keychain`: libsecret (`secret-tool`) on Linux, Keychain (`security`) on
    macOS.
  - `passphrase`: the key is wrapped with a key derived by scrypt from the
    passphrase. `cobra-agent vault unlock` unwraps it into a file in the
    user's runtime folder (`$XDG_RUNTIME_DIR`, in memory, cleared at logout
    and reboot), where the agent reads it. Until then the agent runs, and
    what needs a secret says the vault is locked.
- **Which files:** the secret files that only the agent reads:
  `anthropic-api-key`, `claude-token` (and each account's), `cloudflare.json`,
  `mailboxes.json`. Not `ticket.key`: the agent and the terminal gateway need
  it to start, and a locked vault must not stop them. It signs short-lived
  tickets on loopback, of no use to anyone not already on the computer.
- **Migration:** a plaintext secret file is read as before and sealed the
  next time it is read with the vault open. `cobra-agent vault seal` seals
  them all at once. `install.sh` runs `cobra-agent vault init`.
- **Locked:** a sealed file read while the vault is locked is refused with
  the fix ("run cobra-agent vault unlock"), never read as empty.
- **No vault yet:** an install from before the vault keeps working with
  plaintext files, and `cobra-agent vault status` says so.
- **Commands:** `cobra-agent vault init | unlock | lock | status | seal`.

## Step 2: no secrets in model context (done)

- Secrets that sandboxed processes need (the GitHub token for the GitHub MCP
  launcher, the Lead's key) are handed to them by the agent on loopback,
  never read from a file inside the sandbox. Then they move into the vault.
- Tools refer to a secret by name. The agent puts the value into the request.
- Tool output, logs and error messages pass through the redactor
  (`redact.ts`) before they reach a model or a file.
- Tests check that no secret value appears in a prompt, a tool result or a
  log line.

What was built:

- **The GitHub token is handed over.** The launcher (`githubMcp.ts`) no
  longer reads `github-pat`. It asks the agent (`GET /orch/github/token`,
  `mcp.ts githubHandoff`) down the same session's line that `cobra-orch`
  uses (see "The Lead's key is in no file" below).
  The agent answers only an orchestrator's key, only with the github entry
  on for that role and its pin unchanged. The token goes from that answer
  into the server's environment; it is never in argv, in a config or in a
  file the launch names, so a Codex fence no longer shows the token file.
  `github-pat` and `github-auth.json` are now in the vault's `SEALED_NAMES`
  (`github-auth.json` holds no token, only how it was made).
- **The Lead's key is in no file (follow-up, after Rakazo's model).** At
  first `cobra-orch` and the GitHub launcher read the Lead's and each
  Foreman's key from a `computers.json`; for a Codex Lead or Foreman they
  run inside its fence, where the model's own shell could read that file
  too. Now the agent serves each orchestrator a line (`orchSocket.ts`): a
  Unix socket in its own folder under the state folder (`orch/lead`,
  `orch/fm-<hash>`), mode 600 in a 700 folder, bound read-only into a Codex
  fence. `cobra-orch` and the launcher call down it with no key; the agent
  takes `/orch/*` GET and POST only (the path normalised first), drops
  whatever Authorization came with it, and adds that orchestrator's key,
  which it mints at its own start (the Lead's, and each running Foreman's)
  and at each Foreman's start, holds in memory only, and pushes out hourly
  while it serves the line. `computers.json` is gone (the agent removes old
  ones at start). A shell that talks to its own line gets what its tools
  give it, on this computer, while the agent serves it; there is no key to
  copy out. This is the boundary Rakazo draws: the sandbox uses a
  capability, the server holds the secret.
- **One redactor** (`secretValues.ts`) takes out (a) every secret value the
  agent holds now, read from its secret files (the vault's files, the
  ticket key, each account's Claude and
  Codex sign-in), cached per file by inode, size and time and looked at
  again at most every 5 seconds, and (b) tokens certain by their shape
  (`redact.ts scrubTokens`: known token formats, key blocks, a password in
  a URL; not the email and assignment rules, which would break mail reads
  and code). It runs at one choke point per channel:
  - every `/orch/*` answer (`orch.ts handleOrch`): what `cobra-orch` and a
    Worker's Space tools return to a model, mail and web reads and Worker
    finish lines among them; `orchMcp.ts` scrubs token shapes once more,
    since it may run where it cannot read the values;
  - every HTTP error body (`index.ts sendJson`);
  - the agent's console, so every log line (`installLogRedaction`);
  - the files it appends to: events, notices, the Lead's thread and the
    hash-chained policy log (redacted before the line is hashed);
  - the text the agent types into a session (`dispatch.ts`).
- **Secrets by name.** Every `cobra-orch` tool (lead and foreman lists) and
  every Worker Space tool was checked: none takes or returns a credential.
  Cloudflare, mail, Google and GitHub are used by the agent with what it
  holds (`form_sources`, `site_domain`, `site_publish`, `mail_*`,
  `mirror_status`); `form_link`'s `key` is a column name.
- **Tests** (`secretValues.test.ts`, `mcp.test.ts`) plant values in a temp
  config folder and check that none appears in an `/orch/*` answer, an
  `orchMcp` tool result or error, an HTTP error body, a log line, the
  appended files, or the GitHub launcher's argv and environment as its
  config gives them; and that a sealed `github-pat` is still handed over.
- **Not done here:** the model gateway's request bodies are not rewritten
  (a changed thinking block fails its signature check); the person's own
  typing into a session is not redacted.

## Step 3: taint gate (done)

- Reading untrusted text (email, web pages, form submissions, files from
  outside) marks the turn tainted. This builds on `taint.json`.
- In a tainted turn, every outward action becomes an approval card that
  says what was read, even when trust or Instinct would allow it.
- The taint ends with the turn, not with a timer. (Changed 2026-11-11: it
  lasts the conversation again, since what was read stays in front of the
  model after the turn. See SECURITY.md.)

What was there before: `taint.json` marked a session after a web read only
(the judge's or Claude Code's, `gate.ts` for a Worker, `orchWeb.ts` for the
Lead and a Foreman). It lasted the whole conversation (until `/clear` or a
rotation) or the Worker's life, and was dropped after 14 days. A tainted
Foreman's email and trusted sends asked, but a Drive save and a merge on
green still ran alone once the injection audit (`taintAudit.ts`) called them
clean, and a Worker's Space tools only marked their own cards. Instinct
skipped only a tainted Worker's cards.

What was built:

- **The turn.** A Lead's or a Foreman's turn ends at its next Stop: the
  Claude Code hook, Codex's notify or the Pi extension, read from the hooks
  folder by the session's exact folder (`taintTurns.ts`); a headless
  session counts its ended turns. A taint is in force while no Stop came
  after its last read. The agent sweeps each finish tick (`endTurns`, every
  5 seconds) and writes the end down, since a later event hides a Stop; a
  Stop it could not see keeps the taint until the next one (it asks once
  more, never less). A Worker's turn is its run: its taint ends when the
  Worker is gone. A fresh conversation still ends it. An ended taint stays
  in the file for 14 days for the record; nothing in force is dropped by
  age.
- **The sources** (each taints the reading session's turn):

  | Source | Taints | Where |
  | --- | --- | --- |
  | Web search and page reads | yes | `gate.ts`, `orchWeb.ts` (as before) |
  | Mail search and read (Gmail, a Space's own mailbox) | yes | `orch.ts` TAINTING_READS |
  | Calendar reads | yes, every one (invites carry other people's words) | `orch.ts` TAINTING_READS |
  | An email reply, summed up and told to its Foreman | yes, when the line is typed | `emailLive.ts`, `finishes.ts` |
  | Form submissions and site pulls (`sitePull.ts`, `formLinks.ts`), and replies, in the store | yes, on a `db_query` of the people or timeline when the store holds such rows | `dbRoutes.ts` holdsOutsideText |
  | Files copied into a Worker (`worker_import`) | yes, unless each is a picture or a font | `index.ts`, `workerImport.ts` importsText |
  | A tainted Worker's words (`worker_read`, `worker_wait`) | yes, for the reader | `orch.ts` |
  | A brief, answer or message from a tainted turn | yes, for the Foreman's turn or the Worker's run | `orch.ts` |
  | A Worker started by a tainted turn | yes (as before) | `orch.ts` startOrQueue |
  | Attachments the person sends from the desk | no: the person's own | |
  | Drive | no: Cobra only writes there (`drive.file`) | |
  | Sent files (`sentFiles.ts`) | no: they only mark what went out | |
  | CSV and sheet imports | no: rows move by code and never through a model; a later `db_query` of people rows taints as above | |
  | `contact_lookup`, a Foreman's transcript read by the Lead | no (see below) | |

- **The gate.** Two places decide that something runs without the person,
  and both now check the caller's turn (`orch.ts` handleOrch `taintOf`):
  - Trust and Drive consent at `action_propose` and `email_send`: in a
    tainted turn there is no trusted run; it is a card. The caller is the
    Worker itself for a Worker's Space tools.
  - Merge on green: a merge asked in a tainted turn, or of any Worker whose
    run is tainted, is a card.
  Every card a tainted turn makes through `/orch/*` is stamped on its way to
  the person (`approvals.ts stampTaint`, in handleOrch's notify): a `taint`
  field (what was read, and the note) and the note at the end of its body.
  Instinct (`instinctActs.ts actsAlone`) and the judge for unanswered cards
  (`unanswered.ts`) never take a stamped card. Cards that always asked keep
  asking, now with the note. The note reads, for example, "Cobra read an
  email from outside in this turn, so it asks you before this goes out."
  The desk shows it on the card (`lib/trust.ts taintNote`).

Deviations and choices:

- The injection audit no longer lets anything through: a tainted Drive save
  or merge is a card, as the decision says. `taintAudit.ts`'s `audit` is no
  longer called; its `keepPage` and `speaksToAi` still are. Removing the rest
  is left for a later change.
- Instinct keeps every card of a tainted turn, not only outward ones (a plan,
  a routine, a trade, an org move), as it already did for a tainted Worker's
  cards. A routine written in a tainted turn would otherwise carry planted
  words into a later turn that is not tainted.
- Not gated: a Worker's own tool calls that the judge decides under Auto or
  Instinct (a network call, an outside tool). The judge is told the Worker
  is tainted, as before. Sending each of a tainted Worker's network calls to
  the person would stop research Workers; this needs its own decision.
- Not sources yet: `contact_lookup` (names and addresses only), the Lead
  reading a Foreman's transcript after its tainted turn ended, and files the
  Lead or a Foreman reads with its own Read tool.
- The Lead's turn is found by its folder (`leadHome`); a session of the
  person's own in exactly that folder could end the Lead's taint early.

## Step 4: append-only audit log (done)

- Every action, not only policy decisions, goes in the hash-chained log
  (`auditLog.ts`): approvals, sends, payments, publishes, key and vault
  changes.
- `cobra-agent audit verify` checks the chain. The desk shows the log, read
  only.

What was built (done):

- **One log.** The actions go into the policy log's own file
  (`policy.jsonl`, now `auditTrail.ts AUDIT_LOG`, which `POLICY_LOG` names),
  beside the policy's decisions, as one hash chain: one rotation (`LOG_KEEP`
  older files, the first line of a new file chained to the last of the old),
  one daily anchor (`memory.ts anchorPolicyLog`, as before) and one verify.
  An action record is `{at, kind, actor, subject: {project, card, target},
  outcome, detail, prev}`; a policy decision keeps its shape and has no
  `kind`, which is how readers tell them apart (`readPolicyLog` skips
  actions; `readAudit` reads both).
- **One small API.** `audit(kind, {actor, subject, outcome, detail})`
  (`auditTrail.ts`) keeps strings short (160 characters), drops fields named
  like content (`body`, `text`, `html`, `message`, `password`, `token`,
  `key`, `email`, `values`…), and the whole record is redacted
  (`secretValues.ts`) before it is hashed, as the policy log already was. It
  keeps identifiers, counts, recipients' domains (never an address), amounts
  in cents, file names with the start of their SHA-256, and the card's
  one-line title, never its body or an email's subject or words.
- **Choke points**, so no caller can miss one:

  | Kind | Where | Actor |
  | --- | --- | --- |
  | `approval.proposed`, `.allowed`, `.refused`, `.expired`, `.judged`, `.done`, `.failed` | `approvals.ts saveApprovals`: every change of a card is written there; it compares the file before and after (`auditApprovals`) | who asked; for an answer the person (`person:<key id>`, from `POST /approvals/answer`), `trust`, `instinct`, `judge` or `merge-on-green`; `time` for a lapse, `agent` for one replaced early or carried out |
  | `email.sent`, `drive.saved`, `file.saved`, `mailbox.changed`, `note.read`, `email.queued` | `actions.ts runAction`: every action card carried out, after Allow or on trust | `agent` (`person` for a note read) |
  | `email.sent` | `emailSend.ts sendNext`: each branded, campaign, batch and sequence email the queue sends | `agent` (`person` for a test send) |
  | `merge` | `repo.ts mergePr`: every GitHub merge (a card's Allow, merge on green, a linked site's PR, the desk's Merge) | `agent`, `person` from the desk |
  | `land` | `landing.ts landOne`: a branch landed into a local main | `agent` |
  | `site.published` | `siteDeploy.ts deploy`: a website version put live | `agent` |
  | `money.recorded` | `db.ts write`: a store mutation with an amount, or a payment, expense, invoice, transaction, bill or payroll mutation | the writer (`person`, `agent`, or the Foreman's key) |
  | `key.minted`, `.rotated`, `.revoked`, `.signing` | `keys.ts` key store (`upsert`, `rotate`, `remove`, `setSignKey`): `cobra-agent desk` and `unlink` (`cli`), each Lead and Foreman start, a desk's rotation | `cli`, `agent`, or the key itself for a rotation |
  | `vault.init`, `.unlock` (and a wrong passphrase, `refused`), `.lock`, `.sealed` | `vault.ts Vault`, `private.ts` (a plain secret file sealed when read) | `cli`, `agent` |

  A lapse reaches the log when the file is next written; the agent writes
  lapsed cards each minute (`approvals.ts writeLapsed`, in the unanswered
  cards tick) so it is near its time.
- **Never in the way.** A record that cannot be written (a full disk) is
  told once on the console and as a desk notice (kind `audit`), and the
  action goes on; the next record that is written ends that, and a later
  failure is told again. Losing a line is better than an email that never
  goes out. A record made while another is being written (redacting reads
  the secret files, and a read can seal one, which is audited) waits and is
  written after, so two writes never chain to the same line.
- **Append-only in practice**: the file is only ever appended to, under the
  existing lock; nothing rewrites a line; rotation renames whole files.
- **Commands.** `cobra-agent audit verify` checks the chain across every
  kept file and the anchors and exits 1 at the first broken link, naming the
  file and line (`auditCli.ts`); `cobra-agent policy-log verify` is its old
  name and does the same. `cobra-agent audit tail [n] [--all]` prints the
  newest entries in plain words (`auditWords`).
- **The desk.** `GET /audit/log?limit=&before=&all=1` (`auditRoutes.ts`):
  this computer's desk key only (a phone, Lead, Foreman or API key gets
  403), GET only, newest first, 50 a page, `before` the last id shown, the
  policy's tool decisions left out unless `all=1`. Settings → Audit log
  lists it, read only, with Show older and a Tool decisions switch.
- **Tests** (`auditTrail.test.ts`, and in `repo.test.ts`,
  `emailSend.test.ts`, `landing.test.ts`, the desk's `lib/auditLog.test.ts`,
  `components/settings/AuditLog.test.tsx` and the smoke test): each kind
  appends exactly one record with its fields and no body, address, subject,
  key, hash of a key or passphrase; the chain verifies; a changed line is
  found and named; rotation keeps the chain; a planted secret stays
  redacted; a failed write does not throw and is told once; verify and tail;
  the route refuses every key but the desk's; the desk draws the entries.

Deviations and choices:

- One file rather than a second chain: the log keeps the name
  `policy.jsonl` and the anchors file `policy-anchors.jsonl`, so the chain
  and its anchors run on from before. The policy's decisions are most of the
  lines, so the kept files (about 30 MB) hold fewer days of actions than a
  log of actions alone would.
- Not logged: changes to trust and Instinct settings, the permission policy
  and other settings (a grant of trust is a card, so it is logged as one);
  a store write with no money in it; reads.
- The approval records carry the card's title (its one line), not its body.
  A title a Foreman wrote can name a person or a subject; it is redacted like
  the rest.

## Step 5: sandboxed pages (done)

- Pages and previews that Cobra generates render in a sandboxed frame with a
  strict Content Security Policy and no access to the desk's API or keys.
- Email previews run no scripts.

What was built (done):

- **The desk's own page** (`tauri.conf.json` `app.security.csp`):
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: asset: http://asset.localhost; font-src 'self' data:;
  connect-src ipc: http://ipc.localhost; frame-src 'none'; child-src 'none';
  worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'`. No eval, no inline or remote script. The page
  never talks to the agent itself: every request goes through the Rust side
  (`invoke`), so `connect-src` is the IPC alone and the agent's port does not
  appear. Images are the bundle's, `data:` (designs and screenshots, which
  the Rust side reads and hands over as `data:` URLs) and `asset:` (the
  chat's local pictures); fonts are bundled.
- **Surfaces, and what each got:**

  | Surface | Where | What it got |
  | --- | --- | --- |
  | Email card preview, outreach batch copies | `EmailPreview.tsx` | `PreviewFrame` |
  | The block editor's live email | `EmailEditor.tsx` | `PreviewFrame` |
  | Marketing gallery thumbnails and a template's page | `MarketingBoard.tsx` | `PreviewFrame` (after `lightOnly`) |
  | Chat text (the Lead's, a session's, the person's) | `Chat.tsx`, `ui.tsx Markdown`, `lib/markdown.ts` | already escaped everything and linked only http(s); now tested against tags, handlers and `javascript:`/`data:` links. It is the only HTML put into the desk's own page |
  | Links anywhere in the desk | `lib/linkGuard.ts` (installed in `main.tsx`) | a click no page took: http(s) opens in the browser, anything else does nothing |
  | Any window's navigation | `src-tauri/src/pages.rs` (a plugin's `on_navigation`) | Cobra's windows stay on the bundled page (and `about:srcdoc`); a terminal window on its loopback page; http(s) goes to the browser; `data:`, `javascript:`, `file:` and the rest do not load |
  | Designs, website screenshots, receipts | `Chat.tsx`, `SiteShots.tsx`, `ExpensesPreview.tsx` | unchanged: `<img>` of a `data:` URL, which runs nothing |
  | Website previews (a site card's `previewUrl`) | `Popup.tsx`, `Home.tsx` | unchanged: opened in the browser, never in a desk window |
  | Bills, dashboards, boards, the notebook | `BillsPreview.tsx`, `Dashboard.tsx`, … | unchanged: React from JSON, no HTML |
  | The terminal page | agent `gateway/page.ts`, `index.ts` | a policy header (scripts: its own files and its one inline script by hash; connect only to its own socket; `frame-ancestors 'none'`), `nosniff`, `no-referrer`; xterm's files `nosniff` |
  | A file's bytes (`GET /fs/get`: reports, PDFs, a Worker's HTML) | agent `browse.ts FILE_HEADERS` | already a download (`attachment`); now also `default-src 'none'; …; sandbox`, `nosniff`, `no-referrer` |

- **`PreviewFrame`** (`components/PreviewFrame.tsx`, `lib/previewFrame.ts`)
  is the only `<iframe>` in the desk: `sandbox=""` (no allow-scripts, no
  allow-same-origin, no popups, forms or top navigation),
  `referrerpolicy="no-referrer"`, and `srcdoc` with
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none';
  img-src data: https:; style-src 'unsafe-inline'; font-src data: https:;
  base-uri 'none'; form-action 'none'">` as the first element (after the
  doctype, so the email stays in standards mode; the parser makes it the
  head's first child). It gets the HTML and nothing else: no key, ticket or
  token. A `srcdoc` frame also inherits the desk's policy, so in practice it
  draws only `data:` images, which is what the agent puts in a preview.
- **Links in a preview** do nothing: the empty sandbox stops a popup or a
  move of the desk, and the desk's `frame-src 'none'` stops the frame loading
  the page itself (checked in WebKitGTK 2.54: the click is refused as a
  `frame-src` violation, and a `srcdoc` frame still draws under
  `frame-src 'none'`).
- **Tests**: the desk's `lib/previewFrame.test.ts` (the sandbox is empty, the
  policy has no script and is the head's first element), `components/
  PreviewFrame.test.tsx` (the frame's exact attributes; the email card draws
  in it; no other `<iframe>`, `srcDoc`, `<object>` or `<embed>` in the desk;
  the three email surfaces use it; `dangerouslySetInnerHTML` only from the
  markdown renderer), `lib/markdown.test.ts` (scripts, handlers, styles and
  `javascript:`/`data:`/`vbscript:` links stay text), `lib/linkGuard.test.ts`,
  `lib/appCsp.test.ts` (reads `tauri.conf.json`: no eval, no remote origin in
  any directive, the IPC only, `frame-src`/`object-src`/`base-uri` `'none'`;
  the IPC capability names only Cobra's four windows); `pages.rs` tests in
  Rust; the agent's `gateway/page.test.ts` and `browse.test.ts` (the headers,
  the hash matches the inline script, a Host that is not loopback adds no
  socket origin, and each route sends them).

Deviations and limits:

- Links in a preview do not open in the browser; they do nothing, as before.
  Opening them would need `allow-popups` and a new-window handler, more
  surface for a preview's links, which the card's text already shows.
- No preview needed scripts, so none has `allow-scripts`.
- `style-src 'unsafe-inline'` stays on the desk's page (React's inline
  styles) and on the terminal page (xterm writes `<style>` elements).
- The terminal window still opens with its single-use ticket in the URL, as
  before: it is the agent's own page, not a preview, and the ticket is spent
  when its socket opens.
- Checked against the built bundle in WebKitGTK (no violation) and by the
  tests; not run under `tauri dev`, and nothing was added for Vite's dev
  socket. The desk was not run as the full app with a live agent.
- The agent's API serves no HTML (`index.ts` has no `text/html`), so the
  only HTML routes are the terminal page and a file's bytes.

## Step 6: containment on macOS (warning done; profile moved to phase 3)

- Built: a standing `uncontained` alert (alerts.ts) whenever Workers do not
  run in Cobra's sandbox, with the reason. The desk lists it with the other
  alerts and it comes as a desktop notification. On macOS the reason is that
  there is no Cobra sandbox yet (contain.ts `containMode`); on Linux, that
  `COBRA_CONTAIN` is off or bubblewrap does not work.
- Moved to phase 3: a `sandbox-exec` profile for Workers on macOS. It cannot
  be tested without a Mac, and an untested sandbox is worse than an honest
  warning.
