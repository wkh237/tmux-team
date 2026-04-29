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

# 2. Go to working folder and register agents (run inside each agent's pane)
tmt this claude      # registers current pane as "claude"
tmt this codex       # registers current pane as "codex"

# 3. Talk to agents
tmt talk codex "Review this code"    # waits for response by default

# 4. Update or remove an agent
tmt update codex --pane 2.3
tmt rm codex
```

> **Tip:** Most AI agents support `!` to run bash commands. From inside Claude Code, Codex, or Gemini CLI, you can run `!tmt this myname` to quickly register that pane.

### How scopes work

Registrations live in tmux pane metadata, not in a JSON file you have to track.
By default they are scoped to the current **workspace** — the nearest Git root,
or the current folder when you are not inside a Git repo. So `tmt this`,
`tmt add`, `tmt rm`, `tmt update`, `tmt preamble`, and `tmt list` all act on
the workspace you are currently in.

Reach for `--team <name>` only when you want an explicit shared team that spans
folders (see [Shared Teams](#shared-teams)).

## Cross-Folder Collaboration

Agents don't need to be in the same folder to collaborate. From your current
workspace you can add an agent whose pane lives in another project:

```bash
# In project-a folder, add an agent that's running in project-b
tmt add codex-reviewer 5.1    # Use the pane ID from the other project
```

Find pane IDs with: `tmux display-message -p "#{pane_id}"`

This still uses the default workspace scope: the registration is visible from
project-a, not from project-b. For long-running collaboration that should be
visible on both sides, use a [shared team](#shared-teams).

## Commands

| Command | Description |
|---------|-------------|
| `install [claude\|codex]` | Install tmux-team for an AI agent |
| `this <name> [remark]` | Register current pane as an agent |
| `talk <agent> "msg"` | Send message and wait for response |
| `talk all "msg"` | Broadcast to all agents |
| `check <agent> [lines]` | Read agent's pane output |
| `list` | Show agents in the current workspace (or `--team <name>`) |
| `migrate [--dry-run] [--cleanup]` | Move legacy `tmux-team.json` entries into tmux pane metadata |
| `team ls [--summary\|--json]` | Inspect tmux panes grouped by scope; `--summary` aggregates shared teams |
| `team rm <team> --force` | Remove a shared team registration from every pane |
| `learn` | Show educational guide |

**Options for `talk`:**
- `--timeout <seconds>` - Max wait time (default: 180s)
- `--lines <number>` - Lines to capture from response (default: 100)

Run `tmt help` for all commands and options.

## Message Delivery

tmux-team uses tmux buffers + paste, then waits briefly before sending Enter. This avoids shell history expansion and handles paste-safety windows in CLIs like Gemini.

**Config:** `pasteEnterDelayMs` (default: 500)

```bash
tmt config set pasteEnterDelayMs 500
```

## Managing Your Team

Agent registrations live in tmux pane metadata, scoped per workspace by
default. The same-folder workflow never needs `--team`.

**List agents in this workspace:**
```bash
tmt ls
tmt ls --team myproject   # or list a shared team
```

**Inspect every tmux pane** with `tmt team ls`. Output is grouped by scope —
shared teams first, then workspaces, then unregistered panes — and each
section's title lists the agents living there:

```
Team: acme-app (codex, gemini)
PANE   TARGET             CWD              CMD
%12    main:1.0           ~/acme/frontend  node
%17    main:2.0           ~/acme/backend   python

Workspace: ~/dev/tmux-team (claude)
PANE   TARGET             CWD              CMD
%3     work:0.1           ~/dev/tmux-team  node

