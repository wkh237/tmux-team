/**
 * Independent screen coordinates for the installation's unsaved Lobby fixture.
 * Floor spans cover x=-4..72, y=0..40, including the retained-layout corridor.
 * A sixteen-tile north wall and the framing margin give (-8,-20,84,68).
 * Do not import the production camera or hit-test implementation as its oracle.
 */
export function installationWorldPoint(
  viewport: { x: number; y: number; width: number; height: number },
  x: number,
  y: number
) {
  const scale = Math.min(viewport.width / 84, viewport.height / 68);
  return {
    x: viewport.x + (viewport.width - 84 * scale) / 2 + (x + 8) * scale,
    y: viewport.y + (viewport.height - 68 * scale) / 2 + (y + 20) * scale,
  };
}
