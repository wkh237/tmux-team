/**
 * Independent screen coordinates for the installation's unsaved platform fixture.
 * The v6 starter spans x=0..104 and source y=-48..136. Its northern and southern
 * eight-unit gaps each expand to a 24-unit bridge. Normalizing the projection
 * around the Lobby origin, applying 7/8 depth and framing gives (-4,-60,112,201).
 * The default v6 meeting preview begins at x=136 and extends the fitted range
 * through x=188, for a total width of 192.
 * Do not import the production camera or hit-test implementation as its oracle.
 */
export function installationWorldPoint(
  viewport: { x: number; y: number; width: number; height: number },
  x: number,
  y: number
) {
  const margin = Math.min(viewport.height * 0.2, Math.max(96, viewport.height * 0.08));
  const scale = Math.min((viewport.width * 0.84) / 192, (viewport.height - 2 * margin) / 201);
  return {
    x: viewport.x + (viewport.width - 192 * scale) / 2 + (x + 4) * scale,
    y: viewport.y + (viewport.height - 201 * scale) / 2 + (y + 60) * scale,
  };
}
