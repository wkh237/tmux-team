import { describe, expect, it, vi } from 'vitest';
import { IdentitySelectionError } from './identity-context.js';
import {
  PreambleContentError,
  type PreambleProfile,
  type StoredPreambleResult,
} from './domain/preamble.js';
import type { DurableIdentity } from './domain/identity.js';
import { createPreambleService, type PreambleRepository } from './preamble-service.js';

const identity: DurableIdentity = {
  id: 'id-1',
  name: 'Alice',
  canonicalName: 'alice',
  createdAt: 'created',
  updatedAt: 'updated',
};

function repository(): PreambleRepository & { preamble?: PreambleProfile } {
  const value: PreambleRepository & { preamble?: PreambleProfile } = {
    findByCanonicalName: vi.fn((name: string) => (name === 'alice' ? identity : undefined)),
    findPreamble: vi.fn(() => value.preamble),
    setPreamble: vi.fn((_id: string, content: string) => {
      value.preamble = { content, updatedAt: 'now' };
      return value.preamble;
    }),
    clearPreamble: vi.fn(() => {
      const existed = value.preamble !== undefined;
      value.preamble = undefined;
      return existed;
    }),
    listPreambles: vi.fn(() => {
      const result: StoredPreambleResult[] = value.preamble
        ? [{ identity, preamble: value.preamble }]
        : [];
      return result;
    }),
  };
  return value;
}

describe('preamble service', () => {
  it('resolves an explicit durable identity and shows a missing preamble as null', () => {
    const repo = repository();
    const service = createPreambleService({ repository: repo });

    expect(service.show(' ALICE ')).toEqual({ identity, preamble: null });
    expect(repo.findByCanonicalName).toHaveBeenCalledWith('alice');
  });

  it('normalizes and stores content, then lists it through the repository', () => {
    const repo = repository();
    const service = createPreambleService({ repository: repo });

    expect(service.set('alice', '\ufeffone\r\ntwo\r')).toEqual({
      identity,
      preamble: { content: 'one\ntwo\n', updatedAt: 'now' },
    });
    expect(service.list()).toEqual([
      { identity, preamble: { content: 'one\ntwo\n', updatedAt: 'now' } },
    ]);
  });

  it('does not write when content validation fails', () => {
    const repo = repository();
    const service = createPreambleService({ repository: repo });

    expect(() => service.set('alice', 'invalid\u0000content')).toThrowError(
      expect.objectContaining({ code: 'PREAMBLE_INPUT_INVALID' })
    );
    expect(() => service.set('alice', 'a'.repeat(65_537))).toThrowError(
      expect.objectContaining({ code: 'PREAMBLE_INPUT_TOO_LARGE' })
    );
    expect(repo.setPreamble).not.toHaveBeenCalled();
    expect(() => service.set('alice', 'invalid\u0000content')).toThrowError(PreambleContentError);
  });

  it('clears idempotently and reports whether a value existed', () => {
    const repo = repository();
    const service = createPreambleService({ repository: repo });

    expect(service.clear('alice')).toEqual({ identity, preamble: null, cleared: false });
    service.set('alice', 'stored');
    expect(service.clear('alice')).toEqual({ identity, preamble: null, cleared: true });
    expect(service.clear('alice')).toEqual({ identity, preamble: null, cleared: false });
  });

  it('rejects unknown identities with the shared selection error', () => {
    const service = createPreambleService({ repository: repository() });

    expect(() => service.show('missing')).toThrowError(IdentitySelectionError);
    expect(() => service.show('missing')).toThrowError(
      expect.objectContaining({ code: 'NAME_NOT_FOUND' })
    );
  });
});
