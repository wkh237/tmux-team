# Agent skill installation

Install the native alpha using the [README instructions](../README.md), then run
`tmt install`. Use the installer asset from a published release; the README
supplies the verified version URL when one is available. No plugin, marketplace
or separate slash-command package is required. All providers use the same bundled
[skill](tmux-team/SKILL.md).

The native runtime needs no Node.js, Rust toolchain or source checkout; tmux is
still required for pane operations. Native bindings are temporary by default:
use `-s`/`--save` to keep one, and `tmt rm <name>` to retire a temporary identity
(`--force` is required for a saved identity). Native schema 9 is forward-only;
do not use the legacy TypeScript runtime on a native database.

## Install

```bash
tmt install          # Detect installed providers
tmt install claude   # Or select one explicitly
tmt install codex
tmt install gemini
tmt install agy
tmt install pi
tmt install opencode
tmt install all      # Install for every supported provider
```

| Provider                   | Native skill location                        |
| -------------------------- | -------------------------------------------- |
| Claude Code                | `~/.claude/skills/tmux-team/SKILL.md`        |
| Codex, Gemini and OpenCode | `~/.agents/skills/tmux-team/SKILL.md`        |
| Antigravity CLI (`agy`)    | `~/.gemini/config/skills/tmux-team/SKILL.md` |
| Pi                         | `~/.pi/agent/skills/tmux-team/SKILL.md`      |

Installation is non-interactive and accepts `--json`. If no provider is detected,
the shared `~/.agents/skills/tmux-team` target is installed without claiming a
provider was found; its JSON result has `target` and `changed`, but no `agent`.
This does not install the agent applications themselves. Explicit selectors work
even before the selected provider is installed.

Pi honors `PI_CODING_AGENT_DIR`: its target is `<agent-dir>/skills/tmux-team`.
OpenCode's configuration directory is used for detection, including
`OPENCODE_CONFIG_DIR` or `XDG_CONFIG_HOME`, but its installed skill remains in the shared home location.
Use `--dir` for a different skill discovery root; TMT does not edit provider settings.

The containing directory is a managed link to the installed native skill
package. Repeating installation is a no-op when the link is correct. Native
`tmt upgrade`/`tmt update` refreshes recorded managed skills through the newly
activated executable; use `--channel stable|alpha`, `--to <version>`, or
`--unpin` as needed. A skill refresh can fail after binary activation and is
reported as partial completion; resolve the conflict and repeat the same
selection.

The legacy TypeScript `tmt upgrade` follows npm `latest` and cannot update a
native installation. Use the original manager for package-manager installations.

Load the skill in your agent before collaborating. Claude Code's native skill
can be invoked as `/tmux-team`; the CLI remains `tmt`. Installing files does not
guarantee an already-running agent has reloaded them. Use its skill discovery
or restart the session when necessary. The [Claude skill documentation](https://code.claude.com/docs/en/skills)
describes its native personal skill location and invocation.

Pi exposes `/skill:tmux-team`; OpenCode loads `tmux-team` through its `skill`
tool. Antigravity discovers skill metadata when starting a conversation; ask it
to load `tmux-team` or explicitly read `tmt learn --skill`. Provider permissions
or disabled skill discovery can still prevent loading. Installing a link is not
proof that a running session has loaded its content.

Paths follow the [Antigravity skill documentation](https://www.agy.dev/docs/skills/),
[Pi documentation](https://pi.dev/docs/latest/skills), and
[OpenCode documentation](https://opencode.ai/docs/skills).
Pi's native path also supports the locally verified 0.85.0 loader, which does not
discover the shared `.agents` path by default. Older Antigravity documentation
lists different directories; use a current CLI or explicitly select its actual
discovery root rather than installing multiple competing copies.

## Inspect or choose a folder

```bash
tmt learn --skill
tmt install --dir './project skills'
```

`learn --skill` prints the exact bundled skill; plain `learn` is a short guide.
Custom installation creates `./project skills/tmux-team` relative to the current
directory. Choose a folder your provider discovers, and do not combine `--dir`
with a provider or `all`. Custom installs do not migrate default paths or touch
unrelated siblings. Automatic drift reminders cover default locations, not
arbitrary custom folders.

## Existing installations

Update the native CLI using a published release's installer asset, run
`tmt install` if needed, then reload or restart the agent. For an existing conversation,
ask the agent to run `tmt learn --skill`, read the complete output, and use it
instead of remembered instructions from an older version.

Replacing npm, pnpm, Homebrew or manual installations does not migrate or delete
their application data or files. Stop old writers before switching and verify
`command -v tmt`, `command -v tmux-team`, and the new absolute `tmt --help`.

Existing unmanaged targets are preserved by default. Inspect a conflict before
using `tmt install <provider> --force`; replacement creates a recoverable backup.
Skill target backups are stored in a sibling `.tmt-skill-backups` directory
outside the skills root so agents do not discover them as duplicate skills.
The installer reports backup paths. Do not delete the source package or your
identity database to repair a skill link.

The old Claude `~/.claude/commands/team.md` entry is no longer installed or
updated. `tmt install claude` preserves an existing entry and warns; after the
native skill is installed successfully, `tmt install claude --force` can move
that old entry to a recoverable backup. Other commands are untouched. Local
drift checks also report retired command entries, including broken links.

Previously installed Claude marketplace plugins are managed by Claude, not by
TMT. Remove or disable the old `tmux-team` plugin through Claude's plugin manager
after checking the native skill works, to avoid duplicate guidance. TMT does not
edit plugin settings, delete cached plugins, or uninstall them automatically.

## Verify

```bash
tmt --version
tmt learn --skill
tmt install claude --json   # A correct existing link reports changed: false
```

Use [the quick start](../README.md#quick-start) for the first live exchange and
[the user guide](../USER-GUIDE.md) for recovery, roles, and configuration.
