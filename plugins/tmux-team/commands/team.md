---
allowed-tools: Bash(tmux-team:*), Bash(./bin/tmux-team:*)
description: Talk to peer agents in different tmux panes
---

$ARGUMENTS

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

## Project Management

```bash
# Initialize a team/project
tmux-team pm init --name "My Project"

# Milestones
tmux-team pm m add "Phase 1"
tmux-team pm m list
tmux-team pm m done 1

# Tasks
tmux-team pm t add "Implement feature" --milestone 1
tmux-team pm t list --status pending
tmux-team pm t update 1 --status in_progress
tmux-team pm t done 1

# View audit log
tmux-team pm log --limit 10
```

## Workflow

1. Send message: `tmux-team talk codex "Review this code"`
2. Wait 5-15 seconds (or use `--wait` flag)
3. Read response: `tmux-team check codex`
4. If response is cut off: `tmux-team check codex 200`

## Notes

- `talk` automatically sends Enter key after the message
- `talk` automatically filters exclamation marks for Gemini (TTY issue)
- Use `--delay` instead of sleep (safer for tool whitelists)
- Use `--wait` for synchronous request-response patterns
- Run `tmux-team help` for full CLI documentation
