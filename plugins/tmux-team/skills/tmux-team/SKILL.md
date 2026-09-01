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
# Send and wait for response (recommended)
tmt talk codex "your message" --wait
tmt talk gemini "your message" --wait --timeout 120

# Broadcast to all agents
tmt talk all "message for everyone" --wait

# List configured agents
tmt list
tmt name backend
tmt team add project codex %12
```

## Workflow

The `--wait` flag blocks until the agent responds, returning the response directly:

```bash
tmux-team talk codex "Review this authentication code" --wait
# Response is returned directly - no need for a separate check command
```

## Tips

- Use `--wait` when the user needs a response before continuing; use `check`
  after a timeout or for polling.
- `tmt name` sets a visible pane title. `team` commands manage registrations
  shared across folders; ordinary commands use the current workspace.
- Preserve multiline text. Sending input to another pane is an external action
  and requires user authorization; do not infer permission to send commands.
- Install integrations with `tmt install`. `tmt upgrade` updates the package;
  managed skill links then use the new bundled files automatically.
