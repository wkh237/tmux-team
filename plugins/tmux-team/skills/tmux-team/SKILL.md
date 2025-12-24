---
name: tmux-team
description: Coordinate with other AI agents running in tmux panes. Use this skill when you need to delegate tasks, request reviews, or collaborate with agents like Codex, Gemini, or other Claude instances.
---

# Multi-Agent Coordination with tmux-team

You are working in a multi-agent tmux environment. Use the `tmux-team` CLI to communicate with other AI agents running in different panes.

## When to Use This Skill

- Delegating specialized tasks to other agents (e.g., "Ask Codex to review this code")
- Broadcasting messages to all agents
- Checking responses from agents you've messaged
- Coordinating parallel work across multiple agents

## Commands

```bash
# Send message to an agent
tmux-team talk codex "your message"
tmux-team talk gemini "your message"

# Broadcast to all agents
tmux-team talk all "message for everyone"

# Send and wait for response (synchronous)
tmux-team talk codex "message" --wait --timeout 120

# Read agent's latest response
tmux-team check codex
tmux-team check gemini 200  # more lines

# List configured agents
tmux-team list
```

## Workflow

1. Send message: `tmux-team talk codex "Review this authentication code"`
2. Wait for response (use `--wait` flag or wait 5-15 seconds)
3. Read response: `tmux-team check codex`
4. If response is truncated: `tmux-team check codex 200`

## Tips

- Use `--wait` for synchronous request-response patterns
- Use `--delay 5` to add delay between messages (rate limiting)
- Run `tmux-team help` for full CLI documentation
