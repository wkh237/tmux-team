import type Database from 'better-sqlite3';
import type {
  RequestAttemptRecord,
  RequestEndpoint,
  RequestRepository,
} from '../request-service.js';

type SqliteDatabase = Database.Database;

type AttemptRow = {
  attempt_id: string;
  request_id: string;
  nonce: string | null;
  identity_id: string | null;
  server_id: string;
  socket_path: string;
  server_pid: number;
  server_start_time: string;
  pane_id: string;
  pane_pid: number;
  wait_active: number;
  status: RequestAttemptRecord['status'];
  preamble_every: number | null;
  inject_preamble: number;
  cadence_reserved: number;
  prepared_at_ms: number;
  sending_at_ms: number | null;
  settled_at_ms: number | null;
  wait_released_at_ms: number | null;
  expires_at_ms: number;
};

const ATTEMPT_COLUMNS = `
  attempt_id, request_id, nonce, identity_id, server_id, socket_path, server_pid,
  server_start_time, pane_id, pane_pid, wait_active, status, preamble_every,
  inject_preamble, cadence_reserved, prepared_at_ms, sending_at_ms, settled_at_ms,
  wait_released_at_ms, expires_at_ms
`;

function mapAttempt(row: AttemptRow): RequestAttemptRecord {
  return {
    attemptId: row.attempt_id,
    requestId: row.request_id,
    ...(row.nonce !== null && { nonce: row.nonce }),
    ...(row.identity_id !== null && { identityId: row.identity_id }),
    serverId: row.server_id,
    socketPath: row.socket_path,
    serverPid: row.server_pid,
    serverStartTime: row.server_start_time,
    paneId: row.pane_id,
    panePid: row.pane_pid,
    waitActive: row.wait_active === 1,
    status: row.status,
    ...(row.preamble_every !== null && { preambleEvery: row.preamble_every }),
    injectPreamble: row.inject_preamble === 1,
    cadenceReserved: row.cadence_reserved === 1,
    preparedAtMs: row.prepared_at_ms,
    ...(row.sending_at_ms !== null && { sendingAtMs: row.sending_at_ms }),
    ...(row.settled_at_ms !== null && { settledAtMs: row.settled_at_ms }),
    ...(row.wait_released_at_ms !== null && { waitReleasedAtMs: row.wait_released_at_ms }),
    expiresAtMs: row.expires_at_ms,
  };
}

function endpointArgs(endpoint: RequestEndpoint): readonly unknown[] {
  return [
    endpoint.serverId,
    endpoint.socketPath,
    endpoint.serverPid,
    endpoint.serverStartTime,
    endpoint.paneId,
    endpoint.panePid,
  ];
}

function getAttempt(database: SqliteDatabase, attemptId: string): AttemptRow | undefined {
  return database
    .prepare(`SELECT ${ATTEMPT_COLUMNS} FROM request_attempts WHERE attempt_id = ?`)
    .get(attemptId) as AttemptRow | undefined;
}

