// Geometry and palette for the Porsche/VDO "Quarz-Zeit" clock face.
//
// Everything is authored against a 540 x 540 viewBox because that is the native
// size of the round panel, but nothing here depends on that: the SVG scales, so
// these numbers are really "parts of the dial diameter". The dial is drawn
// full-bleed — radius 270 touches the edge of the viewBox — because the whole
// point is for the screen to read as a gauge, not as a gauge sitting on a page.
//
// Expect to re-tune the tick lengths, hand proportions and numeral size once
// this is on the real display; those are the numbers that read differently at
// 3 inches than they do on a desktop monitor.

export const SIZE = 540
export const C = SIZE / 2

// --- Bezel -----------------------------------------------------------------
// The chrome-ish rim of the OEM gauge. Drawn as two concentric strokes rather
// than a filled annulus so the highlight gradient has somewhere to live.
export const BEZEL_OUTER_R = 270
export const BEZEL_RING_R = 262
export const BEZEL_RING_W = 14
export const BEZEL_LIP_R = 254
export const BEZEL_LIP_W = 4

// --- Dial ------------------------------------------------------------------
export const DIAL_R = 252

// --- Ticks -----------------------------------------------------------------
// The VDO face uses a long/short pattern: every minute gets a thin mark, every
// fifth minute gets a much longer and heavier one. The 12/3/6/9 positions get
// the same long mark as the other fifths — the numerals sit inboard of them.
export const TICK_OUTER_R = 238
export const TICK_MINUTE_INNER_R = 224
export const TICK_HOUR_INNER_R = 208
export const TICK_MINUTE_W = 3.2
export const TICK_HOUR_W = 8.5

// --- Numerals --------------------------------------------------------------
// Radius of the numeral centres, not their baseline: the text is centred both
// ways so the glyph optically sits on this circle.
export const NUMERAL_R = 166
export const NUMERAL_SIZE = 60

// Condensed grotesque is the OEM look. Raspberry Pi OS ships DejaVu rather than
// Arial Narrow, so this stack degrades to a normal-width sans there; the
// fontStretch hint lets a variable-width face condense itself where available.
export const DIAL_FONT = "'Arial Narrow', 'Helvetica Neue', Helvetica, Arial, sans-serif"

// --- Branding --------------------------------------------------------------
// "VDO" over "Quarz-Zeit", printed in the lower half between the hub and the 6.
export const BRAND_Y = C + 74
export const BRAND_SIZE = 22
export const SUBBRAND_Y = C + 100
export const SUBBRAND_SIZE = 19

// --- Hands -----------------------------------------------------------------
// Lengths are measured from the centre outwards; tails are the counterweight
// stub on the far side of the hub.
export const HOUR_LEN = 122
// Tails are shorter than HUB_R so the counterweights tuck under the centre knob
// instead of showing as two red stubs at odd angles below the hub.
export const HOUR_TAIL = 13
export const HOUR_W = 20

export const MINUTE_LEN = 198
export const MINUTE_TAIL = 15
export const MINUTE_W = 16

export const SECOND_LEN = 216
export const SECOND_TAIL = 54
export const SECOND_W = 3.4
export const SECOND_TAIL_W = 6

export const HUB_R = 20

// The hub doubles as the hidden way back to CarPlay, so its touch target is far
// bigger than the knob you can see — the knob is 40px across on the panel, which
// is well under anything you could hit at arm's length in a moving car. Nothing
// marks it; that is the point.
export const HUB_HIT_R = 54

// --- Palette ---------------------------------------------------------------
export const COLORS = {
  bezelDark: '#0b0b0d',
  bezelMid: '#2b2d32',
  bezelLight: '#54575e',
  dialCenter: '#141519',
  dialEdge: '#050506',
  // Warm off-white: OEM dial printing is never pure #fff, and pure white looks
  // like a computer screen on a dark panel.
  mark: '#e6e3db',
  markDim: '#c9c6bf',
  needle: '#d8261d',
  needleShade: '#a3160f',
  second: '#f2efe8',
  hub: '#121214',
  hubEdge: '#34363b'
} as const

/**
 * Point on a circle around the dial centre, with 0deg pointing at 12 o'clock
 * and angles increasing clockwise (SVG's native 0deg points right, hence -90).
 */
export function polar(radius: number, angleDeg: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: C + radius * Math.cos(rad), y: C + radius * Math.sin(rad) }
}

/**
 * A tapered baton hand: a parallel-sided body that chamfers to a narrow flat
 * tip, with a short counterweight tail. Returned as an SVG polygon point list,
 * drawn pointing at 12 o'clock so callers only have to rotate it.
 */
export function handPoints(length: number, tail: number, width: number): string {
  const half = width / 2
  const tipHalf = half * 0.28
  const chamfer = width * 0.9
  return [
    [C - half, C + tail],
    [C - half, C - length + chamfer],
    [C - tipHalf, C - length],
    [C + tipHalf, C - length],
    [C + half, C - length + chamfer],
    [C + half, C + tail]
  ]
    .map(([x, y]) => `${round(x)},${round(y)}`)
    .join(' ')
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}
