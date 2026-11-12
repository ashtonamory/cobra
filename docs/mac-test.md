# Testing Cobra on a Mac

Run this on the test Mac after each macOS step. A step is done when every
line in its section passes. Write down what you see for a line that fails,
and the output of `tail -50 ~/Library/Logs/cobra-agent.log`.

## Before you start

1. macOS 13 (Ventura) or later, on Apple silicon or Intel.
2. Homebrew (brew.sh), then:

   ```sh
   brew install bash tmux git node pnpm
   ```

3. Claude Code, signed in (`claude`, then `/login`). Codex is optional
   (`codex login`). Ollama is optional (ollama.com).
4. The agent package for this Mac: `cobra-agent-<version>-darwin-arm64`
   (Apple silicon) or `-darwin-x64` (Intel), unpacked. From a release, or
   built before one (below).

## A test build from Linux

The Mac package can be built on a Linux computer and copied to the Mac.
On the Linux computer, in a clone with `pnpm install` done:

```sh
bash apps/agent/scripts/package.sh darwin-arm64     # darwin-x64 for an Intel Mac
scp apps/agent/release/cobra-agent-*-darwin-arm64.tar.gz <mac>:Downloads/
```

On the Mac:

```sh
cd ~/Downloads && tar -xzf cobra-agent-*-darwin-arm64.tar.gz
xattr -dr com.apple.quarantine cobra-agent-*-darwin-arm64
cd cobra-agent-*-darwin-arm64 && ./install.sh
```

The build is unsigned, and Linux cannot run the Mac Node in it: the
install on the Mac is the first time it runs.

The desk app cannot be built on Linux. Use the `.dmg` from a release, or
build it on the Mac: `cd apps/desk/app && npm ci && npx tauri build`
(needs Rust, from rustup.rs, and the Xcode command line tools).

## Opening an unsigned build

Until the Apple secrets are set (docs/releasing.md), the Mac files are not
signed by Apple. Each needs one step, once:

- **The agent package.** Fetched with `curl` or `scp`: nothing. Downloaded
  in a browser or sent by AirDrop: `xattr -dr com.apple.quarantine` on the
  unpacked folder, before `./install.sh`. Without it, macOS stops `node`
  with "cannot be opened because the developer cannot be
  verified".
- **The desk app.** Drag Cobra to Applications and open it. macOS says it
  "could not verify" it: click Done, then System Settings → Privacy &
  Security → Open Anyway, and enter your password. After that it opens
  normally, and its own updates do not ask again. (Or, in Terminal:
  `xattr -dr com.apple.quarantine /Applications/Cobra.app`.)

Tests 4.2, 4.3 and 4.5 need a signed release. With an unsigned one, skip
them and run the rest.

## Step 2: the agent on macOS

| # | Do | Pass when |
| --- | --- | --- |
| 2.1 | `./install.sh` from the unpacked package, in Terminal | It ends with "Done" and a numbered list of next steps. No line says "Unsupported" or "bash 4". |
| 2.2 | `launchctl print gui/$(id -u)/app.cobra.agent \| grep state` | `state = running`. The same for `app.cobra.term`. |
| 2.3 | `curl -s http://127.0.0.1:8787/health` | It answers (any JSON). Use the port the installer printed if it is not 8787. |
| 2.4 | `cobra-agent vault status` | "Vault: keychain" and that it is open. Keychain Access shows an item named "Cobra vault key". |
| 2.5 | Log out and log in again, then repeat 2.2 and 2.4 | Both agents run again, and the vault is still open. No keychain prompt appeared. |
| 2.6 | `cobra-agent models` | Claude is "ready". Codex and Ollama are "ready" or say what to do. |
| 2.7 | `cobra-agent desk`, then open the desk app and paste the key | The desk connects. Settings → Engines shows the three model sources. |
| 2.8 | In the desk, look at this computer's stats | CPU, memory, disk (shown as /) and network have numbers; nothing says error. A MacBook shows its battery. |
| 2.9 | `cobra-agent lead start`, then send the Lead a short message in the desk | The Lead answers. `tmux -L cobra ls` lists `cobra_lead`. |
| 2.10 | Run `./install.sh` again (an update) | It ends with "Done". `tmux -L cobra ls` still lists `cobra_lead`: an update never ends a session. |
| 2.11 | Ask the Lead for a small change in a test project | A Foreman and a Worker start; the desk shows a standing warning that Workers run outside Cobra's sandbox (until step 3). |
| 2.12 | `cobra-agent uninstall`, type `uninstall` | It ends with "Cobra's agent is uninstalled." `ls ~/Library/LaunchAgents` has no `app.cobra.*`; `tmux -L cobra ls` finds no server. Then install again for the next step. |

