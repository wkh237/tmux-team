import { Command, CommanderError, Help, Option } from 'commander';
import { isPaneTarget } from '../domain/names.js';
import type { Flags } from '../types.js';
import type { IdentitySelector } from '../identity-context.js';
import type {
  ConfigRequest,
  PreambleRequest,
  ReplyRequest,
  ResultRequest,
  RoleRequest,
} from './requests.js';
import { validateReplyRequestId } from '../reply-receipt.js';
import {
  MAX_CAPTURE_LINES,
  isValidCaptureLines,
  isValidObserverTimeoutSeconds,
  isValidTimerDelayMs,
} from '../domain/interaction-limits.js';
export type { IdentitySelector } from '../identity-context.js';

export type ParsedInvocation =
  | { readonly kind: 'help'; readonly showIntro: boolean }
  | { readonly kind: 'version' }
  | { readonly kind: 'completion'; readonly shell?: string }
  | { readonly kind: 'install'; readonly target?: string; readonly directory?: string }
  | { readonly kind: 'init' | 'whoami' | 'unbind' | 'upgrade' }
  | { readonly kind: 'learn'; readonly skill?: boolean }
  | { readonly kind: 'list'; readonly target?: IdentitySelector }
  | { readonly kind: 'add'; readonly pane: string; readonly name: string }
  | { readonly kind: 'this' | 'name'; readonly name: string }
  | { readonly kind: 'talk'; readonly target: IdentitySelector; readonly message: string }
  | { readonly kind: 'check'; readonly target: IdentitySelector; readonly lines?: number }
  | ConfigRequest
  | PreambleRequest
  | ReplyRequest
  | ResultRequest
  | RoleRequest;

export interface ParsedMetadata {
  readonly argv: readonly string[];
  readonly commandPath: readonly string[];
  readonly unsupportedTeam: boolean;
  readonly capability: 'none' | 'storage' | 'tmux';
}

export interface ParsedArgs {
  readonly invocation: ParsedInvocation;
  readonly flags: Flags;
  readonly metadata: ParsedMetadata;
}

export class CliParseError extends Error {
  readonly flags: Flags;
  readonly commanderCode?: string;

  constructor(
    message: string,
    flags: Flags = { json: false, verbose: false },
    commanderCode?: string
  ) {
    super(message);
    this.name = 'CliParseError';
    this.flags = flags;
    this.commanderCode = commanderCode;
  }
}

interface CommonOptions {
  json?: boolean;
  verbose?: boolean;
  debug?: boolean;
  force?: boolean;
  config?: string;
  delay?: string;
  wait?: boolean;
  detach?: boolean;
  timeout?: string;
  lines?: string;
  noPreamble?: boolean;
  preamble?: boolean;
  team?: string;
}

interface CommandOptions extends CommonOptions {
  global?: boolean;
  identity?: string;
  file?: string;
  message?: string;
  dir?: string;
  skill?: boolean;
  help?: boolean;
  version?: boolean;
}

interface Capture {
  invocation?: ParsedInvocation;
  command?: Command;
  commandPath: string[];
  unsupportedTeam: boolean;
}

interface OptionSpec {
  readonly flags: string;
  readonly description?: string;
  readonly hidden?: boolean;
  readonly rootRecognized?: boolean;
  readonly rootAllowed?: boolean;
}

