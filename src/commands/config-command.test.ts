import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Context, Flags, Paths, ResolvedConfig, Tmux, UI } from '../types.js';
import { ExitCodes } from '../exits.js';
import { cmdConfig } from './config.js';

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
  };
  const config: ResolvedConfig = {
    mode: 'polling',
    preambleMode: 'always',
    defaults: { timeout: 180, pollInterval: 1, captureLines: 100, preambleEvery: 3 },
    agents: {},
    paneRegistry: {},
    ...configOverrides,
  };
  const tmux: Tmux = {
    send: vi.fn(),
    capture: vi.fn(),
    listPanes: vi.fn(() => []),
    getCurrentPaneId: vi.fn(() => null),
  };
  return {
    argv: [],
    flags: { json: false, verbose: false, ...(flags ?? {}) } as Flags,
    ui: createMockUI(),
    config,
    tmux,
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
    cmdConfig(ctx, ['show']);
    expect((ctx.ui as any).jsonCalls.length).toBe(1);
    const out = (ctx.ui as any).jsonCalls[0] as any;
    expect(out.resolved).toBeTruthy();
    expect(out.sources).toBeTruthy();
    expect(out.paths).toBeTruthy();
  });

  it('shows config as table in human mode', () => {
    const ctx = createCtx(testDir);
    cmdConfig(ctx, ['show']);
    expect(ctx.ui.table).toHaveBeenCalled();
  });

  it('rejects invalid keys and values', () => {
    const ctx = createCtx(testDir);
    expect(() => cmdConfig(ctx, ['set', 'nope', 'x'])).toThrow(`exit(${ExitCodes.ERROR})`);
    expect(() => cmdConfig(ctx, ['set', 'mode', 'nope'])).toThrow(`exit(${ExitCodes.ERROR})`);
    expect(() => cmdConfig(ctx, ['set', 'preambleEvery', '-1'])).toThrow(
      `exit(${ExitCodes.ERROR})`
    );
  });

  it('sets and clears local settings', () => {
    const ctx = createCtx(testDir);
    cmdConfig(ctx, ['set', 'preambleMode', 'disabled']);
    const saved = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved.$config.preambleMode).toBe('disabled');

    cmdConfig(ctx, ['clear']);
    const saved2 = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved2.$config).toBeUndefined();
  });

  it('sets global settings with -g', () => {
    const ctx = createCtx(testDir);
    cmdConfig(ctx, ['set', 'preambleEvery', '5', '-g']);
    const saved = JSON.parse(fs.readFileSync(ctx.paths.globalConfig, 'utf-8'));
    expect(saved.defaults.preambleEvery).toBe(5);
  });
});
