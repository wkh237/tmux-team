import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertTargetIdentityEvidence,
  createIdentityService,
  identityAwareTmux,
  IdentityServiceError,
} from './identity-service.js';
import { openIdentityRepository } from './storage/identity-repository.js';
import { PaneMetadataError } from './pane-metadata-error.js';
import type { DurableIdentity, TmuxBinding } from './domain/identity.js';
import type { PaneInfo, Paths, Tmux, TmuxEndpointSnapshot } from './types.js';

const directories: string[] = [];
const repositories: Array<ReturnType<typeof openIdentityRepository>> = [];

function fixture() {
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-identity-'));
  directories.push(globalDir);
  const pane: PaneInfo = {
    id: '%1',
    command: 'mock-agent',
    panePid: 1234,
    suggestedName: null,
  };
  let snapshot: TmuxEndpointSnapshot = {
    server: {
      serverId: 'server-a',
      socketPath: '/tmp/tmt-a',
      serverPid: 10,
      serverStartTime: 'one',
    },
    panes: [pane],
  };
  const tmux = {
    getCurrentPaneId: () => '%1',
    resolvePaneTarget: (target: string) => (target === '%1' ? '%1' : null),
    getEndpointSnapshot: () => snapshot,
    setDurableIdentity: (paneId: string, identity: DurableIdentity, binding: TmuxBinding) => {
      const target = snapshot.panes.find((item) => item.id === paneId);
      if (!target) throw new Error(`Unknown pane '${paneId}'.`);
      target.metadata = {
        version: 1,
        globalIdentity: {
          name: identity.name,
          canonicalName: identity.canonicalName,
          identityId: identity.id,
          bindingId: binding.id,
          serverId: binding.serverId,
          panePid: binding.panePid,
        },
      };
    },
    clearDurableIdentity: (paneId: string) => {
      const target = snapshot.panes.find((item) => item.id === paneId);
      if (!target?.metadata?.globalIdentity) return false;
      delete target.metadata.globalIdentity;
      if (Object.keys(target.metadata).length === 1) target.metadata = undefined;
      return true;
    },
    listGlobalIdentities: () => [],
  } as unknown as Tmux;
  const paths = {
    globalDir,
    databaseFile: path.join(globalDir, 'tmux-team.db'),
  } as Paths;
  return {
    tmux,
    paths,
    pane,
    setSnapshot: (next: TmuxEndpointSnapshot) => (snapshot = next),
    setProbe: (probe: NonNullable<Tmux['probeEndpoint']>) => (tmux.probeEndpoint = probe),
  };
}

function createTestService(test: ReturnType<typeof fixture>) {
  const repository = openIdentityRepository(test.paths.databaseFile);
  repositories.push(repository);
  return createIdentityService({ tmux: test.tmux, repository });
}

function seedForeignBinding(
  test: ReturnType<typeof fixture>,
  name = 'Foreign',
  pane?: { paneId?: string; panePid?: number }
) {
  const repository = openIdentityRepository(test.paths.databaseFile);
  repositories.push(repository);
  const identity = repository.createIdentity(name, name.toLowerCase());
  const binding = repository.createBinding({
    identityId: identity.id,
    transport: 'tmux',
    paneId: pane?.paneId ?? '%foreign',
    serverId: 'server-foreign',
    socketPath: '/tmp/tmt-foreign',
    serverPid: 999999,
    serverStartTime: 'foreign-start',
    panePid: pane?.panePid ?? 8888,
    boundAt: 'foreign-bound',
    lastVerifiedAt: 'foreign-verified',
  });
  return { identity, binding };
}

function addSecondPane(test: ReturnType<typeof fixture>): void {
  const second: PaneInfo = {
    id: '%2',
    command: 'mock-agent',
    panePid: 2345,
    suggestedName: null,
  };
  test.setSnapshot({ ...test.tmux.getEndpointSnapshot!(), panes: [test.pane, second] });
  test.tmux.resolvePaneTarget = (target: string) =>
    target === '%1' || target === '%2' ? target : null;
}