export function createRequestRepository(
  requireOpen: () => SqliteDatabase
): Omit<RequestRepository, 'withImmediateTransaction'> {
  return {
    createAttempt(attempt) {
      requireOpen()
        .prepare(
          `INSERT INTO request_attempts (
             attempt_id, request_id, nonce, identity_id, server_id, socket_path, server_pid,
             server_start_time, pane_id, pane_pid, wait_active, status, preamble_every,
             inject_preamble, cadence_reserved, prepared_at_ms, sending_at_ms, settled_at_ms,
             wait_released_at_ms, expires_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          attempt.attemptId,
          attempt.requestId,
          attempt.nonce ?? null,
          attempt.identityId ?? null,
          attempt.serverId,
          attempt.socketPath,
          attempt.serverPid,
          attempt.serverStartTime,
          attempt.paneId,
          attempt.panePid,
          attempt.waitActive ? 1 : 0,
          attempt.status,
          attempt.preambleEvery ?? null,
          attempt.injectPreamble ? 1 : 0,
          attempt.cadenceReserved ? 1 : 0,
          attempt.preparedAtMs,
          attempt.sendingAtMs ?? null,
          attempt.settledAtMs ?? null,
          attempt.waitReleasedAtMs ?? null,
          attempt.expiresAtMs
        );
    },

    findAttempt(attemptId) {
      const row = getAttempt(requireOpen(), attemptId);
      return row ? mapAttempt(row) : undefined;
    },

    findActiveRequest(endpoint) {
      const row = requireOpen()
        .prepare(
          `SELECT request_id FROM request_attempts
           WHERE server_id = ? AND socket_path = ? AND server_pid = ?
             AND server_start_time = ? AND pane_id = ? AND pane_pid = ?
             AND wait_active = 1
           ORDER BY prepared_at_ms, attempt_id LIMIT 1`
        )
        .get(...endpointArgs(endpoint)) as { request_id: string } | undefined;
      return row?.request_id;
    },

    updateAttemptState(attemptId, expectedStatus, status, cadenceReserved, nowMs) {
      const result = requireOpen()
        .prepare(
          `UPDATE request_attempts
           SET status = ?,
               cadence_reserved = ?,
               sending_at_ms = CASE WHEN ? = 'sending' THEN ? ELSE sending_at_ms END,
               settled_at_ms = CASE
                 WHEN ? IN ('sent', 'uncertain', 'definitely_failed') THEN ?
                 ELSE settled_at_ms
               END
           WHERE attempt_id = ? AND status = ?`
        )
        .run(
          status,
          cadenceReserved ? 1 : 0,
          status,
          nowMs,
          status,
          nowMs,
          attemptId,
          expectedStatus
        );
      return result.changes === 1;
    },

    releaseWait(attemptId, nowMs) {
      const result = requireOpen()
        .prepare(
          `UPDATE request_attempts
           SET wait_active = 0, wait_released_at_ms = ?
           WHERE attempt_id = ? AND wait_active = 1`
        )
        .run(nowMs, attemptId);
      return result.changes === 1;
    },

    getPreambleCount(identityId) {
      const row = requireOpen()
        .prepare('SELECT reserved_count FROM preamble_counters WHERE identity_id = ?')
        .get(identityId) as { reserved_count: number } | undefined;
      return row?.reserved_count ?? 0;
    },

    setPreambleCount(identityId, count, nowMs) {
      requireOpen()
        .prepare(
          `INSERT INTO preamble_counters (identity_id, reserved_count, updated_at_ms)
           VALUES (?, ?, ?)
           ON CONFLICT(identity_id) DO UPDATE SET
             reserved_count = excluded.reserved_count,
             updated_at_ms = excluded.updated_at_ms`
        )
        .run(identityId, count, nowMs);
    },

    deleteRetained(nowMs, retentionMs) {
      const database = requireOpen();
      database
        .prepare(
          `DELETE FROM request_attempts
           WHERE wait_active = 0 AND status IN ('sent', 'uncertain', 'definitely_failed')
             AND settled_at_ms IS NOT NULL AND settled_at_ms <= ?`
        )
        .run(nowMs - retentionMs);
    },

    listExpiredAttempts(nowMs) {
      const rows = requireOpen()
        .prepare(
          `SELECT ${ATTEMPT_COLUMNS} FROM request_attempts
           WHERE expires_at_ms <= ?
             AND (wait_active = 1 OR status IN ('prepared', 'sending'))
           ORDER BY expires_at_ms, attempt_id`
        )
        .all(nowMs) as AttemptRow[];
      return rows.map(mapAttempt);
    },

    listAttempts() {
      const rows = requireOpen()
        .prepare(
          `SELECT ${ATTEMPT_COLUMNS} FROM request_attempts ORDER BY prepared_at_ms, attempt_id`
        )
        .all() as AttemptRow[];
      return rows.map(mapAttempt);
    },
  };
}
