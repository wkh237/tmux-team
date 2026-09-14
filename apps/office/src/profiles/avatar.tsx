import type { Appearance } from './profile-contract.js';

const SKIN = { light: '#f3c9aa', warm: '#dca77d', medium: '#a96f50', deep: '#684431' };
const HAIR = { ink: '#26313a', brown: '#684632', gold: '#c49a4e', silver: '#9aa5ad' };
const SHIRT = {
  blue: '#426c91',
  green: '#467256',
  clay: '#a95943',
  plum: '#704b73',
  gold: '#b88a35',
  ink: '#303b46',
};

function fitted(value: string, byteLimit: number, width: number) {
  return new TextEncoder().encode(value).length > byteLimit
    ? { textLength: width, lengthAdjust: 'spacingAndGlyphs' as const }
    : {};
}

/** Curated SVG only. Profile text can become text content, never markup or asset URLs. */
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
  const hair = HAIR[appearance.hairColor];
  return (
    <g
      className="profile-avatar"
      transform={`translate(${x} ${y}) scale(${scale})`}
      aria-label={`${name} avatar`}
    >
      <title>{displayLabel ? `${displayLabel} — identity ${name}` : name}</title>
      {displayLabel && (
        <text
          className="avatar-label"
          x="0"
          y="-4.45"
          textAnchor="middle"
          {...fitted(displayLabel, 18, 12)}
        >
          {displayLabel}
        </text>
      )}
      <text className="avatar-name" x="0" y="-3.25" textAnchor="middle" {...fitted(name, 12, 12)}>
        {name}
      </text>
      <circle cx="0" cy="0" r="2.35" fill={SKIN[appearance.skinTone]} />
      {appearance.hairStyle === 'short' && (
        <path
          d="M-2.2 -.2 Q-1.8 -2.8 0 -2.45 Q2 -2.7 2.25 -.25 Q.7 -1.15 0 -.75 Q-.8 -1.2 -2.2 -.2"
          fill={hair}
        />
      )}
      {appearance.hairStyle === 'bob' && (
        <path
          d="M-2.45 .9 V-.5 Q-2.1 -2.8 0 -2.55 Q2.2 -2.8 2.45 -.5 V1 H1.65 V-.4 Q1.2 -1.7 0 -1.6 Q-1.25 -1.7 -1.65 -.4 V.9Z"
          fill={hair}
        />
      )}
      {appearance.hairStyle === 'curls' && (
        <path
          d="M-2.5 0 Q-2.8 -2 0 -2.75 Q2.8 -2 2.5 0 L1.7 -.15 Q1.4 -1.5 0 -1.55 Q-1.5 -1.45 -1.7 -.1Z"
          fill={hair}
          stroke={hair}
          strokeWidth=".6"
          strokeDasharray=".35 .2"
        />
      )}
      {appearance.hairStyle === 'tied' && (
        <>
          <circle cx="2.45" cy="-1.25" r=".9" fill={hair} />
          <path
            d="M-2.15 -.2 Q-1.8 -2.65 0 -2.5 Q2 -2.55 2.1 -.2 Q.7 -1.25 0 -.85 Q-.8 -1.25 -2.15 -.2"
            fill={hair}
          />
        </>
      )}
      {appearance.hairStyle === 'bald' && (
        <path d="M-1.7 -1.5 Q0 -2.65 1.7 -1.5" fill="none" stroke={hair} strokeWidth=".2" />
      )}
      <circle cx="-.8" cy=".1" r=".16" fill="#24313a" />
      <circle cx=".8" cy=".1" r=".16" fill="#24313a" />
      <path d="M-.55 1 Q0 1.35 .55 1" fill="none" stroke="#613f35" strokeWidth=".16" />
      <path
        d="M-2.7 5.7 V3.25 Q-2.4 1.95 0 1.9 Q2.4 1.95 2.7 3.25 V5.7Z"
        fill={SHIRT[appearance.shirtColor]}
      />
      <text
        className="avatar-mark"
        x="0"
        y="4.5"
        textAnchor="middle"
        {...fitted(appearance.shirtMark, 7, 4)}
      >
        {appearance.shirtMark}
      </text>
    </g>
  );
}
