import { describe, expect, it, vi } from 'vitest';
import { IdentitySelectionError } from '../identity-context.js';
import {
  ExchangeAttentionError,
  type ExchangeDetail,
  type ExchangeSummary,
} from '../request-attention.js';
import type { RequestService } from '../request-service.js';
import type { Context, IdentityService, UI } from '../types.js';
import { cmdExchange } from './exchange.js';

type MockUI = UI & { readonly jsonCalls: unknown[] };

const identity = {
  id: 'identity-alice',
  name: 'Alice',
  canonicalName: 'alice',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as const;

const summary: ExchangeSummary = {
  requestId: 'req_1',
  recipientIdentityId: 'identity-bob',
  preparedAtMs: 100,
  delivery: 'sent',
  final: { status: 'retained', submittedAtMs: 300, bodyBytes: 11, expiresAtMs: 2_000 },
  revision: 7,
  acknowledged: false,
  settled: false,
  retentionExpiresAtMs: 2_000,
};

const detail: ExchangeDetail = {
  ...summary,
  prompt: { status: 'retained', message: 'private prompt', messageBytes: 13, expiresAtMs: 1_000 },
  final: {
    status: 'retained',
    response: 'exact final',
    submittedAtMs: 300,
    bodyBytes: 11,
    expiresAtMs: 2_000,
  },
};

function context(json = true): {
  ctx: Context;
  ui: MockUI;
  identityService: IdentityService;
  requestService: RequestService;
  exit: (code: number) => never;
} {
  const jsonCalls: unknown[] = [];
  const ui = {
    jsonCalls,
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    table: vi.fn(),
    json(value: unknown) {
      jsonCalls.push(value);
    },
  } as unknown as MockUI;
  const requestService = {
    listExchanges: vi.fn(() => ({ items: [summary], nextAfter: 7 })),
    showExchange: vi.fn(() => detail),
    acknowledgeExchange: vi.fn(() => ({
      requestId: 'req_1',
      revision: 7,
      acknowledged: true as const,
      changed: true,
    })),
    acknowledgeAllExchanges: vi.fn(() => ({ acknowledgedThrough: 7 })),
  } as unknown as RequestService;
  const identityService = {
    resolveIdentity: vi.fn(() => ({ status: 'bound' as const, identity })),
  } as unknown as IdentityService;
  const exit = ((code: number): never => {
    throw new Error(`exit(${code})`);
  }) as (code: number) => never;
  const ctx = {
    argv: [],
    flags: { json, verbose: false },
    ui,
    identityService,
    requestService,
    exit,
    get config(): never {
      throw new Error('config must not be accessed');
    },
    get tmux(): never {
      throw new Error('tmux must not be accessed');
    },
  } as unknown as Context;
  return { ctx, ui, identityService, requestService, exit };
}

const explicitSelector = { value: 'alice', kind: 'identity' as const, explicit: true };

describe('cmdExchange', () => {
  it('resolves the selected identity before listing and emits only public list DTO fields', () => {
    const { ctx, ui, identityService, requestService } = context();
    cmdExchange(ctx, {
      kind: 'exchange',
      operation: 'list',
      selector: explicitSelector,
      limit: 10,
      after: 3,
    });

    expect(identityService.resolveIdentity).toHaveBeenCalledWith(explicitSelector);
    expect(requestService.listExchanges).toHaveBeenCalledWith('identity-alice', {
      limit: 10,
      after: 3,
    });
    expect(ui.jsonCalls).toEqual([
      {
        identity: { id: 'identity-alice', name: 'Alice', canonicalName: 'alice' },
        items: [
          {
            requestId: 'req_1',
            recipientIdentityId: 'identity-bob',
            preparedAtMs: 100,
            delivery: 'sent',
            final: { status: 'retained', submittedAtMs: 300, bodyBytes: 11, expiresAtMs: 2_000 },
            revision: 7,
            acknowledged: false,
            settled: false,
            retentionExpiresAtMs: 2_000,
          },
        ],
        nextAfter: 7,
      },
    ]);
    expect(JSON.stringify(ui.jsonCalls)).not.toContain('attemptId');
    expect(JSON.stringify(ui.jsonCalls)).not.toContain('/private/socket');
    expect(JSON.stringify(ui.jsonCalls)).not.toContain('private prompt');
  });

  it('passes show, single ack, and ackall through the resolved identity and wraps public results', () => {
    const shown = context();
    cmdExchange(shown.ctx, {
      kind: 'exchange',
      operation: 'show',
      selector: explicitSelector,
      requestId: 'req_1',
    });
    expect(shown.requestService.showExchange).toHaveBeenCalledWith('identity-alice', 'req_1');
    expect(shown.ui.jsonCalls).toEqual([
      {
        identity: { id: 'identity-alice', name: 'Alice', canonicalName: 'alice' },
        exchange: {
          requestId: 'req_1',
          recipientIdentityId: 'identity-bob',
          preparedAtMs: 100,
          delivery: 'sent',
          revision: 7,
          acknowledged: false,
          settled: false,
          retentionExpiresAtMs: 2_000,
          prompt: {
            status: 'retained',
            message: 'private prompt',
            messageBytes: 13,
            expiresAtMs: 1_000,
          },
          final: {
            status: 'retained',
            response: 'exact final',
            submittedAtMs: 300,
            bodyBytes: 11,
            expiresAtMs: 2_000,
          },
        },
      },
    ]);
    expect(JSON.stringify(shown.ui.jsonCalls)).not.toContain('private-server');

    const ack = context();
    cmdExchange(ack.ctx, {
      kind: 'exchange',
      operation: 'ack',
      selector: explicitSelector,
      requestId: 'req_1',
      revision: 7,
    });
    expect(ack.requestService.acknowledgeExchange).toHaveBeenCalledWith(
      'identity-alice',
      'req_1',
      7
    );
    expect(ack.ui.jsonCalls).toEqual([
      {
        identity: { id: 'identity-alice', name: 'Alice', canonicalName: 'alice' },
        requestId: 'req_1',
        revision: 7,
        acknowledged: true,
        changed: true,
      },
    ]);

    const all = context();
    cmdExchange(all.ctx, { kind: 'exchange', operation: 'ackall', selector: explicitSelector });
    expect(all.requestService.acknowledgeAllExchanges).toHaveBeenCalledWith('identity-alice');
    expect(all.ui.jsonCalls).toEqual([
      {
        identity: { id: 'identity-alice', name: 'Alice', canonicalName: 'alice' },
        acknowledgedThrough: 7,
      },
    ]);
  });

  it('uses semantic human output for list, empty list, show, and existing acknowledgement', () => {
    const listed = context(false);
    cmdExchange(listed.ctx, { kind: 'exchange', operation: 'list', selector: explicitSelector });
    expect(listed.ui.table).toHaveBeenCalled();
    expect(String(vi.mocked(listed.ui.table).mock.calls[0]?.[0])).toMatch(/REQUEST|REVISION/i);
    expect(JSON.stringify(vi.mocked(listed.ui.table).mock.calls)).toContain('req_1');

    const empty = context(false);
    vi.mocked(empty.requestService.listExchanges).mockReturnValue({ items: [], nextAfter: null });
    cmdExchange(empty.ctx, { kind: 'exchange', operation: 'list', selector: explicitSelector });
    expect(empty.ui.info).toHaveBeenCalledWith(
      expect.stringMatching(/no unacknowledged exchanges/i)
    );

    const show = context(false);
    cmdExchange(show.ctx, {
      kind: 'exchange',
      operation: 'show',
      selector: explicitSelector,
      requestId: 'req_1',
    });
    expect(show.ui.table).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(show.ui.table).mock.calls)).toContain('req_1');
    expect(show.ui.info).toHaveBeenCalledWith(expect.stringContaining('exact final'));

    const existing = context(false);
    vi.mocked(existing.requestService.acknowledgeExchange).mockReturnValue({
      requestId: 'req_1',
      revision: 7,
      acknowledged: true,
      changed: false,
    });
    cmdExchange(existing.ctx, {
      kind: 'exchange',
      operation: 'ack',
      selector: explicitSelector,
      requestId: 'req_1',
      revision: 7,
    });
    expect(existing.ui.success).toHaveBeenCalledWith(
      expect.stringMatching(/already|acknowledged/i)
    );
  });

  it.each([
    [new IdentitySelectionError('IDENTITY_REQUIRED', 'identity required'), 'IDENTITY_REQUIRED', 1],
    [
      new IdentitySelectionError('IDENTITY_AMBIGUOUS', 'identity ambiguous'),
      'IDENTITY_AMBIGUOUS',
      5,
    ],
    [new IdentitySelectionError('NAME_NOT_FOUND', 'missing identity'), 'NAME_NOT_FOUND', 3],
    [new ExchangeAttentionError('X_NOT_FOUND', 'exchange missing'), 'X_NOT_FOUND', 3],
    [new ExchangeAttentionError('X_REVISION_CONFLICT', 'stale revision'), 'X_REVISION_CONFLICT', 5],
    [
      new ExchangeAttentionError('X_INPUT_INVALID', 'invalid attention input'),
      'X_INPUT_INVALID',
      1,
    ],
    [
      new ExchangeAttentionError('X_REVISION_EXHAUSTED', 'revision exhausted'),
      'X_REVISION_EXHAUSTED',
      1,
    ],
  ] as const)('maps expected %s to a sanitized JSON error and exit %i', (error, code, exitCode) => {
    const { ctx, ui, identityService } = context();
    vi.mocked(identityService.resolveIdentity).mockImplementation(() => {
      throw error;
    });
    expect(() => cmdExchange(ctx, { kind: 'exchange', operation: 'list' })).toThrow(
      `exit(${exitCode})`
    );
    expect(ui.jsonCalls).toEqual([{ error: { code, message: error.message } }]);
  });

  it('sanitizes unexpected failures and never accesses config or tmux', () => {
    const { ctx, ui, requestService } = context();
    vi.mocked(requestService.listExchanges).mockImplementation(() => {
      throw new Error('SQLITE_BUSY /private/secret/db.sqlite');
    });
    expect(() =>
      cmdExchange(ctx, { kind: 'exchange', operation: 'list', selector: explicitSelector })
    ).toThrow('exit(1)');
    expect(ui.jsonCalls).toEqual([
      { error: { code: 'X_ERROR', message: 'Could not complete the exchange operation.' } },
    ]);
    expect(JSON.stringify(ui.jsonCalls)).not.toContain('secret');
  });

  it('does not even construct the request service when identity resolution fails', () => {
    const { ctx, ui, identityService } = context();
    const requestServiceAccess = vi.fn(() => {
      throw new Error('request service must not be constructed');
    });
    Object.defineProperty(ctx, 'requestService', {
      configurable: true,
      get: requestServiceAccess,
    });
    vi.mocked(identityService.resolveIdentity).mockImplementation(() => {
      throw new IdentitySelectionError('IDENTITY_REQUIRED', 'identity required');
    });

    expect(() => cmdExchange(ctx, { kind: 'exchange', operation: 'list' })).toThrow('exit(1)');
    expect(requestServiceAccess).not.toHaveBeenCalled();
    expect(ui.jsonCalls).toEqual([
      { error: { code: 'IDENTITY_REQUIRED', message: 'identity required' } },
    ]);
  });
});
