import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context, UI } from './types.js';
import { ExitCodes } from './exits.js';

function baseContext(): Context {
  return {
    argv: [],
    flags: { json: true, verbose: false },
    ui: {} as UI,
    config: {} as Context['config'],
    tmux: {} as Context['tmux'],
    paths: {} as Context['paths'],
    identityService: {} as Context['identityService'],
    requestService: {} as Context['requestService'],
    exit: (() => {
      throw new Error('unconfigured exit');
    }) as Context['exit'],
    dispose: vi.fn(),
  };
}

async function loadRunner(
  options: {
    dispatch?: (ctx: Context) => Promise<void> | void;
    startup?: (ctx: Context) => Promise<void> | void;
    dispose?: () => void;
  } = {}
) {
  vi.resetModules();
  const createContext = vi.fn((contextOptions: { ui: UI; exit: Context['exit'] }) => {
    const ctx = baseContext();
    ctx.ui = contextOptions.ui;
    ctx.exit = contextOptions.exit;
    ctx.dispose = options.dispose ?? ctx.dispose;
    return ctx;
  });
  vi.doMock('./context.js', () => ({ ExitCodes, createContext }));
  vi.doMock('./cli/application.js', () => ({
    dispatchCommand: vi.fn((ctx: Context) => options.dispatch?.(ctx)),
  }));
  vi.doMock('./update-check.js', () => ({
    runStartupChecks: vi.fn((ctx: Context) => options.startup?.(ctx)),
  }));

  return { ...(await import('./cli-runner.js')), createContext };
}

function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  return { chunks, restore: () => spy.mockRestore() };
}

function document(chunks: string[]): Record<string, unknown> {
  return JSON.parse(chunks.join('')) as Record<string, unknown>;
}

