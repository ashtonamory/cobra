# Phase 3: models, macOS, installers

Phase 3 makes Cobra installable by someone else, on Linux or a Mac, from a
signed release. After it comes the public launch. Each step is one pull
request, in this order.

## Decisions

- **Three model sources.** Claude (Claude Code), OpenAI (Codex) and local
  models through Ollama. No other provider in this phase.
- **A real Mac.** The person installs each macOS step on a test Mac and
  runs the checks in `docs/mac-test.md`; a macOS step is done only when
  that list passes there.
- **Signed and notarized.** Releases are signed; the Mac desk app and the
  agent's Mac files are signed with the person's Apple Developer ID and
  notarized, so Gatekeeper opens them without a warning. Until the public
  launch this is optional (decided 2026-11-09): with no Apple secrets a
  release ships unsigned Mac files for testers, who open them by hand once.
- **Mac test builds from Linux** (decided 2026-11-09): `package.sh
  darwin-arm64` works on Linux too, since every native file a Mac package
  needs is prebuilt.

## Step 1: models (Claude, Codex, Ollama) (done)

What was there: every role runs on Claude Code or Codex (`engines.ts`);
Workers and sessions can run on an Ollama model (`localModels.ts`,
`launchEnv.ts`); the helpers and the judge fall back to Ollama
(`fallbackRun.ts`, `judge.ts`).

What was built:

- **The Lead and the Foremen stay on Claude or Codex** (decided): they plan,
  brief and judge, and a local model that gets that wrong costs the person
  more than it saves. `engines.ts` already refuses anything else for them.
  Workers, sessions and the helpers' fallback can use Ollama; Settings →
  Engines says so.
- **One readiness check** (`modelSources.ts`): Claude (a picked account, a
  `claude` login, a kept token, or the API key), Codex (a ChatGPT sign-in)
  and Ollama (answering, with at least one model that can use tools), each
  with what to do when it is not ready. In the desk under Settings →
  Engines (`GET /settings/engines` `sources`) and as `cobra-agent models`.
- **`packages/ai-router` is gone.** It held only the home model's message
  format, now `apps/agent/src/agent/homeModelFormat.ts`.
- VISION.md principle 3, AGENTS.md and README.md say Claude, Codex and
  local models.

## Step 2: the agent on macOS (built; passes when docs/mac-test.md step 2 does)

- **`install.sh` runs on macOS** (arm64 and x64). macOS ships bash 3.2, so
  the script starts itself again under Homebrew's bash. The agent is a
  launchd user agent (`launchd/app.cobra.agent.plist`, in
  `~/Library/LaunchAgents`; the terminal gateway that had one too is gone); `AbandonProcessGroup`
  does what `KillMode=process` does, so an update never ends a session.
  agent.env is sourced by the shell that starts node. Ports are found with
  `lsof` and `ps` where Linux uses `ss` and `/proc`; the link swap uses
  `mv -h`; PATH includes Homebrew's folders; a missing tmux or git is a
  numbered next step with its `brew install`. Logs go to
  `~/Library/Logs/cobra-agent.log`.
- **`cobra-agent uninstall`** boots the launchd agents out and removes
  their plists (no systemd, no linger).
- **Computer stats** (`collect/darwin.ts`): CPU from Node's core times,
  memory from `vm_stat` and `sysctl vm.swapusage`, disks from `mount` (the
  data volume shown as /, and drives under /Volumes), network from
  `netstat -ibn`, power from `pmset -g batt`, Cobra's services from
  `launchctl print`. Each gives an empty answer, never an error, when its
  command fails. Temperature and the lid are not read on a Mac.
- **The vault** already used the macOS keychain (`security`); the Mac test
  checks it across a log out.
- `docs/mac-test.md`: what the person runs on the test Mac.

## Step 3: the Worker sandbox on macOS (built; passes when docs/mac-test.md step 3 does)

