import { ConfigParseError } from './config.js';
import { createContext, ExitCodes } from './context.js';
import { cmdHelp, type HelpConfig } from './commands/help.js';
import { cmdCompletion } from './commands/completion.js';
import { UNSUPPORTED_TEAM_MESSAGE } from './commands/unsupported-team.js';
import { runStartupChecks } from './update-check.js';
import { CliParseError, parseArgs, type ParsedArgs, type ParsedInvocation } from './cli/parser.js';
import { dispatchCommand } from './cli/application.js';
import type { Context, Flags } from './types.js';
import { CliOutputSerializationError, createCliOutput, type CliOutput } from './cli-output.js';
import { loadConfig, resolvePaths } from './config.js';

export class CliExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit(${code})`);
    this.name = 'CliExit';
    this.code = code;
  }
}

const JSON_UNSUPPORTED_MESSAGE =
  'This command only supports human-readable output and cannot be used with --json.';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof ConfigParseError) {
    return { code: 'CONFIG_ERROR', message: error.message };
  }
  return { code: 'INTERNAL_ERROR', message: errorMessage(error) };
}

function writeJsonError(output: CliOutput, error: { code: string; message: string }): void {
  output.replaceJson({ error });
}

function writeHumanError(output: CliOutput, message: string): void {
  output.ui.error(message);
}

function flushJson(output: CliOutput, status: number, verbose: boolean, debug?: boolean): number {
  try {
    output.flush();
    return status;
  } catch (error) {
    if (!(error instanceof CliOutputSerializationError)) throw error;
    output.replaceJson({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Could not serialize JSON output.',
      },
    });
    if (verbose || debug) console.error('[DEBUG] JSON serialization failure:', error);
    try {
      output.flush();
    } catch {
      // A failed stdout write is outside the structured-output guarantee.
    }
    return ExitCodes.ERROR;
  }
}

function textOnly(kind: ParsedInvocation['kind']): boolean {
  return kind === 'help' || kind === 'version' || kind === 'completion' || kind === 'learn';
}

function unsupportedJson(output: CliOutput, flags: Flags): number {
  writeJsonError(output, { code: 'JSON_UNSUPPORTED', message: JSON_UNSUPPORTED_MESSAGE });
  return flushJson(output, ExitCodes.ERROR, flags.verbose, flags.debug);
}

function parseFailure(error: unknown): number {
  const parseError = error instanceof CliParseError ? error : new Error(errorMessage(error));
  const flags: Flags =
    error instanceof CliParseError ? error.flags : { json: false, verbose: false };
  const output = createCliOutput(flags.json);
  if (flags.json) {
    writeJsonError(output, { code: 'USAGE_ERROR', message: parseError.message });
  } else {
    writeHumanError(output, parseError.message);
  }
  return flushJson(output, ExitCodes.ERROR, flags.verbose, flags.debug);
}

function helpConfig(showIntro: boolean): HelpConfig {
  try {
    const config = loadConfig(resolvePaths());
    return { mode: config.mode, timeout: config.defaults.timeout, showIntro };
  } catch {
    return { showIntro };
  }
}

function ensureFailureDocument(output: CliOutput, code: number): void {
  if (output.hasError()) return;
  writeJsonError(output, {
    code: code === ExitCodes.TIMEOUT ? 'TIMEOUT' : 'ERROR',
    message: code === ExitCodes.TIMEOUT ? 'Command timed out.' : 'Command failed.',
  });
}

async function runContextCommand(
  parsed: ParsedArgs,
  argv: readonly string[],
  output: CliOutput
): Promise<number> {
  const { invocation, flags, metadata } = parsed;
  const command = metadata.commandPath[0] ?? invocation.kind;
  let ctx: Context | undefined;
  let status: number = ExitCodes.SUCCESS;
  try {
    ctx = createContext({
      argv: [...argv],
      flags,
      capability: metadata.capability,
      ui: output.ui,
      exit: (code: number): never => {
        throw new CliExit(code);
      },
    });

    const tmuxRequired = new Set([
      'talk',
      'send',
      'check',
      'read',
      'this',
      'name',
      'add',
      'whoami',
      'unbind',
    ]);
    if (!process.env.TMUX && tmuxRequired.has(command)) {
      ctx.ui.warn('Not running inside tmux. Some features may not work.');
    }

    await runStartupChecks(ctx, command);
    await dispatchCommand(ctx, parsed);
  } catch (error) {
    if (error instanceof CliExit) {
      status = error.code;
      if (status !== ExitCodes.SUCCESS) ensureFailureDocument(output, status);
    } else {
      status = ExitCodes.ERROR;
      const detail = publicError(error);
      if (flags.json) writeJsonError(output, detail);
      else writeHumanError(output, detail.message);
      if (flags.verbose || flags.debug) console.error('[DEBUG] CLI failure:', error);
    }
  }

  try {
    ctx?.dispose?.();
  } catch (error) {
    if (status === ExitCodes.SUCCESS) {
      status = ExitCodes.ERROR;
      const detail = {
        code: 'CLEANUP_ERROR',
        message: `Cleanup failed; command effects may already have occurred: ${errorMessage(error)}`,
      };
      if (flags.json) writeJsonError(output, detail);
      else writeHumanError(output, detail.message);
    } else if (flags.verbose || flags.debug) {
      console.error('[DEBUG] CLI cleanup failure:', error);
    }
  }

  if (flags.json) {
    if (output.hasDuplicateJson()) {
      status = ExitCodes.ERROR;
      writeJsonError(output, {
        code: 'INTERNAL_ERROR',
        message: 'Command emitted more than one JSON result.',
      });
    }
    if (status === ExitCodes.SUCCESS && !output.hasJson()) output.setJson({ ok: true });
    if (status !== ExitCodes.SUCCESS) ensureFailureDocument(output, status);
    status = flushJson(output, status, flags.verbose, flags.debug);
  }
  return status;
}

/** Run one CLI invocation and return its meaningful process status. */
export async function runCli(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    return parseFailure(error);
  }

  const { invocation, flags, metadata } = parsed;
  const output = createCliOutput(flags.json);
  const command = metadata.commandPath[0] ?? invocation.kind;

  if (command === 'team' || metadata.unsupportedTeam) {
    if (flags.json) {
      writeJsonError(output, { code: 'UNSUPPORTED_TEAM', message: UNSUPPORTED_TEAM_MESSAGE });
      return flushJson(output, ExitCodes.UNSUPPORTED_TEAM, flags.verbose, flags.debug);
    } else {
      writeHumanError(output, UNSUPPORTED_TEAM_MESSAGE);
    }
    return ExitCodes.UNSUPPORTED_TEAM;
  }

  if (flags.json && textOnly(invocation.kind)) return unsupportedJson(output, flags);

  if (invocation.kind === 'help') {
    try {
      cmdHelp(helpConfig(invocation.showIntro));
      return ExitCodes.SUCCESS;
    } catch (error) {
      writeHumanError(output, errorMessage(error));
      return ExitCodes.ERROR;
    }
  }

  if (invocation.kind === 'version') {
    try {
      const { VERSION } = await import('./version.js');
      console.log(VERSION);
      return ExitCodes.SUCCESS;
    } catch (error) {
      writeHumanError(output, errorMessage(error));
      return ExitCodes.ERROR;
    }
  }

  if (invocation.kind === 'completion') {
    try {
      cmdCompletion(invocation.shell);
      return ExitCodes.SUCCESS;
    } catch (error) {
      writeHumanError(output, errorMessage(error));
      return ExitCodes.ERROR;
    }
  }

  return runContextCommand(parsed, argv, output);
}
