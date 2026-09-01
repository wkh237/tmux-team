---
allowed-tools: Bash(tmt:*), Bash(tmux-team:*)
description: Talk to peer agents in different tmux panes
---

Execute this command: `tmt $ARGUMENTS` (`tmt` is the short alias for `tmux-team`).

You are working in a multi-agent tmux environment.
Use the tmux-team CLI to communicate with other agents.

Registrations use tmux pane metadata, scoped to the current workspace unless
`--team <name>` selects an explicit cross-folder team.

## Commands

```bash
# Send message to an agent
tmt talk codex "your message"
tmt talk gemini "your message"
tmt talk all "broadcast message"

# Send with delay (useful for rate limiting)
tmt talk codex "message" --delay 5

# Send and wait for response (blocks until agent replies)
tmt talk codex "message" --wait --timeout 120

# Read agent response (default: 100 lines)
tmt check codex
tmt check gemini 200

# List all configured agents
tmt list
tmt name backend
tmt team panes
```

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
