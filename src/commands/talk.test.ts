// ─────────────────────────────────────────────────────────────
// Talk Command Tests - --delay, --wait, preambles, nonce detection
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Context, Tmux, UI, Paths, ResolvedConfig, Flags } from '../types.js';
import { ExitCodes } from '../exits.js';
import { TmuxDeliveryError } from '../message-delivery.js';
import { loadState, setActiveRequest } from '../state.js';
import { cmdTalk } from './talk.js';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

// Regex to extract nonce from instruction (new format: "where xxxx = <nonce>")
const INSTRUCTION_NONCE_REGEX = /where xxxx = ([a-f0-9]+)/;

// ─────────────────────────────────────────────────────────────
// Test utilities
// ─────────────────────────────────────────────────────────────

function createMockTmux(): Tmux & {
  sends: Array<{ pane: string; message: string }>;
  captureReturn: string;
} {
  const mock = {
    sends: [] as Array<{ pane: string; message: string }>,
    captureReturn: '',
    send(pane: string, message: string) {
      mock.sends.push({ pane, message });
    },
    capture(_pane: string, _lines: number) {
      return mock.captureReturn;
    },
    listPanes() {
      return [];
    },
    getCurrentPaneId() {
      return null;
    },
    resolvePaneTarget(target: string) {
      return target;
    },
    setPaneTitle() {},
  };
  return mock;
}

function createMockUI(): UI & { errors: string[]; warnings: string[]; jsonOutput: unknown[] } {
  const mock = {
    errors: [] as string[],
    warnings: [] as string[],
    jsonOutput: [] as unknown[],
    info: vi.fn(),
    success: vi.fn(),
    warn: (msg: string) => mock.warnings.push(msg),
    error: (msg: string) => mock.errors.push(msg),
    table: vi.fn(),
    json: (data: unknown) => mock.jsonOutput.push(data),
  };
  return mock;
}

function activeIdentity(name: string, paneId: string) {
  return {
    identity: {
      id: `identity-${name}`,
      name,
      canonicalName: name,
      createdAt: 'now',
      updatedAt: 'now',
    },
    binding: {
      id: `binding-${name}`,
      identityId: `identity-${name}`,
      transport: 'tmux' as const,
      paneId,
      serverId: 's',
      socketPath: '/s',
      serverPid: 1,
      serverStartTime: 'now',
      panePid: 1,
      boundAt: 'now',
      lastVerifiedAt: 'now',
    },
    pane: { id: paneId, command: name, suggestedName: name },
  };
}

function createTestPaths(testDir: string): Paths {
  return {
    globalDir: testDir,
    globalConfig: path.join(testDir, 'config.json'),
    localConfig: path.join(testDir, 'tmux-team.json'),
    stateFile: path.join(testDir, 'state.json'),
    databaseFile: path.join(testDir, 'tmux-team.db'),
  };
}

function createDefaultConfig(): ResolvedConfig {
  return {
    mode: 'polling',
    preambleMode: 'always',
    defaults: {
      timeout: 60,
      pollInterval: 0.1, // Fast polling for tests
      captureLines: 100,
      maxCaptureLines: 2000,
      preambleEvery: 3,
      pasteEnterDelayMs: 500,
    },
  };
}

function createMockPreambleService(content?: string): NonNullable<Context['preambleService']> {
  const identities = new Map([
    [
      'claude',
      {
        id: 'identity-claude',
        name: 'claude',
        canonicalName: 'claude',
        createdAt: 'now',
        updatedAt: 'now',
      },
    ],
    [
      'codex',
      {
        id: 'identity-codex',
        name: 'codex',
        canonicalName: 'codex',
        createdAt: 'now',
        updatedAt: 'now',
      },
    ],
    [
      'gemini',
      {
        id: 'identity-gemini',
        name: 'gemini',
        canonicalName: 'gemini',
        createdAt: 'now',
        updatedAt: 'now',
      },
    ],
    [
      'all',
      {
        id: 'identity-all',
        name: 'all',
        canonicalName: 'all',
        createdAt: 'now',
        updatedAt: 'now',
      },
    ],
  ]);
  return {
    show: vi.fn((name: string) => {
      const identity = identities.get(name);
      if (!identity) throw new Error(`Unknown identity: ${name}`);
      return {
        identity,
        preamble: content ? { content, updatedAt: 'now' } : null,
      };
    }),
    set: vi.fn(),
    clear: vi.fn(),
    list: vi.fn(() => []),
  };
}

