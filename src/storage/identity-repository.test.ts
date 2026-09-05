import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { DurableIdentity } from '../domain/identity.js';
import type { PreambleProfile } from '../domain/preamble.js';
import { openIdentityRepository } from './identity-repository.js';
import { CURRENT_MIGRATIONS } from './migrations.js';
import { openStorageWithMigrations } from './sqlite-adapter.js';

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

  it('rolls back a grouped binding publication when metadata work fails', () => {
    const file = databasePath();
    const repository = openIdentityRepository(file);
    const observer = openIdentityRepository(file);
    const identity = repository.createIdentity('Rollback', 'rollback');
    const now = new Date().toISOString();

    expect(() =>
      repository.withImmediateTransaction(() => {
        repository.createBinding({
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
        expect(observer.findBindings()).toEqual([]);
        throw new Error('metadata publication failed');
      })
    ).toThrow('metadata publication failed');
    expect(repository.findBindings()).toEqual([]);
    expect(observer.findBindings()).toEqual([]);
    expect(repository.findByCanonicalName('rollback')).toEqual(identity);
    repository.close();
    observer.close();
  });

  it('rejects use after close', () => {
    const repository = openIdentityRepository(databasePath());
    repository.close();
    expect(() => repository.listIdentities()).toThrow('Identity repository is closed.');
    repository.close();
  });

  it('stores, replaces, clears, and retains an unbound identity with a role', () => {
    const repository = openIdentityRepository(databasePath());
    const identity = repository.createIdentity('RoleOwner', 'roleowner');
    expect(repository.findRole(identity.id)).toBeUndefined();
    const first = repository.setRole(identity.id, 'first');
    expect(first).toMatchObject({ content: 'first', updatedAt: expect.any(String) });
    expect(repository.findRole(identity.id)).toEqual(first);
    const second = repository.setRole(identity.id, 'second');
    expect(second.content).toBe('second');
    expect(repository.findRole(identity.id)).toEqual(second);
    expect(repository.findByCanonicalName('roleowner')).toEqual(identity);
    expect(repository.clearRole(identity.id)).toBeNull();
    expect(repository.findRole(identity.id)).toBeUndefined();
    expect(repository.findByCanonicalName('roleowner')).toEqual(identity);
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

  it('stores, lists, replaces, clears, and retains preambles on unbound identities', () => {
    const repository = openIdentityRepository(databasePath());
    try {
      const first = repository.createIdentity('Zulu', 'zulu');
      const second = repository.createIdentity('Alpha', 'alpha');

      expect(repository.findPreamble(first.id)).toBeUndefined();
      const initial = repository.setPreamble(first.id, 'first');
      expect(initial).toMatchObject({ content: 'first', updatedAt: expect.any(String) });
      const replacement = repository.setPreamble(first.id, 'replacement');
      expect(repository.findPreamble(first.id)).toEqual(replacement);
      repository.setPreamble(second.id, 'second');

      expect(repository.listPreambles()).toEqual([
        { identity: second, preamble: { content: 'second', updatedAt: expect.any(String) } },
        { identity: first, preamble: replacement },
      ]);
      expect(repository.clearPreamble(first.id)).toBe(true);
      expect(repository.clearPreamble(first.id)).toBe(false);
      expect(repository.findPreamble(first.id)).toBeUndefined();
      expect(() => repository.setPreamble('missing-id', 'orphan')).toThrow();

      expect(repository.findByCanonicalName('alpha')).toEqual(second);
      repository.clearPreamble(second.id);
      expect(repository.findByCanonicalName('alpha')).toEqual(second);
    } finally {
      repository.close();
    }
  });

  it('upgrades a v2 database and retains identities, roles, and preambles across reopen', () => {
    const file = databasePath();
    const location = { globalDir: path.dirname(file), databaseFile: file };
    const storage = openStorageWithMigrations(location, CURRENT_MIGRATIONS.slice(0, 2));
    storage.close();

    const database = new Database(file);
    try {
      database
        .prepare(
          'INSERT INTO identities (id, name, canonical_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run('identity-1', 'Migrated', 'migrated', 'created', 'updated');
      database
        .prepare('INSERT INTO role_profiles (identity_id, content, updated_at) VALUES (?, ?, ?)')
        .run('identity-1', 'role survives', 'role-updated');
    } finally {
      database.close();
    }

    const repository = openIdentityRepository(file);
    let identity: DurableIdentity | undefined;
    let preamble!: PreambleProfile;
    try {
      identity = repository.findByCanonicalName('migrated');
      expect(identity).toEqual({
        id: 'identity-1',
        name: 'Migrated',
        canonicalName: 'migrated',
        createdAt: 'created',
        updatedAt: 'updated',
      });
      expect(repository.findRole('identity-1')).toEqual({
        content: 'role survives',
        updatedAt: 'role-updated',
      });
      preamble = repository.setPreamble('identity-1', 'preamble survives');
    } finally {
      repository.close();
    }

    const reopened = openIdentityRepository(file);
    try {
      expect(reopened.findPreamble('identity-1')).toEqual(preamble);
      expect(reopened.listPreambles()).toEqual([{ identity, preamble }]);
    } finally {
      reopened.close();
    }

    const verification = new Database(file, { readonly: true });
    try {
      expect(verification.prepare('SELECT MAX(version) AS version FROM _migrations').get()).toEqual(
        {
          version: 3,
        }
      );
      expect(
        verification
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'identity_preambles'"
          )
          .get()
      ).toEqual({ name: 'identity_preambles' });
      expect(verification.prepare('PRAGMA foreign_key_list(identity_preambles)').all()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ table: 'identities', from: 'identity_id', to: 'id' }),
        ])
      );
    } finally {
      verification.close();
    }
  });
});
