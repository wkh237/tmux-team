// ─────────────────────────────────────────────────────────────
// Preamble Command Tests
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Context, Paths, ResolvedConfig, Flags, UI, Tmux } from '../types.js';
import { ExitCodes } from '../exits.js';
import { cmdPreamble } from './preamble.js';

// ─────────────────────────────────────────────────────────────
// Test utilities
// ─────────────────────────────────────────────────────────────

function createMockUI(): UI & { errors: string[]; warnings: string[]; infos: string[]; jsonOutput: unknown[] } {
  const mock = {
    errors: [] as string[],
    warnings: [] as string[],
    infos: [] as string[],
    jsonOutput: [] as unknown[],
    info: (msg: string) => mock.infos.push(msg),
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
      pollInterval: 1,
      captureLines: 100,
      maxCaptureLines: 2000,
      preambleEvery: 3,
    },
    agents: {},
    paneRegistry: {
      claude: { pane: '1.0', remark: 'Test agent' },
      codex: { pane: '1.1' },
    },
  };
}

function createMockTmux(): Tmux {
  return {
    send: vi.fn(),
    capture: vi.fn(() => ''),
    listPanes: vi.fn(() => []),
    getCurrentPaneId: vi.fn(() => null),
  };
}

function createContext(
  overrides: Partial<{
    ui: UI;
    config: Partial<ResolvedConfig>;
    flags: Partial<Flags>;
    paths: Paths;
  }>
): Context {
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
    tmux: createMockTmux(),
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

describe('cmdPreamble', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preamble-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('show subcommand', () => {
    it('shows preamble for specific agent', () => {
      const ui = createMockUI();
      const ctx = createContext({
        ui,
        paths: createTestPaths(testDir),
        config: {
          agents: { claude: { preamble: 'Be helpful' } },
        },
      });

      cmdPreamble(ctx, ['show', 'claude']);

      expect(ui.infos).toContain('Preamble for claude:');
    });

    it('shows message when agent has no preamble', () => {
      const ui = createMockUI();
      const ctx = createContext({
        ui,
        paths: createTestPaths(testDir),
        config: { agents: {} },
      });

      cmdPreamble(ctx, ['show', 'claude']);

      expect(ui.infos).toContain('No preamble set for claude');
    });

    it('shows all preambles when no agent specified', () => {
      const ui = createMockUI();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const ctx = createContext({
        ui,
        paths: createTestPaths(testDir),
        config: {
          agents: {
            claude: { preamble: 'Be helpful' },
            codex: { preamble: 'Be concise' },
          },
        },
      });

      cmdPreamble(ctx, ['show']);

      expect(logSpy).toHaveBeenCalled();
      logSpy.mockRestore();
    });

    it('shows message when no preambles configured', () => {
      const ui = createMockUI();
      const ctx = createContext({
        ui,
        paths: createTestPaths(testDir),
        config: { agents: {} },
      });

      cmdPreamble(ctx, ['show']);

      expect(ui.infos).toContain('No preambles configured');
    });

    it('outputs JSON for specific agent when --json flag is set', () => {
      const ui = createMockUI();
      const ctx = createContext({
        ui,
        paths: createTestPaths(testDir),
        flags: { json: true },
        config: {
          agents: { claude: { preamble: 'Be helpful' } },
        },
      });

      cmdPreamble(ctx, ['show', 'claude']);

      expect(ui.jsonOutput).toHaveLength(1);
      expect(ui.jsonOutput[0]).toEqual({ agent: 'claude', preamble: 'Be helpful' });
    });

    it('outputs JSON for all preambles when --json flag is set', () => {
      const ui = createMockUI();
      const ctx = createContext({
        ui,
        paths: createTestPaths(testDir),
        flags: { json: true },
        config: {
          agents: {
            claude: { preamble: 'Be helpful' },
          },
        },
      });

      cmdPreamble(ctx, ['show']);

      expect(ui.jsonOutput).toHaveLength(1);
      expect(ui.jsonOutput[0]).toMatchObject({
        preambles: [{ agent: 'claude', preamble: 'Be helpful' }],
      });
    });

    it('handles undefined subcommand same as show', () => {
      const ui = createMockUI();
      const ctx = createContext({
        ui,
        paths: createTestPaths(testDir),
        config: { agents: {} },
      });

      cmdPreamble(ctx, []);

      expect(ui.infos).toContain('No preambles configured');
    });
  });

  describe('set subcommand', () => {
    it('sets preamble for agent', () => {
      const ui = createMockUI();
      const paths = createTestPaths(testDir);

      // Create local config file
      fs.writeFileSync(paths.localConfig, JSON.stringify({ claude: { pane: '1.0' } }));

      const ctx = createContext({ ui, paths });

      cmdPreamble(ctx, ['set', 'claude', 'Be', 'very', 'helpful']);

      // Check file was updated
      const config = JSON.parse(fs.readFileSync(paths.localConfig, 'utf-8'));
      expect(config.claude.preamble).toBe('Be very helpful');
      expect(ui.success).toHaveBeenCalled();
    });

    it('errors when agent not found', () => {
      const ui = createMockUI();
      const paths = createTestPaths(testDir);
      const ctx = createContext({
        ui,
        paths,
        config: { paneRegistry: {} },
      });

      expect(() => cmdPreamble(ctx, ['set', 'unknown', 'preamble'])).toThrow('exit(1)');
      expect(ui.errors[0]).toContain("Agent 'unknown' not found");
    });

    it('errors when not enough arguments', () => {
      const ui = createMockUI();
      const ctx = createContext({ ui, paths: createTestPaths(testDir) });

      expect(() => cmdPreamble(ctx, ['set', 'claude'])).toThrow('exit(1)');
      expect(ui.errors[0]).toContain('Usage: tmux-team preamble set');
    });

    it('outputs JSON when --json flag is set', () => {
      const ui = createMockUI();
      const paths = createTestPaths(testDir);

      fs.writeFileSync(paths.localConfig, JSON.stringify({ claude: { pane: '1.0' } }));

      const ctx = createContext({ ui, paths, flags: { json: true } });

      cmdPreamble(ctx, ['set', 'claude', 'Be helpful']);

      expect(ui.jsonOutput).toHaveLength(1);
      expect(ui.jsonOutput[0]).toMatchObject({
        agent: 'claude',
        preamble: 'Be helpful',
        status: 'set',
      });
    });
  });

  describe('clear subcommand', () => {
    it('clears preamble for agent', () => {
      const ui = createMockUI();
      const paths = createTestPaths(testDir);

      // Create local config with preamble
      fs.writeFileSync(
        paths.localConfig,
        JSON.stringify({ claude: { pane: '1.0', preamble: 'Old preamble' } })
      );

      const ctx = createContext({ ui, paths });

      cmdPreamble(ctx, ['clear', 'claude']);

      // Check file was updated
      const config = JSON.parse(fs.readFileSync(paths.localConfig, 'utf-8'));
      expect(config.claude.preamble).toBeUndefined();
      expect(ui.success).toHaveBeenCalled();
    });

    it('shows message when no preamble was set', () => {
      const ui = createMockUI();
      const paths = createTestPaths(testDir);

      fs.writeFileSync(paths.localConfig, JSON.stringify({ claude: { pane: '1.0' } }));

      const ctx = createContext({ ui, paths });

      cmdPreamble(ctx, ['clear', 'claude']);

      expect(ui.infos).toContain('No preamble was set for claude');
    });

    it('errors when not enough arguments', () => {
      const ui = createMockUI();
      const ctx = createContext({ ui, paths: createTestPaths(testDir) });

      expect(() => cmdPreamble(ctx, ['clear'])).toThrow('exit(1)');
      expect(ui.errors[0]).toContain('Usage: tmux-team preamble clear');
    });

    it('outputs JSON when --json flag is set and preamble cleared', () => {
      const ui = createMockUI();
      const paths = createTestPaths(testDir);

      fs.writeFileSync(
        paths.localConfig,
        JSON.stringify({ claude: { pane: '1.0', preamble: 'Old' } })
      );

      const ctx = createContext({ ui, paths, flags: { json: true } });

      cmdPreamble(ctx, ['clear', 'claude']);

      expect(ui.jsonOutput).toHaveLength(1);
      expect(ui.jsonOutput[0]).toMatchObject({ agent: 'claude', status: 'cleared' });
    });

    it('outputs JSON when --json flag is set and no preamble was set', () => {
      const ui = createMockUI();
      const paths = createTestPaths(testDir);

      fs.writeFileSync(paths.localConfig, JSON.stringify({ claude: { pane: '1.0' } }));

      const ctx = createContext({ ui, paths, flags: { json: true } });

      cmdPreamble(ctx, ['clear', 'claude']);

      expect(ui.jsonOutput).toHaveLength(1);
      expect(ui.jsonOutput[0]).toMatchObject({ agent: 'claude', status: 'not_set' });
    });
  });

  describe('unknown subcommand', () => {
    it('errors on unknown subcommand', () => {
      const ui = createMockUI();
      const ctx = createContext({ ui, paths: createTestPaths(testDir) });

      expect(() => cmdPreamble(ctx, ['invalid'])).toThrow('exit(1)');
      expect(ui.errors[0]).toContain('Unknown preamble subcommand: invalid');
      expect(ui.errors[1]).toContain('Usage: tmux-team preamble [show|set|clear]');
    });
  });
});
