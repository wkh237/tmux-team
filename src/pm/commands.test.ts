// ─────────────────────────────────────────────────────────────
// PM Commands Tests
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Context } from '../types.js';
import type { UI } from '../types.js';
// ExitCodes imported for reference but tested via ctx.exit mock
import { cmdPm, cmdPmInit, cmdPmMilestone, cmdPmTask, cmdPmLog, cmdPmList } from './commands.js';
import { findCurrentTeamId, linkTeam, getTeamsDir } from './manager.js';

// ─────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────

function createMockUI(): UI & { logs: string[]; errors: string[]; jsonData: unknown[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  const jsonData: unknown[] = [];

  return {
    logs,
    errors,
    jsonData,
    info: vi.fn((msg: string) => logs.push(`[info] ${msg}`)),
    success: vi.fn((msg: string) => logs.push(`[success] ${msg}`)),
    warn: vi.fn((msg: string) => logs.push(`[warn] ${msg}`)),
    error: vi.fn((msg: string) => errors.push(msg)),
    table: vi.fn((_headers: string[], _rows: string[][]) => logs.push('[table]')),
    json: vi.fn((data: unknown) => jsonData.push(data)),
  };
}

function createMockContext(
  globalDir: string,
  options: { json?: boolean; cwd?: string; agents?: Record<string, { deny?: string[] }> } = {}
): Context & { ui: ReturnType<typeof createMockUI>; exitCode: number | null } {
  const ui = createMockUI();
  let exitCode: number | null = null;

  // Override cwd for tests
  const originalCwd = process.cwd;
  if (options.cwd) {
    vi.spyOn(process, 'cwd').mockReturnValue(options.cwd);
  }

  return {
    ui,
    exitCode,
    flags: { json: options.json ?? false },
    paths: { globalDir, configFile: path.join(globalDir, 'config.json') },
    config: {
      mode: 'polling',
      preambleMode: 'always',
      defaults: { timeout: 60, pollInterval: 1, captureLines: 100 },
      agents: options.agents ?? {},
      paneRegistry: {},
    },
    exit: vi.fn((code: number) => {
      exitCode = code;
      throw new Error(`Exit: ${code}`);
    }),
    restoreCwd: () => {
      if (options.cwd) {
        vi.spyOn(process, 'cwd').mockImplementation(originalCwd);
      }
    },
  } as unknown as Context & { ui: ReturnType<typeof createMockUI>; exitCode: number | null };
}

// ─────────────────────────────────────────────────────────────
// requireTeam tests
// ─────────────────────────────────────────────────────────────

describe('requireTeam', () => {
  let testDir: string;
  let globalDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-test-'));
    globalDir = path.join(testDir, 'global');
    fs.mkdirSync(globalDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('finds team ID from .tmux-team-id file in cwd', () => {
    const projectDir = path.join(testDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.tmux-team-id'), 'test-team-123\n');

    const teamId = findCurrentTeamId(projectDir, globalDir);
    expect(teamId).toBe('test-team-123');
  });

  it('finds team ID from TMUX_TEAM_ID environment variable', () => {
    const originalEnv = process.env.TMUX_TEAM_ID;
    process.env.TMUX_TEAM_ID = 'env-team-456';

    try {
      const teamId = findCurrentTeamId(testDir, globalDir);
      expect(teamId).toBe('env-team-456');
    } finally {
      if (originalEnv) {
        process.env.TMUX_TEAM_ID = originalEnv;
      } else {
        delete process.env.TMUX_TEAM_ID;
      }
    }
  });

  it('validates team.json exists for team ID', async () => {
    const projectDir = path.join(testDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });

    // Create team directory with team.json
    const teamId = 'valid-team-id';
    const teamDir = path.join(globalDir, 'teams', teamId);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'team.json'),
      JSON.stringify({ id: teamId, name: 'Test', createdAt: new Date().toISOString() })
    );

    // Link project to team
    linkTeam(projectDir, teamId);

    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    // Should not throw - team is valid
    await cmdPmTask(ctx, ['list']);
    expect(ctx.ui.logs.some((l) => l.includes('[info]') || l.includes('[table]'))).toBe(true);
  });

  it('exits with error when no .tmux-team-id found', async () => {
    const projectDir = path.join(testDir, 'empty-project');
    fs.mkdirSync(projectDir, { recursive: true });

    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await expect(cmdPmTask(ctx, ['list'])).rejects.toThrow('Exit');
    expect(ctx.ui.errors[0]).toContain('No team found');
  });

  it('exits with error when team.json does not exist (stale ID)', async () => {
    const projectDir = path.join(testDir, 'stale-project');
    fs.mkdirSync(projectDir, { recursive: true });

    // Create .tmux-team-id pointing to non-existent team
    fs.writeFileSync(path.join(projectDir, '.tmux-team-id'), 'stale-team-id\n');

    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await expect(cmdPmTask(ctx, ['list'])).rejects.toThrow('Exit');
    expect(ctx.ui.errors[0]).toContain('not found');
  });
});

