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
import { cmdPreamble, type PreambleRequest } from './preamble.js';
import { cmdConfig, type ConfigRequest } from './config.js';
import { cmdCompletion } from './completion.js';
import { cmdHelp } from './help.js';
import { cmdLearn } from './learn.js';
import { cmdMigrate, type MigrateRequest } from './migrate.js';

const preambleRequest = (
  operation: PreambleRequest['operation'],
  values: Omit<PreambleRequest, 'kind' | 'operation'> = {}
): PreambleRequest => ({ kind: 'preamble', operation, ...values });
const configRequest = (
  operation: ConfigRequest['operation'],
  values: Omit<ConfigRequest, 'kind' | 'operation'> = { global: false }
): ConfigRequest => ({ kind: 'config', operation, ...values });

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
    setPaneTitle: vi.fn(),
    getAgentRegistry: vi.fn(() => ({ paneRegistry: {}, agents: {} })),
    setAgentRegistration: vi.fn(),
    clearAgentRegistration: vi.fn(() => false),
    listGlobalIdentities: vi.fn(() => []),
    setGlobalIdentity: vi.fn(),
    clearGlobalIdentity: vi.fn(() => false),
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
  const flags: Flags = { json: false, verbose: false, ...overrides?.flags } as Flags;
  const ui = createMockUI();
  const tmux = createMockTmux();
  tmux.listGlobalIdentities = vi.fn(() =>
    Object.entries(baseConfig.paneRegistry).map(([name, entry]) => ({
      name,
      canonicalName: name.toLowerCase(),
      paneId: entry.pane,
    }))
  );
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

  it('cmdAdd writes global identity metadata', () => {
    const ctx = createCtx(testDir);
    cmdAdd(ctx, '1.1', 'codex');
    expect(ctx.tmux.setGlobalIdentity).toHaveBeenCalledWith('1.1', 'codex');
  });

  it('cmdAdd errors if agent exists', () => {
    const ctx = createCtx(testDir, { config: { paneRegistry: { codex: { pane: '1.1' } } } });
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({ codex: { pane: '1.1' } }, null, 2));
    (ctx.tmux.listGlobalIdentities as ReturnType<typeof vi.fn>).mockReturnValue([
      { name: 'codex', canonicalName: 'codex', paneId: '1.1' },
    ]);
    expect(() => cmdAdd(ctx, '1.1', 'other')).toThrow(`exit(${ExitCodes.CONFLICT})`);
  });

  it('cmdAdd rejects the v4 name-then-pane order without side effects', () => {
    const ctx = createCtx(testDir, { flags: { json: true } });

    expect(() => cmdAdd(ctx, 'codex', '1.2')).toThrow(`exit(${ExitCodes.ERROR})`);
    expect((ctx.ui as any).jsonCalls).toEqual([
      {
        error: {
          code: 'LEGACY_ADD_ORDER',
          message: 'The v4 add argument order is no longer supported.',
          suggestion: 'Use: tmt add 1.2 codex',
        },
      },
    ]);
    expect(ctx.tmux.resolvePaneTarget).not.toHaveBeenCalled();
    expect(ctx.tmux.setGlobalIdentity).not.toHaveBeenCalled();
  });

  it('cmdThis registers current pane with given name', () => {
    const ctx = createCtx(testDir);
    (ctx.tmux.getCurrentPaneId as ReturnType<typeof vi.fn>).mockReturnValue('%5');
    cmdThis(ctx, 'myagent');
    expect(ctx.tmux.setGlobalIdentity).toHaveBeenCalledWith('%5', 'myagent');
  });

  it('cmdThis errors when not in tmux', () => {
    const ctx = createCtx(testDir);
    (ctx.tmux.getCurrentPaneId as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect(() => cmdThis(ctx, 'myagent')).toThrow(`exit(${ExitCodes.PANE_NOT_FOUND})`);
    expect(ctx.ui.error).toHaveBeenCalledWith('Not running inside a resolvable tmux pane.');
  });

  it('cmdThis outputs JSON when --json flag set', () => {
    const ctx = createCtx(testDir, { flags: { json: true } });
    (ctx.tmux.getCurrentPaneId as ReturnType<typeof vi.fn>).mockReturnValue('%3');
    cmdThis(ctx, 'jsonagent');
    expect((ctx.ui as any).jsonCalls.length).toBe(1);
    expect((ctx.ui as any).jsonCalls[0]).toMatchObject({
      bound: true,
      name: 'jsonagent',
      pane: '%3',
    });
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

  it('cmdList joins one pane snapshot into the v5 identity schema', () => {
    const ctx = createCtx(testDir, { flags: { json: true } });
    ctx.tmux.listGlobalIdentities = vi.fn(() => [
      { name: 'Zed', canonicalName: 'zed', paneId: '%2' },
      { name: 'Alice', canonicalName: 'alice', paneId: '%1' },
    ]);
    ctx.tmux.listPanes = vi.fn(() => [
      { id: '%1', target: 'main:1.0', cwd: '/repo', command: 'claude', suggestedName: 'claude' },
      { id: '%2', target: 'main:1.1', cwd: '/tmp', command: 'zsh', suggestedName: null },
    ]);

    cmdList(ctx);

    expect(ctx.tmux.listPanes).toHaveBeenCalledTimes(1);
    expect((ctx.ui as any).jsonCalls).toEqual([
      {
        identities: [
          {
            name: 'Alice',
            canonicalName: 'alice',
            pane: '%1',
            target: 'main:1.0',
            cwd: '/repo',
            command: 'claude',
          },
          {
            name: 'Zed',
            canonicalName: 'zed',
            pane: '%2',
            target: 'main:1.1',
            cwd: '/tmp',
            command: 'zsh',
          },
        ],
      },
    ]);
  });

  it('cmdList resolves an unnamed direct pane without legacy fallback', () => {
    const ctx = createCtx(testDir, { flags: { json: true } });
    ctx.tmux.resolvePaneTarget = vi.fn(() => '%9');
    ctx.tmux.listGlobalIdentities = vi.fn(() => []);
    ctx.tmux.listPanes = vi.fn(() => [
      { id: '%9', target: 'main:9.0', cwd: '/tmp', command: 'zsh', suggestedName: null },
    ]);

    cmdList(ctx, '9.0');

    expect((ctx.ui as any).jsonCalls).toEqual([
      {
        target: '9.0',
        identity: null,
        pane: { id: '%9', target: 'main:9.0', cwd: '/tmp', command: 'zsh' },
      },
    ]);
  });

  it('cmdList prints hint when no agents', () => {
    const ctx = createCtx(testDir);
    cmdList(ctx);
    expect(ctx.ui.info).toHaveBeenCalled();
  });

  it('cmdList prints table when agents exist', () => {
    const ctx = createCtx(testDir, {
      config: { paneRegistry: { claude: { pane: '1.0', remark: 'main' } } },
    });
    cmdList(ctx);
    expect(ctx.ui.table).toHaveBeenCalled();
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

  it('cmdList errors when positional target is neither identity nor pane', () => {
    const ctx = createCtx(testDir);
    (ctx.tmux.resolvePaneTarget as ReturnType<typeof vi.fn>).mockReturnValue(null);

    expect(() => cmdList(ctx, 'missing')).toThrow(`exit(${ExitCodes.PANE_NOT_FOUND})`);
    expect(ctx.ui.error).toHaveBeenCalledWith("Identity 'missing' is not active.");
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

  it('cmdCheck JSON includes the stable identity fields', () => {
    const ctx = createCtx(testDir, {
      flags: { json: true },
      config: { paneRegistry: { claude: { pane: '%1' } } },
    });
    ctx.tmux.listGlobalIdentities = vi.fn(() => [
      { name: 'Claude', canonicalName: 'claude', paneId: '%1' },
    ]);
    ctx.tmux.capture = vi.fn(() => 'response');

    cmdCheck(ctx, 'claude', 5);

    expect((ctx.ui as any).jsonCalls).toEqual([
      {
        target: 'claude',
        pane: '%1',
        identity: { name: 'Claude', canonicalName: 'claude' },
        lines: 5,
        output: 'response',
      },
    ]);
  });

  it('cmdPreamble set/show/clear updates local config', () => {
    const ctx = createCtx(testDir, {
      config: { paneRegistry: { claude: { pane: '1.0' } }, agents: { claude: {} } },
    });
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({ claude: { pane: '1.0' } }, null, 2));

    cmdPreamble(ctx, preambleRequest('set', { agent: 'claude', preamble: 'Be concise' }));
    let saved = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved.claude.preamble).toBe('Be concise');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // show will read from ctx.config.agents; update it to reflect loadConfig behavior
    ctx.config.agents.claude = { preamble: 'Be concise' };
    cmdPreamble(ctx, preambleRequest('show', { agent: 'claude' }));
    expect(logSpy).toHaveBeenCalled();

    cmdPreamble(ctx, preambleRequest('clear', { agent: 'claude' }));
    saved = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved.claude.preamble).toBeUndefined();
  });

  it('cmdPreamble set errors when agent missing', () => {
    const ctx = createCtx(testDir);
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({}, null, 2));
    expect(() =>
      cmdPreamble(ctx, preambleRequest('set', { agent: 'nope', preamble: 'x' }))
    ).toThrow(`exit(${ExitCodes.ERROR})`);
  });

  it('cmdPreamble clear returns not_set when missing', () => {
    const ctx = createCtx(testDir, { flags: { json: true } });
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({ claude: { pane: '1.0' } }, null, 2));
    cmdPreamble(ctx, preambleRequest('clear', { agent: 'claude' }));
    const out = (ctx.ui as any).jsonCalls[0] as any;
    expect(out.status).toBe('not_set');
  });

  it('cmdConfig set/show/clear works for local settings', () => {
    const ctx = createCtx(testDir);
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({}, null, 2));

    cmdConfig(ctx, configRequest('set', { key: 'mode', value: 'wait', global: false }));
    const saved = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved.$config.mode).toBe('wait');

    cmdConfig(ctx, configRequest('clear', { key: 'mode', global: false }));
    const saved2 = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved2.$config?.mode).toBeUndefined();
  });

  it('cmdConfig set supports --global', () => {
    const ctx = createCtx(testDir);
    cmdConfig(ctx, configRequest('set', { key: 'mode', value: 'wait', global: true }));
    const saved = JSON.parse(fs.readFileSync(ctx.paths.globalConfig, 'utf-8'));
    expect(saved.mode).toBe('wait');
  });

  it('cmdConfig set errors when not enough args', () => {
    const ctx = createCtx(testDir);
    expect(() => cmdConfig(ctx, configRequest('set', { key: 'mode', global: false }))).toThrow(
      `exit(${ExitCodes.ERROR})`
    );
    expect(ctx.ui.error).toHaveBeenCalledWith(
      'Usage: tmux-team config set <key> <value> [--global]'
    );
  });

  it('cmdConfig rejects a set request with a missing value', () => {
    const ctx = createCtx(testDir);
    expect(() => cmdConfig(ctx, configRequest('set', { key: 'mode', global: false }))).toThrow(
      `exit(${ExitCodes.ERROR})`
    );
    expect(ctx.ui.error).toHaveBeenCalledWith(
      'Usage: tmux-team config set <key> <value> [--global]'
    );
  });

  it('cmdConfig set preambleMode locally', () => {
    const ctx = createCtx(testDir);
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({}, null, 2));
    cmdConfig(ctx, configRequest('set', { key: 'preambleMode', value: 'disabled', global: false }));
    const saved = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved.$config.preambleMode).toBe('disabled');
  });

  it('cmdConfig set preambleEvery locally', () => {
    const ctx = createCtx(testDir);
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({}, null, 2));
    cmdConfig(ctx, configRequest('set', { key: 'preambleEvery', value: '5', global: false }));
    const saved = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved.$config.preambleEvery).toBe(5);
  });

  it('cmdConfig clear errors on invalid key', () => {
    const ctx = createCtx(testDir);
    expect(() =>
      cmdConfig(ctx, configRequest('clear', { key: 'invalidkey', global: false }))
    ).toThrow(`exit(${ExitCodes.ERROR})`);
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

    cmdMigrate(ctx, { kind: 'migrate', dryRun: true, cleanup: false } satisfies MigrateRequest);

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

    cmdMigrate(ctx, { kind: 'migrate', dryRun: false, cleanup: true } satisfies MigrateRequest);

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

    expect(() => cmdMigrate(ctx, { kind: 'migrate', dryRun: false, cleanup: false })).toThrow(
      `exit(${ExitCodes.PANE_NOT_FOUND})`
    );
  });

  it('cmdMigrate reports when no legacy agents exist', () => {
    const ctx = createCtx(testDir);
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({ $config: { mode: 'wait' } }));

    cmdMigrate(ctx, { kind: 'migrate', dryRun: false, cleanup: false });

    expect(ctx.ui.info).toHaveBeenCalledWith(`No legacy agents found in ${ctx.paths.localConfig}`);
  });

  it('cmdCompletion prints scripts', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdCompletion('bash');
    const bashOutput = logSpy.mock.calls.join('\n');
    expect(bashOutput).toContain('complete -F _tmux_team');
    expect(bashOutput).toContain('name this whoami unbind');

    logSpy.mockClear();
    cmdCompletion('zsh');
    const zshOutput = logSpy.mock.calls.join('\n');
    expect(zshOutput).toContain('#compdef tmux-team');
    expect(zshOutput).toContain('name:Bind the current pane identity');
    expect(zshOutput).toContain('this:Bind the current pane identity');
    expect(zshOutput).toContain('whoami:Show the current pane identity');
    expect(zshOutput).toContain('unbind:Remove the current pane identity');

    logSpy.mockClear();
    cmdCompletion();
    expect(logSpy.mock.calls.join('\n')).toContain('Shell Completion Setup');
  });

  it('cmdHelp/cmdLearn print output', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdHelp({ mode: 'polling', showIntro: true });
    cmdHelp({ mode: 'wait', timeout: 10 });
    cmdLearn();
    const output = logSpy.mock.calls.join('\n');
    expect(output).toContain('add <pane-target> <global-name>');
    expect(output).toContain('this <global-name>');
    expect(output).toContain('name <global-name>');
    expect(output).toContain('whoami');
    expect(output).toContain('unbind');
  });
});
