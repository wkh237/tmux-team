/** Independent SVG oracle: expand inert integer row-run paths into sorted cells. */
export function readRasterCells(element: Element): string[][] {
  const cells: string[][] = [];
  for (const raster of element.querySelectorAll('svg[shape-rendering="crispEdges"]')) {
    if (Array.from(raster.children).some((child) => child.localName !== 'path'))
      throw new Error('Raster contains an unexpected drawing primitive.');
  }
  for (const path of element.querySelectorAll('svg[shape-rendering="crispEdges"] path')) {
    const data = path.getAttribute('d') ?? '';
    const segments = Array.from(data.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g));
    if (segments.map((segment) => segment[0]).join('') !== data)
      throw new Error('Raster contains non-grid geometry.');
    for (const [, x, y, width, back] of segments) {
      if (width !== back || Number(width) < 1) throw new Error('Raster run does not close.');
      for (let offset = 0; offset < Number(width); offset += 1)
        cells.push([String(Number(x) + offset), y!, path.getAttribute('fill') ?? '']);
    }
  }
  return cells.sort((a, b) => Number(a[1]) - Number(b[1]) || Number(a[0]) - Number(b[0]));
}
