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

  // Global identities are intentionally scope-independent in v5. Keep the
  // legacy metadata fields readable through loadConfig, but always use the
  // workspace registry for legacy settings.
  const paths = resolvePaths(cwd);
  const ui = createUI(flags.json);
  const tmux = createTmux();
  const registryScope = {
    type: 'workspace' as const,
    workspaceRoot: paths.workspaceRoot ?? cwd,
  };
  const config = loadConfig(paths, tmux.getAgentRegistry(registryScope));

  return {
    argv,
    flags,
    ui,
    config,
    tmux,
    paths,
    registryScope,
    exit(code: number): never {
      process.exit(code);
    },
  };
}

export { ExitCodes };
