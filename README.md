# 🤖 tmux-team

**The lightweight coordination layer for terminal-based AI agents.**

tmux-team is a protocol-agnostic "Team Lead" that enables multi-agent collaboration directly within your existing tmux workflow. It provides the transport layer, synchronization, and project management needed to turn a collection of isolated terminal panes into a coordinated AI task force.

---

## 🛑 The Problem

As we move from "Chat with an AI" to "Orchestrating a Team," we face major friction points:

1. **Isolation** — Agents in different panes (Claude, Gemini, local LLMs) have no way to talk to each other
2. **Synchronization** — Humans are stuck in a "manual polling" loop—waiting for an agent to finish before copying its output to the next pane
3. **Tool Restrictions** — AI agents operate under tool whitelists; using `sleep` or arbitrary shell commands is dangerous or blocked
4. **Token Waste** — Repeated polling instructions burn context tokens unnecessarily

---

## 🚀 Our Niche: The Universal Transport Layer

Unlike heavyweight frameworks that require specific SDKs or cloud infrastructure, tmux-team treats the **terminal pane as the universal interface**.

- **Model Agnostic** — Works with Claude Code, Gemini CLI, Codex, Aider, or any CLI tool
- **Zero Infrastructure** — No servers, no MCP setup, no complex configuration. If it runs in tmux, tmux-team can talk to it
- **Whitelist-Friendly** — A single `tmux-team talk:*` prefix covers all operations, keeping AI tool permissions simple and safe
- **Local-First** — Per-project `tmux-team.json` lives with your repo; global config in `~/.tmux-team/` (v2)

---

## 🧠 Design Philosophy

> *These principles guide our design decisions.*

### 1. Deterministic Transport (`--delay` vs. `sleep`)

**The Problem**: Tool allowlists typically approve one safe command (`tmux-team talk ...`) but not arbitrary shell commands. Using `sleep` is often blocked by security policies, requires shell availability and proper quoting, and creates a separate process that's hard to manage.

**The Why**: Internal delay keeps the workflow as a single tool call. This guarantees "First-Packet Integrity"—the CLI validates units (`500ms`, `2s`) and ensures the TTY buffer is ready to receive input specifically for that agent. No shell dependency, no policy friction.

### 2. Stateless Handshakes (The "Nonce" Strategy)

**The Problem**: Terminal panes are streams, not RPC channels. A simple `[DONE]` string could already be in scrollback, or the agent might say "I'm almost done" and trigger a false positive.

**The Why**: We use a unique **Nonce** (Number used once) for every request: `{tmux-team-end:8f3a}`.
- **Collision Avoidance** — Prevents matching markers from previous turns
- **Completion Safety** — Ensures the agent has truly finished, not just paused mid-response
- **Zero-API RPC** — Creates request/response semantics over a standard TTY without requiring agents to support a special protocol

Combined with one-at-a-time locking, nonce markers ensure state stays consistent and debuggable.

### 3. Context Injection (Preambles)

**The Problem**: AI agents are prone to "instruction drift." Over a long session, they might stop using your preferred format or forget constraints. Manually re-typing system instructions is a "token tax" on your own brain.

**The Why**: Preambles act as a forced system prompt for CLI environments. By injecting these "hidden instructions" at the transport level, we ensure the agent remains in character (e.g., "You are the code reviewer, do not edit files") without cluttering the human's command history. It's about reducing **Cognitive Load**—the human focuses on intent, the CLI enforces protocol.

### 4. Token-Efficient Polling

**The Problem**: The `--wait` feature is powerful but higher-risk: long-running commands, more state to manage, potential for hung processes.

**The Why**: Default to the simple mental model (send → manually check). Teams opt into `--wait` when they're ready. By capturing only the last few lines of the buffer and searching for the short, high-entropy nonce, we keep overhead near zero—we're looking for a single "heartbeat" at the TTY's edge, not re-parsing the whole history.

---

## 📦 Installation

```bash
npm install -g tmux-team
```

**Requirements:** Node.js >= 16, tmux, macOS/Linux

### Shell Completion

```bash
# Zsh (add to ~/.zshrc)
eval "$(tmux-team completion zsh)"

# Bash (add to ~/.bashrc)
eval "$(tmux-team completion bash)"
```

### Claude Code Plugin

