import { describe, expect, it, vi } from 'vitest';
import { IdentitySelectionError } from '../identity-context.js';
import { IdentityServiceError } from '../identity-service.js';
import type { DurableIdentity } from '../domain/identity.js';
import type { Context, IdentityService, UI } from '../types.js';
import { cmdIdentity } from './identity.js';

type MockUI = UI & { jsonCalls: unknown[] };

function identity(name = 'Alice'): DurableIdentity {
  return {
    id: 'identity-alice',
    name,
    canonicalName: name.toLowerCase(),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function context(json = true): {
  ctx: Context;
  ui: MockUI;
  identityService: IdentityService;
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
  const identityService = {
    bindCurrent: vi.fn(),
    bindPane: vi.fn(),
    unbindCurrent: vi.fn(),
    currentIdentity: vi.fn(),
    resolveIdentity: vi.fn(),
    activeIdentities: vi.fn(() => []),
    resolveActive: vi.fn(),
    reconcile: vi.fn(),
    createIdentity: vi.fn(() => ({ identity: identity(), created: true })),
    showIdentity: vi.fn(() => identity()),
    listIdentities: vi.fn(() => [identity()]),
  } satisfies IdentityService;
  const exit = ((code: number): never => {
    throw new Error(`exit(${code})`);
  }) as (code: number) => never;
  const ctx = {
    argv: [],
    flags: { json, verbose: false },
    ui,
    identityService,
    exit,
    get config(): never {
      throw new Error('config must not be accessed');
    },
    get tmux(): never {
      throw new Error('tmux must not be accessed');
    },
  } as unknown as Context;
  return { ctx, ui, identityService, exit };
}

describe('cmdIdentity', () => {
  it('creates through the service and publishes only the public JSON DTO', () => {
    const { ctx, ui, identityService } = context();
    cmdIdentity(ctx, { kind: 'identity', operation: 'create', name: ' Alice ' });

    expect(identityService.createIdentity).toHaveBeenCalledWith(' Alice ');
    expect(ui.jsonCalls).toEqual([
      {
        identity: { id: 'identity-alice', name: 'Alice', canonicalName: 'alice' },
        created: true,
      },
    ]);
  });

  it('shows and lists explicit identities without consulting config or tmux', () => {
    const shown = context();
    cmdIdentity(shown.ctx, { kind: 'identity', operation: 'show', name: 'alice' });
    expect(shown.identityService.showIdentity).toHaveBeenCalledWith('alice');
    expect(shown.ui.jsonCalls).toEqual([
      { identity: { id: 'identity-alice', name: 'Alice', canonicalName: 'alice' } },
    ]);

    const listed = context();
    cmdIdentity(listed.ctx, { kind: 'identity', operation: 'list' });
    expect(listed.identityService.listIdentities).toHaveBeenCalledOnce();
    expect(listed.ui.jsonCalls).toEqual([
      { identities: [{ id: 'identity-alice', name: 'Alice', canonicalName: 'alice' }] },
    ]);
  });

  it('keeps human output semantic and concise', () => {
    const create = context(false);
    cmdIdentity(create.ctx, { kind: 'identity', operation: 'create', name: 'Alice' });
    const createdMessage = vi.mocked(create.ui.success).mock.calls[0]?.[0];
    expect(createdMessage).toMatch(/created/i);
    expect(createdMessage).toContain('Alice');
    expect(createdMessage).toContain('identity-alice');

    const existing = context(false);
    vi.mocked(existing.identityService.createIdentity).mockReturnValue({
      identity: identity(),
      created: false,
    });
    cmdIdentity(existing.ctx, { kind: 'identity', operation: 'create', name: 'Alice' });
    const existingMessage = vi.mocked(existing.ui.success).mock.calls[0]?.[0];
    expect(existingMessage).toMatch(/already exists/i);
    expect(existingMessage).toContain('Alice');
    expect(existingMessage).toContain('identity-alice');

    const show = context(false);
    cmdIdentity(show.ctx, { kind: 'identity', operation: 'show', name: 'Alice' });
    expect(show.ui.table).toHaveBeenCalledWith(
      ['NAME', 'CANONICAL NAME', 'ID'],
      [['Alice', 'alice', 'identity-alice']]
    );

    const list = context(false);
    cmdIdentity(list.ctx, { kind: 'identity', operation: 'list' });
    expect(list.ui.table).toHaveBeenCalledWith(['NAME', 'ID'], [['Alice', 'identity-alice']]);

    const empty = context(false);
    vi.mocked(empty.identityService.listIdentities).mockReturnValue([]);
    cmdIdentity(empty.ctx, { kind: 'identity', operation: 'list' });
    expect(empty.ui.info).toHaveBeenCalledWith('No durable identities found.');
  });

  it.each([
    [new IdentityServiceError('INVALID_NAME', 'Identity name is invalid.'), 'INVALID_NAME', 1],
    [
      new IdentitySelectionError('NAME_NOT_FOUND', "Identity 'missing' was not found."),
      'NAME_NOT_FOUND',
      3,
    ],
  ] as const)('maps expected error %s to JSON and exit %i', (error, code, exitCode) => {
    const { ctx, ui, identityService } = context();
    vi.mocked(identityService.showIdentity).mockImplementation(() => {
      throw error;
    });

    expect(() =>
      cmdIdentity(ctx, { kind: 'identity', operation: 'show', name: 'missing' })
    ).toThrow(`exit(${exitCode})`);
    expect(ui.jsonCalls).toEqual([{ error: { code, message: error.message } }]);
  });

  it('sanitizes unexpected service failures while preserving the public error code', () => {
    const { ctx, ui, identityService } = context();
    vi.mocked(identityService.listIdentities).mockImplementation(() => {
      throw new Error('SQLITE_BUSY: /private/secret/database.db');
    });

    expect(() => cmdIdentity(ctx, { kind: 'identity', operation: 'list' })).toThrow('exit(1)');
    expect(ui.jsonCalls).toEqual([
      { error: { code: 'IDENTITY_ERROR', message: 'Could not complete the identity operation.' } },
    ]);
    expect(JSON.stringify(ui.jsonCalls)).not.toContain('secret');
  });

  it('sanitizes unexpected human failures without ANSI-sensitive snapshots', () => {
    const { ctx, ui, identityService } = context(false);
    vi.mocked(identityService.createIdentity).mockImplementation(() => {
      throw new Error('database secret leaked');
    });

    expect(() =>
      cmdIdentity(ctx, { kind: 'identity', operation: 'create', name: 'Alice' })
    ).toThrow('exit(1)');
    expect(ui.error).toHaveBeenCalledWith('Could not complete the identity operation.');
    expect(JSON.stringify(vi.mocked(ui.error).mock.calls)).not.toContain('secret');
  });
});
