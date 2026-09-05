import { describe, expect, it, vi } from 'vitest';
import type { Context } from '../types.js';
import { ExitCodes } from '../exits.js';
import { rejectUnsupportedTeam } from './unsupported-team.js';

function context(json: boolean): Context {
  return {
    argv: [],
    flags: { json, verbose: false },
    ui: {
      info: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      table: vi.fn(),
      json: vi.fn(),
    },
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
    paths: {} as Context['paths'],
    exit: ((code: number) => {
      const error = new Error(`exit(${code})`) as Error & { exitCode: number };
      error.exitCode = code;
      throw error;
    }) as Context['exit'],
  };
}

describe('unsupported team usage', () => {
  it('returns the structured v5 error in JSON mode', () => {
    const ctx = context(true);
    expect(() => rejectUnsupportedTeam(ctx)).toThrow(`exit(${ExitCodes.UNSUPPORTED_TEAM})`);
    expect(ctx.ui.json).toHaveBeenCalledWith({
      error: {
        code: 'UNSUPPORTED_TEAM',
        message: 'Team-scoped commands and --team are not supported in tmt v5.',
      },
    });
  });

  it('returns the exact human error in human mode', () => {
    const ctx = context(false);
    expect(() => rejectUnsupportedTeam(ctx)).toThrow(`exit(${ExitCodes.UNSUPPORTED_TEAM})`);
    expect(ctx.ui.error).toHaveBeenCalledWith(
      'Team-scoped commands and --team are not supported in tmt v5.'
    );
  });
});
