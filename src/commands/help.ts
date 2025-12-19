// ─────────────────────────────────────────────────────────────
// help command - show usage information
// ─────────────────────────────────────────────────────────────

import { colors } from '../ui.js';
import { VERSION } from '../version.js';

export function cmdHelp(): void {
  console.log(`
${colors.cyan('tmux-team')} v${VERSION} - AI agent collaboration in tmux

${colors.yellow('USAGE')}
  tmux-team <command> [arguments]

${colors.yellow('COMMANDS')}
  ${colors.green('talk')} <target> <message>     Send message to an agent (or "all")
  ${colors.green('check')} <target> [lines]      Capture output from agent's pane
  ${colors.green('list')}                        List all configured agents
  ${colors.green('add')} <name> <pane> [remark]  Add a new agent
  ${colors.green('update')} <name> [options]     Update an agent's config
  ${colors.green('remove')} <name>               Remove an agent
  ${colors.green('init')}                        Create empty tmux-team.json
  ${colors.green('config')} [show|set|clear]     View/modify settings
  ${colors.green('preamble')} [show|set|clear]   Manage agent preambles
  ${colors.green('pm')} <subcommand>             Project management (run 'pm help')
  ${colors.green('completion')}                  Output shell completion script
  ${colors.green('help')}                        Show this help message

${colors.yellow('OPTIONS')}
  ${colors.green('--json')}                      Output in JSON format
  ${colors.green('--verbose')}                   Show detailed output
  ${colors.green('--force')}                     Skip warnings

${colors.yellow('TALK OPTIONS')} ${colors.dim('(v2)')}
  ${colors.green('--delay')} <seconds>           Wait before sending (default: seconds)
  ${colors.green('--wait')}                      Wait for agent response (nonce-based)
  ${colors.green('--timeout')} <seconds>         Max wait time (default: 60)
  ${colors.green('--no-preamble')}               Skip agent preamble for this message

${colors.yellow('EXAMPLES')}
  tmux-team talk codex "Please review the PR"
  tmux-team talk all "Sync meeting in 5 minutes"
  tmux-team check gemini 50
  tmux-team list --json
  tmux-team add codex 10.1 "Code review specialist"
  tmux-team update codex --pane 10.2
  tmux-team remove codex

${colors.yellow('CONFIG')}
  Local:  ./tmux-team.json (pane registry + $config override)
  Global: ~/.config/tmux-team/config.json (settings)

${colors.yellow('CONFIG EXAMPLES')}
  tmux-team config                     Show current settings
  tmux-team config set mode wait       Set mode in local config (repo override)
  tmux-team config set mode polling --global  Set mode in global config
  tmux-team config clear mode          Clear local override for mode
  tmux-team config clear               Clear all local overrides

${colors.yellow('PREAMBLE EXAMPLES')}
  tmux-team preamble                   Show all preambles
  tmux-team preamble show codex        Show preamble for codex
  tmux-team preamble set codex "You are a code reviewer. Be concise."
  tmux-team preamble clear codex       Clear preamble for codex
`);
}
