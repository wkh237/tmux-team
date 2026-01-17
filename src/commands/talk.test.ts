// ─────────────────────────────────────────────────────────────
// Talk Command Tests - --delay, --wait, preambles, nonce detection
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Context, Tmux, UI, Paths, ResolvedConfig, Flags } from '../types.js';
import { ExitCodes } from '../exits.js';
import { cmdTalk } from './talk.js';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

// Regex to match the END marker (as printed by agent) - tolerates optional dashes
const END_MARKER_REGEX = /-{0,3}RESPONSE-END-([a-f0-9]+)-{0,3}/;

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

function createTestPaths(testDir: string): Paths {
  return {
    globalDir: testDir,
    globalConfig: path.join(testDir, 'config.json'),
    localConfig: path.join(testDir, 'tmux-team.json'),
    stateFile: path.join(testDir, 'state.json'),
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
    agents: {},
    paneRegistry: {
      claude: { pane: '1.0', remark: 'Test agent' },
      codex: { pane: '1.1' },
      gemini: { pane: '1.2' },
    },
  };
}

function createContext(
  overrides: Partial<{
    tmux: Tmux;
    ui: UI;
    config: Partial<ResolvedConfig>;
    flags: Partial<Flags>;
    paths: Paths;
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

  return {
    argv: [],
    flags,
    ui: overrides.ui || createMockUI(),
    config,
    tmux: overrides.tmux || createMockTmux(),
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
      config: {
        preambleMode: 'always',
        agents: { claude: { preamble: 'Be brief' } },
      },
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    expect(tmux.sends).toHaveLength(1);
    expect(tmux.sends[0].message).toBe('Hello');
  });

  it('returns original message when agent has no preamble', async () => {
    const tmux = createMockTmux();
    const ctx = createContext({
      tmux,
      paths: createTestPaths(testDir),
      config: { preambleMode: 'always', agents: {} },
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    expect(tmux.sends).toHaveLength(1);
    expect(tmux.sends[0].message).toBe('Hello');
  });

  it('prepends [SYSTEM: preamble] when preambleMode is always', async () => {
    const tmux = createMockTmux();
    const ctx = createContext({
      tmux,
      paths: createTestPaths(testDir),
      config: {
        preambleMode: 'always',
        agents: { claude: { preamble: 'Be helpful and concise' } },
      },
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
        agents: { claude: { preamble: 'Test preamble' } },
      },
    });

    await cmdTalk(ctx, 'claude', 'Test message');

    expect(tmux.sends[0].message).toBe('[SYSTEM: Test preamble]\n\nTest message');
  });

  it('injects preamble based on preambleEvery config (every N messages)', async () => {
    const paths = createTestPaths(testDir);
    fs.mkdirSync(paths.globalDir, { recursive: true });

    const config = {
      preambleMode: 'always' as const,
      agents: { claude: { preamble: 'Be brief' } },
      defaults: {
        timeout: 60,
        pollInterval: 0.1,
        captureLines: 100,
        maxCaptureLines: 2000,
        preambleEvery: 3, pasteEnterDelayMs: 500,
      },
    };

    // Message 1: should include preamble (first message)
    const tmux1 = createMockTmux();
    await cmdTalk(createContext({ tmux: tmux1, paths, config }), 'claude', 'Hello 1');
    expect(tmux1.sends[0].message).toContain('[SYSTEM: Be brief]');

    // Message 2: should NOT include preamble
    const tmux2 = createMockTmux();
    await cmdTalk(createContext({ tmux: tmux2, paths, config }), 'claude', 'Hello 2');
    expect(tmux2.sends[0].message).toBe('Hello 2');

    // Message 3: should NOT include preamble
    const tmux3 = createMockTmux();
    await cmdTalk(createContext({ tmux: tmux3, paths, config }), 'claude', 'Hello 3');
    expect(tmux3.sends[0].message).toBe('Hello 3');

    // Message 4: should include preamble (4 - 1 = 3, divisible by 3)
    const tmux4 = createMockTmux();
    await cmdTalk(createContext({ tmux: tmux4, paths, config }), 'claude', 'Hello 4');
    expect(tmux4.sends[0].message).toContain('[SYSTEM: Be brief]');
  });

  it('injects preamble every time when preambleEvery is 1', async () => {
    const paths = createTestPaths(testDir);
    fs.mkdirSync(paths.globalDir, { recursive: true });

    const config = {
      preambleMode: 'always' as const,
      agents: { claude: { preamble: 'Be brief' } },
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
      await cmdTalk(createContext({ tmux, paths, config }), 'claude', `Hello ${i}`);
      expect(tmux.sends[0].message).toContain('[SYSTEM: Be brief]');
    }
  });

  it('never injects preamble when preambleEvery is 0', async () => {
    const paths = createTestPaths(testDir);
    fs.mkdirSync(paths.globalDir, { recursive: true });

    const config = {
      preambleMode: 'always' as const,
      agents: { claude: { preamble: 'Be brief' } },
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
      await cmdTalk(createContext({ tmux, paths, config }), 'claude', `Hello ${i}`);
      expect(tmux.sends[0].message).toBe(`Hello ${i}`);
    }
  });
});

