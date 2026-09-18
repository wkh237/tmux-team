/**
 * Independent screen coordinates for the installation's unsaved Lobby fixture.
 * The v5 starter spans x=0..104 and source y=-48..136. The meeting
 * ghost extends to x=168; 7/8 depth, 16-high walls and framing margins
 * give (-4,-62,176,189). Lobby interior depth is 61/88 of native depth.
 * Do not import the production camera or hit-test implementation as its oracle.
 */
export function installationWorldPoint(
  viewport: { x: number; y: number; width: number; height: number },
  x: number,
  y: number
) {
  const margin = Math.min(viewport.height * 0.2, Math.max(96, viewport.height * 0.08));
  const scale = Math.min((viewport.width * 0.84) / 176, (viewport.height - 2 * margin) / 189);
  return {
    x: viewport.x + (viewport.width - 176 * scale) / 2 + (x + 4) * scale,
    y: viewport.y + (viewport.height - 189 * scale) / 2 + (y + 62) * scale,
  };
}
