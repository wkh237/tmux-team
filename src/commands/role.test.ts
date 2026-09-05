import { describe, expect, it, vi } from 'vitest';
import type { Context, RoleResult, RoleService, UI } from '../types.js';
import { cmdRole } from './role.js';
import { IdentitySelectionError } from '../identity-context.js';
import { IdentityServiceError } from '../identity-service.js';

function context(service: RoleService, json = true): Context & { output: unknown[] } {
  const output: unknown[] = [];
  const ui: UI = {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    table: vi.fn(),
    json: (value: unknown) => output.push(value),
  };
  return {
    output,
    argv: [],
    flags: { json, verbose: false },
    ui,
    config: {} as Context['config'],
    tmux: {} as Context['tmux'],
    identityService: {
      bindCurrent: vi.fn(),
      bindPane: vi.fn(),
      unbindCurrent: vi.fn(),
      currentIdentity: vi.fn(),
      activeIdentities: vi.fn(() => []),
      resolveActive: vi.fn(),
      reconcile: vi.fn(),
    },
    get requestService(): Context['requestService'] {
      throw new Error('Unexpected request service access.');
    },
    paths: {} as Context['paths'],
    roleService: service,
    exit: ((code: number) => {
      throw Object.assign(new Error(`exit(${code})`), { exitCode: code });
    }) as Context['exit'],
  };
}

const result: RoleResult = {
  identity: { id: 'id', name: 'Alice', canonicalName: 'alice' },
  role: { content: 'Review code', updatedAt: 'now' },
};

describe('cmdRole', () => {
  it('prints the exact structured result for show/set/clear', () => {
    const service: RoleService = {
      show: vi.fn(() => result),
      set: vi.fn(() => result),
      clear: vi.fn(() => ({ identity: result.identity, role: null })),
    };
    const ctx = context(service);
    cmdRole(ctx, { kind: 'role', operation: 'show' });
    cmdRole(ctx, { kind: 'role', operation: 'set', content: 'Review code' });
    cmdRole(ctx, { kind: 'role', operation: 'clear' });
    expect(ctx.output).toEqual([result, result, { identity: result.identity, role: null }]);
  });

  it('reads file input before invoking the role service', () => {
    const service: RoleService = {
      show: vi.fn(() => result),
      set: vi.fn(() => result),
      clear: vi.fn(() => ({ identity: result.identity, role: null })),
    };
    const ctx = context(service);
    expect(() =>
      cmdRole(ctx, { kind: 'role', operation: 'set', file: '/definitely/missing/role' })
    ).toThrow('exit(1)');
    expect(service.set).not.toHaveBeenCalled();
    expect(ctx.output[0]).toMatchObject({ error: { code: 'ROLE_FILE_ERROR' } });
  });

  it.each([
    ['NAME_NOT_FOUND', 3],
    ['IDENTITY_REQUIRED', 1],
    ['IDENTITY_AMBIGUOUS', 5],
  ] as const)('maps %s to exit %i without a second error', (code, exitCode) => {
    const service: RoleService = {
      show: vi.fn(() => {
        throw new IdentitySelectionError(code, 'selection failed');
      }),
      set: vi.fn(),
      clear: vi.fn(),
    };
    const ctx = context(service);
    expect(() => cmdRole(ctx, { kind: 'role', operation: 'show' })).toThrow(`exit(${exitCode})`);
    expect(ctx.output).toEqual([{ error: { code, message: 'selection failed' } }]);
  });

  it('keeps reconciliation failures distinct from a missing identity', () => {
    const service: RoleService = {
      show: vi.fn(() => {
        throw new IdentityServiceError('RECONCILIATION_FAILED', 'snapshot failed');
      }),
      set: vi.fn(),
      clear: vi.fn(),
    };
    const ctx = context(service);
    expect(() => cmdRole(ctx, { kind: 'role', operation: 'show' })).toThrow('exit(1)');
    expect(ctx.output).toEqual([
      { error: { code: 'RECONCILIATION_FAILED', message: 'snapshot failed' } },
    ]);
  });

  it('shows content or absence and confirms mutations in human output', () => {
    const service: RoleService = {
      show: vi.fn(() => result),
      set: vi.fn(() => result),
      clear: vi.fn(() => ({ identity: result.identity, role: null })),
    };
    const ctx = context(service, false);
    cmdRole(ctx, { kind: 'role', operation: 'show' });
    expect(ctx.ui.info).toHaveBeenCalledWith(result.role!.content);
    vi.mocked(service.show).mockReturnValue({ identity: result.identity, role: null });
    cmdRole(ctx, { kind: 'role', operation: 'show' });
    expect(ctx.ui.info).toHaveBeenCalledWith('No role profile is set.');
    cmdRole(ctx, { kind: 'role', operation: 'set', content: 'Review code' });
    cmdRole(ctx, { kind: 'role', operation: 'clear' });
    expect(ctx.ui.success).toHaveBeenCalledWith("Set role profile for 'Alice'.");
    expect(ctx.ui.success).toHaveBeenCalledWith("Cleared role profile for 'Alice'.");
    expect(ctx.output).toEqual([]);
  });

  it('reports file failures in human output without invoking mutation', () => {
    const service: RoleService = { show: vi.fn(), set: vi.fn(), clear: vi.fn() };
    const ctx = context(service, false);
    expect(() =>
      cmdRole(ctx, { kind: 'role', operation: 'set', file: '/definitely/missing/role' })
    ).toThrow('exit(1)');
    expect(ctx.ui.error).toHaveBeenCalledWith(expect.stringContaining('Could not read role file'));
    expect(service.set).not.toHaveBeenCalled();
  });
});
