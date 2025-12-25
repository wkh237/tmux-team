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

// Regex to match new end marker format
const END_MARKER_REGEX = /---RESPONSE-END-([a-f0-9]+)---/;

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
      preambleEvery: 3,
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
        preambleEvery: 3,
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
        preambleEvery: 1,
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
        preambleEvery: 0,
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

  it('removes exclamation marks for gemini agent', async () => {
    const tmux = createMockTmux();
    const ctx = createContext({ tmux, paths: createTestPaths(testDir) });

    await cmdTalk(ctx, 'gemini', 'Hello! This is exciting!');

    expect(tmux.sends).toHaveLength(1);
    expect(tmux.sends[0].message).toBe('Hello This is exciting');
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
  // The end marker must appear TWICE: once in instruction, once from "agent"
  // New format: ---RESPONSE-END-NONCE---
  function mockCompleteResponse(nonce: string, response: string): string {
    const endMarker = `---RESPONSE-END-${nonce}---`;
    return `Hello\n\nWhen you finish responding, print this exact line:\n${endMarker}\n${response}\n${endMarker}`;
  }

  it('appends nonce instruction to message', async () => {
    const tmux = createMockTmux();
    // Set up capture to return the nonce marker immediately
    let captureCount = 0;
    tmux.capture = () => {
      captureCount++;
      if (captureCount === 1) return ''; // Baseline
      // Return marker on second capture - must include instruction AND agent's end marker
      const sent = tmux.sends[0]?.message || '';
      const match = sent.match(END_MARKER_REGEX);
      return match ? mockCompleteResponse(match[1], 'Response here') : '';
    };

    const ctx = createContext({
      tmux,
      paths: createTestPaths(testDir),
      flags: { wait: true, timeout: 5 },
      config: {
        defaults: {
          timeout: 5,
          pollInterval: 0.01,
          captureLines: 100,
          preambleEvery: 3,
        },
      },
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    expect(tmux.sends).toHaveLength(1);
    expect(tmux.sends[0].message).toContain('When you finish responding, print this exact line:');
    expect(tmux.sends[0].message).toMatch(/---RESPONSE-END-[a-f0-9]+---/);
  });

  it('detects nonce marker and extracts response', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    let captureCount = 0;

    tmux.capture = () => {
      captureCount++;
      if (captureCount === 1) return 'baseline content';
      // Extract nonce from sent message and return matching marker
      const sent = tmux.sends[0]?.message || '';
      const match = sent.match(END_MARKER_REGEX);
      if (match) {
        return mockCompleteResponse(match[1], 'Agent response here');
      }
      return 'baseline content';
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 5 },
      config: {
        defaults: {
          timeout: 5,
          pollInterval: 0.01,
          captureLines: 100,
          preambleEvery: 3,
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
          preambleEvery: 3,
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

  it('isolates response using end markers in scrollback', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    const oldContent = 'Previous conversation\nOld content here';

    tmux.capture = () => {
      // Simulate scrollback with old content, then our instruction (with end marker), response, and agent's end marker
      const sent = tmux.sends[0]?.message || '';
      const endMatch = sent.match(END_MARKER_REGEX);
      if (endMatch) {
        const endMarker = `---RESPONSE-END-${endMatch[1]}---`;
        // Must include end marker TWICE: once in instruction, once from "agent"
        return `${oldContent}\n\nMessage content here\n\nWhen you finish responding, print this exact line:\n${endMarker}\nNew response content\n\n${endMarker}`;
      }
      return oldContent;
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 5 },
      config: {
        defaults: {
          timeout: 5,
          pollInterval: 0.01,
          captureLines: 100,
          preambleEvery: 3,
        },
      },
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output.status).toBe('completed');
    // Response should NOT include old content
    expect(output.response).not.toContain('Previous conversation');
    expect(output.response).not.toContain('Old content here');
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
      const match = sent.match(END_MARKER_REGEX);
      return match ? mockCompleteResponse(match[1], 'Done') : '';
    };

    const paths = createTestPaths(testDir);
    const ctx = createContext({
      tmux,
      paths,
      flags: { wait: true, timeout: 5 },
      config: {
        defaults: {
          timeout: 5,
          pollInterval: 0.01,
          captureLines: 100,
          preambleEvery: 3,
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
          preambleEvery: 3,
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
    const noncesByPane: Record<string, string> = {};

    // Mock send to capture the nonce for each pane
    tmux.send = (pane: string, msg: string) => {
      const match = msg.match(END_MARKER_REGEX);
      if (match) {
        noncesByPane[pane] = match[1];
      }
    };

    // Mock capture to return complete response after first poll
    tmux.capture = (pane: string) => {
      captureCount++;
      // Return complete response on second capture for each pane
      if (captureCount > 3 && noncesByPane[pane]) {
        return mockCompleteResponse(noncesByPane[pane], 'Response from agent');
      }
      return 'working...';
    };

    const ui = createMockUI();
    const paths = createTestPaths(testDir);
    const ctx = createContext({
      ui,
      tmux,
      paths,
      flags: { wait: true, timeout: 5 },
      config: {
        defaults: {
          timeout: 5,
          pollInterval: 0.05,
          captureLines: 100,
          preambleEvery: 3,
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
    const noncesByPane: Record<string, string> = {};

    tmux.send = (pane: string, msg: string) => {
      const match = msg.match(END_MARKER_REGEX);
      if (match) {
        noncesByPane[pane] = match[1];
      }
    };

    // Only pane 10.1 responds, 10.2 times out
    tmux.capture = (pane: string) => {
      if (pane === '10.1' && noncesByPane[pane]) {
        return mockCompleteResponse(noncesByPane[pane], 'Response from codex');
      }
      return 'still working...';
    };

    const ui = createMockUI();
    const paths = createTestPaths(testDir);
    const ctx = createContext({
      ui,
      tmux,
      paths,
      flags: { wait: true, timeout: 0.1, json: true },
      config: {
        defaults: {
          timeout: 0.1,
          pollInterval: 0.02,
          captureLines: 100,
          preambleEvery: 3,
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
      // Expected timeout exit
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
    const nonces: string[] = [];

    tmux.send = (_pane: string, msg: string) => {
      const match = msg.match(END_MARKER_REGEX);
      if (match) {
        nonces.push(match[1]);
      }
    };

    // Return complete response immediately
    tmux.capture = (pane: string) => {
      const idx = pane === '10.1' ? 0 : 1;
      if (nonces[idx]) {
        return mockCompleteResponse(nonces[idx], 'Response');
      }
      return '';
    };

    const paths = createTestPaths(testDir);
    const ctx = createContext({
      tmux,
      paths,
      flags: { wait: true, timeout: 5 },
      config: {
        defaults: {
          timeout: 5,
          pollInterval: 0.02,
          captureLines: 100,
          preambleEvery: 3,
        },
        paneRegistry: {
          codex: { pane: '10.1' },
          gemini: { pane: '10.2' },
        },
      },
    });

    await cmdTalk(ctx, 'all', 'Hello');

    // Each agent should have a unique nonce
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
    const oldEndMarker = '---RESPONSE-END-0000---'; // Old marker from previous request

    tmux.capture = () => {
      captureCount++;
      // Scrollback includes OLD markers from a previous request
      if (captureCount === 1) {
        return `Old question\nOld response\n${oldEndMarker}`;
      }
      // New capture still has old markers but new request markers not complete yet
      if (captureCount === 2) {
        const sent = tmux.sends[0]?.message || '';
        const endMatch = sent.match(END_MARKER_REGEX);
        if (endMatch) {
          const newEndMarker = `---RESPONSE-END-${endMatch[1]}---`;
          // Old content + new instruction (only one occurrence of new marker so far)
          return `Old question\nOld response\n${oldEndMarker}\n\nNew question asked\n\nWhen you finish responding, print this exact line:\n${newEndMarker}`;
        }
        return `Old question\nOld response\n${oldEndMarker}`;
      }
      // Finally, new end marker appears - must have TWO occurrences of new end marker
      const sent = tmux.sends[0]?.message || '';
      const endMatch = sent.match(END_MARKER_REGEX);
      if (endMatch) {
        const newEndMarker = `---RESPONSE-END-${endMatch[1]}---`;
        // Old markers in scrollback + new instruction (with end marker) + response + agent's end marker
        return `Old question\nOld response\n${oldEndMarker}\n\nNew question asked\n\nWhen you finish responding, print this exact line:\n${newEndMarker}\nNew response\n\n${newEndMarker}`;
      }
      return `Old question\nOld response\n${oldEndMarker}`;
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 5 },
      config: {
        defaults: {
          timeout: 5,
          pollInterval: 0.01,
          captureLines: 100,
          preambleEvery: 3,
        },
      },
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output.status).toBe('completed');
    // Response should be from the new markers, not triggered by old markers
    expect(output.response as string).not.toContain('Old response');
    expect(output.response as string).not.toContain('Old question');
    expect(output.response as string).toContain('New response');
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
      const endMatch = sent.match(END_MARKER_REGEX);
      if (endMatch) {
        // Must have TWO end markers: one in instruction, one from "agent"
        return mockCompleteResponse(endMatch[1], 'Response');
      }
      return '';
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 5 },
      config: {
        defaults: {
          timeout: 5,
          pollInterval: 0.01,
          captureLines: 100,
          preambleEvery: 3,
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
  function mockCompleteResponse(nonce: string, response: string): string {
    const endMarker = `---RESPONSE-END-${nonce}---`;
    return `Hello\n\nWhen you finish responding, print this exact line:\n${endMarker}\n${response}\n${endMarker}`;
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
          preambleEvery: 3,
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

  it('captures partialResponse on timeout when agent started responding', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    // Simulate agent started responding but didn't finish (only ONE end marker in instruction, no second from agent)
    tmux.capture = () => {
      const sent = tmux.sends[0]?.message || '';
      const endMatch = sent.match(END_MARKER_REGEX);
      if (endMatch) {
        const endMarker = `---RESPONSE-END-${endMatch[1]}---`;
        // Only one end marker (in instruction), agent started writing but didn't finish
        return `Hello\n\nWhen you finish responding, print this exact line:\n${endMarker}\nThis is partial content\nStill writing...`;
      }
      return 'random content';
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
          preambleEvery: 3,
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
    expect(output).toHaveProperty('partialResponse');
    expect(output.partialResponse).toContain('This is partial content');
    expect(output.partialResponse).toContain('Still writing...');
  });

  it('returns null partialResponse when nothing captured', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    // Nothing meaningful in the capture
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
          preambleEvery: 3,
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
    expect(output.partialResponse).toBeNull();
  });

  it('captures partialResponse in broadcast timeout', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();
    const markersByPane: Record<string, string> = {};

    tmux.send = (pane: string, msg: string) => {
      const match = msg.match(END_MARKER_REGEX);
      if (match) markersByPane[pane] = match[1];
    };

    // codex completes, gemini times out with partial response
    tmux.capture = (pane: string) => {
      if (pane === '10.1') {
        const nonce = markersByPane['10.1'];
        const endMarker = `---RESPONSE-END-${nonce}---`;
        // Complete response: two end markers
        return `Msg\n\nWhen you finish responding, print this exact line:\n${endMarker}\nResponse\n${endMarker}`;
      }
      // gemini has partial response - only one end marker (in instruction)
      const nonce = markersByPane['10.2'];
      const endMarker = `---RESPONSE-END-${nonce}---`;
      return `Msg\n\nWhen you finish responding, print this exact line:\n${endMarker}\nPartial gemini output...`;
    };

    const paths = createTestPaths(testDir);
    const ctx = createContext({
      ui,
      tmux,
      paths,
      flags: { wait: true, timeout: 0.1, json: true },
      config: {
        defaults: {
          timeout: 0.1,
          pollInterval: 0.02,
          captureLines: 100,
          preambleEvery: 3,
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
      // Expected timeout exit
    }

    const result = ui.jsonOutput[0] as {
      results: Array<{
        agent: string;
        status: string;
        response?: string;
        partialResponse?: string;
      }>;
    };
    const codexResult = result.results.find((r) => r.agent === 'codex');
    const geminiResult = result.results.find((r) => r.agent === 'gemini');

    expect(codexResult?.status).toBe('completed');
    expect(codexResult?.response).toContain('Response');

    expect(geminiResult?.status).toBe('timeout');
    expect(geminiResult?.partialResponse).toContain('Partial gemini output');
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
  // The end marker must appear TWICE: once in instruction, once from "agent"
  function mockResponse(nonce: string, response: string): string {
    const endMarker = `---RESPONSE-END-${nonce}---`;
    return `Message\n\nWhen you finish responding, print this exact line:\n${endMarker}\n${response}\n${endMarker}`;
  }

  it('includes end marker in sent message', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    // Return complete response immediately
    tmux.capture = () => {
      const sent = tmux.sends[0]?.message || '';
      const endMatch = sent.match(END_MARKER_REGEX);
      if (endMatch) {
        return mockResponse(endMatch[1], 'Response');
      }
      return '';
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 5 },
      config: { defaults: { timeout: 5, pollInterval: 0.01, captureLines: 100, preambleEvery: 3 } },
    });

    await cmdTalk(ctx, 'claude', 'Test message');

    const sent = tmux.sends[0].message;
    expect(sent).toMatch(/---RESPONSE-END-[a-f0-9]+---/);
    expect(sent).toContain('When you finish responding, print this exact line:');
  });

  it('extracts response between two end markers', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    tmux.capture = () => {
      const sent = tmux.sends[0]?.message || '';
      const endMatch = sent.match(END_MARKER_REGEX);
      if (endMatch) {
        const endMarker = `---RESPONSE-END-${endMatch[1]}---`;
        // Simulate scrollback with old content, instruction, response, and agent's end marker
        return `Old garbage\nMore old stuff\nMessage\n\nWhen you finish responding, print this exact line:\n${endMarker}\nThis is the actual response\n\n${endMarker}\nContent after marker`;
      }
      return 'Old garbage\nMore old stuff';
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 5 },
      config: { defaults: { timeout: 5, pollInterval: 0.01, captureLines: 100, preambleEvery: 3 } },
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
      const endMatch = sent.match(END_MARKER_REGEX);
      if (endMatch) {
        return mockResponse(endMatch[1], multilineResponse);
      }
      return '';
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 5 },
      config: { defaults: { timeout: 5, pollInterval: 0.01, captureLines: 100, preambleEvery: 3 } },
    });

    await cmdTalk(ctx, 'claude', 'Test');

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output.response).toContain('Line 1 of response');
    expect(output.response).toContain('Line 4 final');
  });

  it('handles empty response between markers', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    tmux.capture = () => {
      const sent = tmux.sends[0]?.message || '';
      const endMatch = sent.match(END_MARKER_REGEX);
      if (endMatch) {
        const endMarker = `---RESPONSE-END-${endMatch[1]}---`;
        // Agent printed end marker immediately with no content
        return `Message here\n\nWhen you finish responding, print this exact line:\n${endMarker}\n${endMarker}`;
      }
      return '';
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 5 },
      config: { defaults: { timeout: 5, pollInterval: 0.01, captureLines: 100, preambleEvery: 3 } },
    });

    await cmdTalk(ctx, 'claude', 'Test');

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output.status).toBe('completed');
    expect(typeof output.response).toBe('string');
  });

  it('waits until second marker appears (not triggered by instruction alone)', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    let captureCount = 0;
    tmux.capture = () => {
      captureCount++;
      const sent = tmux.sends[0]?.message || '';
      const endMatch = sent.match(END_MARKER_REGEX);
      if (endMatch) {
        const endMarker = `---RESPONSE-END-${endMatch[1]}---`;
        if (captureCount < 3) {
          // Only ONE end marker (in instruction) - should keep waiting
          return `Message\n\nWhen you finish responding, print this exact line:\n${endMarker}\nAgent is still thinking...`;
        }
        // Finally, agent prints second marker
        return `Message\n\nWhen you finish responding, print this exact line:\n${endMarker}\nActual response\n${endMarker}`;
      }
      return '';
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 5 },
      config: { defaults: { timeout: 5, pollInterval: 0.01, captureLines: 100, preambleEvery: 3 } },
    });

    await cmdTalk(ctx, 'claude', 'Test');

    // Should have polled multiple times before detecting completion
    expect(captureCount).toBeGreaterThanOrEqual(3);
    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output.status).toBe('completed');
    expect(output.response).toContain('Actual response');
  });

  it('handles large scrollback with markers at edges', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    // Simulate 100+ lines of scrollback
    const lotsOfContent = Array.from({ length: 150 }, (_, i) => `Line ${i}`).join('\n');

    tmux.capture = () => {
      const sent = tmux.sends[0]?.message || '';
      const endMatch = sent.match(END_MARKER_REGEX);
      if (endMatch) {
        const endMarker = `---RESPONSE-END-${endMatch[1]}---`;
        // TWO end markers: one in instruction, one from "agent" response
        return `${lotsOfContent}\nMessage\n\nWhen you finish responding, print this exact line:\n${endMarker}\n\nThe actual response\n\n${endMarker}`;
      }
      return lotsOfContent;
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 5 },
      config: { defaults: { timeout: 5, pollInterval: 0.01, captureLines: 200, preambleEvery: 3 } },
    });

    await cmdTalk(ctx, 'claude', 'Test');

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output.status).toBe('completed');
    expect(output.response).toContain('actual response');
    expect(output.response).not.toContain('Line 0');
  });
});
