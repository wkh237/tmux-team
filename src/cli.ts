#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────
// tmux-team CLI entry point
// ─────────────────────────────────────────────────────────────

import { createContext, ExitCodes } from './context.js';

// Commands
import { cmdHelp, HelpConfig } from './commands/help.js';
import { loadConfig, resolvePaths } from './config.js';
import { createUI } from './ui.js';
import { cmdCompletion } from './commands/completion.js';
import { UNSUPPORTED_TEAM_MESSAGE } from './commands/unsupported-team.js';
import { runStartupChecks } from './update-check.js';
import { CliParseError, parseArgs } from './cli/parser.js';
import { dispatchCommand } from './cli/application.js';

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

function main(): void {
  const argv = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    const parseError = error instanceof CliParseError ? error : new Error(String(error));
    const flags = error instanceof CliParseError ? error.flags : { json: false, verbose: false };
    // Parse failures use the normal UI contract without loading config or tmux.
    const parseContext = createContext({ argv, flags, capability: 'none' });
    parseContext.ui.error(parseError.message);
    try {
      parseContext.exit(ExitCodes.ERROR);
    } catch {
      // A test double or embedder may model the non-returning exit by throwing.
      process.exit(ExitCodes.ERROR);
    }
    return;
  }
  const { invocation, flags, metadata } = parsed;
  const command = metadata.commandPath[0] ?? invocation.kind;

  // Reject both `team` and either spelling of `--team` before command routing
  // or configuration loading can interpret them as a scope.
  if (command === 'team' || metadata.unsupportedTeam) {
    const ui = createUI(flags.json);
    const error = {
      code: 'UNSUPPORTED_TEAM',
      message: UNSUPPORTED_TEAM_MESSAGE,
    };
    if (flags.json) ui.json({ error });
    else ui.error(error.message);
    process.exit(ExitCodes.UNSUPPORTED_TEAM);
    return;
  }

  // Help - load config to show current mode/timeout
  if (invocation.kind === 'help') {
    // Show intro highlight when running just `tmux-team` with no args
    const showIntro = invocation.showIntro;
    try {
      const paths = resolvePaths();
      const config = loadConfig(paths);
      const helpConfig: HelpConfig = {
        mode: config.mode,
        timeout: config.defaults.timeout,
        showIntro,
      };
      cmdHelp(helpConfig);
    } catch {
      // Fallback if config can't be loaded
      cmdHelp({ showIntro });
    }
    process.exit(ExitCodes.SUCCESS);
    return;
  }

  if (invocation.kind === 'version') {
    import('./version.js').then((m) => console.log(m.VERSION));
    return;
  }

  // Completion doesn't need context
  if (invocation.kind === 'completion') {
    cmdCompletion(invocation.shell);
    process.exit(ExitCodes.SUCCESS);
    return;
  }

  // Create context for all other commands
  const ctx = createContext({ argv, flags, capability: metadata.capability });

  // Warn if not in tmux for commands that require it
  const TMUX_REQUIRED_COMMANDS = [
    'talk',
    'send',
    'check',
    'read',
    'this',
    'name',
    'add',
    'whoami',
    'unbind',
  ];
  if (!process.env.TMUX && TMUX_REQUIRED_COMMANDS.includes(command)) {
    ctx.ui.warn('Not running inside tmux. Some features may not work.');
  }

  const run = async (): Promise<void> => {
    await runStartupChecks(ctx, command ?? 'help');
    await dispatchCommand(ctx, parsed);
  };

  run()
    .catch((err) => {
      if (!flags.json) {
        console.error(err);
      } else {
        console.error(JSON.stringify({ error: String(err?.message ?? err) }));
      }
      // Dispose before process.exit; Node does not guarantee finally blocks
      // will run after an explicit exit in embedding and test environments.
      ctx.dispose?.();
      process.exit(ExitCodes.ERROR);
    })
    .finally(() => ctx.dispose?.());
}

main();
