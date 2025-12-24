# tmux-team

Coordinate AI agents (Claude, Codex, Gemini) running in tmux panes. Send messages, wait for responses, broadcast to all.

## Install

```bash
npm install -g tmux-team
```

**Requirements:** Node.js >= 18, tmux

**Alias:** `tmt` (shorthand for `tmux-team`)

## Quick Start

```bash
# 1. Install for your AI agent
tmux-team install claude   # or: tmux-team install codex

# 2. Run the setup wizard (auto-detects panes)
tmux-team setup

# 3. Talk to agents
tmux-team talk codex "Review this code" --wait
```

The `--wait` flag blocks until the agent responds, returning the response directly.

## Commands

| Command | Description |
|---------|-------------|
| `install [claude\|codex]` | Install tmux-team for an AI agent |
| `setup` | Interactive wizard to configure agents |
| `talk <agent> "msg" --wait` | Send message and wait for response |
| `talk all "msg" --wait` | Broadcast to all agents |
| `list` | Show configured agents |
| `learn` | Show educational guide |

Run `tmux-team help` for all commands and options.

## Configuration

`tmux-team.json` in your project root:

```json
{
  "codex": { "pane": "%1", "remark": "Code reviewer" },
  "gemini": { "pane": "%2", "remark": "Documentation" }
}
```

Find pane IDs: `tmux display-message -p "#{pane_id}"`

## Claude Code Plugin

```
/plugin marketplace add wkh237/tmux-team
/plugin install tmux-team
```

Gives you `/team` and `/learn` slash commands.

## Learn More

```bash
tmux-team learn   # Comprehensive guide
tmux-team help    # All commands and options
```

## License

MIT
