import { describe, expect, it } from 'vitest';
import vectors from '../../../../contracts/office/profile-v1.vectors.json';
import {
  PROFILE_CATALOG,
  decodeProfileMutation,
  decodeProfileSnapshot,
  validProfile,
} from './profile-contract.js';

describe('profile contract', () => {
  it('uses the shared literal catalog and validation vectors', () => {
    expect(vectors.catalog).toEqual(PROFILE_CATALOG);
    for (const profile of vectors.validProfiles) expect(validProfile(profile)).toBe(true);
    for (const profile of vectors.invalidProfiles) expect(validProfile(profile)).toBe(false);
  });

  it('accepts an omitted or valid avatar reference but not null or a URL', () => {
    expect(validProfile(vectors.validProfiles[0])).toBe(true);
    expect(validProfile(vectors.validProfiles[1])).toBe(true);
    expect(validProfile({ ...vectors.validProfiles[0], avatarRef: null })).toBe(false);
    expect(validProfile({ ...vectors.validProfiles[0], avatarRef: 'https://example.test/a' })).toBe(
      false
    );
  });

  it('rejects nonpositive stored timestamps', () => {
    expect(() =>
      decodeProfileSnapshot({
        identityId: '01020304-0000-4000-8000-000000000000',
        identityName: 'Alice',
        exists: true,
        revision: 1,
        profile: vectors.validProfiles[0],
        updatedAtMs: -1,
        catalog: PROFILE_CATALOG,
      })
    ).toThrow('Invalid profile.');
  });

  it('requires changed only on the strict mutation shape', () => {
    const mutation = {
      identityId: '01020304-0000-4000-8000-000000000000',
      identityName: 'Alice',
      exists: true,
      revision: 1,
      profile: vectors.validProfiles[0],
      updatedAtMs: 1,
      catalog: PROFILE_CATALOG,
      changed: false,
    };
    expect(decodeProfileMutation(mutation).changed).toBe(false);
    const { changed: _changed, ...read } = mutation;
    expect(() => decodeProfileMutation(read)).toThrow('Invalid profile mutation.');
    expect(() => decodeProfileSnapshot(mutation)).toThrow('Invalid profile.');
  });
});
