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
tmt install claude   # or: tmt install codex

# 2. Go to working folder and initialize
tmt init

# 3. Register agents (run inside each agent's pane)
tmt this claude      # registers current pane as "claude"
tmt this codex       # registers current pane as "codex"

# 4. Talk to agents
tmt talk codex "Review this code"    # waits for response by default

# 5. Update or remove an agent
tmt update codex --pane 2.3
tmt rm codex
```

> **Tip:** Most AI agents support `!` to run bash commands. From inside Claude Code, Codex, or Gemini CLI, you can run `!tmt this myname` to quickly register that pane.

## Cross-Folder Collaboration

Agents don't need to be in the same folder to collaborate. You can add an agent from one project to another:

```bash
# In project-a folder, add an agent that's running in project-b
tmt add codex-reviewer 5.1    # Use the pane ID from the other project
```

Find pane IDs with: `tmux display-message -p "#{pane_id}"`

## Commands

| Command | Description |
|---------|-------------|
| `install [claude\|codex]` | Install tmux-team for an AI agent |
| `this <name> [remark]` | Register current pane as an agent |
| `talk <agent> "msg"` | Send message and wait for response |
| `talk all "msg"` | Broadcast to all agents |
| `check <agent> [lines]` | Read agent's pane output |
| `list` | Show configured agents |
| `learn` | Show educational guide |

**Options for `talk`:**
- `--timeout <seconds>` - Max wait time (default: 180s)
- `--lines <number>` - Lines to capture from response (default: 100)

Run `tmt help` for all commands and options.

## Managing Your Team

Configuration lives in `tmux-team.json` in your project root.

**List** - Show configured agents:
```bash
tmt ls
```

**Edit** - Modify `tmux-team.json` directly:
```json
{
  "codex": { "pane": "1.1", "remark": "Code reviewer" },
  "gemini": { "pane": "1.2", "remark": "Documentation" }
}
```

**Remove** - Delete an agent:
```bash
tmt rm codex
```

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
/team talk codex "Review my authentication changes"
/team talk all "I'm starting the database migration"
/team list
```
Use this to delegate tasks, ask for reviews, or broadcast updates.

## Learn More

```bash
tmt learn   # Comprehensive guide
tmt help    # All commands and options
```

## License

MIT
