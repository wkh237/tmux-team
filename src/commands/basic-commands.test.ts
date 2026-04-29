import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Context, Flags, Paths, ResolvedConfig, Tmux, UI } from '../types.js';
import { ExitCodes } from '../exits.js';

import { cmdInit } from './init.js';
import { cmdAdd } from './add.js';
import { cmdThis } from './this.js';
import { cmdRemove } from './remove.js';
import { cmdUpdate } from './update.js';
import { cmdList } from './list.js';
import { cmdCheck } from './check.js';
import { cmdPreamble } from './preamble.js';
import { cmdConfig } from './config.js';
import { cmdCompletion } from './completion.js';
import { cmdHelp } from './help.js';
import { cmdLearn } from './learn.js';
import { cmdMigrate } from './migrate.js';
import { cmdTeam } from './team.js';

function createMockUI(): UI & { jsonCalls: unknown[] } {
  return {
    jsonCalls: [],
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    table: vi.fn(),
    json(data: unknown) {
      (this as any).jsonCalls.push(data);
    },
  } as any;
}

function createMockTmux(): Tmux {
  return {
    send: vi.fn(),
    capture: vi.fn(() => 'captured'),
    listPanes: vi.fn(() => []),
    getCurrentPaneId: vi.fn(() => null),
    resolvePaneTarget: vi.fn((target: string) => target),
    getAgentRegistry: vi.fn(() => ({ paneRegistry: {}, agents: {} })),
    setAgentRegistration: vi.fn(),
    clearAgentRegistration: vi.fn(() => false),
    listTeams: vi.fn(() => ({})),
    listTeamPanes: vi.fn(() => []),
    removeTeam: vi.fn(() => ({ removed: 0, agents: [] })),
  };
}

function createCtx(
  testDir: string,
  overrides?: Partial<{ flags: Partial<Flags>; config: Partial<ResolvedConfig> }>
): Context {
  const paths: Paths = {
    globalDir: testDir,
    globalConfig: path.join(testDir, 'config.json'),
    localConfig: path.join(testDir, 'tmux-team.json'),
    stateFile: path.join(testDir, 'state.json'),
  };
  const baseConfig: ResolvedConfig = {
    mode: 'polling',
    preambleMode: 'always',
    defaults: {
      timeout: 180,
      pollInterval: 1,
      captureLines: 100,
      maxCaptureLines: 2000,
      preambleEvery: 3,
      pasteEnterDelayMs: 500,
    },
    agents: {},
    paneRegistry: {},
    ...overrides?.config,
  };
  const flags: Flags = { json: false, verbose: false, ...(overrides?.flags ?? {}) } as Flags;
  const ui = createMockUI();
  const tmux = createMockTmux();
  return {
    argv: [],
    flags,
    ui,
    config: baseConfig,
    tmux,
    paths,
    exit: ((code: number) => {
      const err = new Error(`exit(${code})`);
      (err as Error & { exitCode: number }).exitCode = code;
      throw err;
    }) as any,
  };
}