afterEach(() => {
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('durable identity service', () => {
  it('requires an injected repository without opening default storage', () => {
    const test = fixture();
    expect(() => createIdentityService({ tmux: test.tmux } as never)).toThrow(
      'Identity repository is required.'
    );
  });

  it('creates standalone identities idempotently without consulting tmux', () => {
    const test = fixture();
    const repository = openIdentityRepository(test.paths.databaseFile);
    repositories.push(repository);
    const service = createIdentityService({ tmux: test.tmux, repository });
    const bound = service.bindCurrent('Bound');
    const role = repository.setRole(bound.id, 'bound profile');
    const preamble = repository.setPreamble(bound.id, 'bound preamble');
    const binding = repository.findBindings();
    const snapshot = vi.spyOn(test.tmux, 'getEndpointSnapshot');
    const currentPane = vi.spyOn(test.tmux, 'getCurrentPaneId');
    const transaction = vi.spyOn(repository, 'withImmediateTransaction');

    const first = service.createIdentity('  Standalone  ');
    const second = service.createIdentity('standalone');
    expect(service.createIdentity('BOUND')).toEqual({ identity: bound, created: false });

    expect(first.created).toBe(true);
    expect(first.identity).toMatchObject({
      name: 'Standalone',
      canonicalName: 'standalone',
      id: expect.any(String),
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(first.identity.createdAt).toBe(first.identity.updatedAt);
    expect(second).toEqual({ identity: first.identity, created: false });
    expect(() => service.createIdentity('%2')).toThrowError(
      expect.objectContaining({ code: 'INVALID_NAME' })
    );
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(snapshot).not.toHaveBeenCalled();
    expect(currentPane).not.toHaveBeenCalled();
    expect(repository.findBindings()).toEqual(binding);
    expect(repository.findRole(bound.id)).toEqual(role);
    expect(repository.findPreamble(bound.id)).toEqual(preamble);
  });

  it('rolls back a standalone identity insert when its immediate transaction fails', () => {
    const test = fixture();
    const base = openIdentityRepository(test.paths.databaseFile);
    const repository = {
      ...base,
      withImmediateTransaction<T>(operation: () => T): T {
        return base.withImmediateTransaction(() => {
          operation();
          throw new Error('abort after identity insert');
        });
      },
    };
    const service = createIdentityService({ tmux: test.tmux, repository });

    try {
      expect(() => service.createIdentity('rolled-back')).toThrow('abort after identity insert');
      expect(base.findByCanonicalName('rolled-back')).toBeUndefined();
    } finally {
      base.close();
    }
  });

  it('shows existing identities, rejects invalid names, and reports missing names', () => {
    const test = fixture();
    const service = createTestService(test);
    // Fullwidth Latin tests canonical normalization without changing display text.
    const identity = service.createIdentity(' Ａｌｉｃｅ ').identity;
    const snapshot = vi.spyOn(test.tmux, 'getEndpointSnapshot');
    const currentPane = vi.spyOn(test.tmux, 'getCurrentPaneId');

    expect(service.showIdentity('alice')).toEqual(identity);
    expect(() => service.showIdentity('missing')).toThrowError(
      expect.objectContaining({ code: 'NAME_NOT_FOUND' })
    );
    expect(() => service.showIdentity('%1')).toThrowError(
      expect.objectContaining({ code: 'INVALID_NAME' })
    );
    expect(snapshot).not.toHaveBeenCalled();
    expect(currentPane).not.toHaveBeenCalled();
  });

  it('lists durable identities in canonical order with profiles and bindings intact', () => {
    const test = fixture();
    const service = createTestService(test);
    const bound = service.bindCurrent('Zulu');
    const repository = openIdentityRepository(test.paths.databaseFile);
    repositories.push(repository);
    repository.setRole(bound.id, 'keep this profile');
    const snapshot = vi.spyOn(test.tmux, 'getEndpointSnapshot');
    const currentPane = vi.spyOn(test.tmux, 'getCurrentPaneId');
    const alpha = service.createIdentity('Alpha').identity;
    const middle = service.createIdentity('middle').identity;

    expect(service.listIdentities()).toEqual([alpha, middle, bound]);
    expect(snapshot).not.toHaveBeenCalled();
    expect(currentPane).not.toHaveBeenCalled();
    expect(repository.findBindings()).toHaveLength(1);
    expect(repository.findRole(bound.id)).toMatchObject({ content: 'keep this profile' });
  });

  it('rejects invalid names before creating durable state', () => {
    const test = fixture();
    const service = createTestService(test);

    expect(() => service.bindCurrent('%12')).toThrowError(
      new IdentityServiceError('INVALID_NAME', 'Identity name must not look like a pane target.')
    );
    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.listIdentities()).toEqual([]);
    expect(repository.findBindings()).toEqual([]);
    repository.close();
  });

  it('requires pane process evidence before creating durable state', () => {
    const test = fixture();
    test.setSnapshot({
      ...test.tmux.getEndpointSnapshot!(),
      panes: [{ ...test.pane, panePid: undefined }],
    });
    const service = createTestService(test);

    expect(() => service.bindCurrent('missing-evidence')).toThrow("Pane '%1' was not found.");
    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.listIdentities()).toEqual([]);
    repository.close();
  });

  it('does not touch identity storage when current pane evidence is missing', () => {
    const test = fixture();
    const repository = openIdentityRepository(test.paths.databaseFile);
    const transaction = vi.spyOn(repository, 'withImmediateTransaction');
    const snapshot = vi.spyOn(test.tmux, 'getEndpointSnapshot');
    test.tmux.getCurrentPaneId = () => null;
    const service = createIdentityService({ ...test, repository });

    expect(() => service.bindCurrent('no-caller')).toThrow(
      'Not running inside a resolvable tmux pane.'
    );
    expect(service.currentIdentity()).toBeUndefined();
    expect(service.unbindCurrent()).toBeUndefined();
    expect(transaction).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
    expect(repository.listIdentities()).toEqual([]);
    expect(repository.findBindings()).toEqual([]);

    repository.close();
  });

  it('uses verified current-pane evidence without resolving an ambient target', () => {
    const test = fixture();
    const resolvePaneTarget = vi.spyOn(test.tmux, 'resolvePaneTarget');
    const service = createTestService(test);

    const identity = service.bindCurrent('direct-current');
    expect(service.currentIdentity()).toMatchObject({ identity: { id: identity.id } });
    expect(service.unbindCurrent()).toMatchObject({ id: identity.id });
    expect(resolvePaneTarget).not.toHaveBeenCalled();
  });

  it('resolves explicit durable identities without consulting tmux', () => {
    const test = fixture();
    const service = createTestService(test);
    const identity = service.bindCurrent('explicit');
    const currentPane = vi.spyOn(test.tmux, 'getCurrentPaneId');
    const snapshot = vi.spyOn(test.tmux, 'getEndpointSnapshot');

    expect(
      service.resolveIdentity({ value: ' EXPLICIT ', kind: 'identity', explicit: true })
    ).toEqual({ status: 'bound', identity });
    expect(service.resolveIdentity({ value: 'missing', kind: 'identity', explicit: true })).toEqual(
      { status: 'not-found' }
    );
    expect(currentPane).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('requires an implicit identity when the caller has no verified binding', () => {
    const test = fixture();
    test.tmux.getCurrentPaneId = () => null;
    const service = createTestService(test);

    expect(service.resolveIdentity()).toEqual({ status: 'required' });
  });

  it('fails closed for ambiguous implicit identity evidence', () => {
    const test = fixture();
    const base = openIdentityRepository(test.paths.databaseFile);
    repositories.push(base);
    const service = createIdentityService({ tmux: test.tmux, repository: base });
    service.bindCurrent('ambiguous');
    const ambiguousRepository = {
      ...base,
      findBindings: () => {
        const bindings = base.findBindings();
        return [...bindings, ...bindings];
      },
    };
    const ambiguousService = createIdentityService({
      tmux: test.tmux,
      repository: ambiguousRepository,
    });

    expect(ambiguousService.resolveIdentity()).toEqual({ status: 'ambiguous' });
    expect(() => ambiguousService.currentIdentity()).toThrow(
      expect.objectContaining({ code: 'IDENTITY_AMBIGUOUS' })
    );
  });

  it('creates one durable identity and a verified transient binding', () => {
    const test = fixture();
    const service = createTestService(test);
    const first = service.bindCurrent('  Ｇｅｍｉｎｉ  ');
    const second = service.bindCurrent('gemini');
    expect(second.id).toBe(first.id);
    expect(service.currentIdentity()).toMatchObject({
      identity: { id: first.id, name: 'Ｇｅｍｉｎｉ' },
    });
    expect(identityAwareTmux(test.tmux, service).listGlobalIdentities()).toEqual([
      expect.objectContaining({ name: 'Ｇｅｍｉｎｉ', canonicalName: 'gemini', paneId: '%1' }),
    ]);
    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.listIdentities()).toHaveLength(1);
    expect(repository.findBindings()).toHaveLength(1);
    repository.close();
  });

  it('asserts target identity evidence against a fresh endpoint snapshot', () => {
    const test = fixture();
    const service = createTestService(test);
    const identity = service.bindCurrent('evidence');
    const runtime = identityAwareTmux(test.tmux, service);
    const target = runtime.listGlobalIdentities()[0];
    const snapshot = test.tmux.getEndpointSnapshot!();
    const evidence = target?.evidence;
    if (!target || !evidence) throw new Error('Expected target identity evidence.');

    expect(() => assertTargetIdentityEvidence(target, snapshot)).not.toThrow();
    expect(() =>
      assertTargetIdentityEvidence({ ...target, evidence: undefined }, snapshot)
    ).toThrow(expect.objectContaining({ code: 'RECONCILIATION_FAILED' }));
    const mismatches: Array<[string, TmuxEndpointSnapshot]> = [
      ['server ID', { ...snapshot, server: { ...snapshot.server, serverId: 'server-other' } }],
      ['socket path', { ...snapshot, server: { ...snapshot.server, socketPath: '/tmp/other' } }],
      [
        'server PID',
        { ...snapshot, server: { ...snapshot.server, serverPid: snapshot.server.serverPid + 1 } },
      ],
      [
        'server start time',
        { ...snapshot, server: { ...snapshot.server, serverStartTime: 'start-other' } },
      ],
      [
        'pane PID',
        {
          ...snapshot,
          panes: snapshot.panes.map((pane) =>
            pane.id === target.paneId ? { ...pane, panePid: (pane.panePid ?? 0) + 1 } : pane
          ),
        },
      ],
      ['rebound pane', { ...snapshot, panes: [{ ...test.pane, id: '%2' }] }],
      [
        'durable marker',
        {
          ...snapshot,
          panes: snapshot.panes.map((pane) =>
            pane.id === target.paneId ? { ...pane, metadata: undefined } : pane
          ),
        },
      ],
    ];
    for (const [label, mismatch] of mismatches) {
      expect(() => assertTargetIdentityEvidence(target, mismatch), label).toThrow(
        expect.objectContaining({ code: 'RECONCILIATION_FAILED' })
      );
    }
    expect(evidence.identity).toEqual(identity);
  });

  it('does not let reconciliation delete a binding while metadata is publishing', () => {
    const test = fixture();
    const base = openIdentityRepository(test.paths.databaseFile);
    const observerBase = openIdentityRepository(test.paths.databaseFile);
    let reconciler: ReturnType<typeof createIdentityService> | undefined;
    const repository = {
      ...base,
      createBinding(value: Parameters<typeof base.createBinding>[0]) {
        const binding = base.createBinding(value);
        reconciler?.activeIdentities();
        return binding;
      },
    };
    // Use a second SQLite connection. Its callback deliberately bypasses the
    // observer's coordination boundary to isolate committed/uncommitted
    // visibility; the production observer uses its own immediate lock.
    reconciler = createIdentityService({
      ...test,
      repository: {
        ...observerBase,
        withImmediateTransaction: <T>(operation: () => T) => operation(),
      },
    });
    const binder = createIdentityService({ ...test, repository });

    expect(binder.bindCurrent('publication-race')).toMatchObject({
      canonicalName: 'publication-race',
    });
    expect(base.findBindings()).toHaveLength(1);
    expect(binder.activeIdentities()).toHaveLength(1);
    expect(test.pane.metadata?.globalIdentity?.bindingId).toBe(base.findBindings()[0]?.id);

    base.close();
    observerBase.close();
  });

  it('acquires repository coordination before taking a discovery snapshot', () => {
    const test = fixture();
    const base = openIdentityRepository(test.paths.databaseFile);
    const events: string[] = [];
    const snapshot = test.tmux.getEndpointSnapshot;
    if (!snapshot) throw new Error('Snapshot seam is missing.');
    test.tmux.getEndpointSnapshot = () => {
      events.push('snapshot');
      return snapshot();
    };
    const repository = {
      ...base,
      withImmediateTransaction<T>(operation: () => T): T {
        events.push('lock');
        return operation();
      },
    };
    const service = createIdentityService({ ...test, repository });

    expect(service.activeIdentities()).toEqual([]);
    expect(events.slice(0, 2)).toEqual(['lock', 'snapshot']);

    base.close();
  });

  it('fails closed when the tmux adapter cannot provide endpoint evidence', () => {
    const test = fixture();
    const repository = openIdentityRepository(test.paths.databaseFile);
    repositories.push(repository);
    const service = createIdentityService({
      tmux: { ...test.tmux, getEndpointSnapshot: undefined },
      repository,
    });
    expect(() => service.reconcile()).toThrow('coherent endpoint snapshot');
    expect(() => identityAwareTmux(test.tmux, undefined as never)).toThrow(
      'Identity service is required'
    );
  });

  it('converts endpoint inspection failures into a structured service error', () => {
    const test = fixture();
    test.tmux.getEndpointSnapshot = () => {
      throw new Error('tmux unavailable');
    };
    const service = createTestService(test);
    expect(() => service.activeIdentities()).toThrow('Could not inspect the tmux endpoint.');
  });

  it('prunes a changed pane process while preserving the durable identity', () => {
    const test = fixture();
    const service = createTestService(test);
    const identity = service.bindCurrent('worker');
    test.setSnapshot({
      server: {
        serverId: 'server-a',
        socketPath: '/tmp/tmt-a',
        serverPid: 10,
        serverStartTime: 'one',
      },
      panes: [{ ...test.pane, panePid: 9876 }],
    });
    expect(service.activeIdentities()).toEqual([]);
    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.listIdentities()).toMatchObject([
      { id: identity.id, canonicalName: 'worker' },
    ]);
    expect(repository.findBindings()).toEqual([]);
    repository.close();
  });

  it('does not accept a binding from a different server instance with the same pane ID', () => {
    const test = fixture();
    const service = createTestService(test);
    const identity = service.bindCurrent('server-bound');
    test.setSnapshot({
      server: {
        serverId: 'server-b',
        socketPath: '/tmp/tmt-b',
        serverPid: 11,
        serverStartTime: 'two',
      },
      panes: [
        {
          ...test.pane,
          metadata: {
            version: 1,
            globalIdentity: {
              ...(test.pane.metadata as NonNullable<PaneInfo['metadata']>).globalIdentity!,
            },
          },
        },
      ],
    });
    expect(service.activeIdentities()).toEqual([]);
    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.listIdentities()).toMatchObject([{ id: identity.id }]);
    expect(repository.findBindings()).toHaveLength(1);
    expect(repository.findBindings()[0]).toMatchObject({
      id: expect.any(String),
      identityId: identity.id,
      socketPath: '/tmp/tmt-a',
    });
    repository.close();
  });

  it('does not accept a binding when the tmux socket changes', () => {
    const test = fixture();
    const service = createTestService(test);
    service.bindCurrent('socket-bound');
    test.setSnapshot({
      server: {
        serverId: 'server-a',
        socketPath: '/tmp/tmt-other-socket',
        serverPid: 10,
        serverStartTime: 'one',
      },
      panes: [{ ...test.pane }],
    });
    expect(service.activeIdentities()).toEqual([]);
  });

  it.each([
    ['missing pane', (snapshot: TmuxEndpointSnapshot) => ({ ...snapshot, panes: [] })],
    [
      'different server ID',
      (snapshot: TmuxEndpointSnapshot) => ({
        ...snapshot,
        server: { ...snapshot.server, serverId: 'server-restarted' },
      }),
    ],
    [
      'different server PID',
      (snapshot: TmuxEndpointSnapshot) => ({
        ...snapshot,
        server: { ...snapshot.server, serverPid: snapshot.server.serverPid + 1 },
      }),
    ],
    [
      'different server start time',
      (snapshot: TmuxEndpointSnapshot) => ({
        ...snapshot,
        server: { ...snapshot.server, serverStartTime: 'server-restarted' },
      }),
    ],
    [
      'different pane PID',
      (snapshot: TmuxEndpointSnapshot) => ({
        ...snapshot,
        panes: snapshot.panes.map((pane) =>
          pane.id === '%1' ? { ...pane, panePid: (pane.panePid ?? 0) + 1 } : pane
        ),
      }),
    ],
    [
      'missing durable metadata',
      (snapshot: TmuxEndpointSnapshot) => ({
        ...snapshot,
        panes: snapshot.panes.map((pane) =>
          pane.id === '%1' ? { ...pane, metadata: undefined } : pane
        ),
      }),
    ],
    [
      'mismatched durable metadata',
      (snapshot: TmuxEndpointSnapshot) => ({
        ...snapshot,
        panes: snapshot.panes.map((pane) =>
          pane.id === '%1' && pane.metadata?.globalIdentity
            ? {
                ...pane,
                metadata: {
                  ...pane.metadata,
                  globalIdentity: { ...pane.metadata.globalIdentity, bindingId: 'other-binding' },
                },
              }
            : pane
        ),
      }),
    ],
  ] as const)('reconciliation removes a binding with %s evidence', (_label, mutate) => {
    const test = fixture();
    const service = createTestService(test);
    const identity = service.bindCurrent('evidence-check');
    const profileRepository = openIdentityRepository(test.paths.databaseFile);
    repositories.push(profileRepository);
    profileRepository.setRole(identity.id, 'Retain this profile.');
    test.setSnapshot(mutate(test.tmux.getEndpointSnapshot!()));

    service.reconcile();

    const repository = openIdentityRepository(test.paths.databaseFile);
    repositories.push(repository);
    expect(repository.findBindings()).toEqual([]);
    expect(repository.findByCanonicalName(identity.canonicalName)).toEqual(identity);
    expect(repository.findRole(identity.id)).toMatchObject({ content: 'Retain this profile.' });
  });

  it('retains matching evidence and refreshes its verification timestamp', () => {
    const test = fixture();
    const service = createTestService(test);
    const identity = service.bindCurrent('valid-evidence');
    const repository = openIdentityRepository(test.paths.databaseFile);
    repositories.push(repository);
    const binding = repository.findBindings()[0];
    repository.touchBinding(binding.id, 'previous-verification');

    service.reconcile();

    const retained = repository.findBindings();
    expect(retained).toHaveLength(1);
    expect(retained[0]).toEqual({ ...binding, lastVerifiedAt: expect.any(String) });
    expect(retained[0].lastVerifiedAt).not.toBe('previous-verification');
    expect(service.activeIdentities()).toMatchObject([{ identity, binding: { id: binding.id } }]);
  });

  it('mapper rejects foreign-socket evidence without pruning the foreign binding', () => {
    const test = fixture();
    const foreign = seedForeignBinding(test, 'Foreign', {
      paneId: '%1',
      panePid: test.pane.panePid,
    });
    const { identity, binding } = foreign;
    test.pane.metadata = {
      version: 1,
      globalIdentity: {
        name: identity.name,
        canonicalName: identity.canonicalName,
        identityId: identity.id,
        bindingId: binding.id,
        serverId: binding.serverId,
        panePid: binding.panePid,
      },
    };
    const service = createTestService(test);

    expect(service.activeIdentities()).toEqual([]);

    const after = openIdentityRepository(test.paths.databaseFile);
    repositories.push(after);
    expect(after.findBindings()).toContainEqual(binding);
  });

  it('preserves a binding owned by another live socket while discovering only the current server', () => {
    const test = fixture();
    const service = createTestService(test);
    service.bindCurrent('local');
    const foreign = seedForeignBinding(test);
    const probe = vi.fn<[string, number], ReturnType<NonNullable<Tmux['probeEndpoint']>>>(() => ({
      status: 'unknown',
    }));
    test.setProbe(probe);

    expect(service.activeIdentities()).toMatchObject([
      { identity: { canonicalName: 'local' }, binding: { socketPath: '/tmp/tmt-a' } },
    ]);
    expect(probe).not.toHaveBeenCalled();

    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.findBindings()).toContainEqual(foreign.binding);
    repository.close();
  });

  it.each([
    ['live', 'NAME_ALREADY_ACTIVE'],
    ['unknown', 'RECONCILIATION_FAILED'],
  ] as const)('does not steal a foreign identity when its endpoint is %s', (status, code) => {
    const test = fixture();
    addSecondPane(test);
    const service = createTestService(test);
    const foreign = seedForeignBinding(test);
    test.setProbe(() =>
      status === 'live'
        ? {
            status,
            snapshot: {
              server: {
                serverId: foreign.binding.serverId,
                socketPath: foreign.binding.socketPath,
                serverPid: foreign.binding.serverPid,
                serverStartTime: foreign.binding.serverStartTime,
              },
              panes: [
                {
                  id: foreign.binding.paneId,
                  command: 'mock-agent',
                  panePid: foreign.binding.panePid,
                  suggestedName: null,
                },
              ],
            },
          }
        : { status }
    );

    expect(() => service.bindPane('%2', foreign.identity.name)).toThrowError(
      expect.objectContaining({ code })
    );

    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.findBindings()).toContainEqual(foreign.binding);
    repository.close();
  });

  it('releases a proven-dead foreign binding for reuse without deleting its identity', () => {
    const test = fixture();
    addSecondPane(test);
    const service = createTestService(test);
    const foreign = seedForeignBinding(test);
    const profileRepository = openIdentityRepository(test.paths.databaseFile);
    profileRepository.setRole(foreign.identity.id, 'foreign profile');
    profileRepository.close();
    test.setProbe(() => ({ status: 'dead' }));

    expect(service.bindPane('%2', foreign.identity.name)).toEqual(foreign.identity);

    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.findBindings()).toHaveLength(1);
    expect(repository.findBindings()[0]).toMatchObject({
      identityId: foreign.identity.id,
      paneId: '%2',
      socketPath: '/tmp/tmt-a',
    });
    expect(repository.findByCanonicalName('foreign')).toEqual(foreign.identity);
    expect(repository.findRole(foreign.identity.id)).toMatchObject({ content: 'foreign profile' });
    repository.close();
  });

  it('releases a foreign binding when the known socket is live but its server instance is stale', () => {
    const test = fixture();
    addSecondPane(test);
    const service = createTestService(test);
    const foreign = seedForeignBinding(test);
    test.setProbe(() => ({
      status: 'live',
      snapshot: {
        server: {
          serverId: 'server-foreign-restarted',
          socketPath: foreign.binding.socketPath,
          serverPid: foreign.binding.serverPid + 1,
          serverStartTime: 'foreign-restarted',
        },
        panes: [
          {
            id: foreign.binding.paneId,
            command: 'mock-agent',
            panePid: foreign.binding.panePid,
            suggestedName: null,
          },
        ],
      },
    }));

    expect(service.bindPane('%2', foreign.identity.name)).toEqual(foreign.identity);
    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.findBindings()[0]).toMatchObject({ paneId: '%2' });
    repository.close();
  });

  it.each(['missing', 'throwing'] as const)(
    'treats a %s foreign endpoint probe as unknown and preserves the binding',
    (probeMode) => {
      const test = fixture();
      addSecondPane(test);
      const service = createTestService(test);
      const foreign = seedForeignBinding(test);
      if (probeMode === 'throwing') {
        test.setProbe(() => {
          throw new Error('probe failed');
        });
      }

      expect(() => service.bindPane('%2', foreign.identity.name)).toThrowError(
        expect.objectContaining({ code: 'RECONCILIATION_FAILED' })
      );
      const repository = openIdentityRepository(test.paths.databaseFile);
      expect(repository.findBindings()).toContainEqual(foreign.binding);
      repository.close();
    }
  );

  it('prunes stale bindings after a restart on the same socket', () => {
    const test = fixture();
    const service = createTestService(test);
    const identity = service.bindCurrent('same-socket');
    test.setSnapshot({
      server: {
        serverId: 'server-restarted',
        socketPath: '/tmp/tmt-a',
        serverPid: 11,
        serverStartTime: 'two',
      },
      panes: [test.pane],
    });

    expect(service.activeIdentities()).toEqual([]);
    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.findBindings()).toEqual([]);
    expect(repository.findByCanonicalName('same-socket')).toEqual(identity);
    repository.close();
  });

  it('does not backfill duplicate name-only v5 metadata or mutate it on repeated reads', () => {
    const test = fixture();
    addSecondPane(test);
    const second = test.tmux.getEndpointSnapshot!().panes.find((item) => item.id === '%2');
    if (!second) throw new Error('Second pane fixture is missing.');
    test.pane.metadata = {
      version: 1,
      globalIdentity: { name: 'Legacy Agent', canonicalName: 'legacy agent' },
    };
    second.metadata = {
      version: 1,
      globalIdentity: { name: 'Legacy Agent', canonicalName: 'legacy agent' },
    };
    const firstMetadata = JSON.stringify(test.pane.metadata);
    const secondMetadata = JSON.stringify(second.metadata);
    const service = createTestService(test);
    expect(service.activeIdentities()).toEqual([]);
    expect(service.activeIdentities()).toEqual([]);

    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.listIdentities()).toEqual([]);
    expect(repository.findBindings()).toEqual([]);
    repository.close();
    expect(JSON.stringify(test.pane.metadata)).toBe(firstMetadata);
    expect(JSON.stringify(second.metadata)).toBe(secondMetadata);
  });

  it.each([
    [
      'missing identity ID',
      (metadata: NonNullable<PaneInfo['metadata']>['globalIdentity']) => ({
        ...metadata,
        identityId: '',
      }),
    ],
    [
      'null name',
      (metadata: NonNullable<PaneInfo['metadata']>['globalIdentity']) => ({
        ...metadata,
        name: null,
      }),
    ],
    [
      'numeric name',
      (metadata: NonNullable<PaneInfo['metadata']>['globalIdentity']) => ({
        ...metadata,
        name: 42,
      }),
    ],
    [
      'control character name',
      (metadata: NonNullable<PaneInfo['metadata']>['globalIdentity']) => ({
        ...metadata,
        name: 'Primary\u0001',
      }),
    ],
    [
      'pane-shaped name',
      (metadata: NonNullable<PaneInfo['metadata']>['globalIdentity']) => ({
        ...metadata,
        name: '%1',
      }),
    ],
    [
      'wrong pane PID type',
      (metadata: NonNullable<PaneInfo['metadata']>['globalIdentity']) => ({
        ...metadata,
        panePid: '1234',
      }),
    ],
    [
      'non-positive pane PID',
      (metadata: NonNullable<PaneInfo['metadata']>['globalIdentity']) => ({
        ...metadata,
        panePid: 0,
      }),
    ],
    [
      'unsafe pane PID',
      (metadata: NonNullable<PaneInfo['metadata']>['globalIdentity']) => ({
        ...metadata,
        panePid: Number.MAX_SAFE_INTEGER + 1,
      }),
    ],
    [
      'mismatched canonical name',
      (metadata: NonNullable<PaneInfo['metadata']>['globalIdentity']) => ({
        ...metadata,
        canonicalName: 'other',
      }),
    ],
    ['null global marker', () => null],
  ] as const)('rejects %s durable metadata without affecting a healthy peer', (_label, mutate) => {
    const test = fixture();
    addSecondPane(test);
    const service = createTestService(test);
    const primary = service.bindCurrent('Primary');
    service.bindPane('%2', 'Peer');

    const roleRepository = openIdentityRepository(test.paths.databaseFile);
    roleRepository.setRole(primary.id, 'Preserve this profile.');
    roleRepository.close();

    const primaryMetadata = test.pane.metadata;
    if (!primaryMetadata?.globalIdentity) throw new Error('Primary metadata is missing.');
    test.pane.metadata = {
      ...primaryMetadata,
      globalIdentity: mutate(primaryMetadata.globalIdentity) as NonNullable<
        PaneInfo['metadata']
      >['globalIdentity'],
    };
    const unchangedMetadata = JSON.stringify(test.pane.metadata);

    expect(service.activeIdentities().map(({ identity }) => identity.name)).toEqual(['Peer']);
    expect(service.activeIdentities().map(({ identity }) => identity.name)).toEqual(['Peer']);
    expect(JSON.stringify(test.pane.metadata)).toBe(unchangedMetadata);

    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.findBindings()).toMatchObject([{ paneId: '%2' }]);
    expect(repository.listIdentities()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: primary.id, canonicalName: 'primary' }),
        expect.objectContaining({ canonicalName: 'peer' }),
      ])
    );
    expect(repository.findRole(primary.id)).toMatchObject({ content: 'Preserve this profile.' });
    repository.close();
  });

  it('rejects an unsupported durable metadata version while preserving identity and profile', () => {
    const test = fixture();
    addSecondPane(test);
    const service = createTestService(test);
    const primary = service.bindCurrent('Versioned');
    service.bindPane('%2', 'Peer');

    const roleRepository = openIdentityRepository(test.paths.databaseFile);
    roleRepository.setRole(primary.id, 'Preserve this profile.');
    roleRepository.close();

    const primaryMetadata = test.pane.metadata;
    if (!primaryMetadata) throw new Error('Primary metadata is missing.');
    test.pane.metadata = { ...primaryMetadata, version: 2 } as unknown as PaneInfo['metadata'];
    const unchangedMetadata = JSON.stringify(test.pane.metadata);

    expect(service.activeIdentities().map(({ identity }) => identity.name)).toEqual(['Peer']);
    expect(service.activeIdentities().map(({ identity }) => identity.name)).toEqual(['Peer']);
    expect(JSON.stringify(test.pane.metadata)).toBe(unchangedMetadata);

    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.findBindings()).toMatchObject([{ paneId: '%2' }]);
    expect(repository.findByCanonicalName('versioned')).toEqual(primary);
    expect(repository.findRole(primary.id)).toMatchObject({ content: 'Preserve this profile.' });
    repository.close();
  });

  it('removes a database binding when the tmux metadata write fails', () => {
    const test = fixture();
    test.tmux.setDurableIdentity = () => {
      throw new Error('simulated tmux write failure');
    };
    const service = createTestService(test);
    expect(() => service.bindCurrent('partial')).toThrow('Could not write pane metadata.');
    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.listIdentities()).toMatchObject([{ canonicalName: 'partial' }]);
    expect(repository.findBindings()).toEqual([]);
    repository.close();
  });

  it.each(['read', 'write'] as const)(
    'preserves the %s stage and safe failure classification without committing a binding',
    (stage) => {
      const test = fixture();
      const cause = Object.assign(new Error('private subprocess arguments'), { code: 'EPERM' });
      test.tmux.setDurableIdentity = () => {
        throw new PaneMetadataError(stage, { cause });
      };
      const service = createTestService(test);
      expect(() => service.bindCurrent('Stage failure')).toThrow(
        `Could not ${stage} pane metadata (EPERM).`
      );
      const repository = openIdentityRepository(test.paths.databaseFile);
      expect(repository.findBindings()).toEqual([]);
      expect(repository.findByCanonicalName('stage failure')).toBeDefined();
      repository.close();
    }
  );

  it('rolls back when metadata publication verifies a missing marker while retaining identity data', () => {
    const test = fixture();
    const seed = openIdentityRepository(test.paths.databaseFile);
    const identity = seed.createIdentity('Verify failure', 'verify failure');
    seed.setRole(identity.id, 'Keep this profile.');
    seed.close();
    test.tmux.setDurableIdentity = () => {};
    const service = createTestService(test);

    expect(() => service.bindCurrent(identity.name)).toThrow(
      'Pane metadata verification failed: pane/server identity does not match.'
    );
    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.findBindings()).toEqual([]);
    expect(repository.findByCanonicalName(identity.canonicalName)).toEqual(identity);
    expect(repository.findRole(identity.id)).toMatchObject({ content: 'Keep this profile.' });
    repository.close();
  });

  it('rejects successful metadata when the binding row is missing at verification', () => {
    const test = fixture();
    const base = openIdentityRepository(test.paths.databaseFile);
    const identity = base.createIdentity('Missing row', 'missing row');
    base.setRole(identity.id, 'Keep this profile.');
    const repository = {
      ...base,
      findBindingByPane: () => undefined,
    };
    const service = createIdentityService({ ...test, repository });

    expect(() => service.bindCurrent(identity.name)).toThrowError(
      expect.objectContaining({ code: 'RECONCILIATION_FAILED' })
    );
    expect(test.pane.metadata?.globalIdentity?.identityId).toBe(identity.id);
    expect(base.findBindings()).toEqual([]);
    expect(base.findByCanonicalName(identity.canonicalName)).toEqual(identity);
    expect(base.findRole(identity.id)).toMatchObject({ content: 'Keep this profile.' });

    base.close();
  });

  it('rolls back when the publication deadline expires after the final tmux call', () => {
    const test = fixture();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const setDurableIdentity = test.tmux.setDurableIdentity!;
    test.tmux.setDurableIdentity = (...args) => {
      setDurableIdentity(...args);
      // The final verification still observes the just-written metadata, but
      // the shared boundary must reject success before committing the row.
      clock.mockReturnValue(4_001);
    };
    const service = createTestService(test);

    try {
      expect(() => service.bindCurrent('deadline-race')).toThrowError(
        expect.objectContaining({ code: 'RECONCILIATION_FAILED' })
      );
      const repository = openIdentityRepository(test.paths.databaseFile);
      expect(repository.findBindings()).toEqual([]);
      expect(repository.findByCanonicalName('deadline-race')).toBeDefined();
      repository.close();
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps a valid binding when a later strict snapshot read fails', () => {
    const test = fixture();
    const service = createTestService(test);
    const identity = service.bindCurrent('Persisted');
    const before = openIdentityRepository(test.paths.databaseFile);
    before.setRole(identity.id, 'Keep this profile.');
    const binding = before.findBindings()[0];
    before.close();
    test.tmux.getEndpointSnapshot = () => {
      throw new Error('metadata fallback failed');
    };

    expect(() => service.activeIdentities()).toThrowError(
      expect.objectContaining({ code: 'RECONCILIATION_FAILED' })
    );
    const after = openIdentityRepository(test.paths.databaseFile);
    expect(after.findBindingByPane('%1', 'server-a')).toMatchObject({ id: binding?.id });
    expect(after.findRole(identity.id)).toMatchObject({ content: 'Keep this profile.' });
    after.close();
  });

  it('maps writer contention to a reconciliation failure', () => {
    const test = fixture();
    const base = openIdentityRepository(test.paths.databaseFile);
    const repository = {
      ...base,
      withImmediateTransaction<T>(): T {
        throw new Error('database is locked');
      },
    };
    const service = createIdentityService({ ...test, repository });

    expect(() => service.activeIdentities()).toThrowError(
      expect.objectContaining({ code: 'RECONCILIATION_FAILED' })
    );
    base.close();
  });

  it('heals a metadata-only unbind interruption on the next reconciliation', () => {
    const test = fixture();
    const base = openIdentityRepository(test.paths.databaseFile);
    let failRemoval = true;
    const repository = {
      ...base,
      removeBinding(id: string): void {
        if (failRemoval) {
          failRemoval = false;
          throw new Error('simulated SQLite interruption');
        }
        base.removeBinding(id);
      },
    };
    const service = createIdentityService({ ...test, repository });
    service.bindCurrent('interrupted');
    expect(() => service.unbindCurrent()).toThrow('Could not remove tmux binding.');
    expect(service.activeIdentities()).toEqual([]);
    expect(base.findBindings()).toEqual([]);
    base.close();
  });

  it('rejects a second identity on one live pane and preserves the first binding', () => {
    const test = fixture();
    const base = openIdentityRepository(test.paths.databaseFile);
    const observer = openIdentityRepository(test.paths.databaseFile);
    let observedSecondCommit = false;
    const repository = {
      ...base,
      withImmediateTransaction<T>(operation: () => T): T {
        const result = base.withImmediateTransaction(operation);
        if (!observedSecondCommit && observer.findByCanonicalName('second')) {
          // The second identity transaction has committed before the
          // separate binding publication transaction starts.
          expect(observer.findByCanonicalName('second')).toEqual(
            expect.objectContaining({ canonicalName: 'second' })
          );
          observedSecondCommit = true;
        }
        return result;
      },
    };
    const service = createIdentityService({ tmux: test.tmux, repository });
    try {
      service.bindCurrent('first');
      expect(() => service.bindCurrent('second')).toThrowError(
        new IdentityServiceError('PANE_ALREADY_BOUND', 'Pane is already bound to another name.')
      );
      expect(observedSecondCommit).toBe(true);
      const identities = observer.listIdentities();
      expect(identities.map(({ canonicalName }) => canonicalName)).toEqual(['first', 'second']);
      expect(observer.findBindings()).toMatchObject([{ identityId: identities[0]?.id }]);
      expect(service.currentIdentity()?.identity.name).toBe('first');
      const second = identities.find(({ canonicalName }) => canonicalName === 'second');
      expect(second).toBeDefined();
      observer.setRole(second!.id, 'Retain this role.');
      observer.setPreamble(second!.id, 'Retain this preamble.');
      expect(observer.findRole(second!.id)?.content).toBe('Retain this role.');
      expect(observer.findPreamble(second!.id)?.content).toBe('Retain this preamble.');
      addSecondPane(test);
      expect(service.bindPane('%2', 'SECOND')).toEqual(second);
      expect(observer.findRole(second!.id)?.content).toBe('Retain this role.');
      expect(observer.findPreamble(second!.id)?.content).toBe('Retain this preamble.');
    } finally {
      base.close();
      observer.close();
    }
  });

  it('rejects a live identity on another pane', () => {
    const test = fixture();
    const secondPane = { ...test.pane, id: '%2', panePid: 5678 };
    test.setSnapshot({ ...test.tmux.getEndpointSnapshot!(), panes: [test.pane, secondPane] });
    (test.tmux.resolvePaneTarget as any) = (target: string) =>
      target === '%1' || target === '%2' ? target : null;
    const service = createTestService(test);
    service.bindPane('%1', 'shared');
    expect(() => service.bindPane('%2', 'shared')).toThrow(
      'Name is already active on another pane.'
    );
  });

  it('makes explicit unbind idempotent while preserving the durable row', () => {
    const test = fixture();
    const service = createTestService(test);
    const identity = service.bindCurrent('keep-me');
    expect(service.unbindCurrent()).toMatchObject({ id: identity.id });
    expect(service.unbindCurrent()).toBeUndefined();
    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.listIdentities()).toMatchObject([{ id: identity.id }]);
    expect(repository.findBindings()).toEqual([]);
    repository.close();
  });

  it('resolves only currently active names and direct pane targets', () => {
    const test = fixture();
    const service = createTestService(test);
    service.bindCurrent('resolvable');
    expect(service.resolveActive('resolvable')).toMatchObject({ identity: { name: 'resolvable' } });
    expect(service.resolveActive('%1')).toMatchObject({ binding: { paneId: '%1' } });
    expect(service.resolveActive('missing')).toBeUndefined();
    expect(() => service.bindPane('%99', 'missing-pane')).toThrow(
      "Pane target '%99' was not found."
    );
  });
});