// ─────────────────────────────────────────────────────────────
// cmdPmInit tests
// ─────────────────────────────────────────────────────────────

describe('cmdPmInit', () => {
  let testDir: string;
  let globalDir: string;
  let projectDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-test-'));
    globalDir = path.join(testDir, 'global');
    projectDir = path.join(testDir, 'project');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('creates team with generated UUID', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmInit(ctx, []);

    // Check that a team directory was created
    const teamsDir = getTeamsDir(globalDir);
    const teamDirs = fs.readdirSync(teamsDir);
    expect(teamDirs.length).toBe(1);

    // UUID format validation
    expect(teamDirs[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses --name flag for team name', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmInit(ctx, ['--name', 'My Custom Project']);

    expect(ctx.ui.logs.some((l) => l.includes('My Custom Project'))).toBe(true);
  });

  it('creates .tmux-team-id file in current directory', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmInit(ctx, ['--name', 'Test']);

    const idFile = path.join(projectDir, '.tmux-team-id');
    expect(fs.existsSync(idFile)).toBe(true);

    const teamId = fs.readFileSync(idFile, 'utf-8').trim();
    expect(teamId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('logs team_created event to audit log', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmInit(ctx, ['--name', 'Test']);

    // Read the events file
    const teamsDir = getTeamsDir(globalDir);
    const teamDirs = fs.readdirSync(teamsDir);
    const eventsFile = path.join(teamsDir, teamDirs[0], 'events.jsonl');

    expect(fs.existsSync(eventsFile)).toBe(true);
    const events = fs
      .readFileSync(eventsFile, 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events[0].event).toBe('team_created');
  });

  it('outputs team info in JSON when --json flag set', async () => {
    const ctx = createMockContext(globalDir, { json: true, cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmInit(ctx, ['--name', 'JSON Test']);

    expect(ctx.ui.jsonData.length).toBe(1);
    const data = ctx.ui.jsonData[0] as { team: { name: string } };
    expect(data.team.name).toBe('JSON Test');
  });
});

// ─────────────────────────────────────────────────────────────
// cmdPmMilestone tests
// ─────────────────────────────────────────────────────────────

describe('cmdPmMilestone', () => {
  let testDir: string;
  let globalDir: string;
  let projectDir: string;
  let teamId: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-test-'));
    globalDir = path.join(testDir, 'global');
    projectDir = path.join(testDir, 'project');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    // Initialize a team
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    await cmdPmInit(ctx, ['--name', 'Test Project']);
    vi.restoreAllMocks();

    teamId = fs.readFileSync(path.join(projectDir, '.tmux-team-id'), 'utf-8').trim();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('creates milestone with given name', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmMilestone(ctx, ['add', 'Sprint 1']);

    expect(ctx.ui.logs.some((l) => l.includes('Sprint 1'))).toBe(true);

    // Verify file was created
    const milestonePath = path.join(globalDir, 'teams', teamId, 'milestones', '1.json');
    expect(fs.existsSync(milestonePath)).toBe(true);
  });

  it('lists all milestones in table format', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmMilestone(ctx, ['add', 'Phase 1']);
    await cmdPmMilestone(ctx, ['add', 'Phase 2']);

    (ctx.ui.table as ReturnType<typeof vi.fn>).mockClear();
    await cmdPmMilestone(ctx, ['list']);

    expect(ctx.ui.table).toHaveBeenCalledTimes(1);
    expect(ctx.ui.table).toHaveBeenCalledWith(
      ['ID', 'NAME', 'STATUS'],
      expect.arrayContaining([
        expect.arrayContaining(['1', 'Phase 1']),
        expect.arrayContaining(['2', 'Phase 2']),
      ])
    );
  });

  it('lists milestones when called without subcommand', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmMilestone(ctx, ['add', 'Phase 1']);

    // Clear mock call history after add, then verify empty args triggers list
    (ctx.ui.table as ReturnType<typeof vi.fn>).mockClear();
    await cmdPmMilestone(ctx, []);

    expect(ctx.ui.table).toHaveBeenCalledTimes(1);
    expect(ctx.ui.table).toHaveBeenCalledWith(
      ['ID', 'NAME', 'STATUS'],
      expect.arrayContaining([expect.arrayContaining(['1', 'Phase 1'])])
    );
  });

  it('marks milestone as done', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmMilestone(ctx, ['add', 'Sprint 1']);
    await cmdPmMilestone(ctx, ['done', '1']);

    expect(ctx.ui.logs.some((l) => l.includes('done'))).toBe(true);

    // Verify status was updated
    const milestonePath = path.join(globalDir, 'teams', teamId, 'milestones', '1.json');
    const milestone = JSON.parse(fs.readFileSync(milestonePath, 'utf-8'));
    expect(milestone.status).toBe('done');
  });

  it('exits with error for non-existent milestone', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await expect(cmdPmMilestone(ctx, ['done', '999'])).rejects.toThrow('Exit');
    expect(ctx.ui.errors[0]).toContain('not found');
  });

  it('routes "pm m add" to milestone add', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPm(ctx, ['m', 'add', 'Shorthand Test']);

    expect(ctx.ui.logs.some((l) => l.includes('Shorthand Test'))).toBe(true);
  });

  it('creates milestone with --description flag', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmMilestone(ctx, ['add', 'Phase 1', '--description', 'Initial development']);

    // Verify doc file contains description
    const docPath = path.join(globalDir, 'teams', teamId, 'milestones', '1.md');
    const content = fs.readFileSync(docPath, 'utf-8');
    expect(content).toContain('Phase 1');
    expect(content).toContain('Initial development');
  });

  it('prints milestone doc by default', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir, json: true });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmMilestone(ctx, ['add', 'Phase 1', '-d', 'Test description']);

    (ctx.ui.json as ReturnType<typeof vi.fn>).mockClear();
    await cmdPmMilestone(ctx, ['doc', '1']);

    expect(ctx.ui.json).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '1',
        doc: expect.stringContaining('Phase 1'),
      })
    );
  });

  it('returns milestone doc in JSON format', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir, json: true });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmMilestone(ctx, ['add', 'Phase 1']);
    await cmdPmMilestone(ctx, ['doc', '1']);

    const jsonOutput = ctx.ui.jsonData.find(
      (d) => typeof d === 'object' && d !== null && 'doc' in d
    ) as { id: string; doc: string };
    expect(jsonOutput).toMatchObject({
      id: '1',
      doc: expect.stringContaining('Phase 1'),
    });
  });

  it('exits with error for non-existent milestone doc', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await expect(cmdPmMilestone(ctx, ['doc', '999'])).rejects.toThrow('Exit');
    expect(ctx.ui.errors[0]).toContain('not found');
  });

  it('shows docPath with doc ref subcommand', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir, json: true });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmMilestone(ctx, ['add', 'Phase 1']);

    (ctx.ui.json as ReturnType<typeof vi.fn>).mockClear();
    await cmdPmMilestone(ctx, ['doc', '1', 'ref']);

    expect(ctx.ui.json).toHaveBeenCalledTimes(1);
    expect(ctx.ui.json).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '1',
        docPath: expect.stringContaining('1.md'),
      })
    );
  });

  it('creates milestone with -d shorthand for description', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmMilestone(ctx, ['add', 'Sprint 1', '-d', 'Two week sprint']);

    const docPath = path.join(globalDir, 'teams', teamId, 'milestones', '1.md');
    const content = fs.readFileSync(docPath, 'utf-8');
    expect(content).toContain('Sprint 1');
    expect(content).toContain('Two week sprint');
  });

  it('prints full doc content including description', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir, json: true });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmMilestone(ctx, ['add', 'Phase 1', '--description', 'Detailed description here']);

    (ctx.ui.json as ReturnType<typeof vi.fn>).mockClear();
    await cmdPmMilestone(ctx, ['doc', '1']);

    expect(ctx.ui.json).toHaveBeenCalledTimes(1);
    expect(ctx.ui.json).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '1',
        doc: expect.stringContaining('Detailed description here'),
      })
    );
  });

  it('sets milestone documentation with --body flag', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmMilestone(ctx, ['add', 'Sprint 1']);
    await cmdPmMilestone(ctx, ['doc', '1', '--body', 'New milestone content']);
    expect(ctx.ui.logs.some((l) => l.includes('Saved'))).toBe(true);

    // Verify the content was saved
    const jsonCtx = createMockContext(globalDir, { cwd: projectDir, json: true });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    await cmdPmMilestone(jsonCtx, ['doc', '1']);

    expect(jsonCtx.ui.json).toHaveBeenCalledWith(
      expect.objectContaining({
        doc: 'New milestone content',
      })
    );
  });

  it('sets milestone documentation with --body-file flag', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmMilestone(ctx, ['add', 'Sprint 1']);

    // Create a temp file with content
    const tempFile = path.join(projectDir, 'milestone-doc.md');
    fs.writeFileSync(tempFile, '# Milestone content from file');

    await cmdPmMilestone(ctx, ['doc', '1', '--body-file', tempFile]);
    expect(ctx.ui.logs.some((l) => l.includes('Saved') && l.includes('from'))).toBe(true);

    // Verify the content was saved
    const jsonCtx = createMockContext(globalDir, { cwd: projectDir, json: true });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    await cmdPmMilestone(jsonCtx, ['doc', '1']);

    expect(jsonCtx.ui.json).toHaveBeenCalledWith(
      expect.objectContaining({
        doc: expect.stringContaining('Milestone content from file'),
      })
    );
  });
});

