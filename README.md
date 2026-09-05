# tmux-team

Coordinate AI agents (Claude, Codex, Gemini, and other terminal agents) in
tmux panes. Send direct messages, wait for responses, and inspect pane output
through the `tmt` CLI.

## Install

```bash
npm install -g tmux-team
tmt install
```

The npm `latest` channel remains the stable v4 release. This source tree is the
v5 alpha line (`5.0.0-alpha.1`); the `@alpha` channel is not claimed to be
published. Tags, GitHub Releases, npm publishing, and npm dist-tags are
separate release operations.

`tmt install` auto-detects Claude Code, Codex, and Gemini. Codex and Gemini
share a managed skill link at `~/.agents/skills/tmux-team`; Claude gets its own
integration. Repeating the command is idempotent, and unmanaged files are
backed up only with `--force`. Use `tmt upgrade` to update the package; managed
skill links immediately use the new bundled files. Interactive commands make a
once-daily cached update check, while local drift checks work without network.

**Requirements:** Node.js >= 22.12, tmux

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
- `tmt role show|set|clear` manages an optional durable profile for an identity,
  including identities that are currently offline.
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

Binding and discovery coordinate through SQLite and verify live pane metadata
before a bind reports success. If tmux cannot be verified or coordination times
out, the operation reports an error instead of claiming a successful binding.
An interrupted operation can leave an inactive pane marker; it does not become
an identity through discovery. Use `name`/`this` or `add` explicitly to bind
again. Existing durable identities and role profiles survive pane loss and
failed publication; do not delete their data to repair a binding.

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

| Command                                      | Description                                                 |
| -------------------------------------------- | ----------------------------------------------------------- |
| `install [claude\|codex\|gemini\|all]`       | Install or repair agent integrations                        |
| `upgrade`                                    | Upgrade tmux-team; managed skill links update automatically |
| `name <global-name>`                         | Bind the current pane to a global identity                  |
| `this <global-name>`                         | Exact supported alias for `name`                            |
| `add <pane-target> <global-name>`            | Bind an explicit pane to a global identity                  |
| `whoami`                                     | Show the current pane's global identity, if any             |
| `unbind`                                     | Remove the current pane's global identity                   |
| `role show [--identity <name>]`              | Read an identity's optional role profile                    |
| `role set <profile> [--identity <name>]`     | Replace an identity's role profile                          |
| `role set --file <path> [--identity <name>]` | Replace a profile from a UTF-8 file                         |
| `role clear [--identity <name>]`             | Remove only the role profile                                |
| `talk <target> "msg"`                        | Send a message to a global name or pane target              |
| `check <target> [lines]`                     | Read output from a global name or pane target               |
| `list [target]`                              | List active identities, or one target's pane status         |
| `learn`                                      | Show the educational guide                                  |

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

An identity record is durable, while its tmux binding and active presence are
transient. TMT treats an identity as active only when SQLite, the live tmux
server and pane, and the pane's identity metadata all agree. Pane targets are
resolved to stable `%pane_id` values, so pane movement and window renumbering
preserve the binding while the pane exists. Killing a pane or restarting its
tmux server removes the stale binding on reconciliation without deleting the
identity record; the same name can be bound again later with its original
identity ID.

Names are unique across tmux servers that share the same local TMT database,
but active discovery and `talk`/`check` routing remain scoped to the current
server. A routine read reconciles only that server's socket; it does not
remove another server's bindings. `%pane_id` alone is not globally unique
across servers.

Binding a name already recorded on another socket performs a bounded,
read-only check of that endpoint. A verified live binding returns
`NAME_ALREADY_ACTIVE` (exit 5). If its state cannot be verified, the operation
returns `RECONCILIATION_FAILED` (exit 1) and preserves the binding. A proven
stale endpoint can be rebound without replacing the durable identity or role
profile. This does not add cross-server message routing or a background
reconciler.

Pane metadata is part of that presence check. A pane title may be updated as a
best-effort presentation side effect, but titles are not the identity API.

Earlier v5 name-only pane markers are not automatically imported into SQLite.
They do not establish active identity routing. Use `tmt name <name>`, its
`tmt this <name>` alias, or `tmt add <pane-target> <name>` to bind explicitly.
Malformed or unsupported identity metadata cannot establish presence; unrelated
valid identities remain discoverable. Reads do not rewrite old pane markers or
delete legacy files, and invalid presence does not delete durable role profiles.