const optionSpecs = {
  json: {
    flags: '--json',
    description: 'Output in JSON format',
    rootRecognized: true,
    rootAllowed: true,
  },
  verbose: {
    flags: '-v, --verbose',
    description: 'Show detailed output',
    rootRecognized: true,
    rootAllowed: true,
  },
  debug: {
    flags: '--debug',
    description: 'Show diagnostic output',
    rootRecognized: true,
    rootAllowed: true,
  },
  force: {
    flags: '-f, --force',
    description: 'Skip warnings',
    rootRecognized: true,
  },
  config: { flags: '--config <path>', hidden: true, rootRecognized: true },
  delay: { flags: '--delay <time>', description: 'Wait before sending', rootRecognized: true },
  wait: {
    flags: '--wait',
    description: 'Retired; talk waits by default',
    hidden: true,
    rootRecognized: true,
  },
  detach: {
    flags: '--detach',
    description: 'Return after sending',
    rootRecognized: true,
  },
  timeout: {
    flags: '--timeout <time>',
    description: 'Bound durable waiting',
    rootRecognized: true,
  },
  lines: { flags: '--lines <count>', description: 'Lines to capture', rootRecognized: true },
  noPreamble: {
    flags: '--no-preamble',
    description: 'Skip agent preamble',
    rootRecognized: true,
  },
  team: { flags: '--team <team>', hidden: true, rootRecognized: true, rootAllowed: true },
  help: { flags: '-h, --help', hidden: true, rootRecognized: true, rootAllowed: true },
  version: { flags: '-V, --version', hidden: true, rootRecognized: true, rootAllowed: true },
  global: { flags: '-g, --global', description: 'Use global settings' },
  identity: { flags: '--identity <name>', description: 'Select an explicit identity' },
  file: { flags: '--file <path>', description: 'Read content from a file' },
  receipt: { flags: '--receipt <receipt>', description: 'Receipt from the talk instruction' },
  stdin: { flags: '--stdin', description: 'Read content from standard input' },
  message: { flags: '--message <text>', description: 'Submit inline content' },
  dir: { flags: '--dir <path>', description: 'Install skills in this directory' },
  skill: { flags: '--skill', description: 'Print the bundled universal skill' },
} satisfies Record<string, OptionSpec>;

type OptionName = keyof typeof optionSpecs;

const optionMetadata = new WeakMap<Option, OptionSpec>();
const optionSpecNames = new Map<OptionSpec, OptionName>(
  Object.entries(optionSpecs).map(([name, spec]) => [spec, name as OptionName])
);

function option(spec: OptionSpec): Option {
  const result = new Option(spec.flags, spec.description);
  if (spec.hidden) result.hideHelp();
  return result;
}

function registerOptions(
  command: Command,
  names: readonly OptionName[],
  mandatoryNames: readonly OptionName[] = []
): void {
  for (const name of names) {
    const registered = option(optionSpecs[name]);
    if (mandatoryNames.includes(name)) registered.makeOptionMandatory();
    command.addOption(registered);
    optionMetadata.set(registered, optionSpecs[name]);
  }
}

export interface CliCommandOptionMetadata {
  readonly name: string;
  readonly flags: string;
  readonly short?: string;
  readonly long?: string;
  readonly required: boolean;
  readonly optional: boolean;
  readonly variadic: boolean;
  readonly description?: string;
  readonly hidden: boolean;
  readonly rootRecognized: boolean;
  readonly rootAllowed: boolean;
}

export interface CliCommandArgumentMetadata {
  readonly name: string;
  readonly required: boolean;
  readonly variadic: boolean;
  readonly description: string;
}

export interface CliCommandMetadata {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly hidden: boolean;
  readonly description: string;
  readonly usage: string;
  readonly arguments: readonly CliCommandArgumentMetadata[];
  readonly options: readonly CliCommandOptionMetadata[];
  readonly commands: readonly CliCommandMetadata[];
}

function projectCommand(command: Command, helper: Help, parent?: Command): CliCommandMetadata {
  return {
    name: command.name(),
    aliases: command.aliases(),
    hidden: parent ? !helper.visibleCommands(parent).includes(command) : false,
    description: command.description(),
    usage: command.usage(),
    arguments: command.registeredArguments.map((argument) => ({
      name: argument.name(),
      required: argument.required,
      variadic: argument.variadic,
      description: argument.description,
    })),
    options: command.options.map((registered) => ({
      name: registered.attributeName(),
      flags: registered.flags,
      short: registered.short,
      long: registered.long,
      required: registered.required,
      optional: registered.optional,
      variadic: registered.variadic,
      description: registered.description,
      hidden: registered.hidden,
      rootRecognized: optionMetadata.get(registered)?.rootRecognized === true,
      rootAllowed: optionMetadata.get(registered)?.rootAllowed === true,
    })),
    commands: command.commands.map((child) => projectCommand(child, helper, command)),
  };
}

function parseTime(value: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s)?$/i);
  if (!match)
    throw new CliParseError(
      `Invalid time format: ${value}. Use number (seconds) or number with ms/s suffix.`
    );
  const seconds =
    match[2]?.toLowerCase() === 'ms' ? parseFloat(match[1]) / 1000 : parseFloat(match[1]);
  if (!Number.isFinite(seconds)) {
    throw new CliParseError(`Invalid time format: ${value}. The value must be finite.`);
  }
  return seconds;
}