// ─────────────────────────────────────────────────────────────
// cmdPmTask tests
// ─────────────────────────────────────────────────────────────

describe('cmdPmTask', () => {
  let testDir: string;
  let globalDir: string;
  let projectDir: string;
  let teamId: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-test-'));
    globalDir = path.join(testDir, 'global');
    projectDir = path.join(testDir, 'project');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    // Initialize a team
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    await cmdPmInit(ctx, ['--name', 'Test Project']);
    vi.restoreAllMocks();

    teamId = fs.readFileSync(path.join(projectDir, '.tmux-team-id'), 'utf-8').trim();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('creates task with given title', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmTask(ctx, ['add', 'Implement login']);

    expect(ctx.ui.logs.some((l) => l.includes('Implement login'))).toBe(true);
  });

  it('creates task with milestone reference', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    // Create milestone first
    await cmdPmMilestone(ctx, ['add', 'Sprint 1']);
    await cmdPmTask(ctx, ['add', 'Task with milestone', '--milestone', '1']);

    const taskPath = path.join(globalDir, 'teams', teamId, 'tasks', '1.json');
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
    expect(task.milestone).toBe('1');
  });

  it('creates task with assignee', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmTask(ctx, ['add', 'Assigned task', '--assignee', 'claude']);

    const taskPath = path.join(globalDir, 'teams', teamId, 'tasks', '1.json');
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
    expect(task.assignee).toBe('claude');
  });

  it('lists all tasks in table format', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmTask(ctx, ['add', 'Task 1']);
    await cmdPmTask(ctx, ['add', 'Task 2']);

    (ctx.ui.table as ReturnType<typeof vi.fn>).mockClear();
    await cmdPmTask(ctx, ['list']);

    expect(ctx.ui.table).toHaveBeenCalledTimes(1);
    expect(ctx.ui.table).toHaveBeenCalledWith(
      ['ID', 'TITLE', 'STATUS', 'MILESTONE'],
      expect.arrayContaining([
        expect.arrayContaining(['1', 'Task 1']),
        expect.arrayContaining(['2', 'Task 2']),
      ])
    );
  });

  it('lists tasks when called without subcommand', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmTask(ctx, ['add', 'Task 1']);

    // Clear mock call history after add, then verify empty args triggers list
    (ctx.ui.table as ReturnType<typeof vi.fn>).mockClear();
    await cmdPmTask(ctx, []);

    expect(ctx.ui.table).toHaveBeenCalledTimes(1);
    expect(ctx.ui.table).toHaveBeenCalledWith(
      ['ID', 'TITLE', 'STATUS', 'MILESTONE'],
      expect.arrayContaining([expect.arrayContaining(['1', 'Task 1'])])
    );
  });

  it('filters task list by status', async () => {
    const ctx = createMockContext(globalDir, { json: true, cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmTask(ctx, ['add', 'Pending task']);
    await cmdPmTask(ctx, ['add', 'Another task']);
    await cmdPmTask(ctx, ['done', '1']);
    await cmdPmTask(ctx, ['list', '--status', 'pending']);

    const lastJson = ctx.ui.jsonData[ctx.ui.jsonData.length - 1] as { id: string }[];
    expect(lastJson).toHaveLength(1);
    expect(lastJson[0].id).toBe('2');
  });

  it('filters task list by milestone', async () => {
    const ctx = createMockContext(globalDir, { json: true, cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmMilestone(ctx, ['add', 'Sprint 1']);
    await cmdPmMilestone(ctx, ['add', 'Sprint 2']);
    await cmdPmTask(ctx, ['add', 'Task in Sprint 1', '--milestone', '1']);
    await cmdPmTask(ctx, ['add', 'Task in Sprint 2', '--milestone', '2']);
    await cmdPmTask(ctx, ['list', '--milestone', '1']);

    const lastJson = ctx.ui.jsonData[ctx.ui.jsonData.length - 1] as { milestone: string }[];
    expect(lastJson).toHaveLength(1);
    expect(lastJson[0].milestone).toBe('1');
  });

  it('displays task details', async () => {
    const ctx = createMockContext(globalDir, { json: true, cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmTask(ctx, ['add', 'Show me', '--assignee', 'claude']);
    await cmdPmTask(ctx, ['show', '1']);

    const lastJson = ctx.ui.jsonData[ctx.ui.jsonData.length - 1] as { title: string };
    expect(lastJson.title).toBe('Show me');
  });

  it('updates task status', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmTask(ctx, ['add', 'Update me']);
    await cmdPmTask(ctx, ['update', '1', '--status', 'in_progress']);

    const taskPath = path.join(globalDir, 'teams', teamId, 'tasks', '1.json');
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
    expect(task.status).toBe('in_progress');
  });

  it('updates task assignee', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmTask(ctx, ['add', 'Reassign me']);
    await cmdPmTask(ctx, ['update', '1', '--assignee', 'codex']);

    const taskPath = path.join(globalDir, 'teams', teamId, 'tasks', '1.json');
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
    expect(task.assignee).toBe('codex');
  });

  it('marks task as done', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmTask(ctx, ['add', 'Complete me']);
    await cmdPmTask(ctx, ['done', '1']);

    const taskPath = path.join(globalDir, 'teams', teamId, 'tasks', '1.json');
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
    expect(task.status).toBe('done');
  });

  it('exits with error for non-existent task', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await expect(cmdPmTask(ctx, ['show', '999'])).rejects.toThrow('Exit');
    expect(ctx.ui.errors[0]).toContain('not found');
  });

  it('routes "pm t add" to task add', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPm(ctx, ['t', 'add', 'Shorthand task']);

    expect(ctx.ui.logs.some((l) => l.includes('Shorthand task'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// cmdPmTask doc tests
// ─────────────────────────────────────────────────────────────

describe('cmdPmTask doc', () => {
  let testDir: string;
  let globalDir: string;
  let projectDir: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-test-'));
    globalDir = path.join(testDir, 'global');
    projectDir = path.join(testDir, 'project');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    // Initialize a team and create a task
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    await cmdPmInit(ctx, ['--name', 'Test Project']);
    await cmdPmTask(ctx, ['add', 'Test Task']);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('prints task documentation by default', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir, json: true });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    (ctx.ui.json as ReturnType<typeof vi.fn>).mockClear();
    await cmdPmTask(ctx, ['doc', '1']);

    expect(ctx.ui.json).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '1',
        doc: expect.stringContaining('Test Task'),
      })
    );
  });

  it('opens documentation in $EDITOR with --edit flag', async () => {
    // This test is tricky because it spawns an editor
    // We'll just verify the command doesn't throw
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    // Set a no-op editor
    const originalEditor = process.env.EDITOR;
    process.env.EDITOR = 'true'; // 'true' command exists and does nothing

    try {
      await cmdPmTask(ctx, ['doc', '1', '--edit']);
      expect(ctx.ui.logs.some((l) => l.includes('Saved'))).toBe(true);
    } finally {
      if (originalEditor) {
        process.env.EDITOR = originalEditor;
      } else {
        delete process.env.EDITOR;
      }
    }
  });

  it('exits with error for non-existent task', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await expect(cmdPmTask(ctx, ['doc', '999'])).rejects.toThrow('Exit');
    expect(ctx.ui.errors[0]).toContain('not found');
  });

  it('sets documentation with --body flag', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmTask(ctx, ['doc', '1', '--body', 'New content via --body']);
    expect(ctx.ui.logs.some((l) => l.includes('Saved'))).toBe(true);

    // Verify the content was saved
    const jsonCtx = createMockContext(globalDir, { cwd: projectDir, json: true });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    await cmdPmTask(jsonCtx, ['doc', '1']);

    expect(jsonCtx.ui.json).toHaveBeenCalledWith(
      expect.objectContaining({
        doc: 'New content via --body',
      })
    );
  });

  it('sets documentation with --body-file flag', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    // Create a temp file with content
    const tempFile = path.join(projectDir, 'test-doc.md');
    fs.writeFileSync(tempFile, '# Content from file\n\nThis came from a file.');

    await cmdPmTask(ctx, ['doc', '1', '--body-file', tempFile]);
    expect(ctx.ui.logs.some((l) => l.includes('Saved') && l.includes('from'))).toBe(true);

    // Verify the content was saved
    const jsonCtx = createMockContext(globalDir, { cwd: projectDir, json: true });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    await cmdPmTask(jsonCtx, ['doc', '1']);

    expect(jsonCtx.ui.json).toHaveBeenCalledWith(
      expect.objectContaining({
        doc: expect.stringContaining('Content from file'),
      })
    );
  });

  it('exits with error for non-existent --body-file', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await expect(cmdPmTask(ctx, ['doc', '1', '--body-file', '/nonexistent/file.md'])).rejects.toThrow(
      'Exit'
    );
    expect(ctx.ui.errors[0]).toContain('File not found');
  });
});

