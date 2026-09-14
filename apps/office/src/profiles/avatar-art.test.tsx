import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { avatarArt } from './avatar-art.js';
import { Avatar } from './avatar.js';
import { PROFILE_CATALOG } from './profile-contract.js';
import type { Appearance } from './profile-contract.js';

const appearance: Appearance = {
  hairStyle: 'short',
  hairColor: 'ink',
  skinTone: 'warm',
  shirtColor: 'blue',
  shirtMark: '',
};

it('keeps every supported appearance on the same bounded sixteen by twenty-four pixel grid', () => {
  const silhouettes = new Set<string>();
  for (const hairStyle of PROFILE_CATALOG.hairStyles) {
    silhouettes.add(avatarArt({ ...appearance, hairStyle }).pixels.join(''));
    for (const hairColor of PROFILE_CATALOG.hairColors)
      for (const skinTone of PROFILE_CATALOG.skinTones)
        for (const shirtColor of PROFILE_CATALOG.shirtColors) {
          const art = avatarArt({ ...appearance, hairStyle, hairColor, skinTone, shirtColor });
          expect(art.pixels).toHaveLength(24);
          for (const row of art.pixels) {
            expect(row).toMatch(/^[0-9a-b]{16}$/);
            for (const index of row) expect(art.palette[Number.parseInt(index, 16)]).toBeDefined();
          }
        }
  }
  expect(silhouettes.size).toBe(5);
});

it('isolates palette customization and never bakes identity text into pixels', () => {
  const original = avatarArt(appearance);
  for (const [field, value, indexes] of [
    ['skinTone', 'deep', [2, 3]],
    ['hairColor', 'silver', [4, 5]],
    ['shirtColor', 'plum', [6, 7]],
  ] as const) {
    const changed = avatarArt({ ...appearance, [field]: value });
    expect(changed.pixels).toEqual(original.pixels);
    expect(
      changed.palette.flatMap((color, index) => (color === original.palette[index] ? [] : [index]))
    ).toEqual(indexes);
  }
  expect(avatarArt({ ...appearance, shirtMark: '<script>' })).toEqual(original);
});

it('renders actual unit pixels instead of smooth character geometry and keeps text inert', () => {
  const view = render(
    <svg>
      <Avatar appearance={{ ...appearance, shirtMark: '<img>' }} name="Alice & team" />
    </svg>
  );
  expect(view.container.querySelectorAll('circle,path,image,script,img')).toHaveLength(0);
  const pixels = view.container.querySelectorAll('rect');
  expect(pixels.length).toBeGreaterThan(100);
  for (const pixel of pixels) {
    expect(pixel.getAttribute('width')).toBe('1');
    expect(pixel.getAttribute('height')).toBe('1');
  }
  expect(view.container.querySelector('.avatar-name')?.textContent).toBe('Alice & team');
  expect(view.container.querySelector('.avatar-mark')?.textContent).toBe('<img>');
  view.unmount();
});
