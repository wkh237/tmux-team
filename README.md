# tmux-team

CLI for multi-agent collaboration in tmux. Coordinate AI agents (Claude, Codex, Gemini) working in different panes.

## Installation

```bash
npm install -g tmux-team
```

### Shell Completion

```bash
# Zsh (add to ~/.zshrc)
eval "$(tmux-team completion zsh)"

# Bash (add to ~/.bashrc)
eval "$(tmux-team completion bash)"
```

### Claude Code Plugin

```
/plugin marketplace add anthropics/tmux-team
/plugin install tmux-team@tmux-team
```

## Quick Start

```bash
# Setup agents
tmux-team add claude 10.0 "Frontend"
tmux-team add codex 10.1 "Backend"
tmux-team add gemini 10.2 "Testing"

# Talk to agents
tmux-team talk codex "Review the auth module"
tmux-team talk all "Starting the refactor"

# Read responses
tmux-team check codex

# Manage agents
tmux-team list
tmux-team remove gemini
```

## From Claude Code

```
/team codex "Can you review my changes?"
/team all "I'm refactoring the database schema"
```

## Commands

| Command | Description |
|---------|-------------|
| `talk <agent> <msg>` | Send message to agent (or "all") |
| `check <agent> [lines]` | Read agent's output |
| `list` | List configured agents |
| `add <name> <pane> [remark]` | Add agent |
| `update <name> --pane/--remark` | Update agent |
| `remove <name>` | Remove agent |
| `init` | Create tmux-team.json |
| `completion [zsh\|bash]` | Output completion script |

## License

MIT
