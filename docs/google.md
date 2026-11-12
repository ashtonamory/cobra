# Google

Cobra has no Google connection of its own. Gmail, Google Calendar and Google
Drive come through the connectors of the Claude account that Claude Code is
signed in to on this computer.

## Connect

1. Open [claude.ai → Settings → Connectors](https://claude.ai/settings/connectors).
2. Connect Gmail, Google Calendar and Google Drive (any of them).
3. In the desk app, open Settings → Integrations → Google and press Refresh.
   It shows which of the three the agent sees.
4. Start a new conversation with the Lead. A Lead or Foreman that is already
   running gets the connectors at its next start.

## What the agents can do

- **Read without asking:** search mail, read a thread or a message, list
  labels and drafts, list calendars, read and search events, suggest a time.
- **Ask first:** send, reply, forward, trash, label, mark as spam, make a
  draft, and make, change, delete or answer an event. Each of these stops,
  and the desk shows an approval card. Nothing runs until you allow it.
- Drive's tools ask first until Cobra knows which of them only read.

Mail, events and files are other people's text. The agents treat them as
data and never as instructions.

## How it works

The Lead and the Foremen start Claude Code with `--restricted` instead of
`--strict-mcp-config`. That keeps out your own MCP servers, plugins and
Claude Code settings, but lets in the connectors of your Claude account.
The agent runs `claude mcp list` (at its start and when the desk asks) and
denies every connector that is not Gmail, Calendar or Drive by name, so a
Lead never sees, for example, Canva or Figma. The read tools above are
pre-allowed; every other tool from a connector needs your Allow.

Workers, jobs and the voice line still start with no MCP server at all.

## Codex

A Lead or Foreman on Codex does not use Google yet: Cobra starts Codex with
its apps (ChatGPT's connectors) turned off (`codexRuntime.ts`). Codex
can turn on only Gmail, Calendar and Drive and allow only their read tools
(`apps._default.enabled=false`, then `apps.<id>.enabled`,
`apps.<id>.default_tools_enabled=false` and
`apps.<id>.tools.<name>.enabled` per read tool). That way, a write does not
exist for the model. This comes once it is tested against a ChatGPT account
that has the connectors.

## What Cobra does not do itself

Cobra holds no Google sign-in, so its own tools never reach Google:

- **Email it sends** (a Foreman's email, branded email, campaigns) goes
  from a mailbox you choose for the Space in Settings → Mailboxes. A Space
  with no mailbox sends nothing, and the agent says so.
- **Mail it reads and tidies** with its own tools (`mail_search`,
  `mail_read`, `mail_organize`) is that same mailbox. Gmail is read through
  the Gmail connector above.
- **Files** a Foreman hands over are copied to a folder on this computer
  that you set up, after your Allow. Nothing is saved to Google Drive.
- **Lists you keep in a Google Sheet** come in as a `.csv` file you
  download. Cobra keeps no copy of your records in a sheet.

## Other mailboxes

iCloud and Zoho mail go through IMAP and SMTP: Settings → Mailboxes.
