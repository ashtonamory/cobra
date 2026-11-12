# Vision

Cobra gives one person the team a small business has: an assistant who
listens, managers who plan and workers who do the work. It keeps the leads,
the customers, the projects, the money, the email and the websites of a
business, and the routines of a life, on one computer that the person owns.

## Principles

1. **One computer.** No cloud, no relay, no account with us. The person's
   data stays on the person's computer.
2. **The person decides.** An agent proposes; the person allows. Anything
   that sends, spends, deletes or publishes waits for a yes.
3. **Your choice of model.** Claude, Codex, or a local model through
   Ollama. The person picks for each role, and can change.
4. **Your assistant, your name.** The Lead is called Cobra until the person
   gives it a name.
5. **Connectors, not integrations.** Google, Stripe and the rest are reached
   through MCP connectors that the person adds.
6. **Secure by default.** Secrets stay out of the model's context, and text
   from outside cannot make an agent act.
7. **A team you can see.** Each manager is a specialist with a name, one
   job and the person's standing instructions. The person talks to any of
   them directly; the Lead is the one manager over all of it for when they
   want one.

## Roadmap

| Phase | What | State |
| --- | --- | --- |
| 1 | Fork, scrub and rename. Single computer only: remove the phone, the relay, the cloud and the fleet. | Done |
| 2 | Security: keychain + AES-GCM secrets, no secrets in model context, taint gate, append-only audit log, CSP-sandboxed pages ([plan](plans/phase-2-security.md)). | Done; open items in [SECURITY.md](../SECURITY.md) |
| 3 | Models (Claude, Codex, Ollama), macOS (including a Worker sandbox), installers (one-line install, signed GitHub Releases, `SETUP_PROMPT.md`) ([plan](plans/phase-3.md)). | Models and signed releases done. macOS built, not yet tested. Installers next. |
| 4 | The roster: each Foreman is a specialist the person names, instructs and talks to; then memory, routines and keys of its own. | Started: the record, the card, the visible roster, and attaching a specialist to a project the person already has. |

The first public release is Linux only. macOS follows when it has been tested
on a Mac.
