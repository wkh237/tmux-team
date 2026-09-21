import { expect, it } from 'vitest';
import {
  BUILTIN_CATALOG,
  MODULAR_WORKSTATION_DIGEST,
  MODULAR_LOUNGE_DIGEST,
} from '../props/prop-contract.js';
import { officeWorldFixture } from '../../../../test/support/office-world.js';
import { hasRotationArt, rotatedObject } from './object-rotation.js';

it('distinguishes actual chair views from repeated static sofa frames', () => {
  const chair = BUILTIN_CATALOG.find(
    (p) => p.digest === MODULAR_WORKSTATION_DIGEST
  )!.pack.props.find((p) => p.key === 'workstation-chair')!;
  const sofa = BUILTIN_CATALOG.find((p) => p.digest === MODULAR_LOUNGE_DIGEST)!.pack.props.find(
    (p) => p.key === 'lounge-sofa'
  )!;
  expect(hasRotationArt(chair)).toBe(true);
  expect(hasRotationArt(sofa)).toBe(false);
});

it('rotates a rectangular footprint about its center, without changing identity or bindings', () => {
  const object = officeWorldFixture().layout.objects[0]!;
  const rotated = rotatedObject(object, 1);
  expect(rotated).toEqual({
    ...object,
    placement: {
      ...object.placement,
      x: object.placement.x + 1,
      y: object.placement.y - 1,
      rotation: 1,
    },
  });
  expect(rotatedObject(rotated, -1)).toEqual(object);
  expect(rotatedObject(object, 4)).toEqual(object);
});