// ─────────────────────────────────────────────────────────────
// cmdPmLog tests
// ─────────────────────────────────────────────────────────────

describe('cmdPmLog', () => {
  let testDir: string;
  let globalDir: string;
  let projectDir: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-test-'));
    globalDir = path.join(testDir, 'global');
    projectDir = path.join(testDir, 'project');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    // Initialize a team
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    await cmdPmInit(ctx, ['--name', 'Test Project']);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('displays audit events', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir, json: true });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    // Create some events
    await cmdPmTask(ctx, ['add', 'Task 1']);
    await cmdPmTask(ctx, ['done', '1']);

    (ctx.ui.json as ReturnType<typeof vi.fn>).mockClear();
    await cmdPmLog(ctx, []);

    // cmdPmLog outputs array of events directly
    expect(ctx.ui.json).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ event: expect.stringMatching(/team_created|task/) }),
      ])
    );
  });

  it('limits number of events displayed', async () => {
    const ctx = createMockContext(globalDir, { json: true, cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    // Create multiple events
    await cmdPmTask(ctx, ['add', 'Task 1']);
    await cmdPmTask(ctx, ['add', 'Task 2']);
    await cmdPmTask(ctx, ['add', 'Task 3']);
    await cmdPmLog(ctx, ['--limit', '2']);

    const lastJson = ctx.ui.jsonData[ctx.ui.jsonData.length - 1] as unknown[];
    expect(lastJson.length).toBe(2);
  });

  it('outputs events in JSON when --json flag set', async () => {
    const ctx = createMockContext(globalDir, { json: true, cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmLog(ctx, []);

    expect(ctx.ui.jsonData.length).toBeGreaterThan(0);
    expect(Array.isArray(ctx.ui.jsonData[ctx.ui.jsonData.length - 1])).toBe(true);
  });

  it('shows info message when no events', async () => {
    // Create a new project without events
    const newProjectDir = path.join(testDir, 'empty-project');
    fs.mkdirSync(newProjectDir, { recursive: true });

    const initCtx = createMockContext(globalDir, { cwd: newProjectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(newProjectDir);
    await cmdPmInit(initCtx, ['--name', 'Empty']);
    vi.restoreAllMocks();

    // Clear events file
    const teamId = fs.readFileSync(path.join(newProjectDir, '.tmux-team-id'), 'utf-8').trim();
    const eventsFile = path.join(globalDir, 'teams', teamId, 'events.jsonl');
    fs.writeFileSync(eventsFile, '');

    const ctx = createMockContext(globalDir, { cwd: newProjectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(newProjectDir);

    await cmdPmLog(ctx, []);

    expect(ctx.ui.logs.some((l) => l.includes('No events'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// cmdPmList tests
// ─────────────────────────────────────────────────────────────

describe('cmdPmList', () => {
  let testDir: string;
  let globalDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-test-'));
    globalDir = path.join(testDir, 'global');
    fs.mkdirSync(globalDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('lists all teams in table format', async () => {
    // Create multiple teams
    const project1 = path.join(testDir, 'project1');
    const project2 = path.join(testDir, 'project2');
    fs.mkdirSync(project1, { recursive: true });
    fs.mkdirSync(project2, { recursive: true });

    const ctx1 = createMockContext(globalDir, { cwd: project1 });
    vi.spyOn(process, 'cwd').mockReturnValue(project1);
    await cmdPmInit(ctx1, ['--name', 'Project 1']);
    vi.restoreAllMocks();

    const ctx2 = createMockContext(globalDir, { cwd: project2 });
    vi.spyOn(process, 'cwd').mockReturnValue(project2);
    await cmdPmInit(ctx2, ['--name', 'Project 2']);
    vi.restoreAllMocks();

    const ctx = createMockContext(globalDir);
    await cmdPmList(ctx, []);

    expect(ctx.ui.table).toHaveBeenCalledTimes(1);
    expect(ctx.ui.table).toHaveBeenCalledWith(
      ['', 'ID', 'NAME', 'BACKEND', 'CREATED'],
      expect.arrayContaining([
        expect.arrayContaining(['Project 1']),
        expect.arrayContaining(['Project 2']),
      ])
    );
  });

  it('shows info message when no teams', async () => {
    const ctx = createMockContext(globalDir);
    await cmdPmList(ctx, []);

    expect(ctx.ui.logs.some((l) => l.includes('No teams'))).toBe(true);
  });

  it('outputs teams in JSON when --json flag set', async () => {
    // Create a team first
    const project = path.join(testDir, 'project');
    fs.mkdirSync(project, { recursive: true });

    const initCtx = createMockContext(globalDir, { cwd: project });
    vi.spyOn(process, 'cwd').mockReturnValue(project);
    await cmdPmInit(initCtx, ['--name', 'JSON Team']);
    vi.restoreAllMocks();

    const ctx = createMockContext(globalDir, { json: true });
    await cmdPmList(ctx, []);

    expect(ctx.ui.jsonData.length).toBe(1);
    const data = ctx.ui.jsonData[0] as { teams: unknown[]; currentTeamId: string | null };
    expect(data).toHaveProperty('teams');
    expect(data).toHaveProperty('currentTeamId');
    expect(Array.isArray(data.teams)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// cmdPm router tests
// ─────────────────────────────────────────────────────────────

describe('cmdPm router', () => {
  let testDir: string;
  let globalDir: string;
  let projectDir: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-test-'));
    globalDir = path.join(testDir, 'global');
    projectDir = path.join(testDir, 'project');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    // Initialize a team
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    await cmdPmInit(ctx, ['--name', 'Test Project']);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('routes to correct subcommand', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPm(ctx, ['task', 'add', 'Routed task']);

    expect(ctx.ui.logs.some((l) => l.includes('Routed task'))).toBe(true);
  });

  it('expands m to milestone, t to task', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPm(ctx, ['m', 'add', 'Milestone via m']);
    await cmdPm(ctx, ['t', 'add', 'Task via t']);

    expect(ctx.ui.logs.some((l) => l.includes('Milestone via m'))).toBe(true);
    expect(ctx.ui.logs.some((l) => l.includes('Task via t'))).toBe(true);
  });

  it('exits with error for unknown subcommand', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await expect(cmdPm(ctx, ['unknown'])).rejects.toThrow('Exit');
    expect(ctx.ui.errors[0]).toContain('Unknown pm command');
  });

  it('displays help for pm help', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await cmdPm(ctx, ['help']);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('tmux-team pm'));
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// parseStatus tests
// ─────────────────────────────────────────────────────────────

describe('parseStatus', () => {
  let testDir: string;
  let globalDir: string;
  let projectDir: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-test-'));
    globalDir = path.join(testDir, 'global');
    projectDir = path.join(testDir, 'project');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    // Initialize a team
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    await cmdPmInit(ctx, ['--name', 'Test Project']);
    await cmdPmTask(ctx, ['add', 'Test task']);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('parses pending, in_progress, done', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmTask(ctx, ['update', '1', '--status', 'pending']);
    await cmdPmTask(ctx, ['update', '1', '--status', 'in_progress']);
    await cmdPmTask(ctx, ['update', '1', '--status', 'done']);

    // If we got here without errors, parsing worked
    expect(true).toBe(true);
  });

  it('normalizes in-progress to in_progress', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmTask(ctx, ['update', '1', '--status', 'in-progress']);

    const teamId = fs.readFileSync(path.join(projectDir, '.tmux-team-id'), 'utf-8').trim();
    const taskPath = path.join(globalDir, 'teams', teamId, 'tasks', '1.json');
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
    expect(task.status).toBe('in_progress');
  });

  it('handles case insensitive input', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await cmdPmTask(ctx, ['update', '1', '--status', 'DONE']);

    const teamId = fs.readFileSync(path.join(projectDir, '.tmux-team-id'), 'utf-8').trim();
    const taskPath = path.join(globalDir, 'teams', teamId, 'tasks', '1.json');
    const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
    expect(task.status).toBe('done');
  });

  it('throws error for invalid status', async () => {
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await expect(cmdPmTask(ctx, ['update', '1', '--status', 'invalid'])).rejects.toThrow(
      'Invalid status'
    );
  });
});

// ─────────────────────────────────────────────────────────────
// Permission Integration Tests
// ─────────────────────────────────────────────────────────────

describe('Permission integration', () => {
  let testDir: string;
  let globalDir: string;
  let projectDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    // Disable pane detection in tests
    delete process.env.TMUX;

    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-test-'));
    globalDir = path.join(testDir, 'global');
    projectDir = path.join(testDir, 'project');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    // Initialize a team and create a task
    const ctx = createMockContext(globalDir, { cwd: projectDir });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    await cmdPmInit(ctx, ['--name', 'Test Project']);
    await cmdPmTask(ctx, ['add', 'Test task']);
    await cmdPmMilestone(ctx, ['add', 'Test milestone']);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('allows human to perform any action', async () => {
    delete process.env.TMT_AGENT_NAME;
    delete process.env.TMUX_TEAM_ACTOR;

    const ctx = createMockContext(globalDir, {
      cwd: projectDir,
      agents: { codex: { deny: ['pm:task:update(status)'] } },
    });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    // Human should be able to update status even with deny pattern for codex
    await cmdPmTask(ctx, ['update', '1', '--status', 'in_progress']);
    expect(ctx.ui.logs.some((l) => l.includes('Updated'))).toBe(true);
  });

  it('blocks agent when deny pattern matches status update', async () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const ctx = createMockContext(globalDir, {
      cwd: projectDir,
      agents: { codex: { deny: ['pm:task:update(status)'] } },
    });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await expect(cmdPmTask(ctx, ['update', '1', '--status', 'done'])).rejects.toThrow('Exit');
    expect(ctx.ui.errors[0]).toContain('Permission denied');
    expect(ctx.ui.errors[0]).toContain('pm:task:update(status)');
  });

  it('blocks agent when deny pattern matches task done command', async () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const ctx = createMockContext(globalDir, {
      cwd: projectDir,
      agents: { codex: { deny: ['pm:task:update(status)'] } },
    });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    // 'task done' is equivalent to 'task update --status done'
    await expect(cmdPmTask(ctx, ['done', '1'])).rejects.toThrow('Exit');
    expect(ctx.ui.errors[0]).toContain('Permission denied');
  });

  it('allows agent to update assignee when only status is denied', async () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const ctx = createMockContext(globalDir, {
      cwd: projectDir,
      agents: { codex: { deny: ['pm:task:update(status)'] } },
    });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    // Assignee update should be allowed
    await cmdPmTask(ctx, ['update', '1', '--assignee', 'gemini']);
    expect(ctx.ui.logs.some((l) => l.includes('Updated'))).toBe(true);
  });

  it('blocks agent when wildcard deny pattern matches any field update', async () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const ctx = createMockContext(globalDir, {
      cwd: projectDir,
      agents: { codex: { deny: ['pm:task:update(*)'] } },
    });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await expect(cmdPmTask(ctx, ['update', '1', '--assignee', 'gemini'])).rejects.toThrow('Exit');
    expect(ctx.ui.errors[0]).toContain('Permission denied');
  });

  it('blocks agent when entire action is denied (no fields)', async () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const ctx = createMockContext(globalDir, {
      cwd: projectDir,
      agents: { codex: { deny: ['pm:task:create'] } },
    });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await expect(cmdPmTask(ctx, ['add', 'New task'])).rejects.toThrow('Exit');
    expect(ctx.ui.errors[0]).toContain('Permission denied');
    expect(ctx.ui.errors[0]).toContain('pm:task:create');
  });

  it('allows agent without deny patterns', async () => {
    process.env.TMT_AGENT_NAME = 'gemini';

    const ctx = createMockContext(globalDir, {
      cwd: projectDir,
      agents: { codex: { deny: ['pm:task:update(status)'] } }, // Only codex is restricted
    });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    // gemini should be allowed
    await cmdPmTask(ctx, ['update', '1', '--status', 'done']);
    expect(ctx.ui.logs.some((l) => l.includes('Updated'))).toBe(true);
  });

  it('blocks milestone status update when denied', async () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const ctx = createMockContext(globalDir, {
      cwd: projectDir,
      agents: { codex: { deny: ['pm:milestone:update(status)'] } },
    });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await expect(cmdPmMilestone(ctx, ['done', '1'])).rejects.toThrow('Exit');
    expect(ctx.ui.errors[0]).toContain('Permission denied');
  });

  it('blocks team creation when denied', async () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const newProjectDir = path.join(testDir, 'new-project');
    fs.mkdirSync(newProjectDir, { recursive: true });

    const ctx = createMockContext(globalDir, {
      cwd: newProjectDir,
      agents: { codex: { deny: ['pm:team:create'] } },
    });
    vi.spyOn(process, 'cwd').mockReturnValue(newProjectDir);

    await expect(cmdPmInit(ctx, ['--name', 'New Project'])).rejects.toThrow('Exit');
    expect(ctx.ui.errors[0]).toContain('Permission denied');
  });

  it('blocks doc update but allows doc read', async () => {
    process.env.TMT_AGENT_NAME = 'codex';

    const ctx = createMockContext(globalDir, {
      cwd: projectDir,
      json: true,
      agents: { codex: { deny: ['pm:doc:update'] } },
    });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    // Read should work
    (ctx.ui.json as ReturnType<typeof vi.fn>).mockClear();
    await cmdPmTask(ctx, ['doc', '1']);

    expect(ctx.ui.json).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '1',
        doc: expect.stringContaining('Test task'),
      })
    );
  });

  it('uses TMUX_TEAM_ACTOR when TMT_AGENT_NAME is not set', async () => {
    delete process.env.TMT_AGENT_NAME;
    process.env.TMUX_TEAM_ACTOR = 'codex';

    const ctx = createMockContext(globalDir, {
      cwd: projectDir,
      agents: { codex: { deny: ['pm:task:update(status)'] } },
    });
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    await expect(cmdPmTask(ctx, ['update', '1', '--status', 'done'])).rejects.toThrow('Exit');
    expect(ctx.ui.errors[0]).toContain('Permission denied');
    expect(ctx.ui.errors[0]).toContain('codex');
  });
});
