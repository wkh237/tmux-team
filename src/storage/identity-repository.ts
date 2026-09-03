import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { DurableIdentity, TmuxBinding } from '../domain/identity.js';
import { openStorage } from './sqlite-adapter.js';
import { StorageError } from './errors.js';
import type { StorageLocation } from './ports.js';

export interface IdentityRepository {
  findByCanonicalName(canonicalName: string): DurableIdentity | undefined;
  createIdentity(name: string, canonicalName: string): DurableIdentity;
  listIdentities(): DurableIdentity[];
  findBindings(): TmuxBinding[];
  findBindingByPane(paneId: string, serverId: string): TmuxBinding | undefined;
  createBinding(binding: Omit<TmuxBinding, 'id'> & { id?: string }): TmuxBinding;
  touchBinding(id: string, lastVerifiedAt: string): void;
  removeBinding(id: string): void;
  removeIdentityIfUnbound(id: string): void;
  close(): void;
}

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
      lifecycle = openStorage(location);
      break;
    } catch (error) {
      if (!(error instanceof StorageError) || error.code !== 'busy' || attempt >= 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  const database = new Database(lifecycle.path);
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.pragma('synchronous = NORMAL');
  let closed = false;

  const requireOpen = (): Database.Database => {
    if (closed) throw new Error('Identity repository is closed.');
    return database;
  };

  return {
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
    removeIdentityIfUnbound(id) {
      requireOpen()
        .prepare(
          'DELETE FROM identities WHERE id = ? AND NOT EXISTS (SELECT 1 FROM bindings WHERE identity_id = ?)'
        )
        .run(id, id);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        database.close();
      } finally {
        lifecycle.close();
      }
    },
  };
}