function createContext(
  overrides: Partial<{
    tmux: Tmux;
    ui: UI;
    config: Partial<Omit<ResolvedConfig, 'defaults'>> & {
      defaults?: Partial<ResolvedConfig['defaults']>;
    };
    flags: Partial<Flags>;
    paths: Paths;
    preambleService: NonNullable<Context['preambleService']>;
  }>
): Context {
  const exitError = new Error('exit called');
  (exitError as Error & { exitCode?: number }).exitCode = 0;

  const baseConfig = createDefaultConfig();
  const config = {
    ...baseConfig,
    ...overrides.config,
    defaults: {
      ...baseConfig.defaults,
      ...overrides.config?.defaults,
    },
  };
  const flags: Flags = { json: false, verbose: false, ...overrides.flags };
  const tmux = overrides.tmux || createMockTmux();
  const identityService = {
    bindCurrent: vi.fn(),
    bindPane: vi.fn(),
    unbindCurrent: vi.fn(),
    currentIdentity: vi.fn(),
    activeIdentities: vi.fn(() =>
      ['claude', 'codex', 'gemini'].map((name, index) => activeIdentity(name, `1.${index}`))
    ),
    resolveActive: vi.fn(),
    reconcile: vi.fn(),
  };
  return {
    argv: [],
    flags,
    ui: overrides.ui || createMockUI(),
    config,
    tmux,
    identityService,
    preambleService: overrides.preambleService || createMockPreambleService(),
    paths: overrides.paths || createTestPaths('/tmp/test'),
    exit: ((code: number) => {
      const err = new Error(`exit(${code})`);
      (err as Error & { exitCode: number }).exitCode = code;
      throw err;
    }) as (code: number) => never,
  };
}

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

