import type { Appearance } from './profile-contract.js';

// Sixteen by twenty-four source pixels, authored on the grid rather than
// rasterized from curves. Zero in an overlay preserves the underlying pixel.
const BODY = [
  '0000000110000000',
  '0000011331100000',
  '0000123333210000',
  '0001233333321000',
  '0011233333321100',
  '0012199999912100',
  '001219a99a912100',
  '0012199999912100',
  '001212bbbb212100',
  '0001233333321000',
  '0000112222110000',
  '0000001881000000',
  '0001166776611000',
  '0013677777763100',
  '0012167777612100',
  '0018167777618100',
  '0012167777612100',
  '0011166666611100',
  '0000118888110000',
  '0000188118810000',
  '0000121001210000',
  '0000181001810000',
  '0001991001991000',
  '0001111001111000',
] as const;

const HAIRSTYLES: Record<Appearance['hairStyle'], readonly string[]> = {
  short: [
    '0000011111100000',
    '0000145555410000',
    '0001455555541000',
    '0001444555441000',
    '0001400040041000',
    '0001400000041000',
  ],
  bob: [
    '0000011111100000',
    '0000145555410000',
    '0001455555541000',
    '0014555555554100',
    '0014440000444100',
    '0014400000044100',
    '0014400000044100',
    '0014400000044100',
    '0014400000044100',
    '0014100000014100',
    '0001100000011000',
  ],
  curls: [
    '0000110110110000',
    '0001451451451000',
    '0014554554554100',
    '0145455455455410',
    '0014441144144100',
    '0014100000014100',
    '0001100000011000',
  ],
  tied: [
    '0000011111101100',
    '0000145555414510',
    '0001455555544510',
    '0001444555541100',
    '0001400000041410',
    '0001400000041410',
    '0000000000000110',
  ],
  bald: [],
};

// Retain stored skinTone choices as robot shell finishes; no profile migration.
const SHELL = {
  light: ['#899eac', '#d4e2e9'],
  warm: ['#92745a', '#cdb291'],
  medium: ['#526976', '#849da8'],
  deep: ['#303d4c', '#596b7d'],
} as const;
const HAIR = {
  ink: ['#26313a', '#46545e'],
  brown: ['#684632', '#926445'],
  gold: ['#a77b32', '#d9b561'],
  silver: ['#7b8991', '#c0cbd0'],
} as const;
const SHIRT = {
  blue: ['#34546e', '#527e9f'],
  green: ['#345640', '#5b8862'],
  clay: ['#884332', '#bf7353'],
  plum: ['#553b59', '#936b95'],
  gold: ['#927026', '#ccaa53'],
  ink: ['#28323b', '#4a5965'],
} as const;

export function avatarArt(appearance: Appearance) {
  const overlay = HAIRSTYLES[appearance.hairStyle];
  return {
    pixels: BODY.map((row, y) =>
      Array.from(row, (pixel, x) => {
        const hair = overlay[y]?.[x];
        return hair && hair !== '0' ? hair : pixel;
      }).join('')
    ),
    palette: [
      '#00000000',
      '#25333b',
      ...SHELL[appearance.skinTone],
      ...HAIR[appearance.hairColor],
      ...SHIRT[appearance.shirtColor],
      '#455568',
      '#27333e',
      '#a0f2eb',
      '#708c98',
    ],
  };
}