function parseLines(value: string): number {
  if (!/^\d+$/.test(value))
    throw new CliParseError(
      `Invalid lines value: ${value}. Use an integer between 0 and ${MAX_CAPTURE_LINES}.`
    );
  const lines = Number(value);
  if (!isValidCaptureLines(lines))
    throw new CliParseError(
      `Invalid lines value: ${value}. Use an integer between 0 and ${MAX_CAPTURE_LINES}.`
    );
  return lines;
}

function flagsFrom(options: CommonOptions): Flags {
  const flags: Flags = {
    json: options.json === true,
    verbose: options.verbose === true,
  };
  if (options.debug) flags.debug = true;
  if (options.force) flags.force = true;
  if (options.delay !== undefined) flags.delay = parseTime(options.delay);
  if (options.detach) flags.detach = true;
  if (options.timeout !== undefined) flags.timeout = parseTime(options.timeout);
  if (options.lines !== undefined) flags.lines = parseLines(options.lines);
  if (options.noPreamble || options.preamble === false) flags.noPreamble = true;
  return flags;
}

function flagsFromOptions(options: CommonOptions): Flags {
  return {
    json: options.json === true,
    verbose: options.verbose === true,
    ...(options.debug === true && { debug: true }),
  };
}

function compatibilityUsage(commandName: string | undefined, message: string): string | undefined {
  if (!/missing required argument|too many arguments/.test(message)) return undefined;
  const usage: Record<string, string> = {
    name: 'Usage: tmux-team name <global-name>',
    this: 'Usage: tmux-team this <global-name>',
    add: 'Usage: tmux-team add <pane-target> <global-name>',
    check: 'Usage: tmux-team check <target> [lines]',
    read: 'Usage: tmux-team read <target> [lines]',
    talk: 'Usage: tmux-team talk <target> <message>',
    send: 'Usage: tmux-team send <target> <message>',
    whoami: 'Usage: tmux-team whoami',
    unbind: 'Usage: tmux-team unbind',
    role: 'Usage: tmux-team role show|set|clear [options]',
  };
  return commandName && Object.prototype.hasOwnProperty.call(usage, commandName)
    ? usage[commandName]
    : undefined;
}

function selector(value: string, explicit: boolean): IdentitySelector {
  return { value, kind: explicit || !isPaneTarget(value) ? 'identity' : 'pane', explicit };
}

function capabilityFor(invocation: ParsedInvocation): ParsedMetadata['capability'] {
  switch (invocation.kind) {
    case 'help':
    case 'version':
    case 'completion':
    case 'learn':
      return 'none';
    case 'config':
    case 'install':
      return 'storage';
    case 'preamble':
    case 'reply':
    case 'result':
      return 'storage';
    case 'role':
      // Keep context creation storage-only. Implicit current-pane resolution
      // obtains tmux lazily, preserving offline explicit identity behavior.
      return 'storage';
    case 'name':
    case 'this':
    case 'whoami':
    case 'unbind':
      // These commands validate caller-pane evidence before opening identity
      // storage or eager legacy config, so an absent caller cannot bootstrap state.
      return 'storage';
    default:
      return 'tmux';
  }
}

function commandOptions(command: Command): CommandOptions {
  const options: CommandOptions = {};
  const chain: Command[] = [];
  let current: Command | null = command;
  while (current) {
    chain.unshift(current);
    current = current.parent;
  }
  for (const item of chain) Object.assign(options, item.opts() as CommandOptions);
  // Commander consumes options shared by the root and a leaf through the
  // root. Re-apply CLI-sourced values so a negated option's child default
  // cannot overwrite a value supplied by the caller.
  for (const item of chain) {
    for (const registered of item.options) {
      const name = registered.attributeName();
      if (item.getOptionValueSource(name) === 'cli') {
        (options as Record<string, unknown>)[name] = item.opts()[name];
      }
    }
  }
  return options;
}

function optionAttribute(name: OptionName): string {
  return option(optionSpecs[name]).attributeName();
}

function optionWasProvided(command: Command, name: string): boolean {
  let current: Command | null = command;
  while (current) {
    if (current.getOptionValueSource(name) === 'cli') return true;
    current = current.parent;
  }
  return false;
}

