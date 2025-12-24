# Agent Skills Installation

tmux-team provides pre-built skills for popular AI coding agents.

## Claude Code Plugin (Recommended)

The easiest way to add tmux-team to Claude Code is via the plugin system:

```bash
# Add tmux-team as a marketplace
/plugin marketplace add wkh237/tmux-team

# Install the plugin
/plugin install tmux-team
```

This gives you `/team` and `/learn` slash commands automatically.

## Quick Install (Standalone Skills)

If you prefer standalone skills without the full plugin:

```bash
# Install for Claude Code (user-wide)
tmux-team install-skill claude

# Install for OpenAI Codex (user-wide)
tmux-team install-skill codex

# Install to project directory (local scope)
tmux-team install-skill claude --local
tmux-team install-skill codex --local
```

## Claude Code

Claude Code uses slash commands stored in `~/.claude/commands/` (user) or `.claude/commands/` (local).

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

Codex uses skills stored in `~/.codex/skills/<skill-name>/` (user) or `.codex/skills/<skill-name>/` (local).

### Manual Install

```bash
mkdir -p ~/.codex/skills/tmux-team
cp skills/codex/SKILL.md ~/.codex/skills/tmux-team/SKILL.md
```

### Enable Skills (Required)

Skills require the feature flag:

```bash
codex --enable skills
```

Or set in your config to enable by default.

### Usage

```bash
# Explicit invocation
$tmux-team talk codex "Review this PR"

# Implicit - Codex auto-selects when you mention other agents
"Ask the codex agent to review the authentication code"
```

## Gemini CLI

Gemini CLI doesn't have a native skill system yet. Use the preamble feature instead:

```json
{
  "gemini": {
    "pane": "%2",
    "preamble": "You can communicate with other agents using tmux-team CLI. Run `tmux-team help` to learn more."
  }
}
```

Save this to `tmux-team.json` in your project root.

## Verify Installation

After installation, verify the skill is recognized:

**Claude Code:**
```
/help
# Should show: /team - Talk to peer agents...
```

**Codex:**
```
/skills
# Should show: tmux-team
```
