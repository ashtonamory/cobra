# Security

## Report a vulnerability

Do not open a public issue. Use GitHub's private vulnerability reporting
(the **Security** tab, then **Report a vulnerability**). You get an answer
within 7 days.

## The model

Cobra runs AI agents that can read your email, change your CRM, spend money
and publish websites. The design assumes that any text an agent reads
(an email, a web page, a form submission) can contain instructions written
by an attacker. These are the protections that are in place now:

- **Loopback only.** The agent, the terminal gateway and the model gateway
  listen on `127.0.0.1`. There is no remote access.
- **Scoped keys.** Each caller (the desk, the Lead, each Foreman, each
  Worker) has its own bearer key with its own scope. A Worker's key cannot
  approve its own requests.
- **Approvals.** Anything that sends, spends, deletes or publishes becomes a
  card that you allow or refuse in the desk.
- **Contained Workers.** Workers run in Cobra's sandbox, with no access to
  your home directory outside their project and no network but their line
  to the agent: under bubblewrap on Linux, under a `sandbox-exec` profile
  made from the same rules on macOS. Its limits on macOS: other accounts
  on the same Mac can reach a Worker's loopback port (Linux gives each
  Worker a loopback of its own); a Worker cannot connect to a server it
  started itself on loopback, so a check that does fails there; build
  caches are read-only (Linux lets a build write a throwaway copy); a
  Worker can see the names and sizes of files it cannot read; and Codex
  Workers do not run on macOS yet. A Codex Lead or Foreman on macOS runs
  with Codex's own sandbox off (macOS cannot nest one), so the fence holds
  its shell too: writes only to its own folders, and the network only to
  loopback and HTTPS.
- **Append-only audit log.** Every action is appended to one log in which
  each line carries the hash of the line before it: each card asked and who
  answered it (you, trust, Instinct or the judge), each email, file, Drive
  save, merge, website and money record that went out, each key made,
  rotated or removed, each vault change, and each policy decision. It keeps
  ids, counts, recipients' domains, amounts and hashes, never a message, a
  secret or a password, and it is redacted before it is hashed. Writing it
  never stops an action; a failure is told once. `cobra-agent audit verify`
  checks the chain and names the first changed line; the desk shows the log
  in Settings → Audit log, read only. Its limits: anything running as your
  account can rewrite the whole file and every hash in it. The daily anchor
  (the chain's head, kept in the Executive Assistant's memory) shows such a
  rewrite only for what was there at the last anchor; a rewrite of the
  records since then, or of the anchors too, does not show.
- **File modes.** Files that hold secrets are written with mode `600`, and
  Cobra refuses to read one that other users can read.
- **The vault.** Secret files are sealed at rest with AES-256-GCM; the key
  is in the OS keychain, or wrapped by your passphrase
  (`cobra-agent vault status`).
- **Taint always asks.** Once an agent reads text from outside (a web
  page, an email, a calendar invite, what someone sent through a website
  form, what a connector's tool gave back), every action after it that
  sends, spends, deletes or publishes is a card, even where trust, Drive
  consent, merge on green or Instinct would have let it run alone. The card
  says what was read. The taint lasts the conversation, since what was read
  stays in front of the model: only a fresh conversation ends it (New
  conversation, a restart, the Lead's rotation after two quiet hours, an
  on-call Foreman's next wake). A Worker's lasts its whole run, and a Worker
  started from a tainted conversation starts tainted. A Foreman's report
  written in a tainted conversation taints the Lead that reads it. A note
  kept in memory from a tainted conversation is kept, and says "written
  after reading text from outside" wherever it is read later. Its limits:
  that mark is a warning to the reader, not a gate, so reading a marked
  note does not taint; and the connector mark is made only for a Lead or
  Foreman on Claude Code. A
  tainted Worker's own network calls under Auto or Instinct still go to the
  judge, which is told the Worker is tainted.
- **Sandboxed pages.** The desk draws an email Cobra made, or a template a
  Foreman wrote, only in a frame with an empty sandbox (no scripts, no
  same origin, no forms, popups or navigation) and its own Content Security
  Policy (nothing loads but inline styles and pictures). The desk's own page
  has a strict policy: no eval, no inline or remote script, no frames, no
  plugins, and it reaches the agent only through the app. Chat text is
  escaped and links only to http(s). A web link opens in your browser; no
  desk window ever loads another page. The agent's terminal page and the
  files it serves carry a strict policy, `nosniff` and no referrer. Its
  limits: links inside an email preview do nothing; the desk still allows
  inline styles.
- **No secrets in model context.** The Lead and each Foreman reach the
  agent down a socket of their own, and the agent adds their key on its
  side: no orchestrator key is in a file or in a model's reach. The agent
  hands the GitHub token to the GitHub server down the same socket; no tool
  takes or returns a credential; and
  tool results, typed text, log lines and error messages are redacted of
  every secret value the agent holds and every token by its shape.

## Known gaps (to be fixed before the public launch)

Cobra is pre-release. This is known and not fixed yet:

1. **The model can still read some secrets itself.** What the agent sends a
   model (tool results, typed text) and writes to logs and errors is
   redacted: no secret value it holds, and no token by its shape. A Worker
   or a Lead that reads a file holding a secret with its own tools gets it
   unredacted; the deny rules and the sandbox are what keep those files
   out of reach.

Until this is done, use Cobra only with accounts that you can afford to
expose to an agent that makes mistakes.
