import { normalizeName, validateName } from './domain/names.js';
import type { DurableIdentity, TmuxBinding } from './domain/identity.js';
import { resolveTarget } from './target-resolver.js';
import type {
  IdentityService,
  PaneInfo,
  Tmux,
  TmuxEndpointSnapshot,
  TmuxServerEvidence,
} from './types.js';
import { openIdentityRepository, type IdentityRepository } from './storage/identity-repository.js';
import type { Paths } from './types.js';

export interface IdentityServiceOptions {
  readonly tmux: Tmux;
  readonly paths: Paths;
  /** Test and embedding seam; production callers use the storage adapter. */
  readonly repository?: IdentityRepository;
}

export class IdentityServiceError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_NAME'
      | 'PANE_NOT_FOUND'
      | 'NAME_NOT_FOUND'
      | 'PANE_ALREADY_BOUND'
      | 'NAME_ALREADY_ACTIVE'
      | 'UNBOUND_PANE'
      | 'RECONCILIATION_FAILED',
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'IdentityServiceError';
  }
}

function serverMatches(expected: TmuxBinding, current: TmuxServerEvidence): boolean {
  return (
    expected.serverId === current.serverId &&
    expected.socketPath === current.socketPath &&
    expected.serverPid === current.serverPid &&
    expected.serverStartTime === current.serverStartTime
  );
}

function paneMatches(expected: TmuxBinding, pane: PaneInfo): boolean {
  return expected.paneId === pane.id && expected.panePid === pane.panePid;
}

function metadataMatches(pane: PaneInfo, identity: DurableIdentity, binding: TmuxBinding): boolean {
  const metadata = pane.metadata?.globalIdentity;
  return (
    metadata?.identityId === identity.id &&
    metadata.bindingId === binding.id &&
    metadata.serverId === binding.serverId &&
    metadata.panePid === binding.panePid &&
    normalizeName(metadata.name) === identity.canonicalName
  );
}

function endpointSnapshot(tmux: Tmux): TmuxEndpointSnapshot {
  if (tmux.getEndpointSnapshot) {
    try {
      return tmux.getEndpointSnapshot();
    } catch (error) {
      throw new IdentityServiceError(
        'RECONCILIATION_FAILED',
        'Could not inspect the tmux endpoint.',
        {
          cause: error,
        }
      );
    }
  }
  throw new IdentityServiceError(
    'RECONCILIATION_FAILED',
    'The tmux adapter does not provide a coherent endpoint snapshot.'
  );
}

function findPane(snapshot: TmuxEndpointSnapshot, paneId: string): PaneInfo | undefined {
  return snapshot.panes.find((pane) => pane.id === paneId);
}

function mapActive(
  repository: IdentityRepository,
  snapshot: TmuxEndpointSnapshot,
  bindings: readonly TmuxBinding[]
): Array<{ identity: DurableIdentity; binding: TmuxBinding; pane: PaneInfo }> {
  const identities = new Map(repository.listIdentities().map((item) => [item.id, item]));
  return bindings.flatMap((binding) => {
    const identity = identities.get(binding.identityId);
    const pane = findPane(snapshot, binding.paneId);
    if (
      !identity ||
      !pane ||
      !serverMatches(binding, snapshot.server) ||
      !paneMatches(binding, pane)
    ) {
      return [];
    }
    return metadataMatches(pane, identity, binding) ? [{ identity, binding, pane }] : [];
  });
}

function createOrResolve(
  repository: IdentityRepository,
  name: string
): { identity: DurableIdentity; created: boolean } {
  const valid = validateName(name);
  if (!valid.ok) throw new IdentityServiceError(valid.error.code, valid.error.message);
  const existing = repository.findByCanonicalName(valid.value.canonicalName);
  if (existing) return { identity: existing, created: false };
  try {
    return {
      identity: repository.createIdentity(valid.value.name, valid.value.canonicalName),
      created: true,
    };
  } catch (error) {
    // A concurrent creator may win the canonical unique constraint.
    const raced = repository.findByCanonicalName(valid.value.canonicalName);
    if (raced) return { identity: raced, created: false };
    throw new IdentityServiceError('RECONCILIATION_FAILED', 'Could not create durable identity.', {
      cause: error,
    });
  }
}

function cleanupUnboundIdentity(
  repository: IdentityRepository,
  created: boolean,
  id: string
): void {
  if (!created) return;
  try {
    repository.removeIdentityIfUnbound(id);
  } catch {
    // The identity may have been claimed by a concurrent binder. It is still
    // safe because active routing requires a verified binding join.
  }
}

function paneEvidence(snapshot: TmuxEndpointSnapshot, paneId: string): PaneInfo {
  const pane = findPane(snapshot, paneId);
  if (!pane || !pane.panePid) {
    throw new IdentityServiceError('PANE_NOT_FOUND', `Pane '${paneId}' was not found.`);
  }
  return pane;
}

/**
 * Adapt the legacy target resolver to the verified identity view. Commands
 * only consume this adapter; lifecycle and presence policy remain here.
 */
