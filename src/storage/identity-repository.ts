import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { DurableIdentity, TmuxBinding } from '../domain/identity.js';
import type { PreambleRepository } from '../preamble-service.js';
import type { IdentityRepository as IdentityBindingRepository } from '../identity-service.js';
import type { RoleRepository } from '../role-service.js';
import type { RequestRepository } from '../request-service.js';
import { openStorageWithDatabase } from './sqlite-adapter.js';
import { createRequestRepository } from './request-repository.js';
import { StorageError } from './errors.js';
import type { StorageLocation } from './ports.js';

/** Concrete adapter composed from the application-owned repository ports. */
export type IdentityRepository = IdentityBindingRepository &
  RoleRepository &
  PreambleRepository &
  RequestRepository & {
    close(): void;
  };

type IdentityRow = {
  id: string;
  name: string;
  canonical_name: string;
  created_at: string;
  updated_at: string;
};

type BindingRow = {
  id: string;
  identity_id: string;
  transport: 'tmux';
  pane_id: string;
  server_id: string;
  socket_path: string;
  server_pid: number;
  server_start_time: string;
  pane_pid: number;
  bound_at: string;
  last_verified_at: string;
};

type RoleRow = { content: string; updated_at: string };
type PreambleRow = { content: string; updated_at: string };
type PreambleResultRow = IdentityRow & {
  content: string;
  preamble_updated_at: string;
};

