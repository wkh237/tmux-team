#!/usr/bin/env tsx
// ─────────────────────────────────────────────────────────────
// tmux-team CLI entry point
// ─────────────────────────────────────────────────────────────

import { createContext, ExitCodes } from './context.js';
import type { Flags } from './types.js';

// Commands
import { cmdHelp } from './commands/help.js';
import { cmdInit } from './commands/init.js';
import { cmdList } from './commands/list.js';
import { cmdAdd } from './commands/add.js';
import { cmdUpdate } from './commands/update.js';
import { cmdRemove } from './commands/remove.js';
import { cmdTalk } from './commands/talk.js';
import { cmdCheck } from './commands/check.js';
import { cmdCompletion } from './commands/completion.js';

// ─────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { command: string; args: string[]; flags: Flags } {
  const flags: Flags = {
    json: false,
    verbose: false,
  };

  const positional: string[] = [];
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--verbose' || arg === '-v') {
      flags.verbose = true;
    } else if (arg === '--force' || arg === '-f') {
      flags.force = true;
    } else if (arg === '--config') {
      flags.config = argv[++i];
    } else if (arg === '--delay') {
      flags.delay = parseTime(argv[++i]);
    } else if (arg === '--wait') {
      flags.wait = true;
    } else if (arg === '--timeout') {
      flags.timeout = parseTime(argv[++i]);
    } else if (arg.startsWith('--pane=')) {
      // Handled in update command
      positional.push(arg);
    } else if (arg.startsWith('--remark=')) {
      // Handled in update command
      positional.push(arg);
    } else if (arg.startsWith('-')) {
      // Unknown flag, pass through
      positional.push(arg);
    } else {
      positional.push(arg);
    }
    i++;
  }

  const [command = 'help', ...args] = positional;
  return { command, args, flags };
}

/**
 * Parse time string to seconds.
 * Default unit is seconds (no suffix needed).
 */
function parseTime(value: string): number {
  if (!value) return 0;

  const match = value.match(/^(\d+(?:\.\d+)?)(ms|s)?$/i);
  if (!match) {
    console.error(`Invalid time format: ${value}. Use number (seconds) or number with ms/s suffix.`);
    process.exit(ExitCodes.ERROR);
  }

  const num = parseFloat(match[1]);
  const unit = (match[2] || 's').toLowerCase();

  if (unit === 'ms') {
    return num / 1000;
  }
  return num; // seconds
}

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────

function main(): void {
  const argv = process.argv.slice(2);
  const { command, args, flags } = parseArgs(argv);

  // Help doesn't need context
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    cmdHelp();
    process.exit(ExitCodes.SUCCESS);
  }

  if (command === '--version' || command === '-V') {
    import('./version.js').then((m) => console.log(m.VERSION));
    return;
  }

  // Completion doesn't need context
  if (command === 'completion') {
    cmdCompletion(args[0]);
    process.exit(ExitCodes.SUCCESS);
  }

  // Create context for all other commands
  const ctx = createContext({ argv, flags });

  const run = async (): Promise<void> => {
    switch (command) {
    case 'init':
      cmdInit(ctx);
      break;

    case 'list':
    case 'ls':
      cmdList(ctx);
      break;

    case 'add':
      if (args.length < 2) {
        ctx.ui.error('Usage: tmux-team add <name> <pane> [remark]');
        ctx.exit(ExitCodes.ERROR);
      }
      cmdAdd(ctx, args[0], args[1], args[2]);
      break;

    case 'update':
      if (args.length < 1) {
        ctx.ui.error('Usage: tmux-team update <name> --pane <pane> | --remark <remark>');
        ctx.exit(ExitCodes.ERROR);
      }
      {
        const options: { pane?: string; remark?: string } = {};
        for (let i = 1; i < args.length; i++) {
          if (args[i] === '--pane' && args[i + 1]) {
            options.pane = args[++i];
          } else if (args[i] === '--remark' && args[i + 1]) {
            options.remark = args[++i];
          } else if (args[i].startsWith('--pane=')) {
            options.pane = args[i].slice(7);
          } else if (args[i].startsWith('--remark=')) {
            options.remark = args[i].slice(9);
          }
        }
        cmdUpdate(ctx, args[0], options);
      }
      break;

    case 'remove':
    case 'rm':
      if (args.length < 1) {
        ctx.ui.error('Usage: tmux-team remove <name>');
        ctx.exit(ExitCodes.ERROR);
      }
      cmdRemove(ctx, args[0]);
      break;

    case 'talk':
    case 'send':
      if (args.length < 2) {
        ctx.ui.error('Usage: tmux-team talk <target> <message>');
        ctx.exit(ExitCodes.ERROR);
      }
      await cmdTalk(ctx, args[0], args[1]);
      break;

    case 'check':
    case 'read':
      if (args.length < 1) {
        ctx.ui.error('Usage: tmux-team check <target> [lines]');
        ctx.exit(ExitCodes.ERROR);
      }
      cmdCheck(ctx, args[0], args[1] ? parseInt(args[1], 10) : undefined);
      break;

    default:
      ctx.ui.error(`Unknown command: ${command}. Run 'tmux-team help' for usage.`);
      ctx.exit(ExitCodes.ERROR);
    }
  };

  run().catch((err) => {
    if (!flags.json) {
      console.error(err);
    } else {
      console.error(JSON.stringify({ error: String(err?.message ?? err) }));
    }
    process.exit(ExitCodes.ERROR);
  });
}

main();
