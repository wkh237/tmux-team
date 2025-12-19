// ─────────────────────────────────────────────────────────────
// State Tests - Request tracking and TTL cleanup
// ─────────────────────────────────────────────────────────────

import { describe, it } from 'vitest';

describe('loadState', () => {
  // Test loading empty state when file doesn't exist
  it.todo('returns empty state when state.json does not exist');

  // Test loading existing state
  it.todo('loads existing state from state.json');

  // Test handling corrupted state file
  it.todo('returns empty state when state.json is corrupted');
});

describe('saveState', () => {
  // Test writing state to file
  it.todo('writes state to state.json');

  // Note: Current impl uses writeFileSync, not atomic temp+rename
  // This is acceptable for CLI simplicity per CONVENTIONS.md
});

describe('cleanupState', () => {
  // Test TTL enforcement - removes stale entries
  it.todo('removes entries older than TTL');

  // Test keeping recent entries
  it.todo('keeps entries within TTL');

  // Note: cleanupState requires ttlSeconds parameter (no default)
  // Caller (talk.ts) passes 60 * 60 (1 hour)
  it.todo('requires ttlSeconds parameter');

  // Note: No "completed" status in state - entries are removed via clearActiveRequest
  // Cleanup only handles TTL-based expiration
});

describe('setActiveRequest', () => {
  // Test adding new request
  it.todo('adds new request to state');

  // Test request structure (id, nonce, startedAt)
  it.todo('stores request with id, nonce, and startedAt');

  // Test overwriting existing request for same agent
  it.todo('overwrites existing request for same agent');
});

describe('clearActiveRequest', () => {
  // Test removing request by agent and id
  it.todo('removes request matching agent and id');

  // Test no-op when request id does not match
  it.todo('does nothing when request id does not match current');

  // Test no-op when no request exists for agent
  it.todo('does nothing when no request exists for agent');
});