function identity(row: IdentityRow): DurableIdentity {
  return {
    id: row.id,
    name: row.name,
    canonicalName: row.canonical_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function binding(row: BindingRow): TmuxBinding {
  return {
    id: row.id,
    identityId: row.identity_id,
    transport: row.transport,
    paneId: row.pane_id,
    serverId: row.server_id,
    socketPath: row.socket_path,
    serverPid: row.server_pid,
    serverStartTime: row.server_start_time,
    panePid: row.pane_pid,
    boundAt: row.bound_at,
    lastVerifiedAt: row.last_verified_at,
  };
}

/** Storage-backed identity repository. SQL remains private to this module. */
export function openIdentityRepository(location: StorageLocation): IdentityRepository {
  let lifecycle;
  for (let attempt = 0; ; attempt += 1) {
    try {
      lifecycle = openStorageWithDatabase(location);
      break;
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== 'busy' || attempt >= 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  const database = lifecycle.database;
  let closed = false;

  const requireOpen = (): Database.Database => {
    if (closed) throw new Error('Identity repository is closed.');
    return database;
  };

  return {
    ...createRequestRepository(requireOpen),
    withImmediateTransaction<T>(operation: () => T): T {
      return requireOpen().transaction(operation).immediate();
    },
    findByCanonicalName(canonicalName) {
      const row = requireOpen()
        .prepare(
          'SELECT id, name, canonical_name, created_at, updated_at FROM identities WHERE canonical_name = ?'
        )
        .get(canonicalName) as IdentityRow | undefined;
      return row ? identity(row) : undefined;
    },
    createIdentity(name, canonicalName) {
      const now = new Date().toISOString();
      const value = {
        id: crypto.randomUUID(),
        name,
        canonicalName,
        createdAt: now,
        updatedAt: now,
      };
      requireOpen()
        .prepare(
          'INSERT INTO identities (id, name, canonical_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(value.id, value.name, value.canonicalName, value.createdAt, value.updatedAt);
      return value;
    },
    listIdentities() {
      const rows = requireOpen()
        .prepare(
          'SELECT id, name, canonical_name, created_at, updated_at FROM identities ORDER BY canonical_name'
        )
        .all() as IdentityRow[];
      return rows.map(identity);
    },
    findBindings() {
      const rows = requireOpen()
        .prepare(
          'SELECT id, identity_id, transport, pane_id, server_id, socket_path, server_pid, server_start_time, pane_pid, bound_at, last_verified_at FROM bindings'
        )
        .all() as BindingRow[];
      return rows.map(binding);
    },
    findBindingByPane(paneId, serverId) {
      const row = requireOpen()
        .prepare(
          'SELECT id, identity_id, transport, pane_id, server_id, socket_path, server_pid, server_start_time, pane_pid, bound_at, last_verified_at FROM bindings WHERE pane_id = ? AND server_id = ?'
        )
        .get(paneId, serverId) as BindingRow | undefined;
      return row ? binding(row) : undefined;
    },
    createBinding(value) {
      const id = value.id ?? crypto.randomUUID();
      requireOpen()
        .prepare(
          'INSERT INTO bindings (id, identity_id, transport, pane_id, server_id, socket_path, server_pid, server_start_time, pane_pid, bound_at, last_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          id,
          value.identityId,
          value.transport,
          value.paneId,
          value.serverId,
          value.socketPath,
          value.serverPid,
          value.serverStartTime,
          value.panePid,
          value.boundAt,
          value.lastVerifiedAt
        );
      return { ...value, id };
    },
    touchBinding(id, lastVerifiedAt) {
      requireOpen()
        .prepare('UPDATE bindings SET last_verified_at = ? WHERE id = ?')
        .run(lastVerifiedAt, id);
    },
    removeBinding(id) {
      requireOpen().prepare('DELETE FROM bindings WHERE id = ?').run(id);
    },
    findRole(identityId) {
      const row = requireOpen()
        .prepare('SELECT content, updated_at FROM role_profiles WHERE identity_id = ?')
        .get(identityId) as RoleRow | undefined;
      return row ? { content: row.content, updatedAt: row.updated_at } : undefined;
    },
    setRole(identityId, content) {
      const write = requireOpen().transaction(() => {
        const now = new Date().toISOString();
        requireOpen()
          .prepare(
            'INSERT INTO role_profiles (identity_id, content, updated_at) VALUES (?, ?, ?) ' +
              'ON CONFLICT(identity_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at'
          )
          .run(identityId, content, now);
        return { content, updatedAt: now };
      });
      return write.immediate();
    },
    clearRole(identityId) {
      const clear = requireOpen().transaction(() => {
        requireOpen().prepare('DELETE FROM role_profiles WHERE identity_id = ?').run(identityId);
        return null;
      });
      return clear.immediate();
    },
    findPreamble(identityId) {
      const row = requireOpen()
        .prepare('SELECT content, updated_at FROM identity_preambles WHERE identity_id = ?')
        .get(identityId) as PreambleRow | undefined;
      return row ? { content: row.content, updatedAt: row.updated_at } : undefined;
    },
    setPreamble(identityId, content) {
      const write = requireOpen().transaction(() => {
        const now = new Date().toISOString();
        requireOpen()
          .prepare(
            'INSERT INTO identity_preambles (identity_id, content, updated_at) VALUES (?, ?, ?) ' +
              'ON CONFLICT(identity_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at'
          )
          .run(identityId, content, now);
        return { content, updatedAt: now };
      });
      return write.immediate();
    },
    clearPreamble(identityId) {
      const result = requireOpen()
        .prepare('DELETE FROM identity_preambles WHERE identity_id = ?')
        .run(identityId);
      return result.changes > 0;
    },
    listPreambles() {
      const rows = requireOpen()
        .prepare(
          'SELECT i.id, i.name, i.canonical_name, i.created_at, i.updated_at, p.content, ' +
            'p.updated_at AS preamble_updated_at ' +
            'FROM identities AS i INNER JOIN identity_preambles AS p ON p.identity_id = i.id ' +
            'ORDER BY i.canonical_name'
        )
        .all() as PreambleResultRow[];
      return rows.map((row) => ({
        identity: identity(row),
        preamble: { content: row.content, updatedAt: row.preamble_updated_at },
      }));
    },
    close() {
      if (closed) return;
      closed = true;
      lifecycle.close();
    },
  };
}