describe('cmdTalk - basic send', () => {
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

  it('sends message to all configured agents', async () => {
    const tmux = createMockTmux();
    const ctx = createContext({ tmux, paths: createTestPaths(testDir) });

    await cmdTalk(ctx, 'all', 'Hello everyone');

    expect(tmux.sends).toHaveLength(3);
    expect(tmux.sends.map((s) => s.pane).sort()).toEqual(['1.0', '1.1', '1.2']);
  });

  it('errors when sending to all with no agents configured', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();
    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      config: { paneRegistry: {} },
    });

    await expect(cmdTalk(ctx, 'all', 'Hello')).rejects.toThrow(`exit(${ExitCodes.CONFIG_MISSING})`);
    expect(ui.errors).toContain("No agents configured. Use 'tmux-team add' first.");
  });

  it('outputs JSON when sending to all with --json flag', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();
    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { json: true },
    });

    await cmdTalk(ctx, 'all', 'Hello');

    expect(ui.jsonOutput).toHaveLength(1);
    expect(ui.jsonOutput[0]).toMatchObject({
      target: 'all',
      results: expect.any(Array),
    });
  });

  it('handles tmux.send failure gracefully', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();
    // Make send throw for one agent
    const originalSend = tmux.send.bind(tmux);
    let callCount = 0;
    tmux.send = (pane: string, message: string) => {
      callCount++;
      if (callCount === 2) throw new Error('tmux error');
      originalSend(pane, message);
    };

    const ctx = createContext({ tmux, ui, paths: createTestPaths(testDir) });

    await cmdTalk(ctx, 'all', 'Hello');

    expect(ui.warnings).toContain('Failed to send to codex');
  });

  it('skips self when sending to all (via env var)', async () => {
    // Simulate being an agent via env var (when not in tmux)
    const originalEnv = { ...process.env };
    delete process.env.TMUX; // Ensure pane detection is disabled
    process.env.TMT_AGENT_NAME = 'claude';

    try {
      const tmux = createMockTmux();
      const ui = createMockUI();
      const ctx = createContext({ tmux, ui, paths: createTestPaths(testDir) });

      await cmdTalk(ctx, 'all', 'Hello team');

      // Should skip claude (self) and only send to codex and gemini
      expect(tmux.sends).toHaveLength(2);
      expect(tmux.sends.map((s) => s.pane).sort()).toEqual(['1.1', '1.2']);
    } finally {
      process.env = originalEnv;
    }
  });

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
    expect(ui.errors[0]).toContain("Agent 'unknown' not found");
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
          preambleEvery: 3, pasteEnterDelayMs: 500,
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
          preambleEvery: 3, pasteEnterDelayMs: 500,
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
          preambleEvery: 3, pasteEnterDelayMs: 500,
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
          preambleEvery: 3, pasteEnterDelayMs: 500,
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
          preambleEvery: 3, pasteEnterDelayMs: 500,
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
          preambleEvery: 3, pasteEnterDelayMs: 500,
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

  it('supports wait mode with all target (parallel polling)', async () => {
    // Create mock tmux that returns markers for each agent after a delay
    const tmux = createMockTmux();
    let captureCount = 0;
    const getNonceForPane = (pane: string): string | undefined => {
      const sent = tmux.sends.find((s) => s.pane === pane)?.message ?? '';
      const match = String(sent).match(INSTRUCTION_NONCE_REGEX);
      return match?.[1];
    };

    // Mock capture to return complete response after first poll
    tmux.capture = (pane: string) => {
      captureCount++;
      // Return complete response on second capture for each pane
      const nonce = getNonceForPane(pane);
      if (captureCount > 3 && nonce) {
        return mockCompleteResponse(nonce, 'Response from agent');
      }
      return 'working...';
    };

    const ui = createMockUI();
    const paths = createTestPaths(testDir);
    const ctx = createContext({
      ui,
      tmux,
      paths,
      flags: { wait: true, timeout: 0.5 },
      config: {
        defaults: {
          timeout: 0.5,
          pollInterval: 0.05,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3, pasteEnterDelayMs: 500,
        },
        paneRegistry: {
          codex: { pane: '10.1' },
          gemini: { pane: '10.2' },
        },
      },
    });

    await cmdTalk(ctx, 'all', 'Hello');

    // Should have captured both panes
    expect(captureCount).toBeGreaterThan(2);
  });

  it('handles partial timeout in wait mode with all target', async () => {
    const tmux = createMockTmux();
    const getNonceForPane = (pane: string): string | undefined => {
      const sent = tmux.sends.find((s) => s.pane === pane)?.message ?? '';
      const match = String(sent).match(INSTRUCTION_NONCE_REGEX);
      return match?.[1];
    };

    // Only pane 10.1 responds with end marker, 10.2 never has end marker
    tmux.capture = (pane: string) => {
      const nonce = getNonceForPane(pane);
      if (pane === '10.1' && nonce) {
        return mockCompleteResponse(nonce, 'Response from codex');
      }
      // gemini has no end marker - still typing
      return 'still working...';
    };

    const ui = createMockUI();
    const paths = createTestPaths(testDir);
    const ctx = createContext({
      ui,
      tmux,
      paths,
      flags: { wait: true, timeout: 0.5, json: true },
      config: {
        defaults: {
          timeout: 0.5,
          pollInterval: 0.02,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3, pasteEnterDelayMs: 500,
        },
        paneRegistry: {
          codex: { pane: '10.1' },
          gemini: { pane: '10.2' },
        },
      },
    });

    try {
      await cmdTalk(ctx, 'all', 'Hello');
    } catch {
      // Expected timeout exit for gemini
    }

    // Should have JSON output with both results
    expect(ui.jsonOutput.length).toBe(1);
    const result = ui.jsonOutput[0] as {
      summary: { completed: number; timeout: number };
      results: Array<{ agent: string; status: string }>;
    };
    expect(result.summary.completed).toBe(1);
    expect(result.summary.timeout).toBe(1);
    expect(result.results.find((r) => r.agent === 'codex')?.status).toBe('completed');
    expect(result.results.find((r) => r.agent === 'gemini')?.status).toBe('timeout');
  });

  it('uses unique nonces per agent in broadcast', async () => {
    const tmux = createMockTmux();
    const getNonces = (): string[] =>
      tmux.sends
        .map((s) => String(s.message).match(INSTRUCTION_NONCE_REGEX)?.[1])
        .filter((nonce): nonce is string => Boolean(nonce));

    // Return complete response immediately
    tmux.capture = (pane: string) => {
      const idx = pane === '10.1' ? 0 : 1;
      const nonces = getNonces();
      if (nonces[idx]) {
        return mockCompleteResponse(nonces[idx], 'Response');
      }
      return '';
    };

    const paths = createTestPaths(testDir);
    const ctx = createContext({
      tmux,
      paths,
      flags: { wait: true, timeout: 0.5 },
      config: {
        defaults: {
          timeout: 0.5,
          pollInterval: 0.02,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3, pasteEnterDelayMs: 500,
        },
        paneRegistry: {
          codex: { pane: '10.1' },
          gemini: { pane: '10.2' },
        },
      },
    });

    await cmdTalk(ctx, 'all', 'Hello');

    // Each agent should have a unique nonce
    const nonces = getNonces();
    expect(nonces.length).toBe(2);
    expect(nonces[0]).not.toBe(nonces[1]);
  });
});

