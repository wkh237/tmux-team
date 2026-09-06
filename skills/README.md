# Agent skill installation

Install the CLI using the [README instructions](../README.md#v5-preview-installation),
then run `tmt install`. No plugin, marketplace, or separate slash-command package
is required. All providers use the same bundled [skill](tmux-team/SKILL.md).

## Install

```bash
tmt install          # Detect installed providers
tmt install claude   # Or select one explicitly
tmt install codex
tmt install gemini
```

| Provider         | Native skill location                 |
| ---------------- | ------------------------------------- |
| Claude Code      | `~/.claude/skills/tmux-team/SKILL.md` |
| Codex and Gemini | `~/.agents/skills/tmux-team/SKILL.md` |

The containing directory is a managed link to the installed package. Repeating
installation is a no-op when the link is correct. Package updates at the same
location update the linked instructions; rerun installation after relocation.
`tmt upgrade` follows npm `latest`, not the unpublished v5 preview; follow the
README's preview instructions to select a new revision.

Load the skill in your agent before collaborating. Claude Code's native skill
can be invoked as `/tmux-team`; the CLI remains `tmt`. Installing files does not
guarantee an already-running agent has reloaded them. Use its skill discovery
or restart the session when necessary. The [Claude skill documentation](https://code.claude.com/docs/en/skills)
describes its native personal skill location and invocation.

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
