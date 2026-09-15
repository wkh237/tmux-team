import { createMemoryHistory } from '@tanstack/react-router';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import avatarVectors from '../../../../contracts/office/avatar-pack-vectors.json';
import { BlockConflict, defaultCatalog } from '../blocks/block-contract.js';
import { decodeAvatarCatalog } from '../avatars/avatar-catalog.js';
import { OfficeApp } from '../office-app.js';
import { createOfficeRouter } from '../router.js';
import type { LocalBlockProjection, LocalRuntime } from './local-runtime.js';
import { PROFILE_CATALOG } from '../profiles/profile-contract.js';
import type { ProfileProjection } from '../profiles/profile-contract.js';

const identityId = '22222222-2222-4222-8222-222222222222';
const blockId = '11111111-1111-4111-8111-111111111111';
const digest = `sha256:${'1'.repeat(64)}`;
const profile: ProfileProjection = {
  identityId,
  identityName: 'Alice',
  exists: true,
  revision: 1,
  profile: {
    displayLabel: 'Signal lead',
    description: '',
    appearance: {
      hairStyle: 'short',
      hairColor: 'ink',
      skinTone: 'medium',
      shirtColor: 'blue',
      shirtMark: 'AI',
    },
    avatarRef: `${digest}/signal-bot`,
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
function runtime(profiles = [profile], initial: LocalBlockProjection[] = [block]): LocalRuntime {
  let blocks = [...initial];
  const unused = async (): Promise<never> => {
    throw new Error('Not used by room scenarios');
  };
  return {
    list: vi.fn(async () => blocks),
    resolveProps: vi.fn(async () => defaultCatalog()),
    profiles: {
      list: vi.fn(async () => profiles),
      show: async () => profile,
      apply: vi.fn(async () => ({ ...profile, changed: false })),
    },
    avatars: {
      list: vi.fn(async () =>
        decodeAvatarCatalog({
          catalogRevision: 1,
          packs: [{ digest, pack: avatarVectors.packCases[0]!.value }],
        })
      ),
    },
    blocks: {
      watch(id, changed) {
        const stored = blocks.find((item) => item.identityId === id);
        changed(
          stored
            ? {
                revision: stored.revision,
                objects: stored.layout.objects,
                updatedAtMs: stored.updatedAtMs,
              }
            : null
        );
        return () => undefined;
      },
      apply: vi.fn(async (id, revision, objects) => {
        const stored = blocks.find((item) => item.identityId === id);
        if ((stored?.revision ?? 0) !== revision) throw new BlockConflict();
        const saved = {
          ...block,
          identityId: id,
          revision: revision + 1,
          layout: { version: 2 as const, objects },
          updatedAtMs: revision + 2,
        };
        blocks = [...blocks.filter((item) => item.identityId !== id), saved];
        return { revision: saved.revision, objects, updatedAtMs: saved.updatedAtMs };
      }),
    },
    board: {
      categories: unused,
      list: unused,
      show: unused,
      post: unused,
      reply: unused,
      edit: unused,
      delete: unused,
    },
    preview: unused,
    avatarPreview: unused,
    dispose: () => undefined,
  };
}
function show(local: LocalRuntime, path = '/local') {
  const router = createOfficeRouter(createMemoryHistory({ initialEntries: [path] }));
  return { ...render(<OfficeApp router={router} local={local} />), router };
}
const pixels = (element: Element) =>
  Array.from(element.querySelectorAll('rect'), (rect) => [
    rect.getAttribute('x'),
    rect.getAttribute('y'),
    rect.getAttribute('fill'),
  ]);

it('reuses identical custom pixels in overview, room and profile without per-render catalog reads', async () => {
  const local = runtime();
  show(local);
  await screen.findByRole('link', { name: "Enter Alice's room" });
  const overview = pixels(document.querySelector('.profile-avatar')!);
  await userEvent.click(screen.getByRole('link', { name: "Enter Alice's room" }));
  await waitFor(() => expect(document.querySelectorAll('.profile-avatar')).toHaveLength(2));
  for (const avatar of document.querySelectorAll('.profile-avatar'))
    expect(pixels(avatar)).toEqual(overview);
  expect(overview.length).toBeGreaterThan(0);
  expect(local.avatars.list).toHaveBeenCalledTimes(2);
});

it('enters an unfurnished identity by keyboard, writes only on save, then shows its saved room', async () => {
  const local = runtime([profile], []);
  show(local);
  const enter = await screen.findByRole('link', { name: "Enter Alice's room" });
  expect(screen.getByText('Unfurnished · not saved')).toBeTruthy();
  expect(local.blocks.apply).not.toHaveBeenCalled();
  enter.focus();
  await userEvent.keyboard('{Enter}');
  await screen.findByRole('button', { name: 'Add desk' });
  expect(local.blocks.apply).not.toHaveBeenCalled();
  expect(local.profiles.apply).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Add desk' }));
  expect(local.blocks.apply).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Save layout' }));
  await waitFor(() =>
    expect(
      within(screen.getByRole('region', { name: 'Office block editor' })).getByRole('status')
        .textContent
    ).toBe('Saved · revision 1')
  );
  expect(local.blocks.apply).toHaveBeenCalledWith(identityId, 0, [
    expect.objectContaining({ x: 14, y: 14 }),
  ]);
  await userEvent.click(screen.getByRole('link', { name: '← Back to office' }));
  await screen.findByText('1 piece · saved');
  expect(screen.queryByText('Unfurnished · not saved')).toBeNull();
});

it('shows multiple labeled rooms without inventing offline presence', async () => {
  const bob = {
    ...profile,
    identityId: '33333333-3333-4333-8333-333333333333',
    identityName: 'Bob',
    online: false,
  };
  show(runtime([profile, bob]));
  const room = await screen.findByRole('article', { name: "Bob's room" });
  expect(within(room).getByText('Offline')).toBeTruthy();
  expect(room.querySelector('.profile-avatar')).toBeNull();
  expect(within(room).getByRole('link', { name: "Enter Bob's room" })).toBeTruthy();
  expect(screen.getByText('2 spaces · 1 online')).toBeTruthy();
});

it('shows an honest empty office without writes', async () => {
  const local = runtime([], []);
  show(local);
  await screen.findByText('tmt identity create alice');
  expect(document.querySelector('.office-room')).toBeNull();
  expect(document.querySelector('.office-floor')).not.toBeNull();
  expect(screen.getByRole('link', { name: 'Visit the board' })).toBeTruthy();
  expect(local.blocks.apply).not.toHaveBeenCalled();
  expect(local.profiles.apply).not.toHaveBeenCalled();
});

it('selects an unfurnished room with the keyboard without fetching or saving another snapshot', async () => {
  const local = runtime([profile], []);
  const list = vi.spyOn(local, 'list');
  const profiles = vi.spyOn(local.profiles, 'list');
  show(local);
  const select = await screen.findByRole('button', { name: "Select Alice's room" });
  const reads = [list.mock.calls.length, profiles.mock.calls.length];
  select.focus();
  await userEvent.keyboard('{Enter}');
  expect(select.getAttribute('aria-pressed')).toBe('true');
  const details = screen.getByRole('complementary', { name: 'Room details' });
  expect(within(details).getByRole('heading', { name: 'Alice' })).toBeTruthy();
  expect(within(details).getByText(/Nothing is saved until/)).toBeTruthy();
  expect(
    within(details).getByRole('link', { name: 'Customize this space →' }).getAttribute('href')
  ).toBe(`/local/agents/${identityId}`);
  expect([list.mock.calls.length, profiles.mock.calls.length]).toEqual(reads);
  expect(local.blocks.apply).not.toHaveBeenCalled();
  expect(local.profiles.apply).not.toHaveBeenCalled();
});

it('drops stale selection details when the identity disappears on refresh', async () => {
  const local = runtime();
  show(local);
  await userEvent.click(await screen.findByRole('button', { name: "Select Alice's room" }));
  local.profiles.list = async () => [];
  await userEvent.click(screen.getByRole('button', { name: 'Refresh office' }));
  await screen.findByText('tmt identity create alice');
  const details = screen.getByRole('complementary', { name: 'Room details' });
  expect(within(details).queryByRole('heading', { name: 'Alice' })).toBeNull();
  expect(within(details).queryByRole('link')).toBeNull();
});

it.each(['blocks', 'profiles', 'avatars', 'props'] as const)(
  'recovers from initial %s failure',
  async (failed) => {
    const local = runtime();
    const rejected = async (): Promise<never> => {
      throw new Error('unavailable');
    };
    if (failed === 'blocks') local.list = rejected;
    if (failed === 'profiles') local.profiles.list = rejected;
    if (failed === 'avatars') local.avatars.list = rejected;
    if (failed === 'props') local.resolveProps = rejected;
    show(local);
    expect((await screen.findByRole('alert')).textContent).toContain('could not load');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByText('Opening your office…')).toBeNull();
  }
);

it('fences late completion from a replaced runtime', async () => {
  const old = runtime();
  let resolveOld!: (value: ProfileProjection[]) => void;
  old.profiles.list = () =>
    new Promise((resolve) => {
      resolveOld = resolve;
    });
  const view = show(old);
  await screen.findByText('Opening your office…');
  const current = runtime([{ ...profile, identityName: 'Bob' }], []);
  view.rerender(<OfficeApp router={view.router} local={current} />);
  await screen.findByRole('link', { name: "Enter Bob's room" });
  await act(async () => {
    resolveOld([profile]);
  });
  expect(screen.queryByRole('link', { name: "Enter Alice's room" })).toBeNull();
});

it('does not expose the previous ready runtime while its replacement loads', async () => {
  const view = show(runtime());
  await screen.findByRole('link', { name: "Enter Alice's room" });
  const next = runtime();
  let resolveNext!: (value: ProfileProjection[]) => void;
  next.profiles.list = () =>
    new Promise((resolve) => {
      resolveNext = resolve;
    });
  view.rerender(<OfficeApp router={view.router} local={next} />);
  expect(screen.queryByRole('link', { name: "Enter Alice's room" })).toBeNull();
  await act(async () => {
    resolveNext([{ ...profile, identityName: 'Bob' }]);
  });
  await screen.findByRole('link', { name: "Enter Bob's room" });
});
