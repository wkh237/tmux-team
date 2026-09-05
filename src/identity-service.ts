import { performance } from 'node:perf_hooks';
import { validateName } from './domain/names.js';
import type { DurableIdentity, TmuxBinding } from './domain/identity.js';
import { resolveTarget } from './target-resolver.js';
import type {
  IdentityService,
  PaneInfo,
  Tmux,
  TmuxEndpointProbe,
  TmuxEndpointSnapshot,
  TmuxOperationOptions,
  TmuxServerEvidence,
} from './types.js';
import { openIdentityRepository, type IdentityRepository } from './storage/identity-repository.js';
import type { Paths } from './types.js';

const PUBLICATION_TIMEOUT_MS = 3_000;

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

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function metadataMatches(pane: PaneInfo, identity: DurableIdentity, binding: TmuxBinding): boolean {
  const envelope = pane.metadata;
  const metadata = pane.metadata?.globalIdentity;
  if (envelope?.version !== 1 || !metadata || typeof metadata !== 'object') return false;
  if (
    !nonEmptyString(metadata.name) ||
    !nonEmptyString(metadata.canonicalName) ||
    !nonEmptyString(metadata.identityId) ||
    !nonEmptyString(metadata.bindingId) ||
    !nonEmptyString(metadata.serverId) ||
    typeof metadata.panePid !== 'number' ||
    !Number.isSafeInteger(metadata.panePid) ||
    metadata.panePid <= 0
  ) {
    return false;
  }
  const validatedName = validateName(metadata.name);
  if (
    !validatedName.ok ||
    validatedName.value.canonicalName !== metadata.canonicalName ||
    metadata.canonicalName !== identity.canonicalName
  ) {
    return false;
  }
  return (
    metadata?.identityId === identity.id &&
    metadata.bindingId === binding.id &&
    metadata.serverId === binding.serverId &&
    metadata.panePid === binding.panePid
  );
}

