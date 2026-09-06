// ─────────────────────────────────────────────────────────────
// help command - show usage information
// ─────────────────────────────────────────────────────────────

import { colors } from '../ui.js';
import { VERSION } from '../version.js';

export interface HelpConfig {
  timeout?: number;
  showIntro?: boolean;
}

export function cmdHelp(config?: HelpConfig): void {
  const timeout = config?.timeout ?? 180;

  // Show intro highlight when running just `tmux-team` with no args
  if (config?.showIntro) {
    console.log(`
${colors.cyan('┌─────────────────────────────────────────────────────────────┐')}
${colors.cyan('│')}  ${colors.yellow('New to tmux-team?')} Run ${colors.green('tmux-team learn')} or ${colors.green('tmt learn')}         ${colors.cyan('│')}
${colors.cyan('│')}  ${colors.dim('tmt is a shorthand alias for tmux-team')}                      ${colors.cyan('│')}
${colors.cyan('└─────────────────────────────────────────────────────────────┘')}`);
  }

  console.log(`
${colors.cyan('tmux-team')} v${VERSION} - AI agent collaboration in tmux
${colors.dim('Alias: tmt')}

Talk waits for a complete durable reply (timeout: ${timeout}s).
Use --detach to return after sending; use result <request-id> to retrieve later.

${colors.yellow('USAGE')}
  tmt <command> [arguments]

${colors.yellow('COMMANDS')}
  ${colors.green('talk')} <target> <message>     Send message to an identity or pane
  ${colors.green('check')} <target> [lines]      Capture output from agent's pane
  ${colors.green('reply')} <request-id>         Submit a complete result with a receipt
  ${colors.green('result')} <request-id>        Retrieve a retained result
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
  ${colors.green('preamble')} [show|set|clear]   Manage durable identity preambles
  ${colors.green('role')} <show|set|clear>      Manage durable identity role profiles
  ${colors.green('completion')}                  Output shell completion script
  ${colors.green('learn')}                       Show educational guide
  ${colors.green('learn --skill')}               Print the exact bundled universal skill
  ${colors.green('help')}                        Show this help message

${colors.yellow('SKILL INSTALLATION')}
  tmt install --dir <skills-root> [--force] [--json]
  Links <skills-root>/tmux-team; do not combine with a provider or all.
  Unmanaged paths require --force and are backed up, not deleted.
  Choose a folder the provider discovers; active agents may need a reload.
  Automatic drift reminders cover default paths, not custom folders.

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
  ${colors.green('--timeout')} <time>            Observer bound (current: ${timeout}s; positive, at most 24h)
  ${colors.green('--detach')}                    Return request ID after sending; no explicit --timeout
  ${colors.green('--no-preamble')}               Skip agent preamble for this message
  ${colors.green('--debug')}                     Show debug output

${colors.yellow('REPLY / RESULT')}
  tmt reply <request-id> --receipt <receipt> (--message <text> | --file <path> | --stdin) [--json]
  tmt result <request-id> [--json]
  Use exactly one input source and the request ID/receipt from the talk instruction.
  Quote short inline text; use --message='-text' for a leading hyphen.
  Use file/stdin for large bodies or NUL; operating-system argv limits apply.
  Do not invent a receipt, select the latest request, or infer a current pane.
  A recipient must submit a final; markers, idle output and summaries do not complete talk.
  Reply/result work without tmux on the same local database; check is diagnostic only.
  Bodies are exact valid UTF-8 up to 1 MiB; stdin is EOF-driven with a 5s
  deadline. Submission means result delivery, not task success. Summarize only
  after successful submission. Result unavailable (pending, unknown, expired)
  uses RESPONSE_NOT_AVAILABLE (exit 3); input errors exit 1, input timeout
  uses RESPONSE_INPUT_TIMEOUT (exit 4), and conflicts exit 5. Identical retries
  keep the original submittedAtMs; conflicting bodies cannot replace results.
  JSON unavailable is {status:"unavailable",requestId,error:{code:"RESPONSE_NOT_AVAILABLE",message}}.
  Receipts are local correlation, not remote authentication. Bodies are
  retained seven days; retry only with the same receipt/body while retained.
  Missing results do not cancel work. Surface failed submission without a
  success summary, and never resubmit after accepted delivery.

${colors.yellow('EXAMPLES')}
  tmux-team talk codex "Review this PR" --timeout 300 --json
  tmux-team talk %12 "Run the agreed tests" --detach --json
  tmux-team result <request-id> --json
  tmux-team check codex 200                ${colors.dim('← diagnostic snapshot only')}
  tmux-team list --json
  tmux-team list main:1.0
  tmux-team add 10.1 codex
  tmux-team name backend
  tmt install
  tmt upgrade

${colors.yellow('CONFIG')}
  Runtime: durable identities in SQLite, with live tmux bindings
  Local:  ./tmux-team.json (settings override; other fields remain opaque)
  Global: ~/.config/tmux-team/config.json (settings)

${colors.yellow('SETTINGS')}
  tmux-team config set preambleMode disabled ${colors.dim('Disable preambles (local)')}
  tmux-team config set preambleEvery 5      ${colors.dim('Inject preamble every 5 messages')}
  --wait is retired; --lines is only for check, not talk.
  Stored mode/maxCaptureLines settings are inert and preserved, not migrated.
  config clear mode removes only the obsolete local mode key.
  Timeout accepts seconds or ms/s suffixes and includes transport/Enter time,
  after pre-send delay/preparation. It never cancels work or permits a resend.
  Synchronous transport is not interrupted mid-operation by this observer bound.
  Same-pane input serialization and exactly-once processing are not guaranteed.
`);
}
