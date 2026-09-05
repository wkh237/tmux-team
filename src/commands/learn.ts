// ─────────────────────────────────────────────────────────────
// learn command - educational guide for tmux-team
// ─────────────────────────────────────────────────────────────

import { colors } from '../ui.js';

export function cmdLearn(): void {
  console.log(`
${colors.cyan('tmux-team')} - Multi-Agent Coordination Guide

${colors.yellow('WHAT IS TMUX-TEAM?')}

  tmux-team enables terminal agents running in separate tmux panes to
  communicate with each other through active global identities.

${colors.yellow('CORE CONCEPT')}

  Each agent runs in its own tmux pane. When you talk to another agent:
  1. Your message is pasted via a tmux buffer
  2. tmux-team waits briefly, then sends Enter to submit
  3. You read their response by capturing their pane output

${colors.yellow('ESSENTIAL COMMANDS')}

  ${colors.green('tmux-team list')}                     List active identities
  ${colors.green('tmux-team talk')} <target> "<msg>"   Send a message
  ${colors.green('tmux-team check')} <target> [lines]  Read pane output
  ${colors.green('tmux-team talk')} <target> --wait    Send and wait for response

${colors.yellow('RECOMMENDED: WAIT MODE (--wait)')}

  The ${colors.green('--wait')} flag is recommended for better token utilization:

  ${colors.dim('# Without --wait (polling mode):')}
  tmux-team talk codex "Review this code"
  ${colors.dim('# ... wait manually ...')}
  tmux-team check codex                    ${colors.dim('← extra command')}

  ${colors.dim('# With --wait:')}
  tmux-team talk codex "Review this code" --wait
  ${colors.dim('↳ Blocks until response, returns it directly')}

  Enable by default: ${colors.cyan('tmux-team config set mode wait')}

${colors.yellow('PRACTICAL EXAMPLES')}

  ${colors.dim('# Quick question')}
  tmux-team talk codex "What's the auth status?" --wait

  ${colors.dim('# Delegate a task with timeout')}
  tmux-team talk gemini "Implement login form" --wait --timeout 300

${colors.yellow('GLOBAL IDENTITIES')}

  Identity bindings live in active tmux pane metadata and work across folders:

  ${colors.cyan('tmux-team name codex')}        Bind the current pane
  ${colors.cyan('tmux-team add %2 gemini')}     Bind another pane by stable ID

  Find your pane ID: ${colors.cyan('tmux display-message -p "#{pane_id}"')}
  ${colors.dim('Legacy registry commands are retired; local settings and preamble compatibility remain.')}
  ${colors.dim('tmux-team is CLI-only; there is no daemon to run.')}

${colors.yellow('BEST PRACTICES')}

  1. ${colors.green('Use --wait for important tasks')} - ensures complete response
  2. ${colors.green('Be explicit')} - tell agents exactly what you need
  3. ${colors.green('Set timeout appropriately')} - complex tasks need more time
  4. ${colors.green('Use stable pane IDs in scripts')} - avoid ambiguous locators

${colors.yellow('NEXT STEP')}

  Run ${colors.cyan('tmux-team list')} to see active global identities.
`);
}
