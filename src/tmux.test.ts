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
const CALLER_PANE_SEPARATOR = '__TMT_CALLER_PANE_4f1c__';
const VALID_SERVER_ID = '123e4567-e89b-42d3-a456-426614174000';

function endpointRow(
  overrides: {
    serverId?: string;
    socketPath?: string;
    serverPid?: string;
    paneId?: string;
    target?: string;
    panePid?: string;
    metadata?: string;
  } = {}
): string {
  return [
    overrides.serverId ?? VALID_SERVER_ID,
    overrides.socketPath ?? '/tmp/foreign.sock',
    overrides.serverPid ?? '321',
    '1700000000',
    overrides.paneId ?? '%9',
    overrides.target ?? 'main:1.0',
    '/foreign',
    'node',
    overrides.panePid ?? '654',
    overrides.metadata ?? '',
  ].join(ENDPOINT_SEPARATOR);
}

describe('createTmux', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
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
        expect.objectContaining({
          timeout: 1000,
          maxBuffer: 64 * 1024,
          killSignal: 'SIGKILL',
        })
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

    it('falls back once with the adapted literal payload when set-buffer fails', () => {
      const error = new Error('set-buffer failed');
      mockedExecFileSync.mockImplementationOnce(() => {
        throw error;
      });
      const tmux = createTmux();

      tmux.send('1.0', '-n weird!\nLine two', { enterDelayMs: 0 });

      const calls = mockedExecFileSync.mock.calls.map(([, args]) => args);
      const bufferName = calls[0]?.[2];
      expect(calls[0]).toEqual([
        'set-buffer',
        '-b',
        expect.stringMatching(/^tmt-/),
        '--',
        '-n weird！\nLine two\n',
      ]);
      expect(calls[1]).toEqual(['delete-buffer', '-b', bufferName]);
      expect(calls[2]).toEqual(['send-keys', '-l', '-t', '1.0', '--', '-n weird！\nLine two\n']);
      expect(calls[3]).toEqual(['send-keys', '-t', '1.0', 'Enter']);
      expect(calls.filter((args) => args?.[0] === 'paste-buffer')).toHaveLength(0);
      expect(calls.filter((args) => args?.[0] === 'send-keys')).toEqual([calls[2], calls[3]]);
    });

    it('reports uncertain literal fallback without submitting or replaying', () => {
      mockedExecFileSync.mockImplementation((_, args = []) => {
        if (args[0] === 'set-buffer') throw new Error('set-buffer failed');
        if (args[0] === 'send-keys' && args.includes('--')) throw new Error('literal failed');
        return '';
      });
      const tmux = createTmux();

      expect(() => tmux.send('1.0', 'Hello!', { enterDelayMs: 0 })).toThrowError(
        expect.objectContaining({ code: 'DELIVERY_UNCERTAIN', stage: 'literal' })
      );
      const calls = mockedExecFileSync.mock.calls.map(([, args]) => args);
      expect(calls.filter((args) => args?.[0] === 'send-keys')).toEqual([
        ['send-keys', '-l', '-t', '1.0', '--', 'Hello！\n'],
      ]);
    });

    it('reports uncertain paste failure without replaying input', () => {
      mockedExecFileSync.mockImplementation((_, args = []) => {
        if (args[0] === 'paste-buffer') throw new Error('paste failed');
        return '';
      });
      const tmux = createTmux();

      expect(() => tmux.send('1.0', 'Hello', { enterDelayMs: 0 })).toThrowError(
        expect.objectContaining({ code: 'DELIVERY_UNCERTAIN', stage: 'paste' })
      );
      const calls = mockedExecFileSync.mock.calls.map(([, args]) => args);
      expect(calls[0]?.[0]).toBe('set-buffer');
      expect(calls[1]?.[0]).toBe('paste-buffer');
      expect(calls[2]).toEqual(['delete-buffer', '-b', calls[0]?.[2]]);
      expect(calls.filter((args) => args?.[0] === 'send-keys')).toEqual([]);
    });

    it('preserves uncertain paste outcome when cleanup fails', () => {
      mockedExecFileSync.mockImplementation((_, args = []) => {
        if (args[0] === 'paste-buffer') throw new Error('paste failed');
        if (args[0] === 'delete-buffer') throw new Error('cleanup failed');
        return '';
      });
      const tmux = createTmux();

      expect(() => tmux.send('1.0', 'Hello', { enterDelayMs: 0 })).toThrowError(
        expect.objectContaining({ code: 'DELIVERY_UNCERTAIN', stage: 'paste' })
      );
      const calls = mockedExecFileSync.mock.calls.map(([, args]) => args);
      expect(calls[2]).toEqual(['delete-buffer', '-b', calls[0]?.[2]]);
    });

    it('does not replay after Enter submission becomes uncertain', () => {
      mockedExecFileSync.mockImplementation((_, args = []) => {
        if (args[0] === 'send-keys' && args.includes('Enter')) throw new Error('Enter failed');
        return '';
      });
      const tmux = createTmux();

      expect(() => tmux.send('1.0', 'Hello', { enterDelayMs: 0 })).toThrowError(
        expect.objectContaining({ code: 'DELIVERY_UNCERTAIN', stage: 'submit' })
      );
      const calls = mockedExecFileSync.mock.calls.map(([, args]) => args);
      expect(calls.filter((args) => args?.[0] === 'send-keys')).toEqual([
        ['send-keys', '-t', '1.0', 'Enter'],
      ]);
    });

    it('uses pipe stdio to suppress output', () => {
      const tmux = createTmux();

      tmux.send('1.0', 'Hello', { enterDelayMs: 0 });

      for (const [, , options] of mockedExecFileSync.mock.calls) {
        expect(options).toEqual(
          expect.objectContaining({
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 1000,
            maxBuffer: 64 * 1024,
            killSignal: 'SIGKILL',
          })
        );
      }
    });
  });

  describe('capture', () => {
    it('calls tmux capture-pane with pane ID and line count', () => {
      mockedExecFileSync.mockReturnValue('captured output');
      const tmux = createTmux();

      tmux.capture('1.0', 100);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['capture-pane', '-t', '1.0', '-p', '-S', '-100'],
        expect.objectContaining({
          timeout: 1000,
          maxBuffer: 4 * 1024 * 1024,
          killSignal: 'SIGKILL',
        })
      );
    });

    it('returns captured pane content', () => {
      const expectedOutput = 'Line 1\nLine 2\nLine 3';
      mockedExecFileSync.mockReturnValue(expectedOutput);
      const tmux = createTmux();

      const result = tmux.capture('1.0', 50);

      expect(result).toBe(expectedOutput);
    });

    it('captures specified number of lines', () => {
      mockedExecFileSync.mockReturnValue('');
      const tmux = createTmux();

      tmux.capture('2.1', 200);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['capture-pane', '-t', '2.1', '-p', '-S', '-200'],
        expect.any(Object)
      );
    });

    it('passes hostile pane targets as argv without shell interpretation', () => {
      mockedExecFileSync.mockReturnValue('captured output');
      const tmux = createTmux();
      const hostilePane = '1.0; touch /tmp/tmt-should-not-run';

      tmux.capture(hostilePane, 1);

      expect(mockedExecSync).not.toHaveBeenCalled();
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        ['capture-pane', '-t', hostilePane, '-p', '-S', '-1'],
        expect.any(Object)
      );
    });

    it('throws when pane does not exist', () => {
      const error = new Error("can't find pane: 99.99");
      mockedExecFileSync.mockImplementationOnce(() => {
        throw error;
      });

      const tmux = createTmux();

      expect(() => tmux.capture('99.99', 100)).toThrow("can't find pane: 99.99");
    });

    it('uses utf-8 encoding for output', () => {
      mockedExecFileSync.mockReturnValue('');
      const tmux = createTmux();

      tmux.capture('1.0', 100);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        expect.any(Array),
        expect.objectContaining({ encoding: 'utf-8' })
      );
    });

    it('uses pipe stdio for all streams', () => {
      mockedExecFileSync.mockReturnValue('');
      const tmux = createTmux();

      tmux.capture('1.0', 100);

      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        expect.any(Array),
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

    it('does not query pane options when list-panes omits user metadata', () => {
      mockedExecSync.mockReturnValue('%1\tmain:2.0\t/repo\tnode\t\n');
      mockedExecFileSync.mockReturnValue(
        '{"version":1,"globalIdentity":{"name":"Alice","canonicalName":"alice"}}\n'
      );

      expect(createTmux().listPanes()).toMatchObject([
        {
          id: '%1',
          target: 'main:2.0',
          cwd: '/repo',
          command: 'node',
        },
      ]);
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });

    it('keeps a full 200-pane listing to one tmux subprocess for unbound panes', () => {
      mockedExecSync.mockReturnValue(
        Array.from(
          { length: 200 },
          (_, index) => `%${index}\tmain:1.${index}\t/repo\tzsh\t\n`
        ).join('')
      );

      const panes = createTmux().listPanes();

      expect(panes).toHaveLength(200);
      expect(mockedExecSync).toHaveBeenCalledTimes(1);
      expect(mockedExecFileSync).not.toHaveBeenCalled();
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

    it('preserves opaque metadata through durable replacement and matching clear', () => {
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
      const original = {
        version: 1,
        workspaces: { '/repo': { name: 'legacy' } },
        teams: { egp: { name: 'codex' } },
        future: { flag: true },
        globalIdentity: { name: 'Old' },
      };
      mockedExecFileSync.mockReturnValueOnce(JSON.stringify(original));
      const tmux = createTmux();
      tmux.setDurableIdentity!('%9', identity, binding);
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

      mockedExecFileSync.mockReset();
      mockedExecFileSync.mockReturnValueOnce(
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
        })
      );
      expect(tmux.clearDurableIdentity!('%9', 'binding-1')).toBe(true);
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
            workspaces: original.workspaces,
            teams: original.teams,
            future: original.future,
          }),
        ],
        expect.any(Object)
      );
    });

    it('preserves an unknown-only sibling when clearing a matching durable binding', () => {
      mockedExecFileSync.mockReturnValueOnce(
        JSON.stringify({
          version: 1,
          future: { flag: true },
          globalIdentity: { name: 'Alice', bindingId: 'binding-1' },
        })
      );
      expect(createTmux().clearDurableIdentity!('%9', 'binding-1')).toBe(true);
      expect(mockedExecFileSync).toHaveBeenLastCalledWith(
        'tmux',
        [
          'set-option',
          '-p',
          '-t',
          '%9',
          '@tmux-team.agent',
          JSON.stringify({ version: 1, future: { flag: true } }),
        ],
        expect.any(Object)
      );
    });

    it('clears the durable marker from an otherwise empty metadata envelope', () => {
      mockedExecFileSync.mockReturnValueOnce(
        JSON.stringify({ version: 1, globalIdentity: { name: 'Alice', bindingId: 'binding-1' } })
      );
      expect(createTmux().clearDurableIdentity!('%9', 'binding-1')).toBe(true);
      expect(mockedExecFileSync).toHaveBeenLastCalledWith(
        'tmux',
        ['set-option', '-p', '-u', '-t', '%9', '@tmux-team.agent'],
        expect.any(Object)
      );
    });

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
        expect.objectContaining({
          name: 'PaneMetadataError',
          stage: 'read',
          message: 'Could not read pane metadata.',
          cause: expect.objectContaining({ message: 'tmux read failed' }),
        })
      );
      expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    });

    it('wraps metadata write failures without retrying or leaking subprocess details', () => {
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
      const cause = Object.assign(new Error('private tmux stderr'), { code: 'EPERM' });
      mockedExecFileSync
        .mockReturnValueOnce(JSON.stringify({ version: 1 }))
        .mockImplementationOnce(() => {
          throw cause;
        });

      expect(() => createTmux().setDurableIdentity!('%9', identity, binding)).toThrow(
        expect.objectContaining({
          name: 'PaneMetadataError',
          stage: 'write',
          message: 'Could not write pane metadata (EPERM).',
          cause,
        })
      );
      expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
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
    it('returns TMUX_PANE only when the caller socket, server, and pane agree', () => {
      vi.stubEnv('TMUX', '/tmp/tmux,with,comma.sock,321,0');
      vi.stubEnv('TMUX_PANE', '%9');
      mockedExecFileSync.mockReturnValueOnce(
        `%9${CALLER_PANE_SEPARATOR}/tmp/tmux,with,comma.sock${CALLER_PANE_SEPARATOR}321\n`
      );
      const tmux = createTmux();
      expect(tmux.getCurrentPaneId()).toBe('%9');
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'tmux',
        [
          'display-message',
          '-p',
          '-t',
          '%9',
          `#{pane_id}${CALLER_PANE_SEPARATOR}#{socket_path}${CALLER_PANE_SEPARATOR}#{pid}`,
        ],
        expect.objectContaining({ timeout: 1000, maxBuffer: 4096, killSignal: 'SIGKILL' })
      );
    });

    it('uses bounded process evidence when both caller environment values are absent', () => {
      vi.stubEnv('TMUX', '');
      vi.stubEnv('TMUX_PANE', '');
      const tmux = createTmux();
      expect(tmux.getCurrentPaneId()).toBeNull();
      expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
      expect(mockedExecFileSync).toHaveBeenCalledWith(
        'ps',
        ['-o', 'pid=,ppid=', '-p', String(process.pid)],
        expect.any(Object)
      );
      expect(mockedExecSync).not.toHaveBeenCalled();
    });

    it.each([
      {
        label: 'missing TMUX context',
        tmux: undefined,
        pane: '%9',
        output: undefined,
        calls: 1,
      },
      {
        label: 'malformed pane target',
        tmux: '/tmp/tmux.sock,321,0',
        pane: '0.0',
        output: undefined,
        calls: 0,
      },
      {
        label: 'malformed TMUX context',
        tmux: '/tmp/tmux.sock,321',
        pane: '%9',
        output: undefined,
        calls: 0,
      },
      {
        label: 'empty socket in TMUX context',
        tmux: ',321,0',
        pane: '%9',
        output: undefined,
        calls: 0,
      },
      {
        label: 'stale pane',
        tmux: '/tmp/tmux.sock,321,0',
        pane: '%9',
        output: `${CALLER_PANE_SEPARATOR}/tmp/tmux.sock${CALLER_PANE_SEPARATOR}321\n`,
        calls: 1,
      },
      {
        label: 'socket mismatch',
        tmux: '/tmp/tmux.sock,321,0',
        pane: '%9',
        output: `%9${CALLER_PANE_SEPARATOR}/tmp/other.sock${CALLER_PANE_SEPARATOR}321\n`,
        calls: 1,
      },
      {
        label: 'server mismatch',
        tmux: '/tmp/tmux.sock,321,0',
        pane: '%9',
        output: `%9${CALLER_PANE_SEPARATOR}/tmp/tmux.sock${CALLER_PANE_SEPARATOR}999\n`,
        calls: 1,
      },
      {
        label: 'extra fields',
        tmux: '/tmp/tmux.sock,321,0',
        pane: '%9',
        output: `%9${CALLER_PANE_SEPARATOR}/tmp/tmux.sock${CALLER_PANE_SEPARATOR}321${CALLER_PANE_SEPARATOR}extra\n`,
        calls: 1,
      },
      {
        label: 'extra lines',
        tmux: '/tmp/tmux.sock,321,0',
        pane: '%9',
        output: `%9${CALLER_PANE_SEPARATOR}/tmp/tmux.sock${CALLER_PANE_SEPARATOR}321\nextra\n`,
        calls: 1,
      },
    ])('rejects $label caller evidence', ({ tmux: tmuxValue, pane, output, calls }) => {
      vi.stubEnv('TMUX', tmuxValue ?? '');
      vi.stubEnv('TMUX_PANE', pane);
      if (output !== undefined) mockedExecFileSync.mockReturnValueOnce(output);
      const tmux = createTmux();
      expect(tmux.getCurrentPaneId()).toBeNull();
      expect(mockedExecFileSync).toHaveBeenCalledTimes(calls);
    });

    it('returns null when the caller pane query fails', () => {
      vi.stubEnv('TMUX', '/tmp/tmux.sock,321,0');
      vi.stubEnv('TMUX_PANE', '%9');
      mockedExecFileSync.mockImplementationOnce(() => {
        throw new Error('fail');
      });
      const tmux = createTmux();
      expect(tmux.getCurrentPaneId()).toBeNull();
    });

    it('discovers the unique pane containing the caller process outside tmux env', () => {
      vi.stubEnv('TMUX', '');
      vi.stubEnv('TMUX_PANE', '');
      const parentPid = process.pid + 1;
      mockedExecFileSync
        .mockReturnValueOnce(`${process.pid} ${parentPid}\n`)
        .mockReturnValueOnce(`${parentPid} 0\n`)
        .mockReturnValueOnce(
          `%7${CALLER_PANE_SEPARATOR}${parentPid}${CALLER_PANE_SEPARATOR}/tmp/default.sock${CALLER_PANE_SEPARATOR}321\n`
        );

      expect(createTmux().getCurrentPaneId()).toBe('%7');
      expect(mockedExecFileSync).toHaveBeenLastCalledWith(
        'tmux',
        ['list-panes', '-a', '-F', expect.stringContaining('#{pane_pid}')],
        expect.objectContaining({
          timeout: expect.any(Number),
          maxBuffer: 64 * 1024,
          killSignal: 'SIGKILL',
        })
      );
    });

    it('discovers one caller pane repeated by grouped sessions without extra probes', () => {
      vi.stubEnv('TMUX', '');
      vi.stubEnv('TMUX_PANE', '');
      const row = ['%7', String(process.pid), '/tmp/default.sock', '321'].join(
        CALLER_PANE_SEPARATOR
      );
      mockedExecFileSync
        .mockReturnValueOnce(`${process.pid} 0\n`)
        .mockReturnValueOnce(`${row}\n${row}\n`);

      expect(createTmux().getCurrentPaneId()).toBe('%7');
      expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
    });

    describe.each([false, true])('conflicting caller row first: %s', (conflictFirst) => {
      it.each([
        ['pane PID', 1, '1'],
        ['socket', 2, '/tmp/other.sock'],
        ['server PID', 3, '999'],
      ] as const)('rejects repeated pane IDs with a different %s', (_label, index, value) => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('TMUX_PANE', '');
        const fields = ['%7', String(process.pid), '/tmp/default.sock', '321'];
        const row = fields.join(CALLER_PANE_SEPARATOR);
        fields[index] = value;
        const conflicting = fields.join(CALLER_PANE_SEPARATOR);
        const rows = conflictFirst ? [conflicting, row] : [row, conflicting];
        mockedExecFileSync
          .mockReturnValueOnce(`${process.pid} 0\n`)
          .mockReturnValueOnce(rows.join('\n'));

        expect(createTmux().getCurrentPaneId()).toBeNull();
      });
    });

    it('rejects an ambiguous process-to-pane match', () => {
      vi.stubEnv('TMUX', '');
      vi.stubEnv('TMUX_PANE', '');
      const parentPid = process.pid + 1;
      mockedExecFileSync
        .mockReturnValueOnce(`${process.pid} ${parentPid}\n`)
        .mockReturnValueOnce(`${parentPid} 0\n`)
        .mockReturnValueOnce(
          `%7${CALLER_PANE_SEPARATOR}${parentPid}${CALLER_PANE_SEPARATOR}/tmp/default.sock${CALLER_PANE_SEPARATOR}321\n` +
            `%8${CALLER_PANE_SEPARATOR}${parentPid}${CALLER_PANE_SEPARATOR}/tmp/default.sock${CALLER_PANE_SEPARATOR}321\n`
        );

      expect(createTmux().getCurrentPaneId()).toBeNull();
    });

    it('rejects discovery when process ancestry cannot be read', () => {
      vi.stubEnv('TMUX', '');
      vi.stubEnv('TMUX_PANE', '');
      mockedExecFileSync.mockImplementationOnce(() => {
        throw new Error('ps unavailable');
      });

      expect(createTmux().getCurrentPaneId()).toBeNull();
      expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    });

    it('validates partial pane evidence against the discovered process', () => {
      vi.stubEnv('TMUX', '');
      vi.stubEnv('TMUX_PANE', '%7');
      const parentPid = process.pid + 1;
      mockedExecFileSync
        .mockReturnValueOnce(`${process.pid} ${parentPid}\n`)
        .mockReturnValueOnce(`${parentPid} 0\n`)
        .mockReturnValueOnce(
          `%8${CALLER_PANE_SEPARATOR}${parentPid}${CALLER_PANE_SEPARATOR}/tmp/default.sock${CALLER_PANE_SEPARATOR}321\n`
        );

      expect(createTmux().getCurrentPaneId()).toBeNull();
    });

    it.each([
      ['/tmp/custom.sock', '321', '%7'],
      ['/tmp/other.sock', '321', null],
      ['/tmp/custom.sock', '999', null],
    ])('checks partial server evidence against %s/%s', (socket, server, expected) => {
      vi.stubEnv('TMUX', '/tmp/custom.sock,321,0');
      vi.stubEnv('TMUX_PANE', '');
      mockedExecFileSync
        .mockReturnValueOnce(`${process.pid} 0\n`)
        .mockReturnValueOnce(
          ['%7', String(process.pid), socket, server].join(CALLER_PANE_SEPARATOR)
        );
      expect(createTmux().getCurrentPaneId()).toBe(expected);
      expect(mockedExecFileSync).toHaveBeenLastCalledWith(
        'tmux',
        ['-S', '/tmp/custom.sock', 'list-panes', '-a', '-F', expect.any(String)],
        expect.any(Object)
      );
    });

    it.each([
      ['', '123', '/tmp/default.sock', '321'],
      ['%8', '0', '/tmp/default.sock', '321'],
      ['%8', '123', '', '321'],
      ['%8', '123', '/tmp/default.sock', '0'],
      ['%8', '123', '/tmp/default.sock'],
    ])('rejects malformed rows alongside a valid candidate: %j', (...fields) => {
      vi.stubEnv('TMUX', '');
      vi.stubEnv('TMUX_PANE', '');
      mockedExecFileSync
        .mockReturnValueOnce(`${process.pid} 0\n`)
        .mockReturnValueOnce(
          ['%7', String(process.pid), '/tmp/default.sock', '321'].join(CALLER_PANE_SEPARATOR) +
            '\n' +
            fields.join(CALLER_PANE_SEPARATOR)
        );
      expect(createTmux().getCurrentPaneId()).toBeNull();
    });

    it.each(['ancestry', 'pane listing'])(
      'rejects a shared deadline exhausted during %s',
      (stage) => {
        vi.stubEnv('TMUX', '');
        vi.stubEnv('TMUX_PANE', '');
        let now = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
        mockedExecFileSync.mockImplementation((command) => {
          if (command === 'ps') {
            if (stage === 'ancestry') now = 1000;
            return `${process.pid} 0\n`;
          }
          now = 1000;
          return ['%7', String(process.pid), '/tmp/default.sock', '321'].join(
            CALLER_PANE_SEPARATOR
          );
        });
        try {
          expect(createTmux().getCurrentPaneId()).toBeNull();
          expect(mockedExecFileSync).toHaveBeenCalledTimes(stage === 'ancestry' ? 1 : 2);
        } finally {
          clock.mockRestore();
        }
      }
    );

    it('does not mistake an unrelated pane process for the caller', () => {
      vi.stubEnv('TMUX', '');
      vi.stubEnv('TMUX_PANE', '');
      mockedExecFileSync
        .mockReturnValueOnce(`${process.pid} 0\n`)
        .mockReturnValueOnce(
          ['%7', String(process.pid + 1), '/tmp/default.sock', '321'].join(CALLER_PANE_SEPARATOR)
        );
      expect(createTmux().getCurrentPaneId()).toBeNull();
    });
  });

  describe('durable endpoint snapshots', () => {
    it('does not invoke tmux after a shared deadline expires', () => {
      expect(() =>
        createTmux().getEndpointSnapshot?.({ deadlineMs: performance.now() - 1 })
      ).toThrow('tmux operation deadline exceeded');
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });

    it('does not query pane metadata when list output omits it', () => {
      mockedExecFileSync
        .mockReturnValueOnce(`${VALID_SERVER_ID}\n`)
        .mockReturnValueOnce(`${endpointRow()}\n`);

      const snapshot = createTmux().getEndpointSnapshot?.();
      expect(snapshot?.panes[0]?.id).toBe('%9');
      expect(snapshot?.panes[0]).not.toHaveProperty('metadata');
      expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
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
        expect(timeouts).toEqual([900, 750]);
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

    it('keeps a full 200-pane grouped snapshot to one list subprocess and one entry per pane', () => {
      mockedExecFileSync.mockReturnValueOnce(`${VALID_SERVER_ID}\n`).mockReturnValueOnce(
        Array.from({ length: 200 }, (_, index) =>
          ['main', 'grouped'].map((session) =>
            endpointRow({
              paneId: `%${index}`,
              panePid: String(654 + index),
              target: `${session}:${index}.0`,
            })
          )
        )
          .flat()
          .join('\n') + '\n'
      );

      const snapshot = createTmux().getEndpointSnapshot?.();

      expect(snapshot?.panes).toHaveLength(200);
      expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
      expect(
        mockedExecFileSync.mock.calls.some(
          ([, args]) => Array.isArray(args) && args.includes('show-options') && args.includes('-p')
        )
      ).toBe(false);
    });

    it('scopes pane evidence and metadata to requested IDs while retaining tmux order', () => {
      mockedExecFileSync
        .mockReturnValueOnce(`${VALID_SERVER_ID}\n`)
        .mockReturnValueOnce(
          `${endpointRow({ paneId: '%10' })}\n${endpointRow({ paneId: '%11' })}\n`
        );

      const snapshot = createTmux().getEndpointSnapshot?.({ paneIds: ['%11', '%10'] });

      expect(snapshot?.panes.map((pane) => pane.id)).toEqual(['%10', '%11']);
      expect(mockedExecFileSync).toHaveBeenLastCalledWith(
        'tmux',
        [
          'list-panes',
          '-a',
          '-f',
          expect.stringContaining('#{==:#{pane_id},%11}'),
          '-F',
          expect.any(String),
        ],
        expect.any(Object)
      );
    });

    it('returns coherent server evidence when every scoped pane is absent', () => {
      mockedExecFileSync
        .mockReturnValueOnce(`${VALID_SERVER_ID}\n`)
        .mockReturnValueOnce('')
        .mockReturnValueOnce(
          [VALID_SERVER_ID, '/tmp/foreign.sock', '321', '1700000000'].join(ENDPOINT_SEPARATOR) +
            '\n'
        );

      const snapshot = createTmux().getEndpointSnapshot?.({ paneIds: ['%404'] });

      expect(snapshot).toEqual({
        server: {
          serverId: VALID_SERVER_ID,
          socketPath: '/tmp/foreign.sock',
          serverPid: 321,
          serverStartTime: '1700000000',
        },
        panes: [],
      });
      expect(mockedExecFileSync).toHaveBeenLastCalledWith(
        'tmux',
        ['display-message', '-p', expect.stringContaining('#{socket_path}')],
        expect.any(Object)
      );
    });

    it('uses server-only evidence for an explicitly empty scope', () => {
      mockedExecFileSync
        .mockReturnValueOnce(`${VALID_SERVER_ID}\n`)
        .mockReturnValueOnce(
          [VALID_SERVER_ID, '/tmp/foreign.sock', '321', '1700000000'].join(ENDPOINT_SEPARATOR) +
            '\n'
        );

      const snapshot = createTmux().getEndpointSnapshot?.({ paneIds: [] });

      expect(snapshot?.panes).toEqual([]);
      expect(mockedExecFileSync).toHaveBeenLastCalledWith(
        'tmux',
        ['display-message', '-p', expect.stringContaining('#{socket_path}')],
        expect.any(Object)
      );
      expect(mockedExecFileSync).not.toHaveBeenCalledWith(
        'tmux',
        expect.arrayContaining(['list-panes']),
        expect.any(Object)
      );
    });

    it('rejects invalid scoped pane IDs before invoking tmux', () => {
      expect(() => createTmux().getEndpointSnapshot?.({ paneIds: ['not-a-pane'] })).toThrow(
        'tmux pane scope contains an invalid pane ID'
      );
      expect(mockedExecFileSync).not.toHaveBeenCalled();
    });

    it('rejects truncated full pane evidence instead of returning a pruning snapshot', () => {
      mockedExecFileSync
        .mockReturnValueOnce(`${VALID_SERVER_ID}\n`)
        .mockReturnValueOnce(
          `${endpointRow().split(ENDPOINT_SEPARATOR).slice(0, 9).join(ENDPOINT_SEPARATOR)}\n`
        );

      expect(() => createTmux().getEndpointSnapshot?.()).toThrow(
        'tmux endpoint snapshot contains inconsistent server evidence'
      );
    });

    it('ignores malformed metadata without issuing a pane-specific query', () => {
      mockedExecFileSync
        .mockReturnValueOnce(`${VALID_SERVER_ID}\n`)
        .mockReturnValueOnce(`${endpointRow({ metadata: 'not-json' })}\n`);

      const snapshot = createTmux().getEndpointSnapshot?.();

      expect(snapshot?.panes[0]).not.toHaveProperty('metadata');
      expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
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

    describe.each(['current', 'foreign'] as const)('%s repeated pane evidence', (source) => {
      function readRows(rows: string[]) {
        if (source === 'current') mockedExecFileSync.mockReturnValueOnce(`${VALID_SERVER_ID}\n`);
        mockedExecFileSync.mockReturnValueOnce(rows.join('\n') + '\n');
        const tmux = createTmux();
        return source === 'current'
          ? { status: 'live', snapshot: tmux.getEndpointSnapshot?.({ paneIds: ['%9'] }) }
          : tmux.probeEndpoint?.('/tmp/foreign.sock', 321, { paneIds: ['%9'] });
      }

      it.each(['main:1.0', 'grouped:7.0'])('accepts repeated rows targeting %s', (target) => {
        const result = readRows([endpointRow(), endpointRow({ target })]);
        expect(result).toMatchObject({
          status: 'live',
          snapshot: { panes: [{ id: '%9', panePid: 654, target: 'main:1.0' }] },
        });
        expect(result?.status === 'live' && result.snapshot?.panes).toHaveLength(1);
        expect(mockedExecFileSync).toHaveBeenCalledTimes(source === 'current' ? 2 : 1);
      });

      it('preserves matching opaque metadata containing the field separator', () => {
        const metadata = JSON.stringify({ version: 1, opaque: ENDPOINT_SEPARATOR });
        const result = readRows([
          endpointRow({ metadata }),
          endpointRow({ metadata, target: 'linked:9.0' }),
        ]);
        expect(result).toMatchObject({
          status: 'live',
          snapshot: { panes: [{ metadata: { version: 1, opaque: ENDPOINT_SEPARATOR } }] },
        });
      });

      describe.each([false, true])('invalid row first: %s', (invalidFirst) => {
        it.each([
          ['missing pane ID', endpointRow({ paneId: '' })],
          ['invalid pane PID', endpointRow({ panePid: '0' })],
          ['different pane PID', endpointRow({ panePid: '999' })],
          ['different metadata', endpointRow({ metadata: '{"version":1}' })],
          ['malformed metadata mismatch', endpointRow({ metadata: 'not-json' })],
          ['different server PID', endpointRow({ serverPid: '999' })],
          [
            'truncated row',
            endpointRow().split(ENDPOINT_SEPARATOR).slice(0, 9).join(ENDPOINT_SEPARATOR),
          ],
        ])('does not hide %s through deduplication', (_label, invalid) => {
          const rows = invalidFirst ? [invalid, endpointRow()] : [endpointRow(), invalid];
          if (source === 'current') {
            expect(() => readRows(rows)).toThrow(/tmux endpoint snapshot contains/);
          } else {
            expect(readRows(rows)).toEqual({ status: 'unknown' });
          }
        });
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

  describe('pane target resolution', () => {
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
