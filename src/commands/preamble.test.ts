// ─────────────────────────────────────────────────────────────
// Preamble command tests - durable service boundary and output contract
// ─────────────────────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import type { Context } from '../types.js';
import type { PreambleService } from '../preamble-service.js';
import type { StoredPreambleResult } from '../domain/preamble.js';
import type { DurableIdentity } from '../domain/identity.js';
import { IdentitySelectionError } from '../identity-context.js';
import { PreambleContentError } from '../domain/preamble.js';
import { ExitCodes } from '../exits.js';
import { cmdPreamble, type PreambleRequest } from './preamble.js';

const identity: DurableIdentity = {
  id: 'identity-alice',
  name: 'Alice',
  canonicalName: 'alice',
  createdAt: 'now',
  updatedAt: 'now',
};

function result(content: string | null = null) {
  return {
    identity,
    preamble: content === null ? null : { content, updatedAt: 'now' },
  };
}

function createUI() {
  return {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    table: vi.fn(),
    json: vi.fn(),
  };
}

function createContext(service: PreambleService, flags: Partial<Context['flags']> = {}): Context {
  const ui = createUI();
  return {
    argv: [],
    flags: { json: false, verbose: false, ...flags },
    ui,
    config: {
      mode: 'wait',
      preambleMode: 'always',
      defaults: {
        timeout: 180,
        pollInterval: 1,
        captureLines: 100,
        maxCaptureLines: 2000,
        preambleEvery: 3,
        pasteEnterDelayMs: 500,
      },
    },
    tmux: {
      send: vi.fn(),
      capture: vi.fn(),
      listPanes: vi.fn(() => []),
      getCurrentPaneId: vi.fn(() => null),
      resolvePaneTarget: vi.fn(() => null),
      setPaneTitle: vi.fn(),
    },
    preambleService: service,
    identityService: {
      bindCurrent: vi.fn(),
      bindPane: vi.fn(),
      unbindCurrent: vi.fn(),
      currentIdentity: vi.fn(),
      activeIdentities: vi.fn(() => []),
      resolveActive: vi.fn(),
      reconcile: vi.fn(),
    },
    paths: {
      globalDir: '/tmp/tmt',
      globalConfig: '/tmp/tmt/config.json',
      localConfig: '/tmp/tmt/tmux-team.json',
      stateFile: '/tmp/tmt/state.json',
      databaseFile: '/tmp/tmt/tmux-team.db',
    },
    exit: ((code: number) => {
      throw Object.assign(new Error(`exit(${code})`), { exitCode: code });
    }) as Context['exit'],
  };
}

function createService(overrides: Partial<PreambleService> = {}): PreambleService {
  return {
    show: vi.fn(() => result()),
    set: vi.fn(
      (_name: string, _content: string): StoredPreambleResult => ({
        ...result('saved'),
        preamble: { content: 'saved', updatedAt: 'now' },
      })
    ),
    clear: vi.fn(() => ({ ...result(), cleared: false })),
    list: vi.fn(() => []),
    ...overrides,
  };
}

function request(
  operation: PreambleRequest['operation'],
  values: Omit<PreambleRequest, 'kind' | 'operation'> = {}
): PreambleRequest {
  return { kind: 'preamble', operation, ...values };
}

