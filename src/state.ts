// ─────────────────────────────────────────────────────────────
// State management for wait-mode requests (soft locks + cleanup)
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import type { Paths } from './types.js';
import { ensureGlobalDir } from './config.js';

export interface AgentRequestState {
  id: string;
  nonce: string;
  pane: string;
  startedAtMs: number;
}

export interface StateFile {
  requests: Record<string, AgentRequestState>;
}

const DEFAULT_STATE: StateFile = { requests: {} };

function safeParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function loadState(paths: Paths): StateFile {
  ensureGlobalDir(paths);

  if (!fs.existsSync(paths.stateFile)) {
    return { ...DEFAULT_STATE };
  }

  const raw = fs.readFileSync(paths.stateFile, 'utf-8');
  const parsed = safeParseJson<StateFile>(raw);
  if (!parsed || typeof parsed !== 'object' || !parsed.requests) {
    return { ...DEFAULT_STATE };
  }
  return parsed;
}

export function saveState(paths: Paths, state: StateFile): void {
  ensureGlobalDir(paths);
  fs.writeFileSync(paths.stateFile, JSON.stringify(state, null, 2) + '\n');
}

export function cleanupState(paths: Paths, ttlSeconds: number): StateFile {
  const state = loadState(paths);
  const now = Date.now();

  const ttlMs = Math.max(1, ttlSeconds) * 1000;
  const next: StateFile = { requests: {} };

  for (const [agent, req] of Object.entries(state.requests)) {
    if (!req || typeof req.startedAtMs !== 'number') continue;
    if (now - req.startedAtMs <= ttlMs) {
      next.requests[agent] = req;
    }
  }

  // Only rewrite if it changed materially
  if (Object.keys(next.requests).length !== Object.keys(state.requests).length) {
    saveState(paths, next);
  }
  return next;
}

export function setActiveRequest(paths: Paths, agent: string, req: AgentRequestState): void {
  const state = loadState(paths);
  state.requests[agent] = req;
  saveState(paths, state);
}

export function clearActiveRequest(paths: Paths, agent: string, requestId?: string): void {
  const state = loadState(paths);
  if (!state.requests[agent]) return;
  if (requestId && state.requests[agent]?.id !== requestId) return;
  delete state.requests[agent];
  saveState(paths, state);
}
