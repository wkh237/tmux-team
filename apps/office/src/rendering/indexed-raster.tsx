/** Inert indexed pixels shared by trusted character art and admitted props. */
export function IndexedRaster({
  pixels,
  palette,
  width,
  height,
}: {
  pixels: readonly string[];
  palette: readonly string[];
  width: number;
  height: number;
}) {
  return (
    <svg
      x="0"
      y="0"
      width={width}
      height={height}
      viewBox={`0 0 ${pixels[0]!.length} ${pixels.length}`}
      preserveAspectRatio="none"
      overflow="hidden"
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      {pixels.flatMap((row, y) =>
        Array.from(row, (index, x) =>
          index === '0' ? null : (
            <rect
              key={`${x}:${y}`}
              x={x}
              y={y}
              width="1"
              height="1"
              fill={palette[Number.parseInt(index, 16)]}
            />
          )
        )
      )}
    </svg>
  );
}
