// ─────────────────────────────────────────────────────────────
// Context object - passed to all commands
// ─────────────────────────────────────────────────────────────

import type { Context, Flags } from './types.js';
import { resolvePaths, loadConfig } from './config.js';
import { createUI } from './ui.js';
import { createTmux } from './tmux.js';
import { ExitCodes } from './exits.js';
import { createIdentityService } from './identity-service.js';
import { openIdentityRepository, type IdentityRepository } from './storage/identity-repository.js';
import { createRoleService, type RoleRepository } from './role-service.js';

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
  let identityService: Context['identityService'] | undefined;
  let identityRepository: IdentityRepository | undefined;
  let roleService: Context['roleService'] | undefined;
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
  const getIdentityService = (): NonNullable<Context['identityService']> => {
    identityService ??= createIdentityService({
      tmux: getTmux(),
      paths,
      repository: getIdentityRepository(),
    });
    return identityService;
  };
  const getIdentityRepository = (): IdentityRepository => {
    identityRepository ??= openIdentityRepository(paths.databaseFile);
    return identityRepository;
  };
  const roleRepository: RoleRepository = {
    findByCanonicalName(canonicalName) {
      return getIdentityRepository().findByCanonicalName(canonicalName);
    },
    findRole(identityId) {
      return getIdentityRepository().findRole(identityId);
    },
    setRole(identityId, content) {
      return getIdentityRepository().setRole(identityId, content);
    },
    clearRole(identityId) {
      return getIdentityRepository().clearRole(identityId);
    },
  };
  const getRoleService = (): NonNullable<Context['roleService']> => {
    roleService ??= createRoleService({
      repository: roleRepository,
      currentIdentity: () =>
        getTmux().getCurrentPaneId() ? getIdentityService().currentIdentity() : undefined,
    });
    return roleService;
  };
  const dispose = (): void => {
    const service = identityService;
    const repository = identityRepository;
    identityService = undefined;
    identityRepository = undefined;
    roleService = undefined;
    try {
      service?.close();
    } finally {
      repository?.close();
    }
  };

  const context = {
    argv,
    flags,
    ui,
    paths,
    registryScope,
    dispose,
    exit(code: number): never {
      dispose();
      process.exit(code);
    },
  } as Context;
  Object.defineProperties(context, {
    config: { enumerable: true, get: getConfig },
    tmux: { enumerable: true, get: getTmux },
    identityService: { enumerable: true, get: getIdentityService },
    roleService: { enumerable: true, get: getRoleService },
  });
  // Preserve the established full-context behavior. Lightweight capabilities
  // intentionally defer both resources until a command asks for them.
  if (capability === 'tmux') getConfig();
  return context;
}

export { ExitCodes };
