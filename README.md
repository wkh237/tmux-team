# tmux-team

Your coding agents, working together. Send work to a tmux pane by name, get
complete replies, and recover outstanding tasks without digging through terminal
history. A standalone native CLI—no Node.js, Rust toolchain, or daemon required.

## Install

Native alpha for macOS and Linux, arm64 and x64. No Node, npm, pnpm or Rust
toolchain needed.

[Download the installer](https://github.com/wkh237/tmux-team/releases/download/v5.0.0-alpha.2/tmt-installer.sh),
then run it from the download folder:

```sh
sh tmt-installer.sh
```

Installs into `~/.local/bin` and sets up the agent skill non-interactively.
If `tmt` is not found, complete the [one-time PATH setup](NATIVE-INSTALL.md#one-time-path-setup).
Reload your agent's skills. Update later with `tmt upgrade`—no reinstall or
repeated PATH setup.

Prefer curl, a custom location, or replacing an older installation? See
[installation options](NATIVE-INSTALL.md). The installer never uninstalls old
packages or deletes application data.

tmux is needed for live pane operations: binding, messaging and inspection.
Explicit local identity/profile access and stored results work without it. There is no
non-tmux receiving agent transport yet.

## Quick start

For the receiving agent, start a tmux session if needed:

```bash
tmux new -s tmt
```

Name the target pane from its shell, then launch your agent:

```bash
tmt name reviewer
gemini
```

From another terminal or tmux pane on the same machine (the sender need not be
inside tmux):

```bash
tmt talk reviewer "Review the current changes and report concrete risks."
```

The receiving agent's skill explains how to submit its complete reply. `talk`
waits for that stored reply, not terminal markers or idle output. Use
`--detach` to return immediately and `tmt result <request-id>` to collect it later.

Names are global, not folder-scoped. Pane identities are temporary by default;
use `tmt name reviewer -s` to save one. `tmt ls` shows lifetime and presence.
`tmt rm reviewer` removes a temporary identity; saved removal requires `--force`.
Neither removal nor unbinding kills the pane.

## Recover outstanding work

A saved originator identity lets you recover requests after timeout, detach or
pane loss, including when the caller is outside tmux:

```bash
tmt identity create coordinator
tmt talk reviewer "Run the agreed checks." --identity coordinator --detach --json
tmt x --identity coordinator --json
tmt x show <request-id> --identity coordinator --json
tmt x ackall --identity coordinator --json
```

Reads never acknowledge results. `ackall` marks the current snapshot handled;
a later reply appears again. Acknowledgment neither cancels work nor asserts success.

## One skill, no plugin

`tmt install` supports Claude Code, Codex, Gemini, agy, Pi and OpenCode. If none
is detected, it installs the shared skill. Use `tmt install --dir <skills-root>`
for another discovery folder. No plugin or separate `/team` command is needed;
Claude Code can invoke the skill as `/tmux-team`.

For an existing conversation, ask the agent to read `tmt learn --skill` after
updating. Installation does not reload a running agent. See the
[provider guide](skills/README.md) and [canonical skill](skills/tmux-team/SKILL.md).

## Boundaries worth knowing

TMT routes to live panes on the current tmux server. Identities, profiles and
retained exchanges live in local SQLite. There is no offline recipient queue,
remote routing, shared memory, authentication, or MCP connectivity yet.

Your tmux titles and border layout stay untouched. Badges are off by default;
see [optional pane badges](USER-GUIDE.md#optional-pane-badge). Inspect settings
with `tmt config show --json`.

ASCII `!` becomes fullwidth `！` in delivered messages to protect coding-agent
shell shortcuts. If delivery becomes uncertain, inspect before retrying; a
timeout alone is not permission to resend.

See the [user guide](USER-GUIDE.md) for roles, preambles, configuration and
failure handling, or `tmt help` for command options.

## Development

Office is an optional work in progress. Its CLI installation/status commands are
implemented; source builds also support pairing and scoped access with renewable
leases. No public Office release is available yet. See
[Office commands](docs/office/commands.md); ordinary TMT use does not require it.

Contributor-only requirements and checks are in [development](DEVELOPMENT.md).
See [architecture](ARCHITECTURE.md) for runtime and test ownership.

## License

MIT
