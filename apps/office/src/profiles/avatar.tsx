import type { Appearance } from './profile-contract.js';
import { avatarArt } from './avatar-art.js';
import { IndexedRaster } from '../rendering/indexed-raster.js';

/** Preserve natural glyph proportions and accessible full text. */
function AvatarText({
  value,
  className,
  y,
  width,
}: {
  value: string;
  className: string;
  y: number;
  width: number;
}) {
  return (
    <foreignObject x={-width / 2} y={y} width={width} height={1.6}>
      <div className={`avatar-text ${className}`} title={value}>
        {value}
      </div>
    </foreignObject>
  );
}

/** Trusted pixel art only; profile strings remain inert, accessible text. */
export function Avatar({
  appearance,
  name,
  displayLabel = '',
  x = 0,
  y = 0,
  scale = 1,
}: {
  appearance: Appearance;
  name: string;
  displayLabel?: string;
  x?: number;
  y?: number;
  scale?: number;
}) {
  const art = avatarArt(appearance);
  return (
    <g
      className="profile-avatar"
      transform={`translate(${x} ${y}) scale(${scale})`}
      aria-label={`${name} avatar`}
    >
      <title>{displayLabel ? `${displayLabel} — identity ${name}` : name}</title>
      {displayLabel && (
        <AvatarText value={displayLabel} className="avatar-label" y={-5.7} width={12} />
      )}
      <AvatarText value={name} className="avatar-name" y={-4.1} width={12} />
      <g transform="translate(-2.8 -2.8)">
        <IndexedRaster pixels={art.pixels} palette={art.palette} width={5.6} height={8.4} />
      </g>
      <AvatarText value={appearance.shirtMark} className="avatar-mark" y={2.25} width={4} />
    </g>
  );
}
