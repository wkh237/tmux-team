// ─────────────────────────────────────────────────────────────
// help command - show usage information
// ─────────────────────────────────────────────────────────────

import { colors } from '../ui.js';
import { VERSION } from '../version.js';
import { MAX_CAPTURE_LINES, MAX_TIMER_DELAY_MS } from '../domain/interaction-limits.js';
import {
  getCliCommandMetadata,
  type CliCommandMetadata,
  type CliCommandOptionMetadata,
} from '../cli/parser.js';

export interface HelpConfig {
  timeout?: number;
  showIntro?: boolean;
}

function commandUsage(command: CliCommandMetadata): string {
  const usage = command.usage.replace(/^\[options\]\s*/, '').trim();
  const childNames = command.commands.map((child) => child.name).join('|');
  const childUsage = childNames ? `[${childNames}]` : '';
  const argumentsUsage =
    usage
      .replace('[command]', childUsage)
      .replace('<command>', childNames ? `<${childNames}>` : '') || childUsage;
  const aliases = command.aliases.length > 0 ? ` (alias: ${command.aliases.join(', ')})` : '';
  return `${command.name}${argumentsUsage ? ` ${argumentsUsage}` : ''}${aliases}`;
}

function findCommand(root: CliCommandMetadata, name: string): CliCommandMetadata | undefined {
  return root.commands.find((command) => command.name === name);
}

function requiredCommand(root: CliCommandMetadata, name: string): CliCommandMetadata {
  const command = findCommand(root, name);
  if (!command) throw new Error(`CLI metadata is missing command: ${name}`);
  return command;
}

function formatOption(option: CliCommandOptionMetadata): string {
  const description = option.description ? ` ${option.description}` : '';
  return `  ${colors.green(option.flags)}${description}`;
}

function commandOptions(command: CliCommandMetadata): readonly CliCommandOptionMetadata[] {
  return command.options.filter((option) => !option.hidden && !option.rootAllowed);
}

function commandRows(root: CliCommandMetadata): string {
  return root.commands
    .filter((command) => !command.hidden)
    .map((command) => {
      const description = command.description ? ` ${command.description}` : '';
      return `  ${colors.green(commandUsage(command))}${description}`;
    })
    .join('\n');
}

function childRows(parent: CliCommandMetadata): string {
  return parent.commands
    .filter((child) => !child.hidden)
    .map((child) => {
      const options = commandOptions(child)
        .map((option) => (option.mandatory ? option.flags : `[${option.flags}]`))
        .join(' ');
      const suffix = options ? ` ${options}` : '';
      return `  tmt ${colors.green(`${parent.name} ${commandUsage(child)}${suffix}`)}`;
    })
    .join('\n');
}

