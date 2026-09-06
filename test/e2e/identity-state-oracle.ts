import Database from 'better-sqlite3';
import path from 'node:path';
import type { E2EFixture } from './harness.js';

export interface DurableState {
  identities: Array<Record<string, unknown>>;
  bindings: Array<Record<string, unknown>>;
  profiles: Array<Record<string, unknown>>;
}

/** Observe committed identity state without service reconciliation or writes. */
export function durableState(fixture: E2EFixture): DurableState {
  const database = new Database(path.join(fixture.globalDir, 'tmux-team.db'), { readonly: true });
  try {
    return {
      identities: database
        .prepare('SELECT * FROM identities ORDER BY canonical_name')
        .all() as Array<Record<string, unknown>>,
      bindings: database.prepare('SELECT * FROM bindings ORDER BY identity_id').all() as Array<
        Record<string, unknown>
      >,
      profiles: database.prepare('SELECT * FROM role_profiles ORDER BY identity_id').all() as Array<
        Record<string, unknown>
      >,
    };
  } finally {
    database.close();
  }
}
