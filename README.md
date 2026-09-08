# tmux-team

Your coding agents, working together. Send work to a tmux pane by name, get
complete replies, and recover outstanding tasks without digging through terminal
history. A standalone native CLI—no Node.js, Rust toolchain, or daemon required.

## Install

Native `5.0.0-alpha.2` for macOS and Linux, arm64 and x64. tmux is required for
pane operations.

```bash
curl -fsSL --proto '=https' --proto-redir '=https' https://github.com/wkh237/tmux-team/releases/download/v5.0.0-alpha.2/tmt-installer.sh | sh
export PATH="$HOME/.local/bin:$PATH"
tmt --version
```

Installs into `~/.local/bin` and sets up the agent skill non-interactively.
Keep that directory in your shell's PATH and reload your agent's skills.
Update later with `tmt upgrade` (`tmt update` works too).

Already using npm or pnpm? Read [replacement and PATH guidance](NATIVE-INSTALL.md#replacing-npm-or-pnpm)
first. The installer does not uninstall old packages or transfer/delete data.
Old TypeScript writers must not use native SQLite state.

For custom prefixes, pinning, binary-only installation, or inspecting the
installer before running it, see [native installation](NATIVE-INSTALL.md).
Downloads and integrity evidence are in the [alpha release](https://github.com/wkh237/tmux-team/releases/tag/v5.0.0-alpha.2).

## Quick start

Start a tmux session if needed:

```bash
tmux new -s tmt
```

Name the target pane from its shell, then launch your agent:

```bash
tmt name reviewer
gemini
```

From another terminal or tmux pane:

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

`rust/` owns the native runtime. Root npm entrypoints and TypeScript sources
remain transitional reference/test tooling; installing the source through npm
does not install the native release above. See [development](DEVELOPMENT.md),
[architecture](ARCHITECTURE.md) and the [rewrite tracker](https://github.com/wkh237/tmux-team/issues/93).

## License

MIT