function endpointSnapshot(tmux: Tmux, options: TmuxOperationOptions = {}): TmuxEndpointSnapshot {
  if (tmux.getEndpointSnapshot) {
    try {
      return tmux.getEndpointSnapshot(options);
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

function assertDeadline(options: TmuxOperationOptions): void {
  if (options.deadlineMs !== undefined && performance.now() >= options.deadlineMs) {
    throw new Error('identity operation deadline exceeded');
  }
}

function verifyPublished(
  repository: IdentityRepository,
  tmux: Tmux,
  identity: DurableIdentity,
  binding: TmuxBinding,
  paneId: string,
  options: TmuxOperationOptions
): void {
  const snapshot = endpointSnapshot(tmux, options);
  const pane = findPane(snapshot, paneId);
  if (
    !pane ||
    !serverMatches(binding, snapshot.server) ||
    !paneMatches(binding, pane) ||
    !metadataMatches(pane, identity, binding)
  ) {
    throw new Error('Durable pane metadata could not be verified.');
  }
  const persisted = repository.findBindingByPane(paneId, binding.serverId);
  if (!persisted || persisted.id !== binding.id || persisted.identityId !== identity.id) {
    throw new Error('Durable binding could not be verified.');
  }
}

function probeForeignEndpoint(
  tmux: Tmux,
  binding: TmuxBinding,
  options: TmuxOperationOptions = {}
): TmuxEndpointProbe {
  if (!tmux.probeEndpoint) return { status: 'unknown' };
  try {
    return tmux.probeEndpoint(binding.socketPath, binding.serverPid, options);
  } catch {
    return { status: 'unknown' };
  }
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

  const guarded = <T>(operation: () => T, message: string): T => {
    try {
      return operation();
    } catch (error) {
      if (error instanceof IdentityServiceError) throw error;
      throw new IdentityServiceError('RECONCILIATION_FAILED', message, { cause: error });
    }
  };

  const coordinated = <T>(operation: (options: TmuxOperationOptions) => T, message: string): T =>
    guarded(
      () =>
        repository.withImmediateTransaction(() => {
          const options = { deadlineMs: performance.now() + PUBLICATION_TIMEOUT_MS };
          const result = operation(options);
          assertDeadline(options);
          return result;
        }),
      message
    );

  const reconcileWithinTransaction = (options: TmuxOperationOptions): TmuxEndpointSnapshot => {
    const snapshot = endpointSnapshot(tmux, options);
    const allBindings = repository.findBindings();
    const identities = new Map(repository.listIdentities().map((item) => [item.id, item]));

    for (const binding of allBindings) {
      // A command can observe only its current tmux server. Never prune a
      // binding owned by another socket merely because its panes are absent
      // from this endpoint snapshot.
      if (binding.socketPath !== snapshot.server.socketPath) continue;
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
    return snapshot;
  };

  const reconcile = (): void => {
    coordinated((options) => {
      reconcileWithinTransaction(options);
    }, 'Could not reconcile identity state.');
  };

  const active = () => {
    return coordinated((options) => {
      const snapshot = reconcileWithinTransaction(options);
      return mapActive(repository, snapshot, repository.findBindings());
    }, 'Could not reconcile identity state.');
  };

  const bind = (paneId: string, name: string): DurableIdentity => {
    // Validate the user-selected pane before creating the durable identity.
    // The authoritative snapshot is repeated only after the writer lock is
    // acquired below; this preflight prevents a missing pane from leaving a
    // newly-created identity behind.
    paneEvidence(endpointSnapshot(tmux), paneId);
    const resolved = createOrResolve(repository, name);
    const identity = resolved.identity;
    try {
      return coordinated((options) => {
        const snapshot = endpointSnapshot(tmux, options);
        const pane = paneEvidence(snapshot, paneId);
        const endpointBinding = repository
          .findBindings()
          .filter(
            (item) => item.paneId === paneId && item.serverId === snapshot.server.serverId
          )[0];
        let current: TmuxBinding | undefined = endpointBinding;
        if (current && (!serverMatches(current, snapshot.server) || !paneMatches(current, pane))) {
          repository.removeBinding(current.id);
          current = undefined;
        }
        if (current && current.identityId !== identity.id) {
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
          if (existingIdentityBinding.socketPath === snapshot.server.socketPath) {
            repository.removeBinding(existingIdentityBinding.id);
          } else {
            const probe = probeForeignEndpoint(tmux, existingIdentityBinding, options);
            if (probe.status === 'live') {
              const foreignPane = findPane(probe.snapshot, existingIdentityBinding.paneId);
              if (
                serverMatches(existingIdentityBinding, probe.snapshot.server) &&
                foreignPane &&
                paneMatches(existingIdentityBinding, foreignPane)
              ) {
                throw new IdentityServiceError(
                  'NAME_ALREADY_ACTIVE',
                  'Name is already active on another pane.'
                );
              }
              repository.removeBinding(existingIdentityBinding.id);
            } else if (probe.status === 'unknown') {
              throw new IdentityServiceError(
                'RECONCILIATION_FAILED',
                'Could not verify the existing tmux binding.'
              );
            } else {
              repository.removeBinding(existingIdentityBinding.id);
            }
          }
        }
        if (current) {
          if (tmux.setDurableIdentity && !metadataMatches(pane, identity, current)) {
            tmux.setDurableIdentity(paneId, identity, current, options);
          }
          verifyPublished(repository, tmux, identity, current, paneId, options);
          repository.touchBinding(current.id, new Date().toISOString());
          return identity;
        }
        const now = new Date().toISOString();
        const binding = repository.createBinding({
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
        try {
          if (!tmux.setDurableIdentity) throw new Error('Durable tmux metadata is unavailable.');
          tmux.setDurableIdentity(paneId, identity, binding, options);
          verifyPublished(repository, tmux, identity, binding, paneId, options);
        } catch (error) {
          throw new IdentityServiceError(
            'RECONCILIATION_FAILED',
            'Could not write pane metadata.',
            {
              cause: error,
            }
          );
        }
        return identity;
      }, 'Could not publish identity state.');
    } catch (error) {
      if (
        resolved.created &&
        error instanceof IdentityServiceError &&
        (error.code === 'PANE_NOT_FOUND' ||
          error.code === 'PANE_ALREADY_BOUND' ||
          error.code === 'NAME_ALREADY_ACTIVE')
      ) {
        cleanupUnboundIdentity(repository, true, identity.id);
      }
      throw error;
    }
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
      return coordinated((options) => {
        const snapshot = reconcileWithinTransaction(options);
        const item = mapActive(repository, snapshot, repository.findBindings()).find(
          (entry) => entry.binding.paneId === paneId
        );
        if (!item) return undefined;
        try {
          if (tmux.clearDurableIdentity) {
            tmux.clearDurableIdentity(paneId, item.binding.id, options);
          }
        } catch (error) {
          throw new IdentityServiceError(
            'RECONCILIATION_FAILED',
            'Could not clear pane metadata.',
            { cause: error }
          );
        }
        try {
          repository.removeBinding(item.binding.id);
        } catch (error) {
          throw new IdentityServiceError(
            'RECONCILIATION_FAILED',
            'Could not remove tmux binding.',
            { cause: error }
          );
        }
        return item.identity;
      }, 'Could not unbind identity state.');
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
    reconcile,
    close() {
      if (ownsRepository) repository.close();
    },
  };
}
