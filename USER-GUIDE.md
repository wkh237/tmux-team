# tmux-team user guide

This guide covers the common v5 native alpha workflows. Start with the
[README](README.md) for the current installation status and verified release
URL, then use
[`skills/README.md`](skills/README.md) for provider-specific installation and
[`skills/tmux-team/SKILL.md`](skills/tmux-team/SKILL.md) for canonical agent
guidance.

## Install and load the skill

Use the native installer asset from a published release as described by the
README, then let the native executable detect supported agents with `tmt install`.
The installer defaults to `$HOME/.local/bin/tmt` and runs skill installation
unless `--no-skill` is supplied. Reload the agent after installation.

The native runtime requires macOS or Linux and tmux for pane operations, but no
Node.js, Rust toolchain or source checkout. Native `tmt upgrade` (also
available as `tmt update`) follows its retained stable/alpha channel; use
`--to <version>` to pin or `--unpin` to resume channel updates. Package-manager
installations from older releases are a separate legacy TypeScript runtime.
Use their original manager to remove them before switching; current repository
source is not an npm product installation. See the replacement guidance below.

After installation, load or reload the `tmux-team` skill in every agent that
will send or receive TMT work. Installation places the provider integration;
it does not reload an already running agent session.

Native `name` and `add` bindings are temporary by default. Add `-s`/`--save`
to preserve an identity, and use `tmt rm <name>` to retire a temporary identity
(`--force` is required for a saved identity). Switching from npm or pnpm is a
fresh installation: stop old writers first; no configuration, database or
historical exchange is migrated or deleted. Native schema migrations are forward-only,
so never use the old TypeScript writer on a native database.

## Name panes and inspect presence

Give each live agent pane a global name from that pane's shell, before
launching the agent:

```bash
tmt name reviewer
# Or bind another pane from a shell that can address it:
tmt add %12 gemini
```

Use these commands to inspect the current tmux server:

```bash
tmt list
tmt list reviewer
tmt whoami
```

Human tables align columns using Unicode display widths and show complete values.
Long rows may wrap in narrow terminals. Control characters in table metadata are
shown as escapes, not executed. Use `--json` for scripts and exact metadata;
human spacing is presentation, not a machine-readable format.

`name` and `whoami` need a live caller pane. `add` accepts `%pane_id`,
`window.pane`, or `session:window.pane`; the current order is pane target first,
global name second. `tmt unbind` retires a temporary identity; a saved identity
and its profile remain offline. Neither operation kills the pane.

Global names are independent of the working directory. A durable identity can
exist without an active pane:

```bash
tmt identity create coordinator --json
tmt identity show coordinator --json
tmt identity list --json
```

Creation is idempotent for a canonical-equivalent name. It does not bind a
pane, authenticate a caller, or create an offline receiving queue.

## Saved identity notes

Each saved identity can own one ordinary local Markdown file:

```bash
tmt notes path --identity coordinator
tmt notes path --identity coordinator --json
```

Omit `--identity` only in a verified pane bound to a saved identity. Outside
tmux, or when caller evidence is unavailable, select an existing saved identity
explicitly. Temporary identities return `NOTES_SAVED_IDENTITY_REQUIRED`; an
unknown or retired name returns `NAME_NOT_FOUND`.

The first successful invocation creates an empty `notes.md` at
`<global-state>/notes/<identity-uuid>/notes.md`; plain output is only that
absolute path. JSON returns `identityId`, `path`, and `created`. Directories and
the file are created owner-only on supported Unix platforms. Later invocations
preserve the file's exact bytes and do not refresh, truncate, template, lock, or
watch it. Edit it with normal filesystem tools and coordinate concurrent writers
as you would for any other file.

The path follows the saved identity UUID, not its display name, pane, current
directory, role, or Office state. Retiring an identity retains its notebook; a
new identity that reuses the name receives a new UUID and path. TMT does not
garbage-collect old notebooks. This is local filesystem discovery for the same
OS user, not authentication, isolation, encryption, or a shared remote notebook.

## Talk and receive a complete reply

Send a request by global name or direct pane target:

```bash
tmt talk reviewer "Review this patch and report concrete risks."
tmt talk %12 "Run the focused checks." --timeout 300
```

The receiver must have the skill loaded. TMT gives it a request ID and receipt
inside the delivered instructions; the receiver submits one complete final
reply with that receipt. `talk` waits for the durable final by default.

For work that should continue after the caller returns:

```bash
tmt talk reviewer "Run the agreed checks." --detach --json
tmt result <request-id> --json
```

Use exactly the request ID and receipt supplied by TMT. Do not invent a receipt,
select the latest request, or infer a pane. A successful submission means a
body was stored; it does not prove that the requested work succeeded.

Agents can submit a final explicitly when TMT supplies the receipt:

```bash
tmt reply <request-id> --receipt <receipt> --message 'Review complete.'
tmt reply <request-id> --receipt <receipt> --file response.md
tmt reply <request-id> --receipt <receipt> --stdin < response.md
```

Choose exactly one input source. Identical retries are safe while the body is
retained; a different body conflicts and cannot replace the stored final.

## Attribute and recover requests

When the caller is not in a verified bound pane, select an existing durable
identity explicitly. The option belongs after `talk`:

```bash
tmt talk reviewer "Review the release notes." --identity coordinator --detach --json
```

This is local attribution, not authentication. The recipient still needs a
live bound pane. To recover requests after timeout, detach, process restart, or
pane loss:

```bash
tmt x --identity coordinator --json
tmt x show <request-id> --identity coordinator --json
tmt x ack <request-id> --revision <revision> --identity coordinator --json
tmt x ackall --identity coordinator --json
```

