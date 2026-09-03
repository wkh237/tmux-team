import { Command, CommanderError } from 'commander';
import { isPaneTarget } from '../domain/names.js';
import type { Flags } from '../types.js';
import type { IdentitySelector } from '../identity-context.js';
import type { RoleRequest } from '../commands/role.js';
export type { IdentitySelector } from '../identity-context.js';

export type ParsedInvocation =
  | { readonly kind: 'help'; readonly showIntro: boolean }
  | { readonly kind: 'version' }
  | { readonly kind: 'completion'; readonly shell?: string }
  | { readonly kind: 'install'; readonly target?: string }
  | { readonly kind: 'init' | 'whoami' | 'unbind' | 'upgrade' | 'learn' }
  | { readonly kind: 'list'; readonly target?: IdentitySelector }
  | { readonly kind: 'add'; readonly pane: string; readonly name: string }
  | {
      readonly kind: 'update';
      readonly name: string;
      readonly options: { pane?: string; remark?: string };
    }
  | { readonly kind: 'remove'; readonly name: string }
  | { readonly kind: 'migrate'; readonly dryRun: boolean; readonly cleanup: boolean }
  | { readonly kind: 'this' | 'name'; readonly name: string }
  | { readonly kind: 'talk'; readonly target: IdentitySelector; readonly message: string }
  | { readonly kind: 'check'; readonly target: IdentitySelector; readonly lines?: number }
  | {
      readonly kind: 'config';
      readonly operation: 'show' | 'set' | 'clear';
      readonly key?: string;
      readonly value?: string;
      readonly global: boolean;
    }
  | {
      readonly kind: 'preamble';
      readonly operation: 'show' | 'set' | 'clear';
      readonly agent?: string;
      readonly preamble?: string;
    }
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

  constructor(message: string, flags: Flags = { json: false, verbose: false }) {
    super(message);
    this.name = 'CliParseError';
    this.flags = flags;
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
  timeout?: string;
  lines?: string;
  noPreamble?: boolean;
  preamble?: boolean;
  team?: string;
}

interface CommandOptions extends CommonOptions {
  pane?: string;
  remark?: string;
  dryRun?: boolean;
  cleanup?: boolean;
  global?: boolean;
  identity?: string;
  file?: string;
}

interface Capture {
  invocation?: ParsedInvocation;
  command?: Command;
  commandPath: string[];
  unsupportedTeam: boolean;
}

function parseTime(value: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s)?$/i);
  if (!match)
    throw new CliParseError(
      `Invalid time format: ${value}. Use number (seconds) or number with ms/s suffix.`
    );
  return match[2]?.toLowerCase() === 'ms' ? parseFloat(match[1]) / 1000 : parseFloat(match[1]);
}

function parseLines(value: string): number {
  if (!/^\d+$/.test(value))
    throw new CliParseError(`Invalid lines value: ${value}. Use a non-negative integer.`);
  return parseInt(value, 10);
}

function flagsFrom(options: CommonOptions, argv: readonly string[] = []): Flags {
  const flags: Flags = {
    json: options.json === true,
    verbose: options.verbose === true,
  };
  if (options.debug) flags.debug = true;
  if (options.force) flags.force = true;
  if (options.config !== undefined) flags.config = options.config;
  if (options.delay !== undefined) flags.delay = parseTime(options.delay);
  if (options.wait) flags.wait = true;
  if (options.timeout !== undefined) flags.timeout = parseTime(options.timeout);
  if (options.lines !== undefined) {
    if (!/^\d+$/.test(options.lines))
      throw new CliParseError(`Invalid lines value: ${options.lines}. Use a non-negative integer.`);
    flags.lines = parseInt(options.lines, 10);
  }
  if (options.noPreamble || options.preamble === false || argv.includes('--no-preamble'))
    flags.noPreamble = true;
  return flags;
}

function flagsFromArgv(argv: readonly string[]): Flags {
  return {
    json: argv.includes('--json'),
    verbose: argv.includes('--verbose') || argv.includes('-v'),
  };
}

function compatibilityUsage(argv: readonly string[], message: string): string | undefined {
  if (!/missing required argument|too many arguments/.test(message)) return undefined;
  const usage: Record<string, string> = {
    name: 'Usage: tmux-team name <global-name>',
    this: 'Usage: tmux-team this <global-name>',
    add: 'Usage: tmux-team add <pane-target> <global-name>',
    update: 'Usage: tmux-team update <global-name> [--pane <pane>] [--remark <remark>]',
    remove: 'Usage: tmux-team remove <global-name>',
    rm: 'Usage: tmux-team rm <global-name>',
    check: 'Usage: tmux-team check <target> [lines]',
    read: 'Usage: tmux-team read <target> [lines]',
    talk: 'Usage: tmux-team talk <target> <message>',
    send: 'Usage: tmux-team send <target> <message>',
    whoami: 'Usage: tmux-team whoami',
    unbind: 'Usage: tmux-team unbind',
    role: 'Usage: tmux-team role show|set|clear [options]',
  };
  const command = argv.find((token) => Object.prototype.hasOwnProperty.call(usage, token));
  return command ? usage[command] : undefined;
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
      return invocation.operation === 'show' ? 'storage' : 'tmux';
    case 'role':
      // Keep context creation storage-only. Implicit current-pane resolution
      // obtains tmux lazily, preserving offline explicit identity behavior.
      return 'storage';
    case 'migrate':
      return 'tmux';
    default:
      return 'tmux';
  }
}

