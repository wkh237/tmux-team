// ─────────────────────────────────────────────────────────────
// Tmux Wrapper Tests - buffer paste, capture-pane
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'child_process';
import { performance } from 'node:perf_hooks';
import { createTmux } from './tmux.js';
import type { DurableIdentity, TmuxBinding } from './domain/identity.js';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);
const mockedExecFileSync = vi.mocked(execFileSync);

const ENDPOINT_SEPARATOR = '__TMT_FIELD_4f1c__';
const VALID_SERVER_ID = '123e4567-e89b-42d3-a456-426614174000';

function endpointRow(
  overrides: {
    serverId?: string;
    socketPath?: string;
    serverPid?: string;
    paneId?: string;
    panePid?: string;
  } = {}
): string {
  return [
    overrides.serverId ?? VALID_SERVER_ID,
    overrides.socketPath ?? '/tmp/foreign.sock',
    overrides.serverPid ?? '321',
    '1700000000',
    overrides.paneId ?? '%9',
    'main:1.0',
    '/foreign',
    'node',
    overrides.panePid ?? '654',
    '',
  ].join(ENDPOINT_SEPARATOR);
}

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

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['set-buffer', '-b', expect.stringMatching(/^tmt-/), '--', 'Hello world\n'],
        expect.any(Object)
      );
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['paste-buffer', '-b', expect.stringMatching(/^tmt-/), '-d', '-t', '1.0', '-p'],
        expect.any(Object)
      );
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['send-keys', '-t', '1.0', 'Enter'],
        expect.any(Object)
      );
    });

    it('adds a trailing newline to the buffer payload', () => {
      const tmux = createTmux();

      tmux.send('1.0', 'Line 1\nLine 2', { enterDelayMs: 0 });

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['set-buffer', '-b', expect.stringMatching(/^tmt-/), '--', 'Line 1\nLine 2\n'],
        expect.any(Object)
      );
    });

    it('escapes special characters in message', () => {
      const tmux = createTmux();

      tmux.send('1.0', 'Hello "world" with \'quotes\'', { enterDelayMs: 0 });

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        [
          'set-buffer',
          '-b',
          expect.stringMatching(/^tmt-/),
          '--',
          'Hello "world" with \'quotes\'\n',
        ],
        expect.any(Object)
      );
    });

    it('falls back to send-keys when buffer paste fails', () => {
      const error = new Error('set-buffer failed');
      mockedExecFileSync.mockImplementationOnce(() => {
        throw error;
      });
      const tmux = createTmux();

      tmux.send('1.0', 'Hello', { enterDelayMs: 0 });

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['send-keys', '-t', '1.0', 'Hello'],
        expect.any(Object)
      );
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['send-keys', '-t', '1.0', 'Enter'],
        expect.any(Object)
      );
    });

    it('uses pipe stdio to suppress output', () => {
      const tmux = createTmux();

      tmux.send('1.0', 'Hello', { enterDelayMs: 0 });

      expect(mockedExecFileSync).toHaveBeenCalledWith('tmux', expect.any(Array), { stdio: 'pipe' });
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
      mockedExecSync.mockReturnValue(
        '%1__TMT_FIELD_4f1c__main:2.0__TMT_FIELD_4f1c__/repo__TMT_FIELD_4f1c__codex__TMT_FIELD_4f1c__{"version":1}\n'
      );
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

    it('captures pane process evidence from modern list-panes output', () => {
      mockedExecSync.mockReturnValue(
        '%1__TMT_FIELD_4f1c__main:2.0__TMT_FIELD_4f1c__/repo__TMT_FIELD_4f1c__codex__TMT_FIELD_4f1c__4242__TMT_FIELD_4f1c__{"version":1}\n'
      );
      expect(createTmux().listPanes()).toMatchObject([
        { id: '%1', panePid: 4242, metadata: { version: 1 } },
      ]);
    });

    it('falls back to pane options when list-panes omits user metadata', () => {
      mockedExecSync.mockReturnValue('%1\tmain:2.0\t/repo\tnode\t\n');
      mockedExecFileSync.mockReturnValue(
        '{"version":1,"globalIdentity":{"name":"Alice","canonicalName":"alice"}}\n'
      );

      expect(createTmux().listGlobalIdentities()).toEqual([
        { name: 'Alice', canonicalName: 'alice', paneId: '%1' },
      ]);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['show-options', '-p', '-t', '%1', '-v', '@tmux-team.agent'],
        expect.any(Object)
      );
    });

    it('lists global identities independently of workspace metadata', () => {
      mockedExecSync.mockReturnValue(
        '%1\tmain:1.0\t/repo-a\tcodex\t{"version":1,"globalIdentity":{"name":"Alice","canonicalName":"alice"}}\n%2\tmain:2.0\t/repo-b\tzsh\t{"version":1}\n'
      );
      const tmux = createTmux();
      expect(tmux.listGlobalIdentities()).toEqual([
        { name: 'Alice', canonicalName: 'alice', paneId: '%1' },
      ]);
    });

    it('ignores malformed global identity metadata', () => {
      mockedExecSync.mockReturnValue(
        '%1\tmain:1.0\t/repo\tzsh\t{"version":1,"globalIdentity":{"name":42}}\n'
      );
      expect(createTmux().listGlobalIdentities()).toEqual([]);
    });

    it('writes and clears global identity metadata without touching workspace entries', () => {
      mockedExecFileSync.mockReturnValueOnce(
        '{"version":1,"workspaces":{"/repo":{"name":"legacy"}},"teams":{"egp":{"name":"codex"}},"globalIdentity":{"name":"Old","canonicalName":"old"}}'
      );
      const tmux = createTmux();
      tmux.setGlobalIdentity('%9', 'Alice');
      expect(mockedExecFileSync).toHaveBeenLastCalledWith(
        'tmux',
        [
          'set-option',
          '-p',
          '-t',
          '%9',
          '@tmux-team.agent',
          JSON.stringify({
            version: 1,
            workspaces: { '/repo': { name: 'legacy' } },
            teams: { egp: { name: 'codex' } },
            globalIdentity: { name: 'Alice', canonicalName: 'alice' },
          }),
        ],
        expect.any(Object)
      );

      mockedExecFileSync.mockReset();
      mockedExecFileSync.mockReturnValueOnce(
        '{"version":1,"workspaces":{"/repo":{"name":"legacy"}},"teams":{"egp":{"name":"codex"}},"globalIdentity":{"name":"Alice","canonicalName":"alice"}}'
      );
      expect(tmux.clearGlobalIdentity('%9')).toBe(true);
      expect(mockedExecFileSync).toHaveBeenLastCalledWith(
        'tmux',
        [
          'set-option',
          '-p',
          '-t',
          '%9',
          '@tmux-team.agent',
          JSON.stringify({
            version: 1,
            workspaces: { '/repo': { name: 'legacy' } },
            teams: { egp: { name: 'codex' } },
          }),
        ],
        expect.any(Object)
      );

      mockedExecFileSync.mockReset();
      mockedExecFileSync.mockReturnValueOnce(
        '{"version":1,"globalIdentity":{"name":"Alice","canonicalName":"alice"}}'
      );
      expect(tmux.clearGlobalIdentity('%9')).toBe(true);
      expect(mockedExecFileSync).toHaveBeenLastCalledWith(
        'tmux',
        ['set-option', '-p', '-u', '-t', '%9', '@tmux-team.agent'],
        expect.any(Object)
      );
    });

    it.each([
      ['name-only', { name: 'Old' }],
      ['malformed', { name: null }],
    ] as const)(
      'preserves sibling metadata when replacing a %s global marker',
      (_label, marker) => {
        const original = {
          version: 1,
          workspaces: { '/repo': { name: 'legacy' } },
          teams: { egp: { name: 'codex' } },
          customPluginData: { source: 'external', values: ['keep'] },
          globalIdentity: marker,
        };
        mockedExecFileSync.mockReturnValueOnce(JSON.stringify(original));
        const identity: DurableIdentity = {
          id: 'identity-1',
          name: 'Alice',
          canonicalName: 'alice',
          createdAt: 'created',
          updatedAt: 'updated',
        };
        const binding: TmuxBinding = {
          id: 'binding-1',
          identityId: identity.id,
          transport: 'tmux',
          paneId: '%9',
          serverId: 'server-1',
          socketPath: '/tmp/tmux.sock',
          serverPid: 321,
          serverStartTime: 'started',
          panePid: 654,
          boundAt: 'bound',
          lastVerifiedAt: 'verified',
        };

        createTmux().setDurableIdentity!('%9', identity, binding);

        expect(mockedExecFileSync).toHaveBeenLastCalledWith(
          'tmux',
          [
            'set-option',
            '-p',
            '-t',
            '%9',
            '@tmux-team.agent',
            JSON.stringify({
              ...original,
              globalIdentity: {
                name: 'Alice',
                canonicalName: 'alice',
                identityId: 'identity-1',
                bindingId: 'binding-1',
                serverId: 'server-1',
                panePid: 654,
              },
            }),
          ],
          expect.any(Object)
        );
      }
    );

    it('fails closed when durable metadata cannot be read', () => {
      mockedExecFileSync.mockImplementationOnce(() => {
        throw new Error('tmux read failed');
      });
      const identity: DurableIdentity = {
        id: 'identity-1',
        name: 'Alice',
        canonicalName: 'alice',
        createdAt: 'created',
        updatedAt: 'updated',
      };
      const binding: TmuxBinding = {
        id: 'binding-1',
        identityId: identity.id,
        transport: 'tmux',
        paneId: '%9',
        serverId: 'server-1',
        socketPath: '/tmp/tmux.sock',
        serverPid: 321,
        serverStartTime: 'started',
        panePid: 654,
        boundAt: 'bound',
        lastVerifiedAt: 'verified',
      };

      expect(() => createTmux().setDurableIdentity!('%9', identity, binding)).toThrow(
        'tmux read failed'
      );
      expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    });

    it('treats a quiet absent metadata option as an empty metadata object', () => {
      mockedExecFileSync.mockReturnValueOnce('');
      const identity: DurableIdentity = {
        id: 'identity-1',
        name: 'Alice',
        canonicalName: 'alice',
        createdAt: 'created',
        updatedAt: 'updated',
      };
      const binding: TmuxBinding = {
        id: 'binding-1',
        identityId: identity.id,
        transport: 'tmux',
        paneId: '%9',
        serverId: 'server-1',
        socketPath: '/tmp/tmux.sock',
        serverPid: 321,
        serverStartTime: 'started',
        panePid: 654,
        boundAt: 'bound',
        lastVerifiedAt: 'verified',
      };

      createTmux().setDurableIdentity!('%9', identity, binding);
      expect(mockedExecFileSync).toHaveBeenLastCalledWith(
        'tmux',
        ['set-option', '-p', '-t', '%9', '@tmux-team.agent', expect.any(String)],
        expect.any(Object)
      );
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

  describe('durable endpoint snapshots', () => {
    it('does not invoke tmux after a shared deadline expires', () => {
      expect(() =>
        createTmux().getEndpointSnapshot?.({ deadlineMs: performance.now() - 1 })
      ).toThrow('tmux operation deadline exceeded');
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });

    it('propagates strict fallback metadata read failures', () => {
      mockedExecFileSync
        .mockReturnValueOnce(`${VALID_SERVER_ID}\n`)
        .mockReturnValueOnce(`${endpointRow()}\n`)
        .mockImplementationOnce(() => {
          throw new Error('metadata fallback failed');
        });

      expect(() => createTmux().getEndpointSnapshot?.()).toThrow('metadata fallback failed');
    });

    it('uses integer per-command timeouts bounded by a decreasing shared deadline', () => {
      const clock = vi
        .spyOn(performance, 'now')
        .mockImplementationOnce(() => 100)
        .mockImplementationOnce(() => 250)
        .mockImplementationOnce(() => 400);
      mockedExecFileSync
        .mockReturnValueOnce(`${VALID_SERVER_ID}\n`)
        .mockReturnValueOnce(`${endpointRow()}\n`)
        .mockReturnValueOnce(`${JSON.stringify({ version: 1 })}\n`);

      try {
        createTmux().getEndpointSnapshot?.({ deadlineMs: 1_000 });
        const timeouts = mockedExecFileSync.mock.calls.map(([, , options]) => {
          expect(options).toEqual(
            expect.objectContaining({
              timeout: expect.any(Number),
              maxBuffer: 1024 * 1024,
              killSignal: 'SIGKILL',
            })
          );
          const timeout = (options as { timeout: number }).timeout;
          expect(Number.isInteger(timeout)).toBe(true);
          expect(timeout).toBeGreaterThan(0);
          expect(timeout).toBeLessThanOrEqual(1_000);
          return timeout;
        });
        expect(timeouts).toEqual([900, 750, 600]);
      } finally {
        clock.mockRestore();
      }
    });

    it('reads server and pane evidence from one list-panes snapshot', () => {
      const serverId = '123e4567-e89b-42d3-a456-426614174000';
      mockedExecFileSync
        .mockReturnValueOnce(`${serverId}\n`)
        .mockReturnValueOnce(
          [
            serverId,
            '/tmp/tmux.sock',
            '321',
            '1700000000',
            '%9',
            'main:1.0',
            '/repo',
            'codex',
            '654',
            '{"version":1}',
          ].join('__TMT_FIELD_4f1c__') + '\n'
        );

      expect(createTmux().getEndpointSnapshot?.()).toEqual({
        server: {
          serverId,
          socketPath: '/tmp/tmux.sock',
          serverPid: 321,
          serverStartTime: '1700000000',
        },
        panes: [
          {
            id: '%9',
            target: 'main:1.0',
            cwd: '/repo',
            command: 'codex',
            panePid: 654,
            suggestedName: 'codex',
            metadata: { version: 1 },
          },
        ],
      });
      expect(mockedExecFileSync).toHaveBeenLastCalledWith(
        'tmux',
        ['list-panes', '-a', '-F', expect.stringContaining('#{socket_path}')],
        expect.any(Object)
      );
    });

    it('rejects mixed server evidence instead of constructing a torn snapshot', () => {
      const serverId = '123e4567-e89b-42d3-a456-426614174000';
      const row = (pid: string, pane: string) =>
        [
          serverId,
          '/tmp/tmux.sock',
          pid,
          '1700000000',
          pane,
          `main:1.${pane.slice(1)}`,
          '/repo',
          'node',
          '654',
          '{"version":1}',
        ].join('__TMT_FIELD_4f1c__');
      mockedExecFileSync
        .mockReturnValueOnce(`${serverId}\n`)
        .mockReturnValueOnce(`${row('321', '%1')}\n${row('999', '%2')}\n`);

      expect(() => createTmux().getEndpointSnapshot?.()).toThrow(
        'tmux endpoint snapshot contains inconsistent server evidence'
      );
    });

    it('probes a known socket with bounded read-only evidence and no current-server metadata fallback', () => {
      mockedExecFileSync.mockReturnValueOnce(`${endpointRow()}\n`);

      const result = createTmux().probeEndpoint?.('/tmp/foreign.sock', 321);

      expect(result).toMatchObject({
        status: 'live',
        snapshot: { server: { socketPath: '/tmp/foreign.sock' } },
      });
      expect(result?.status === 'live' && result.snapshot.panes[0]?.metadata).toBeUndefined();
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['-S', '/tmp/foreign.sock', 'list-panes', '-a', '-F', expect.any(String)],
        expect.objectContaining({
          timeout: 1000,
          maxBuffer: 1024 * 1024,
          killSignal: 'SIGKILL',
        })
      );
      expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
      expect(mockedExecSync).not.toHaveBeenCalled();
      expect(
        mockedExecFileSync.mock.calls.some(
          ([, args]) => Array.isArray(args) && args.includes('show-options')
        )
      ).toBe(false);
    });

    it('classifies a failed probe as dead only when the recorded PID is gone', () => {
      mockedExecFileSync.mockImplementationOnce(() => {
        throw new Error('tmux probe timed out');
      });
      const kill = vi.spyOn(process, 'kill').mockImplementationOnce(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      });

      expect(createTmux().probeEndpoint?.('/tmp/dead.sock', 321)).toEqual({ status: 'dead' });
      kill.mockRestore();
    });

    it('preserves uncertainty when a failed probe cannot validate process death', () => {
      mockedExecFileSync.mockImplementationOnce(() => {
        throw new Error('tmux probe timed out');
      });
      const kill = vi.spyOn(process, 'kill').mockImplementationOnce(() => true);

      expect(createTmux().probeEndpoint?.('/tmp/unknown.sock', 321)).toEqual({
        status: 'unknown',
      });
      kill.mockRestore();
    });

    it.each([
      ['invalid pane ID', endpointRow({ paneId: 'not-a-pane-id' })],
      ['mismatched returned socket', endpointRow({ socketPath: '/tmp/different.sock' })],
      ['invalid UUID', endpointRow({ serverId: 'not-a-uuid' })],
      ['empty UUID', endpointRow({ serverId: '' })],
      [
        'truncated row',
        endpointRow().split(ENDPOINT_SEPARATOR).slice(0, 9).join(ENDPOINT_SEPARATOR),
      ],
      ['fractional pane PID', endpointRow({ panePid: '654.5' })],
      ['unsafe pane PID', endpointRow({ panePid: '9007199254740992' })],
    ] as const)('returns unknown for %s endpoint evidence', (_label, row) => {
      mockedExecFileSync.mockReturnValueOnce(`${row}\n`);

      expect(createTmux().probeEndpoint?.('/tmp/foreign.sock', 321)).toEqual({
        status: 'unknown',
      });
    });

    it('returns unknown for duplicate pane evidence instead of treating a partial parse as live', () => {
      mockedExecFileSync.mockReturnValueOnce(`${endpointRow()}\n${endpointRow()}\n`);

      expect(createTmux().probeEndpoint?.('/tmp/foreign.sock', 321)).toEqual({
        status: 'unknown',
      });
    });

    it('rejects an invalid recorded PID before invoking tmux or signal zero', () => {
      const kill = vi.spyOn(process, 'kill');

      expect(createTmux().probeEndpoint?.('/tmp/foreign.sock', 321.5)).toEqual({
        status: 'unknown',
      });
      expect(mockedExecFileSync).not.toHaveBeenCalled();
      expect(kill).not.toHaveBeenCalled();
      kill.mockRestore();
    });

    it('preserves unknown when signal zero is denied after a failed probe', () => {
      mockedExecFileSync.mockImplementationOnce(() => {
        throw new Error('tmux probe failed');
      });
      const kill = vi.spyOn(process, 'kill').mockImplementationOnce(() => {
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      });

      expect(createTmux().probeEndpoint?.('/tmp/foreign.sock', 321)).toEqual({
        status: 'unknown',
      });
      kill.mockRestore();
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
      mockedExecFileSync.mockReturnValueOnce('{"version":1,"teams":{"egp":{"name":"legacy"}}}\n');
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
          '{"version":1,"teams":{"egp":{"name":"legacy"}},"workspaces":{"/repo":{"name":"codex","preamble":"Be strict"}}}',
        ],
        expect.any(Object)
      );
    });

    it('clears workspace registration while preserving legacy team metadata', () => {
      mockedExecSync.mockReturnValue(
        '%1\tcodex\t{"version":1,"workspaces":{"/repo":{"name":"codex"}},"teams":{"egp":{"name":"legacy"}}}\n'
      );
      const tmux = createTmux();
      expect(
        tmux.clearAgentRegistration('codex', { type: 'workspace', workspaceRoot: '/repo' })
      ).toBe(true);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        [
          'set-option',
          '-p',
          '-t',
          '%1',
          '@tmux-team.agent',
          '{"version":1,"teams":{"egp":{"name":"legacy"}}}',
        ],
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
  });

  describe('pane ID handling', () => {
    it('accepts window.pane format', () => {
      mockedExecSync.mockReturnValue('');
      const tmux = createTmux();

      tmux.send('1.2', 'Hello', { enterDelayMs: 0 });
      tmux.capture('1.2', 100);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['paste-buffer', '-b', expect.stringMatching(/^tmt-/), '-d', '-t', '1.2', '-p'],
        expect.any(Object)
      );
    });

    it('accepts session:window.pane format', () => {
      mockedExecSync.mockReturnValue('');
      const tmux = createTmux();

      tmux.send('main:1.2', 'Hello', { enterDelayMs: 0 });
      tmux.capture('main:1.2', 100);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['paste-buffer', '-b', expect.stringMatching(/^tmt-/), '-d', '-t', 'main:1.2', '-p'],
        expect.any(Object)
      );
    });

    it('quotes pane ID to prevent shell injection', () => {
      mockedExecSync.mockReturnValue('');
      const tmux = createTmux();

      // Malicious pane ID attempt
      tmux.send('1.0; rm -rf /', 'Hello', { enterDelayMs: 0 });

      // Should be quoted and treated as literal string
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['paste-buffer', '-b', expect.stringMatching(/^tmt-/), '-d', '-t', '1.0; rm -rf /', '-p'],
        expect.any(Object)
      );
    });
  });

  describe('pane titles', () => {
    it('sets the title and displays it right-aligned in the themed pane border', () => {
      const tmux = createTmux();

      tmux.setPaneTitle('%9', 'backend');

      expect(mockedExecFileSync).toHaveBeenNthCalledWith(
        1,
        'tmux',
        ['select-pane', '-t', '%9', '-T', 'backend'],
        expect.any(Object)
      );
      expect(mockedExecFileSync).toHaveBeenNthCalledWith(
        2,
        'tmux',
        ['set-window-option', '-t', '%9', 'pane-border-status', 'top'],
        expect.any(Object)
      );
      expect(mockedExecFileSync).toHaveBeenNthCalledWith(
        3,
        'tmux',
        ['set-window-option', '-t', '%9', 'pane-border-format', '#[align=right]#{pane_title}'],
        expect.any(Object)
      );
      expect(mockedExecFileSync.mock.calls[2]?.[1]).not.toContain('#[fg=');
    });
  });
});