Bare `x` means `x list`: it returns unacknowledged retained metadata. `x show`
reads the retained original prompt and final when available. `ack` requires the
revision observed by list/show; `ackall` acknowledges the current transaction
snapshot without enumerating or claiming that every body was read. Reads and
acknowledgements do not cancel work or renew retention.

## Roles and preambles

An optional role profile is stored with an identity and is not automatically
injected into messages:

```bash
tmt role set "Review correctness before style." --identity reviewer
tmt role show --identity reviewer
tmt role clear --identity reviewer
```

Preambles are separate and are included in messages for the selected identity:

```bash
tmt preamble set reviewer "Be concise and cite concrete evidence."
tmt preamble show reviewer
tmt preamble clear reviewer
```

Use notes for deliberate working context, `role` for durable profile data, and
`preamble` for message context. All three survive pane loss and rebinding.
Explicit names work outside tmux; unknown names are not created implicitly.

## Important delivery behavior

TMT is CLI-only. Each command exits after its operation; there is no daemon,
listener, remote service, MCP transport, or offline recipient inbox. Active
routing is limited to live panes on the current tmux server. Durable identities
and retained request/reply bodies stay in local SQLite.

Line breaks are preserved. ASCII `!` is converted to fullwidth `！` to protect
coding-agent shell/bash shortcuts, so code such as `if (!ready)` is not delivered
byte-for-byte. If tmux input may have reached the pane and TMT reports
`DELIVERY_UNCERTAIN`, inspect the pane before deciding whether to retry; a
timeout or missing visible output is not proof that nothing ran.

For command grammar and edge cases, use `tmt help`. For the complete durable
request/response contract, see
[`REQUEST-RESPONSE.md`](REQUEST-RESPONSE.md). For provider-specific skill
installation, custom skill roots, and retiring an older Claude integration, see
[`skills/README.md`](skills/README.md).

## Configuration and troubleshooting

Inspect resolved settings before changing them:

```bash
tmt config show --json
tmt config set pasteEnterDelayMs 500
tmt config set preambleEvery 3
tmt config set exchange.retentionDays 90 --global
```

| Setting                  | Default  | Scope                                                |
| ------------------------ | -------- | ---------------------------------------------------- |
| `preambleMode`           | `always` | Local override or `--global`; `always` / `disabled`  |
| `preambleEvery`          | `3`      | Local override or `--global`; `0` disables injection |
| `pasteEnterDelayMs`      | `500`    | Local override or `--global`; `0` removes the delay  |
| `exchange.retentionDays` | `90`     | Global only; new requests, integer days `1..3650`    |
| `ui.paneBadge`           | `off`    | Global only; `on` / `off`                            |

`config show --json` reports resolved values, sources, and actual file paths.
Global settings normally live in `~/.config/tmux-team/config.json`; local
overrides live in `./tmux-team.json`. Use the reported paths when a custom home
or configuration root is in use. Global-only settings cannot be set or cleared
locally. Unknown fields are preserved; invalid known fields should be repaired,
not worked around by deleting the file.

### Optional pane badge

TMT never changes `pane_title`, `pane-border-format`, border position, or colors.
The badge is **off by default**. To opt in:

```bash
tmt config set ui.paneBadge on --global
tmt name alice
```

This publishes `alice (tmt)` in the pane-local `@tmux-team.badge` option.
It does not display anything until you explicitly insert this fragment at the
desired position in your own tmux `pane-border-format`:

```text
#{?@tmux-team.badge, [#{@tmux-team.badge}],}
```

For a theme showing the pane number on the left and `repo/branch` on the right,
place the fragment after the pane number, before your right-aligned segment.
Keep the existing expressions and styles; do not replace the whole theme with
this fragment. The result is conceptually:

```text
---10.0 [alice (tmt)]----------------------------repo/branch---
```

Your theme controls color, alignment, and narrow-pane behavior. TMT does not
reserve space or move the existing right-hand segment. For black text on a light
blue background, hidden below 80 columns, an optional fragment is:

```text
#{?#{&&:#{@tmux-team.badge},#{e|>=:#{pane_width},80}},#[push-default]#[fg=black bg=colour153] #{@tmux-team.badge} #[default]#[pop-default],}
```

Adjust the width threshold for your theme; it is not an automatic fit calculation.
The style save/restore assumes your surrounding theme does not already use
`push-default`: tmux only supports one saved default, not nested style stacks.
If it does, integrate the colors using that theme's own restoration mechanism.
See the [tmux styles reference](https://man.openbsd.org/tmux#STYLES).

Display labels replace
`#` and control characters with non-executable text and truncate names after
48 Unicode code points; the stored identity name remains unchanged.

Configuration changes do not scan or rewrite panes. They apply on the next
successful `name`, `this`, or `add` for that pane. To disable the current badge:

```bash
tmt config set ui.paneBadge off --global
tmt this alice
```

`unbind` also clears the badge, even when it is disabled. Failed bindings leave
it unchanged. Badge writes are bounded and best-effort: display failures do not
undo a successful identity change. If an older TMT version already replaced
your title or border format, restore it from your saved tmux configuration;
TMT cannot reconstruct an overwritten theme.

### Installation troubleshooting

If native `tmt` is not found after installation, put `~/.local/bin` (or your
selected prefix's `bin`) first in PATH, then open a new shell or run `hash -r`.
Check `command -v tmt`, `command -v tmux-team` and the new absolute `tmt --help`;
an older npm command may still shadow the native installation. Use a user-owned
prefix instead of adding `sudo` blindly. See [npm/pnpm replacement](NATIVE-INSTALL.md#replacing-npm-or-pnpm)
before switching package managers or touching their files.

If an integration path conflicts with unmanaged files, inspect the
target first; `tmt install <provider> --force` creates a recoverable backup
outside the skills root and reports its path.
After changing skills or provider setup, reload or restart the agent session.
