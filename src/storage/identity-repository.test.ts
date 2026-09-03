import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openIdentityRepository } from './identity-repository.js';

const directories: string[] = [];

function databasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tmt-repository-'));
  directories.push(directory);
  return path.join(directory, 'tmux-team.db');
}

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('identity repository contract', () => {
  it('round-trips identities and bindings through the narrow repository API', () => {
    const repository = openIdentityRepository(databasePath());
    const now = new Date().toISOString();
    const identity = repository.createIdentity('Alice', 'alice');
    const binding = repository.createBinding({
      identityId: identity.id,
      transport: 'tmux',
      paneId: '%3',
      serverId: 'server',
      socketPath: '/tmp/server',
      serverPid: 42,
      serverStartTime: now,
      panePid: 99,
      boundAt: now,
      lastVerifiedAt: now,
    });
    expect(repository.findByCanonicalName('alice')).toEqual(identity);
    expect(repository.findByCanonicalName('missing')).toBeUndefined();
    expect(repository.findBindingByPane('%3', 'server')).toEqual(binding);
    expect(repository.findBindingByPane('%4', 'server')).toBeUndefined();
    repository.touchBinding(binding.id, 'later');
    expect(repository.findBindings()[0]?.lastVerifiedAt).toBe('later');
    repository.removeBinding(binding.id);
    expect(repository.findBindings()).toEqual([]);
    expect(repository.listIdentities()).toEqual([identity]);
    repository.close();
  });

  it('rejects duplicate canonical identities and identity bindings atomically', () => {
    const repository = openIdentityRepository(databasePath());
    const identity = repository.createIdentity('Alice', 'alice');
    expect(() => repository.createIdentity('ALICE', 'alice')).toThrow();
    const value = {
      identityId: identity.id,
      transport: 'tmux' as const,
      paneId: '%3',
      serverId: 'server',
      socketPath: '/tmp/server',
      serverPid: 42,
      serverStartTime: 'start',
      panePid: 99,
      boundAt: 'now',
      lastVerifiedAt: 'now',
    };
    repository.createBinding(value);
    expect(() => repository.createBinding(value)).toThrow();
    expect(repository.findBindings()).toHaveLength(1);
    repository.close();
  });

  it('rejects use after close', () => {
    const repository = openIdentityRepository(databasePath());
    repository.close();
    expect(() => repository.listIdentities()).toThrow('Identity repository is closed.');
    repository.close();
  });

  it('stores, replaces, clears, and protects an unbound identity with a role', () => {
    const repository = openIdentityRepository(databasePath());
    const identity = repository.createIdentity('RoleOwner', 'roleowner');
    expect(repository.findRole(identity.id)).toBeUndefined();
    const first = repository.setRole(identity.id, 'first');
    expect(first).toMatchObject({ content: 'first', updatedAt: expect.any(String) });
    expect(repository.findRole(identity.id)).toEqual(first);
    const second = repository.setRole(identity.id, 'second');
    expect(second.content).toBe('second');
    expect(repository.findRole(identity.id)).toEqual(second);
    repository.removeIdentityIfUnbound(identity.id);
    expect(repository.findByCanonicalName('roleowner')).toEqual(identity);
    expect(repository.clearRole(identity.id)).toBeNull();
    expect(repository.findRole(identity.id)).toBeUndefined();
    repository.removeIdentityIfUnbound(identity.id);
    expect(repository.findByCanonicalName('roleowner')).toBeUndefined();
    repository.close();
  });

  it('persists profiles across reopen and rejects orphan writes without affecting another identity', () => {
    const file = databasePath();
    const repository = openIdentityRepository(file);
    const identity = repository.createIdentity('Owner', 'owner');
    const profile = repository.setRole(identity.id, 'durable profile');
    expect(() => repository.setRole('missing-id', 'orphan')).toThrow();
    expect(repository.findRole(identity.id)).toEqual(profile);
    expect(repository.findRole('missing-id')).toBeUndefined();
    repository.close();
    const reopened = openIdentityRepository(file);
    try {
      expect(reopened.findRole(identity.id)).toEqual(profile);
      reopened.clearRole(identity.id);
      reopened.clearRole(identity.id);
      expect(reopened.findRole(identity.id)).toBeUndefined();
      expect(reopened.findByCanonicalName('owner')).toEqual(identity);
    } finally {
      reopened.close();
    }
  });
});
