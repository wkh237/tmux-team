import type { SceneRect } from './office-geometry.js';

/** Standard visible connector span before the common depth projection. */
export const PLATFORM_BRIDGE_LENGTH = 24;

/** Expand empty bands between platforms, never room interiors. Both directions
 * share the same monotone transform, including negative coordinates and picking.
 * Normalize around the Lobby origin so adding a northern room does not shift it.
 */
function spacedAxis(intervals: readonly [number, number][]) {
  const merged: [number, number][] = [];
  for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  const gaps = merged.slice(1).map(([end], index) => {
    const start = merged[index]![1];
    const length = end - start;
    // Longer routed circulation is not compressed into a short connector.
    return { start, end, length, extra: Math.max(0, PLATFORM_BRIDGE_LENGTH - length) };
  });
  const offset = (value: number) =>
    gaps.reduce(
      (sum, gap) =>
        sum + (Math.max(0, Math.min(value, gap.end) - gap.start) * gap.extra) / gap.length,
      0
    );
  const zero = offset(0);
  const project = (value: number) => value + offset(value) - zero;
  function unproject(value: number) {
    let extra = 0;
    const shifted = value + zero;
    for (const gap of gaps) {
      const start = gap.start + extra;
      if (shifted < start) return shifted - extra;
      const span = gap.length + gap.extra;
      if (shifted <= start + span) return gap.start + ((shifted - start) * gap.length) / span;
      extra += gap.extra;
    }
    return shifted - extra;
  }
  return { project, unproject };
}

export function platformProjection(rooms: Iterable<SceneRect>, depth: number) {
  const bounds = [...rooms];
  const x = spacedAxis(bounds.map((room) => [room.x, room.x + room.width]));
  const y = spacedAxis(bounds.map((room) => [room.y, room.y + room.height]));
  const projectGround = (point: { x: number; y: number }) => ({
    x: x.project(point.x),
    y: y.project(point.y) * depth,
  });
  const unprojectGround = (point: { x: number; y: number }) => ({
    x: x.unproject(point.x),
    y: y.unproject(point.y / depth),
  });
  const projectGroundRect = (rect: SceneRect, _owner?: string | null): SceneRect => {
    const start = projectGround(rect);
    const end = projectGround({ x: rect.x + rect.width, y: rect.y + rect.height });
    return { ...start, width: end.x - start.x, height: end.y - start.y };
  };
  return {
    version: 6,
    uprightAnchorOffset: (height: number) => height,
    projectGround,
    unprojectGround,
    projectGroundRect,
    projectModuleFloor: projectGroundRect,
    projectUpright: (rect: SceneRect): SceneRect => ({
      ...rect,
      x: x.project(rect.x),
      y: y.project(rect.y + rect.height) * depth - rect.height,
    }),
    projectWallGround: projectGround,
    unprojectWallGround: unprojectGround,
  };
}
