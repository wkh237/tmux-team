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
import { createPreambleService } from './preamble-service.js';
import { createRequestService } from './request-service.js';

export interface CreateContextOptions {
  argv: string[];
  flags: Flags;
  cwd?: string;
  /** Declares the resources a command may need; tmux and config are lazy. */
  capability?: 'none' | 'storage' | 'tmux';
}

export function createContext(options: CreateContextOptions): Context {
  const { argv, flags, cwd = process.cwd() } = options;

  const paths = resolvePaths(cwd);
  const ui = createUI(flags.json);
  const capability = options.capability ?? 'tmux';
  let tmux: Context['tmux'] | undefined;
  let config: Context['config'] | undefined;
  let identityService: Context['identityService'] | undefined;
  let preambleService: Context['preambleService'] | undefined;
  let identityRepository: IdentityRepository | undefined;
  let roleService: Context['roleService'] | undefined;
  let requestService: Context['requestService'] | undefined;
  let disposed = false;
  const assertActive = (): void => {
    if (disposed) throw new Error('Context is disposed.');
  };
  const getTmux = (): Context['tmux'] => {
    assertActive();
    tmux ??= createTmux();
    return tmux;
  };
  const getConfig = (): Context['config'] => {
    assertActive();
    config ??= loadConfig(paths);
    return config;
  };
  const getIdentityService = (): NonNullable<Context['identityService']> => {
    assertActive();
    identityService ??= createIdentityService({
      tmux: getTmux(),
      repository: getIdentityRepository(),
    });
    return identityService;
  };
  const getIdentityRepository = (): IdentityRepository => {
    assertActive();
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
    assertActive();
    roleService ??= createRoleService({
      repository: roleRepository,
      currentIdentity: () =>
        getTmux().getCurrentPaneId() ? getIdentityService().currentIdentity() : undefined,
    });
    return roleService;
  };
  const getPreambleService = (): NonNullable<Context['preambleService']> => {
    assertActive();
    preambleService ??= createPreambleService({ repository: getIdentityRepository() });
    return preambleService;
  };
  const getRequestService = (): NonNullable<Context['requestService']> => {
    assertActive();
    requestService ??= createRequestService({ repository: getIdentityRepository() });
    return requestService;
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    const repository = identityRepository;
    identityService = undefined;
    preambleService = undefined;
    identityRepository = undefined;
    roleService = undefined;
    requestService = undefined;
    repository?.close();
  };

  const context = {
    argv,
    flags,
    ui,
    paths,
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
    preambleService: { enumerable: true, get: getPreambleService },
    requestService: { enumerable: true, get: getRequestService },
    roleService: { enumerable: true, get: getRoleService },
  });
  // Preserve the established full-context behavior. Lightweight capabilities
  // intentionally defer both resources until a command asks for them.
  if (capability === 'tmux') getConfig();
  return context;
}

export { ExitCodes };
