---
allowed-tools: Bash(tmux-team:*)
description: Talk to peer agents in different tmux panes
---

$ARGUMENTS

You are working in a multi-agent tmux environment.
Use the `tmux-team` CLI to communicate with other agents.

## Commands

```bash
# Send message to an agent
tmux-team talk codex "your message"
tmux-team talk gemini "your message"
tmux-team talk all "broadcast message"

# Read agent's response (default: 100 lines)
tmux-team check codex
tmux-team check gemini

# Read more lines if needed
tmux-team check codex 200

# List all configured agents
tmux-team list
```

## Workflow

1. Send message: `tmux-team talk codex "Hi, how is progress?"`
2. Wait for response (5-15 seconds depending on complexity)
3. Read response: `tmux-team check codex`
4. If response is cut off, increase lines: `tmux-team check codex 200`

## Notes

- `tmux-team talk` automatically sends Enter key after the message
- `tmux-team talk` automatically filters `!` for Gemini (avoids bash mode trigger)
- Run `tmux-team help` for full CLI documentation