describe('buildMessage (via cmdTalk)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('returns original message when preambleMode is disabled', async () => {
    const tmux = createMockTmux();
    const ctx = createContext({
      tmux,
      paths: createTestPaths(testDir),
      config: { preambleMode: 'disabled' },
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    expect(tmux.sends).toHaveLength(1);
    expect(tmux.sends[0].message).toBe('Hello');
  });

  it('returns original message when --no-preamble flag is set', async () => {
    const tmux = createMockTmux();
    const ctx = createContext({
      tmux,
      paths: createTestPaths(testDir),
      flags: { noPreamble: true },
      config: { preambleMode: 'always' },
      preambleService: createMockPreambleService('Be brief'),
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    expect(tmux.sends).toHaveLength(1);
    expect(tmux.sends[0].message).toBe('Hello');
  });

  it('returns original message when agent has no preamble', async () => {
    const tmux = createMockTmux();
    const preambleService = createMockPreambleService();
    const paths = createTestPaths(testDir);
    const ctx = createContext({
      tmux,
      paths,
      config: { preambleMode: 'always' },
      preambleService,
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    expect(tmux.sends).toHaveLength(1);
    expect(tmux.sends[0].message).toBe('Hello');
    expect(preambleService.show).toHaveBeenCalledWith('claude');
    expect(fs.existsSync(paths.stateFile)).toBe(false);
  });

  it('prepends [SYSTEM: preamble] when preambleMode is always', async () => {
    const tmux = createMockTmux();
    const ctx = createContext({
      tmux,
      paths: createTestPaths(testDir),
      config: {
        preambleMode: 'always',
      },
      preambleService: createMockPreambleService('Be helpful and concise'),
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    expect(tmux.sends).toHaveLength(1);
    expect(tmux.sends[0].message).toContain('[SYSTEM: Be helpful and concise]');
    expect(tmux.sends[0].message).toContain('Hello');
  });

  it('formats preamble as [SYSTEM: <preamble>]\\n\\n<message>', async () => {
    const tmux = createMockTmux();
    const ctx = createContext({
      tmux,
      paths: createTestPaths(testDir),
      config: {
        preambleMode: 'always',
      },
      preambleService: createMockPreambleService('Test preamble'),
    });

    await cmdTalk(ctx, 'claude', 'Test message');

    expect(tmux.sends[0].message).toBe('[SYSTEM: Test preamble]\n\nTest message');
  });

  it('injects preamble based on preambleEvery config (every N messages)', async () => {
    const paths = createTestPaths(testDir);
    fs.mkdirSync(paths.globalDir, { recursive: true });

    const config = {
      preambleMode: 'always' as const,
      defaults: {
        timeout: 60,
        pollInterval: 0.1,
        captureLines: 100,
        maxCaptureLines: 2000,
        preambleEvery: 3,
        pasteEnterDelayMs: 500,
      },
    };

    // Message 1: should include preamble (first message)
    const tmux1 = createMockTmux();
    await cmdTalk(
      createContext({
        tmux: tmux1,
        paths,
        config,
        preambleService: createMockPreambleService('Be brief'),
      }),
      'claude',
      'Hello 1'
    );
    expect(tmux1.sends[0].message).toContain('[SYSTEM: Be brief]');

    // Message 2: should NOT include preamble
    const tmux2 = createMockTmux();
    await cmdTalk(
      createContext({
        tmux: tmux2,
        paths,
        config,
        preambleService: createMockPreambleService('Be brief'),
      }),
      'claude',
      'Hello 2'
    );
    expect(tmux2.sends[0].message).toBe('Hello 2');

    // Message 3: should NOT include preamble
    const tmux3 = createMockTmux();
    await cmdTalk(
      createContext({
        tmux: tmux3,
        paths,
        config,
        preambleService: createMockPreambleService('Be brief'),
      }),
      'claude',
      'Hello 3'
    );
    expect(tmux3.sends[0].message).toBe('Hello 3');

    // Message 4: should include preamble (4 - 1 = 3, divisible by 3)
    const tmux4 = createMockTmux();
    await cmdTalk(
      createContext({
        tmux: tmux4,
        paths,
        config,
        preambleService: createMockPreambleService('Be brief'),
      }),
      'claude',
      'Hello 4'
    );
    expect(tmux4.sends[0].message).toContain('[SYSTEM: Be brief]');
  });

  it('injects preamble every time when preambleEvery is 1', async () => {
    const paths = createTestPaths(testDir);
    fs.mkdirSync(paths.globalDir, { recursive: true });

    const config = {
      preambleMode: 'always' as const,
      defaults: {
        timeout: 60,
        pollInterval: 0.1,
        captureLines: 100,
        maxCaptureLines: 2000,
        preambleEvery: 1,
        pasteEnterDelayMs: 500,
      },
    };

    // All messages should include preamble
    for (let i = 0; i < 3; i++) {
      const tmux = createMockTmux();
      await cmdTalk(
        createContext({
          tmux,
          paths,
          config,
          preambleService: createMockPreambleService('Be brief'),
        }),
        'claude',
        `Hello ${i}`
      );
      expect(tmux.sends[0].message).toContain('[SYSTEM: Be brief]');
    }
  });

  it('never injects preamble when preambleEvery is 0', async () => {
    const paths = createTestPaths(testDir);
    fs.mkdirSync(paths.globalDir, { recursive: true });

    const config = {
      preambleMode: 'always' as const,
      defaults: {
        timeout: 60,
        pollInterval: 0.1,
        captureLines: 100,
        maxCaptureLines: 2000,
        preambleEvery: 0,
        pasteEnterDelayMs: 500,
      },
    };

    // No messages should include preamble
    for (let i = 0; i < 3; i++) {
      const tmux = createMockTmux();
      await cmdTalk(
        createContext({
          tmux,
          paths,
          config,
          preambleService: createMockPreambleService('Be brief'),
        }),
        'claude',
        `Hello ${i}`
      );
      expect(tmux.sends[0].message).toBe(`Hello ${i}`);
    }
  });
});

describe('cmdTalk - basic send', () => {
  it.each(['claude', '%9'])(
    'does not send target %s without required identity wiring',
    async (target) => {
      for (const wait of [false, true]) {
        const tmux = createMockTmux();
        const legacyRead = vi.fn(() => [{ name: 'claude', canonicalName: 'claude', paneId: '%9' }]);
        Object.assign(tmux, { listGlobalIdentities: legacyRead });
        const ctx = createContext({ tmux, flags: { wait }, paths: createTestPaths(testDir) });
        Object.defineProperty(ctx, 'identityService', { value: undefined });
        await expect(cmdTalk(ctx, target, 'must not send')).rejects.toThrow(
          'Identity service is required'
        );
        expect(legacyRead).not.toHaveBeenCalled();
        expect(tmux.sends).toEqual([]);
        expect(fs.existsSync(ctx.paths.stateFile)).toBe(false);
      }
    }
  );
  let testDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Disable pane detection in tests
    delete process.env.TMUX;
    delete process.env.TMT_AGENT_NAME;
    delete process.env.TMUX_TEAM_ACTOR;
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-test-'));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('sends message to specified agent pane', async () => {
    const tmux = createMockTmux();
    const ctx = createContext({ tmux, paths: createTestPaths(testDir) });

    await cmdTalk(ctx, 'claude', 'Hello Claude');

    expect(tmux.sends).toHaveLength(1);
    expect(tmux.sends[0].pane).toBe('1.0');
    expect(tmux.sends[0].message).toBe('Hello Claude');
  });

  it('treats all as an ordinary identity and reports it when inactive', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();
    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
    });

    await expect(cmdTalk(ctx, 'all', 'Hello')).rejects.toThrow(`exit(${ExitCodes.NAME_NOT_FOUND})`);
    expect(ui.jsonOutput).toEqual([]);
    expect(ui.errors).toContain("Identity 'all' is not active.");
  });

  it('sends to a bound all identity as one pane', async () => {
    const tmux = createMockTmux();
    const ctx = createContext({
      tmux,
      paths: createTestPaths(testDir),
    });
    (ctx.identityService.activeIdentities as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        ...activeIdentity('all', '1.9'),
      },
    ]);

    await cmdTalk(ctx, 'all', 'Hello');

    expect(tmux.sends).toHaveLength(1);
    expect(tmux.sends[0].pane).toBe('1.9');
  });

  it('returns a structured error when tmux.send fails', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();
    tmux.send = () => {
      throw new Error('tmux error');
    };
    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { json: true },
    });

    await expect(cmdTalk(ctx, 'claude', 'Hello')).rejects.toThrow(`exit(${ExitCodes.ERROR})`);
    expect(ui.jsonOutput).toEqual([
      { error: { code: 'ERROR', message: 'Failed to send to pane 1.0. Is tmux running?' } },
    ]);
  });

  it('returns one structured uncertainty envelope for a typed send failure', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();
    tmux.send = () => {
      throw new TmuxDeliveryError('paste');
    };
    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { json: true },
    });

    await expect(cmdTalk(ctx, 'claude', 'Hello')).rejects.toThrow(`exit(${ExitCodes.ERROR})`);
    expect(ui.jsonOutput).toEqual([
      {
        error: {
          code: 'DELIVERY_UNCERTAIN',
          message: 'Message delivery is uncertain during paste.',
          stage: 'paste',
          suggestion: 'Inspect the target pane before retrying.',
        },
      },
    ]);
    expect(ui.jsonOutput).toHaveLength(1);
  });

  it('shows an actionable inspection hint for human uncertainty output', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();
    tmux.send = () => {
      throw new TmuxDeliveryError('literal');
    };
    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
    });

    await expect(cmdTalk(ctx, 'claude', 'Hello')).rejects.toThrow(`exit(${ExitCodes.ERROR})`);
    expect(ui.errors).toEqual([
      'Message delivery is uncertain during literal. Inspect the target pane before retrying.',
    ]);
    expect(ui.jsonOutput).toEqual([]);
  });

  it.each([
    ['non-wait', { wait: false }],
    ['wait', { wait: true, timeout: 0.5 }],
  ] as const)(
    'fails named %s talk before transport when the preamble service is absent',
    async (_mode, flags) => {
      const tmux = createMockTmux();
      const ui = createMockUI();
      const ctx = createContext({
        tmux,
        ui,
        paths: createTestPaths(testDir),
        flags: { ...flags, json: true },
      });
      delete ctx.preambleService;

      await expect(cmdTalk(ctx, 'claude', 'Hello')).rejects.toThrow(`exit(${ExitCodes.ERROR})`);
      expect(tmux.sends).toHaveLength(0);
      expect(ui.jsonOutput).toEqual([
        { error: { code: 'PREAMBLE_ERROR', message: 'Preamble service is unavailable.' } },
      ]);
    }
  );

  it.each([
    ['non-wait', { wait: false }],
    ['wait', { wait: true, timeout: 0.5 }],
  ] as const)('maps %s preamble lookup failures before transport', async (_mode, flags) => {
    const tmux = createMockTmux();
    const ui = createMockUI();
    const paths = createTestPaths(testDir);
    const preambleService = createMockPreambleService('Be brief');
    preambleService.show = vi.fn(() => {
      throw new Error('preamble database unavailable');
    });
    const ctx = createContext({
      tmux,
      ui,
      paths,
      flags: { ...flags, json: true },
      preambleService,
    });

    await expect(cmdTalk(ctx, 'claude', 'Hello')).rejects.toThrow(`exit(${ExitCodes.ERROR})`);
    expect(tmux.sends).toHaveLength(0);
    expect(ui.jsonOutput).toEqual([
      { error: { code: 'PREAMBLE_ERROR', message: 'preamble database unavailable' } },
    ]);
    expect(fs.existsSync(paths.stateFile)).toBe(false);
  });

  it.each([
    ['disabled', { preambleMode: 'disabled' as const }],
    ['zero cadence', { defaults: { preambleEvery: 0 } }],
  ] as const)(
    'does not require preamble service when %s disables lookup',
    async (_mode, config) => {
      const tmux = createMockTmux();
      const ctx = createContext({ tmux, paths: createTestPaths(testDir), config });
      delete ctx.preambleService;

      await cmdTalk(ctx, 'claude', 'Hello');
      expect(tmux.sends).toHaveLength(1);
      expect(tmux.sends[0].message).toBe('Hello');
    }
  );

  it('preserves exclamation marks for gemini agent', async () => {
    const tmux = createMockTmux();
    const ctx = createContext({ tmux, paths: createTestPaths(testDir) });

    await cmdTalk(ctx, 'gemini', 'Hello! This is exciting!');

    expect(tmux.sends).toHaveLength(1);
    expect(tmux.sends[0].message).toBe('Hello! This is exciting!');
  });

  it('exits with error for unknown agent', async () => {
    const ui = createMockUI();
    const ctx = createContext({ ui, paths: createTestPaths(testDir) });

    await expect(cmdTalk(ctx, 'unknown', 'Hello')).rejects.toThrow('exit(3)');

    expect(ui.errors).toHaveLength(1);
    expect(ui.errors[0]).toContain("Identity 'unknown' is not active.");
  });

  it('outputs JSON when --json flag is set', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();
    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { json: true },
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    expect(ui.jsonOutput).toHaveLength(1);
    expect(ui.jsonOutput[0]).toMatchObject({
      target: 'claude',
      pane: '1.0',
      status: 'sent',
    });
  });
});

