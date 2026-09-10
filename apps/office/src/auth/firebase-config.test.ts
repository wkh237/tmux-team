import { describe, expect, it } from 'vitest';
import { officeFirebaseConfig } from './firebase-config.js';

const settings = {
  VITE_FIREBASE_API_KEY: 'public-key',
  VITE_FIREBASE_PROJECT_ID: 'example-office',
  VITE_FIREBASE_AUTH_DOMAIN: 'example-office.firebaseapp.com',
  VITE_FIREBASE_APP_ID: 'public-app-id',
};
describe('explicit cloud configuration', () => {
  it('uses only the supplied public configuration in cloud mode', () => {
    expect(officeFirebaseConfig('cloud', 'localhost', settings)).toEqual({
      apiKey: 'public-key',
      projectId: 'example-office',
      authDomain: 'example-office.firebaseapp.com',
      appId: 'public-app-id',
    });
  });
  it('never leaks cloud configuration into preview or emulator selection', () => {
    expect(officeFirebaseConfig('production', 'localhost', settings)).toBeUndefined();
    expect(officeFirebaseConfig('emulator', 'localhost', settings)?.projectId).toBe(
      'demo-tmt-office'
    );
  });
  it.each(Object.keys(settings))('rejects missing %s without fallback', (key) => {
    expect(() => officeFirebaseConfig('cloud', 'localhost', { ...settings, [key]: '' })).toThrow(
      'complete Firebase'
    );
  });
  it('rejects a mismatched auth domain', () => {
    expect(() =>
      officeFirebaseConfig('cloud', 'localhost', {
        ...settings,
        VITE_FIREBASE_AUTH_DOMAIN: 'other.example',
      })
    ).toThrow('complete Firebase');
  });
});