```
/plugin marketplace add wkh237/tmux-team
/plugin install tmux-team@tmux-team
```

---

## ⌨️ Quick Start

```bash
# Initialize config
tmux-team init

# Register your agents (name + tmux pane ID)
tmux-team add claude 10.0 "Frontend specialist"
tmux-team add codex 10.1 "Backend engineer"
tmux-team add gemini 10.2 "Code reviewer"

# Send messages
tmux-team talk codex "Review the auth module and suggest improvements"
tmux-team talk all "Starting the refactor now"

# Read responses
tmux-team check codex
tmux-team check codex 200  # More lines if needed

# Manage agents
tmux-team list
tmux-team update codex --remark "Now handling tests"
tmux-team remove gemini
```

### From Claude Code

Once the plugin is installed, coordinate directly from your Claude Code session:

```
/tmux-team:team codex "Can you review my changes?"
/tmux-team:team all "I'm starting the database migration"
```

---

## 📋 Commands

| Command | Description |
|---------|-------------|
| `talk <agent> "<msg>"` | Send message to agent (or `all` for broadcast) |
| `talk ... --delay 5` | Wait 5 seconds before sending |
| `talk ... --wait` | Wait for agent response (nonce-based) |
| `check <agent> [lines]` | Read agent's terminal output (default: 100 lines) |
| `list` | Show all configured agents |
| `add <name> <pane> [remark]` | Register a new agent |
| `update <name> --pane/--remark` | Update agent configuration |
| `remove <name>` | Unregister an agent |
| `init` | Create `tmux-team.json` in current directory |
| `pm init --name "Project"` | Initialize project management |
| `pm m add/list/done` | Manage milestones |
| `pm t add/list/update/done` | Manage tasks |
| `pm log` | View audit event log |
| `completion [zsh\|bash]` | Output shell completion script |

---

## ⚙️ Configuration

### Local Config (`./tmux-team.json`)

Per-project agent registry:

```json
{
  "claude": { "pane": "10.0", "remark": "Frontend specialist" },
  "codex": { "pane": "10.1", "remark": "Backend engineer" }
}
```

### Global Config (`~/.config/tmux-team/config.json`)

```json
{
  "mode": "polling",
  "preambleMode": "always",
  "defaults": {
    "timeout": 60000,
    "pollInterval": 1000
  },
  "agents": {
    "gemini": {
      "preamble": "Do not edit files until explicitly asked."
    }
  }
}
```

---

## ✨ v2 Features

### 📡 Enhanced `talk` Command

```bash
# Delay before sending (safe alternative to sleep)
tmux-team talk codex "message" --delay 5

# Wait for response with nonce-based completion detection
tmux-team talk codex "message" --wait --timeout 60
```

### 📜 Agent Preambles

Inject hidden instructions into every message:

```json
{
  "agents": {
    "gemini": {
      "preamble": "Always explain your reasoning. Do not edit files directly."
    }
  }
}
```

### 🎯 Project Management

```bash
# Initialize a team project
tmux-team pm init --name "Auth Refactor"

# Manage milestones and tasks
tmux-team pm m add "MVP Release"
tmux-team pm t add "Implement login" --milestone 1
tmux-team pm t update 1 --status in_progress
tmux-team pm t done 1

# View audit log
tmux-team pm log --limit 10
```

---

## 🚫 Non-Goals

tmux-team intentionally stays lightweight:

- **Not an orchestrator** — No automatic task routing or agent selection
- **Not a session manager** — Doesn't create/manage tmux sessions or git worktrees
- **Not an LLM wrapper** — Doesn't process or route messages through AI

It's the plumbing layer that lets humans and AI agents coordinate via tmux, nothing more.

---

*Built for developers who live in the terminal and want their AIs to do the same.*

---

## 📖 Command Reference

### Core Commands

```
tmux-team <command> [arguments]
```

| Command | Description |
|---------|-------------|
| `talk <target> <message>` | Send message to an agent (or `all` for broadcast) |
| `check <target> [lines]` | Capture output from agent's pane (default: 100 lines) |
| `list` | List all configured agents |
| `add <name> <pane> [remark]` | Register a new agent |
| `update <name> [options]` | Update an agent's config |
| `remove <name>` | Unregister an agent |
| `init` | Create empty `tmux-team.json` in current directory |
| `config [show\|set\|clear]` | View/modify configuration settings |
| `preamble [show\|set\|clear]` | Manage agent preambles |
| `pm <subcommand>` | Project management commands |
| `completion [zsh\|bash]` | Output shell completion script |
| `help` | Show help message |

