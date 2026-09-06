---
allowed-tools: Bash(tmt:*), Bash(tmux-team:*)
description: Talk to peer agents in different tmux panes
---

You are working in a multi-agent tmux environment with other AI agents running in different tmux panes. The user wants you to coordinate with them.

## Your Task

Interpret the user's request: $ARGUMENTS

Based on what the user wants, use the tmux-team CLI to coordinate with other agents.

## How to Coordinate

To send a message to a global identity or direct pane target and wait for a
response:
tmt talk <target> "<message>" --json

To see available agents:
tmt list
tmt name <global-name>
tmt this <global-name>
tmt add <pane-target> <global-name>
tmt whoami
tmt unbind

Identities are global across working directories. `list`, `talk`, and `check`
accept either a global name or a direct pane target (`%pane_id`, `window.pane`,
or `session:window.pane`). The name `all` is an ordinary identity, not a
special destination. The `add` order is pane target first, then global name;
the old name-first order is rejected with a usage error.

## Durable result replies

When TMT gives you a receipt, submit the complete response through the
storage-only result adapter:

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

Use exactly one input source and the request ID/receipt supplied by `talk`,
including detached requests. Never manufacture a receipt, look up the latest
request, or infer a current pane. A successful submission confirms delivery of the
body, not success of the requested task, so give a truthful summary only
after submission.

An identical retry for the same request and attempt keeps the original
submission timestamp. A different body is a conflict and cannot replace the
stored response.

The receipt is local correlation, not remote authentication. Accepted bodies
are retained for seven days from submission; identical retry is safe only
while retained with the same receipt and body, not indefinitely. A missing
result does not cancel the work. Surface failed submission without a success
summary, and do not resubmit if final summarization fails after acceptance.

The body is exact valid UTF-8 up to 1 MiB, including empty, whitespace, BOM,
NUL, CR/LF, Unicode, and marker-like text. Stdin is EOF-driven with a five-
second input deadline. `result` reports `RESPONSE_NOT_AVAILABLE` (exit 3) for
pending, unknown, or expired bodies; input errors exit 1, input timeout exits
4, and conflicts exit 5. JSON unavailable output is
`{status:"unavailable",requestId,error:{code:"RESPONSE_NOT_AVAILABLE",message}}`.

## Examples

User says: "tell codex to review the auth module"
You run: tmt talk codex "Please review the auth module and share your findings" --json

User says: "ask gemini about the test coverage"
You run: tmt talk gemini "What is the current test coverage status?" --json

User says: "ask codex to review the refactor"
You run: tmt talk codex "Please review the refactor before I continue." --json

## Options

Talk waits for a complete durable final by default (180 seconds unless configured).
Timeout accepts positive seconds or ms/s suffixes, at most 24 hours. For longer work:

tmt talk <target> "<message>" --timeout 300 --json

Use `--detach` instead of explicit timeout to return the request ID after sending.
`--wait` is retired; `--lines` belongs to diagnostic `check`, not `talk`.
Stored mode settings are inert; `config clear mode` removes only the local key.

## If talk times out

Preserve the request ID and retrieve the final later:

```bash
tmt result <request-id> --json
tmt check <target> 200  # diagnostics only, not full result retrieval
```

Timeout and interruption end only the observer, not recipient work. Transport/Enter
time counts after preparation/delay, but synchronous transport cannot be cancelled
mid-operation. No reply means no durable final; idle output, markers and summaries
do not complete a request. Same-pane input serialization is not guaranteed.

## Important

- Wait by default, or detach and use `result` later; do not automatically resend
  on timeout, cleanup failure or `DELIVERY_UNCERTAIN` (exit 1).
- Craft clear, specific messages for the other agent
- Preserve multiline messages and do not send pane input without authorization
- After receiving a response, summarize it for the user

## Command option scope

Options apply only to commands that use them. `--timeout`, `--delay`,
`--detach`, and `--no-preamble` belong to talk/send; `--lines` belongs to
check/read; `--force` belongs to talk/send and install. Unrelated options
and the unsupported `--config` path override fail with `USAGE_ERROR` before
execution. Use `tmt help` for the command-specific option inventory.

Meaningful common options may precede the command, such as
`tmt --timeout 30 talk reviewer "Review this"`. Put command-local options
such as reply `--receipt` or install `--dir` after their command. Use `--`
before a positional message beginning with a hyphen, or equals syntax for
an option value, such as `--message='--json is literal text'`. Literal text
does not enable diagnostic flags. Reply/result accept only their documented
options; `--verbose` and `--debug` are not supported there.

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