describe('CLI runner lifecycle', () => {
  afterEach(() => {
    vi.doUnmock('./context.js');
    vi.doUnmock('./cli/application.js');
    vi.doUnmock('./update-check.js');
    vi.restoreAllMocks();
  });

  it('reports parse errors without creating a Context', async () => {
    const output = captureStdout();
    try {
      const { runCli, createContext } = await loadRunner();
      await expect(runCli(['--json', 'name'])).resolves.toBe(1);
      expect(document(output.chunks)).toMatchObject({ error: { code: 'USAGE_ERROR' } });
      expect(createContext).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it('disposes once when startup fails and emits an internal error', async () => {
    const output = captureStdout();
    let outputAtDisposal: string[] | undefined;
    const dispose = vi.fn(() => {
      outputAtDisposal = [...output.chunks];
    });
    try {
      const { runCli } = await loadRunner({
        dispose,
        startup: () => {
          throw new Error('startup failed');
        },
      });
      await expect(runCli(['role', 'show', '--json'])).resolves.toBe(1);
      expect(dispose).toHaveBeenCalledOnce();
      expect(outputAtDisposal).toEqual([]);
      expect(output.chunks).toHaveLength(1);
      expect(document(output.chunks)).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'startup failed' },
      });
    } finally {
      output.restore();
    }
  });

  it('preserves a primary failure when cleanup also fails', async () => {
    const output = captureStdout();
    try {
      const { runCli } = await loadRunner({
        dispose: () => {
          throw new Error('cleanup failed');
        },
        dispatch: () => {
          throw new Error('primary failed');
        },
      });
      await expect(runCli(['role', 'show', '--json'])).resolves.toBe(1);
      expect(document(output.chunks)).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'primary failed' },
      });
    } finally {
      output.restore();
    }
  });

  it('replaces pending success with cleanup failure and effects warning', async () => {
    const output = captureStdout();
    try {
      const { runCli } = await loadRunner({
        dispose: () => {
          throw new Error('close failed');
        },
        dispatch: (ctx) => {
          ctx.ui.json({ result: 'pending' });
        },
      });
      await expect(runCli(['role', 'show', '--json'])).resolves.toBe(1);
      expect(document(output.chunks)).toEqual({
        error: {
          code: 'CLEANUP_ERROR',
          message: 'Cleanup failed; command effects may already have occurred: close failed',
        },
      });
    } finally {
      output.restore();
    }
  });

  it.each([undefined, 0, 5])('rejects duplicate results with exit %s', async (status) => {
    const output = captureStdout();
    try {
      const { runCli } = await loadRunner({
        dispatch: (ctx) => {
          ctx.ui.json({ result: 'first' });
          ctx.ui.json({ result: 'second' });
          if (status !== undefined) ctx.exit(status);
        },
      });
      await expect(runCli(['role', 'show', '--json'])).resolves.toBe(1);
      expect(document(output.chunks)).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'Command emitted more than one JSON result.' },
      });
    } finally {
      output.restore();
    }
  });

  it('does not promote an arbitrary native error code into the public contract', async () => {
    const output = captureStdout();
    try {
      const { runCli } = await loadRunner({
        dispatch: () => {
          throw Object.assign(new Error('native operation failed'), { code: 'ENOENT' });
        },
      });
      expect(await runCli(['role', 'show', '--json'])).toBe(1);
      expect(document(output.chunks)).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'native operation failed' },
      });
    } finally {
      output.restore();
    }
  });

  it('does not retry a potentially partial stdout write at the runner boundary', async () => {
    const failure = new Error('output pipe failed');
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => {
      throw failure;
    });
    const dispose = vi.fn();
    try {
      const { runCli } = await loadRunner({ dispose });
      await expect(runCli(['role', 'show', '--json'])).rejects.toBe(failure);
      expect(dispose).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();
    } finally {
      write.mockRestore();
    }
  });

  it('does not return success JSON after a nonzero exit', async () => {
    const output = captureStdout();
    try {
      const { runCli } = await loadRunner({
        dispatch: (ctx) => {
          ctx.ui.json({ ok: true });
          ctx.exit(5);
        },
      });
      await expect(runCli(['role', 'show', '--json'])).resolves.toBe(5);
      expect(document(output.chunks)).toEqual({
        error: { code: 'ERROR', message: 'Command failed.' },
      });
    } finally {
      output.restore();
    }
  });

  it.each(['undefined', 'circular', 'bigint'])(
    'maps %s serialization failures to one internal error document',
    async (kind) => {
      const output = captureStdout();
      try {
        const { runCli } = await loadRunner({
          dispatch: (ctx) => {
            let value: unknown;
            if (kind === 'undefined') value = undefined;
            else if (kind === 'bigint') value = 1n;
            else {
              const circular: { self?: unknown } = {};
              circular.self = circular;
              value = circular;
            }
            ctx.ui.json(value);
          },
        });
        await expect(runCli(['role', 'show', '--json'])).resolves.toBe(1);
        expect(document(output.chunks)).toEqual({
          error: { code: 'INTERNAL_ERROR', message: 'Could not serialize JSON output.' },
        });
      } finally {
        output.restore();
      }
    }
  );

  it.each([
    [3, 'PANE_NOT_FOUND'],
    [4, 'TIMEOUT'],
    [5, 'CONFLICT'],
  ] as const)(
    'preserves emitted error details for exit %s when cleanup fails',
    async (status, code) => {
      const output = captureStdout();
      try {
        const { runCli } = await loadRunner({
          dispose: () => {
            throw new Error('cleanup failed');
          },
          dispatch: (ctx) => {
            ctx.ui.json({
              error: {
                code,
                message: 'request failed',
                stage: 'submit',
                suggestion: 'retry later',
              },
            });
            ctx.exit(status);
          },
        });
        await expect(runCli(['role', 'show', '--json'])).resolves.toBe(status);
        expect(document(output.chunks)).toEqual({
          error: {
            code,
            message: 'request failed',
            stage: 'submit',
            suggestion: 'retry later',
          },
        });
      } finally {
        output.restore();
      }
    }
  );

  it.each([
    ['team', 'list', '--json'],
    ['list', '--team', 'legacy', '--json'],
    ['talk', 'Alpha', 'message', '--json', '--team', 'legacy'],
  ])('rejects unsupported team routing with one JSON error: %s', async (...argv) => {
    const output = captureStdout();
    try {
      const { runCli, createContext } = await loadRunner();
      await expect(runCli(argv)).resolves.toBe(1);
      expect(document(output.chunks)).toEqual({
        error: {
          code: 'UNSUPPORTED_TEAM',
          message: 'Team-scoped commands and --team are not supported in tmt v5.',
        },
      });
      expect(createContext).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it('rejects JSON text-only commands before Context creation', async () => {
    const output = captureStdout();
    try {
      const { runCli, createContext } = await loadRunner();
      await expect(runCli(['--json', 'help'])).resolves.toBe(1);
      expect(document(output.chunks)).toMatchObject({ error: { code: 'JSON_UNSUPPORTED' } });
      expect(createContext).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it('emits an explicit success document when a command has no result', async () => {
    const output = captureStdout();
    try {
      const { runCli } = await loadRunner();
      await expect(runCli(['role', 'show', '--json'])).resolves.toBe(0);
      expect(document(output.chunks)).toEqual({ ok: true });
    } finally {
      output.restore();
    }
  });
});
