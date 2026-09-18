import { expect, it } from 'vitest';
import vectors from '../../../../contracts/office/modules-central-grid-vectors.json';
import bridges from '../../../../contracts/office/modules-skybridge-vectors.json';
import { decodeModuleMap } from './module-contract.js';
import { moduleSlotBounds, projectModules } from './module-geometry.js';
import { skybridgeModuleWorld } from './module-upgrade.js';
import { worldHistory } from './world-draft.js';
import { officeWorldFixture } from '../../../../test/support/office-world.js';
import { decodeMapSource } from './map-source.js';

const source = () =>
  decodeModuleMap({ ...vectors.map, version: 6, modules: vectors.map.modules.slice(0, 5) });

it.each([
  { rows: [-1, 0], prefix: 'westChain' },
  { rows: [-2, 0], prefix: 'sparseWest' },
  { rows: [-2, -1, 0], prefix: 'sparseWest' },
] as const)(
  'joins west column $rows through public bridges without incidental doors',
  ({ rows, prefix }) => {
    const map = source();
    const added = rows.map((row, index) => ({
      ...map.modules[1]!,
      slot: { type: 'office' as const, column: -1, row },
      area: { ...map.modules[1]!.area, id: `10000000-0000-4000-8000-00000000009${index}` },
    }));
    const input = { ...map, modules: [...map.modules, ...added] };
    const geometry = projectModules(input);
    const at = (x: number, y: number) =>
      geometry.floor.find((s) => s.y === y && s.start <= x && x < s.end);
    for (const [x, y] of bridges[`${prefix}Public`]) expect(at(x!, y!)?.areaId).toBeNull();
    for (const [x, y] of bridges[`${prefix}Empty`]) expect(at(x!, y!)).toBeUndefined();
    for (const [x, y] of bridges[`${prefix}Doors`])
      expect(geometry.doors).toContainEqual({ x, y, axis: 'vertical' });
    for (const [x, y] of bridges[`${prefix}ForbiddenHorizontalDoors`])
      expect(geometry.doors).not.toContainEqual({ x, y, axis: 'horizontal' });
    if ((rows as readonly number[]).includes(-1)) {
      expect(geometry.doors).toContainEqual({ x: -8, y: -28, axis: 'vertical' });
      expect(geometry.doors).not.toContainEqual({ x: -36, y: -8, axis: 'horizontal' });
    }
    expect(projectModules({ ...input, modules: [...input.modules].reverse() })).toEqual(geometry);
  }
);

it.each([-1, 2])('joins a diagonal pod through the nearest row %i bridge', (row) => {
  const map = source();
  const pod = {
    ...map.modules[1]!,
    slot: { type: 'office' as const, column: -1, row },
    area: { ...map.modules[1]!.area, id: '10000000-0000-4000-8000-000000000099' },
  };
  const input = { ...map, modules: [...map.modules, pod] };
  const geometry = projectModules(input);
  const y = row < 0 ? -4 : 92;
  for (const x of [-32, -4, 24])
    expect(
      geometry.floor.find((span) => span.y === y && span.start <= x && x < span.end)?.areaId
    ).toBeNull();
  expect(
    geometry.floor.find((span) => span.y === y && span.start <= 50 && 50 < span.end)
  ).toBeUndefined();
  expect(geometry.doors).toContainEqual({ x: -36, y: row < 0 ? -8 : 96, axis: 'horizontal' });
  expect(geometry.doors).not.toContainEqual({ x: 48, y: row < 0 ? 0 : 88, axis: 'horizontal' });
  expect(projectModules({ ...input, modules: [...input.modules].reverse() })).toEqual(geometry);
});

it('connects four neighboring offices only at their doors, leaving empty slots unbuilt', () => {
  const geometry = projectModules(source());
  const at = (x: number, y: number) =>
    geometry.floor.find((s) => s.y === y && s.start <= x && x < s.end);
  for (const [x, y] of bridges.starterPublic) expect(at(x!, y!)?.areaId).toBeNull();
  for (const [x, y] of bridges.starterEmpty) expect(at(x!, y!)).toBeUndefined();
  for (const [x, y] of bridges.lobbyDoorStarts)
    expect(geometry.doors).toContainEqual({ x, y, axis: 'horizontal' });
  expect(projectModules({ ...source(), modules: [...source().modules].reverse() })).toEqual(
    geometry
  );
});