describe('cmdPreamble', () => {
  it('shows the durable identity name and stored content', () => {
    const service = createService({ show: vi.fn(() => result('Be helpful')) });
    const ctx = createContext(service);

    cmdPreamble(ctx, request('show', { agent: 'alice' }));

    expect(service.show).toHaveBeenCalledWith('alice');
    expect(ctx.ui.info).toHaveBeenCalledWith('Preamble for Alice:\nBe helpful');
  });

  it('returns the legacy JSON shape while using durable identity data', () => {
    const service = createService({ show: vi.fn(() => result('Be helpful')) });
    const ctx = createContext(service, { json: true });

    cmdPreamble(ctx, request('show', { agent: 'ALICE' }));

    expect(ctx.ui.json).toHaveBeenCalledWith({ agent: 'Alice', preamble: 'Be helpful' });
  });

  it('treats an explicit empty identity as a lookup, not list', () => {
    const service = createService({
      show: vi.fn(() => {
        throw new IdentitySelectionError('NAME_NOT_FOUND', 'Identity was not found.');
      }),
    });
    const ctx = createContext(service, { json: true });

    expect(() => cmdPreamble(ctx, request('show', { agent: '' }))).toThrow(
      `exit(${ExitCodes.NAME_NOT_FOUND})`
    );
    expect(service.show).toHaveBeenCalledWith('');
    expect(service.list).not.toHaveBeenCalled();
    expect(ctx.ui.json).toHaveBeenCalledTimes(1);
    expect(ctx.ui.json).toHaveBeenCalledWith({
      error: { code: 'NAME_NOT_FOUND', message: 'Identity was not found.' },
    });
  });

  it('shows only stored preambles in service-provided order', () => {
    const bob = { ...identity, id: 'identity-bob', name: 'Bob', canonicalName: 'bob' };
    const service = createService({
      list: vi.fn(() => [
        { identity, preamble: { content: 'A', updatedAt: 'now' } },
        { identity: bob, preamble: { content: 'B', updatedAt: 'now' } },
      ]),
    });
    const ctx = createContext(service, { json: true });

    cmdPreamble(ctx, request('show'));

    expect(ctx.ui.json).toHaveBeenCalledWith({
      preambles: [
        { agent: 'Alice', preamble: 'A' },
        { agent: 'Bob', preamble: 'B' },
      ],
    });
  });

  it('sets and clears through the durable service', () => {
    const service = createService({
      set: vi.fn(
        (_name: string, _content: string): StoredPreambleResult => ({
          ...result('saved'),
          preamble: { content: 'saved', updatedAt: 'now' },
        })
      ),
      clear: vi.fn(() => ({ ...result(), cleared: true })),
    });
    const ctx = createContext(service, { json: true });

    cmdPreamble(ctx, request('set', { agent: 'alice', preamble: 'saved' }));
    cmdPreamble(ctx, request('clear', { agent: 'alice' }));

    expect(service.set).toHaveBeenCalledWith('alice', 'saved');
    expect(service.clear).toHaveBeenCalledWith('alice');
    expect(ctx.ui.json).toHaveBeenNthCalledWith(1, {
      agent: 'Alice',
      preamble: 'saved',
      status: 'set',
    });
    expect(ctx.ui.json).toHaveBeenNthCalledWith(2, { agent: 'Alice', status: 'cleared' });
  });

  it('returns not_set when clear finds no stored content', () => {
    const ctx = createContext(createService(), { json: true });
    cmdPreamble(ctx, request('clear', { agent: 'alice' }));
    expect(ctx.ui.json).toHaveBeenCalledWith({ agent: 'Alice', status: 'not_set' });
  });

  it.each([
    [
      new IdentitySelectionError('NAME_NOT_FOUND', 'Identity was not found.'),
      ExitCodes.NAME_NOT_FOUND,
      'NAME_NOT_FOUND',
    ],
    [
      new PreambleContentError('PREAMBLE_INPUT_INVALID', 'Invalid preamble.'),
      ExitCodes.ERROR,
      'PREAMBLE_INPUT_INVALID',
    ],
    [new Error('database failed'), ExitCodes.ERROR, 'PREAMBLE_ERROR'],
  ])('maps service failure %s', async (error, exitCode, code) => {
    const service = createService({
      show: vi.fn(() => {
        throw error;
      }),
    });
    const ctx = createContext(service, { json: true });
    await expect(() => cmdPreamble(ctx, request('show', { agent: 'alice' }))).toThrow(
      `exit(${exitCode})`
    );
    expect(ctx.ui.json).toHaveBeenCalledWith({ error: { code, message: error.message } });
  });
});
