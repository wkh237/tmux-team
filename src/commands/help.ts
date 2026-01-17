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
  tmux-team <command> [arguments]

${colors.yellow('COMMANDS')}
  ${colors.green('talk')} <target> <message>     Send message to an agent (or "all")
  ${colors.green('check')} <target> [lines]      Capture output from agent's pane
  ${colors.green('list')}                        List all configured agents
  ${colors.green('add')} <name> <pane> [remark]  Add a new agent
  ${colors.green('this')} <name> [remark]       Register current pane as an agent
  ${colors.green('update')} <name> [options]     Update an agent's config
  ${colors.green('remove')} <name>               Remove an agent
  ${colors.green('install')} [claude|codex]       Install tmux-team for an AI agent
  ${colors.green('init')}                        Create empty tmux-team.json
  ${colors.green('config')} [show|set|clear]     View/modify settings
  ${colors.green('preamble')} [show|set|clear]   Manage agent preambles
  ${colors.green('completion')}                  Output shell completion script
  ${colors.green('learn')}                       Show educational guide
  ${colors.green('help')}                        Show this help message

${colors.yellow('OPTIONS')}
  ${colors.green('--json')}                      Output in JSON format
  ${colors.green('--verbose')}                   Show detailed output
  ${colors.green('--force')}                     Skip warnings
  ${colors.green('--team')} <name>               Use shared team (cross-folder)

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
  tmux-team talk all "Status update"        ${colors.dim('← waits for all agents')}`
      : `
  ${colors.dim('# Polling mode: send then check')}
  tmux-team talk codex "Review this PR"     ${colors.dim('← sends immediately')}
  tmux-team check codex                     ${colors.dim('← read response later')}`
  }
  tmux-team list --json
  tmux-team add codex 10.1 "Code review specialist"

${colors.yellow('CONFIG')}
  Local:  ./tmux-team.json (pane registry + $config override)
  Global: ~/.config/tmux-team/config.json (settings)
  Teams:  ~/.config/tmux-team/teams/<name>.json (shared teams)

${colors.yellow('CHANGE MODE')}
  tmux-team config set mode wait            ${colors.dim('Enable wait mode (local)')}
  tmux-team config set mode polling         ${colors.dim('Enable polling mode (local)')}
  tmux-team config set preambleMode disabled ${colors.dim('Disable preambles (local)')}
  tmux-team config set preambleEvery 5      ${colors.dim('Inject preamble every 5 messages')}
`);
}
