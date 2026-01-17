---
name: tmux-team
description: Communicate with other AI agents in tmux panes. Use when you need to talk to codex, claude, gemini, or other agents.
---

When invoked, execute the tmux-team command with the provided arguments.

You are working in a multi-agent tmux environment.
Use the tmux-team CLI to communicate with other agents.

## Commands

```bash
# Send message to an agent
tmux-team talk codex "your message"
tmux-team talk gemini "your message"
tmux-team talk all "broadcast message"

# Send with delay (useful for rate limiting)
tmux-team talk codex "message" --delay 5

# Send and wait for response (blocks until agent replies)
tmux-team talk codex "message" --wait --timeout 120

# Read agent response (default: 100 lines)
tmux-team check codex
tmux-team check gemini 200

# List all configured agents
tmux-team list
```

## Workflow

1. Send message: `tmux-team talk codex "Review this code"`
2. Wait 5-15 seconds (or use `--wait` flag)
3. Read response: `tmux-team check codex`
4. If response is cut off: `tmux-team check codex 200`

## Notes

- `talk` sends via tmux buffer paste, then waits briefly before Enter
- Control the delay with `pasteEnterDelayMs` in config (default: 500)
- Use `--delay` instead of sleep (safer for tool whitelists)
- Use `--wait` for synchronous request-response patterns
- Run `tmux-team help` for full CLI documentation
