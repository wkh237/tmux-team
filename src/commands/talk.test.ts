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

  const config = { ...createDefaultConfig(), ...overrides.config };
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

  it('appends nonce instruction to message', async () => {
    const tmux = createMockTmux();
    // Set up capture to return the nonce marker immediately
    let captureCount = 0;
    tmux.capture = () => {
      captureCount++;
      if (captureCount === 1) return ''; // Baseline
      // Return marker on second capture
      const sent = tmux.sends[0]?.message || '';
      const match = sent.match(/\{tmux-team-end:([a-f0-9]+)\}/);
      return match ? `Response here {tmux-team-end:${match[1]}}` : '';
    };

    const ctx = createContext({
      tmux,
      paths: createTestPaths(testDir),
      flags: { wait: true, timeout: 5 },
      config: { defaults: { timeout: 5, pollInterval: 0.01, captureLines: 100 } },
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    expect(tmux.sends).toHaveLength(1);
    expect(tmux.sends[0].message).toContain(
      '[IMPORTANT: When your response is complete, print exactly:'
    );
    expect(tmux.sends[0].message).toMatch(/\{tmux-team-end:[a-f0-9]+\}/);
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
      const match = sent.match(/\{tmux-team-end:([a-f0-9]+)\}/);
      if (match) {
        return `baseline content\n\nAgent response here\n\n{tmux-team-end:${match[1]}}`;
      }
      return 'baseline content';
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 5 },
      config: { defaults: { timeout: 5, pollInterval: 0.01, captureLines: 100 } },
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
      config: { defaults: { timeout: 0.1, pollInterval: 0.02, captureLines: 100 } },
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

  it('isolates response from baseline using scrollback', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();

    let captureCount = 0;
    const baseline = 'Previous conversation\nOld content here';

    tmux.capture = () => {
      captureCount++;
      if (captureCount === 1) return baseline;
      // Second capture includes baseline + new content + marker
      const sent = tmux.sends[0]?.message || '';
      const match = sent.match(/\{tmux-team-end:([a-f0-9]+)\}/);
      if (match) {
        return `${baseline}\n\nNew response content\n\n{tmux-team-end:${match[1]}}`;
      }
      return baseline;
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 5 },
      config: { defaults: { timeout: 5, pollInterval: 0.01, captureLines: 100 } },
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output.status).toBe('completed');
    // Response should NOT include baseline content
    expect(output.response).toBe('New response content');
  });

  it('clears active request on completion', async () => {
    const tmux = createMockTmux();
    let captureCount = 0;

    tmux.capture = () => {
      captureCount++;
      if (captureCount === 1) return '';
      const sent = tmux.sends[0]?.message || '';
      const match = sent.match(/\{tmux-team-end:([a-f0-9]+)\}/);
      return match ? `Done {tmux-team-end:${match[1]}}` : '';
    };

    const paths = createTestPaths(testDir);
    const ctx = createContext({
      tmux,
      paths,
      flags: { wait: true, timeout: 5 },
      config: { defaults: { timeout: 5, pollInterval: 0.01, captureLines: 100 } },
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
      config: { defaults: { timeout: 0.05, pollInterval: 0.01, captureLines: 100 } },
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
    const markersByPane: Record<string, string> = {};

    // Mock send to capture the marker for each pane
    tmux.send = (pane: string, msg: string) => {
      const match = msg.match(/\{tmux-team-end:([a-f0-9]+)\}/);
      if (match) {
        markersByPane[pane] = match[0];
      }
    };

    // Mock capture to return the marker after first poll
    tmux.capture = (pane: string) => {
      captureCount++;
      // Return marker on second capture for each pane
      if (captureCount > 3 && markersByPane[pane]) {
        return `Response from agent\n${markersByPane[pane]}`;
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
        defaults: { timeout: 5, pollInterval: 0.05, captureLines: 100 },
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
    const markersByPane: Record<string, string> = {};

    tmux.send = (pane: string, msg: string) => {
      const match = msg.match(/\{tmux-team-end:([a-f0-9]+)\}/);
      if (match) {
        markersByPane[pane] = match[0];
      }
    };

    // Only pane 10.1 responds, 10.2 times out
    tmux.capture = (pane: string) => {
      if (pane === '10.1' && markersByPane[pane]) {
        return `Response from codex\n${markersByPane[pane]}`;
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
        defaults: { timeout: 0.1, pollInterval: 0.02, captureLines: 100 },
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
      const match = msg.match(/\{tmux-team-end:([a-f0-9]+)\}/);
      if (match) {
        nonces.push(match[1]);
      }
    };

    // Return markers immediately
    tmux.capture = (pane: string) => {
      const idx = pane === '10.1' ? 0 : 1;
      if (nonces[idx]) {
        return `Response\n{tmux-team-end:${nonces[idx]}}`;
      }
      return '';
    };

    const paths = createTestPaths(testDir);
    const ctx = createContext({
      tmux,
      paths,
      flags: { wait: true, timeout: 5 },
      config: {
        defaults: { timeout: 5, pollInterval: 0.02, captureLines: 100 },
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
    const oldMarker = '{tmux-team-end:0000}'; // Old marker from previous request

    tmux.capture = () => {
      captureCount++;
      if (captureCount === 1) {
        // Baseline includes an OLD marker
        return `Old response ${oldMarker}`;
      }
      // New capture still has old marker but not new one yet
      if (captureCount === 2) {
        return `Old response ${oldMarker}\nNew question asked`;
      }
      // Finally, new marker appears
      const sent = tmux.sends[0]?.message || '';
      const match = sent.match(/\{tmux-team-end:([a-f0-9]+)\}/);
      if (match) {
        return `Old response ${oldMarker}\nNew question asked\nNew response {tmux-team-end:${match[1]}}`;
      }
      return `Old response ${oldMarker}`;
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 5 },
      config: { defaults: { timeout: 5, pollInterval: 0.01, captureLines: 100 } },
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output.status).toBe('completed');
    // Response should be from after the new question, not triggered by old marker
    expect(output.response as string).not.toContain('Old response');
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

    let captureCount = 0;
    tmux.capture = () => {
      captureCount++;
      if (captureCount === 1) return '';
      const sent = tmux.sends[0]?.message || '';
      const match = sent.match(/\{tmux-team-end:([a-f0-9]+)\}/);
      return match ? `Response {tmux-team-end:${match[1]}}` : '';
    };

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 5 },
      config: { defaults: { timeout: 5, pollInterval: 0.01, captureLines: 100 } },
    });

    await cmdTalk(ctx, 'claude', 'Hello');

    const output = ui.jsonOutput[0] as Record<string, unknown>;
    expect(output).toHaveProperty('target', 'claude');
    expect(output).toHaveProperty('pane', '1.0');
    expect(output).toHaveProperty('status', 'completed');
    expect(output).toHaveProperty('requestId');
    expect(output).toHaveProperty('nonce');
    expect(output).toHaveProperty('marker');
    expect(output).toHaveProperty('response');
  });

  it('includes required fields in timeout response', async () => {
    const tmux = createMockTmux();
    const ui = createMockUI();
    tmux.capture = () => 'no marker';

    const ctx = createContext({
      tmux,
      ui,
      paths: createTestPaths(testDir),
      flags: { wait: true, json: true, timeout: 0.05 },
      config: { defaults: { timeout: 0.05, pollInterval: 0.01, captureLines: 100 } },
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
    expect(output).toHaveProperty('marker');
  });
});
