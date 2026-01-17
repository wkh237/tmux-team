// ─────────────────────────────────────────────────────────────
// Context object - passed to all commands
// ─────────────────────────────────────────────────────────────

import type { Context, Flags } from './types.js';
import { resolvePaths, loadConfig } from './config.js';
import { createUI } from './ui.js';
import { createTmux } from './tmux.js';
import { ExitCodes } from './exits.js';

export interface CreateContextOptions {
  argv: string[];
  flags: Flags;
  cwd?: string;
}

export function createContext(options: CreateContextOptions): Context {
  const { argv, flags, cwd = process.cwd() } = options;

  const paths = resolvePaths(cwd, flags.team);
  const config = loadConfig(paths);
  const ui = createUI(flags.json);
  const tmux = createTmux();

  return {
    argv,
    flags,
    ui,
    config,
    tmux,
    paths,
    exit(code: number): never {
      process.exit(code);
    },
  };
}

export { ExitCodes };