**Aliases:** `send` = talk, `read` = check, `ls` = list, `rm` = remove

### Global Options

| Option | Description |
|--------|-------------|
| `--json` | Output in JSON format |
| `--verbose` | Show detailed output |
| `--force` | Skip warnings |

### talk Options

| Option | Description |
|--------|-------------|
| `--delay <seconds>` | Wait before sending (whitelist-friendly alternative to `sleep`) |
| `--wait` | Block until agent responds (nonce-based completion detection) |
| `--timeout <seconds>` | Max wait time (default: 180s) |
| `--no-preamble` | Skip agent preamble for this message |

### config Command

```bash
tmux-team config show                  # Show current config
tmux-team config set <key> <value>     # Set a config value
tmux-team config set mode wait         # Enable wait mode
tmux-team config set timeout 120       # Set timeout to 120s
tmux-team config clear <key>           # Clear a config value
tmux-team config --global set ...      # Modify global config
```

### preamble Command

```bash
tmux-team preamble show <agent>        # Show agent's preamble
tmux-team preamble set <agent> "..."   # Set agent's preamble
tmux-team preamble clear <agent>       # Clear agent's preamble
```

---

### Project Management (`pm`)

```
tmux-team pm <subcommand>
```

**Shorthands:** `pm m` = milestone, `pm t` = task, `pm ls` = list

#### pm init

```bash
tmux-team pm init --name "Project Name"
tmux-team pm init --name "Sprint 1" --backend github --repo owner/repo
```

| Option | Description |
|--------|-------------|
| `--name <name>` | Project name (required) |
| `--backend <fs\|github>` | Storage backend (default: `fs`) |
| `--repo <owner/repo>` | GitHub repo (required for github backend) |

#### pm list

```bash
tmux-team pm list                      # List all teams/projects
tmux-team pm ls                        # Shorthand
```

#### pm milestone (shorthand: `pm m`)

```bash
tmux-team pm m                         # List all milestones
tmux-team pm m add "Phase 1"           # Add milestone
tmux-team pm m add "Phase 1" -d "..."  # Add with description
tmux-team pm m list                    # List milestones
tmux-team pm m done <id>               # Mark milestone complete
tmux-team pm m doc <id>                # Print milestone documentation
tmux-team pm m doc <id> --edit         # Edit doc in $EDITOR
tmux-team pm m doc <id> ref            # Print doc path/reference
tmux-team pm m doc <id> --body "..."   # Set doc content directly
tmux-team pm m doc <id> --body-file x  # Set doc content from file
```

#### pm task (shorthand: `pm t`)

```bash
tmux-team pm t                         # List all tasks
tmux-team pm t add "Task title"        # Add task
tmux-team pm t add "..." --milestone 1 # Add task to milestone
tmux-team pm t add "..." --body "..."  # Add task with body
tmux-team pm t add "..." -a @user      # Add task with assignee
tmux-team pm t list                    # List tasks
tmux-team pm t list --status pending   # Filter by status
tmux-team pm t list --milestone 1      # Filter by milestone
tmux-team pm t show <id>               # Show task details
tmux-team pm t update <id> --status in_progress
tmux-team pm t update <id> -a @user    # Assign task
tmux-team pm t done <id>               # Mark task complete
tmux-team pm t doc <id>                # Print task documentation
tmux-team pm t doc <id> --edit         # Edit doc in $EDITOR
tmux-team pm t doc <id> ref            # Print doc path/reference
tmux-team pm t doc <id> --body "..."   # Set doc content directly
tmux-team pm t doc <id> --body-file x  # Set doc content from file
```

#### pm log

```bash
tmux-team pm log                       # Show audit event log
tmux-team pm log --limit 10            # Limit to 10 events
```

---

### Storage Backends

| Backend | Description |
|---------|-------------|
| `fs` | Local filesystem (default). Tasks stored in `~/.config/tmux-team/teams/` |
| `github` | GitHub Issues. Tasks become issues, milestones sync with GitHub |

---

## License

MIT
