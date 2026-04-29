// ─────────────────────────────────────────────────────────────
// Tmux Wrapper Tests - buffer paste, capture-pane
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import { createTmux } from './tmux.js';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);
const mockedExecFileSync = vi.mocked(execFileSync);

describe('createTmux', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('send', () => {
    it('uses buffer paste and then sends Enter', () => {
      const tmux = createTmux();

      tmux.send('1.0', 'Hello world', { enterDelayMs: 0 });

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('tmux set-buffer -b "tmt-'),
        expect.any(Object)
      );
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('tmux paste-buffer -b "tmt-'),
        expect.any(Object)
      );
      expect(mockedExecSync).toHaveBeenCalledWith(
        'tmux send-keys -t "1.0" Enter',
        expect.any(Object)
      );
    });

    it('adds a trailing newline to the buffer payload', () => {
      const tmux = createTmux();

      tmux.send('1.0', 'Line 1\nLine 2', { enterDelayMs: 0 });

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('"Line 1\\nLine 2\\n"'),
        expect.any(Object)
      );
    });

    it('escapes special characters in message', () => {
      const tmux = createTmux();

      tmux.send('1.0', 'Hello "world" with \'quotes\'', { enterDelayMs: 0 });

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('"Hello \\"world\\" with \'quotes\'\\n"'),
        expect.any(Object)
      );
    });

    it('falls back to send-keys when buffer paste fails', () => {
      const error = new Error('set-buffer failed');
      mockedExecSync.mockImplementationOnce(() => {
        throw error;
      });
      const tmux = createTmux();

      tmux.send('1.0', 'Hello', { enterDelayMs: 0 });

      expect(mockedExecSync).toHaveBeenCalledWith(
        'tmux send-keys -t "1.0" "Hello"',
        expect.any(Object)
      );
      expect(mockedExecSync).toHaveBeenCalledWith(
        'tmux send-keys -t "1.0" Enter',
        expect.any(Object)
      );
    });

    it('uses pipe stdio to suppress output', () => {
      const tmux = createTmux();

      tmux.send('1.0', 'Hello', { enterDelayMs: 0 });

      expect(mockedExecSync).toHaveBeenCalledWith(expect.any(String), { stdio: 'pipe' });
    });
  });

  describe('capture', () => {
    it('calls tmux capture-pane with pane ID and line count', () => {
      mockedExecSync.mockReturnValue('captured output');
      const tmux = createTmux();

      tmux.capture('1.0', 100);

      expect(mockedExecSync).toHaveBeenCalledWith(
        'tmux capture-pane -t "1.0" -p -S -100',
        expect.any(Object)
      );
    });

    it('returns captured pane content', () => {
      const expectedOutput = 'Line 1\nLine 2\nLine 3';
      mockedExecSync.mockReturnValue(expectedOutput);
      const tmux = createTmux();

      const result = tmux.capture('1.0', 50);

      expect(result).toBe(expectedOutput);
    });

    it('captures specified number of lines', () => {
      mockedExecSync.mockReturnValue('');
      const tmux = createTmux();

      tmux.capture('2.1', 200);

      expect(mockedExecSync).toHaveBeenCalledWith(
        'tmux capture-pane -t "2.1" -p -S -200',
        expect.any(Object)
      );
    });

    it('throws when pane does not exist', () => {
      const error = new Error("can't find pane: 99.99");
      mockedExecSync.mockImplementationOnce(() => {
        throw error;
      });

      const tmux = createTmux();

      expect(() => tmux.capture('99.99', 100)).toThrow("can't find pane: 99.99");
    });

    it('uses utf-8 encoding for output', () => {
      mockedExecSync.mockReturnValue('');
      const tmux = createTmux();

      tmux.capture('1.0', 100);

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ encoding: 'utf-8' })
      );
    });

    it('uses pipe stdio for all streams', () => {
      mockedExecSync.mockReturnValue('');
      const tmux = createTmux();

      tmux.capture('1.0', 100);

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
      );
    });
  });

  describe('listPanes', () => {
    it('returns parsed panes and suggestedName', () => {
      mockedExecSync.mockReturnValue('%1\tcodex\n%2\tzsh\n');
      const tmux = createTmux();
      const panes = tmux.listPanes();
      expect(panes).toEqual([
        { id: '%1', command: 'codex', suggestedName: 'codex' },
        { id: '%2', command: 'zsh', suggestedName: null },
      ]);
    });

    it('returns empty list on error', () => {
      mockedExecSync.mockImplementationOnce(() => {
        throw new Error('no tmux');
      });
      const tmux = createTmux();
      expect(tmux.listPanes()).toEqual([]);
    });

    it('handles malformed output with missing tab separator', () => {
      // When a line has no tab, id will be the whole line and command will be empty
      mockedExecSync.mockReturnValue('%1\n%2\tcodex\n');
      const tmux = createTmux();
      const panes = tmux.listPanes();
      expect(panes).toEqual([
        { id: '%1', command: '', suggestedName: null },
        { id: '%2', command: 'codex', suggestedName: 'codex' },
      ]);
    });

    it('ignores invalid metadata and duplicate pane IDs', () => {
      mockedExecSync.mockReturnValue('%1\tcodex\tbad-json\n%1\tcodex\tbad-json\n%2\tzsh\t{}\n');
      const tmux = createTmux();
      expect(tmux.listPanes()).toEqual([
        { id: '%1', command: 'codex', suggestedName: 'codex' },
        { id: '%2', command: 'zsh', suggestedName: null },
      ]);
      expect(tmux.getAgentRegistry({ type: 'workspace', workspaceRoot: '/repo' })).toEqual({
        paneRegistry: {},
        agents: {},
      });
    });

    it('parses tmux-team pane metadata', () => {
      mockedExecSync.mockReturnValue(
        '%1\tcodex\t{"version":1,"workspaces":{"/repo":{"name":"codex","remark":"review"}}}\n'
      );
      const tmux = createTmux();
      expect(tmux.getAgentRegistry({ type: 'workspace', workspaceRoot: '/repo' })).toEqual({
        paneRegistry: { codex: { pane: '%1', remark: 'review' } },
        agents: {},
      });
    });

    it('parses pane target and cwd from modern list-panes output', () => {
      mockedExecSync.mockReturnValue('%1\tmain:2.0\t/repo\tcodex\t{"version":1}\n');
      const tmux = createTmux();
      expect(tmux.listPanes()).toEqual([
        {
          id: '%1',
          target: 'main:2.0',
          cwd: '/repo',
          command: 'codex',
          suggestedName: 'codex',
          metadata: { version: 1 },
        },
      ]);
    });

    it('builds team registries and agent config from metadata', () => {
      mockedExecSync.mockReturnValue(
        '%1\tcodex\t{"version":1,"teams":{"egp":{"name":"codex","preamble":"Be strict","deny":["x"]}}}\n'
      );
      const tmux = createTmux();
      expect(tmux.getAgentRegistry({ type: 'team', teamName: 'egp' })).toEqual({
        paneRegistry: { codex: { pane: '%1', preamble: 'Be strict', deny: ['x'] } },
        agents: { codex: { preamble: 'Be strict', deny: ['x'] } },
      });
    });
  });

  describe('getCurrentPaneId', () => {
    it('returns TMUX_PANE when set', () => {
      const old = process.env.TMUX_PANE;
      process.env.TMUX_PANE = '%9';
      const tmux = createTmux();
      expect(tmux.getCurrentPaneId()).toBe('%9');
      process.env.TMUX_PANE = old;
    });

    it('falls back to tmux display-message', () => {
      const old = process.env.TMUX_PANE;
      delete process.env.TMUX_PANE;
      mockedExecSync.mockReturnValue('%7\n');
      const tmux = createTmux();
      expect(tmux.getCurrentPaneId()).toBe('%7');
      process.env.TMUX_PANE = old;
    });

    it('returns null on failure', () => {
      const old = process.env.TMUX_PANE;
      delete process.env.TMUX_PANE;
      mockedExecSync.mockImplementationOnce(() => {
        throw new Error('fail');
      });
      const tmux = createTmux();
      expect(tmux.getCurrentPaneId()).toBeNull();
      process.env.TMUX_PANE = old;
    });

    it('returns null when tmux output is empty', () => {
      const old = process.env.TMUX_PANE;
      delete process.env.TMUX_PANE;
      mockedExecSync.mockReturnValue('   \n');
      const tmux = createTmux();
      expect(tmux.getCurrentPaneId()).toBeNull();
      process.env.TMUX_PANE = old;
    });
  });

  describe('metadata registry writes', () => {
    it('resolves pane targets to canonical pane IDs', () => {
      mockedExecFileSync.mockReturnValue('%9\n');
      const tmux = createTmux();
      expect(tmux.resolvePaneTarget('1.2')).toBe('%9');
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['display-message', '-p', '-t', '1.2', '#{pane_id}'],
        expect.any(Object)
      );
    });

    it('sets workspace registration on pane metadata', () => {
      mockedExecFileSync.mockReturnValueOnce('');
      const tmux = createTmux();
      tmux.setAgentRegistration(
        '%9',
        { type: 'workspace', workspaceRoot: '/repo' },
        { name: 'codex', preamble: 'Be strict' }
      );
      expect(mockedExecFileSync).toHaveBeenLastCalledWith(
        'tmux',
        [
          'set-option',
          '-p',
          '-t',
          '%9',
          '@tmux-team.agent',
          '{"version":1,"workspaces":{"/repo":{"name":"codex","preamble":"Be strict"}}}',
        ],
        expect.any(Object)
      );
    });

    it('sets team registration while preserving existing metadata', () => {
      mockedExecFileSync.mockReturnValueOnce(
        '{"version":1,"workspaces":{"/repo":{"name":"codex"}}}\n'
      );
      const tmux = createTmux();
      tmux.setAgentRegistration('%9', { type: 'team', teamName: 'egp' }, { name: 'reviewer' });
      expect(mockedExecFileSync).toHaveBeenLastCalledWith(
        'tmux',
        [
          'set-option',
          '-p',
          '-t',
          '%9',
          '@tmux-team.agent',
          '{"version":1,"workspaces":{"/repo":{"name":"codex"}},"teams":{"egp":{"name":"reviewer"}}}',
        ],
        expect.any(Object)
      );
    });

    it('clears scoped registration and unsets empty metadata', () => {
      mockedExecSync.mockReturnValue(
        '%1\tcodex\t{"version":1,"workspaces":{"/repo":{"name":"codex"}}}\n'
      );
      const tmux = createTmux();
      expect(
        tmux.clearAgentRegistration('codex', { type: 'workspace', workspaceRoot: '/repo' })
      ).toBe(true);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['set-option', '-p', '-u', '-t', '%1', '@tmux-team.agent'],
        expect.any(Object)
      );
    });

    it('returns false when clearing a missing registration', () => {
      mockedExecSync.mockReturnValue(
        '%1\tcodex\t{"version":1,"workspaces":{"/repo":{"name":"codex"}}}\n'
      );
      const tmux = createTmux();
      expect(
        tmux.clearAgentRegistration('claude', { type: 'workspace', workspaceRoot: '/repo' })
      ).toBe(false);
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });

    it('lists teams from pane metadata', () => {
      mockedExecSync.mockReturnValue(
        '%1\tcodex\t{"version":1,"teams":{"egp":{"name":"codex"},"checkout":{"name":"claude"}}}\n'
      );
      const tmux = createTmux();
      expect(tmux.listTeams()).toEqual({ checkout: ['claude'], egp: ['codex'] });
    });

    it('lists pane team and workspace details', () => {
      mockedExecSync.mockReturnValue(
        '%1\tmain:1.0\t/repo\tclaude\t{"version":1,"workspaces":{"/repo":{"name":"claude","remark":"lead"}},"teams":{"egp":{"name":"reviewer"}}}\n%2\tmain:1.1\t/tmp\tzsh\t\n'
      );
      const tmux = createTmux();
      expect(tmux.listTeamPanes()).toEqual([
        {
          pane: '%1',
          target: 'main:1.0',
          cwd: '/repo',
          command: 'claude',
          suggestedName: 'claude',
          registrations: [
            { scopeType: 'team', scope: 'egp', agent: 'reviewer' },
            { scopeType: 'workspace', scope: '/repo', agent: 'claude', remark: 'lead' },
          ],
        },
        {
          pane: '%2',
          target: 'main:1.1',
          cwd: '/tmp',
          command: 'zsh',
          suggestedName: null,
          registrations: [],
        },
      ]);
    });

    it('removes one team while preserving other registrations', () => {
      mockedExecSync.mockReturnValue(
        '%1\tcodex\t{"version":1,"teams":{"egp":{"name":"codex"},"checkout":{"name":"claude"}}}\n'
      );
      const tmux = createTmux();
      expect(tmux.removeTeam('egp')).toEqual({ removed: 1, agents: ['codex'] });
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        [
          'set-option',
          '-p',
          '-t',
          '%1',
          '@tmux-team.agent',
          '{"version":1,"teams":{"checkout":{"name":"claude"}}}',
        ],
        expect.any(Object)
      );
    });
  });

  describe('pane ID handling', () => {
    it('accepts window.pane format', () => {
      mockedExecSync.mockReturnValue('');
      const tmux = createTmux();

      tmux.send('1.2', 'Hello', { enterDelayMs: 0 });
      tmux.capture('1.2', 100);

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('tmux paste-buffer -b "tmt-'),
        expect.any(Object)
      );
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('-t "1.2"'),
        expect.any(Object)
      );
    });

    it('accepts session:window.pane format', () => {
      mockedExecSync.mockReturnValue('');
      const tmux = createTmux();

      tmux.send('main:1.2', 'Hello', { enterDelayMs: 0 });
      tmux.capture('main:1.2', 100);

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('tmux paste-buffer -b "tmt-'),
        expect.any(Object)
      );
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('-t "main:1.2"'),
        expect.any(Object)
      );
    });

    it('quotes pane ID to prevent shell injection', () => {
      mockedExecSync.mockReturnValue('');
      const tmux = createTmux();

      // Malicious pane ID attempt
      tmux.send('1.0; rm -rf /', 'Hello', { enterDelayMs: 0 });

      // Should be quoted and treated as literal string
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('-t "1.0; rm -rf /"'),
        expect.any(Object)
      );
    });
  });
});
