---
allowed-tools: Bash(tmt:*), Bash(tmux-team:*)
description: Talk to peer agents in different tmux panes
---

Execute this command: `tmt $ARGUMENTS` (`tmt` is the short alias for `tmux-team`).

You are working in a multi-agent tmux environment.
Use the tmux-team CLI to communicate with other agents.

Registrations use tmux pane metadata as global active identities, independent
of the current working directory.

## Commands

```bash
# Send a message to a global identity or direct pane target
tmt talk codex "your message"
tmt talk gemini "your message"
tmt talk %12 "your message"

# Send with delay (useful for rate limiting)
tmt talk codex "message" --delay 5

# Send and wait for response (blocks until agent replies)
tmt talk codex "message" --wait --timeout 120

# Read response (default: 100 lines); names and pane targets are both valid
tmt check codex
tmt check %12 200

# List all active identities, or inspect one pane
tmt list
tmt list %12
tmt name backend                 # bind the current pane globally
tmt this reviewer                # exact alias for `name`
tmt add %12 backend              # bind an explicit pane by stable pane ID
tmt whoami
tmt unbind
```

Global identities are independent of the current folder. Names may be
undeclared; they do not need a configured role. `tmt add` resolves `%pane_id`,
`window.pane`, or `session:window.pane` targets before storing the stable pane
ID. Pane-title updates are best-effort presentation side effects only; there is
no panel-title command or daemon.

The `add` argument order is `tmt add <pane-target> <global-name>`. The legacy
name-first order is rejected with a usage error. The name `all` is an ordinary
identity, not a special destination.

## Workflow

1. Send message: `tmt talk codex "Review this code" --wait`
2. Wait 5-15 seconds (or use `--wait` flag)
3. Read response: `tmux-team check codex`
4. If response is cut off: `tmux-team check codex 200`

## Notes

- `talk` sends via tmux buffer paste, then waits briefly before Enter and
  preserves multiline text.
- Control the delay with `pasteEnterDelayMs` in config (default: 500)
- Use `--delay` instead of sleep (safer for tool whitelists)
- Use `--wait` for synchronous request-response patterns; use `check` after a
  timeout or when polling.
- Sending pane input is an external action requiring user authorization.
- Install integrations with `tmt install`. `tmt upgrade` updates the package;
  managed skill links then use the new bundled files automatically.
