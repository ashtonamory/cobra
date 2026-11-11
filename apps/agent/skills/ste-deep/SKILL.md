---
name: ste-deep
description: Deep answers in ASD-STE100 Simplified Technical English, with Mermaid flow diagrams, checked by ste-check. Use when a question needs more than a short reply (several steps that depend on each other, a failure path, a decision with trade-offs, or facts to look up). Offer it first and write the report only after the user approves. Also use when the user asks for a deep answer, an STE report, or to "go deeper".
---

# Deep answers in STE

Cobra's deep answers, on a computer. The phone and the desktop show your
question to the user as a needs-you, and show the finished report as markdown.
The rules and the report format come from `ste-check`, so this skill and
`ste-check` always write the same thing.

## 1. Answer briefly, then offer

Give the short answer first. Then ask with AskUserQuestion:

- question: `Go deeper? <one sentence: why a deep answer would help>`
- options: `Approve` (description: `A researched STE report with <n> diagram(s), about 2 to 5 minutes`) and `Not now`

Do not offer for small talk, for a simple fact, or when the short answer is
complete. If the user asked for a deep answer, skip the offer and start.
Stop at `Not now`.

## 2. Research

Look up anything that could be out of date with WebSearch and WebFetch, and
prefer primary sources: manuals, official documentation, and the code and
files on this computer. Read a file rather than guess what it says. Keep the
URL of every page you use.

## 3. Write the report

Run `ste-check --rules`, and follow the rules and the JSON format it prints
exactly. Write the report to:

```
~/.local/share/cobra-agent/reports/<yyyy-mm-dd>-<short-slug>/report.json
```

- Cite sources inline as `[1]`, `[2]` in the order of `sources`.
- Put commands, paths and code in backticks, and screen labels in double quotes.
- A WARNING (risk to people) or CAUTION (risk to data or equipment) goes in the
  `before` list of the step it applies to.
- Diagrams are Mermaid `flowchart`, `sequenceDiagram` or `stateDiagram-v2`.
  Keep labels short, quote a label with punctuation, and set no colors.

## 4. Check, and revise once

```
ste-check <dir>/report.json --markdown <dir>/report.md
```

- Exit 0: clean.
- Exit 1: fix each violation it lists, once. A check marked `?` is a heuristic:
  keep the sentence if it is correct STE. Run `ste-check` again and stop, even
  if some notes remain.
- Exit 2: the JSON is not a valid report. Fix what the message says and run it
  again.

Do not change facts or sources to pass a check.

## 5. Reply

Reply with the contents of `report.md` (the diagrams are in `mermaid` fences)
and the folder it is in. Then one line from the last `ste-check` output: how
many notes remain, and, when it says no dictionary is loaded, that the word
choice was guided, not checked.
