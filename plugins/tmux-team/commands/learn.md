---
allowed-tools: Read(*), Bash(tmux-team:*)
description: Learn how to use tmux-team for multi-agent coordination
---

You need to learn how to use tmux-team, a CLI tool for coordinating multiple AI agents running in different tmux panes.

## What is tmux-team?

tmux-team enables AI agents (like Claude, Codex, Gemini) running in separate terminal panes to communicate with each other. Think of it as a messaging system for terminal-based AI agents.

## Core Concept

Each agent runs in its own tmux pane. When you want to talk to another agent:
1. Your message is sent to their pane via tmux send-keys
2. They see it as if a human typed it
3. You read their response by capturing their pane output

## Essential Commands (use --wait for better token utilization)

```bash
# List available agents in this project
tmux-team list

# Send and wait for response (recommended)
tmux-team talk <agent> "<message>" --wait

# Broadcast to all agents
tmux-team talk all "<message>" --wait
```

## Practical Examples

### Quick question to another agent
```bash
tmux-team talk codex "What's the status of the authentication refactor?" --wait
# Response is returned directly
```

### Delegate a task with longer timeout
```bash
tmux-team talk codex "Please implement the login form. Reply when done." --wait --timeout 300
```

### Broadcast to all agents
```bash
tmux-team talk all "Sync: PR #123 was merged, please pull latest" --wait
```

## Configuration

tmux-team is configured via tmux-team.json in your project root:

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

To find your pane ID, run: tmux display-message -p '#{pane_id}'

## Best Practices

1. **Always use --wait** - More token-efficient than polling with check command
2. **Be explicit** - Tell the other agent exactly what you need and how to respond
3. **Set timeout appropriately** - Use --timeout 300 for complex tasks
4. **Broadcast sparingly** - Only use "talk all" for announcements everyone needs

## Your Next Step

Run tmux-team list to see which agents are available in your current project.
