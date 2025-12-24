# 🤖 tmux-team

**The lightweight coordination layer for terminal-based AI agents.**

tmux-team is a protocol-agnostic transport layer that enables multi-agent collaboration directly within your existing tmux workflow. It turns a collection of isolated terminal panes into a coordinated AI team.

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
- **Local-First** — Per-project `tmux-team.json` lives with your repo; global config in `~/.config/tmux-team/`

---

## 🧠 Design Philosophy

> *These principles guide our design decisions.*

### 1. Deterministic Transport (`--delay` vs. `sleep`)

**The Problem**: Tool allowlists typically approve one safe command (`tmux-team talk ...`) but not arbitrary shell commands. Using `sleep` is often blocked by security policies.

**The Why**: Internal delay keeps the workflow as a single tool call. No shell dependency, no policy friction.

### 2. Stateless Handshakes (The "Nonce" Strategy)

**The Problem**: Terminal panes are streams, not RPC channels. A simple `[DONE]` string could already be in scrollback.

**The Why**: We use a unique **Nonce** for every request: `{tmux-team-end:8f3a}`.
- **Collision Avoidance** — Prevents matching markers from previous turns
- **Completion Safety** — Ensures the agent has truly finished
- **Zero-API RPC** — Creates request/response semantics over a standard TTY

### 3. Context Injection (Preambles)

**The Problem**: AI agents are prone to "instruction drift." Over a long session, they might forget constraints.

**The Why**: Preambles act as a forced system prompt for CLI environments. By injecting these "hidden instructions" at the transport level, we ensure the agent remains in character.

---

## 📦 Installation

```bash
npm install -g tmux-team
```

**Requirements:** Node.js >= 18, tmux, macOS/Linux

**Alias:** `tmt` is available as a shorthand for `tmux-team`

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

### Agent Skills (Optional)

Install tmux-team as a native skill for your AI coding agent:

```bash
# Install for Claude Code (user-wide)
tmux-team install-skill claude

# Install for OpenAI Codex (user-wide)
tmux-team install-skill codex

# Install to project directory instead
tmux-team install-skill claude --local
tmux-team install-skill codex --local
```

See [skills/README.md](./skills/README.md) for detailed instructions.

---

## ⌨️ Quick Start

```bash
# Initialize config
tmux-team init

# Register your agents (name + tmux pane ID)
tmux-team add claude 10.0 "Frontend specialist"
tmux-team add codex 10.1 "Backend engineer"
tmux-team add gemini 10.2 "Code reviewer"

# Send messages and wait for response (recommended for better token utilization)
tmux-team talk codex "Review the auth module" --wait
tmux-team talk all "Starting the refactor now" --wait

# Or use the shorthand alias
tmt talk codex "Quick question" --wait

# Manage agents
tmux-team list
tmux-team update codex --remark "Now handling tests"
tmux-team remove gemini

# Learn more
tmux-team learn
```

### From Claude Code

Once the plugin is installed, coordinate directly from your Claude Code session:

```
/tmux-team:team codex "Can you review my changes?" --wait
/tmux-team:team all "I'm starting the database migration" --wait
```

---

## 📋 Commands

| Command | Description |
|---------|-------------|
| `talk <agent> "<msg>" --wait` | Send message and wait for response (recommended) |
| `talk ... --delay 5` | Wait 5 seconds before sending |
| `talk ... --timeout 300` | Set max wait time (default: 180s) |
| `check <agent> [lines]` | Read agent's terminal output (default: 100 lines) |
| `list` | Show all configured agents |
| `add <name> <pane> [remark]` | Register a new agent |
| `update <name> --pane/--remark` | Update agent configuration |
| `remove <name>` | Unregister an agent |
| `init` | Create `tmux-team.json` in current directory |
| `config [show/set/clear]` | View/modify settings |
| `preamble [show/set/clear]` | Manage agent preambles |
| `install-skill <agent>` | Install skill for Claude/Codex (--local/--user) |
| `learn` | Show educational guide |
| `completion [zsh\|bash]` | Output shell completion script |

---

## ⚙️ Configuration

### Local Config (`./tmux-team.json`)

Per-project agent registry with optional preambles:

```json
{
  "claude": {
    "pane": "10.0",
    "remark": "Frontend specialist",
    "preamble": "Focus on UI components. Ask for review before merging."
  },
  "codex": {
    "pane": "10.1",
    "remark": "Code reviewer",
    "preamble": "You are the code quality guard. Review changes thoroughly."
  }
}
```

| Field | Description |
|-------|-------------|
| `pane` | tmux pane ID (required) |
| `remark` | Description shown in `list` |
| `preamble` | Hidden instructions prepended to every message |

### Global Config (`~/.config/tmux-team/config.json`)

Global settings that apply to all projects:

```json
{
  "mode": "polling",
  "preambleMode": "always",
  "defaults": {
    "timeout": 180,
    "pollInterval": 1,
    "captureLines": 100,
    "preambleEvery": 3
  }
}
```

| Field | Description |
|-------|-------------|
| `mode` | Default mode: `polling` (manual check) or `wait` (auto-wait) |
| `preambleMode` | `always` (inject preambles) or `disabled` |
| `defaults.timeout` | Default --wait timeout in seconds |
| `defaults.pollInterval` | Polling interval in seconds |
| `defaults.captureLines` | Default lines for `check` command |
| `defaults.preambleEvery` | Inject preamble every N messages (default: 3) |

---

## ✨ Features

### 📡 Async Mode (Recommended)

The `--wait` flag is recommended for better token utilization:

```bash
# Wait for response with nonce-based completion detection
tmux-team talk codex "Review this code" --wait

# With custom timeout for complex tasks
tmux-team talk codex "Implement the feature" --wait --timeout 300

# Delay before sending (safe alternative to sleep)
tmux-team talk codex "message" --wait --delay 5
```

Enable by default: `tmux-team config set mode wait`

### 📜 Agent Preambles

Inject hidden instructions into every message via local `tmux-team.json`:

```json
{
  "gemini": {
    "pane": "10.2",
    "preamble": "Always explain your reasoning. Do not edit files directly."
  }
}
```

Use the CLI to manage preambles:

```bash
tmux-team preamble show gemini      # View current preamble
tmux-team preamble set gemini "Be concise" # Set preamble
tmux-team preamble clear gemini     # Remove preamble
```

---

## 🚫 Non-Goals

tmux-team intentionally stays lightweight:

- **Not an orchestrator** — No automatic agent selection or routing
- **Not a session manager** — Doesn't create/manage tmux sessions
- **Not an LLM wrapper** — Doesn't process or route messages through AI

It's the plumbing layer that lets humans and AI agents coordinate via tmux, nothing more.

---

## 📖 Command Reference

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
tmux-team config set mode wait         # Enable wait mode
tmux-team config set preambleMode disabled  # Disable preambles
tmux-team config set preambleEvery 5   # Inject preamble every 5 messages
tmux-team config clear <key>           # Clear a config value
```

### preamble Command

```bash
tmux-team preamble show <agent>        # Show agent's preamble
tmux-team preamble set <agent> "text"  # Set agent's preamble
tmux-team preamble clear <agent>       # Clear agent's preamble
```

---

*Built for developers who live in the terminal and want their AIs to do the same.*

---

## License

MIT