## Step 3: the Worker sandbox on macOS

Install the step 3 package over step 2 (`./install.sh`). In a test project,
add a file `.env` with the line `SECRET=canary`.

| # | Do | Pass when |
| --- | --- | --- |
| 3.1 | `grep COBRA_CONTAIN ~/.config/cobra-agent/agent.env` | `COBRA_CONTAIN=on`. The installer said "the default: sandbox-exec works here". |
| 3.2 | `cobra-agent audit` | Workers are "contained". No line says bubblewrap or "outside Cobra's sandbox". |
| 3.3 | Ask the Lead for a small change in the test project | A Foreman and a Worker start. The desk shows no warning that Workers run outside Cobra's sandbox. The Worker shows as working, then done, in the desk. |
| 3.4 | While the Worker runs: `ps -axo command \| grep sandbox-exec` | Nothing (sandbox-exec becomes the Worker). `ps -axo pid,command \| grep containBridge` shows the bridge. |
| 3.5 | Ask the Lead for a Worker that runs `cat ~/.ssh/id_ed25519` (or any file in `~/.ssh`) and reports what it got | It reports "Operation not permitted" (or no such file). Never the key. |
| 3.6 | A Worker that runs `cat .env` in the project | "Operation not permitted". |
| 3.7 | A Worker that runs `touch ~/Desktop/cobra-test` and `touch /tmp/cobra-test` | Both fail. `ls ~/Desktop/cobra-test /tmp/cobra-test` finds neither. |
| 3.8 | A Worker that runs `curl -sS https://example.com` | It is refused (by the Gate, or "Couldn't connect"). With an allow in the desk, the request goes through the agent and works. |
| 3.9 | A Worker that runs `curl -sS http://127.0.0.1:8787/health` | "Couldn't connect". The agent's port is out of reach. |
| 3.10 | A Worker that runs `security find-generic-password -s "Cobra vault key"` | It fails. The keychain is out of reach. |
| 3.11 | A Worker that edits a file and commits on its branch | The commit is there (`git log` on the branch). Its pull request opens as on Linux. |
| 3.12 | Start two Workers at once | Both run. `lsof -iTCP -sTCP:LISTEN -n -P \| grep node` shows two bridge ports between 40000 and 60000. |
| 3.13 | A project with `pnpm install` to do (a package.json and lockfile) | The Worker's dependencies install. The log says "(in Cobra's sandbox)". |
| 3.14 | Ask a Foreman for a local check on the Worker's branch (`pnpm test` or the project's check) | It runs and reports. A check that starts its own server on loopback and connects to it fails on macOS: that is a known limit (SECURITY.md). |
| 3.15 | Settings → Engines: Lead on Codex, then `cobra-agent lead start` | The Lead starts and answers. `ps -axo command \| grep codex` shows it. A Codex Lead asked to `cat ~/.ssh/id_ed25519` reports "Operation not permitted". |
| 3.16 | Put the Lead back on Claude | It starts and answers. |
| 3.17 | Ask the Lead for a Codex Worker | It is refused with "Codex Workers do not run on macOS yet". |

## Step 4: signed releases

Use the files from a published release (docs/releasing.md), downloaded in
Safari, so macOS marks them as downloaded from the internet. Uninstall the
agent first (`cobra-agent uninstall`) and drag the old Cobra app to the Bin.

| # | Do | Pass when |
| --- | --- | --- |
| 4.1 | `shasum -a 256 -c --ignore-missing SHA256SUMS` in the Downloads folder | Each downloaded file says OK. |
| 4.2 | Open the `.dmg`, drag Cobra to Applications, open it | It opens with no warning about an unidentified developer and no "move to Bin". At most: "Cobra is an app downloaded from the internet. Open?" |
| 4.3 | `spctl --assess --type execute --verbose /Applications/Cobra.app` | "accepted" and "source=Notarized Developer ID". |
| 4.4 | Unpack the agent package (`tar -xzf cobra-agent-…-darwin-arm64.tar.gz`), then `./install.sh` in it | It ends with "Done". No dialog says a file "cannot be opened because the developer cannot be verified". |
| 4.5 | `find <package>/site-template/node_modules -name '*.node' \| head -1 \| xargs codesign --verify --strict --verbose=2` | "valid on disk" and "satisfies its Designated Requirement". |
| 4.6 | `cobra-agent desk`, connect the desk, write to your Lead | The Lead answers in the desk. |
| 4.7 | Settings → This app → Updates → Check for updates | "This is version x. It is the newest." |
| 4.8 | After the next release is published: Check for updates again, then Install and restart | It asks first, installs, and comes back on the new version. Settings shows it. |
