import { describe, expect, it } from 'vitest';
import { bindGlobalName, normalizeName, unbindGlobalPane, validateName } from './service.js';
import type { ActiveRegistration, BindingErrorCode } from './types.js';

const active = (name: string, paneId: string): ActiveRegistration => ({
  name,
  canonicalName: normalizeName(name),
  paneId,
});

describe('global name validation', () => {
  it('normalizes deterministically and rejects invalid/pane-shaped names', () => {
    expect(normalizeName(' Ａlice ')).toBe('alice');
    for (const name of [
      '',
      '  ',
      'a\u0000b',
      '%14',
      '10.3',
      'session:2.1',
      '％１４',
      '１０.３',
      'session：２.１',
    ]) {
      expect(validateName(name).ok).toBe(false);
    }
  });
});

describe('global registration transitions', () => {
  it('binds new names and does not mutate input', () => {
    const input: readonly ActiveRegistration[] = [active('Alice', '%1')];
    const result = bindGlobalName(input, 'Bob', '%2');
    expect(result).toMatchObject({ ok: true, value: [...input, active('Bob', '%2')] });
    expect(input).toEqual([active('Alice', '%1')]);
  });

  it('is idempotent for same canonical name and pane', () => {
    const input = [active('Alice', '%1')];
    const result = bindGlobalName(input, ' alice ', '%1');
    expect(result).toEqual({ ok: true, value: input });
  });

  it.each([
    ['PANE_ALREADY_BOUND', [active('Alice', '%1')], 'Bob', '%1'],
    ['NAME_ALREADY_ACTIVE', [active('Alice', '%1')], ' alice ', '%2'],
  ] as readonly [BindingErrorCode, readonly ActiveRegistration[], string, string][])(
    'reports %s without changing state',
    (
      code: BindingErrorCode,
      input: readonly ActiveRegistration[],
      name: string,
      paneId: string
    ) => {
      expect(bindGlobalName(input, name, paneId)).toMatchObject({ ok: false, error: { code } });
      expect(input).toEqual([active('Alice', '%1')]);
    }
  );

  it('rejects invalid bind names without changing state', () => {
    const input = [active('Alice', '%1')];
    expect(bindGlobalName(input, '%14', '%2')).toMatchObject({
      ok: false,
      error: { code: 'INVALID_NAME' },
    });
    expect(input).toHaveLength(1);
  });

  it('unbinds only the selected pane and preserves other registrations', () => {
    const input = [active('Alice', '%1'), active('Bob', '%2')];
    expect(unbindGlobalPane(input, '%1')).toEqual({ ok: true, value: [active('Bob', '%2')] });
    expect(input).toHaveLength(2);
  });

  it('reports missing pane without changing state', () => {
    const input = [active('Alice', '%1')];
    expect(unbindGlobalPane(input, '%9')).toMatchObject({
      ok: false,
      error: { code: 'UNBOUND_PANE' },
    });
    expect(input).toHaveLength(1);
  });
});