describe('cmdTalk - --delay flag', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-test-'));
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('waits specified seconds before sending', async () => {
    const tmux = createMockTmux();
    const ctx = createContext({
      tmux,
      paths: createTestPaths(testDir),
      flags: { delay: 2 },
    });

    const promise = cmdTalk(ctx, 'claude', 'Hello');

    // Before delay, no message sent
    expect(tmux.sends).toHaveLength(0);

    // Advance time
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect(tmux.sends).toHaveLength(1);
  });
});

describe('cmdTalk - --wait mode', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // Helper: generate mock capture output with proper marker structure
  // New protocol: instruction shows format with placeholder "xxxx" then actual nonce
  // Include the instruction line so extraction can anchor to it for clean output
  function mockCompleteResponse(nonce: string, response: string): string {
    const instruction = `When done, output exactly: RESPONSE-END-xxxx (where xxxx = ${nonce})`;
    const endMarker = `RESPONSE-END-${nonce}`;
    // Simulate: scrollback, user message with instruction, agent response, marker
    return `Some scrollback content\nUser message here\n\n${instruction}\n${response}\n${endMarker}`;
  }

  it.each([
    [
      'generic',
      () => new Error('tmux error'),
      { code: 'ERROR', message: 'Failed to send to pane 1.0. Is tmux running?' },
    ],
    [
      'typed',
      () => new TmuxDeliveryError('submit'),
      {
        code: 'DELIVERY_UNCERTAIN',
        message: 'Message delivery is uncertain during submit.',
        stage: 'submit',
        suggestion: 'Inspect the target pane before retrying.',
      },
    ],
  ] as const)(
    'maps %s send failure once in wait mode and clears request state',
    async (_kind, makeError, expected) => {
      const tmux = createMockTmux();
      const ui = createMockUI();
      tmux.send = () => {
        throw makeError();
      };
      const paths = createTestPaths(testDir);
      const unrelated = {
        id: 'other-request',
        nonce: 'other',
        pane: '1.1',
        startedAtMs: Date.now(),
      };
      setActiveRequest(paths, '1.1', unrelated);
      const ctx = createContext({
        tmux,
        ui,
        paths,
        flags: { wait: true, json: true, timeout: 0.5 },
        config: {
          defaults: {
            timeout: 0.5,
            pollInterval: 0.01,
            captureLines: 100,
            maxCaptureLines: 2000,
            preambleEvery: 3,
            pasteEnterDelayMs: 500,
          },
        },
      });
      ctx.exit = (code: number) => {
        expect(code).toBe(ExitCodes.ERROR);
        expect(loadState(paths).requests['1.0']).toBeUndefined();
        expect(loadState(paths).requests['1.1']).toEqual(unrelated);
        throw new Error(`exit(${code})`);
      };

      await expect(cmdTalk(ctx, 'claude', 'Hello')).rejects.toThrow(`exit(${ExitCodes.ERROR})`);
      expect(ui.jsonOutput).toEqual([{ error: expected }]);
      expect(ui.jsonOutput).toHaveLength(1);
      expect(fs.existsSync(paths.stateFile)).toBe(true);
      const state = loadState(paths);
      expect(state.requests['1.0']).toBeUndefined();
      expect(state.requests['1.1']).toEqual(unrelated);
    }
  );

  it('does not clear a newer pane request after an uncertain send', async () => {
    const paths = createTestPaths(testDir);
    const tmux = createMockTmux();
    const replacement = {
      id: 'newer-request',
      nonce: 'newer',
      pane: '1.0',
      startedAtMs: Date.now(),
    };
    tmux.send = () => {
      expect(loadState(paths).requests['1.0']?.id).not.toBe(replacement.id);
      expect(loadState(paths).requests['1.0']?.pane).toBe('1.0');
      setActiveRequest(paths, '1.0', replacement);
      throw new TmuxDeliveryError('paste');
    };
    const ctx = createContext({ tmux, paths, flags: { wait: true, json: true } });
    ctx.exit = (code: number) => {
      expect(code).toBe(ExitCodes.ERROR);
      expect(loadState(paths).requests['1.0']).toEqual(replacement);
      throw new Error(`exit(${code})`);
    };

    await expect(cmdTalk(ctx, 'claude', 'Hello')).rejects.toThrow(`exit(${ExitCodes.ERROR})`);
    expect(loadState(paths).requests['1.0']).toEqual(replacement);
  });

  it('appends nonce instruction to message', async () => {
    const tmux = createMockTmux();
    // Set up capture to return the nonce marker immediately
    let captureCount = 0;
    tmux.capture = () => {
      captureCount++;
      if (captureCount === 1) return ''; // Baseline
      // Extract nonce from instruction and return agent response with marker
      const sent = tmux.sends[0]?.message || '';
      const match = sent.match(INSTRUCTION_NONCE_REGEX);
      return match ? mockCompleteResponse(match[1], 'Response here') : '';
    };

    const ctx = createContext({
      tmux,
      paths: createTestPaths(testDir),
      flags: { wait: true, timeout: 0.5 },
      config: {
        defaults: {
          timeout: 0.5,
          pollInterval: 0.01,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3,
          pasteEnterDelayMs: 500,
        },
      },
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    expect(tmux.sends).toHaveLength(1);
    // New protocol: instruction shows format with placeholder, then actual nonce
    expect(tmux.sends[0].message).toContain('output exactly: RESPONSE-END-xxxx');
    expect(tmux.sends[0].message).toContain('where xxxx =');
    // Should NOT contain the literal marker format (marker appears only in agent response)
    expect(tmux.sends[0].message).not.toMatch(/^RESPONSE-END-[a-f0-9]+$/m);
  });

  it('detects nonce marker and extracts response', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    let captureCount = 0;

    tmux.capture = () => {
      captureCount++;
      if (captureCount === 1) return 'baseline content';
      // Extract nonce from instruction and return agent response with marker
      const sent = tmux.sends[0]?.message || '';
      const match = sent.match(INSTRUCTION_NONCE_REGEX);
      if (match) {
        return mockCompleteResponse(match[1], 'Agent response here');
      }
      return 'baseline content';
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 0.5 },
      config: {
        defaults: {
          timeout: 0.5,
          pollInterval: 0.01,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3,
          pasteEnterDelayMs: 500,
        },
      },
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    expect(ui.jsonOutput).toHaveLength(1);
    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output.status).toBe('completed');
    expect(output.response).toEqual(expect.stringContaining('Agent response here'));
  });

  it('returns timeout error with correct exit code', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    // Capture never returns the marker
    tmux.capture = () => 'no marker here';

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 0.1 },
      config: {
        defaults: {
          timeout: 0.1,
          pollInterval: 0.02,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3,
          pasteEnterDelayMs: 500,
        },
      },
    });

    try {
      await cmdTalk(ctx, 'claude', 'Hello');
      expect.fail('Should have thrown');
    } catch (err) {
      const error = err as Error & { exitCode: number };
      expect(error.exitCode).toBe(ExitCodes.TIMEOUT);
    }

    expect(ui.jsonOutput).toHaveLength(1);
    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output.status).toBe('timeout');
    expect(output.error).toContain('Timed out');
  });

  it('isolates response using end marker in scrollback', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    const oldContent = 'Previous conversation\nOld content here';

    tmux.capture = () => {
      // Simulate scrollback with old content, then agent response with marker
      const sent = tmux.sends[0]?.message || '';
      const nonceMatch = sent.match(INSTRUCTION_NONCE_REGEX);
      if (nonceMatch) {
        const endMarker = `RESPONSE-END-${nonceMatch[1]}`;
        // Only ONE marker from agent
        return `${oldContent}\nNew response content\n\n${endMarker}`;
      }
      return oldContent;
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 0.5 },
      config: {
        defaults: {
          timeout: 0.5,
          pollInterval: 0.01,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3,
          pasteEnterDelayMs: 500,
        },
      },
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output.status).toBe('completed');
    // Response should contain the actual response content
    expect(output.response).toContain('New response content');
  });

  it('clears active request on completion', async () => {
    const tmux = createMockTmux();
    let captureCount = 0;

    tmux.capture = () => {
      captureCount++;
      if (captureCount === 1) return '';
      const sent = tmux.sends[0]?.message || '';
      const match = sent.match(INSTRUCTION_NONCE_REGEX);
      return match ? mockCompleteResponse(match[1], 'Done') : '';
    };

    const paths = createTestPaths(testDir);
    const ctx = createContext({
      tmux,
      paths,
      flags: { wait: true, timeout: 0.5 },
      config: {
        defaults: {
          timeout: 0.5,
          pollInterval: 0.01,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3,
          pasteEnterDelayMs: 500,
        },
      },
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    // Check state file is cleaned up
    if (fs.existsSync(paths.stateFile)) {
      const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf-8'));
      expect(state.requests.claude).toBeUndefined();
    }
  });

  it('clears active request on timeout', async () => {
    const tmux = createMockTmux();
    tmux.capture = () => 'no marker';

    const paths = createTestPaths(testDir);
    const ctx = createContext({
      tmux,
      paths,
      flags: { wait: true, timeout: 0.05 },
      config: {
        defaults: {
          timeout: 0.05,
          pollInterval: 0.01,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3,
          pasteEnterDelayMs: 500,
        },
      },
    });

    try {
      await cmdTalk(ctx, 'claude', 'Hello');
    } catch {
      // Expected timeout
    }

    // Check state file is cleaned up
    if (fs.existsSync(paths.stateFile)) {
      const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf-8'));
      expect(state.requests.claude).toBeUndefined();
    }
  });
});

