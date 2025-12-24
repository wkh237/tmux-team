---
allowed-tools: Bash(tmux-team:*)
description: Talk to peer agents in different tmux panes
---

You are working in a multi-agent tmux environment with other AI agents running in different tmux panes. The user wants you to coordinate with them.

## Your Task

Interpret the user's request: $ARGUMENTS

Based on what the user wants, use the tmux-team CLI to coordinate with other agents.

## How to Coordinate

To send a message to an agent and wait for their response:
  tmux-team talk <agent> "<message>" --wait

To broadcast to all agents:
  tmux-team talk all "<message>" --wait

To see available agents:
  tmux-team list

## Examples

User says: "tell codex to review the auth module"
You run: tmux-team talk codex "Please review the auth module and share your findings" --wait

User says: "ask gemini about the test coverage"
You run: tmux-team talk gemini "What is the current test coverage status?" --wait

User says: "let everyone know we are starting the refactor"
You run: tmux-team talk all "Starting the refactor now. Please hold off on conflicting changes." --wait

## If --wait Times Out

If the agent takes longer than expected, --wait will timeout. Use the check command to retrieve the response later:

  tmux-team check <agent>

You can also increase the timeout for complex tasks:

  tmux-team talk <agent> "<message>" --wait --timeout 300

## Important

- Always use --wait flag for better token efficiency
- Craft clear, specific messages for the other agent
- After receiving a response, summarize it for the user
