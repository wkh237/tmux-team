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
tmt talk <target> "<message>" --wait

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
tmt reply <request-id> --receipt <receipt> --file response.md
tmt reply <request-id> --receipt <receipt> --stdin < response.md
tmt result <request-id> --json
```

Use exactly one input source. Use the supplied receipt; never manufacture one,
look up the latest request, or infer a current pane. `talk` remains
marker-based in this release and does not generate receipts; receipt
generation and durable completion are staged for TMT-39. There is no
`--detach` behavior yet. A successful submission confirms delivery of the
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
You run: tmt talk codex "Please review the auth module and share your findings" --wait

User says: "ask gemini about the test coverage"
You run: tmt talk gemini "What is the current test coverage status?" --wait

User says: "ask codex to review the refactor"
You run: tmt talk codex "Please review the refactor before I continue." --wait

## Options

For long responses, increase timeout and lines captured:

tmt talk <target> "<message>" --wait --timeout 300 --lines 200

## If --wait Times Out

Use the check command to retrieve the response with an optional line count:

tmt check <target>
tmt check <target> 200

## Important

- Use `--wait` when the user asks for a synchronous answer; `check` can read a
  response later after timeout.
- Craft clear, specific messages for the other agent
- Preserve multiline messages and do not send pane input without authorization
- After receiving a response, summarize it for the user
