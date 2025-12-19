// ─────────────────────────────────────────────────────────────
// PM Manager - handles team resolution and storage adapter
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { StorageAdapter } from './storage/adapter.js';
import { createFSAdapter } from './storage/fs.js';
import { createGitHubAdapter } from './storage/github.js';
import type { Team, TeamConfig, TeamWithConfig, StorageBackend } from './types.js';

/**
 * Resolve the teams directory from global config path.
 */
export function getTeamsDir(globalDir: string): string {
  return path.join(globalDir, 'teams');
}

/**
 * Find the current team by looking for a .tmux-team-id file in cwd or parents,
 * or by matching the current tmux window.
 */
export function findCurrentTeamId(cwd: string, _globalDir: string): string | null {
  // 1. Check for .tmux-team-id file in cwd or parents
  // Note: _globalDir reserved for future tmux window matching feature
  let dir = cwd;
  while (dir !== path.dirname(dir)) {
    const idFile = path.join(dir, '.tmux-team-id');
    if (fs.existsSync(idFile)) {
      return fs.readFileSync(idFile, 'utf-8').trim();
    }
    dir = path.dirname(dir);
  }

  // 2. Check TMUX_TEAM_ID env
  if (process.env.TMUX_TEAM_ID) {
    return process.env.TMUX_TEAM_ID;
  }

  // 3. Try to match by tmux window (future enhancement)
  // For now, return null if no explicit team found

  return null;
}

/**
 * Get team config from team directory.
 */
export function getTeamConfig(teamDir: string): TeamConfig | null {
  const configFile = path.join(teamDir, 'config.json');
  if (fs.existsSync(configFile)) {
    try {
      return JSON.parse(fs.readFileSync(configFile, 'utf-8')) as TeamConfig;
    } catch {
      return null;
    }
  }
  // Default to fs backend if no config
  return { backend: 'fs' };
}

/**
 * Save team config to team directory.
 */
export function saveTeamConfig(teamDir: string, config: TeamConfig): void {
  fs.mkdirSync(teamDir, { recursive: true });
  fs.writeFileSync(path.join(teamDir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
}

/**
 * Get storage adapter for a specific team.
 */
export function getStorageAdapter(teamId: string, globalDir: string): StorageAdapter {
  const teamDir = path.join(getTeamsDir(globalDir), teamId);
  const config = getTeamConfig(teamDir);

  if (config?.backend === 'github' && config.repo) {
    return createGitHubAdapter(teamDir, config.repo);
  }

  return createFSAdapter(teamDir);
}

/**
 * Get storage adapter with explicit backend.
 */
export function createStorageAdapter(
  teamDir: string,
  backend: StorageBackend,
  repo?: string
): StorageAdapter {
  if (backend === 'github') {
    if (!repo) {
      throw new Error('GitHub backend requires --repo flag');
    }
    return createGitHubAdapter(teamDir, repo);
  }
  return createFSAdapter(teamDir);
}

/**
 * Generate a new team ID.
 */
export function generateTeamId(): string {
  return crypto.randomUUID();
}

/**
 * List all teams with their backend config.
 */
export function listTeams(globalDir: string): TeamWithConfig[] {
  const teamsDir = getTeamsDir(globalDir);
  if (!fs.existsSync(teamsDir)) return [];

  const teams: TeamWithConfig[] = [];
  const dirs = fs.readdirSync(teamsDir);

  for (const dir of dirs) {
    const teamDir = path.join(teamsDir, dir);
    const teamFile = path.join(teamDir, 'team.json');
    if (fs.existsSync(teamFile)) {
      try {
        const team = JSON.parse(fs.readFileSync(teamFile, 'utf-8')) as Team;
        const config = getTeamConfig(teamDir);
        teams.push({
          ...team,
          backend: config?.backend || 'fs',
          repo: config?.repo,
        });
      } catch {
        // Skip malformed team files
      }
    }
  }

  return teams;
}

/**
 * Create a team ID file in the current directory.
 */
export function linkTeam(cwd: string, teamId: string): void {
  const idFile = path.join(cwd, '.tmux-team-id');
  fs.writeFileSync(idFile, teamId + '\n');
}
