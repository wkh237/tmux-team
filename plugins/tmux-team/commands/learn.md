---
allowed-tools: Read(*), Bash(tmux-team:*)
description: Learn how to use tmux-team for multi-agent coordination
---

You need to learn how to use tmux-team, a CLI tool for coordinating multiple AI agents running in different tmux panes.

## What is tmux-team?

tmux-team enables AI agents (like Claude, Codex, Gemini) running in separate terminal panes to communicate with each other. Think of it as a messaging system for terminal-based AI agents.

## Core Concept

Each agent runs in its own tmux pane. When you want to talk to another agent:
1. Your message is sent to their pane via `tmux send-keys`
2. They see it as if a human typed it
3. You read their response by capturing their pane output

## Essential Commands

```bash
# List available agents in this project
tmux-team list

# Send a message to an agent
tmux-team talk <agent> "<message>"

# Check an agent's response (captures their pane output)
tmux-team check <agent> [lines]

# Send and wait for response (synchronous)
tmux-team talk <agent> "<message>" --wait --timeout 120

# Broadcast to all agents
tmux-team talk all "<message>"
```

## Practical Examples

### Quick question to another agent
```bash
tmux-team talk codex "What's the status of the authentication refactor?"
# Wait a few seconds...
tmux-team check codex
```

### Synchronous request-response
```bash
tmux-team talk gemini "Review this function for security issues" --wait
# Returns when gemini completes their response
```

### Delegate a task
```bash
tmux-team talk codex "Please implement the login form. Reply when done." --wait --timeout 300
```

## Configuration

tmux-team is configured via `tmux-team.json` in your project root:

```json
{
  "$config": {
    "mode": "polling"
  },
  "codex": { "pane": "%1", "remark": "OpenAI Codex agent" },
  "gemini": { "pane": "%2", "remark": "Google Gemini agent" },
  "claude": { "pane": "%3", "remark": "Anthropic Claude agent" }
}
```

To find your pane ID, run: `tmux display-message -p '#{pane_id}'`

## Best Practices

1. **Be explicit** - Tell the other agent exactly what you need and how to respond
2. **Use --wait for important tasks** - Ensures you get the complete response
3. **Check response length** - Use `tmux-team check <agent> 200` for longer responses
4. **Broadcast sparingly** - Only use `talk all` for announcements everyone needs

## Your Next Step

Run `tmux-team list` to see which agents are available in your current project.
