import type { Page } from '@playwright/test';

interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Use independently specified projected fixture extents, not the renderer's
 * own camera or geometry. Coordinates accepted by the result are scene points.
 */
export async function fitWorldCoordinates(page: Page, fittedBounds: Rectangle) {
  await page.getByRole('button', { name: 'Fit office', exact: true }).click();
  const view = (await page.locator('.office-canvas').boundingBox())!;
  const scale = Math.min(view.width / fittedBounds.width, view.height / fittedBounds.height) * 0.84;
  return (x: number, y: number) => ({
    x: view.x + (view.width - fittedBounds.width * scale) / 2 + (x - fittedBounds.x) * scale,
    y: view.y + (view.height - fittedBounds.height * scale) / 2 + (y - fittedBounds.y) * scale,
  });
}
