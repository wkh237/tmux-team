import path from 'node:path';
import Database from 'better-sqlite3';
import type { E2EFixture } from './harness.js';

export interface AttemptRow {
  attempt_id: string;
  request_id: string;
  nonce: string | null;
  server_id: string;
  socket_path: string;
  server_pid: number;
  server_start_time: string;
  pane_id: string;
  pane_pid: number;
  wait_active: number;
  status: string;
  inject_preamble: number;
}

/** Read committed state independently of the CLI's service and connection. */
function read<T>(fixture: E2EFixture, query: (database: Database.Database) => T): T {
  const database = new Database(path.join(fixture.globalDir, 'tmux-team.db'), { readonly: true });
  try {
    return query(database);
  } finally {
    database.close();
  }
}

export function requestAttempts(fixture: E2EFixture): AttemptRow[] {
  return read(
    fixture,
    (database) => database.prepare('SELECT * FROM request_attempts').all() as AttemptRow[]
  );
}

export function preambleCounters(fixture: E2EFixture): Record<string, number> {
  return read(fixture, (database) => {
    const rows = database
      .prepare('SELECT identity_id, reserved_count FROM preamble_counters')
      .all() as Array<{ identity_id: string; reserved_count: number }>;
    return Object.fromEntries(rows.map((row) => [row.identity_id, row.reserved_count]));
  });
}
