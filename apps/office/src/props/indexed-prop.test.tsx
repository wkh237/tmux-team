import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BUILTIN_PACK, indexedProp } from './prop-contract.js';
import { IndexedProp } from './indexed-prop.js';

it('renders indexed pixels as inert SVG rectangles', () => {
  const prop = indexedProp(BUILTIN_PACK, 'desk')!;
  const view = render(
    <svg>
      <IndexedProp pack={BUILTIN_PACK} prop={prop} />
    </svg>
  );
  const expected = prop.pixels.join('').replaceAll('0', '').length;
  expect(view.container.querySelectorAll('rect')).toHaveLength(expected);
  expect(view.container.querySelector('script')).toBeNull();
  expect(view.container.querySelector('image')).toBeNull();
});
