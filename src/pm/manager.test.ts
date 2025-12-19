// ─────────────────────────────────────────────────────────────
// PM Manager Tests - Team resolution and adapter factory
// ─────────────────────────────────────────────────────────────

import { describe, it } from 'vitest';

describe('findCurrentTeamId', () => {
  // Test finds team ID from .tmux-team-id in cwd
  it.todo('reads team ID from .tmux-team-id file');

  // Test finds team ID from TMUX_TEAM_ID env
  it.todo('uses TMUX_TEAM_ID environment variable when no file exists');

  // Note: Current impl checks FILE FIRST, then env
  // .tmux-team-id file takes precedence over TMUX_TEAM_ID env
  it.todo('prefers .tmux-team-id file over TMUX_TEAM_ID env');

  // Test walks up directory tree
  it.todo('searches parent directories for .tmux-team-id');

  // Test returns null when neither exists
  it.todo('returns null when no team ID found');

  // Test trims whitespace from file content
  it.todo('trims whitespace from team ID file');
});

describe('getStorageAdapter', () => {
  // Test returns FSAdapter for fs storage
  it.todo('returns FSAdapter instance');

  // Test adapter uses correct team directory
  it.todo('configures adapter with correct team directory');

  // Future: Test returns GitHubAdapter when storage is github
  // it.todo('returns GitHubAdapter when pm.storage is github');
});

describe('generateTeamId', () => {
  // Test generates valid UUID v4
  it.todo('generates valid UUID v4 format');

  // Test generates unique IDs
  it.todo('generates unique IDs on each call');
});

describe('linkTeam', () => {
  // Test creates .tmux-team-id file
  it.todo('creates .tmux-team-id file with team ID');

  // Test overwrites existing link
  it.todo('overwrites existing .tmux-team-id file');
});

describe('getTeamsDir', () => {
  // Test returns correct teams directory path
  it.todo('returns <globalDir>/teams path');
});

describe('listTeams', () => {
  // Test lists all team directories
  it.todo('returns all teams with metadata');

  // Test returns empty array when no teams
  it.todo('returns empty array when teams directory is empty');

  // Test handles missing teams directory
  it.todo('returns empty array when teams directory does not exist');

  // Test reads team.json for each team
  it.todo('loads team metadata from team.json');
});
