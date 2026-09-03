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
  /** Declares the resources a command may need; tmux and config are lazy. */
  capability?: 'none' | 'storage' | 'tmux';
}

export function createContext(options: CreateContextOptions): Context {
  const { argv, flags, cwd = process.cwd() } = options;

  // Global identities are intentionally scope-independent in v5. Keep the
  // legacy metadata fields readable through loadConfig, but always use the
  // workspace registry for legacy settings.
  const paths = resolvePaths(cwd);
  const ui = createUI(flags.json);
  const capability = options.capability ?? 'tmux';
  let tmux: Context['tmux'] | undefined;
  let config: Context['config'] | undefined;
  const getTmux = (): Context['tmux'] => {
    tmux ??= createTmux();
    return tmux;
  };
  const registryScope = {
    type: 'workspace' as const,
    workspaceRoot: paths.workspaceRoot ?? cwd,
  };
  const getConfig = (): Context['config'] => {
    config ??= loadConfig(
      paths,
      capability === 'tmux' ? getTmux().getAgentRegistry(registryScope) : undefined
    );
    return config;
  };

  const context = {
    argv,
    flags,
    ui,
    paths,
    registryScope,
    exit(code: number): never {
      process.exit(code);
    },
  } as Context;
  Object.defineProperties(context, {
    config: { enumerable: true, get: getConfig },
    tmux: { enumerable: true, get: getTmux },
  });
  // Preserve the established full-context behavior. Lightweight capabilities
  // intentionally defer both resources until a command asks for them.
  if (capability === 'tmux') getConfig();
  return context;
}

export { ExitCodes };
