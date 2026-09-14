import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PROFILE_CATALOG, ProfileConflict } from './profile-contract.js';
import type { ProfilePort, ProfileSnapshot } from './profile-contract.js';
import { ProfilePanel } from './profile-view.js';

const snapshot: ProfileSnapshot = {
  identityId: '22222222-2222-4222-8222-222222222222',
  identityName: '<img onerror=alert(1)>',
  exists: true,
  revision: 2,
  profile: {
    displayLabel: '',
    description: '',
    appearance: {
      hairStyle: 'curls',
      hairColor: 'silver',
      skinTone: 'deep',
      shirtColor: 'plum',
      shirtMark: '<b>',
    },
  },
  updatedAtMs: 2,
  catalog: PROFILE_CATALOG,
};

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
});
afterEach(() => vi.unstubAllGlobals());

it('renders curated appearance and preserves a draft across conflict and remount', async () => {
  const port: ProfilePort = {
    list: async () => [],
    show: vi.fn(async () => ({ ...snapshot, revision: 3 })),
    apply: vi.fn(async () => {
      throw new ProfileConflict();
    }),
  };
  const changed = vi.fn();
  const first = render(<ProfilePanel initial={snapshot} port={port} changed={changed} />);
  expect(screen.getByText('<img onerror=alert(1)>')).toBeTruthy();
  expect(document.querySelector('img')).toBeNull();
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Unsaved draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save appearance' }));
  await screen.findByRole('alert');
  expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Unsaved draft');
  await waitFor(() => expect(port.show).toHaveBeenCalled());
  first.unmount();
  render(<ProfilePanel initial={snapshot} port={port} changed={changed} />);
  expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Unsaved draft');
});
