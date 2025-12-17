# tmux-team

CLI tool for AI agent collaboration in tmux. Manage cross-pane communication between multiple AI agents (Claude, Codex, Gemini, etc.) working in different tmux panes.

## Installation

```bash
npm install -g tmux-team
```

## Requirements

- tmux
- jq (`brew install jq` on macOS)
- zsh or bash

## Quick Start

```bash
# Initialize config in your project
cd your-project
tmux-team init

# Add agents
tmux-team add codex 10.1 "Code review specialist"
tmux-team add gemini 10.3 "Implementation engineer"

# Send message to an agent
tmux-team talk codex "Please review the PR"

# Read agent's response
tmux-team check codex
```

## Commands

| Command | Description |
|---------|-------------|
| `tmux-team help` | Show help message |
| `tmux-team init` | Create empty tmux-team.json |
| `tmux-team init-claude` | Install Claude Code slash command |
| `tmux-team list` | List all configured agents |
| `tmux-team add <name> <pane> [remark]` | Add a new agent |
| `tmux-team update <name> [options]` | Update agent config |
| `tmux-team remove <name>` | Remove an agent |
| `tmux-team talk <target> <message>` | Send message to agent |
| `tmux-team check <target> [lines]` | Read agent's output |

## Configuration

Agent pane mappings are stored in `./tmux-team.json`:

```json
{
  "codex": { "pane": "10.1", "remark": "Code review specialist" },
  "gemini": { "pane": "10.3", "remark": "Implementation engineer" }
}
```

## Usage Examples

### Basic workflow

```bash
# Send a message
tmux-team talk codex "Hi, can you review the authentication module?"

# Wait a few seconds for response...

# Read the response
tmux-team check codex

# If response is truncated, read more lines
tmux-team check codex 200
```

### Broadcast to all agents

```bash
tmux-team talk all "Sync meeting in 5 minutes"
```

### Update agent configuration

```bash
# Change pane
tmux-team update codex --pane 10.2

# Change remark
tmux-team update codex --remark "New description"
```

## Finding tmux pane IDs

To find the pane ID for an agent:

```bash
# List all panes with their IDs
tmux list-panes -a

# Output format: session:window.pane
# Example: 10:0.1 means session 10, window 0, pane 1
```

## Claude Code Integration

### Option 1: Plugin Marketplace (Recommended)

Install from GitHub using Claude Code's plugin system:

```
/plugin marketplace add anthropics/tmux-team
/plugin install tmux-team@tmux-team
```

Then use:

```
/team codex "please review this PR"
/team gemini "how is progress?"
```

### Option 2: Manual Installation

```bash
tmux-team init-claude
```

This creates `~/.claude/commands/tmux/team.md`, enabling:

```
/tmux/team codex "please review this PR"
/tmux/team gemini "how is progress?"
```

## License

MIT
