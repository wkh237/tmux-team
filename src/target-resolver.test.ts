import { describe, expect, it, vi } from 'vitest';
import {
  resolveTarget,
  sortedGlobalIdentities,
  type TargetResolverPort,
} from './target-resolver.js';

function resolver(overrides: Partial<TargetResolverPort> = {}): TargetResolverPort {
  return {
    resolvePaneTarget: vi.fn((target: string) => (target.startsWith('%') ? target : '%7')),
    listGlobalIdentities: vi.fn(() => []),
    ...overrides,
  };
}

describe('shared target resolver', () => {
  it.each(['%14', '1.2', 'main:1.2'])('resolves pane locator %s', (input) => {
    const resolvePaneTarget = vi.fn(() => '%14');
    const result = resolveTarget(resolver({ resolvePaneTarget }), input);
    expect(result).toEqual({ ok: true, value: { input, paneId: '%14', kind: 'pane' } });
    expect(resolvePaneTarget).toHaveBeenCalledWith(input);
  });

  it('normalizes identity lookup using TMT-2 name rules', () => {
    const result = resolveTarget(
      resolver({
        listGlobalIdentities: vi.fn(() => [
          { name: ' Ａlice ', canonicalName: 'alice', paneId: '%3' },
        ]),
      }),
      'alice'
    );
    expect(result).toMatchObject({ ok: true, value: { paneId: '%3', kind: 'identity' } });
  });

  it('returns stale pane error without falling back to identity lookup', () => {
    const listGlobalIdentities = vi.fn(() => [{ name: '1.2', canonicalName: '1.2', paneId: '%3' }]);
    const result = resolveTarget(
      resolver({ resolvePaneTarget: vi.fn(() => null), listGlobalIdentities }),
      '1.2'
    );
    expect(result).toEqual({
      ok: false,
      error: { code: 'PANE_NOT_FOUND', message: "Pane target '1.2' was not found." },
    });
    expect(listGlobalIdentities).not.toHaveBeenCalled();
  });

  it('does not consult legacy config when identity is missing', () => {
    const result = resolveTarget(resolver(), 'codex');
    expect(result).toEqual({
      ok: false,
      error: { code: 'NAME_NOT_FOUND', message: "Identity 'codex' is not active." },
    });
  });

  it('sorts identities by canonical name then pane', () => {
    const result = sortedGlobalIdentities(
      resolver({
        listGlobalIdentities: vi.fn(() => [
          { name: 'Zed', canonicalName: 'zed', paneId: '%1' },
          { name: 'alice', canonicalName: 'alice', paneId: '%9' },
          { name: 'Alice 2', canonicalName: 'alice 2', paneId: '%2' },
        ]),
      })
    );
    expect(result.map((entry) => entry.paneId)).toEqual(['%9', '%2', '%1']);
  });
});
