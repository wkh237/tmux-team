// ─────────────────────────────────────────────────────────────
// learn command - educational guide for tmux-team
// ─────────────────────────────────────────────────────────────

import { colors } from '../ui.js';

export function cmdLearn(): void {
  console.log(`
${colors.cyan('tmux-team')} - Multi-Agent Coordination Guide

${colors.yellow('WHAT IS TMUX-TEAM?')}

  tmux-team enables AI agents (Claude, Codex, Gemini) running in separate
  terminal panes to communicate with each other. Think of it as a messaging
  system for terminal-based AI agents.

${colors.yellow('CORE CONCEPT')}

  Each agent runs in its own tmux pane. When you talk to another agent:
  1. Your message is pasted via a tmux buffer
  2. tmux-team waits briefly, then sends Enter to submit
  3. You read their response by capturing their pane output

${colors.yellow('ESSENTIAL COMMANDS')}

  ${colors.green('tmux-team list')}                     List available agents
  ${colors.green('tmux-team talk')} <agent> "<msg>"     Send a message
  ${colors.green('tmux-team check')} <agent> [lines]    Read agent's response
  ${colors.green('tmux-team talk')} <agent> --wait      Send and wait for response

${colors.yellow('RECOMMENDED: ASYNC MODE (--wait)')}

  The ${colors.green('--wait')} flag is recommended for better token utilization:

  ${colors.dim('# Without --wait (polling mode):')}
  tmux-team talk codex "Review this code"
  ${colors.dim('# ... wait manually ...')}
  tmux-team check codex                    ${colors.dim('← extra command')}

  ${colors.dim('# With --wait (async mode):')}
  tmux-team talk codex "Review this code" --wait
  ${colors.dim('↳ Blocks until response, returns it directly')}

  Enable by default: ${colors.cyan('tmux-team config set mode wait')}

${colors.yellow('PRACTICAL EXAMPLES')}

  ${colors.dim('# Quick question (async)')}
  tmux-team talk codex "What's the auth status?" --wait

  ${colors.dim('# Delegate a task with timeout')}
  tmux-team talk gemini "Implement login form" --wait --timeout 300

  ${colors.dim('# Broadcast to all agents')}
  tmux-team talk all "Sync: PR #123 was merged" --wait

${colors.yellow('CONFIGURATION')}

  Config file: ${colors.cyan('./tmux-team.json')}

  {
    "$config": { "mode": "wait", "pasteEnterDelayMs": 500 },
    "codex": { "pane": "%1", "remark": "Code reviewer" },
    "gemini": { "pane": "%2", "remark": "Documentation" }
  }

  Find your pane ID: ${colors.cyan('tmux display-message -p "#{pane_id}"')}

${colors.yellow('BEST PRACTICES')}

  1. ${colors.green('Use --wait for important tasks')} - ensures complete response
  2. ${colors.green('Be explicit')} - tell agents exactly what you need
  3. ${colors.green('Set timeout appropriately')} - complex tasks need more time
  4. ${colors.green('Broadcast sparingly')} - only for announcements everyone needs

${colors.yellow('NEXT STEP')}

  Run ${colors.cyan('tmux-team list')} to see available agents in your project.
`);
}
