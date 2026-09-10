import { useId } from 'react';
import type { Furniture } from './block-contract.js';
import { BLOCK_SIZE, footprint, FURNITURE } from './block-contract.js';

/** Only curated vector primitives render here; stored data cannot supply markup. */
function Sprite({ item }: { item: Furniture }) {
  const { width, height } = FURNITURE[item.asset];
  const size = footprint(item);
  return (
    <g
      transform={`translate(${item.x + size.width / 2} ${item.y + size.height / 2}) rotate(${item.rotation * 90}) translate(${-width / 2} ${-height / 2})`}
    >
      {item.asset === 'desk' && (
        <>
          <rect x="0.2" y="0.3" width="3.6" height="1.6" fill="var(--wood-dark)" />
          <rect width="4" height="1.5" rx="0.15" fill="var(--wood)" />
          <rect x="1.4" y="0.2" width="1.3" height="0.75" rx="0.08" fill="var(--ink)" />
          <rect x="1.55" y="0.3" width="1" height="0.45" fill="var(--screen)" />
          <rect x="1.5" y="1.05" width="1.1" height="0.25" fill="var(--paper)" />
        </>
      )}
      {item.asset === 'chair' && (
        <>
          <rect x="0.3" y="0.3" width="1.4" height="1.5" rx="0.3" fill="var(--ink)" />
          <rect x="0.3" y="0.2" width="1.4" height="0.5" rx="0.2" fill="var(--blue-dark)" />
          <rect x="0.4" y="0.8" width="1.2" height="0.8" rx="0.2" fill="var(--blue)" />
        </>
      )}
      {item.asset === 'plant' && (
        <>
          <rect x="0.5" y="1" width="1" height="0.8" rx="0.15" fill="var(--clay)" />
          <path d="M1 1.4 C-0.5 0.5 0.2 -0.4 1 0.8 C1.9 -0.5 2.8 0.6 1 1.4" fill="var(--leaf)" />
          <path d="M1 1.5 V0.5" stroke="var(--leaf-dark)" strokeWidth="0.1" />
        </>
      )}
      {item.asset === 'rug' && (
        <>
          <rect width="6" height="4" rx="0.15" fill="var(--rug)" />
          <rect
            x="0.3"
            y="0.3"
            width="5.4"
            height="3.4"
            fill="none"
            stroke="var(--paper)"
            strokeWidth="0.12"
          />
          <path d="M1 2 H5 M3 1 V3" stroke="var(--rug-dark)" strokeWidth="0.15" />
        </>
      )}
    </g>
  );
}

export function BlockScene({
  objects,
  selected,
  select,
  move,
}: {
  objects: Furniture[];
  selected: number | null;
  select: (index: number) => void;
  move: (x: number, y: number) => void;
}) {
  const pattern = useId();
  return (
    <svg
      className="block-scene"
      viewBox={`-1 -1 ${BLOCK_SIZE + 2} ${BLOCK_SIZE + 2}`}
      role="img"
      aria-label="Office layout, 32 by 32 tiles. Use the furniture controls to edit."
      onClick={(event) => {
        const matrix = event.currentTarget.getScreenCTM();
        if (!matrix) return;
        const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
        move(Math.floor(point.x), Math.floor(point.y));
      }}
    >
      <defs>
        <pattern id={pattern} width="1" height="1" patternUnits="userSpaceOnUse">
          <rect width="1" height="1" fill="var(--floor)" />
          <path d="M1 0 H0 V1" fill="none" stroke="var(--grid)" strokeWidth="0.035" />
        </pattern>
      </defs>
      <rect x="-0.6" y="-0.6" width="33.2" height="33.2" rx="0.5" fill="var(--wall)" />
      <rect width="32" height="32" fill={`url(#${pattern})`} />
      {objects.map((item, index) => {
        const { width, height } = footprint(item);
        return (
          <g
            key={index}
            onClick={(event) => {
              event.stopPropagation();
              select(index);
            }}
          >
            <Sprite item={item} />
            {selected === index && (
              <rect
                x={item.x - 0.1}
                y={item.y - 0.1}
                width={width + 0.2}
                height={height + 0.2}
                fill="none"
                stroke="var(--selection)"
                strokeWidth="0.12"
                strokeDasharray="0.25 0.15"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
