# Agent Skills Installation

The recommended setup is two commands:

```bash
npm install -g tmux-team
tmt install
```

The npm `latest` channel remains the stable v4 release. This source tree is the
v5 alpha line (`5.0.0-alpha.1`), but `@alpha` is not claimed to be published.
Tags, GitHub Releases, npm publishing, and npm dist-tags remain separate
release operations.

`tmt install` auto-detects Claude Code, Codex, and Gemini CLI. It manages a
symlink at `~/.agents/skills/tmux-team` for Codex and Gemini, and installs the
Claude command where needed. Repeating it is idempotent; unmanaged paths are
only backed up and replaced with `--force`.

Managed links use new bundled files as soon as the npm package is updated, so
`tmt upgrade` updates both the CLI and linked skills. Re-run `tmt install` only
to add or repair an integration. Interactive commands perform a once-daily
cached version check and warn about newer releases; non-interactive commands
skip it. Local drift checks never use the network.

## Claude Code Plugin (Recommended)

The easiest way to add tmux-team to Claude Code is via the plugin system:

```bash
# Add tmux-team as a marketplace
/plugin marketplace add wkh237/tmux-team

# Install the plugin
/plugin install tmux-team@tmux-team
```

This gives you `/team` and `/learn` slash commands automatically.

## Quick Install

You can select an integration explicitly:

```bash
# Auto-detect environment and install
tmt install

# Or specify agent directly
tmt install claude
tmt install codex
tmt install gemini
```

After installation, use `tmux-team name <global-name>` (or its exact `this`
alias) inside each agent's tmux pane. To bind another pane, run
`tmux-team add <pane-target> <global-name>`; targets are resolved to stable
tmux `%pane_id` values. Use `tmux-team whoami` to inspect the current identity
and `tmux-team unbind` to remove it. Identities are global and remain
addressable from any working directory.

The `talk`, `check`, and `list` commands accept either a global name or a
direct pane target (`%pane_id`, `window.pane`, or `session:window.pane`):

```bash
tmt talk codex "Review this PR"
tmt check %12 100
tmt list
tmt list %12
```

The `add` order is pane target first, then global name. Older name-first
examples are rejected with a usage error. `all` is an ordinary identity name,
not a special destination.

tmux-team is CLI-only: each invocation exits after its operation and no daemon
or background service is required.

## Claude Code

Claude Code users should prefer the marketplace plugin above. It provides
`/team` and `/learn`. See the [Claude plugin docs](https://code.claude.com/docs/en/discover-plugins)
and [plugin reference](https://code.claude.com/docs/en/plugins-reference).

### Manual Install

```bash
mkdir -p ~/.claude/commands
cp skills/claude/team.md ~/.claude/commands/team.md
```

### Usage

```bash
# In Claude Code, use the slash command:
/team talk codex "Review this PR"

# Or invoke implicitly - Claude will recognize when to use it
```

## OpenAI Codex CLI

Codex discovers user skills in `~/.agents/skills` and repository skills in
`.agents/skills`. See the [Codex skills docs](https://learn.chatgpt.com/docs/build-skills).

### Manual Install

```bash
mkdir -p ~/.agents/skills/tmux-team
cp skills/codex/SKILL.md ~/.agents/skills/tmux-team/SKILL.md
```

### Usage

```bash
# Explicit invocation
$tmt talk codex "Review this PR" --wait

# Implicit - Codex auto-selects when you mention other agents
"Ask the codex agent to review the authentication code"
```

## Gemini CLI

Gemini CLI supports native Agent Skills and the shared `~/.agents/skills`
location. See the [Gemini Agent Skills guide](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/using-agent-skills.md).

## Verify Installation

After installation, verify with `tmt list` or `tmt help`. For Claude, `/help`
should show `/team`; Codex and Gemini discover the `tmux-team` skill natively.