describe('cmdTalk - errors and JSON output', () => {
  it('errors when target agent is not found', async () => {
    const ctx = createContext({});
    await expect(cmdTalk(ctx, 'nope', 'hi')).rejects.toMatchObject({
      exitCode: ExitCodes.PANE_NOT_FOUND,
    });
    expect((ctx.ui as any).errors.join('\n')).toContain("Identity 'nope' is not active.");
  });

  it('outputs JSON in non-wait mode', async () => {
    const ctx = createContext({
      flags: { json: true },
    });
    await cmdTalk(ctx, 'claude', 'hello');
    const out = (ctx.ui as any).jsonOutput[0] as any;
    expect(out).toMatchObject({ target: 'claude', pane: '1.0', status: 'sent' });
  });
});

describe('cmdTalk - nonce collision handling', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('ignores old markers in scrollback that do not match current nonce', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    let captureCount = 0;
    const oldEndMarker = 'RESPONSE-END-0000'; // Old marker from previous request

    tmux.capture = () => {
      captureCount++;
      // Scrollback includes OLD markers from a previous request
      if (captureCount === 1) {
        return `Old question\nOld response\n${oldEndMarker}`;
      }
      // New capture still has old markers but agent hasn't responded yet
      if (captureCount === 2) {
        return `Old question\nOld response\n${oldEndMarker}`;
      }
      // Finally, new end marker appears from agent
      const sent = tmux.sends[0]?.message || '';
      const nonceMatch = sent.match(INSTRUCTION_NONCE_REGEX);
      if (nonceMatch) {
        const newEndMarker = `RESPONSE-END-${nonceMatch[1]}`;
        // Old markers in scrollback + new response + agent's end marker
        return `Old question\nOld response\n${oldEndMarker}\nNew response\n\n${newEndMarker}`;
      }
      return `Old question\nOld response\n${oldEndMarker}`;
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 0.5 },
      config: {
        defaults: {
          timeout: 0.5,
          pollInterval: 0.01,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3,
          pasteEnterDelayMs: 500,
        },
      },
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output.status).toBe('completed');
    // The key behavior: old markers with different nonce don't trigger completion
    // We waited for the NEW marker with correct nonce before completing
    // Note: With new protocol, response includes N lines before marker (may include scrollback)
    expect(output.response as string).toContain('New response');
    // Verify we polled multiple times (waiting for correct marker, not triggered by old one)
    expect(captureCount).toBeGreaterThan(2);
  });
});

