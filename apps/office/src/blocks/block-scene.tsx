import { useId } from 'react';
import type { Furniture } from './block-contract.js';
import { BLOCK_SIZE, defaultCatalog, footprint } from './block-contract.js';
import { Avatar } from '../profiles/avatar.js';
import type { AvatarArt } from '../profiles/avatar.js';
import type { Appearance } from '../profiles/profile-contract.js';
import type { CatalogPack } from '../props/prop-contract.js';
import { resolvedProp } from '../props/prop-contract.js';
import { IndexedProp } from '../props/indexed-prop.js';

function ResolvedProp({ item, catalog }: { item: Furniture; catalog: CatalogPack[] }) {
  const clip = useId();
  const [digest, key] = item.prop.split('/');
  const digestPrefix = digest?.startsWith('sha256:')
    ? digest.slice('sha256:'.length, 'sha256:'.length + 12)
    : '000000000000';
  const pack = catalog.find((candidate) => candidate.digest === digest)?.pack;
  const prop = pack && key ? resolvedProp(pack, key, item.footprint) : undefined;
  const size = footprint(item);
  return (
    <g
      transform={`translate(${item.x + size.width / 2} ${item.y + size.height / 2}) rotate(${item.rotation * 90}) translate(${-item.footprint.width / 2} ${-item.footprint.height / 2})`}
    >
      {pack && prop ? (
        <IndexedProp pack={pack} prop={prop} />
      ) : (
        <>
          <defs>
            <clipPath id={clip}>
              <rect width={item.footprint.width} height={item.footprint.height} />
            </clipPath>
          </defs>
          <g role="img" aria-label={`Unavailable prop ${digestPrefix}`} clipPath={`url(#${clip})`}>
            <rect
              width={item.footprint.width}
              height={item.footprint.height}
              fill="var(--floor)"
              stroke="var(--selection)"
              strokeWidth="0.15"
              strokeDasharray="0.3 0.2"
            />
            <text x="0.25" y="0.65" fontSize="0.45" fill="var(--ink)">
              Unavailable prop
            </text>
            <text x="0.25" y="1.2" fontSize="0.32" fill="var(--ink)" opacity="0.65">
              {digestPrefix}
            </text>
          </g>
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
  avatar,
  catalog = defaultCatalog(),
}: {
  objects: Furniture[];
  selected: number | null;
  select: (index: number) => void;
  move: (x: number, y: number) => void;
  avatar?: {
    appearance: Appearance;
    name: string;
    displayLabel?: string;
    customArt?: AvatarArt;
  };
  catalog?: CatalogPack[];
}) {
  const pattern = useId();
  return (
    <svg
      className="block-scene"
      viewBox={`-1 -1 ${BLOCK_SIZE + 2} ${BLOCK_SIZE + 2}`}
      role="group"
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
            <ResolvedProp item={item} catalog={catalog} />
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
      {avatar && (
        <Avatar
          appearance={avatar.appearance}
          name={avatar.name}
          displayLabel={avatar.displayLabel}
          customArt={avatar.customArt}
          x={16}
          y={15}
        />
      )}
    </svg>
  );
}
