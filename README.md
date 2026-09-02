# tmux-team

Coordinate AI agents (Claude, Codex, Gemini, and other terminal agents) in
tmux panes. Send direct messages, wait for responses, and inspect pane output
through the `tmt` CLI.

## Install

```bash
npm install -g tmux-team
tmt install
```

`tmt install` auto-detects Claude Code, Codex, and Gemini. Codex and Gemini
share a managed skill link at `~/.agents/skills/tmux-team`; Claude gets its own
integration. Repeating the command is idempotent, and unmanaged files are
backed up only with `--force`. Use `tmt upgrade` to update the package; managed
skill links immediately use the new bundled files. Interactive commands make a
once-daily cached update check, while local drift checks work without network.

**Requirements:** Node.js >= 18, tmux

**Alias:** `tmt` (shorthand for `tmux-team`)

## What's new in 5.0

- `tmt name <global-name>` assigns a global identity to the current pane.
- `tmt this <global-name>` remains a supported, exact alias for `tmt name`.
- `tmt add <pane-target> <global-name>` assigns an identity to an explicit pane
  after resolving the target to tmux's stable `%pane_id`.
- `tmt talk` and `tmt check` accept either a global name or a direct pane
  target.
- `tmt list [target]` lists active identities or the runtime status of one
  pane.
- `tmt whoami` and `tmt unbind` inspect and remove the current pane's identity.
- Multiline messages preserve real line breaks when delivered.
- Skills can be installed and refreshed with `tmt install` and `tmt upgrade`.

## Quick Start

```bash
# 1. Assign global identities (run inside each agent's pane)
tmt name claude      # bind the current pane as "claude"
tmt this codex       # exact alias for `tmt name codex`
# Or bind an explicit pane target; it is stored by stable `%pane_id`
tmt add 10.1 gemini

# 2. List active identities, or inspect one pane directly
tmt list
tmt list %12
tmt list 10.1

# 3. Talk to an identity or directly to a pane
tmt talk codex "Review this code"
tmt talk %12 "Please run the smoke tests"

# 4. Inspect output and manage the current pane's identity
tmt check codex
tmt check %12 100
tmt whoami
tmt unbind
```

The `add` argument order is pane target first, global name second:
`tmt add <pane-target> <global-name>`. If an older example uses
`tmt add <global-name> <pane-target>`, it is rejected with a usage error; swap
the two arguments to use the current form.

Global identities are active across folders and do not depend on the current
working directory. Names may be undeclared—they do not need to match a
configured agent role. Each pane has at most one active global identity, and a
global name identifies at most one pane. The name `all` is an ordinary global
identity, not a special destination. A message addressed to that name goes to
the single pane currently bound to it.

### Pane targets

Commands that accept a target recognize a global name or a tmux pane target:

- `%pane_id`, such as `%12`
- `window.pane`, such as `1.0`
- `session:window.pane`, such as `main:1.0`

`tmt add` resolves a window-style target to the pane's stable `%pane_id`
before storing it. Use `%pane_id` when a script needs an unambiguous target.
Find the current pane ID with:

```bash
tmux display-message -p '#{pane_id}'
```

## Commands

| Command | Description |
|---------|-------------|
| `install [claude\|codex\|gemini\|all]` | Install or repair agent integrations |
| `upgrade` | Upgrade tmux-team; managed skill links update automatically |
| `name <global-name>` | Bind the current pane to a global identity |
| `this <global-name>` | Exact supported alias for `name` |
| `add <pane-target> <global-name>` | Bind an explicit pane to a global identity |
| `whoami` | Show the current pane's global identity, if any |
| `unbind` | Remove the current pane's global identity |
| `talk <target> "msg"` | Send a message to a global name or pane target |
| `check <target> [lines]` | Read output from a global name or pane target |
| `list [target]` | List active identities, or one target's pane status |
| `migrate [--dry-run] [--cleanup]` | Move legacy `tmux-team.json` entries into tmux metadata |
| `learn` | Show the educational guide |

`list` also has the `ls` alias. With no target it shows all active global
identities. With a target it resolves a global name or direct pane target and
shows that pane's status. `talk` and `check` use the same target resolution.

**Options for `talk`:**

- `--timeout <seconds>` - Max wait time (default: 180s)
- `--lines <number>` - Lines to capture from a response (default: 100)
- `--wait` - Wait for a response before returning
- `--delay <seconds>` - Delay before sending

Run `tmt help` for all commands and options.

## Runtime and lifecycle

tmux-team is CLI-only. Each `tmt` invocation reads or updates tmux pane
metadata, sends any requested message, and exits; there is no daemon or
background service to start, stop, or keep healthy. tmux must be running when a
command needs pane state.

Identity metadata is authoritative. A pane title may be updated as a
best-effort presentation side effect, but titles are not the identity API.
Pane targets are resolved to stable `%pane_id` values so pane movement and
window renumbering do not silently change a stored binding while the pane
exists.

Messages use tmux buffer paste and then submit with Enter. This preserves
multiline text and handles paste-safety windows in CLIs such as Gemini. The
delay is configurable:

```bash
tmt config set pasteEnterDelayMs 500
```

## Managing global identities

Bind the current pane, or bind another pane by an explicit target:

```bash
tmt name reviewer
tmt add %12 gemini
```

Inspect active identities and pane status:

```bash
tmt list
tmt list gemini
tmt list %12
tmt whoami
```

Remove the current pane's binding with `tmt unbind`. If a pane is moved or
renumbered, use its stable `%pane_id` in subsequent commands.

## Legacy preambles

Workspace-scoped preambles remain available for migrated or legacy
registrations:

```bash
tmt preamble set codex "You are the code quality guard. Be strict."
```

When you send a message, tmux-team injects the preamble like this:

```
[SYSTEM: You are the code quality guard. Be strict.]

Review the login flow changes.
```

This compatibility setting is separate from the global identity binding.
Control how often it is injected with `preambleEvery`:

```bash
tmt config set preambleEvery 3
```

## Legacy migration

Versions before v4 stored registrations in a project-local
`tmux-team.json`. `tmt migrate` can copy those legacy entries into tmux pane
metadata:

```bash
tmt migrate --dry-run     # preview what would move
tmt migrate               # move entries into tmux metadata
tmt migrate --cleanup     # also remove migrated entries from the JSON file
```

The JSON file is retained only as a compatibility path for older projects and
settings. New identity bindings use tmux pane metadata and are global across
folders.

## Using /team in Claude Code

The `/team` command lets Claude invoke `tmt` to communicate with other agents.
Install the plugin:

```
/plugin marketplace add wkh237/tmux-team
/plugin install tmux-team@tmux-team
```

### /team Commands

| Command | What it does |
|---------|--------------|
| `/team list [target]` | List active identities or one pane's status |
| `/team talk <target> "msg"` | Send a message to a global name or pane target |
| `/team check <target> [lines]` | Read output from a global name or pane target |

Examples:

```text
/team talk codex "Review my changes in src/auth/ for security issues"
/team check %12 100
/team list
```

`/team talk` follows the same wait and timeout options as `tmt talk`. Run
`/learn` once per session to teach Claude the full workflow.

## Learn More

```bash
tmt learn   # Comprehensive guide
tmt help    # All commands and options
```

## License

MIT