describe('cmdTalk - JSON output contract', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('includes required fields in success response', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    tmux.capture = () => {
      const sent = tmux.sends[0]?.message || '';
      const nonceMatch = sent.match(INSTRUCTION_NONCE_REGEX);
      if (nonceMatch) {
        return mockCompleteResponse(nonceMatch[1], 'Response');
      }
      return '';
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 0.5 },
      config: {
        defaults: {
          timeout: 0.5,
          pollInterval: 0.01,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3,
          pasteEnterDelayMs: 500,
        },
      },
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output).toHaveProperty('target', 'claude');
    expect(output).toHaveProperty('pane', '1.0');
    expect(output).toHaveProperty('status', 'completed');
    expect(output).toHaveProperty('requestId');
    expect(output).toHaveProperty('nonce');
    expect(output).toHaveProperty('endMarker');
    expect(output).toHaveProperty('response');
  });

  // Helper moved to describe scope for JSON output tests
  // Include instruction line for proper extraction anchoring
  function mockCompleteResponse(nonce: string, response: string): string {
    const instruction = `When done, output exactly: RESPONSE-END-xxxx (where xxxx = ${nonce})`;
    const endMarker = `RESPONSE-END-${nonce}`;
    return `Some scrollback\n${instruction}\n${response}\n${endMarker}`;
  }

  it('includes required fields in timeout response', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();
    tmux.capture = () => 'no marker';

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 0.05 },
      config: {
        defaults: {
          timeout: 0.05,
          pollInterval: 0.01,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3,
          pasteEnterDelayMs: 500,
        },
      },
    });

    try {
      await cmdTalk(ctx, 'claude', 'Hello');
    } catch {
      // Expected
    }

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output).toHaveProperty('target', 'claude');
    expect(output).toHaveProperty('pane', '1.0');
    expect(output).toHaveProperty('status', 'timeout');
    expect(output).toHaveProperty('error');
    expect(output).toHaveProperty('requestId');
    expect(output).toHaveProperty('nonce');
    expect(output).toHaveProperty('endMarker');
  });

  it('captures partialResponse on timeout even when no marker visible', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    // Agent is writing but hasn't printed any marker yet
    // New behavior: we capture the last N lines as partial response
    tmux.capture = () => {
      return `This is partial content\nStill writing...`;
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 0.05 },
      config: {
        defaults: {
          timeout: 0.05,
          pollInterval: 0.01,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3,
          pasteEnterDelayMs: 500,
        },
      },
    });

    try {
      await cmdTalk(ctx, 'claude', 'Hello');
    } catch {
      // Expected timeout
    }

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output).toHaveProperty('status', 'timeout');
    // Fallback: capture last N lines as partial response
    expect(output.partialResponse).toContain('This is partial content');
    expect(output.partialResponse).toContain('Still writing...');
  });

  it('returns scrollback as partialResponse when no instruction visible', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    // Capture shows scrollback but no instruction marker
    // Fallback returns last N lines
    tmux.capture = () => 'random scrollback content';

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 0.05 },
      config: {
        defaults: {
          timeout: 0.05,
          pollInterval: 0.01,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3,
          pasteEnterDelayMs: 500,
        },
      },
    });

    try {
      await cmdTalk(ctx, 'claude', 'Hello');
    } catch {
      // Expected timeout
    }

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output).toHaveProperty('status', 'timeout');
    // Fallback captures last N lines even without instruction visible
    expect(output.partialResponse).toBe('random scrollback content');
  });
});

