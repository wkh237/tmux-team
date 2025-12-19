// ─────────────────────────────────────────────────────────────
// PM Manager Tests - Team resolution and adapter factory
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  findCurrentTeamId,
  getTeamsDir,
  getTeamConfig,
  saveTeamConfig,
  getStorageAdapter,
  createStorageAdapter,
  generateTeamId,
  listTeams,
  linkTeam,
} from './manager.js';
import { FSAdapter } from './storage/fs.js';
import { GitHubAdapter } from './storage/github.js';

describe('getTeamsDir', () => {
  it('returns <globalDir>/teams path', () => {
    expect(getTeamsDir('/home/user/.config/tmux-team')).toBe('/home/user/.config/tmux-team/teams');
  });

  it('handles trailing slash in globalDir', () => {
    expect(getTeamsDir('/home/user/.tmux-team')).toBe('/home/user/.tmux-team/teams');
  });
});

describe('findCurrentTeamId', () => {
  let testDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-manager-test-'));
    originalEnv = process.env.TMUX_TEAM_ID;
    delete process.env.TMUX_TEAM_ID;
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    if (originalEnv) {
      process.env.TMUX_TEAM_ID = originalEnv;
    } else {
      delete process.env.TMUX_TEAM_ID;
    }
  });

  it('reads team ID from .tmux-team-id file', () => {
    const teamId = 'test-team-123';
    fs.writeFileSync(path.join(testDir, '.tmux-team-id'), teamId);

    const result = findCurrentTeamId(testDir, testDir);

    expect(result).toBe(teamId);
  });

  it('uses TMUX_TEAM_ID environment variable when no file exists', () => {
    process.env.TMUX_TEAM_ID = 'env-team-456';

    const result = findCurrentTeamId(testDir, testDir);

    expect(result).toBe('env-team-456');
  });

  it('prefers .tmux-team-id file over TMUX_TEAM_ID env', () => {
    const fileTeamId = 'file-team-id';
    process.env.TMUX_TEAM_ID = 'env-team-id';
    fs.writeFileSync(path.join(testDir, '.tmux-team-id'), fileTeamId);

    const result = findCurrentTeamId(testDir, testDir);

    expect(result).toBe(fileTeamId);
  });

  it('searches parent directories for .tmux-team-id', () => {
    const parentDir = path.join(testDir, 'parent');
    const childDir = path.join(parentDir, 'child');
    const grandchildDir = path.join(childDir, 'grandchild');

    fs.mkdirSync(grandchildDir, { recursive: true });
    fs.writeFileSync(path.join(parentDir, '.tmux-team-id'), 'parent-team');

    const result = findCurrentTeamId(grandchildDir, testDir);

    expect(result).toBe('parent-team');
  });

  it('returns null when no team ID found', () => {
    const result = findCurrentTeamId(testDir, testDir);

    expect(result).toBeNull();
  });

  it('trims whitespace from team ID file', () => {
    fs.writeFileSync(path.join(testDir, '.tmux-team-id'), '  team-with-spaces  \n');

    const result = findCurrentTeamId(testDir, testDir);

    expect(result).toBe('team-with-spaces');
  });
});

describe('getTeamConfig', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-config-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('returns config from config.json', () => {
    const config = { backend: 'github' as const, repo: 'owner/repo' };
    fs.writeFileSync(path.join(testDir, 'config.json'), JSON.stringify(config));

    const result = getTeamConfig(testDir);

    expect(result).toEqual(config);
  });

  it('returns default fs backend when no config exists', () => {
    const result = getTeamConfig(testDir);

    expect(result).toEqual({ backend: 'fs' });
  });

  it('returns null for malformed config.json', () => {
    fs.writeFileSync(path.join(testDir, 'config.json'), 'not json');

    const result = getTeamConfig(testDir);

    expect(result).toBeNull();
  });
});

describe('saveTeamConfig', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-save-config-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('writes config to config.json', () => {
    const config = { backend: 'github' as const, repo: 'owner/repo' };

    saveTeamConfig(testDir, config);

    const content = fs.readFileSync(path.join(testDir, 'config.json'), 'utf-8');
    expect(JSON.parse(content)).toEqual(config);
  });

  it('creates team directory if it does not exist', () => {
    const nestedDir = path.join(testDir, 'nested', 'team');
    const config = { backend: 'fs' as const };

    saveTeamConfig(nestedDir, config);

    expect(fs.existsSync(nestedDir)).toBe(true);
    expect(fs.existsSync(path.join(nestedDir, 'config.json'))).toBe(true);
  });
});

