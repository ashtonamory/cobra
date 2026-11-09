<img src="assets/icon.svg" width="64" height="64" alt="">

# Cobra

Cobra is an AI team that runs your business and your life from one computer.

You talk to one assistant, your Lead. You name it; the default name is Cobra.
The Lead hands the work to managers (Foremen), who run Workers. Together they
keep your leads and customers (CRM), your projects and tasks, your money, your
email, your websites and your routines. Anything that sends, spends or
publishes waits for you to allow it.

Cobra is not a coding harness. It is a business-and-life harness that uses
coding agents (Claude Code, Codex and others) as its workforce.

> **Status: early preview, Linux only.** Cobra is tested on Arch Linux
> (Omarchy). macOS support is built but not yet tested; it comes in a later
> release. See [docs/VISION.md](docs/VISION.md). Read
> [SECURITY.md](SECURITY.md) before you give it real accounts.

## What runs where

Everything runs on your computer. There is no Cobra cloud, no relay and no
phone app. Nothing listens on a network address other than `127.0.0.1`.

| Part | What it is |
| --- | --- |
| `apps/agent` | The daemon (`cobra-agent`): an HTTP API on `127.0.0.1:8787`, a terminal gateway on `:8788` and a model gateway on `:8789`. It runs the agents in tmux sessions. |
| `apps/desk` | The desktop app (Tauri 2 + React). It is how you talk to your Lead and allow or refuse what the agents propose. |
| `packages/contracts` | The shapes (zod) that the agent and the desk share. |
| `packages/ste` | Plain-language checks for the text the agents write. |
| `site-template` | The Astro template for the websites Cobra builds. |

## Requirements

- Linux with systemd user services. Tested on Arch Linux (Omarchy). macOS
  is not supported yet.
- Node.js 22.18 or later, pnpm, tmux, git.
- At least one agent CLI: `claude` (Claude Code) or `codex`.
- `bubblewrap` (`bwrap`) to contain Workers.
- `notify-send` for desktop notifications (optional).

## Install from a release

Each [release](../../releases) has the agent
package (`cobra-agent-<version>-linux-x64.tar.gz` or `-linux-arm64`) and the
desk app (`.deb` or `.AppImage`). Check the files against `SHA256SUMS`, then:

```sh
tar xzf cobra-agent-<version>-linux-x64.tar.gz
cd cobra-agent-<version>-linux-x64
./install.sh                    # installs and starts the cobra-agent user service
```

Then install and open the desk app.

## Install from source

```sh
git clone <this repository's URL> cobra
cd cobra
pnpm install
pnpm check                      # typecheck and tests
./apps/agent/install.sh         # installs and starts the cobra-agent user service
```

Then open the desk app. It makes its own key with `cobra-agent desk`.

To build the desk app:

```sh
cd apps/desk/app
npm install
npm run tauri build
```

## Development

```sh
pnpm typecheck   # tsc --noEmit
pnpm test        # node --test over packages and apps/agent
pnpm check       # both
```

The agent runs TypeScript directly with Node (type stripping). No build step.
See [AGENTS.md](AGENTS.md) for the layout and the rules, and
[CONTRIBUTING.md](CONTRIBUTING.md) to send a change.

## License

MIT. See [LICENSE](LICENSE).