// ─────────────────────────────────────────────────────────────
// End Marker Tests - comprehensive coverage for the simplified marker system
// ─────────────────────────────────────────────────────────────

describe('cmdTalk - end marker detection', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talk-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // Helper: generate mock capture output with proper marker structure
  // Include instruction line for proper extraction anchoring
  function mockResponse(nonce: string, response: string): string {
    const instruction = `When done, output exactly: RESPONSE-END-xxxx (where xxxx = ${nonce})`;
    const endMarker = `RESPONSE-END-${nonce}`;
    return `Some scrollback\n${instruction}\n${response}\n${endMarker}`;
  }

  it('includes end marker instruction in sent message (not literal marker)', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    // Return complete response immediately
    tmux.capture = () => {
      const sent = tmux.sends[0]?.message || '';
      // Extract nonce from instruction (looks for RESPONSE-END-xxxx pattern)
      const nonceMatch = sent.match(INSTRUCTION_NONCE_REGEX);
      if (nonceMatch) {
        return mockResponse(nonceMatch[1], 'Response');
      }
      return '';
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 0.5 },
      config: {
        defaults: {
          timeout: 0.5,
          pollInterval: 0.01,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3,
          pasteEnterDelayMs: 500,
        },
      },
    });

    await cmdTalk(ctx, 'claude', 'Test message');

    const sent = tmux.sends[0].message;
    // New protocol: instruction shows format with placeholder, then actual nonce
    expect(sent).toContain('output exactly: RESPONSE-END-xxxx');
    expect(sent).toContain('where xxxx =');
    // Should NOT contain the literal marker format (marker appears only in agent response)
    expect(sent).not.toMatch(/^RESPONSE-END-[a-f0-9]+$/m);
  });

  it('extracts response before end marker', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    tmux.capture = () => {
      const sent = tmux.sends[0]?.message || '';
      // Extract nonce from instruction
      const nonceMatch = sent.match(INSTRUCTION_NONCE_REGEX);
      if (nonceMatch) {
        const endMarker = `RESPONSE-END-${nonceMatch[1]}`;
        // Simulate scrollback with old content, then agent's response with marker
        return `Old garbage\nMore old stuff\nThis is the actual response\n\n${endMarker}\nContent after marker`;
      }
      return 'Old garbage\nMore old stuff';
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 0.5 },
      config: {
        defaults: {
          timeout: 0.5,
          pollInterval: 0.01,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3,
          pasteEnterDelayMs: 500,
        },
      },
    });

    await cmdTalk(ctx, 'claude', 'Test');

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output.status).toBe('completed');
    expect(output.response).toContain('actual response');
  });

  it('handles multiline responses correctly', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    const multilineResponse = `Line 1 of response
Line 2 of response
Line 3 with special chars: <>&"'
Line 4 final`;

    tmux.capture = () => {
      const sent = tmux.sends[0]?.message || '';
      // Extract nonce from instruction
      const nonceMatch = sent.match(INSTRUCTION_NONCE_REGEX);
      if (nonceMatch) {
        return mockResponse(nonceMatch[1], multilineResponse);
      }
      return '';
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 0.5 },
      config: {
        defaults: {
          timeout: 0.5,
          pollInterval: 0.01,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3,
          pasteEnterDelayMs: 500,
        },
      },
    });

    await cmdTalk(ctx, 'claude', 'Test');

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output.response).toContain('Line 1 of response');
    expect(output.response).toContain('Line 4 final');
  });

  it('handles empty response before marker', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    tmux.capture = () => {
      const sent = tmux.sends[0]?.message || '';
      // Extract nonce from instruction
      const nonceMatch = sent.match(INSTRUCTION_NONCE_REGEX);
      if (nonceMatch) {
        const endMarker = `RESPONSE-END-${nonceMatch[1]}`;
        // Agent printed end marker immediately with no content before it
        return `${endMarker}`;
      }
      return '';
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 0.5 },
      config: {
        defaults: {
          timeout: 0.5,
          pollInterval: 0.01,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3,
          pasteEnterDelayMs: 500,
        },
      },
    });

    await cmdTalk(ctx, 'claude', 'Test');

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output.status).toBe('completed');
    expect(typeof output.response).toBe('string');
  });

  it('waits until marker appears (not triggered while agent is thinking)', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    let captureCount = 0;
    tmux.capture = () => {
      captureCount++;
      const sent = tmux.sends[0]?.message || '';
      // Extract nonce from instruction
      const nonceMatch = sent.match(INSTRUCTION_NONCE_REGEX);
      if (nonceMatch) {
        const endMarker = `RESPONSE-END-${nonceMatch[1]}`;
        if (captureCount < 3) {
          // No marker yet - agent is still thinking
          return `Agent is still thinking...`;
        }
        // Finally, agent prints marker
        return `Actual response\n${endMarker}`;
      }
      return '';
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 0.5 },
      config: {
        defaults: {
          timeout: 0.5,
          pollInterval: 0.01,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3,
          pasteEnterDelayMs: 500,
        },
      },
    });

    await cmdTalk(ctx, 'claude', 'Test');

    // Should have polled multiple times before detecting completion
    expect(captureCount).toBeGreaterThanOrEqual(3);
    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output.status).toBe('completed');
    expect(output.response).toContain('Actual response');
  });

  it('handles large scrollback with marker at end', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    // Simulate 100+ lines of scrollback
    const lotsOfContent = Array.from({ length: 150 }, (_, i) => `Line ${i}`).join('\n');

    tmux.capture = () => {
      const sent = tmux.sends[0]?.message || '';
      // Extract nonce from instruction
      const nonceMatch = sent.match(INSTRUCTION_NONCE_REGEX);
      if (nonceMatch) {
        const endMarker = `RESPONSE-END-${nonceMatch[1]}`;
        // ONE marker only - from agent response
        return `${lotsOfContent}\nThe actual response\n\n${endMarker}`;
      }
      return lotsOfContent;
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 0.5 },
      config: {
        defaults: {
          timeout: 0.5,
          pollInterval: 0.01,
          captureLines: 200,
          maxCaptureLines: 2000,
          preambleEvery: 3,
          pasteEnterDelayMs: 500,
        },
      },
    });

    await cmdTalk(ctx, 'claude', 'Test');

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output.status).toBe('completed');
    expect(output.response).toContain('actual response');
  });
});