function commonOptions(command: Command): Command {
  command
    .option('--json')
    .option('-v, --verbose')
    .option('--debug')
    .option('-f, --force')
    .option('--config <path>')
    .option('--delay <time>')
    .option('--wait')
    .option('--timeout <time>')
    .option('--lines <count>')
    .option('--no-preamble')
    .option('--team <team>');
  return command;
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
  return options;
}

function setupProgram(capture: Capture): Command {
  const program = commonOptions(new Command()).name('tmux-team').helpOption(false);
  program.exitOverride((error) => {
    if (error instanceof CommanderError) throw new CliParseError(error.message);
    throw error;
  });
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });

  const action = (command: Command, invocation: ParsedInvocation): void => {
    capture.invocation = invocation;
    capture.command = command;
    const path: string[] = [];
    let current: Command | null = command;
    while (current && current !== program) {
      path.unshift(current.name());
      current = current.parent;
    }
    capture.commandPath = path;
    capture.unsupportedTeam ||= Boolean(commandOptions(command).team);
  };
  const leaf = <T extends Command>(command: T): T => {
    commonOptions(command);
    return command;
  };

  program.action(() => action(program, { kind: 'help', showIntro: true }));
  commonOptions(program.command('help')).action(function () {
    action(this, { kind: 'help', showIntro: false });
  });
  const team = commonOptions(program.command('team').argument('[scope]'));
  team.action(function () {
    capture.unsupportedTeam = true;
    action(this, { kind: 'help', showIntro: false });
  });
  commonOptions(program.command('init')).action(function () {
    action(this, { kind: 'init' });
  });
  const list = leaf(program.command('list').alias('ls').argument('[target]'));
  list.action(function (target?: string) {
    action(this, {
      kind: 'list',
      target: target ? selector(target, false) : undefined,
    });
  });
  const add = leaf(program.command('add').argument('<pane-target>').argument('<global-name>'));
  add.action(function (pane: string, name: string) {
    action(this, { kind: 'add', pane, name });
  });
  const update = leaf(program.command('update').argument('<name>'));
  update
    .option('--pane <pane>')
    .option('--remark <remark>')
    .action(function (name: string) {
      const options = commandOptions(this);
      action(this, {
        kind: 'update',
        name,
        options: {
          ...(options.pane && { pane: options.pane }),
          ...(options.remark && { remark: options.remark }),
        },
      });
    });
  for (const [name, kind] of [
    ['remove', 'remove'],
    ['rm', 'remove'],
  ] as const) {
    const command = leaf(program.command(name).argument('<name>'));
    command.action(function (value: string) {
      action(this, { kind, name: value });
    });
  }
  const migrate = leaf(program.command('migrate'));
  migrate
    .option('--dry-run')
    .option('--cleanup')
    .action(function () {
      const options = commandOptions(this) as CommonOptions & {
        dryRun?: boolean;
        cleanup?: boolean;
      };
      action(this, {
        kind: 'migrate',
        dryRun: options.dryRun === true,
        cleanup: options.cleanup === true,
      });
    });
  for (const kind of ['this', 'name'] as const) {
    const command = leaf(program.command(kind).argument('<name>'));
    command.action(function (name: string) {
      action(this, { kind, name });
    });
  }
  for (const [name, kind] of [
    ['talk', 'talk'],
    ['send', 'talk'],
  ] as const) {
    const command = leaf(program.command(name).argument('<target>').argument('<message>'));
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
    const command = leaf(program.command(name).argument('<target>').argument('[lines]'));
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
  const config = leaf(program.command('config'));
  config.action(function () {
    action(this, { kind: 'config', operation: 'show', global: false });
  });
  const configShow = config.command('show');
  commonOptions(configShow);
  configShow.action(function () {
    action(this, { kind: 'config', operation: 'show', global: false });
  });
  const configSet = config.command('set').argument('<key>').argument('<value>');
  commonOptions(configSet).option('-g, --global');
  configSet.action(function (key: string, value: string) {
    action(this, {
      kind: 'config',
      operation: 'set',
      key,
      value,
      global: Boolean((this.opts() as { global?: boolean }).global),
    });
  });
  const configClear = config.command('clear').argument('[key]');
  commonOptions(configClear);
  configClear.action(function (key?: string) {
    action(this, {
      kind: 'config',
      operation: 'clear',
      ...(key !== undefined && { key }),
      global: false,
    });
  });
  const preamble = leaf(program.command('preamble'));
  preamble.action(function () {
    action(this, { kind: 'preamble', operation: 'show' });
  });
  const preambleShow = preamble.command('show').argument('[agent]');
  commonOptions(preambleShow);
  preambleShow.action(function (agent?: string) {
    action(this, { kind: 'preamble', operation: 'show', agent });
  });
  const preambleSet = preamble.command('set').argument('<agent>').argument('<preamble...>');
  commonOptions(preambleSet);
  preambleSet.action(function (agent: string, values: string[]) {
    action(this, { kind: 'preamble', operation: 'set', agent, preamble: values.join(' ') });
  });
  const preambleClear = preamble.command('clear').argument('<agent>');
  commonOptions(preambleClear);
  preambleClear.action(function (agent: string) {
    action(this, { kind: 'preamble', operation: 'clear', agent });
  });
  const role = leaf(program.command('role')).option('--identity <name>');
  const roleShow = role.command('show');
  commonOptions(roleShow).option('--identity <name>');
  roleShow.action(function () {
    const options = commandOptions(this);
    action(this, {
      kind: 'role',
      operation: 'show',
      ...(options.identity !== undefined && { selector: selector(options.identity, true) }),
    });
  });
  const roleSet = role.command('set').argument('[content]');
  commonOptions(roleSet).option('--identity <name>').option('--file <path>');
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
  const roleClear = role.command('clear');
  commonOptions(roleClear).option('--identity <name>');
  roleClear.action(function () {
    const options = commandOptions(this);
    action(this, {
      kind: 'role',
      operation: 'clear',
      ...(options.identity !== undefined && { selector: selector(options.identity, true) }),
    });
  });
  const install = leaf(program.command('install').argument('[agent]'));
  install.action(function (agent?: string) {
    action(this, { kind: 'install', target: agent });
  });
  const completion = leaf(program.command('completion').argument('[shell]'));
  completion.action(function (shell?: string) {
    action(this, { kind: 'completion', shell });
  });
  for (const kind of ['upgrade', 'learn', 'whoami', 'unbind'] as const) {
    const command = leaf(program.command(kind));
    command.action(function () {
      action(this, { kind });
    });
  }
  return program;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const raw = [...argv];
  if (raw.length === 0) {
    return {
      invocation: { kind: 'help', showIntro: raw.length === 0 },
      flags: { json: raw.includes('--json'), verbose: false },
      metadata: {
        argv: raw,
        commandPath: [],
        unsupportedTeam: false,
        capability: 'none',
      },
    };
  }
  const terminator = raw.indexOf('--');
  const commandTokens = terminator === -1 ? raw : raw.slice(0, terminator);
  const valueOptions = new Set(['--config', '--delay', '--timeout', '--lines', '--team']);
  let firstCommandToken: string | undefined;
  for (let index = 0; index < commandTokens.length; index++) {
    const token = commandTokens[index];
    if (valueOptions.has(token)) {
      index++;
      continue;
    }
    if (token.startsWith('--team=')) continue;
    if (
      token.startsWith('-') &&
      token !== '--help' &&
      token !== '-h' &&
      token !== '--version' &&
      token !== '-V'
    ) {
      continue;
    }
    firstCommandToken = token;
    break;
  }
  if (firstCommandToken === '--help' || firstCommandToken === '-h') {
    return {
      invocation: { kind: 'help', showIntro: false },
      flags: {
        json: commandTokens.includes('--json'),
        verbose: commandTokens.includes('--verbose') || commandTokens.includes('-v'),
      },
      metadata: {
        argv: raw,
        commandPath: [],
        unsupportedTeam: false,
        capability: 'none',
      },
    };
  }
  if (firstCommandToken === '--version' || firstCommandToken === '-V') {
    return {
      invocation: { kind: 'version' },
      flags: flagsFromArgv(commandTokens),
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
  if (
    firstCommandToken &&
    !firstCommandToken.startsWith('-') &&
    !program.commands.some(
      (command) =>
        command.name() === firstCommandToken || command.aliases().includes(firstCommandToken)
    )
  ) {
    throw new CliParseError(
      `Unknown command: ${firstCommandToken}. Run 'tmux-team help' for usage.`,
      flagsFromArgv(commandTokens)
    );
  }
  try {
    program.parse(['node', 'tmux-team', ...raw], { from: 'node' });
  } catch (error) {
    if (error instanceof CliParseError) {
      throw new CliParseError(
        compatibilityUsage(commandTokens, error.message) ?? error.message,
        flagsFromArgv(commandTokens)
      );
    }
    throw new CliParseError(error instanceof Error ? error.message : String(error));
  }
  if (!capture.invocation)
    throw new CliParseError(`Unknown command: ${raw[0]}. Run 'tmux-team help' for usage.`);
  let flags: Flags;
  try {
    flags = flagsFrom(
      capture.command ? commandOptions(capture.command) : (program.opts() as CommonOptions),
      commandTokens
    );
  } catch (error) {
    if (error instanceof CliParseError) {
      throw new CliParseError(error.message, flagsFromArgv(commandTokens));
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
