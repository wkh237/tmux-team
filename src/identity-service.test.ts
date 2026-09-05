import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIdentityService, identityAwareTmux } from './identity-service.js';
import { IdentityServiceError } from './identity-service.js';
import { openIdentityRepository } from './storage/identity-repository.js';
import type { DurableIdentity, TmuxBinding } from './domain/identity.js';
import type { PaneInfo, Paths, Tmux, TmuxEndpointSnapshot } from './types.js';

const directories: string[] = [];

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

function seedForeignBinding(test: ReturnType<typeof fixture>, name = 'Foreign') {
  const repository = openIdentityRepository(test.paths.databaseFile);
  const identity = repository.createIdentity(name, name.toLowerCase());
  const binding = repository.createBinding({
    identityId: identity.id,
    transport: 'tmux',
    paneId: '%foreign',
    serverId: 'server-foreign',
    socketPath: '/tmp/tmt-foreign',
    serverPid: 999999,
    serverStartTime: 'foreign-start',
    panePid: 8888,
    boundAt: 'foreign-bound',
    lastVerifiedAt: 'foreign-verified',
  });
  repository.close();
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
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('durable identity service', () => {
  it('rejects invalid names before creating durable state', () => {
    const test = fixture();
    const service = createIdentityService(test);

    expect(() => service.bindCurrent('%12')).toThrowError(
      new IdentityServiceError('INVALID_NAME', 'Identity name must not look like a pane target.')
    );
    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.listIdentities()).toEqual([]);
    expect(repository.findBindings()).toEqual([]);
    repository.close();
    service.close();
  });

  it('requires pane process evidence before creating durable state', () => {
    const test = fixture();
    test.setSnapshot({
      ...test.tmux.getEndpointSnapshot!(),
      panes: [{ ...test.pane, panePid: undefined }],
    });
    const service = createIdentityService(test);

    expect(() => service.bindCurrent('missing-evidence')).toThrow("Pane '%1' was not found.");
    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.listIdentities()).toEqual([]);
    repository.close();
    service.close();
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

    service.close();
    repository.close();
  });

  it('uses verified current-pane evidence without resolving an ambient target', () => {
    const test = fixture();
    const resolvePaneTarget = vi.spyOn(test.tmux, 'resolvePaneTarget');
    const service = createIdentityService(test);

    const identity = service.bindCurrent('direct-current');
    expect(service.currentIdentity()).toMatchObject({ identity: { id: identity.id } });
    expect(service.unbindCurrent()).toMatchObject({ id: identity.id });
    expect(resolvePaneTarget).not.toHaveBeenCalled();

    service.close();
  });

  it('creates one durable identity and a verified transient binding', () => {
    const test = fixture();
    const service = createIdentityService(test);
    const first = service.bindCurrent('  Ｇｅｍｉｎｉ  ');
    const second = service.bindCurrent('gemini');
    expect(second.id).toBe(first.id);
    expect(service.currentIdentity()).toMatchObject({
      identity: { id: first.id, name: 'Ｇｅｍｉｎｉ' },
    });
    expect(identityAwareTmux(test.tmux, service).listGlobalIdentities()).toEqual([
      { name: 'Ｇｅｍｉｎｉ', canonicalName: 'gemini', paneId: '%1' },
    ]);
    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.listIdentities()).toHaveLength(1);
    expect(repository.findBindings()).toHaveLength(1);
    repository.close();
    service.close();
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

    binder.close();
    reconciler.close();
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

    service.close();
    base.close();
  });

  it('fails closed when the tmux adapter cannot provide endpoint evidence', () => {
    const test = fixture();
    const service = createIdentityService({
      ...test,
      tmux: { ...test.tmux, getEndpointSnapshot: undefined },
    });
    expect(() => service.reconcile()).toThrow('coherent endpoint snapshot');
    expect(identityAwareTmux(test.tmux)).toBe(test.tmux);
    service.close();
  });

  it('converts endpoint inspection failures into a structured service error', () => {
    const test = fixture();
    test.tmux.getEndpointSnapshot = () => {
      throw new Error('tmux unavailable');
    };
    const service = createIdentityService(test);
    expect(() => service.activeIdentities()).toThrow('Could not inspect the tmux endpoint.');
    service.close();
  });

  it('prunes a changed pane process while preserving the durable identity', () => {
    const test = fixture();
    const service = createIdentityService(test);
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
    service.close();
  });

  it('does not accept a binding from a different server instance with the same pane ID', () => {
    const test = fixture();
    const service = createIdentityService(test);
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
    service.close();
  });

  it('does not accept a binding when the tmux socket changes', () => {
    const test = fixture();
    const service = createIdentityService(test);
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
    service.close();
  });

  it('preserves a binding owned by another live socket while discovering only the current server', () => {
    const test = fixture();
    const service = createIdentityService(test);
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
    service.close();
  });

  it.each([
    ['live', 'NAME_ALREADY_ACTIVE'],
    ['unknown', 'RECONCILIATION_FAILED'],
  ] as const)('does not steal a foreign identity when its endpoint is %s', (status, code) => {
    const test = fixture();
    addSecondPane(test);
    const service = createIdentityService(test);
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
    service.close();
  });

  it('releases a proven-dead foreign binding for reuse without deleting its identity', () => {
    const test = fixture();
    addSecondPane(test);
    const service = createIdentityService(test);
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
    service.close();
  });

  it('releases a foreign binding when the known socket is live but its server instance is stale', () => {
    const test = fixture();
    addSecondPane(test);
    const service = createIdentityService(test);
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
    service.close();
  });

  it.each(['missing', 'throwing'] as const)(
    'treats a %s foreign endpoint probe as unknown and preserves the binding',
    (probeMode) => {
      const test = fixture();
      addSecondPane(test);
      const service = createIdentityService(test);
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
      service.close();
    }
  );

  it('prunes stale bindings after a restart on the same socket', () => {
    const test = fixture();
    const service = createIdentityService(test);
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
    service.close();
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
    const service = createIdentityService(test);
    expect(service.activeIdentities()).toEqual([]);
    expect(service.activeIdentities()).toEqual([]);

    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.listIdentities()).toEqual([]);
    expect(repository.findBindings()).toEqual([]);
    repository.close();
    expect(JSON.stringify(test.pane.metadata)).toBe(firstMetadata);
    expect(JSON.stringify(second.metadata)).toBe(secondMetadata);
    service.close();
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
    const service = createIdentityService(test);
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
    service.close();
  });

  it('rejects an unsupported durable metadata version while preserving identity and profile', () => {
    const test = fixture();
    addSecondPane(test);
    const service = createIdentityService(test);
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
    service.close();
  });

  it('removes a database binding when the tmux metadata write fails', () => {
    const test = fixture();
    test.tmux.setDurableIdentity = () => {
      throw new Error('simulated tmux write failure');
    };
    const service = createIdentityService(test);
    expect(() => service.bindCurrent('partial')).toThrow('Could not write pane metadata.');
    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.listIdentities()).toMatchObject([{ canonicalName: 'partial' }]);
    expect(repository.findBindings()).toEqual([]);
    repository.close();
    service.close();
  });

  it('rolls back when metadata publication verifies a missing marker while retaining identity data', () => {
    const test = fixture();
    const seed = openIdentityRepository(test.paths.databaseFile);
    const identity = seed.createIdentity('Verify failure', 'verify failure');
    seed.setRole(identity.id, 'Keep this profile.');
    seed.close();
    test.tmux.setDurableIdentity = () => {};
    const service = createIdentityService(test);

    expect(() => service.bindCurrent(identity.name)).toThrow('Could not write pane metadata.');
    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.findBindings()).toEqual([]);
    expect(repository.findByCanonicalName(identity.canonicalName)).toEqual(identity);
    expect(repository.findRole(identity.id)).toMatchObject({ content: 'Keep this profile.' });
    repository.close();
    service.close();
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

    service.close();
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
    const service = createIdentityService(test);

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
      service.close();
    }
  });

  it('keeps a valid binding when a later strict snapshot read fails', () => {
    const test = fixture();
    const service = createIdentityService(test);
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
    service.close();
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
    service.close();
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
    service.close();
    base.close();
  });

  it('rejects a second identity on one live pane and preserves the first binding', () => {
    const test = fixture();
    const service = createIdentityService(test);
    service.bindCurrent('first');
    expect(() => service.bindCurrent('second')).toThrowError(
      new IdentityServiceError('PANE_ALREADY_BOUND', 'Pane is already bound to another name.')
    );
    expect(service.currentIdentity()?.identity.name).toBe('first');
    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.listIdentities()).toMatchObject([{ canonicalName: 'first' }]);
    repository.close();
    service.close();
  });

  it('rejects a live identity on another pane', () => {
    const test = fixture();
    const secondPane = { ...test.pane, id: '%2', panePid: 5678 };
    test.setSnapshot({ ...test.tmux.getEndpointSnapshot!(), panes: [test.pane, secondPane] });
    (test.tmux.resolvePaneTarget as any) = (target: string) =>
      target === '%1' || target === '%2' ? target : null;
    const service = createIdentityService(test);
    service.bindPane('%1', 'shared');
    expect(() => service.bindPane('%2', 'shared')).toThrow(
      'Name is already active on another pane.'
    );
    service.close();
  });

  it('makes explicit unbind idempotent while preserving the durable row', () => {
    const test = fixture();
    const service = createIdentityService(test);
    const identity = service.bindCurrent('keep-me');
    expect(service.unbindCurrent()).toMatchObject({ id: identity.id });
    expect(service.unbindCurrent()).toBeUndefined();
    const repository = openIdentityRepository(test.paths.databaseFile);
    expect(repository.listIdentities()).toMatchObject([{ id: identity.id }]);
    expect(repository.findBindings()).toEqual([]);
    repository.close();
    service.close();
  });

  it('resolves only currently active names and direct pane targets', () => {
    const test = fixture();
    const service = createIdentityService(test);
    service.bindCurrent('resolvable');
    expect(service.resolveActive('resolvable')).toMatchObject({ identity: { name: 'resolvable' } });
    expect(service.resolveActive('%1')).toMatchObject({ binding: { paneId: '%1' } });
    expect(service.resolveActive('missing')).toBeUndefined();
    expect(() => service.bindPane('%99', 'missing-pane')).toThrow(
      "Pane target '%99' was not found."
    );
    service.close();
  });
});
