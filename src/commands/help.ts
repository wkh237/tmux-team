// ─────────────────────────────────────────────────────────────
// help command - show usage information
// ─────────────────────────────────────────────────────────────

import { colors } from '../ui.js';
import { VERSION } from '../version.js';

export interface HelpConfig {
  mode?: 'polling' | 'wait';
  timeout?: number;
  showIntro?: boolean;
}

export function cmdHelp(config?: HelpConfig): void {
  const mode = config?.mode ?? 'wait';
  const timeout = config?.timeout ?? 180;
  const isWaitMode = mode === 'wait';

  // Show intro highlight when running just `tmux-team` with no args
  if (config?.showIntro) {
    console.log(`
${colors.cyan('┌─────────────────────────────────────────────────────────────┐')}
${colors.cyan('│')}  ${colors.yellow('New to tmux-team?')} Run ${colors.green('tmux-team learn')} or ${colors.green('tmt learn')}         ${colors.cyan('│')}
${colors.cyan('│')}  ${colors.dim('tmt is a shorthand alias for tmux-team')}                      ${colors.cyan('│')}
${colors.cyan('└─────────────────────────────────────────────────────────────┘')}`);
  }

  // Mode indicator with clear explanation
  const modeInfo = isWaitMode
    ? `${colors.yellow('CURRENT MODE')}: ${colors.green('wait')} (timeout: ${timeout}s) ${colors.green('✓ recommended')}
  ${colors.dim('→ talk commands will BLOCK until agent responds or timeout')}
  ${colors.dim('→ Response is returned directly, no need to use check command')}`
    : `${colors.yellow('CURRENT MODE')}: ${colors.cyan('polling')}
  ${colors.dim('→ talk commands send and return immediately')}
  ${colors.dim('→ Use check command to read agent response')}
  ${colors.dim('→')} ${colors.yellow('TIP')}: ${colors.dim('Use --wait or set mode to wait for better token utilization')}`;

  console.log(`
${colors.cyan('tmux-team')} v${VERSION} - AI agent collaboration in tmux
${colors.dim('Alias: tmt')}

${modeInfo}

${colors.yellow('USAGE')}
  tmt <command> [arguments]

${colors.yellow('COMMANDS')}
  ${colors.green('talk')} <target> <message>     Send message to an identity or pane
  ${colors.green('check')} <target> [lines]      Capture output from agent's pane
  ${colors.green('list')} [target]                List active identities or pane status
  ${colors.green('add')} <pane-target> <global-name> Bind an explicit pane identity
  ${colors.green('this')} <global-name>       Bind the current pane (alias of name)
  ${colors.green('name')} <global-name>       Bind the current pane identity
  ${colors.green('whoami')}                   Show the current pane identity
  ${colors.green('unbind')}                   Remove the current pane identity
  ${colors.green('install')} [claude|codex|gemini|all] Install/refresh agent skills
  ${colors.green('upgrade')}                     Upgrade tmux-team (links update automatically)
  ${colors.green('init')}                        Create empty tmux-team.json
  ${colors.green('config')} [show|set|clear]     View/modify settings
  ${colors.green('preamble')} [show|set|clear]   Manage legacy workspace preambles
  ${colors.green('role')} <show|set|clear>      Manage durable identity role profiles
  ${colors.green('completion')}                  Output shell completion script
  ${colors.green('learn')}                       Show educational guide
  ${colors.green('help')}                        Show this help message

${colors.yellow('OPTIONS')}
  ${colors.green('--json')}                      Output in JSON format
  ${colors.green('--verbose')}                   Show detailed output
  ${colors.green('--force')}                     Skip warnings

${colors.yellow('ROLE USAGE')}
  tmt role show [--identity <name>]
  tmt role set <profile> [--identity <name>]
  tmt role set --file <path> [--identity <name>]
  tmt role clear [--identity <name>]
  Omit --identity only in a verified bound pane; explicit offline identities are supported.

${colors.yellow('CALLER CONTEXT')}
  name, this, whoami and unbind require matching live TMUX/TMUX_PANE context.
  Missing or stale caller: PANE_NOT_FOUND (exit 3); implicit role: IDENTITY_REQUIRED (exit 1).
  Outside tmux, use explicit add/talk/check targets or role --identity <name>.

${colors.yellow('TALK OPTIONS')}
  ${colors.green('--delay')} <seconds>           Wait before sending
  ${colors.green('--wait')}                      Force wait mode (block until response)
  ${colors.green('--timeout')} <seconds>         Max wait time (current: ${timeout}s)
  ${colors.green('--lines')} <number>            Lines to capture (default: 100)
  ${colors.green('--no-preamble')}               Skip agent preamble for this message
  ${colors.green('--debug')}                     Show debug output

${colors.yellow('EXAMPLES')}${
    isWaitMode
      ? `
  ${colors.dim('# Wait mode: commands block until response')}
  tmux-team talk codex "Review this PR"     ${colors.dim('← blocks, returns response')}
  tmux-team talk %12 "Status update"       ${colors.dim('← waits for one pane')}`
      : `
  ${colors.dim('# Polling mode: send then check')}
  tmux-team talk codex "Review this PR"     ${colors.dim('← sends immediately')}
  tmux-team check codex                     ${colors.dim('← read response later')}`
  }
  tmux-team list --json
  tmux-team list main:1.0
  tmux-team add 10.1 codex
  tmux-team name backend
  tmt install
  tmt upgrade

${colors.yellow('CONFIG')}
  Runtime: active global identities in tmux pane metadata
  Local:  ./tmux-team.json (legacy registry + settings override)
  Global: ~/.config/tmux-team/config.json (settings)

${colors.yellow('CHANGE MODE')}
  tmux-team config set mode wait            ${colors.dim('Enable wait mode (local)')}
  tmux-team config set mode polling         ${colors.dim('Enable polling mode (local)')}
  tmux-team config set preambleMode disabled ${colors.dim('Disable preambles (local)')}
  tmux-team config set preambleEvery 5      ${colors.dim('Inject preamble every 5 messages')}
`);
}
