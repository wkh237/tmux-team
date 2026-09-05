import { describe, expect, it, vi } from 'vitest';
import { sendTmuxMessage } from './tmux-message.js';

describe('message submission sequencing', () => {
  it.each([false, true])(
    'preserves configured delay before one Enter (fallback: %s)',
    (fallback) => {
      const sequence: string[] = [];
      const execute = vi.fn((args: string[]) => {
        sequence.push(
          args[0] === 'send-keys' ? (args.includes('-l') ? 'literal' : 'submit') : args[0]
        );
        if (fallback && args[0] === 'set-buffer') throw new Error('buffer unavailable');
      });
      sendTmuxMessage({
        paneId: '%7',
        message: 'message!',
        enterDelayMs: 731,
        execute,
        sleep: (milliseconds) => sequence.push(`delay:${milliseconds}`),
      });
      expect(sequence).toEqual(
        fallback
          ? ['set-buffer', 'delete-buffer', 'literal', 'delay:731', 'submit']
          : ['set-buffer', 'paste-buffer', 'delay:731', 'submit']
      );
    }
  );

  it('retains the input failure cause when owned-buffer cleanup also fails', () => {
    const inputError = new Error('input outcome unknown');
    const execute = vi.fn((args: string[]) => {
      if (args[0] === 'paste-buffer') throw inputError;
      if (args[0] === 'delete-buffer') throw new Error('cleanup failed');
    });
    const sleep = vi.fn();
    expect(() =>
      sendTmuxMessage({
        paneId: '%7',
        message: 'message',
        enterDelayMs: 10,
        execute,
        sleep,
      })
    ).toThrowError(expect.objectContaining({ stage: 'paste', cause: inputError }));
    expect(sleep).not.toHaveBeenCalled();
    expect(execute.mock.calls.map(([args]) => args[0])).toEqual([
      'set-buffer',
      'paste-buffer',
      'delete-buffer',
    ]);
  });
});
