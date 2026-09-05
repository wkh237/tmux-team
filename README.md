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

`name`, `this`, `whoami` and `unbind` require a live caller pane whose
`TMUX_PANE` and `TMUX` server context agree. Missing or stale caller context
returns `PANE_NOT_FOUND` (exit 3), without selecting the default pane or
changing identity data. Implicit `role` access returns `IDENTITY_REQUIRED`
(exit 1) in that situation. Do not manufacture caller environment variables
as a workaround: outside tmux, use explicit `add`, `talk`, `check`, or
`role show|set|clear --identity <name>` as appropriate.

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

Identity creation commits separately from binding publication. Once created,
an identity is never deleted by a failed bind. Trying a valid new name on an
occupied pane returns `PANE_ALREADY_BOUND` (exit 5), preserves the existing
binding, and leaves the new identity offline. It cannot receive `talk` by name,
but explicit role/preamble access works. Retrying on an available pane reuses
its UUID and profiles. Invalid names and panes missing at preflight create no
identity. There is no automatic garbage collection or identity deletion command.

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

Messages use tmux buffer paste and then submit with Enter. Line breaks are
preserved, but ASCII `!` is deliberately converted to fullwidth `！` to protect
coding-agent shell/bash-mode shortcuts, including on the literal-key fallback
path. This means code such as `if (!ready)` is not delivered byte-for-byte.
Bracketed paste is not assumed to disable every agent's shortcuts. The
paste-to-Enter delay is configurable:

```bash
tmt config set pasteEnterDelayMs 500
```

Once paste or literal input may have reached a pane, TMT does not automatically
replay it. A failed input/submission stage returns `DELIVERY_UNCERTAIN` (exit 1)
in both wait and non-wait modes, with `error.stage` in JSON. Inspect the pane
before deciding whether to retry; absent visible output does not prove that no
work started. Successful submission does not promise exactly-once processing.
Each transport/capture subprocess is bounded independently of the configured
Enter delay and response wait timeout.

Response waits still use best-effort terminal extraction: a completion marker
does not guarantee a full body under virtual scrolling. `check` is a diagnostic
snapshot, not durable response retrieval. See the
[channel research and implementation plan](REQUEST-RESPONSE.md).

## Local SQLite storage

TMT owns its local SQLite database. The database is deliberately local-file
only: it is not a shared service, does not listen on a network socket, and is
not accessed by a daemon. The default path is the global TMT directory
selected by the XDG config resolution rules: `$XDG_CONFIG_HOME/tmux-team/tmux-team.db`,
or `~/.config/tmux-team/tmux-team.db` when `XDG_CONFIG_HOME` is unset. The
configuration file remains separate. Legacy JSON request/counter state is
ignored and left untouched; it is not imported into SQLite.

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
`talk` messages and does not change identity preambles.

## Identity preambles

Preambles belong to existing durable global identities, separately from role
profiles. Managing them does not require tmux or an active binding:

```bash
tmt preamble show
tmt preamble show codex
tmt preamble set codex "You are the code quality guard. Be strict."
tmt preamble clear codex
```

When you send a message, tmux-team injects the preamble like this:

```
[SYSTEM: You are the code quality guard. Be strict.]

Review the login flow changes.
```

Names are explicit and case-normalized; an unknown identity fails with
`NAME_NOT_FOUND` (exit 3). Bare `preamble` or `show` without a name lists stored
preambles, not the caller's data. Show returns null when an existing identity
has no preamble; repeated clear is safe. Set accepts nonblank text up to 65,536
UTF-8 bytes, normalizes an initial BOM and CRLF/CR, and rejects invalid Unicode
or control characters without replacing existing content. Use clear to remove it.

Both name targets and direct panes with a verified identity use that identity's
preamble. Unnamed panes get none. Role text is never automatically injected.
Content persists across directories, unbind, pane death and server restart.
Control injection frequency with `preambleEvery`:

```bash
tmt config set preambleEvery 3
```