Messages use tmux buffer paste and then submit with Enter. This preserves
multiline text and handles paste-safety windows in CLIs such as Gemini. The
delay is configurable:

```bash
tmt config set pasteEnterDelayMs 500
```

## Local SQLite storage

TMT owns its local SQLite database. The database is deliberately local-file
only: it is not a shared service, does not listen on a network socket, and is
not accessed by a daemon. The default path is the global TMT directory
selected by the XDG config resolution rules: `$XDG_CONFIG_HOME/tmux-team/tmux-team.db`,
or `~/.config/tmux-team/tmux-team.db` when `XDG_CONFIG_HOME` is unset. The
configuration file and legacy JSON state remain separate compatibility
surfaces in that directory.

The storage directory is created with mode `0700` and database files with mode
`0600`; operators should not place the database on a shared or untrusted
filesystem. SQLite WAL sidecar files must remain beside the database and must
not be deleted manually. Writers use a bounded busy timeout and checkpoint
after write work. Normal command shutdown uses a passive checkpoint; backup or
export first obtains a consistent SQLite backup and may use a truncate
checkpoint only after no active reader remains.

Durable identity records, optional role profiles, and transient tmux bindings
use this storage boundary. Memory and inbox schemas are intentionally deferred
to their respective tickets; this release does not expose aliases or those
later domain models.

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

Remove the current pane's binding with `tmt unbind`. This preserves the durable
identity record so its name and ID can be rebound later. Repeating `tmt unbind`
on an already-unbound pane returns `UNBOUND_PANE`. Pane movement and window
renumbering preserve the binding's stable `%pane_id` while the pane lives.

## Optional role profiles

Each identity can carry one optional role/profile document. A role is not a
reusable catalog entry or an assignment to another identity. An identity with
no role remains valid.

```bash
tmt role set "Review changes and preserve verification evidence."
tmt role set --file reviewer.md --identity reviewer
tmt role show --identity reviewer
tmt role clear --identity reviewer
```

Omit `--identity` only when the current pane has a verified identity binding.
Otherwise specify an existing identity explicitly. Explicit access works
outside tmux and while an identity is offline; it does not create a missing
identity. Profiles survive unbind, pane death, tmux server restart, and later
rebind. `clear` removes only the profile and succeeds even when no profile was
set. `show --json` returns `role: null` for an identity without a profile.

Both inline and file input use the same validation. Each raw input and its
normalized content must be at most 65,536 UTF-8 bytes. Files must be regular
files containing valid UTF-8; symlinks to regular files are accepted. TMT
removes one initial byte-order mark and normalizes CRLF/CR to LF, preserving
other whitespace, tabs, indentation, and trailing newlines. Empty or
whitespace-only content, malformed encoding, and binary control characters
are rejected without changing the stored profile. Use `clear`, not an empty
`set`, to remove a profile.

Writes replace the whole profile atomically. Concurrent writes use
last-committed-write-wins; there is no content merge or version-conflict check.
The role document is stored data only: it is not automatically injected into
`talk` messages and does not change legacy preambles.

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

## Retired registry commands

V5 no longer supports `update`, `remove` (or `rm`), or `migrate`, including
its former `--cleanup` option. These commands return an unknown-command error
without changing files, pane metadata, or durable identities. Old user files
are not automatically migrated or deleted.

Use `name`/`this` or `add` to bind a durable identity, and `unbind` to detach
the current pane without deleting its identity or role profile. No replacement
durable-identity deletion or rename command is introduced.

Local `$config` settings and the existing preamble feature still use
`tmux-team.json`/workspace metadata where applicable. Their remaining registry
dependencies are tracked separately; command retirement does not migrate
preambles into role profiles.

## Using /team in Claude Code

The `/team` command lets Claude invoke `tmt` to communicate with other agents.
Install the plugin:

```
/plugin marketplace add wkh237/tmux-team
/plugin install tmux-team@tmux-team
```

### /team Commands

| Command                        | What it does                                   |
| ------------------------------ | ---------------------------------------------- |
| `/team list [target]`          | List active identities or one pane's status    |
| `/team talk <target> "msg"`    | Send a message to a global name or pane target |
| `/team check <target> [lines]` | Read output from a global name or pane target  |

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
