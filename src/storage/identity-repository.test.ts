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
});
