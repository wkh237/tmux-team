import { render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import avatarVectors from '../../../../contracts/office/avatar-pack-vectors.json';
import type { Block } from '../blocks/block-contract.js';
import { decodeAvatarCatalog } from '../avatars/avatar-catalog.js';
import { LocalOfficePage } from './local-page.js';
import { LocalRuntimeContext } from './local-runtime.js';
import type { LocalBlockProjection, LocalRuntime } from './local-runtime.js';
import { PROFILE_CATALOG } from '../profiles/profile-contract.js';

const identityId = '22222222-2222-4222-8222-222222222222';
const blockId = '11111111-1111-4111-8111-111111111111';
const digest = `sha256:${'1'.repeat(64)}`;
const avatarRef = `${digest}/signal-bot`;
const profile = {
  identityId,
  identityName: 'Alice',
  exists: true,
  revision: 1,
  profile: {
    displayLabel: 'Signal lead',
    description: '',
    appearance: {
      hairStyle: 'short' as const,
      hairColor: 'ink' as const,
      skinTone: 'medium' as const,
      shirtColor: 'blue' as const,
      shirtMark: 'AI',
    },
    avatarRef,
  },
  updatedAtMs: 1,
  catalog: PROFILE_CATALOG,
  online: true,
};
const block: LocalBlockProjection = {
  exists: true,
  blockId,
  identityId,
  identityName: 'Alice',
  revision: 1,
  layout: { version: 2, objects: [] },
  resolutions: [],
  updatedAtMs: 1,
};

it('loads the avatar catalog once and gives profile preview and block scene identical custom art', async () => {
  const avatars = vi.fn(async () =>
    decodeAvatarCatalog({
      catalogRevision: 1,
      packs: [{ digest, pack: avatarVectors.packCases[0]!.value }],
    })
  );
  const runtime = {
    list: async () => [block],
    profiles: {
      list: async () => [profile],
      show: async () => profile,
      apply: async () => ({ ...profile, changed: false }),
    },
    avatars: { list: avatars },
    blocks: {
      watch: (_id: string, changed: (value: Block) => void) => {
        changed({ revision: 1, objects: [], updatedAtMs: 1 });
        return () => undefined;
      },
      apply: async () => ({ revision: 1, objects: [], updatedAtMs: 1 }),
    },
    dispose: () => undefined,
  } as unknown as LocalRuntime;
  render(
    <LocalRuntimeContext.Provider value={runtime}>
      <LocalOfficePage />
    </LocalRuntimeContext.Provider>
  );
  await waitFor(() => expect(document.querySelectorAll('.profile-avatar')).toHaveLength(2));
  const pixels = Array.from(document.querySelectorAll('.profile-avatar'), (avatar) =>
    Array.from(avatar.querySelectorAll('rect'), (rect) => [
      rect.getAttribute('x'),
      rect.getAttribute('y'),
      rect.getAttribute('fill'),
    ])
  );
  expect(pixels[0]?.length).toBeGreaterThan(0);
  expect(pixels[1]).toEqual(pixels[0]);
  expect(avatars).toHaveBeenCalledOnce();
});

it.each(['blocks', 'profiles', 'avatars'] as const)(
  'shows recovery guidance when the initial %s request fails',
  async (failed) => {
    const rejected = async () => {
      throw new Error('unavailable');
    };
    const runtime = {
      list: failed === 'blocks' ? rejected : async () => [block],
      profiles: {
        list: failed === 'profiles' ? rejected : async () => [profile],
      },
      avatars: {
        list: failed === 'avatars' ? rejected : async () => ({ catalogRevision: 0, packs: [] }),
      },
    } as unknown as LocalRuntime;
    render(
      <LocalRuntimeContext.Provider value={runtime}>
        <LocalOfficePage />
      </LocalRuntimeContext.Provider>
    );
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Local Office could not load. Rerun tmt office start.'
    );
    expect(screen.queryByText('Loading your local office…')).toBeNull();
  }
);

it('resets on runtime replacement and ignores completion from the previous runtime', async () => {
  let resolveOld: ((value: Array<typeof profile>) => void) | undefined;
  const oldProfiles = new Promise<Array<typeof profile>>((resolve) => {
    resolveOld = resolve;
  });
  const oldRuntime = {
    list: async () => [block],
    profiles: { list: () => oldProfiles },
    avatars: { list: async () => ({ catalogRevision: 0, packs: [] }) },
  } as unknown as LocalRuntime;
  const bob = {
    ...profile,
    identityId: '33333333-3333-4333-8333-333333333333',
    identityName: 'Bob',
    profile: { ...profile.profile, displayLabel: '', avatarRef: undefined },
  };
  const currentRuntime = {
    list: async () => [],
    profiles: { list: async () => [bob] },
    avatars: { list: async () => ({ catalogRevision: 0, packs: [] }) },
  } as unknown as LocalRuntime;
  const view = render(
    <LocalRuntimeContext.Provider value={oldRuntime}>
      <LocalOfficePage />
    </LocalRuntimeContext.Provider>
  );
  expect(screen.getByText('Loading your local office…')).toBeTruthy();
  view.rerender(
    <LocalRuntimeContext.Provider value={currentRuntime}>
      <LocalOfficePage />
    </LocalRuntimeContext.Provider>
  );
  await waitFor(() => expect(document.querySelector('.avatar-name')?.textContent).toBe('Bob'));
  resolveOld?.([profile]);
  await Promise.resolve();
  await waitFor(() => expect(document.querySelector('.avatar-name')?.textContent).toBe('Bob'));
});

it('does not expose ready state owned by the previous runtime while its replacement loads', async () => {
  const readyRuntime = {
    list: async () => [block],
    profiles: { list: async () => [profile] },
    avatars: { list: async () => ({ catalogRevision: 0, packs: [] }) },
  } as unknown as LocalRuntime;
  let resolveCurrent: ((value: Array<typeof profile>) => void) | undefined;
  const currentProfiles = new Promise<Array<typeof profile>>((resolve) => {
    resolveCurrent = resolve;
  });
  const currentRuntime = {
    list: async () => [],
    profiles: { list: () => currentProfiles },
    avatars: { list: async () => ({ catalogRevision: 0, packs: [] }) },
  } as unknown as LocalRuntime;
  const view = render(
    <LocalRuntimeContext.Provider value={readyRuntime}>
      <LocalOfficePage />
    </LocalRuntimeContext.Provider>
  );
  await waitFor(() => expect(document.querySelector('.avatar-name')?.textContent).toBe('Alice'));
  view.rerender(
    <LocalRuntimeContext.Provider value={currentRuntime}>
      <LocalOfficePage />
    </LocalRuntimeContext.Provider>
  );
  expect(screen.getByText('Loading your local office…')).toBeTruthy();
  expect(document.querySelector('.avatar-name')).toBeNull();
  resolveCurrent?.([{ ...profile, identityName: 'Bob' }]);
  await waitFor(() => expect(document.querySelector('.avatar-name')?.textContent).toBe('Bob'));
});
