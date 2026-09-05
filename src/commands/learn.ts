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

${colors.yellow('DURABLE REPLIES AND RESULTS')}

  When TMT supplies an exact receipt, submit a complete response without tmux:
  ${colors.cyan('tmt reply <request-id> --receipt <receipt> --file response.md')}
  ${colors.cyan('tmt reply <request-id> --receipt <receipt> --stdin < response.md')}
  ${colors.cyan('tmt result <request-id> --json')}

  Use exactly one input source and never manufacture a receipt, select the
  latest request, or infer a pane. talk remains marker-based in this release
  and does not generate receipts; TMT-39 owns receipt generation and durable
  completion. There is no --detach behavior yet. Submission confirms result
  delivery, not task success; summarize only after successful submission.

  Bodies preserve exact valid UTF-8 up to 1 MiB, including empty, whitespace,
  BOM, NUL, CR/LF, Unicode, and marker-like text. Stdin is EOF-driven with a
  five-second deadline. result reports RESPONSE_NOT_AVAILABLE (exit 3) for
  pending, unknown, or expired bodies; input errors exit 1, timeout exits 4,
  and conflicts exit 5. JSON unavailable output is
  {status:"unavailable",requestId,error:{code:"RESPONSE_NOT_AVAILABLE",message}}.
  Identical retries keep the original submission timestamp; conflicting bodies
  cannot replace stored results.
  Receipts are local correlation, not remote authentication. Bodies are
  retained seven days; retry only with the same receipt/body while retained.
  Missing results do not cancel work. Surface failed submission without a
  success summary, and never resubmit after accepted delivery.

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

  SQLite owns durable identities; active bindings require verified tmux evidence:

  ${colors.cyan('tmux-team name codex')}        Bind the current pane
  ${colors.cyan('tmux-team add %2 gemini')}     Bind another pane by stable ID

  Find your pane ID: ${colors.cyan('tmux display-message -p "#{pane_id}"')}
  ${colors.dim('Legacy registry commands are retired; local settings and durable identity preambles remain.')}
  ${colors.dim('tmux-team is CLI-only; there is no daemon to run.')}

${colors.yellow('BEST PRACTICES')}

  1. ${colors.green('Use --wait for correlated completion')} - captured response text is best-effort
  2. ${colors.green('Be explicit')} - tell agents exactly what you need
  3. ${colors.green('Set timeout appropriately')} - complex tasks need more time
  4. ${colors.green('Use stable pane IDs in scripts')} - avoid ambiguous locators

${colors.yellow('NEXT STEP')}

  Run ${colors.cyan('tmux-team list')} to see active global identities.
`);
}