function rejectUnsupportedOptions(command: Command): void {
  const allowed = new Set(
    command.parent === null
      ? command.options
          .filter((item) => optionMetadata.get(item)?.rootAllowed === true)
          .map((item) => item.attributeName())
      : command.options.map((item) => item.attributeName())
  );
  const seen = new Set<string>();
  let current: Command | null = command;
  while (current) {
    for (const item of current.options) {
      const name = item.attributeName();
      if (seen.has(name)) continue;
      seen.add(name);
      if (optionWasProvided(command, name) && !allowed.has(name)) {
        throw new CliParseError(
          `Unknown option '${item.long ?? item.flags}' for ${command.name()}.`
        );
      }
    }
    current = current.parent;
  }
}

function registeredOptions(command: Command): readonly Option[] {
  const result: Option[] = [];
  const visit = (current: Command): void => {
    result.push(...current.options);
    for (const child of current.commands) visit(child);
  };
  visit(command);
  return result;
}

function setupProgram(capture: Capture): Command {
  const program = new Command().name('tmux-team').helpOption(false);
  program.exitOverride((error) => {
    if (error instanceof CommanderError)
      throw new CliParseError(error.message, { json: false, verbose: false }, error.code);
    throw error;
  });
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  // These are root-owned parser controls. `config` is intentionally hidden
  // and rejected by command validation because it has no runtime consumer.
  registerOptions(program, ['help', 'version', 'config']);

  const generalOptions: readonly OptionName[] = ['json', 'verbose', 'debug', 'wait', 'team'];
  const talkOptions: readonly OptionName[] = [
    ...generalOptions,
    'force',
    'delay',
    'detach',
    'timeout',
    'noPreamble',
  ];
  const checkOptions: readonly OptionName[] = [...generalOptions, 'lines'];
  const storageOptions: readonly OptionName[] = ['json'];
  const captureCommand = (command: Command): void => {
    capture.command = command;
    const path: string[] = [];
    let current: Command | null = command;
    while (current && current !== program) {
      path.unshift(current.name());
      current = current.parent;
    }
    capture.commandPath = path;
  };
  program.hook('preSubcommand', (_parent, command) => captureCommand(command));
  const register = (command: Command, names: readonly OptionName[]): Command => {
    registerOptions(command, names);
    command.hook('preSubcommand', (_parent, subCommand) => captureCommand(subCommand));
    return command;
  };
  const action = (command: Command, invocation: ParsedInvocation): void => {
    const commandName = command.name();
    if (optionWasProvided(command, optionAttribute('wait'))) {
      throw new CliParseError(
        'The --wait option is retired. talk waits for a durable reply by default; use --timeout or --detach.'
      );
    }
    if (
      (commandName === 'talk' || commandName === 'send') &&
      optionWasProvided(command, optionAttribute('lines'))
    ) {
      throw new CliParseError(
        'The --lines option is only supported by check/read; talk retrieves the complete durable response.'
      );
    }
    if (commandName === 'talk' || commandName === 'send') {
      const options = commandOptions(command);
      if (options.detach && optionWasProvided(command, optionAttribute('timeout'))) {
        throw new CliParseError('Use either --timeout or --detach, not both.');
      }
      if (optionWasProvided(command, optionAttribute('timeout')) && options.timeout !== undefined) {
        const timeoutSeconds = parseTime(options.timeout);
        if (!isValidObserverTimeoutSeconds(timeoutSeconds)) {
          throw new CliParseError(
            'Talk timeout must be finite, positive, and no greater than 24 hours.'
          );
        }
      }
      if (optionWasProvided(command, optionAttribute('delay')) && options.delay !== undefined) {
        const delaySeconds = parseTime(options.delay);
        if (!isValidTimerDelayMs(delaySeconds * 1000)) {
          throw new CliParseError('Talk delay exceeds the supported timer limit.');
        }
      }
    }
    capture.invocation = invocation;
    captureCommand(command);
    capture.unsupportedTeam ||= Boolean(commandOptions(command).team);
    rejectUnsupportedOptions(command);
  };
  const storageOnly = <T extends Command>(command: T): T => {
    register(command, storageOptions);
    return command;
  };
  program.action(() => {
    const options = program.opts() as CommandOptions;
    action(
      program,
      options.version === true
        ? { kind: 'version' }
        : { kind: 'help', showIntro: options.help !== true }
    );
  });
  register(program.command('help').description('Show this help message'), generalOptions).action(
    function () {
      action(this, { kind: 'help', showIntro: false });
    }
  );
  const team = register(
    program
      .command('team', { hidden: true })
      .description('Retired compatibility command')
      .argument('[scope]'),
    generalOptions
  );
  team.action(function () {
    capture.unsupportedTeam = true;
    action(this, { kind: 'help', showIntro: false });
  });
  register(
    program.command('init').description('Create empty tmux-team.json'),
    generalOptions
  ).action(function () {
    action(this, { kind: 'init' });
  });
  const list = register(
    program
      .command('list')
      .description('List active identities or pane status')
      .alias('ls')
      .argument('[target]'),
    generalOptions
  );
  list.action(function (target?: string) {
    action(this, {
      kind: 'list',
      target: target ? selector(target, false) : undefined,
    });
  });
  const add = register(
    program
      .command('add')
      .description('Bind an explicit pane identity')
      .argument('<pane-target>')
      .argument('<global-name>'),
    generalOptions
  );
  add.action(function (pane: string, name: string) {
    action(this, { kind: 'add', pane, name });
  });
  for (const kind of ['this', 'name'] as const) {
    const command = register(
      program.command(kind).description('Bind the current pane identity').argument('<name>'),
      generalOptions
    );
    command.action(function (name: string) {
      action(this, { kind, name });
    });
  }
  for (const [name, kind] of [
    ['talk', 'talk'],
    ['send', 'talk'],
  ] as const) {
    const command = register(
      program
        .command(name)
        .description('Send a message to an identity or pane')
        .argument('<target>')
        .argument('<message>'),
      talkOptions
    );
    command.action(function (target: string, message: string) {
      action(this, {
        kind,
        target: selector(target, false),
        message,
      });
    });
  }
  for (const [name, kind] of [
    ['check', 'check'],
    ['read', 'check'],
  ] as const) {
    const command = register(
      program
        .command(name)
        .description('Capture output from an agent pane')
        .argument('<target>')
        .argument('[lines]'),
      checkOptions
    );
    command.action(function (target: string, lines?: string) {
      const options = commandOptions(this);
      const value = lines ?? options.lines;
      action(this, {
        kind,
        target: selector(target, false),
        ...(value !== undefined && { lines: parseLines(value) }),
      });
    });
  }
  const config = register(
    program.command('config').description('View or modify settings'),
    generalOptions
  );
  config.action(function () {
    action(this, { kind: 'config', operation: 'show', global: false });
  });
  const configShow = config.command('show').description('Show current settings');
  register(configShow, generalOptions);
  configShow.action(function () {
    action(this, { kind: 'config', operation: 'show', global: false });
  });
  const configSet = config
    .command('set')
    .description('Set a setting')
    .argument('<key>')
    .argument('<value>');
  register(configSet, [...generalOptions, 'global']);
  configSet.action(function (key: string, value: string) {
    action(this, {
      kind: 'config',
      operation: 'set',
      key,
      value,
      global: Boolean((this.opts() as { global?: boolean }).global),
    });
  });
  const configClear = config.command('clear').description('Clear a setting').argument('[key]');
  register(configClear, generalOptions);
  configClear.action(function (key?: string) {
    action(this, {
      kind: 'config',
      operation: 'clear',
      ...(key !== undefined && { key }),
      global: false,
    });
  });
  const preamble = register(
    program.command('preamble').description('Manage identity preambles'),
    generalOptions
  );
  preamble.action(function () {
    action(this, { kind: 'preamble', operation: 'show' });
  });
  const preambleShow = preamble
    .command('show')
    .description('Show stored preambles')
    .argument('[agent]');
  register(preambleShow, generalOptions);
  preambleShow.action(function (agent?: string) {
    action(this, { kind: 'preamble', operation: 'show', agent });
  });
  const preambleSet = preamble
    .command('set')
    .description('Set an identity preamble')
    .argument('<agent>')
    .argument('<preamble...>');
  register(preambleSet, generalOptions);
  preambleSet.action(function (agent: string, values: string[]) {
    action(this, { kind: 'preamble', operation: 'set', agent, preamble: values.join(' ') });
  });
  const preambleClear = preamble
    .command('clear')
    .description('Clear an identity preamble')
    .argument('<agent>');
  register(preambleClear, generalOptions);
  preambleClear.action(function (agent: string) {
    action(this, { kind: 'preamble', operation: 'clear', agent });
  });
  const role = register(
    program
      .command('role')
      .description('Manage identity role profiles')
      .usage('[options] <command>'),
    [...generalOptions, 'identity']
  );
  const roleShow = role.command('show').description('Show an identity role profile');
  register(roleShow, [...generalOptions, 'identity']);
  roleShow.action(function () {
    const options = commandOptions(this);
    action(this, {
      kind: 'role',
      operation: 'show',
      ...(options.identity !== undefined && { selector: selector(options.identity, true) }),
    });
  });
  const roleSet = role
    .command('set')
    .description('Set an identity role profile')
    .argument('[content]');
  register(roleSet, [...generalOptions, 'identity', 'file']);
  roleSet.action(function (content?: string) {
    const options = commandOptions(this);
    const hasContent = content !== undefined;
    const hasFile = options.file !== undefined;
    if (hasContent === hasFile) {
      throw new CliParseError(
        'Usage: tmux-team role set [content] [--file <path>] [--identity <name>]'
      );
    }
    action(this, {
      kind: 'role',
      operation: 'set',
      ...(content !== undefined ? { content } : { file: options.file! }),
      ...(options.identity !== undefined && { selector: selector(options.identity, true) }),
    });
  });
  const roleClear = role.command('clear').description('Clear an identity role profile');
  register(roleClear, [...generalOptions, 'identity']);
  roleClear.action(function () {
    const options = commandOptions(this);
    action(this, {
      kind: 'role',
      operation: 'clear',
      ...(options.identity !== undefined && { selector: selector(options.identity, true) }),
    });
  });
  const reply = program
    .command('reply')
    .description('Submit a complete result with a receipt')
    .argument('<request-id>');
  const replyOptions: readonly OptionName[] = [
    ...storageOptions,
    'receipt',
    'file',
    'stdin',
    'message',
  ];
  registerOptions(reply, replyOptions, ['receipt']);
  reply.action(function (requestId: string) {
    rejectUnsupportedOptions(this);
    try {
      validateReplyRequestId(requestId);
    } catch (error) {
      throw new CliParseError(error instanceof Error ? error.message : 'Invalid request ID.');
    }
    const options = commandOptions(this) as CommandOptions & {
      receipt?: string;
      stdin?: boolean;
    };
    const hasFile = options.file !== undefined;
    const hasStdin = options.stdin === true;
    const hasMessage = options.message !== undefined;
    if (
      [hasFile, hasStdin, hasMessage].filter(Boolean).length !== 1 ||
      options.receipt === undefined
    ) {
      throw new CliParseError(
        'Usage: tmux-team reply <request-id> --receipt <receipt> (--file <path> | --stdin | --message <text>) [--json]'
      );
    }
    action(this, {
      kind: 'reply',
      requestId,
      receipt: options.receipt,
      ...(hasFile
        ? { file: options.file! }
        : hasStdin
          ? { stdin: true }
          : { message: options.message! }),
    });
  });
  const result = storageOnly(
    program.command('result').description('Retrieve a retained result').argument('<request-id>')
  );
  result.action(function (requestId: string) {
    rejectUnsupportedOptions(this);
    try {
      validateReplyRequestId(requestId);
    } catch (error) {
      throw new CliParseError(error instanceof Error ? error.message : 'Invalid request ID.');
    }
    action(this, { kind: 'result', requestId });
  });
  const install = register(
    program.command('install').description('Install or refresh agent skills').argument('[agent]'),
    [...generalOptions, 'force', 'dir']
  );
  install.action(function (agent?: string) {
    const options = commandOptions(this);
    if (options.dir !== undefined && options.dir.trim() === '') {
      throw new CliParseError('Install directory must not be empty.');
    }
    if (options.dir !== undefined && agent !== undefined) {
      throw new CliParseError('The --dir option cannot be combined with an agent or all.');
    }
    action(this, {
      kind: 'install',
      ...(agent !== undefined ? { target: agent } : {}),
      ...(options.dir !== undefined ? { directory: options.dir } : {}),
    });
  });
  const completion = register(
    program.command('completion').description('Output shell completion script').argument('[shell]'),
    generalOptions
  );
  completion.action(function (shell?: string) {
    action(this, { kind: 'completion', shell });
  });
  for (const kind of ['upgrade', 'whoami', 'unbind'] as const) {
    const command = register(
      program
        .command(kind)
        .description(
          kind === 'upgrade'
            ? 'Upgrade tmux-team and refresh skills'
            : kind === 'whoami'
              ? 'Show the current pane identity'
              : 'Remove the current pane identity'
        ),
      generalOptions
    );
    command.action(function () {
      action(this, { kind });
    });
  }
  const learn = register(program.command('learn').description('Show the learning guide'), [
    ...generalOptions,
    'skill',
  ]);
  learn.action(function () {
    const options = commandOptions(this);
    action(this, { kind: 'learn', ...(options.skill ? { skill: true } : {}) });
  });
  const rootNames = new Set<OptionName>();
  for (const registered of registeredOptions(program)) {
    const spec = optionMetadata.get(registered);
    const name = spec ? optionSpecNames.get(spec) : undefined;
    if (name && spec?.rootRecognized === true) rootNames.add(name);
  }
  const existingRootOptions = new Set(program.options.map((item) => item.attributeName()));
  registerOptions(
    program,
    [...rootNames].filter((name) => !existingRootOptions.has(optionAttribute(name)))
  );
  return program;
}

