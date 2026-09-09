import { getApps } from 'firebase/app';
import { describe, expect, it } from 'vitest';
import { startOfficeSession } from './firebase-session.js';

describe('Firebase activation boundary', () => {
  it('does not initialize Firebase for ordinary preview or unknown modes', () => {
    for (const mode of ['development', 'production', 'preview', 'cloud']) {
      expect(startOfficeSession(mode, 'localhost')).toBeUndefined();
    }
    expect(getApps()).toEqual([]);
  });

  it.each(['office.example', 'localhost.evil', '127.0.0.1.evil', '0.0.0.0', ''])(
    'rejects non-loopback hostname %s before Firebase initialization',
    (hostname) => {
      expect(() => startOfficeSession('emulator', hostname)).toThrow('only available on loopback');
      expect(getApps()).toEqual([]);
    }
  );
});
