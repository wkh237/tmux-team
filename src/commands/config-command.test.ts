import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Context, Flags, Paths, ResolvedConfig, Tmux, UI } from '../types.js';
import { ExitCodes } from '../exits.js';
import { cmdConfig, type ConfigRequest } from './config.js';

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

function createCtx(
  testDir: string,
  flags?: Partial<Flags>,
  configOverrides?: Partial<ResolvedConfig>
): Context {
  const paths: Paths = {
    globalDir: path.join(testDir, 'global'),
    globalConfig: path.join(testDir, 'global', 'config.json'),
    localConfig: path.join(testDir, 'tmux-team.json'),
    stateFile: path.join(testDir, 'global', 'state.json'),
    databaseFile: path.join(testDir, 'global', 'tmux-team.db'),
  };
  const config: ResolvedConfig = {
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
    ...configOverrides,
  };
  const tmux: Tmux = {
    send: vi.fn(),
    capture: vi.fn(),
    listPanes: vi.fn(() => []),
    getCurrentPaneId: vi.fn(() => null),
    resolvePaneTarget: vi.fn((target: string) => target),
    setPaneTitle: vi.fn(),
  };
  return {
    argv: [],
    flags: { json: false, verbose: false, ...flags } as Flags,
    ui: createMockUI(),
    config,
    tmux,
    identityService: {
      bindCurrent: vi.fn(),
      bindPane: vi.fn(),
      unbindCurrent: vi.fn(),
      currentIdentity: vi.fn(),
      activeIdentities: vi.fn(() => []),
      resolveActive: vi.fn(),
      reconcile: vi.fn(),
    },
    paths,
    exit: ((code: number) => {
      const err = new Error(`exit(${code})`);
      (err as Error & { exitCode: number }).exitCode = code;
      throw err;
    }) as any,
  };
}

describe('cmdConfig', () => {
  let testDir = '';

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-configcmd-'));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('shows config as JSON when --json', () => {
    const ctx = createCtx(testDir, { json: true });
    cmdConfig(ctx, configRequest('show'));
    expect((ctx.ui as any).jsonCalls.length).toBe(1);
    const out = (ctx.ui as any).jsonCalls[0] as any;
    expect(out.resolved).toBeTruthy();
    expect(out.sources).toBeTruthy();
    expect(out.paths).toBeTruthy();
  });

  it('shows config as table in human mode', () => {
    const ctx = createCtx(testDir);
    cmdConfig(ctx, configRequest('show'));
    expect(ctx.ui.table).toHaveBeenCalled();
  });

  it('rejects invalid keys and values', () => {
    const ctx = createCtx(testDir);
    expect(() =>
      cmdConfig(ctx, configRequest('set', { key: 'nope', value: 'x', global: false }))
    ).toThrow(`exit(${ExitCodes.ERROR})`);
    expect(() =>
      cmdConfig(ctx, configRequest('set', { key: 'mode', value: 'nope', global: false }))
    ).toThrow(`exit(${ExitCodes.ERROR})`);
    expect(() =>
      cmdConfig(ctx, configRequest('set', { key: 'preambleEvery', value: '-1', global: false }))
    ).toThrow(`exit(${ExitCodes.ERROR})`);
  });

  it('sets and clears local settings', () => {
    const ctx = createCtx(testDir);
    cmdConfig(ctx, configRequest('set', { key: 'preambleMode', value: 'disabled', global: false }));
    const saved = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved.$config.preambleMode).toBe('disabled');

    cmdConfig(ctx, configRequest('clear'));
    const saved2 = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved2.$config).toBeUndefined();
  });

  it('sets global settings with -g', () => {
    const ctx = createCtx(testDir);
    cmdConfig(ctx, configRequest('set', { key: 'preambleEvery', value: '5', global: true }));
    const saved = JSON.parse(fs.readFileSync(ctx.paths.globalConfig, 'utf-8'));
    expect(saved.defaults.preambleEvery).toBe(5);
  });

  it('shows local source when local config has settings', () => {
    const ctx = createCtx(testDir, { json: true });
    // Create local config with all settings
    fs.writeFileSync(
      ctx.paths.localConfig,
      JSON.stringify({
        $config: { mode: 'wait', preambleMode: 'disabled', preambleEvery: 5 },
      })
    );
    cmdConfig(ctx, configRequest('show'));
    const out = (ctx.ui as any).jsonCalls[0] as any;
    expect(out.sources.mode).toBe('local');
    expect(out.sources.preambleMode).toBe('local');
    expect(out.sources.preambleEvery).toBe('local');
  });

  it('shows global source when only global config has settings', () => {
    const ctx = createCtx(testDir, { json: true });
    // Create global config with settings
    fs.mkdirSync(ctx.paths.globalDir, { recursive: true });
    fs.writeFileSync(
      ctx.paths.globalConfig,
      JSON.stringify({
        mode: 'wait',
        preambleMode: 'disabled',
        defaults: { preambleEvery: 7 },
      })
    );
    cmdConfig(ctx, configRequest('show'));
    const out = (ctx.ui as any).jsonCalls[0] as any;
    expect(out.sources.mode).toBe('global');
    expect(out.sources.preambleMode).toBe('global');
    expect(out.sources.preambleEvery).toBe('global');
  });

  it('shows default source when no config has settings', () => {
    const ctx = createCtx(testDir, { json: true });
    cmdConfig(ctx, configRequest('show'));
    const out = (ctx.ui as any).jsonCalls[0] as any;
    expect(out.sources.mode).toBe('default');
    expect(out.sources.preambleMode).toBe('default');
    expect(out.sources.preambleEvery).toBe('default');
  });

  it('shows sources in table mode with local settings', () => {
    const ctx = createCtx(testDir);
    fs.writeFileSync(ctx.paths.localConfig, JSON.stringify({ $config: { mode: 'wait' } }));
    cmdConfig(ctx, configRequest('show'));
    expect(ctx.ui.table).toHaveBeenCalled();
    // The table call should include (local) source
    const tableCall = (ctx.ui.table as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(tableCall[1].some((row: string[]) => row[2]?.includes('local'))).toBe(true);
  });

  it('shows sources in table mode with global settings', () => {
    const ctx = createCtx(testDir);
    fs.mkdirSync(ctx.paths.globalDir, { recursive: true });
    fs.writeFileSync(ctx.paths.globalConfig, JSON.stringify({ mode: 'wait' }));
    cmdConfig(ctx, configRequest('show'));
    expect(ctx.ui.table).toHaveBeenCalled();
    const tableCall = (ctx.ui.table as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(tableCall[1].some((row: string[]) => row[2]?.includes('global'))).toBe(true);
  });

  it('sets global mode and preambleMode', () => {
    const ctx = createCtx(testDir);
    cmdConfig(ctx, configRequest('set', { key: 'mode', value: 'wait', global: true }));
    cmdConfig(ctx, configRequest('set', { key: 'preambleMode', value: 'disabled', global: true }));
    const saved = JSON.parse(fs.readFileSync(ctx.paths.globalConfig, 'utf-8'));
    expect(saved.mode).toBe('wait');
    expect(saved.preambleMode).toBe('disabled');
  });
});
