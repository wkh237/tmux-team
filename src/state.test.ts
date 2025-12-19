// ─────────────────────────────────────────────────────────────
// State Tests - Request tracking and TTL cleanup
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Paths } from './types.js';
import {
  loadState,
  saveState,
  cleanupState,
  setActiveRequest,
  clearActiveRequest,
  type AgentRequestState,
} from './state.js';

describe('State Management', () => {
  let testDir: string;
  let paths: Paths;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-state-test-'));
    paths = {
      globalDir: testDir,
      globalConfig: path.join(testDir, 'config.json'),
      localConfig: path.join(testDir, 'tmux-team.json'),
      stateFile: path.join(testDir, 'state.json'),
    };
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('loadState', () => {
    it('returns empty state when state.json does not exist', () => {
      const state = loadState(paths);
      expect(state.requests).toEqual({});
    });

    it('loads existing state from state.json', () => {
      const existingState = {
        requests: {
          claude: { id: 'req-1', nonce: 'abc123', pane: '1.0', startedAtMs: 1000 },
        },
      };
      fs.writeFileSync(paths.stateFile, JSON.stringify(existingState));

      const state = loadState(paths);
      expect(state.requests.claude).toBeDefined();
      expect(state.requests.claude?.nonce).toBe('abc123');
    });

    it('returns empty state when state.json is corrupted', () => {
      fs.writeFileSync(paths.stateFile, 'not valid json');

      const state = loadState(paths);
      expect(state.requests).toEqual({});
    });

    it('returns empty state when state.json has invalid structure', () => {
      fs.writeFileSync(paths.stateFile, JSON.stringify({ invalid: true }));

      const state = loadState(paths);
      expect(state.requests).toEqual({});
    });
  });

  describe('saveState', () => {
    it('writes state to state.json', () => {
      const state = {
        requests: {
          claude: { id: 'req-1', nonce: 'xyz', pane: '1.0', startedAtMs: 2000 },
        },
      };

      saveState(paths, state);

      expect(fs.existsSync(paths.stateFile)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(paths.stateFile, 'utf-8'));
      expect(saved.requests.claude.nonce).toBe('xyz');
    });

    it('creates globalDir if it does not exist', () => {
      fs.rmSync(testDir, { recursive: true, force: true });
      expect(fs.existsSync(testDir)).toBe(false);

      saveState(paths, { requests: {} });

      expect(fs.existsSync(testDir)).toBe(true);
    });
  });

  describe('cleanupState', () => {
    it('removes entries older than TTL', () => {
      const oldTime = Date.now() - 120 * 1000; // 2 minutes ago
      const state = {
        requests: {
          oldAgent: { id: 'old', nonce: 'old', pane: '1.0', startedAtMs: oldTime },
        },
      };
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(paths.stateFile, JSON.stringify(state));

      const cleaned = cleanupState(paths, 60); // 60 second TTL

      expect(cleaned.requests.oldAgent).toBeUndefined();
    });

    it('keeps entries within TTL', () => {
      const recentTime = Date.now() - 30 * 1000; // 30 seconds ago
      const state = {
        requests: {
          recentAgent: { id: 'new', nonce: 'new', pane: '1.0', startedAtMs: recentTime },
        },
      };
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(paths.stateFile, JSON.stringify(state));

      const cleaned = cleanupState(paths, 60); // 60 second TTL

      expect(cleaned.requests.recentAgent).toBeDefined();
    });

    it('requires ttlSeconds parameter', () => {
      // TypeScript enforces this - the function requires ttlSeconds
      // This test just verifies the behavior with different TTL values
      const now = Date.now();
      const state = {
        requests: {
          agent1: { id: '1', nonce: 'a', pane: '1.0', startedAtMs: now - 5000 }, // 5s ago
          agent2: { id: '2', nonce: 'b', pane: '1.1', startedAtMs: now - 15000 }, // 15s ago
        },
      };
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(paths.stateFile, JSON.stringify(state));

      // With 10s TTL, agent1 should be kept, agent2 removed
      const cleaned = cleanupState(paths, 10);

      expect(cleaned.requests.agent1).toBeDefined();
      expect(cleaned.requests.agent2).toBeUndefined();
    });

    it('handles entries with missing startedAtMs', () => {
      const state = {
        requests: {
          badAgent: { id: 'bad', nonce: 'bad', pane: '1.0' } as AgentRequestState,
        },
      };
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(paths.stateFile, JSON.stringify(state));

      const cleaned = cleanupState(paths, 60);

      // Entry with invalid startedAtMs is removed
      expect(cleaned.requests.badAgent).toBeUndefined();
    });

    it('only rewrites file if entries were removed', () => {
      const recentTime = Date.now();
      const state = {
        requests: {
          agent: { id: '1', nonce: 'a', pane: '1.0', startedAtMs: recentTime },
        },
      };
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(paths.stateFile, JSON.stringify(state));
      const originalMtime = fs.statSync(paths.stateFile).mtimeMs;

      // Wait a tiny bit then cleanup (nothing should change)
      cleanupState(paths, 3600);

      const newMtime = fs.statSync(paths.stateFile).mtimeMs;
      // File should not have been rewritten
      expect(newMtime).toBe(originalMtime);
    });
  });

  describe('setActiveRequest', () => {
    it('adds new request to state', () => {
      const req: AgentRequestState = {
        id: 'req-1',
        nonce: 'nonce123',
        pane: '1.0',
        startedAtMs: Date.now(),
      };

      setActiveRequest(paths, 'claude', req);

      const state = loadState(paths);
      expect(state.requests.claude).toBeDefined();
      expect(state.requests.claude?.id).toBe('req-1');
    });

    it('stores request with id, nonce, pane, and startedAtMs', () => {
      const req: AgentRequestState = {
        id: 'test-id',
        nonce: 'test-nonce',
        pane: '2.1',
        startedAtMs: 1234567890,
      };

      setActiveRequest(paths, 'codex', req);

      const state = loadState(paths);
      expect(state.requests.codex?.id).toBe('test-id');
      expect(state.requests.codex?.nonce).toBe('test-nonce');
      expect(state.requests.codex?.pane).toBe('2.1');
      expect(state.requests.codex?.startedAtMs).toBe(1234567890);
    });

    it('overwrites existing request for same agent', () => {
      const req1: AgentRequestState = {
        id: 'old',
        nonce: 'old-nonce',
        pane: '1.0',
        startedAtMs: 1000,
      };
      const req2: AgentRequestState = {
        id: 'new',
        nonce: 'new-nonce',
        pane: '1.0',
        startedAtMs: 2000,
      };

      setActiveRequest(paths, 'claude', req1);
      setActiveRequest(paths, 'claude', req2);

      const state = loadState(paths);
      expect(state.requests.claude?.id).toBe('new');
      expect(state.requests.claude?.nonce).toBe('new-nonce');
    });

    it('preserves other agents when adding new one', () => {
      const req1: AgentRequestState = { id: '1', nonce: 'a', pane: '1.0', startedAtMs: 1000 };
      const req2: AgentRequestState = { id: '2', nonce: 'b', pane: '1.1', startedAtMs: 2000 };

      setActiveRequest(paths, 'claude', req1);
      setActiveRequest(paths, 'codex', req2);

      const state = loadState(paths);
      expect(state.requests.claude).toBeDefined();
      expect(state.requests.codex).toBeDefined();
    });
  });

  describe('clearActiveRequest', () => {
    it('removes agent request from state', () => {
      const req: AgentRequestState = { id: '1', nonce: 'a', pane: '1.0', startedAtMs: 1000 };
      setActiveRequest(paths, 'claude', req);

      clearActiveRequest(paths, 'claude');

      const state = loadState(paths);
      expect(state.requests.claude).toBeUndefined();
    });

    it('does nothing if agent has no active request', () => {
      // Should not throw
      const stateBefore = loadState(paths);
      const countBefore = Object.keys(stateBefore.requests).length;

      clearActiveRequest(paths, 'nonexistent');

      const stateAfter = loadState(paths);
      const countAfter = Object.keys(stateAfter.requests).length;

      // Count should be unchanged (no error, no modification)
      expect(countAfter).toBe(countBefore);
    });

    it('only clears if requestId matches when provided', () => {
      const req: AgentRequestState = { id: 'req-1', nonce: 'a', pane: '1.0', startedAtMs: 1000 };
      setActiveRequest(paths, 'claude', req);

      // Try to clear with wrong requestId
      clearActiveRequest(paths, 'claude', 'wrong-id');

      const state = loadState(paths);
      expect(state.requests.claude).toBeDefined(); // Should still exist
    });

    it('clears when requestId matches', () => {
      const req: AgentRequestState = { id: 'req-1', nonce: 'a', pane: '1.0', startedAtMs: 1000 };
      setActiveRequest(paths, 'claude', req);

      clearActiveRequest(paths, 'claude', 'req-1');

      const state = loadState(paths);
      expect(state.requests.claude).toBeUndefined();
    });

    it('preserves other agents when clearing one', () => {
      const req1: AgentRequestState = { id: '1', nonce: 'a', pane: '1.0', startedAtMs: 1000 };
      const req2: AgentRequestState = { id: '2', nonce: 'b', pane: '1.1', startedAtMs: 2000 };
      setActiveRequest(paths, 'claude', req1);
      setActiveRequest(paths, 'codex', req2);

      clearActiveRequest(paths, 'claude');

      const state = loadState(paths);
      expect(state.requests.claude).toBeUndefined();
      expect(state.requests.codex).toBeDefined();
    });
  });
});
