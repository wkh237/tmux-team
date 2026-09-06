import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Context, Flags, Paths, ResolvedConfig, Tmux, UI } from '../types.js';
import { ExitCodes } from '../exits.js';
import { cmdConfig } from './config.js';
import type { ConfigRequest } from '../cli/requests.js';

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
    preambleMode: 'always',
    defaults: {
      timeout: 180,
      pollInterval: 1,
      captureLines: 100,
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
    get requestService(): Context['requestService'] {
      throw new Error('Unexpected request service access.');
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

  it('preserves an opaque local mode key during unrelated settings writes', () => {
    const ctx = createCtx(testDir);
    fs.writeFileSync(
      ctx.paths.localConfig,
      JSON.stringify({ keep: { value: true }, $config: { mode: 'wait' } })
    );
    cmdConfig(ctx, configRequest('set', { key: 'preambleEvery', value: '5', global: false }));
    expect(JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf8'))).toEqual({
      keep: { value: true },
      $config: { mode: 'wait', preambleEvery: 5 },
    });
  });

  it('sets global settings with -g', () => {
    const ctx = createCtx(testDir);
    cmdConfig(ctx, configRequest('set', { key: 'preambleEvery', value: '5', global: true }));
    const saved = JSON.parse(fs.readFileSync(ctx.paths.globalConfig, 'utf-8'));
    expect(saved.defaults.preambleEvery).toBe(5);
  });

  it('preserves an opaque global mode key during unrelated settings writes', () => {
    const ctx = createCtx(testDir);
    fs.mkdirSync(ctx.paths.globalDir, { recursive: true });
    fs.writeFileSync(ctx.paths.globalConfig, JSON.stringify({ mode: 'wait', keep: true }));
    cmdConfig(ctx, configRequest('set', { key: 'preambleMode', value: 'disabled', global: true }));
    expect(JSON.parse(fs.readFileSync(ctx.paths.globalConfig, 'utf8'))).toEqual({
      mode: 'wait',
      keep: true,
      preambleMode: 'disabled',
    });
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
    expect(out.resolved).not.toHaveProperty('mode');
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
    expect(out.sources.preambleMode).toBe('global');
    expect(out.sources.preambleEvery).toBe('global');
  });

  it('shows default source when no config has settings', () => {
    const ctx = createCtx(testDir, { json: true });
    cmdConfig(ctx, configRequest('show'));
    const out = (ctx.ui as any).jsonCalls[0] as any;
    expect(out.sources.preambleMode).toBe('default');
    expect(out.sources.preambleEvery).toBe('default');
  });

  it('shows sources in table mode with local settings', () => {
    const ctx = createCtx(testDir);
    fs.writeFileSync(
      ctx.paths.localConfig,
      JSON.stringify({ $config: { preambleMode: 'disabled' } })
    );
    cmdConfig(ctx, configRequest('show'));
    expect(ctx.ui.table).toHaveBeenCalled();
    // The table call should include (local) source
    const tableCall = (ctx.ui.table as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(tableCall[1].some((row: string[]) => row[2]?.includes('local'))).toBe(true);
  });

  it('shows sources in table mode with global settings', () => {
    const ctx = createCtx(testDir);
    fs.mkdirSync(ctx.paths.globalDir, { recursive: true });
    fs.writeFileSync(ctx.paths.globalConfig, JSON.stringify({ preambleMode: 'disabled' }));
    cmdConfig(ctx, configRequest('show'));
    expect(ctx.ui.table).toHaveBeenCalled();
    const tableCall = (ctx.ui.table as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(tableCall[1].some((row: string[]) => row[2]?.includes('global'))).toBe(true);
  });

  it('rejects obsolete mode writes, including global writes', () => {
    const ctx = createCtx(testDir);
    expect(() =>
      cmdConfig(ctx, configRequest('set', { key: 'mode', value: 'wait', global: true }))
    ).toThrow(`exit(${ExitCodes.ERROR})`);
    expect(fs.existsSync(ctx.paths.globalConfig)).toBe(false);
  });

  it('uses strict integer syntax and preserves partial global defaults', () => {
    const ctx = createCtx(testDir);
    fs.mkdirSync(ctx.paths.globalDir, { recursive: true });
    fs.writeFileSync(
      ctx.paths.globalConfig,
      JSON.stringify({ keep: true, defaults: { timeout: 120, future: { enabled: true } } })
    );

    cmdConfig(ctx, configRequest('set', { key: 'preambleEvery', value: '5', global: true }));
    expect(JSON.parse(fs.readFileSync(ctx.paths.globalConfig, 'utf8'))).toEqual({
      keep: true,
      defaults: { timeout: 120, future: { enabled: true }, preambleEvery: 5 },
    });

    for (const value of ['5.5', '5junk', '5\n', '9007199254740992']) {
      expect(() =>
        cmdConfig(ctx, configRequest('set', { key: 'preambleEvery', value, global: false }))
      ).toThrow(`exit(${ExitCodes.ERROR})`);
    }
  });

  it('repairs the selected invalid field but rejects an unrelated invalid field before writing', () => {
    const ctx = createCtx(testDir);
    fs.mkdirSync(ctx.paths.globalDir, { recursive: true });
    fs.writeFileSync(
      ctx.paths.globalConfig,
      JSON.stringify({ defaults: { preambleEvery: 'bad', captureLines: 100 } })
    );
    cmdConfig(ctx, configRequest('set', { key: 'preambleEvery', value: '5', global: true }));
    expect(JSON.parse(fs.readFileSync(ctx.paths.globalConfig, 'utf8')).defaults).toEqual({
      preambleEvery: 5,
      captureLines: 100,
    });

    const original = JSON.stringify({ defaults: { preambleEvery: 3, captureLines: 'bad' } });
    fs.writeFileSync(ctx.paths.globalConfig, original);
    expect(() =>
      cmdConfig(ctx, configRequest('set', { key: 'preambleEvery', value: '5', global: true }))
    ).toThrow(/Invalid configuration/);
    expect(fs.readFileSync(ctx.paths.globalConfig, 'utf8')).toBe(original);
  });
});