For N, injection occurs at effective reservation counts 1, 1+N, 1+2N, and so on. Disabled
`preambleMode`, `--no-preamble`, no stored content, or N=0 does not advance the
counter. Set, clear and rebind do not reset it. SQLite atomically reserves each
eligible attempt against its durable identity. Sent, uncertain, and pending
attempts count; a proven unsent attempt refunds only future reservations.
Already prepared payloads do not change. Sequential definitely-unsent failures
do not consume cadence, but overlapping failures can produce extra or missing
preambles relative to ideal successful-send spacing. There is no hidden
single-flight lock or exactly-once delivery guarantee. The SQLite request/cadence
cutover starts fresh without importing or deleting old JSON state.

### Concurrent request bookkeeping

Each `talk` attempt records its own ID and complete tmux server/pane instance
in SQLite, including direct unnamed panes. Concurrent waiters never replace
one another's rows; an overlap warning is advisory, and `--force` only suppresses
the warning. Cleanup affects only its own attempt. Transactions end before
transport and capture, so a waiting agent does not hold the database writer lock.

An attempt is prepared before transmission and marked sending immediately
before invoking it. A crash after sending starts is uncertain, never permission
to retry. Timeout or interruption releases the waiter, not the recipient's
work. Expired prepared attempts can refund their reservations; expired sending
attempts remain consumed as uncertain. Attempt metadata is pruned opportunistically
after terminal retention; cadence totals persist. No prompt or response body is
stored by this bookkeeping feature.

`REQUEST_STATE_ERROR` (exit 1) reports a bookkeeping failure. When delivery may
already have occurred, inspect the pane before retrying; a failed state write
does not mean the message was not sent. The existing terminal-marker response
and truncation limitations remain unchanged.

Old preambles in JSON or workspace metadata are ignored, not automatically
imported or deleted. Reapply desired text using `preamble set`. A preamble lookup
failure stops delivery rather than silently sending without it.

## JSON result contract

For commands using `--json`, stdout contains one JSON document after cleanup.
Errors use `{ "error": { "code": "...", "message": "..." } }`; optional
diagnostics use stderr. Preserve and inspect additional error fields such as
delivery `stage` and `suggestion`. Successful operations without a detailed
result, such as `config set`, return `{ "ok": true }`.

Exit statuses remain meaningful: 1 is a general failure, 3 a missing target,
4 a timeout, and 5 a conflict. Parse errors now use `USAGE_ERROR` on stdout,
not a flat string error on stderr. Initialization errors are also handled by
the command boundary. `CLEANUP_ERROR` after successful work does not roll back
its effects; inspect state before retrying. A cleanup failure alongside an
existing command failure preserves that primary error and status.

This v5 alpha intentionally changes the timeout `error` field from a string to
`{ "code": "TIMEOUT", "message": "..." }`. The existing `status`, target,
pane, identity when present, request ID, nonce, end marker and nullable
`partialResponse` remain. Read `error.message` instead of treating `error` as
text. Timeout and Ctrl+C release the waiter, not recipient work.

`help`, `version`, `completion`, and `learn` remain text-only; combining them
with `--json` returns `JSON_UNSUPPORTED` before output or effects. `upgrade`
also rejects JSON because its installer streams text. Run these without
`--json`. This contract covers the running application, not a broken runtime
installation or an unwritable output pipe.

## Retired registry commands

V5 no longer supports `update`, `remove` (or `rm`), or `migrate`, including
its former `--cleanup` option. These commands return an unknown-command error
without changing files, pane metadata, or durable identities. Old user files
are not automatically migrated or deleted.

Use `name`/`this` or `add` to bind a durable identity, and `unbind` to detach
the current pane without deleting its identity or role profile. No replacement
durable-identity deletion or rename command is introduced.

Local `$config` settings still use `tmux-team.json`; unknown keys remain when
editing settings. Legacy pane, preamble and deny entries are no longer runtime
configuration or routing authority. Ordinary preamble operations leave those
files and opaque old pane metadata untouched.

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