/**
 * Read-only projection of the Commander registration tree. Help and completion
 * consumers use this instead of maintaining a second option inventory.
 */
export function getCliCommandMetadata(): CliCommandMetadata {
  const program = setupProgram({ commandPath: [], unsupportedTeam: false });
  return projectCommand(program, new Help());
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const raw = [...argv];
  if (raw.length === 0) {
    return {
      invocation: { kind: 'help', showIntro: raw.length === 0 },
      flags: { json: false, verbose: false },
      metadata: {
        argv: raw,
        commandPath: [],
        unsupportedTeam: false,
        capability: 'none',
      },
    };
  }
  const capture: Capture = { commandPath: [], unsupportedTeam: false };
  const program = setupProgram(capture);
  try {
    program.parse(['node', 'tmux-team', ...raw], { from: 'node' });
  } catch (error) {
    if (error instanceof CliParseError) {
      const commanderUnknown =
        error.commanderCode === 'commander.unknownCommand'
          ? error.message.match(/unknown command ['"]([^'"]+)['"]/i)
          : undefined;
      const rootOperand = program.args[0];
      const rootOperandIsKnownCommand = rootOperand
        ? program.commands.some(
            (command) => command.name() === rootOperand || command.aliases().includes(rootOperand)
          )
        : false;
      const unknownCommand =
        commanderUnknown?.[1] ??
        (!capture.command &&
        rootOperand &&
        !rootOperandIsKnownCommand &&
        (error.commanderCode === 'commander.excessArguments' || !rootOperand.startsWith('-'))
          ? rootOperand
          : undefined);
      const message = unknownCommand
        ? `Unknown command: ${unknownCommand}. Run 'tmux-team help' for usage.`
        : error.message;
      throw new CliParseError(
        compatibilityUsage(capture.command?.name(), message) ?? message,
        flagsFromOptions(
          capture.command ? commandOptions(capture.command) : (program.opts() as CommonOptions)
        ),
        error.commanderCode
      );
    }
    throw new CliParseError(error instanceof Error ? error.message : String(error));
  }
  if (!capture.invocation)
    throw new CliParseError(`Unknown command: ${raw[0]}. Run 'tmux-team help' for usage.`);
  let flags: Flags;
  try {
    flags = flagsFrom(
      capture.command ? commandOptions(capture.command) : (program.opts() as CommonOptions)
    );
  } catch (error) {
    if (error instanceof CliParseError) {
      throw new CliParseError(error.message, flagsFromOptions(program.opts() as CommonOptions));
    }
    throw error;
  }
  capture.unsupportedTeam ||= Boolean((program.opts() as CommonOptions).team);
  return {
    invocation: capture.invocation,
    flags,
    metadata: {
      argv: raw,
      commandPath: capture.commandPath,
      unsupportedTeam: capture.unsupportedTeam,
      capability: capabilityFor(capture.invocation),
    },
  };
}
