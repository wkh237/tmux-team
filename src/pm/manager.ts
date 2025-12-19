// ─────────────────────────────────────────────────────────────
// PM Manager - handles team resolution and storage adapter
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { StorageAdapter } from './storage/adapter.js';
import { createFSAdapter } from './storage/fs.js';
import type { Team } from './types.js';

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
 * Get storage adapter for a specific team.
 */
export function getStorageAdapter(teamId: string, globalDir: string): StorageAdapter {
  const teamDir = path.join(getTeamsDir(globalDir), teamId);
  return createFSAdapter(teamDir);
}

/**
 * Generate a new team ID.
 */
export function generateTeamId(): string {
  return crypto.randomUUID();
}

/**
 * List all teams.
 */
export function listTeams(globalDir: string): Team[] {
  const teamsDir = getTeamsDir(globalDir);
  if (!fs.existsSync(teamsDir)) return [];

  const teams: Team[] = [];
  const dirs = fs.readdirSync(teamsDir);

  for (const dir of dirs) {
    const teamFile = path.join(teamsDir, dir, 'team.json');
    if (fs.existsSync(teamFile)) {
      try {
        const team = JSON.parse(fs.readFileSync(teamFile, 'utf-8')) as Team;
        teams.push(team);
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
