import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Context, Flags, Paths, ResolvedConfig, Tmux, UI } from '../types.js';
import { ExitCodes } from '../exits.js';

function createMockUI(): UI {
  return {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    table: vi.fn(),
    json: vi.fn(),
  };
}

function createCtx(testDir: string, tmux: Tmux, flags?: Partial<Flags>): Context {
  const paths: Paths = {
    globalDir: testDir,
    globalConfig: path.join(testDir, 'config.json'),
    localConfig: path.join(testDir, 'tmux-team.json'),
    stateFile: path.join(testDir, 'state.json'),
  };
  const config: ResolvedConfig = {
    mode: 'polling',
    preambleMode: 'always',
    defaults: { timeout: 180, pollInterval: 1, captureLines: 100, maxCaptureLines: 2000, preambleEvery: 3 },
    agents: {},
    paneRegistry: {},
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

describe('cmdSetup', () => {
  let testDir = '';
  const originalTmux = process.env.TMUX;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmux-team-setup-'));
  });

  afterEach(() => {
    process.env.TMUX = originalTmux;
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('errors when not in tmux', async () => {
    vi.resetModules();
    delete process.env.TMUX;
    const { cmdSetup } = await import('./setup.js');
    const ctx = createCtx(testDir, {
      send: vi.fn(),
      capture: vi.fn(),
      listPanes: vi.fn(() => []),
      getCurrentPaneId: vi.fn(() => null),
    });
    await expect(cmdSetup(ctx)).rejects.toThrow(`exit(${ExitCodes.ERROR})`);
  });

  it('creates tmux-team.json by configuring panes', async () => {
    vi.resetModules();
    process.env.TMUX = '1';

    const answers = [
      '', // accept default "codex" for pane %1
      'reviewer', // remark
      '1bad', // invalid name for pane %2 -> skipped
      '', // remark (unused)
    ];

    vi.doMock('readline', () => ({
      default: {
        createInterface: () => ({
          question: (_q: string, cb: (a: string) => void) => cb(answers.shift() ?? ''),
          close: () => {},
        }),
      },
      createInterface: () => ({
        question: (_q: string, cb: (a: string) => void) => cb(answers.shift() ?? ''),
        close: () => {},
      }),
    }));

    const { cmdSetup } = await import('./setup.js');
    const ctx = createCtx(testDir, {
      send: vi.fn(),
      capture: vi.fn(),
      getCurrentPaneId: vi.fn(() => '%0'),
      listPanes: vi.fn(() => [
        { id: '%0', command: 'zsh', suggestedName: null },
        { id: '%1', command: 'codex', suggestedName: 'codex' },
        { id: '%2', command: 'zsh', suggestedName: null },
      ]),
    });

    await cmdSetup(ctx);
    const saved = JSON.parse(fs.readFileSync(ctx.paths.localConfig, 'utf-8'));
    expect(saved.codex.pane).toBe('%1');
    expect(saved.codex.remark).toBe('reviewer');
  });

  it('errors when no panes found', async () => {
    vi.resetModules();
    process.env.TMUX = '1';
    vi.doMock('readline', () => ({
      default: {
        createInterface: () => ({
          question: (_q: string, cb: (a: string) => void) => cb(''),
          close: () => {},
        }),
      },
      createInterface: () => ({
        question: (_q: string, cb: (a: string) => void) => cb(''),
        close: () => {},
      }),
    }));
    const { cmdSetup } = await import('./setup.js');
    const ctx = createCtx(testDir, {
      send: vi.fn(),
      capture: vi.fn(),
      getCurrentPaneId: vi.fn(() => '%0'),
      listPanes: vi.fn(() => []),
    });
    await expect(cmdSetup(ctx)).rejects.toThrow(`exit(${ExitCodes.ERROR})`);
  });

  it('exits success when user skips all panes', async () => {
    vi.resetModules();
    process.env.TMUX = '1';

    const answers = [
      '', // pane %1 has no suggested name -> press Enter to skip
    ];
    vi.doMock('readline', () => ({
      default: {
        createInterface: () => ({
          question: (_q: string, cb: (a: string) => void) => cb(answers.shift() ?? ''),
          close: () => {},
        }),
      },
      createInterface: () => ({
        question: (_q: string, cb: (a: string) => void) => cb(answers.shift() ?? ''),
        close: () => {},
      }),
    }));

    const { cmdSetup } = await import('./setup.js');
    const ctx = createCtx(testDir, {
      send: vi.fn(),
      capture: vi.fn(),
      getCurrentPaneId: vi.fn(() => '%0'),
      listPanes: vi.fn(() => [
        { id: '%0', command: 'zsh', suggestedName: null },
        { id: '%1', command: 'zsh', suggestedName: null },
      ]),
    });

    await expect(cmdSetup(ctx)).rejects.toThrow(`exit(${ExitCodes.SUCCESS})`);
  });
});
