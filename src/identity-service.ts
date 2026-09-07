import { performance } from 'node:perf_hooks';
import { isPaneTarget, normalizeName, validateName } from './domain/names.js';
import type { DurableIdentity, TmuxBinding } from './domain/identity.js';
import {
  requireDurableIdentity,
  resolveDurableIdentity,
  type IdentitySelector,
  type DurableIdentityResolution,
} from './identity-context.js';
import { PaneMetadataError } from './pane-metadata-error.js';
import type { TargetIdentity, TargetResolverPort } from './target-resolver.js';
import type {
  IdentityService,
  PaneInfo,
  Tmux,
  TmuxEndpointProbe,
  TmuxEndpointSnapshot,
  TmuxOperationOptions,
  TmuxServerEvidence,
  IdentityCreationResult,
} from './types.js';

const PUBLICATION_TIMEOUT_MS = 3_000;

export interface IdentityServiceOptions {
  readonly tmux: Tmux;
  readonly repository: IdentityRepository;
}

/** Application-owned persistence port for durable identity binding. */
export interface IdentityRepository {
  withImmediateTransaction<T>(operation: () => T): T;
  findByCanonicalName(canonicalName: string): DurableIdentity | undefined;
  findById(id: string): DurableIdentity | undefined;
  createIdentity(name: string, canonicalName: string): DurableIdentity;
  listIdentities(): DurableIdentity[];
  findBindings(): TmuxBinding[];
  findBindingByPane(paneId: string, serverId: string): TmuxBinding | undefined;
  findBindingByIdentity(identityId: string): TmuxBinding | undefined;
  createBinding(binding: Omit<TmuxBinding, 'id'> & { id?: string }): TmuxBinding;
  touchBinding(id: string, lastVerifiedAt: string): void;
  removeBinding(id: string): void;
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
        error instanceof PaneMetadataError ? error.message : 'Could not inspect the tmux endpoint.',
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

interface BindingEvidence {
  readonly identity: DurableIdentity;
  readonly pane: PaneInfo;
}

function verifiedBindingEvidence(
  binding: TmuxBinding,
  identity: DurableIdentity | undefined,
  snapshot: TmuxEndpointSnapshot
): BindingEvidence | undefined {
  const pane = findPane(snapshot, binding.paneId);
  if (
    !identity ||
    !pane ||
    !serverMatches(binding, snapshot.server) ||
    !paneMatches(binding, pane) ||
    !metadataMatches(pane, identity, binding)
  ) {
    return undefined;
  }
  return { identity, pane };
}

function targetIdentity(item: {
  readonly identity: DurableIdentity;
  readonly binding: TmuxBinding;
  readonly pane: PaneInfo;
}): TargetIdentity {
  return {
    name: item.identity.name,
    canonicalName: item.identity.canonicalName,
    paneId: item.binding.paneId,
    pane: item.pane,
    evidence: {
      identity: item.identity,
      binding: item.binding,
    },
  };
}

export function assertTargetIdentityEvidence(
  identity: TargetIdentity,
  snapshot: TmuxEndpointSnapshot
): void {
  const evidence = identity.evidence;
  if (
    !evidence ||
    identity.name !== evidence.identity.name ||
    identity.canonicalName !== evidence.identity.canonicalName ||
    identity.paneId !== evidence.binding.paneId ||
    !verifiedBindingEvidence(evidence.binding, evidence.identity, snapshot)
  ) {
    throw new IdentityServiceError(
      'RECONCILIATION_FAILED',
      'Target identity evidence could not be verified.'
    );
  }
}

function mapActive(
  repository: IdentityRepository,
  snapshot: TmuxEndpointSnapshot,
  bindings: readonly TmuxBinding[]
): Array<{ identity: DurableIdentity; binding: TmuxBinding; pane: PaneInfo }> {
  const identities = new Map(repository.listIdentities().map((item) => [item.id, item]));
  return bindings.flatMap((binding) => {
    const evidence = verifiedBindingEvidence(binding, identities.get(binding.identityId), snapshot);
    return evidence ? [{ identity: evidence.identity, binding, pane: evidence.pane }] : [];
  });
}

function createOrResolve(repository: IdentityRepository, name: string): IdentityCreationResult {
  const valid = validateName(name);
  if (!valid.ok) throw new IdentityServiceError(valid.error.code, valid.error.message);
  return repository.withImmediateTransaction(() => {
    const existing = repository.findByCanonicalName(valid.value.canonicalName);
    if (existing) return { identity: existing, created: false };
    return {
      identity: repository.createIdentity(valid.value.name, valid.value.canonicalName),
      created: true,
    };
  });
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
  const snapshot = endpointSnapshot(tmux, { ...options, paneIds: [paneId] });
  const pane = findPane(snapshot, paneId);
  if (
    !pane ||
    !serverMatches(binding, snapshot.server) ||
    !paneMatches(binding, pane) ||
    !metadataMatches(pane, identity, binding)
  ) {
    throw new IdentityServiceError(
      'RECONCILIATION_FAILED',
      'Pane metadata verification failed: pane/server identity does not match.'
    );
  }
  const persisted = repository.findBindingByPane(paneId, binding.serverId);
  if (!persisted || persisted.id !== binding.id || persisted.identityId !== identity.id) {
    throw new IdentityServiceError(
      'RECONCILIATION_FAILED',
      'Pane metadata verification failed: database binding does not match.'
    );
  }
}

function probeForeignEndpoint(
  tmux: Tmux,
  binding: TmuxBinding,
  options: TmuxOperationOptions = {}
): TmuxEndpointProbe {
  if (!tmux.probeEndpoint) return { status: 'unknown' };
  try {
    return tmux.probeEndpoint(binding.socketPath, binding.serverPid, {
      ...options,
      paneIds: [binding.paneId],
    });
  } catch {
    return { status: 'unknown' };
  }
}

/** Adapt target resolution to the verified identity view. */
export function identityAwareTmux(tmux: Tmux, service: IdentityService): Tmux & TargetResolverPort {
  if (!service) throw new Error('Identity service is required for target resolution.');
  return {
    ...tmux,
    listGlobalIdentities: (selection) => {
      if (!selection) return service.activeIdentities().map(targetIdentity);
      const item = service.resolveActive(
        'paneId' in selection ? selection.paneId : selection.canonicalName
      );
      return item ? [targetIdentity(item)] : [];
    },
  };
}

export function createIdentityService(options: IdentityServiceOptions): IdentityService {
  const { tmux, repository } = options;
  if (!repository) throw new Error('Identity repository is required.');

  const guarded = <T>(operation: () => T, message: string): T => {
    try {
      return operation();
    } catch (error) {
      if (error instanceof IdentityServiceError) throw error;
      if (error instanceof PaneMetadataError) {
        throw new IdentityServiceError('RECONCILIATION_FAILED', error.message, { cause: error });
      }
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

  // Both scoped and full discovery reconcile only bindings covered by their
  // snapshot. Foreign sockets are never pruned based on local absence.
  const activeBinding = (
    binding: TmuxBinding | undefined,
    identity: DurableIdentity | undefined,
    snapshot: TmuxEndpointSnapshot
  ) => {
    if (!binding || binding.socketPath !== snapshot.server.socketPath) return undefined;
    const evidence = verifiedBindingEvidence(binding, identity, snapshot);
    if (!evidence) {
      repository.removeBinding(binding.id);
      return undefined;
    }
    repository.touchBinding(binding.id, new Date().toISOString());
    return { ...evidence, binding };
  };

  const activePane = (paneId: string, options: TmuxOperationOptions) => {
    const snapshot = endpointSnapshot(tmux, { ...options, paneIds: [paneId] });
    const binding = repository.findBindingByPane(paneId, snapshot.server.serverId);
    return activeBinding(
      binding,
      binding ? repository.findById(binding.identityId) : undefined,
      snapshot
    );
  };

  const reconcileWithinTransaction = (options: TmuxOperationOptions): TmuxEndpointSnapshot => {
    const snapshot = endpointSnapshot(tmux, options);
    const identities = new Map(repository.listIdentities().map((item) => [item.id, item]));
    for (const binding of repository.findBindings()) {
      activeBinding(binding, identities.get(binding.identityId), snapshot);
    }
    return snapshot;
  };

  const reconcile = (): void => {
    coordinated((options) => {
      reconcileWithinTransaction(options);
    }, 'Could not reconcile identity state.');
  };

  const currentIdentityContext = () => {
    const currentPane = tmux.getCurrentPaneId();
    if (!currentPane) return undefined;
    return coordinated(
      (options) => activePane(currentPane, options),
      'Could not inspect current identity.'
    );
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
    paneEvidence(endpointSnapshot(tmux, { paneIds: [paneId] }), paneId);
    let identity: DurableIdentity;
    try {
      identity = createOrResolve(repository, name).identity;
    } catch (error) {
      if (error instanceof IdentityServiceError) throw error;
      throw new IdentityServiceError(
        'RECONCILIATION_FAILED',
        'Could not create durable identity.',
        {
          cause: error,
        }
      );
    }
    return coordinated((options) => {
      const existingIdentityBinding = repository.findBindingByIdentity(identity.id);
      const snapshot = endpointSnapshot(tmux, {
        ...options,
        paneIds: [
          ...new Set([
            paneId,
            ...(existingIdentityBinding ? [existingIdentityBinding.paneId] : []),
          ]),
        ],
      });
      const pane = paneEvidence(snapshot, paneId);
      const endpointBinding = repository.findBindingByPane(paneId, snapshot.server.serverId);
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
      } catch (error) {
        throw new IdentityServiceError(
          'RECONCILIATION_FAILED',
          error instanceof PaneMetadataError ? error.message : 'Could not write pane metadata.',
          { cause: error }
        );
      }
      verifyPublished(repository, tmux, identity, binding, paneId, options);
      return identity;
    }, 'Could not publish identity state.');
  };

  return {
    createIdentity(name) {
      return createOrResolve(repository, name);
    },
    showIdentity(name) {
      const valid = validateName(name);
      if (!valid.ok) throw new IdentityServiceError(valid.error.code, valid.error.message);
      return requireDurableIdentity(
        {
          findByCanonicalName: (canonicalName) => repository.findByCanonicalName(canonicalName),
          currentIdentity: () => undefined,
        },
        { value: name, kind: 'identity', explicit: true }
      );
    },
    listIdentities() {
      return repository.listIdentities();
    },
    bindCurrent(name) {
      const current = tmux.getCurrentPaneId();
      if (!current)
        throw new IdentityServiceError(
          'PANE_NOT_FOUND',
          'Not running inside a resolvable tmux pane.'
        );
      return bind(current, name);
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
      const paneId = current;
      return coordinated((options) => {
        const item = activePane(paneId, options);
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
      return currentIdentityContext();
    },
    resolveIdentity(selector?: IdentitySelector): DurableIdentityResolution {
      return resolveDurableIdentity(
        {
          findByCanonicalName: (canonicalName) => repository.findByCanonicalName(canonicalName),
          currentIdentity: currentIdentityContext,
        },
        selector
      );
    },
    activeIdentities: active,
    resolveActive(target) {
      const paneId = isPaneTarget(target) ? tmux.resolvePaneTarget(target) : undefined;
      if (paneId === null) return undefined;
      return coordinated((options) => {
        if (paneId) return activePane(paneId, options);
        const identity = repository.findByCanonicalName(normalizeName(target));
        if (!identity) return undefined;
        const binding = repository.findBindingByIdentity(identity.id);
        if (!binding) return undefined;
        const snapshot = endpointSnapshot(tmux, { ...options, paneIds: [binding.paneId] });
        return activeBinding(binding, identity, snapshot);
      }, 'Could not inspect target identity.');
    },
    reconcile,
  };
}