it('separates meeting pods from the spine and keeps occupied branches through a missing slot', () => {
  const map = source();
  const meetings = bridges.meetingIndices.map((index) => ({
    ...map.modules[1]!,
    slot: { type: 'meeting' as const, index },
    area: {
      id: `10000000-0000-4000-8000-00000000001${index}`,
      name: `Meeting ${index}`,
      binding: { type: 'meeting' as const, roomId: `20000000-0000-4000-8000-00000000001${index}` },
    },
  }));
  const geometry = projectModules({ ...map, modules: [...map.modules, ...meetings] });
  const at = (x: number, y: number) =>
    geometry.floor.find((s) => s.y === y && s.start <= x && x < s.end);
  expect(moduleSlotBounds({ type: 'meeting', index: 2 }, 6)).toEqual(bridges.lastMeetingBounds);
  for (const [x, y] of bridges.meetingPublic) expect(at(x!, y!)?.areaId).toBeNull();
  for (const [x, y] of bridges.meetingEmpty) expect(at(x!, y!)).toBeUndefined();
  expect(geometry.doors).toContainEqual({ x: 136, y: 16, axis: 'vertical' });
  expect(geometry.doors).toContainEqual({ x: 136, y: 112, axis: 'vertical' });
});

it('previews skybridges reversibly without mutating saved sources', () => {
  const world = { version: 1 as const, map: { ...source(), version: 4 as const }, objects: [] };
  const before = structuredClone(world);
  const next = skybridgeModuleWorld(world);
  expect(next.map.version).toBe(6);
  expect(world).toEqual(before);
  expect(skybridgeModuleWorld(next)).toBe(next);
  const history = worldHistory.commit(worldHistory.create(world), next);
  expect(worldHistory.current(worldHistory.undo(history))).toEqual(before);
});

it('moves meeting contents with their pod while retaining identity, order and resource bindings', () => {
  const map = source();
  const meeting = {
    ...map.modules[1]!,
    slot: { type: 'meeting' as const, index: 1 },
    area: {
      id: '10000000-0000-4000-8000-000000000099',
      name: 'Review',
      binding: { type: 'meeting' as const, roomId: '20000000-0000-4000-8000-000000000099' },
    },
  };
  const object = officeWorldFixture().layout.objects[0]!;
  const world = {
    version: 1 as const,
    map: { ...map, version: 5 as const, modules: [...map.modules, meeting] },
    objects: [{ ...object, placement: { ...object.placement, x: 124, y: 44 } }],
  };
  const before = structuredClone(world);
  const next = skybridgeModuleWorld(world);
  expect(next.objects).toEqual([
    { ...world.objects[0], placement: { ...world.objects[0]!.placement, x: 140, y: 52 } },
  ]);
  expect(world).toEqual(before);
});

it('rejects public-floor contents before changing the source', () => {
  const object = officeWorldFixture().layout.objects[0]!;
  const world = {
    version: 1 as const,
    map: { ...source(), version: 5 as const },
    objects: [{ ...object, placement: { ...object.placement, x: 48, y: -4 } }],
  };
  const before = structuredClone(world);
  expect(() => skybridgeModuleWorld(world)).toThrow(/fully inside a room/);
  expect(world).toEqual(before);
});

it('counts the meeting wing together with office floor against the shared budget', () => {
  const map = source();
  const modules = [map.modules[0]!];
  for (let index = 0; index < 130; index++) {
    const id = `10000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`;
    modules.push({
      ...map.modules[1]!,
      slot:
        index < 50
          ? { type: 'office', column: -1 - (index % 5), row: Math.floor(index / 5) }
          : { type: 'meeting', index: index - 50 },
      area: {
        id,
        name: `Room ${index}`,
        binding:
          index < 50 ? { type: 'personal', identityId: null } : { type: 'meeting', roomId: id },
      },
    });
  }
  expect(() => decodeMapSource({ ...map, modules })).toThrow(/floor budgets/);
});
