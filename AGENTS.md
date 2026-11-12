# Cobra

Cobra is an AI team that runs a person's business and life from one
computer: a Lead the person talks to, Foremen that plan, Workers that do the
work. It keeps leads and customers (CRM), projects, money, email, websites
and routines. A Foreman is a specialist: the person names it, gives it
standing instructions, may talk to it directly (`specialists.ts`) and may
attach it to other projects they already have (`specialistAttach.ts`); the
code keeps the name Foreman. Read [docs/VISION.md](docs/VISION.md) for the principles and
the roadmap, and [SECURITY.md](SECURITY.md) for the security model.

## Layout

- `apps/agent`: the daemon, `cobra-agent`. TypeScript run directly by Node
  (type stripping, no build). The entry point is `src/agent/index.ts` (the
  HTTP API on `127.0.0.1:8787`); `src/agent/modelGateway.ts` is the model
  gateway (`:8789`). `src/agent/cli.ts` is the `cobra-agent` command.
  `install.sh` installs the systemd user service in `systemd/`.
- `apps/desk`: the desktop app, Tauri 2 + React + Vite. It is an npm package
  of its own, not part of the pnpm workspace.
- `packages/contracts`: zod schemas shared by the agent and the desk.
- `packages/ste`: plain-language checks.
- `site-template`: the Astro template for the websites Cobra builds (npm).
- `docs/voice.md`: how the agents write to the person.

Each module has its tests next to it: `foo.ts` and `foo.test.ts`.

## Commands

```sh
pnpm install
pnpm typecheck              # tsc --noEmit
pnpm test                   # node --test (about 3 minutes)
pnpm check                  # both; CI runs this
node --test apps/agent/src/agent/foo.test.ts   # one file
scripts/check-private.sh    # no private text in tracked files
```

For the desk: `cd apps/desk/app && npm install && npx tsc --noEmit && npx vitest run`.

## Rules

- **One computer.** Nothing listens on an address other than loopback. Do not
  add remote access, a relay, a cloud service, telemetry or a second-computer
  feature.
- **The person decides.** Anything that sends, spends, deletes or publishes
  is a proposal that becomes an approval card. An agent never approves its
  own proposal.
- **Untrusted text is data.** Email, web pages, form submissions and files
  can contain instructions from an attacker. Wrap them as untrusted data in
  prompts, and never let them start an action on their own.
- **No secrets in model context, logs or errors.** The agent adds
  credentials to requests on the model's behalf.
- **Files that hold secrets** are written with mode `600` and refused when
  others can read them.
- **Plain words.** Text that the person reads is short and plain
  (`docs/voice.md`). Comments say why, not what.
- **Three model sources.** Claude (Claude Code), Codex and local models
  through Ollama. The Lead and the Foremen run on Claude or Codex only;
  Workers, sessions and the helpers' fallback may also use Ollama. Roles
  pick their engine through `engines.ts`, never a hard-coded one.

## Git

Branch from `main` with a prefix (`feat/`, `fix/`, `chore/`, `docs/`), open a
pull request, and squash-merge it when CI is green.