Unregistered panes
PANE   TARGET             CWD              CMD
%9     misc:0.0           ~/scratch        zsh
```

```bash
tmt team ls               # grouped pane inventory (default)
tmt team ls --summary     # collapse to a shared-team aggregate (TEAM / AGENTS)
tmt team ls --json        # { teams, panes } incl. each pane's registrations
```

**Add an agent from any pane.** Targets can be `%pane_id`, `window.pane`, or
`session:window.pane`; tmux-team stores the canonical `%pane_id`.

```bash
tmt add codex 1.1 "Code reviewer"
```

**Remove an agent** from the current scope:
```bash
tmt rm codex
```

**Migrate from legacy `tmux-team.json`.** Versions before v4 stored agents in
a JSON file. `tmt migrate` copies those entries into tmux pane metadata so the
new commands can see them. Run it once per project that still has the file:

```bash
tmt migrate --dry-run     # preview what would move
tmt migrate               # move entries into tmux metadata
tmt migrate --cleanup     # also delete the migrated entries from the JSON file
```

`tmux-team.json` is still loaded as a fallback when no tmux metadata exists,
and it remains the home for local `$config` overrides. If you don't use it,
you can ignore it.

---

## Agent Preambles

Set a per-agent preamble to steer behavior (stored with the pane registration):

```bash
tmt preamble set codex "You are the code quality guard. Be strict."
```

### What Happens When a Preamble Is Set

When you send a message, tmux-team injects the preamble like this:

```
[SYSTEM: You are the code quality guard. Be strict.]

Review the login flow changes.
```

Control how often it’s injected with `preambleEvery`:

```bash
tmt config set preambleEvery 3
```

## Shared Teams

> *Work on different folders but talk to the same team of agents.*

By default, registrations are scoped to the current workspace. The `--team` flag
creates an explicit shared team that works across folders:

```bash
# Register agents from ANY folder
cd ~/code/frontend && tmt this claude --team myproject
cd ~/code/backend && tmt this codex --team myproject
cd ~/code/infra && tmt this gemini --team myproject

# Now talk to them from anywhere
tmt talk codex "What's the user API schema?" --team myproject
tmt talk all "Starting deploy - heads up" --team myproject
```

> **Tip:** Most AI coding agents (Claude Code, Codex, Gemini CLI) support `!` to run shell commands. Agents can register themselves without leaving the session:
> ```
> !tmt this claude --team myproject
> ```

### When to use shared teams

**Single project** (default) — agents work in the same folder:
```bash
tmt this claude
tmt add codex 1.1
```

**Shared team** — agents work across folders but collaborate:
```bash
tmt this frontend-claude --team acme-app   # from ~/acme/frontend
tmt this backend-codex --team acme-app     # from ~/acme/backend
tmt ls --team acme-app                     # list members
tmt team ls --summary                      # all shared teams at a glance
tmt team rm acme-app --force               # remove the team from every pane
```

### Multi-team coordination

For large systems, create team hierarchies where leaders coordinate sub-teams:

```mermaid
flowchart

A["you (claude)"]
A2["codex"]
A3["gemini"]
B["backend-lead"]
B2["codex"]
C["infra-lead"]
C2["codex"]

subgraph your-team
  A <--> A2
  A <--> A3
end

A e1@<--> B
A e2@<--> C

e1@{ animate: true }
e2@{ animate: true }

subgraph backend-team
  B <--> B2
end

subgraph infra-team
  C <--> C2
end
```

---

## Using /team in Claude Code

The `/team` command lets Claude talk to other AI agents directly. Install the plugin:

```
/plugin marketplace add wkh237/tmux-team
/plugin install tmux-team
```

### /team Commands

| Command | What it does |
|---------|--------------|
| `/team list` | Show all registered agents |
| `/team talk <agent> "msg"` | Send a message and wait for response |
| `/team talk all "msg"` | Broadcast to all agents |

### Real-World Examples

**Code review delegation:**
```
/team talk codex "Review my changes in src/auth/ for security issues"
```

**Cross-agent coordination:**
```
/team talk all "Starting database migration - hold off on API changes"
```

**Ask a specialist:**
```
/team talk gemini "What's the best practice for rate limiting in GCP?"
```

### Tips

- `/team talk` waits for the agent to respond before continuing
- Use `/team list` to see who's available
- Run `/learn` once per session to teach Claude the full tmux-team workflow

## Learn More

```bash
tmt learn   # Comprehensive guide
tmt help    # All commands and options
```

## License

MIT
