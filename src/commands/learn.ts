// ─────────────────────────────────────────────────────────────
// learn command - educational guide for tmux-team
// ─────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { colors } from '../ui.js';
import { getUniversalSkillFile } from '../skill-installation.js';

export function cmdLearn(skill = false): void {
  if (skill) {
    process.stdout.write(readFileSync(getUniversalSkillFile(), 'utf8'));
    return;
  }
  console.log(`
${colors.cyan('tmux-team')} - Multi-Agent Coordination Guide

${colors.yellow('WHAT IS TMUX-TEAM?')}

  tmux-team enables terminal agents running in separate tmux panes to
  communicate with each other through active global identities.

${colors.yellow('CORE CONCEPT')}

  A recipient runs in a tmux pane; the caller does not have to. When you talk:
  1. Your message is pasted via a tmux buffer
  2. tmux-team waits briefly, then sends Enter to submit
  3. The recipient submits its complete final through tmt reply
  4. Talk returns that retained body; check is only a diagnostic pane snapshot

${colors.yellow('ESSENTIAL COMMANDS')}

  ${colors.green('tmux-team list')}                     List active identities
  ${colors.green('tmux-team talk')} <target> "<msg>"   Send a message
  ${colors.green('tmux-team check')} <target> [lines]  Read pane output
  ${colors.green('tmux-team talk')} <target> "<msg>" --detach  Send without waiting
  ${colors.green('tmux-team result')} <request-id> --json      Retrieve a retained final

${colors.yellow('DURABLE IDENTITIES')}

  tmt identity create coordinator --json
  tmt identity show coordinator --json
  tmt identity list --json

  These commands work inside or outside tmux. Repeated creation preserves the
  existing UUID, display name, profiles and pane binding. Nothing logs in or
  binds automatically. identity list includes unbound identities; ordinary
  list shows active destinations. Use talk --identity coordinator for explicit
  local attribution, not authentication. A recipient still needs a live pane.

${colors.yellow('DURABLE REPLIES AND RESULTS')}

  When TMT supplies an exact receipt, submit a complete response without tmux:
  ${colors.cyan("tmt reply <request-id> --receipt <receipt> --message 'Review complete.'")}
  ${colors.cyan('tmt reply <request-id> --receipt <receipt> --file response.md')}
  ${colors.cyan('tmt reply <request-id> --receipt <receipt> --stdin < response.md')}
  ${colors.cyan('tmt result <request-id> --json')}

  Short replies can use --message; quote for the shell and use --message='-text'
  for a leading hyphen. Use file/stdin for large bodies or NUL (argv limits apply).
  Use exactly one input source and never manufacture a receipt, select the
  latest request, or infer a pane. talk supplies the exact request ID/receipt
  for both default wait and detached requests. Submission confirms result
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
  retained for the request's frozen duration (90 days by default, seven for
  pre-migration requests). Retry only with the same receipt/body while retained.
  Missing results do not cancel work. Surface failed submission without a
  success summary, and never resubmit after accepted delivery.

${colors.yellow('DEFAULT WAIT, TIMEOUT AND DETACH')}

  Talk waits by default (180 seconds unless defaults.timeout is configured).
  --timeout accepts positive seconds or ms/s suffixes, at most 24 hours.
  Use --detach to return a request ID after sending; do not combine with --timeout.
  --wait is retired; --lines belongs to check, not talk. Stored mode settings
  are inert and preserved; config clear mode removes only the obsolete local key.
  Timeout/interrupt ends the observer, not the task. Preserve the request ID
  and use result later; never automatically resend. The clock includes send/Enter
  time after preparation/delay, but cannot interrupt synchronous transport.
  Markers, idle panes and summaries never complete a request without a reply.
  Same-pane input serialization and exactly-once processing are not guaranteed.

${colors.yellow('PRACTICAL EXAMPLES')}

  ${colors.dim('# Quick question')}
  tmux-team talk codex "What's the auth status?" --json

  ${colors.dim('# Delegate a task with timeout')}
  tmux-team talk gemini "Implement login form" --timeout 300 --json
  tmux-team talk gemini "Run the agreed tests" --detach --json
  tmux-team result <request-id> --json

${colors.yellow('GLOBAL IDENTITIES')}

  SQLite owns durable identities; active bindings require verified tmux evidence:

  ${colors.cyan('tmux-team name codex')}        Bind the current pane
  ${colors.cyan('tmux-team add %2 gemini')}     Bind another pane by stable ID

  Find your pane ID: ${colors.cyan('tmux display-message -p "#{pane_id}"')}
  ${colors.dim('Legacy registry commands are retired; local settings and durable identity preambles remain.')}
  ${colors.dim('tmux-team is CLI-only; there is no daemon to run.')}

${colors.yellow('CONFIGURATION SAFETY')}

  Use tmt config show --json for resolved settings and config paths.
  config set supports preambleMode, preambleEvery and pasteEnterDelayMs;
  add --global for the global file. Numeric writes require decimal digits,
  not fractions or suffixes. Invalid loaded settings return CONFIG_ERROR
  before talk/check effects. Fix the reported field, not the whole file.
  Storage-only reply/result remain usable with malformed configuration.
  tmt config set exchange.retentionDays 90 --global sets 1..3650 integer days
  for new requests only. Existing deadlines, reply eligibility and observer
  timeouts are unchanged. Local overrides/clear are not supported for this key.
  Original messages are retained locally from preparation; avoid secrets.
  talk/send --identity <existing-name> attributes an existing originator,
  including an offline identity. Explicit selection overrides a bound caller;
  omission uses a verified caller or stays anonymous. This is not authentication.
  Original text is bounded to 1 MiB of well-formed UTF-8 before injected guidance
  and transport protection. Existing talk/result output is unchanged.
  Final retention starts at submission. Reads/retries do not renew expiry;
  cleanup is bounded and opportunistic, not scheduled or secure erasure.

${colors.yellow('BEST PRACTICES')}

  1. ${colors.green('Submit a full reply before summarizing')} - terminal text is not completion
  2. ${colors.green('Be explicit')} - tell agents exactly what you need
  3. ${colors.green('Set timeout appropriately')} - complex tasks need more time
  4. ${colors.green('Use stable pane IDs in scripts')} - avoid ambiguous locators

${colors.yellow('NEXT STEP')}

  Run ${colors.cyan('tmux-team list')} to see active global identities.
  Run ${colors.cyan('tmt learn --skill')} for the canonical agent guidance,
  including offline role profiles and complete command safety contracts.
  Use ${colors.cyan('tmt help')} for the current command and option inventory.
`);
}
