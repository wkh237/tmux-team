---
allowed-tools: Read(*), Bash(tmt:*), Bash(tmux-team:*)
description: Learn how to use tmux-team for multi-agent coordination
---

You need to learn how to use tmux-team, a CLI tool for coordinating multiple AI agents running in different tmux panes.

## What is tmux-team?

tmux-team enables AI agents (like Claude, Codex, Gemini) running in separate terminal panes to communicate with each other. Think of it as a messaging system for terminal-based AI agents.

## Core Concept

Each agent runs in its own tmux pane. When you want to talk to another agent:

1. Your message is pasted via a tmux buffer
2. tmux-team waits briefly, then sends Enter to submit
3. The recipient submits its complete final through `tmt reply`
4. Talk returns that retained body; `check` is a diagnostic snapshot only

## Essential Commands

```bash
# List active global identities
tmt list

# Send and wait for response (recommended); use a name or pane target
tmt talk <target> "<message>" --json

# Inspect output by name or pane target
tmt check <target> 100
```

## Practical Examples

### Quick question to another agent

```bash
tmt talk codex "What's the status of the authentication refactor?" --json
# Response is returned directly
```

### Delegate a task with a longer timeout

```bash
tmt talk codex "Please implement the login form. Reply when done." --timeout 300 --json
```

### Address a named identity

```bash
tmt talk codex "Sync: PR #123 was merged, please pull latest" --json
```

The name `all` is an ordinary identity, not a special destination. To address
another pane directly, use `%pane_id`, `window.pane`, or `session:window.pane`.

## Configuration

Durable identities live in SQLite, independent of the current working
directory; active presence also requires matching live tmux metadata.
The old `update`, `remove`/`rm`, and `migrate` commands are not supported in
v5. Bind explicitly with `name`/`this` or `add`; `unbind` detaches the current
pane without deleting its durable identity. Do not delete old user files as a
migration step. tmux-team is CLI-only and has no daemon or background service.

```bash
tmt name codex
tmt add %2 gemini
tmt config set pasteEnterDelayMs 500
```

To find your pane ID, run: tmux display-message -p '#{pane_id}'

## Waiting and retrieving results

Talk waits for a durable final by default, with 180 seconds unless configured.
Use positive seconds or ms/s suffixes, at most 24 hours, for `--timeout`.
Use `--detach` instead of explicit timeout to return a request ID after sending.
On timeout, preserve that ID and retrieve the result later:

```bash
tmt result <request-id> --json
tmt check <target> 200  # diagnostics only
```

`--wait` is retired; `--lines` belongs to check, not talk. Stored mode settings
are inert; `config clear mode` removes only that local obsolete key. Timeout
or interruption never cancels work or makes a resend safe. Transport/Enter
time counts after preparation/delay but cannot be interrupted mid-operation.
Markers, idle output and summaries never complete a request without a reply.
Same-pane input serialization and exactly-once processing are not guaranteed.

## Durable result replies

When TMT supplies an exact receipt, submit a complete response without tmux:

```bash
tmt reply <request-id> --receipt <receipt> --message 'Review complete.'
tmt reply <request-id> --receipt <receipt> --file response.md
tmt reply <request-id> --receipt <receipt> --stdin < response.md
tmt result <request-id> --json
```

Use `--message` for short replies, including an explicit empty string. Quote
the body for your shell; use `--message='-leading text'` for a leading hyphen.
Choose exactly one of `--message`, `--file`, or `--stdin`. Inline arguments
have operating-system size limits and cannot contain NUL; use file/stdin for
large bodies or NUL-containing text. All sources share the same exact-body
validation and immutable submission rules.

Received instructions group the reply command in `<tmt-reply>` tags, with the
request ID and receipt supplied once. These tags do not guarantee hidden UI
rendering and are not terminal-output completion markers. Replace the message
placeholder with your complete response, or use file/stdin with the same
request ID and receipt.

Use exactly one input source and the exact request ID/receipt from the received
talk instruction, including detached requests. Never manufacture a receipt,
select the latest request, or infer a pane. Submission confirms result
delivery, not task success; summarize only after a successful submission.

An identical retry keeps the original submission timestamp; a different body
is a conflict and cannot replace the stored response.

The receipt is local correlation, not remote authentication. Accepted bodies
are retained for seven days from submission; identical retry is safe only
while retained with the same receipt and body, not indefinitely. A missing
result does not cancel the work. Surface failed submission without a success
summary, and do not resubmit if final summarization fails after acceptance.

Bodies are exact valid UTF-8 up to 1 MiB, including empty, whitespace, BOM,
NUL, CR/LF, Unicode, and marker-like text. Stdin is EOF-driven with a
five-second deadline. `result` reports `RESPONSE_NOT_AVAILABLE` (exit 3) for
pending, unknown, or expired bodies; input errors exit 1, timeout exits 4,
and conflicts exit 5. JSON unavailable output is
`{status:"unavailable",requestId,error:{code:"RESPONSE_NOT_AVAILABLE",message}}`.

## Best Practices

1. Submit the full reply before giving a brief truthful work/tests/blockers summary
2. **Be explicit** - Tell the other agent exactly what you need and how to respond
3. **Set timeout appropriately** - Use --timeout 300 for complex tasks
4. **Use result for complete output** - Never reconstruct results from terminal capture
5. **If timeout occurs** - Use `tmt result <request-id> --json`; do not automatically resend
6. **Use stable pane IDs in scripts** - `tmt add` resolves window-style targets to `%pane_id`

## Your Next Step

Run `tmt list` to see all active global identities. Use `tmt list <target>` to
inspect one identity or pane.

Install integrations with `tmt install`. `tmt upgrade` updates the package, and
managed skill links then use the new bundled files automatically. Sending pane
input is an external action and must be authorized by the user; preserve
multiline text.

## View and install the bundled skill

`tmt learn --skill` prints the exact bundled universal skill; plain `tmt learn`
shows the guide. Both are text-only. Install default integrations with
`tmt install [claude|codex|gemini|all]`, or choose a skills root explicitly:

```bash
tmt install --dir ./my-skills
```

This links `./my-skills/tmux-team`; do not also specify a provider. Choose a
folder your provider actually discovers and reload its skills if needed.
Managed links follow bundled updates at the same package path. Re-run the same
install command to inspect/repair the target after relocation; existing
unmanaged content is preserved unless `--force` requests a recoverable backup.
Automatic drift reminders inspect known default paths, not custom folders.
They do not reload an active agent, update provider-managed plugins, or track
alpha release channels. Package upgrades and skill installation are separate
from provider discovery.