- **One description, two sandboxes** (`seatbelt.ts`). The bubblewrap
  arguments Linux already builds (`contain.ts`, `checks.ts`,
  `installJail.ts`, `orchFence.ts`) are read as rules and turned into a
  `sandbox-exec` profile: the system readable, home and the temp folders
  hidden, then the toolchains, the worktree and the Worker's own folders
  back, the covers and secrets out, in the same order. Workers, jobs,
  dependency installs, local checks and built sites all use it.
- **Network:** a Worker reaches only its socket folder and its own bridge
  port on loopback. macOS shares one loopback, so each Worker's bridge has
  a port of its own (40000 to 59999, from its socket folder's hash), and its
  socket keeps its real path. An install has the network; a check has none.
- `containMode` gives "contained" on macOS when the profile starts (probed
  as bubblewrap is); `install.sh` turns `COBRA_CONTAIN` on there. The
  "Workers run outside Cobra's sandbox" warning goes away. SECURITY.md's gap
  2 is closed, with the limits on macOS written under "Contained Workers".
- **A Codex Lead or Foreman** runs in the same fence on macOS: its folders
  read-only, its Codex home writable, its line to the agent reachable. macOS
  cannot nest sandboxes, so Codex's own is off there and the fence holds its
  shell too (network: loopback and HTTPS only).
- **Codex Workers stay Linux only** (decided while building): their managed
  hooks live in `/etc/codex`, which needs a second `/etc` that macOS cannot
  give one process. On macOS they are refused with a clear message.
- Tests: `seatbelt.test.ts` (the profile for a Worker, a check, an install
  and a fence). On the Mac: `docs/mac-test.md` step 3.

## Step 4: signed releases (built; passes when the first release does, and docs/mac-test.md step 4)

- **`package.sh` builds any target on its own kind of computer**
  (linux-x64, linux-arm64, darwin-arm64, darwin-x64), with Node's pinned
  hash for each, and runs on macOS (shasum, BSD tools; GNU tar when there,
  for a reproducible archive). It no longer reads the removed
  `packages/sync`, and `zod` is taken from `packages/ste`, whose it is. On
  macOS it ships node-pty's prebuilt addon with `spawn-helper` made
  executable (node-pty 1.1.0 ships it without the bit).
- **macOS signing:** with the release secrets, every native file of ours is
  signed (Developer ID, hardened runtime, timestamp) and notarized; Node's
  own binary is already signed and notarized by the Node.js project.
- **`.github/workflows/release.yml`** on a `v*.*.*` tag: checks the one
  version (`scripts/release/version.ts`), builds the four agent packages and
  the desk (`.deb` and AppImage for x64 and arm64, a universal signed and
  notarized `.dmg`), writes the desk's update feed
  (`scripts/release/updaterFeed.ts`) and `SHA256SUMS`, attests every file
  once the repository is public, and makes a **draft** release a person
  publishes.
- **The desk's updater** (tauri-plugin-updater): Settings → This app →
  Updates checks when asked and installs only on a click, after a confirm.
  Each update is checked against the public key built into the app. The
  key pair is kept outside the repository; `docs/releasing.md` lists every
  secret and how to cut a release.

## Step 5: one-line install and SETUP_PROMPT.md

- `curl -fsSL https://…/install | sh` fetches the right package for the
  computer, checks it against `SHA256SUMS` and its attestation (with `gh`
  when present), and runs `install.sh`. It never needs root; it says the
  one root step (linger on Linux) when there is one.
- `SETUP_PROMPT.md`: a prompt the person gives their own AI agent (Claude
  Code or Codex) to set Cobra up with them: install, sign in, the vault,
  the first Lead, Ollama if they want local models. It asks before every
  step that changes the computer.
- README: install, update, uninstall, in that order.

## Step 6: what is left from phase 2

- Text the person types is redacted as tool results are.
- A link in an email preview opens in the browser after a confirm.
- `contact_lookup` and a Read of a file from outside taint the turn.
- `taintAudit.audit` is used or removed; `packages/contracts/src/audit.ts`
  loses its stale comment.

## Done when

A person with a Mac or a Linux computer runs the one line, follows
`SETUP_PROMPT.md` with their own agent, and has a Lead, contained Workers
and a sealed vault, from signed files, with no warning they have to click
past.