export function identityAwareTmux(tmux: Tmux, service?: IdentityService): Tmux {
  if (!service) return tmux;
  return {
    ...tmux,
    listGlobalIdentities: () =>
      service.activeIdentities().map(({ identity, binding }) => ({
        name: identity.name,
        canonicalName: identity.canonicalName,
        paneId: binding.paneId,
      })),
  };
}

export function createIdentityService(options: IdentityServiceOptions): IdentityService {
  const { tmux, paths } = options;
  const repository = options.repository ?? openIdentityRepository(paths.databaseFile);
  const ownsRepository = !options.repository;

  const reconcile = (): void => {
    const snapshot = endpointSnapshot(tmux);
    const allBindings = repository.findBindings();
    const identities = new Map(repository.listIdentities().map((item) => [item.id, item]));

    // Backfill old v5 pane metadata lazily. A database-only binding is never
    // active until this metadata marker is successfully written.
    for (const pane of snapshot.panes) {
      const legacy = pane.metadata?.globalIdentity;
      if (!legacy || legacy.identityId || !pane.panePid) continue;
      const { identity } = createOrResolve(repository, legacy.name);
      const binding = repository.createBinding({
        identityId: identity.id,
        transport: 'tmux',
        paneId: pane.id,
        serverId: snapshot.server.serverId,
        socketPath: snapshot.server.socketPath,
        serverPid: snapshot.server.serverPid,
        serverStartTime: snapshot.server.serverStartTime,
        panePid: pane.panePid,
        boundAt: new Date().toISOString(),
        lastVerifiedAt: new Date().toISOString(),
      });
      try {
        if (!tmux.setDurableIdentity) throw new Error('Durable tmux metadata is unavailable.');
        tmux.setDurableIdentity(pane.id, identity, binding);
      } catch (error) {
        try {
          repository.removeBinding(binding.id);
        } catch {
          // The legacy marker was not upgraded, so this row remains ineligible
          // for active routing and will be retried by reconciliation.
        }
        throw new IdentityServiceError(
          'RECONCILIATION_FAILED',
          'Could not backfill pane metadata.',
          {
            cause: error,
          }
        );
      }
    }

    for (const binding of allBindings) {
      const identity = identities.get(binding.identityId);
      const pane = findPane(snapshot, binding.paneId);
      if (
        !identity ||
        !pane ||
        !serverMatches(binding, snapshot.server) ||
        !paneMatches(binding, pane) ||
        !metadataMatches(pane, identity, binding)
      ) {
        repository.removeBinding(binding.id);
      } else {
        repository.touchBinding(binding.id, new Date().toISOString());
      }
    }
  };

  const safeReconcile = (): void => {
    try {
      reconcile();
    } catch (error) {
      if (error instanceof IdentityServiceError) throw error;
      throw new IdentityServiceError(
        'RECONCILIATION_FAILED',
        'Could not reconcile identity state.',
        {
          cause: error,
        }
      );
    }
  };

  const active = () => {
    safeReconcile();
    const snapshot = endpointSnapshot(tmux);
    return mapActive(repository, snapshot, repository.findBindings());
  };

  const bind = (paneId: string, name: string): DurableIdentity => {
    const snapshot = endpointSnapshot(tmux);
    const pane = paneEvidence(snapshot, paneId);
    const resolved = createOrResolve(repository, name);
    const identity = resolved.identity;
    const endpointBinding = repository
      .findBindings()
      .filter((item) => item.paneId === paneId && item.serverId === snapshot.server.serverId)[0];
    let current: TmuxBinding | undefined = endpointBinding;
    if (current && (!serverMatches(current, snapshot.server) || !paneMatches(current, pane))) {
      repository.removeBinding(current.id);
      current = undefined;
    }
    if (current && current.identityId !== identity.id) {
      cleanupUnboundIdentity(repository, resolved.created, identity.id);
      throw new IdentityServiceError(
        'PANE_ALREADY_BOUND',
        'Pane is already bound to another name.'
      );
    }
    const existingIdentityBinding = repository
      .findBindings()
      .find((item) => item.identityId === identity.id);
    if (existingIdentityBinding && existingIdentityBinding.id !== current?.id) {
      const existingPane = findPane(snapshot, existingIdentityBinding.paneId);
      if (
        existingPane &&
        serverMatches(existingIdentityBinding, snapshot.server) &&
        paneMatches(existingIdentityBinding, existingPane)
      ) {
        throw new IdentityServiceError(
          'NAME_ALREADY_ACTIVE',
          'Name is already active on another pane.'
        );
      }
      repository.removeBinding(existingIdentityBinding.id);
    }
    if (current) {
      if (tmux.setDurableIdentity && !metadataMatches(pane, identity, current)) {
        tmux.setDurableIdentity(paneId, identity, current);
      }
      repository.touchBinding(current.id, new Date().toISOString());
      return identity;
    }
    const now = new Date().toISOString();
    let binding: TmuxBinding;
    try {
      binding = repository.createBinding({
        identityId: identity.id,
        transport: 'tmux',
        paneId,
        serverId: snapshot.server.serverId,
        socketPath: snapshot.server.socketPath,
        serverPid: snapshot.server.serverPid,
        serverStartTime: snapshot.server.serverStartTime,
        panePid: pane.panePid as number,
        boundAt: now,
        lastVerifiedAt: now,
      });
    } catch (error) {
      // SQLite uniqueness is the final arbiter for cross-process races. Turn
      // the native constraint into the same deterministic domain result.
      const endpoint = repository.findBindingByPane(paneId, snapshot.server.serverId);
      if (endpoint && endpoint.identityId === identity.id) {
        try {
          if (!tmux.setDurableIdentity) throw new Error('Durable tmux metadata is unavailable.');
          tmux.setDurableIdentity(paneId, identity, endpoint);
        } catch (metadataError) {
          throw new IdentityServiceError(
            'RECONCILIATION_FAILED',
            'Could not write pane metadata.',
            { cause: metadataError }
          );
        }
        return identity;
      }
      if (endpoint) {
        cleanupUnboundIdentity(repository, resolved.created, identity.id);
        throw new IdentityServiceError(
          'PANE_ALREADY_BOUND',
          'Pane is already bound to another name.'
        );
      }
      const racedIdentityBinding = repository
        .findBindings()
        .find((item) => item.identityId === identity.id);
      if (racedIdentityBinding) {
        cleanupUnboundIdentity(repository, false, identity.id);
        throw new IdentityServiceError(
          'NAME_ALREADY_ACTIVE',
          'Name is already active on another pane.'
        );
      }
      cleanupUnboundIdentity(repository, resolved.created, identity.id);
      throw new IdentityServiceError('RECONCILIATION_FAILED', 'Could not create tmux binding.', {
        cause: error,
      });
    }
    try {
      if (!tmux.setDurableIdentity) throw new Error('Durable tmux metadata is unavailable.');
      tmux.setDurableIdentity(paneId, identity, binding);
    } catch (error) {
      try {
        repository.removeBinding(binding.id);
      } catch {
        // The missing durable metadata still makes this row ineligible for
        // routing; reconciliation will retry cleanup on the next read.
      }
      throw new IdentityServiceError('RECONCILIATION_FAILED', 'Could not write pane metadata.', {
        cause: error,
      });
    }
    return identity;
  };

  return {
    bindCurrent(name) {
      const current = tmux.getCurrentPaneId();
      if (!current)
        throw new IdentityServiceError(
          'PANE_NOT_FOUND',
          'Not running inside a resolvable tmux pane.'
        );
      const paneId = tmux.resolvePaneTarget(current);
      if (!paneId)
        throw new IdentityServiceError(
          'PANE_NOT_FOUND',
          'Not running inside a resolvable tmux pane.'
        );
      return bind(paneId, name);
    },
    bindPane(pane, name) {
      const resolved = tmux.resolvePaneTarget(pane);
      if (!resolved)
        throw new IdentityServiceError('PANE_NOT_FOUND', `Pane target '${pane}' was not found.`);
      return bind(resolved, name);
    },
    unbindCurrent() {
      const current = tmux.getCurrentPaneId();
      if (!current) return undefined;
      const paneId = tmux.resolvePaneTarget(current);
      if (!paneId) return undefined;
      const item = active().find((entry) => entry.binding.paneId === paneId);
      if (!item) return undefined;
      try {
        if (tmux.clearDurableIdentity) tmux.clearDurableIdentity(paneId, item.binding.id);
      } catch (error) {
        throw new IdentityServiceError('RECONCILIATION_FAILED', 'Could not clear pane metadata.', {
          cause: error,
        });
      }
      try {
        repository.removeBinding(item.binding.id);
      } catch (error) {
        // Metadata was cleared first. A subsequent reconciliation will remove
        // the stale row, so this partial operation can never route a phantom.
        throw new IdentityServiceError('RECONCILIATION_FAILED', 'Could not remove tmux binding.', {
          cause: error,
        });
      }
      return item.identity;
    },
    currentIdentity() {
      const current = tmux.getCurrentPaneId();
      if (!current) return undefined;
      const paneId = tmux.resolvePaneTarget(current);
      return paneId ? active().find((entry) => entry.binding.paneId === paneId) : undefined;
    },
    activeIdentities: active,
    resolveActive(target) {
      const items = active();
      const identities = items.map(({ identity, binding }) => ({
        name: identity.name,
        canonicalName: identity.canonicalName,
        paneId: binding.paneId,
      }));
      const result = resolveTarget(
        {
          ...tmux,
          listGlobalIdentities: () => identities,
        },
        target
      );
      if (!result.ok) return undefined;
      return items.find((item) => item.binding.paneId === result.value.paneId);
    },
    reconcile: safeReconcile,
    close() {
      if (ownsRepository) repository.close();
    },
  };
}
