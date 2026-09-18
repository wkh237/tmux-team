export interface SceneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface OfficeCamera {
  x: number;
  y: number;
  scale: number;
}

/** Fit with a quiet framing margin beneath floating HUD controls. The canvas
 * still occupies the entire viewport; zoom/pan can use every pixel underneath it.
 */
export function fitOfficeCamera(bounds: SceneRect, viewport: SceneRect): OfficeCamera {
  if (viewport.width <= 0 || viewport.height <= 0 || bounds.width <= 0 || bounds.height <= 0)
    return { x: 0, y: 0, scale: 1 };
  const scale = Math.min(viewport.width / bounds.width, viewport.height / bounds.height) * 0.84;
  return {
    scale,
    x: viewport.x + (viewport.width - bounds.width * scale) / 2 - bounds.x * scale,
    y: viewport.y + (viewport.height - bounds.height * scale) / 2 - bounds.y * scale,
  };
}
export function scenePoint(camera: OfficeCamera, x: number, y: number) {
  return { x: (x - camera.x) / camera.scale, y: (y - camera.y) / camera.scale };
}

/** Browser trackpad pinch is a control-wheel gesture; ordinary scrolling pans. */
export function wheelOfficeCamera(
  camera: OfficeCamera,
  input: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'ctrlKey'>,
  x: number,
  y: number,
  viewportHeight: number,
  fitScale: number,
  entryScale: number
): OfficeCamera {
  const unit = input.deltaMode === 1 ? 16 : input.deltaMode === 2 ? viewportHeight : 1;
  if (input.ctrlKey)
    return zoomOfficeCamera(
      camera,
      Math.exp(-input.deltaY * unit * 0.01),
      x,
      y,
      fitScale,
      entryScale
    );
  return { ...camera, x: camera.x - input.deltaX * unit, y: camera.y - input.deltaY * unit };
}
/** Preserve the viewed world center and zoom relative to Fit across viewport changes. */
export function resizeOfficeCamera(
  camera: OfficeCamera,
  bounds: SceneRect,
  previous: SceneRect,
  next: SceneRect
): OfficeCamera {
  const ratio = fitOfficeCamera(bounds, next).scale / fitOfficeCamera(bounds, previous).scale;
  const center = scenePoint(
    camera,
    previous.x + previous.width / 2,
    previous.y + previous.height / 2
  );
  const scale = camera.scale * ratio;
  return {
    scale,
    x: next.x + next.width / 2 - center.x * scale,
    y: next.y + next.height / 2 - center.y * scale,
  };
}
/** Relative bounds keep zoom predictable at both overview and editing scales. */
export function zoomOfficeCamera(
  camera: OfficeCamera,
  factor: number,
  x: number,
  y: number,
  fitScale: number,
  entryScale = fitScale
) {
  const scale = Math.max(fitScale / 4, Math.min(entryScale * 4, camera.scale * factor));
  const point = scenePoint(camera, x, y);
  return { scale, x: x - point.x * scale, y: y - point.y * scale };
}
