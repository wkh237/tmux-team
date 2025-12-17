# tmux-team

CLI tool for AI agent collaboration in tmux. Manage cross-pane communication between multiple AI agents (Claude, Codex, Gemini, etc.) working in different tmux panes.

## Installation

```bash
npm install -g tmux-team
```

## Requirements

- Node.js 16+
- tmux

## Shell Completion

Enable tab auto-completion for commands and agent names:

**Zsh** (add to `~/.zshrc`):
```bash
eval "$(tmux-team completion zsh)"
```

**Bash** (add to `~/.bashrc`):
```bash
eval "$(tmux-team completion bash)"
```

Then restart your shell or run `source ~/.zshrc` (or `~/.bashrc`).

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

# Remove an agent
tmux-team remove gemini
```

## Commands

| Command | Description |
|---------|-------------|
| `tmux-team help` | Show help message |
| `tmux-team init` | Create empty tmux-team.json |
| `tmux-team init-claude` | Show Claude Code plugin install instructions |
| `tmux-team completion [shell]` | Output shell completion script |
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

## Use Cases

### From Claude Code (Slash Command)

After installing the plugin, you can communicate with other agents directly from Claude Code:

```
/team codex "Can you review the authentication changes I just made?"

/team gemini "I've finished the frontend. Please start writing tests for src/auth/"

/team all "I'm about to refactor the database schema. Please pause your current work."
```

This is especially useful when:
- You want Claude to coordinate with other agents mid-task
- You need to ask another agent for help without leaving your current context
- You want to broadcast status updates to the whole team

### Multi-Agent Feature Development

Run multiple AI agents in parallel, each handling different aspects of a feature:

```
┌─────────────────────────────────────────────────────────────┐
│ tmux session                                                │
├───────────────────────────┬─────────────────────────────────┤
│ Claude (pane 10.0)        │ Codex (pane 10.1)               │
│ - Implementing frontend   │ - Writing backend API           │
│ - UI components           │ - Database schema               │
├───────────────────────────┼─────────────────────────────────┤
│ Gemini (pane 10.2)        │ Human (pane 10.3)               │
│ - Writing tests           │ - Coordinating work             │
│ - Documentation           │ - Reviewing progress            │
└───────────────────────────┴─────────────────────────────────┘
```

**Workflow:**
1. Human assigns tasks to each agent
2. Agents work independently on their tasks
3. When one agent needs input from another, use `tmux-team talk`
4. Human monitors progress with `tmux-team check`

### Code Review Pipeline

Set up a review chain where different agents focus on different aspects:

```bash
# Claude focuses on architecture
tmux-team talk claude "Review this PR for architectural concerns"

# Codex focuses on implementation details
tmux-team talk codex "Check for edge cases and error handling"

# Gemini focuses on testing
tmux-team talk gemini "Verify test coverage is adequate"
```

### Parallel Task Processing

Speed up large tasks by dividing work:

```bash
# Broadcast the context to all agents
tmux-team talk all "We're refactoring the auth module. Here's the plan..."

# Assign specific files to each agent
tmux-team talk claude "Refactor src/auth/login.ts"
tmux-team talk codex "Refactor src/auth/register.ts"
tmux-team talk gemini "Refactor src/auth/password-reset.ts"

# Check progress periodically
tmux-team check claude
tmux-team check codex
tmux-team check gemini
```

### Design Discussion

Facilitate discussions between agents for complex decisions:

```bash
# Start a discussion
tmux-team talk claude "Should we use Redux or Zustand for state management?"

# Get Claude's opinion, then ask Codex
tmux-team check claude
tmux-team talk codex "Claude suggests Zustand. What do you think?"

# Synthesize the discussion
tmux-team check codex
tmux-team talk gemini "Based on Claude and Codex's input, summarize the pros/cons"
```

### Debugging Collaboration

When stuck on a bug, get multiple perspectives:

```bash
# Share the bug context with all agents
tmux-team talk all "Getting 'undefined is not a function' in useAuth hook. Stack trace: ..."

# Each agent investigates from their perspective
tmux-team check claude   # Frontend perspective
tmux-team check codex    # Backend perspective
tmux-team check gemini   # Testing perspective
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
