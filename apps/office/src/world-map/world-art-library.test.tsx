import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { BUILTIN_DIGEST, BUILTIN_PACK } from '../props/prop-contract.js';
import { WorldArtLibrary } from './world-art-library.js';

const catalog = [{ digest: BUILTIN_DIGEST, pack: BUILTIN_PACK }];

it('searches human names and pack names without changing the draft until a picture is chosen', async () => {
  const user = userEvent.setup();
  const choose = vi.fn();
  render(<WorldArtLibrary catalog={catalog} choose={choose} />);
  const search = screen.getByRole('searchbox', { name: 'Search objects' });
  await user.type(search, '  DESK  ');
  const desk = screen.getByRole('button', { name: 'Desk' });
  expect(desk.querySelector('svg')).not.toBeNull();
  expect(screen.queryByRole('button', { name: 'Chair' })).toBeNull();
  expect(choose).not.toHaveBeenCalled();
  await user.click(desk);
  expect(choose).toHaveBeenCalledExactlyOnceWith(catalog[0], 'desk');
  await user.clear(search);
  await user.type(search, BUILTIN_PACK.label);
  expect(screen.getAllByRole('button')).toHaveLength(BUILTIN_PACK.props.length);
});

it('offers a local search reset with no placement or catalog mutation', async () => {
  const user = userEvent.setup();
  const choose = vi.fn();
  render(<WorldArtLibrary catalog={catalog} choose={choose} />);
  await user.type(screen.getByRole('searchbox'), 'nothing-matches-this');
  expect(screen.queryByRole('button', { name: 'Desk' })).toBeNull();
  const empty = screen.getByRole('status');
  expect(empty.textContent).toContain('No matching objects.');
  await user.click(within(empty).getByRole('button', { name: 'Clear search' }));
  expect(screen.getByRole('searchbox')).toHaveProperty('value', '');
  expect(screen.getAllByRole('button')).toHaveLength(BUILTIN_PACK.props.length);
  expect(choose).not.toHaveBeenCalled();
});