describe('getStorageAdapter', () => {
  let testDir: string;
  let globalDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-adapter-test-'));
    globalDir = testDir;
    fs.mkdirSync(path.join(testDir, 'teams', 'test-team'), { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('returns FSAdapter by default', () => {
    const adapter = getStorageAdapter('test-team', globalDir);

    expect(adapter).toBeInstanceOf(FSAdapter);
  });

  it('returns GitHubAdapter when configured', () => {
    const teamDir = path.join(testDir, 'teams', 'test-team');
    saveTeamConfig(teamDir, { backend: 'github', repo: 'owner/repo' });

    const adapter = getStorageAdapter('test-team', globalDir);

    expect(adapter).toBeInstanceOf(GitHubAdapter);
  });

  it('configures adapter with correct team directory', () => {
    const adapter = getStorageAdapter('my-team', globalDir);

    // FSAdapter exposes its teamDir
    expect((adapter as FSAdapter)['teamDir']).toBe(path.join(globalDir, 'teams', 'my-team'));
  });
});

describe('createStorageAdapter', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-create-adapter-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('creates FSAdapter for fs backend', () => {
    const adapter = createStorageAdapter(testDir, 'fs');

    expect(adapter).toBeInstanceOf(FSAdapter);
  });

  it('creates GitHubAdapter for github backend with repo', () => {
    const adapter = createStorageAdapter(testDir, 'github', 'owner/repo');

    expect(adapter).toBeInstanceOf(GitHubAdapter);
  });

  it('throws error for github backend without repo', () => {
    expect(() => createStorageAdapter(testDir, 'github')).toThrow(
      'GitHub backend requires --repo flag'
    );
  });
});

describe('generateTeamId', () => {
  it('generates valid UUID v4 format', () => {
    const id = generateTeamId();

    // UUID v4 pattern
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('generates unique IDs on each call', () => {
    const ids = new Set<string>();

    for (let i = 0; i < 100; i++) {
      ids.add(generateTeamId());
    }

    expect(ids.size).toBe(100);
  });
});

describe('linkTeam', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-link-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('creates .tmux-team-id file with team ID', () => {
    linkTeam(testDir, 'my-team-id');

    const content = fs.readFileSync(path.join(testDir, '.tmux-team-id'), 'utf-8');
    expect(content.trim()).toBe('my-team-id');
  });

  it('overwrites existing .tmux-team-id file', () => {
    fs.writeFileSync(path.join(testDir, '.tmux-team-id'), 'old-team');

    linkTeam(testDir, 'new-team');

    const content = fs.readFileSync(path.join(testDir, '.tmux-team-id'), 'utf-8');
    expect(content.trim()).toBe('new-team');
  });
});

describe('listTeams', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-list-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('returns empty array when teams directory does not exist', () => {
    const teams = listTeams(testDir);

    expect(teams).toEqual([]);
  });

  it('returns empty array when teams directory is empty', () => {
    fs.mkdirSync(path.join(testDir, 'teams'), { recursive: true });

    const teams = listTeams(testDir);

    expect(teams).toEqual([]);
  });

  it('returns all teams with metadata', () => {
    const teamsDir = path.join(testDir, 'teams');
    fs.mkdirSync(path.join(teamsDir, 'team-1'), { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'team-2'), { recursive: true });

    const team1 = { id: 'team-1', name: 'Project A', createdAt: '2024-01-01' };
    const team2 = { id: 'team-2', name: 'Project B', createdAt: '2024-02-01' };

    fs.writeFileSync(path.join(teamsDir, 'team-1', 'team.json'), JSON.stringify(team1));
    fs.writeFileSync(path.join(teamsDir, 'team-2', 'team.json'), JSON.stringify(team2));

    const teams = listTeams(testDir);

    expect(teams).toHaveLength(2);
    expect(teams.find((t) => t.id === 'team-1')?.name).toBe('Project A');
    expect(teams.find((t) => t.id === 'team-2')?.name).toBe('Project B');
  });

  it('skips directories without team.json', () => {
    const teamsDir = path.join(testDir, 'teams');
    fs.mkdirSync(path.join(teamsDir, 'valid-team'), { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'invalid-team'), { recursive: true });

    fs.writeFileSync(
      path.join(teamsDir, 'valid-team', 'team.json'),
      JSON.stringify({ id: 'valid-team', name: 'Valid' })
    );
    // invalid-team has no team.json

    const teams = listTeams(testDir);

    expect(teams).toHaveLength(1);
    expect(teams[0].id).toBe('valid-team');
  });

  it('skips malformed team.json files', () => {
    const teamsDir = path.join(testDir, 'teams');
    fs.mkdirSync(path.join(teamsDir, 'good-team'), { recursive: true });
    fs.mkdirSync(path.join(teamsDir, 'bad-team'), { recursive: true });

    fs.writeFileSync(
      path.join(teamsDir, 'good-team', 'team.json'),
      JSON.stringify({ id: 'good-team', name: 'Good' })
    );
    fs.writeFileSync(path.join(teamsDir, 'bad-team', 'team.json'), 'not json');

    const teams = listTeams(testDir);

    expect(teams).toHaveLength(1);
    expect(teams[0].id).toBe('good-team');
  });
});