export function cmdHelp(config?: HelpConfig): void {
  const timeout = config?.timeout ?? 180;
  const metadata = getCliCommandMetadata();
  const rootOptions = metadata.options.filter((option) => !option.hidden && option.rootAllowed);
  const talk = requiredCommand(metadata, 'talk');
  const check = requiredCommand(metadata, 'check');
  const reply = requiredCommand(metadata, 'reply');
  const result = requiredCommand(metadata, 'result');
  const role = requiredCommand(metadata, 'role');
  const identity = requiredCommand(metadata, 'identity');
  const exchange = requiredCommand(metadata, 'x');
  const learn = requiredCommand(metadata, 'learn');
  const learnSkill = learn.options.find((option) => option.name === 'skill');
  if (!learnSkill) throw new Error('CLI metadata is missing learn --skill');

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
${commandRows(metadata)}
  ${colors.green(`learn ${learnSkill.flags}`)} Print the exact bundled universal skill

${colors.yellow('SKILL INSTALLATION')}
  tmt install --dir <skills-root> [--force] [--json]
  Links <skills-root>/tmux-team; do not combine with a provider or all.
  Unmanaged paths require --force and are backed up, not deleted.
  Choose a folder the provider discovers; active agents may need a reload.
  Automatic drift reminders cover default paths, not custom folders.

${colors.yellow('OPTIONS')}
${rootOptions.map(formatOption).join('\n')}
  JSON is available only for commands with a JSON result; text-only commands
  such as help, completion and learn do not provide a universal JSON form.

${colors.yellow('DURABLE IDENTITY USAGE')}
${childRows(identity)}
  Storage-only; works inside or outside tmux without loading unrelated configuration.
  Create preserves an existing canonical name, UUID, profile and pane binding.
  Identity list includes unbound identities; ordinary list shows active destinations.
  No login, automatic binding, presence claim or authentication is implied.

${colors.yellow('EXCHANGE ATTENTION USAGE')}
${childRows(exchange)}
  Bare x lists unacknowledged exchanges; use --identity outside a verified bound pane.
  List accepts --limit (1-200, default 50) and --after (default 0).
  ack requires --revision from list/show; ackall needs no prior lookup.
  Reads never acknowledge. A later final reopens attention; acknowledgment is not task success.

${colors.yellow('ROLE USAGE')}
${childRows(role)}
  Omit --identity only in a verified bound pane; explicit offline identities are supported.
  role set accepts either inline content or --file, never both; --identity selects the durable identity.

${colors.yellow('CALLER CONTEXT')}
  name, this, whoami and unbind require matching live TMUX/TMUX_PANE context.
  Missing or stale caller: PANE_NOT_FOUND (exit 3); implicit role: IDENTITY_REQUIRED (exit 1).
  Outside tmux, use explicit add/talk/check targets or role --identity <name>.

${colors.yellow('TALK OPTIONS')}
${commandOptions(talk).map(formatOption).join('\n')}
  Delay is bounded to 0 through ${MAX_TIMER_DELAY_MS}ms; timeout is positive and at most 24h.
  --detach returns a request ID after sending; --no-preamble skips the agent preamble.
  --identity attributes an existing originator, including offline identities; it is command-local.
  Explicit selection overrides a bound caller; omission uses a verified caller or stays anonymous.
  This is local attribution, not authentication, and does not change the recipient.
  Original messages are retained locally for the frozen duration; avoid secrets.
  Exact well-formed Unicode is bounded to 1 MiB before preamble/instructions/protection.
  Invalid/oversized text: REQUEST_INPUT_INVALID/REQUEST_INPUT_TOO_LARGE (exit 1).
  OS argument limits apply; talk has no file/stdin source. Use x show for retained context.
  --debug shows diagnostic output.

${colors.yellow('CHECK OPTIONS')}
  ${commandUsage(check)}; --lines accepts an integer 0 through ${MAX_CAPTURE_LINES}.
  ${commandOptions(check).map(formatOption).join('\n')}
  Zero captures the visible pane. Invalid CLI/configured counts are rejected.

${colors.yellow('REPLY / RESULT')}
  tmt ${commandUsage(reply)} --receipt <receipt> (--message <text> | --file <path> | --stdin) [--json]
  tmt ${commandUsage(result)} [--json]
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
  retained for the request's frozen duration (90 days by default, seven for
  pre-migration requests). Retry only with the same receipt/body while retained.
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
  tmux-team config set exchange.retentionDays 90 --global
  Retention accepts integer days 1..3650, global-only, for new requests only.
  Reads/retries do not renew expiry; cleanup is bounded and opportunistic.
  --wait is retired; --lines is only for check, not talk.
  Stored mode/maxCaptureLines settings are inert and preserved, not migrated.
  config clear mode removes only the obsolete local mode key.
  Timeout accepts seconds or ms/s suffixes and includes transport/Enter time,
  after pre-send delay/preparation. It never cancels work or permits a resend.
  Synchronous transport is not interrupted mid-operation by this observer bound.
  Same-pane input serialization and exactly-once processing are not guaranteed.
`);
}
