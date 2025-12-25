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
| `check <agent> [lines]` | Read agent's pane output (fallback if --wait times out) |
| `list` | Show configured agents |
| `learn` | Show educational guide |

**Options for `talk --wait`:**
- `--timeout <seconds>` - Max wait time (default: 180s)
- `--lines <number>` - Lines to capture from response (default: 100)

Run `tmux-team help` for all commands and options.

## Managing Your Team

Configuration lives in `tmux-team.json` in your project root.

**Create** - Run the setup wizard to auto-detect agents:
```bash
tmux-team setup
```

**Read** - List configured agents:
```bash
tmux-team list
```

**Update** - Edit `tmux-team.json` directly or re-run setup:
```json
{
  "codex": { "pane": "%1", "remark": "Code reviewer" },
  "gemini": { "pane": "%2", "remark": "Documentation" }
}
```

**Delete** - Remove an agent entry from `tmux-team.json` or delete the file entirely.

Find pane IDs: `tmux display-message -p "#{pane_id}"`

## Claude Code Plugin

```
/plugin marketplace add wkh237/tmux-team
/plugin install tmux-team
```

Gives you two slash commands:

**`/learn`** - Teach Claude how to use tmux-team
```
/learn
```
Run this once when starting a session. Claude will understand how to coordinate with other agents.

**`/team`** - Talk to other agents
```
/team talk codex "Review my authentication changes" --wait
/team talk all "I'm starting the database migration" --wait
/team list
```
Use this to delegate tasks, ask for reviews, or broadcast updates.

## Learn More

```bash
tmux-team learn   # Comprehensive guide
tmux-team help    # All commands and options
```

## License

MIT