describe('cmdTalk - errors and JSON output', () => {
  it('errors when target agent is not found', async () => {
    const ctx = createContext({
      config: { paneRegistry: {} },
    });
    await expect(cmdTalk(ctx, 'nope', 'hi')).rejects.toMatchObject({
      exitCode: ExitCodes.PANE_NOT_FOUND,
    });
    expect((ctx.ui as any).errors.join('\n')).toContain("Agent 'nope' not found");
  });

  it('outputs JSON in non-wait mode', async () => {
    const ctx = createContext({
      flags: { json: true },
      config: { paneRegistry: { claude: { pane: '1.0' } } },
    });
    await cmdTalk(ctx, 'claude', 'hello');
    const out = (ctx.ui as any).jsonOutput[0] as any;
    expect(out).toMatchObject({ target: 'claude', pane: '1.0', status: 'sent' });
  });

  it('marks failures in broadcast when send throws', async () => {
    const tmux = createMockTmux();
    const sendSpy = vi.spyOn(tmux, 'send').mockImplementationOnce(() => {
      throw new Error('fail');
    });
    const ctx = createContext({
      tmux,
      flags: { json: true },
      config: {
        paneRegistry: { claude: { pane: '1.0' }, codex: { pane: '1.1' } },
      },
    });

    await cmdTalk(ctx, 'all', 'hello');
    expect(sendSpy).toHaveBeenCalled();
    const out = (ctx.ui as any).jsonOutput[0] as any;
    expect(out.results.some((r: any) => r.status === 'failed')).toBe(true);
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
          preambleEvery: 3, pasteEnterDelayMs: 500,
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
          preambleEvery: 3, pasteEnterDelayMs: 500,
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
          preambleEvery: 3, pasteEnterDelayMs: 500,
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
          preambleEvery: 3, pasteEnterDelayMs: 500,
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
          preambleEvery: 3, pasteEnterDelayMs: 500,
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

  it('handles broadcast with mixed completion and timeout', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();
    const getNonceForPane = (pane: string): string | undefined => {
      const sent = tmux.sends.find((s) => s.pane === pane)?.message ?? '';
      const match = String(sent).match(INSTRUCTION_NONCE_REGEX);
      return match?.[1];
    };

    // codex completes with end marker, gemini has no end marker (still typing)
    tmux.capture = (pane: string) => {
      if (pane === '10.1') {
        const nonce = getNonceForPane('10.1');
        const endMarker = `RESPONSE-END-${nonce}`;
        // Complete response with end marker
        return `Response\n${endMarker}`;
      }
      // gemini has no end marker at all - agent is still responding
      return `Gemini is still typing this response and hasn't finished yet...`;
    };

    const paths = createTestPaths(testDir);
    const ctx = createContext({
      ui,
      tmux,
      paths,
      flags: { wait: true, timeout: 0.5, json: true },
      config: {
        defaults: {
          timeout: 0.5,
          pollInterval: 0.02,
          captureLines: 100,
          maxCaptureLines: 2000,
          preambleEvery: 3, pasteEnterDelayMs: 500,
        },
        paneRegistry: {
          codex: { pane: '10.1' },
          gemini: { pane: '10.2' },
        },
      },
    });

    try {
      await cmdTalk(ctx, 'all', 'Hello');
    } catch {
      // Expected timeout exit for gemini
    }

    const result = ui.jsonOutput[0] as {
      results: Array<{
        agent: string;
        status: string;
        response?: string;
        partialResponse?: string | null;
      }>;
    };
    const codexResult = result.results.find((r) => r.agent === 'codex');
    const geminiResult = result.results.find((r) => r.agent === 'gemini');

    // Codex should complete (has end marker, output stable)
    expect(codexResult?.status).toBe('completed');
    expect(codexResult?.response).toContain('Response');

    // Gemini times out (no end marker in output)
    expect(geminiResult?.status).toBe('timeout');
    // Fallback captures the output even without marker
    expect(geminiResult?.partialResponse).toContain('Gemini is still typing');
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
      config: { defaults: { timeout: 0.5, pollInterval: 0.01, captureLines: 100, maxCaptureLines: 2000, preambleEvery: 3, pasteEnterDelayMs: 500 } },
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
      config: { defaults: { timeout: 0.5, pollInterval: 0.01, captureLines: 100, maxCaptureLines: 2000, preambleEvery: 3, pasteEnterDelayMs: 500 } },
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
      config: { defaults: { timeout: 0.5, pollInterval: 0.01, captureLines: 100, maxCaptureLines: 2000, preambleEvery: 3, pasteEnterDelayMs: 500 } },
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
      config: { defaults: { timeout: 0.5, pollInterval: 0.01, captureLines: 100, maxCaptureLines: 2000, preambleEvery: 3, pasteEnterDelayMs: 500 } },
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
      config: { defaults: { timeout: 0.5, pollInterval: 0.01, captureLines: 100, maxCaptureLines: 2000, preambleEvery: 3, pasteEnterDelayMs: 500 } },
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
      config: { defaults: { timeout: 0.5, pollInterval: 0.01, captureLines: 200, maxCaptureLines: 2000, preambleEvery: 3, pasteEnterDelayMs: 500 } },
    });

    await cmdTalk(ctx, 'claude', 'Test');

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output.status).toBe('completed');
    expect(output.response).toContain('actual response');
  });
});
