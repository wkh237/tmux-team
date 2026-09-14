import type { PropDefinition, PropPack } from './prop-contract.js';

export function IndexedProp({ pack, prop }: { pack: PropPack; prop: PropDefinition }) {
  const width = prop.pixels[0]!.length;
  const height = prop.pixels.length;
  return (
    <svg
      x="0"
      y="0"
      width={prop.footprint.width}
      height={prop.footprint.height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      overflow="hidden"
      aria-hidden="true"
      shapeRendering="crispEdges"
    >
      {prop.pixels.flatMap((row, y) =>
        Array.from(row, (index, x) => {
          if (index === '0') return null;
          return (
            <rect
              key={`${x}:${y}`}
              x={x}
              y={y}
              width="1"
              height="1"
              fill={pack.palette[Number.parseInt(index, 16)]}
            />
          );
        })
      )}
    </svg>
  );
}
