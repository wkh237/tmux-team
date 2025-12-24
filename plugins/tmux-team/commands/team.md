---
allowed-tools: Bash(tmux-team:*)
description: Talk to peer agents in different tmux panes
---

Execute this tmux-team command: `tmux-team $ARGUMENTS`

You are working in a multi-agent tmux environment.
Use the tmux-team CLI to communicate with other agents.

## Commands (use --wait for better token utilization)

```bash
# Send and wait for response (recommended)
tmux-team talk codex "your message" --wait
tmux-team talk gemini "your message" --wait --timeout 120

# Broadcast to all agents
tmux-team talk all "broadcast message" --wait

# Send with delay (useful for rate limiting)
tmux-team talk codex "message" --wait --delay 5

# List all configured agents
tmux-team list
```

## Workflow

The `--wait` flag blocks until the agent responds, returning the response directly:

```bash
tmux-team talk codex "Review this code" --wait
# Response is returned directly - no need for a separate check command
```

## Notes

- **Always use `--wait`** - it's more token-efficient than polling with `check`
- `talk` automatically sends Enter key after the message
- `talk` automatically filters exclamation marks for Gemini (TTY issue)
- Use `--delay` to add delay between messages (rate limiting)
- Run `tmux-team learn` for a comprehensive guide
