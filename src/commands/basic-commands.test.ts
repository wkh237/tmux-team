import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Context, Flags, Paths, ResolvedConfig, Tmux, UI } from '../types.js';
import { ExitCodes } from '../exits.js';

import { cmdInit } from './init.js';
import { cmdAdd } from './add.js';
import { cmdRemove } from './remove.js';
import { cmdUpdate } from './update.js';
import { cmdList } from './list.js';
import { cmdCheck } from './check.js';
import { cmdPreamble } from './preamble.js';
import { cmdConfig } from './config.js';
import { cmdCompletion } from './completion.js';
import { cmdHelp } from './help.js';
import { cmdLearn } from './learn.js';

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
    defaults: { timeout: 180, pollInterval: 1, captureLines: 100, preambleEvery: 3 },
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

  it('cmdAdd creates config if missing and writes new agent', () => {
    const ctx = createCtx(testDir);
    cmdAdd(ctx, 'codex', '1.1', 'review');
    const saved = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved.codex.pane).toBe('1.1');
    expect(saved.codex.remark).toBe('review');
  });

  it('cmdAdd errors if agent exists', () => {
    const ctx = createCtx(testDir, { config: { paneRegistry: { codex: { pane: '1.1' } } } });
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({ codex: { pane: '1.1' } }, null, 2));
    expect(() => cmdAdd(ctx, 'codex', '1.1')).toThrow(`exit(${ExitCodes.ERROR})`);
  });

  it('cmdRemove deletes agent', () => {
    const ctx = createCtx(testDir, { config: { paneRegistry: { codex: { pane: '1.1' } } } });
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({ codex: { pane: '1.1' } }, null, 2));
    cmdRemove(ctx, 'codex');
    const saved = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved.codex).toBeUndefined();
  });

  it('cmdUpdate updates pane and remark; creates entry if missing', () => {
    const ctx = createCtx(testDir, { config: { paneRegistry: { codex: { pane: '1.1' } } } });
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({}, null, 2));
    cmdUpdate(ctx, 'codex', { pane: '2.2', remark: 'new' });
    const saved = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved.codex.pane).toBe('2.2');
    expect(saved.codex.remark).toBe('new');
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

  it('cmdList prints table when agents exist', () => {
    const ctx = createCtx(testDir, {
      config: { paneRegistry: { claude: { pane: '1.0', remark: 'main' } } },
    });
    cmdList(ctx);
    expect(ctx.ui.table).toHaveBeenCalled();
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

  it('cmdCompletion prints scripts', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdCompletion('bash');
    expect(logSpy.mock.calls.join('\n')).toContain('complete -F _tmux_team');

    logSpy.mockClear();
    cmdCompletion('zsh');
    expect(logSpy.mock.calls.join('\n')).toContain('#compdef tmux-team');
  });

  it('cmdHelp/cmdLearn print output', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cmdHelp({ mode: 'polling', showIntro: true });
    cmdHelp({ mode: 'wait', timeout: 10 });
    cmdLearn();
    expect(logSpy).toHaveBeenCalled();
  });
});
