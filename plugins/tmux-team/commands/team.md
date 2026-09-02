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
