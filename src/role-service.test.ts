import { describe, expect, it, vi } from 'vitest';
import { createRoleService, type RoleRepository } from './role-service.js';
import { IdentitySelectionError } from './identity-context.js';
import { RoleContentError } from './domain/role.js';
import type { DurableIdentity } from './domain/identity.js';

const identity: DurableIdentity = {
  id: 'id-1',
  name: 'Alice',
  canonicalName: 'alice',
  createdAt: 'created',
  updatedAt: 'updated',
};

function repository(): RoleRepository & { role?: { content: string; updatedAt: string } } {
  const value: RoleRepository & { role?: { content: string; updatedAt: string } } = {
    findByCanonicalName: vi.fn((name: string) => (name === 'alice' ? identity : undefined)),
    findRole: vi.fn(() => value.role),
    setRole: vi.fn((_id: string, content: string) => {
      value.role = { content, updatedAt: 'now' };
      return value.role;
    }),
    clearRole: vi.fn(() => {
      value.role = undefined;
      return null;
    }),
  };
  return value;
}

describe('role service', () => {
  it('resolves an explicit durable identity without invoking current-pane lookup', () => {
    const currentIdentity = vi.fn(() => {
      throw new Error('tmux should not be consulted');
    });
    const service = createRoleService({ repository: repository(), currentIdentity });
    expect(service.show({ value: ' ALICE ', kind: 'identity', explicit: true })).toMatchObject({
      identity: { id: 'id-1', name: 'Alice', canonicalName: 'alice' },
      role: null,
    });
    expect(currentIdentity).not.toHaveBeenCalled();
  });

  it('requires a verified current identity when the selector is omitted', () => {
    const service = createRoleService({
      repository: repository(),
      currentIdentity: () => undefined,
    });
    expect(() => service.show()).toThrow('An identity is required');
  });

  it('normalizes content, replaces atomically, and clear returns null directly', () => {
    const repo = repository();
    const service = createRoleService({
      repository: repo,
      currentIdentity: () => ({ identity }),
    });
    const set = service.set(undefined, '\ufeffa\r\nb\r');
    expect(set.role?.content).toBe('a\nb\n');
    expect(service.clear()?.role).toBeNull();
    expect(repo.findRole).not.toHaveBeenCalled();
  });

  it('preserves the prior profile when validation rejects a replacement', () => {
    const repo = repository();
    repo.role = { content: 'last committed profile', updatedAt: 'before' };
    const service = createRoleService({
      repository: repo,
      currentIdentity: () => ({ identity }),
    });

    expect(() => service.set(undefined, 'invalid\u0000profile')).toThrow(RoleContentError);
    expect(repo.setRole).not.toHaveBeenCalled();
    expect(service.show()?.role).toEqual({
      content: 'last committed profile',
      updatedAt: 'before',
    });
  });

  it('rejects missing names and ambiguous current identity', () => {
    const missing = createRoleService({
      repository: repository(),
      currentIdentity: () => undefined,
    });
    expect(() => missing.show({ value: 'missing', kind: 'identity', explicit: true })).toThrow(
      'was not found'
    );
    expect(() => missing.show({ value: 'missing', kind: 'identity', explicit: true })).toThrowError(
      expect.objectContaining({ code: 'NAME_NOT_FOUND' })
    );
    const ambiguous = createRoleService({
      repository: repository(),
      currentIdentity: () => ({ status: 'ambiguous' }),
    });
    expect(() => ambiguous.show()).toThrowError(IdentitySelectionError);
    expect(() => ambiguous.show()).toThrowError(
      expect.objectContaining({ code: 'IDENTITY_AMBIGUOUS' })
    );
    const required = createRoleService({
      repository: repository(),
      currentIdentity: () => undefined,
    });
    expect(() => required.show()).toThrowError(
      expect.objectContaining({ code: 'IDENTITY_REQUIRED' })
    );
  });
});