describe('basic commands', () => {
  let testDir = '';

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-cmd-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('cmdInit creates tmux-team.json', () => {
    const ctx = createCtx(testDir);
    cmdInit(ctx);
    expect(fs.existsSync(ctx.paths.localConfig)).toBe(true);
  });

  it('cmdInit errors if tmux-team.json exists', () => {
    const ctx = createCtx(testDir);
    fs.writeFileSync(ctx.paths.localConfig, '{}\n');
    expect(() => cmdInit(ctx)).toThrow(`exit(${ExitCodes.ERROR})`);
  });

  it('cmdInit outputs JSON when --json flag set', () => {
    const ctx = createCtx(testDir, { flags: { json: true } });
    cmdInit(ctx);
    expect((ctx.ui as any).jsonCalls.length).toBe(1);
    expect((ctx.ui as any).jsonCalls[0]).toMatchObject({ created: ctx.paths.localConfig });
  });

  it('cmdAdd writes new agent to tmux metadata', () => {
    const ctx = createCtx(testDir);
    cmdAdd(ctx, 'codex', '1.1', 'review');
    expect(ctx.tmux.setAgentRegistration).toHaveBeenCalledWith(
      '1.1',
      expect.objectContaining({ type: 'workspace' }),
      { name: 'codex', remark: 'review' }
    );
  });

  it('cmdAdd errors if agent exists', () => {
    const ctx = createCtx(testDir, { config: { paneRegistry: { codex: { pane: '1.1' } } } });
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({ codex: { pane: '1.1' } }, null, 2));
    expect(() => cmdAdd(ctx, 'codex', '1.1')).toThrow(`exit(${ExitCodes.ERROR})`);
  });

  it('cmdThis registers current pane with given name', () => {
    const ctx = createCtx(testDir);
    (ctx.tmux.getCurrentPaneId as ReturnType<typeof vi.fn>).mockReturnValue('%5');
    cmdThis(ctx, 'myagent', 'test remark');
    expect(ctx.tmux.setAgentRegistration).toHaveBeenCalledWith(
      '%5',
      expect.objectContaining({ type: 'workspace' }),
      { name: 'myagent', remark: 'test remark' }
    );
  });

  it('cmdThis errors when not in tmux', () => {
    const ctx = createCtx(testDir);
    (ctx.tmux.getCurrentPaneId as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect(() => cmdThis(ctx, 'myagent')).toThrow(`exit(${ExitCodes.ERROR})`);
    expect(ctx.ui.error).toHaveBeenCalledWith('Not running inside tmux.');
  });

  it('cmdThis outputs JSON when --json flag set', () => {
    const ctx = createCtx(testDir, { flags: { json: true } });
    (ctx.tmux.getCurrentPaneId as ReturnType<typeof vi.fn>).mockReturnValue('%3');
    cmdThis(ctx, 'jsonagent');
    expect((ctx.ui as any).jsonCalls.length).toBe(1);
    expect((ctx.ui as any).jsonCalls[0]).toMatchObject({ added: 'jsonagent', pane: '%3' });
  });

  it('cmdRemove deletes agent', () => {
    const ctx = createCtx(testDir, { config: { paneRegistry: { codex: { pane: '1.1' } } } });
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({ codex: { pane: '1.1' } }, null, 2));
    cmdRemove(ctx, 'codex');
    const saved = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved.codex).toBeUndefined();
  });

  it('cmdRemove errors when agent not found', () => {
    const ctx = createCtx(testDir);
    expect(() => cmdRemove(ctx, 'notfound')).toThrow(`exit(${ExitCodes.PANE_NOT_FOUND})`);
    expect(ctx.ui.error).toHaveBeenCalledWith("Agent 'notfound' not found.");
  });

  it('cmdRemove outputs JSON when --json flag set', () => {
    const ctx = createCtx(testDir, {
      flags: { json: true },
      config: { paneRegistry: { codex: { pane: '1.1' } } },
    });
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({ codex: { pane: '1.1' } }, null, 2));
    cmdRemove(ctx, 'codex');
    expect((ctx.ui as any).jsonCalls).toEqual([{ removed: 'codex', source: 'legacy' }]);
  });

  it('cmdUpdate updates pane and remark in tmux metadata', () => {
    const ctx = createCtx(testDir, { config: { paneRegistry: { codex: { pane: '1.1' } } } });
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({}, null, 2));
    cmdUpdate(ctx, 'codex', { pane: '2.2', remark: 'new' });
    expect(ctx.tmux.clearAgentRegistration).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({ type: 'workspace' })
    );
    expect(ctx.tmux.setAgentRegistration).toHaveBeenCalledWith(
      '2.2',
      expect.objectContaining({ type: 'workspace' }),
      { name: 'codex', remark: 'new' }
    );
  });

  it('cmdUpdate errors when agent not found', () => {
    const ctx = createCtx(testDir);
    expect(() => cmdUpdate(ctx, 'notfound', { pane: '1.0' })).toThrow(
      `exit(${ExitCodes.PANE_NOT_FOUND})`
    );
    expect(ctx.ui.error).toHaveBeenCalledWith(
      "Agent 'notfound' not found. Use 'tmux-team add' to create."
    );
  });

  it('cmdUpdate errors when no updates specified', () => {
    const ctx = createCtx(testDir, { config: { paneRegistry: { codex: { pane: '1.1' } } } });
    expect(() => cmdUpdate(ctx, 'codex', {})).toThrow(`exit(${ExitCodes.ERROR})`);
    expect(ctx.ui.error).toHaveBeenCalledWith('No updates specified. Use --pane or --remark.');
  });

  it('cmdUpdate outputs JSON when --json flag set', () => {
    const ctx = createCtx(testDir, {
      flags: { json: true },
      config: { paneRegistry: { codex: { pane: '1.1' } } },
    });
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({ codex: { pane: '1.1' } }, null, 2));
    cmdUpdate(ctx, 'codex', { pane: '2.0', remark: 'updated' });
    expect((ctx.ui as any).jsonCalls).toEqual([
      { updated: 'codex', pane: '2.0', remark: 'updated' },
    ]);
  });

  it('cmdList outputs JSON when --json', () => {
    const ctx = createCtx(testDir, {
      flags: { json: true },
      config: { paneRegistry: { claude: { pane: '1.0', remark: 'main' } } },
    });
    cmdList(ctx);
    expect((ctx.ui as any).jsonCalls.length).toBe(1);
  });

  it('cmdList prints hint when no agents', () => {
    const ctx = createCtx(testDir);
    cmdList(ctx);
    expect(ctx.ui.info).toHaveBeenCalled();
  });

  it('cmdList prints team hint when no shared team agents exist', () => {
    const ctx = createCtx(testDir, { flags: { team: 'egp' } });
    cmdList(ctx);
    expect(ctx.ui.info).toHaveBeenCalledWith(
      'No agents in team "egp". Use \'tmt this <name> --team egp\' to add one.'
    );
  });

  it('cmdList prints table when agents exist', () => {
    const ctx = createCtx(testDir, {
      config: { paneRegistry: { claude: { pane: '1.0', remark: 'main' } } },
    });
    cmdList(ctx);
    expect(ctx.ui.table).toHaveBeenCalled();
  });

  it('cmdList warns when using legacy registry', () => {
    const ctx = createCtx(testDir, {
      config: { paneRegistry: { claude: { pane: '1.0' } }, registrySource: 'legacy' },
    });
    cmdList(ctx);
    expect(ctx.ui.warn).toHaveBeenCalledWith(
      'Using legacy tmux-team.json registry. Run `tmt migrate` to store registrations in tmux.'
    );
  });

  it('cmdList shows dash for missing remark', () => {
    const ctx = createCtx(testDir, {
      config: { paneRegistry: { claude: { pane: '1.0' } } }, // no remark
    });
    cmdList(ctx);
    expect(ctx.ui.table).toHaveBeenCalled();
    const tableCall = (ctx.ui.table as ReturnType<typeof vi.fn>).mock.calls[0];
    // Third column should be '-' for missing remark
    expect(tableCall[1][0][2]).toBe('-');
  });

  it('cmdCheck captures pane output', () => {
    const ctx = createCtx(testDir, {
      config: { paneRegistry: { claude: { pane: '1.0' } } },
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdCheck(ctx, 'claude', 10);
    expect(ctx.tmux.capture).toHaveBeenCalledWith('1.0', 10);
    expect(logSpy).toHaveBeenCalled();
  });

  it('cmdCheck errors when agent missing', () => {
    const ctx = createCtx(testDir);
    expect(() => cmdCheck(ctx, 'nope')).toThrow(`exit(${ExitCodes.PANE_NOT_FOUND})`);
  });

  it('cmdCheck errors when tmux capture fails', () => {
    const ctx = createCtx(testDir, {
      config: { paneRegistry: { claude: { pane: '1.0' } } },
    });
    (ctx.tmux.capture as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('tmux not running');
    });
    expect(() => cmdCheck(ctx, 'claude')).toThrow(`exit(${ExitCodes.ERROR})`);
    expect(ctx.ui.error).toHaveBeenCalledWith('Failed to capture pane 1.0. Is tmux running?');
  });

  it('cmdCheck outputs JSON when --json', () => {
    const ctx = createCtx(testDir, {
      flags: { json: true },
      config: { paneRegistry: { claude: { pane: '1.0' } } },
    });
    cmdCheck(ctx, 'claude', 5);
    expect((ctx.ui as any).jsonCalls.length).toBe(1);
  });

  it('cmdPreamble set/show/clear updates local config', () => {
    const ctx = createCtx(testDir, {
      config: { paneRegistry: { claude: { pane: '1.0' } }, agents: { claude: {} } },
    });
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({ claude: { pane: '1.0' } }, null, 2));

    cmdPreamble(ctx, ['set', 'claude', 'Be', 'concise']);
    let saved = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved.claude.preamble).toBe('Be concise');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // show will read from ctx.config.agents; update it to reflect loadConfig behavior
    ctx.config.agents.claude = { preamble: 'Be concise' };
    cmdPreamble(ctx, ['show', 'claude']);
    expect(logSpy).toHaveBeenCalled();

    cmdPreamble(ctx, ['clear', 'claude']);
    saved = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved.claude.preamble).toBeUndefined();
  });

  it('cmdPreamble set errors when agent missing', () => {
    const ctx = createCtx(testDir);
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({}, null, 2));
    expect(() => cmdPreamble(ctx, ['set', 'nope', 'x'])).toThrow(`exit(${ExitCodes.ERROR})`);
  });

  it('cmdPreamble clear returns not_set when missing', () => {
    const ctx = createCtx(testDir, { flags: { json: true } });
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({ claude: { pane: '1.0' } }, null, 2));
    cmdPreamble(ctx, ['clear', 'claude']);
    const out = (ctx.ui as any).jsonCalls[0] as any;
    expect(out.status).toBe('not_set');
  });

  it('cmdConfig set/show/clear works for local settings', () => {
    const ctx = createCtx(testDir);
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({}, null, 2));

    cmdConfig(ctx, ['set', 'mode', 'wait']);
    const saved = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved.$config.mode).toBe('wait');

    cmdConfig(ctx, ['clear', 'mode']);
    const saved2 = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved2.$config?.mode).toBeUndefined();
  });

  it('cmdConfig set supports --global', () => {
    const ctx = createCtx(testDir);
    cmdConfig(ctx, ['set', 'mode', 'wait', '--global']);
    const saved = JSON.parse(fs.readFileSync(ctx.paths.globalConfig, 'utf-8'));
    expect(saved.mode).toBe('wait');
  });

  it('cmdConfig set errors when not enough args', () => {
    const ctx = createCtx(testDir);
    expect(() => cmdConfig(ctx, ['set', 'mode'])).toThrow(`exit(${ExitCodes.ERROR})`);
    expect(ctx.ui.error).toHaveBeenCalledWith(
      'Usage: tmux-team config set <key> <value> [--global]'
    );
  });

  it('cmdConfig errors on unknown subcommand', () => {
    const ctx = createCtx(testDir);
    expect(() => cmdConfig(ctx, ['unknown'])).toThrow(`exit(${ExitCodes.ERROR})`);
    expect(ctx.ui.error).toHaveBeenCalledWith('Unknown config subcommand: unknown');
  });

  it('cmdConfig set preambleMode locally', () => {
    const ctx = createCtx(testDir);
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({}, null, 2));
    cmdConfig(ctx, ['set', 'preambleMode', 'disabled']);
    const saved = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved.$config.preambleMode).toBe('disabled');
  });

  it('cmdConfig set preambleEvery locally', () => {
    const ctx = createCtx(testDir);
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({}, null, 2));
    cmdConfig(ctx, ['set', 'preambleEvery', '5']);
    const saved = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved.$config.preambleEvery).toBe(5);
  });

  it('cmdConfig clear errors on invalid key', () => {
    const ctx = createCtx(testDir);
    expect(() => cmdConfig(ctx, ['clear', 'invalidkey'])).toThrow(`exit(${ExitCodes.ERROR})`);
    expect(ctx.ui.error).toHaveBeenCalledWith(
      'Invalid key: invalidkey. Valid keys: mode, preambleMode, preambleEvery, pasteEnterDelayMs'
    );
  });

  it('cmdMigrate dry-run reports legacy entries without writing tmux metadata', () => {
    const ctx = createCtx(testDir, { flags: { json: true } });
    fs.writeFileSync(
      ctx.paths.localConfig,
      JSON.stringify({ claude: { pane: '1.1', remark: 'review' } }, null, 2)
    );

    cmdMigrate(ctx, ['--dry-run']);

    expect(ctx.tmux.setAgentRegistration).not.toHaveBeenCalled();
    expect((ctx.ui as any).jsonCalls[0]).toMatchObject({
      dryRun: true,
      migrated: 0,
      items: [{ agent: 'claude', fromPane: '1.1', pane: '1.1', status: 'ready' }],
    });
  });

  it('cmdMigrate writes tmux metadata and can clean legacy entries', () => {
    const ctx = createCtx(testDir);
    fs.writeFileSync(
      ctx.paths.localConfig,
      JSON.stringify({
        $config: { mode: 'wait' },
        claude: { pane: '1.1', remark: 'review', preamble: 'Be helpful' },
      })
    );

    cmdMigrate(ctx, ['--cleanup']);

    expect(ctx.tmux.setAgentRegistration).toHaveBeenCalledWith(
      '1.1',
      expect.objectContaining({ type: 'workspace' }),
      { name: 'claude', remark: 'review', preamble: 'Be helpful' }
    );
    const saved = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved.$config.mode).toBe('wait');
    expect(saved.claude).toBeUndefined();
  });

  it('cmdMigrate errors when a legacy pane cannot be resolved', () => {
    const ctx = createCtx(testDir);
    (ctx.tmux.resolvePaneTarget as ReturnType<typeof vi.fn>).mockReturnValue(null);
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({ claude: { pane: 'missing' } }));

    expect(() => cmdMigrate(ctx, [])).toThrow(`exit(${ExitCodes.PANE_NOT_FOUND})`);
  });

  it('cmdMigrate reports when no legacy agents exist', () => {
    const ctx = createCtx(testDir);
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({ $config: { mode: 'wait' } }));

    cmdMigrate(ctx, []);

    expect(ctx.ui.info).toHaveBeenCalledWith(`No legacy agents found in ${ctx.paths.localConfig}`);
  });

  it('cmdTeam lists all pane team/workspace scopes', () => {
    const ctx = createCtx(testDir, { flags: { json: true } });
    (ctx.tmux.listTeams as ReturnType<typeof vi.fn>).mockReturnValue({
      egp: ['claude', 'codex'],
    });
    (ctx.tmux.listTeamPanes as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        pane: '%1',
        target: 'main:1.0',
        cwd: '/repo',
        command: 'claude',
        suggestedName: 'claude',
        registrations: [
          { scopeType: 'workspace', scope: '/repo', agent: 'claude', remark: 'lead' },
          { scopeType: 'team', scope: 'egp', agent: 'claude' },
        ],
      },
    ]);

    cmdTeam(ctx, ['ls']);

    expect((ctx.ui as any).jsonCalls).toEqual([
      {
        teams: { egp: ['claude', 'codex'] },
        panes: [
          {
            pane: '%1',
            target: 'main:1.0',
            cwd: '/repo',
            command: 'claude',
            suggestedName: 'claude',
            registrations: [
              { scopeType: 'workspace', scope: '/repo', agent: 'claude', remark: 'lead' },
              { scopeType: 'team', scope: 'egp', agent: 'claude' },
            ],
          },
        ],
      },
    ]);
  });

  it('cmdTeam shows empty state and errors on unknown subcommands', () => {
    const ctx = createCtx(testDir);

    cmdTeam(ctx, ['ls']);
    expect(ctx.ui.info).toHaveBeenCalledWith('No tmux panes found.');

    expect(() => cmdTeam(ctx, ['wat'])).toThrow(`exit(${ExitCodes.ERROR})`);
  });

  it('cmdTeam summary keeps shared-team aggregate view', () => {
    const ctx = createCtx(testDir);
    (ctx.tmux.listTeams as ReturnType<typeof vi.fn>).mockReturnValue({ egp: ['claude'] });

    cmdTeam(ctx, ['ls', '--summary']);

    expect(ctx.ui.table).toHaveBeenCalledWith(['TEAM', 'AGENTS'], [['egp', 'claude']]);
  });

  it('cmdTeam table groups by team/workspace scope before pane order', () => {
    const ctx = createCtx(testDir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    (ctx.tmux.listTeamPanes as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        pane: '%3',
        target: 'main:3.0',
        cwd: '/tmp',
        command: 'zsh',
        suggestedName: null,
        registrations: [],
      },
      {
        pane: '%1',
        target: 'main:1.0',
        cwd: '/repo',
        command: 'claude',
        suggestedName: 'claude',
        registrations: [{ scopeType: 'workspace', scope: '/repo', agent: 'claude' }],
      },
      {
        pane: '%2',
        target: 'main:2.0',
        cwd: '/repo',
        command: 'codex',
        suggestedName: 'codex',
        registrations: [{ scopeType: 'team', scope: 'beta', agent: 'codex' }],
      },
      {
        pane: '%4',
        target: 'main:4.0',
        cwd: '/repo',
        command: 'gemini',
        suggestedName: 'gemini',
        registrations: [{ scopeType: 'team', scope: 'alpha', agent: 'gemini' }],
      },
    ]);

    cmdTeam(ctx, ['ls']);

    expect(logSpy.mock.calls.map((call) => call[0])).toEqual([
      'Team: alpha (gemini)',
      '',
      'Team: beta (codex)',
      '',
      'Workspace: /repo (claude)',
      '',
      'Unregistered panes',
    ]);
    expect((ctx.ui.table as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])).toEqual([
      ['PANE', 'TARGET', 'CWD', 'CMD'],
      ['PANE', 'TARGET', 'CWD', 'CMD'],
      ['PANE', 'TARGET', 'CWD', 'CMD'],
      ['PANE', 'TARGET', 'CWD', 'CMD'],
    ]);
    expect((ctx.ui.table as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual([
      ['%4', 'main:4.0', '/repo', 'gemini'],
    ]);
    logSpy.mockRestore();
  });

  it('cmdTeam rm supports dry-run and force removal', () => {
    const ctx = createCtx(testDir);
    (ctx.tmux.listTeams as ReturnType<typeof vi.fn>).mockReturnValue({
      egp: ['claude'],
    });
    (ctx.tmux.removeTeam as ReturnType<typeof vi.fn>).mockReturnValue({
      removed: 1,
      agents: ['claude'],
    });

    cmdTeam(ctx, ['rm', 'egp', '--dry-run']);
    expect(ctx.tmux.removeTeam).not.toHaveBeenCalled();

    ctx.flags.force = true;
    cmdTeam(ctx, ['rm', 'egp']);
    expect(ctx.tmux.removeTeam).toHaveBeenCalledWith('egp');
  });

  it('cmdTeam rm requires --force and errors for missing teams', () => {
    const ctx = createCtx(testDir);
    (ctx.tmux.listTeams as ReturnType<typeof vi.fn>).mockReturnValue({ egp: ['claude'] });

    expect(() => cmdTeam(ctx, ['rm', 'egp'])).toThrow(`exit(${ExitCodes.ERROR})`);

    (ctx.tmux.listTeams as ReturnType<typeof vi.fn>).mockReturnValue({});
    expect(() => cmdTeam(ctx, ['rm', 'missing', '--force'])).toThrow(
      `exit(${ExitCodes.PANE_NOT_FOUND})`
    );
  });

  it('cmdTeam rm outputs JSON in dry-run and force modes', () => {
    const ctx = createCtx(testDir, { flags: { json: true } });
    (ctx.tmux.listTeams as ReturnType<typeof vi.fn>).mockReturnValue({ egp: ['claude'] });
    (ctx.tmux.removeTeam as ReturnType<typeof vi.fn>).mockReturnValue({
      removed: 1,
      agents: ['claude'],
    });

    cmdTeam(ctx, ['rm', 'egp', '--dry-run']);
    ctx.flags.force = true;
    cmdTeam(ctx, ['rm', 'egp']);

    expect((ctx.ui as any).jsonCalls).toEqual([
      { team: 'egp', dryRun: true, agents: ['claude'], removed: 0 },
      { team: 'egp', removed: 1, agents: ['claude'] },
    ]);
  });

  it('cmdCompletion prints scripts', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdCompletion('bash');
    expect(logSpy.mock.calls.join('\n')).toContain('complete -F _tmux_team');

    logSpy.mockClear();
    cmdCompletion('zsh');
    expect(logSpy.mock.calls.join('\n')).toContain('#compdef tmux-team');

    logSpy.mockClear();
    cmdCompletion();
    expect(logSpy.mock.calls.join('\n')).toContain('Shell Completion Setup');
  });

  it('cmdHelp/cmdLearn print output', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdHelp({ mode: 'polling', showIntro: true });
    cmdHelp({ mode: 'wait', timeout: 10 });
    cmdLearn();
    expect(logSpy).toHaveBeenCalled();
  });
});
