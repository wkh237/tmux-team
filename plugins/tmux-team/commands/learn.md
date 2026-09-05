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
3. You read their response by capturing their pane output

## Essential Commands

```bash
# List active global identities
tmt list

# Send and wait for response (recommended); use a name or pane target
tmt talk <target> "<message>" --wait

# Inspect output by name or pane target
tmt check <target> 100
```

## Practical Examples

### Quick question to another agent

```bash
tmt talk codex "What's the status of the authentication refactor?" --wait
# Response is returned directly
```

### Delegate a task with longer timeout and more output

```bash
tmt talk codex "Please implement the login form. Reply when done." --wait --timeout 300 --lines 200
```

### Address a named identity

```bash
tmt talk codex "Sync: PR #123 was merged, please pull latest" --wait
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

## If --wait Times Out

If the agent takes longer than expected, --wait will timeout. Use the check command to retrieve the response later:

```bash
# Check for response after timeout (default 100 lines)
tmt check <target>

# Check with more lines for long responses
tmt check <target> 200
```

## Durable result replies

When TMT supplies an exact receipt, submit a complete response without tmux:

```bash
tmt reply <request-id> --receipt <receipt> --file response.md
tmt reply <request-id> --receipt <receipt> --stdin < response.md
tmt result <request-id> --json
```

Use exactly one input source and never manufacture a receipt, select the latest
request, or infer a pane. `talk` is still marker-based in this release and
does not generate receipts; TMT-39 owns receipt generation and durable
completion. There is no `--detach` behavior yet. Submission confirms result
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

1. Use `--wait` for synchronous request/response; use `check` after timeout
2. **Be explicit** - Tell the other agent exactly what you need and how to respond
3. **Set timeout appropriately** - Use --timeout 300 for complex tasks
4. **Use --lines for long responses** - Default is 100 lines, increase for verbose output
5. **If timeout occurs** - Use "tmux-team check <target> [lines]" to retrieve the response
6. **Use stable pane IDs in scripts** - `tmt add` resolves window-style targets to `%pane_id`

## Your Next Step

Run `tmt list` to see all active global identities. Use `tmt list <target>` to
inspect one identity or pane.

Install integrations with `tmt install`. `tmt upgrade` updates the package, and
managed skill links then use the new bundled files automatically. Sending pane
input is an external action and must be authorized by the user; preserve
multiline text.
