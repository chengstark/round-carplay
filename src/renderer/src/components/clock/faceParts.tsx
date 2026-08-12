// The individual printed and moving parts of the clock face, each drawn from
// scratch as SVG. Nothing here is stateful or time-aware: the hands are drawn
// pointing at 12 o'clock and PorscheClock rotates them. Keeping them dumb is
// what lets the same parts render the full-screen dial and the little dial on
// the button, and lets the animation touch three transform attributes per frame
// instead of re-rendering sixty tick marks.
//
// Every gradient/clip id is prefixed per instance, because two dials share the
// document as soon as the button and the full-screen view are both mounted and
// duplicate ids would cross-wire them.

import React from 'react'
import {
  BEZEL_LIP_R,
  BEZEL_LIP_W,
  BEZEL_OUTER_R,
  BEZEL_RING_R,
  BEZEL_RING_W,
  BRAND_SIZE,
  BRAND_Y,
  C,
  COLORS,
  DIAL_FONT,
  DIAL_R,
  HOUR_LEN,
  HOUR_TAIL,
  HOUR_W,
  HUB_R,
  MINUTE_LEN,
  MINUTE_TAIL,
  MINUTE_W,
  NUMERAL_R,
  NUMERAL_SIZE,
  SECOND_LEN,
  SECOND_TAIL,
  SECOND_TAIL_W,
  SECOND_W,
  SUBBRAND_SIZE,
  SUBBRAND_Y,
  TICK_HOUR_INNER_R,
  TICK_HOUR_W,
  TICK_MINUTE_INNER_R,
  TICK_MINUTE_W,
  TICK_OUTER_R,
  handPoints,
  polar
} from './geometry'

interface IdProps {
  idPrefix: string
}

/**
 * Gradients and clips shared by the parts below.
 */
export function FaceDefs({ idPrefix }: IdProps): React.JSX.Element {
  return (
    <defs>
      {/* Dial: slightly lifted in the middle, falling off to near-black at the
          rim, so the face has some depth without looking backlit. */}
      <radialGradient id={`${idPrefix}-dial`} cx="50%" cy="44%" r="62%">
        <stop offset="0%" stopColor={COLORS.dialCenter} />
        <stop offset="65%" stopColor="#0b0c0f" />
        <stop offset="100%" stopColor={COLORS.dialEdge} />
      </radialGradient>

      {/* Bezel: lit from above, as a chrome ring in a dash would be. */}
      <linearGradient id={`${idPrefix}-bezel`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={COLORS.bezelLight} />
        <stop offset="38%" stopColor={COLORS.bezelMid} />
        <stop offset="70%" stopColor={COLORS.bezelDark} />
        <stop offset="100%" stopColor={COLORS.bezelMid} />
      </linearGradient>

      {/* Glass sheen, clipped to the dial so it never spills onto the bezel. */}
      <radialGradient id={`${idPrefix}-sheen`} cx="34%" cy="26%" r="52%">
        <stop offset="0%" stopColor="#ffffff" stopOpacity="0.075" />
        <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
      </radialGradient>

      <clipPath id={`${idPrefix}-dialClip`}>
        <circle cx={C} cy={C} r={DIAL_R} />
      </clipPath>
    </defs>
  )
}

/**
 * Outer rim and the dial it encloses.
 */
export function Bezel({ idPrefix }: IdProps): React.JSX.Element {
  return (
    <g>
      <circle cx={C} cy={C} r={BEZEL_OUTER_R} fill={COLORS.bezelDark} />
      <circle
        cx={C}
        cy={C}
        r={BEZEL_RING_R}
        fill="none"
        stroke={`url(#${idPrefix}-bezel)`}
        strokeWidth={BEZEL_RING_W}
      />
      {/* Dark lip where the rim meets the dial — reads as the shadow under the
          bezel and stops the chrome from bleeding into the face. */}
      <circle
        cx={C}
        cy={C}
        r={BEZEL_LIP_R}
        fill="none"
        stroke="#000000"
        strokeWidth={BEZEL_LIP_W}
      />
      <circle cx={C} cy={C} r={DIAL_R} fill={`url(#${idPrefix}-dial)`} />
    </g>
  )
}

/**
 * Glass reflection over the dial. Drawn last-but-one in the stack so it sits
 * over the printing but under the hands.
 */
export function Sheen({ idPrefix }: IdProps): React.JSX.Element {
  return (
    <g clipPath={`url(#${idPrefix}-dialClip)`} pointerEvents="none">
      <circle cx={C} cy={C} r={DIAL_R} fill={`url(#${idPrefix}-sheen)`} />
    </g>
  )
}

interface TickRingProps {
  /** Multiplier on stroke widths. The small dial needs fatter marks to read. */
  boost?: number
  /** Drop the minute ticks entirely — they turn to mush below ~80px. */
  hourTicksOnly?: boolean
}

/**
 * 60 marks: a thin one per minute, a long heavy one every five.
 */
export function TickRing({ boost = 1, hourTicksOnly = false }: TickRingProps): React.JSX.Element {
  const marks: React.JSX.Element[] = []

  for (let i = 0; i < 60; i++) {
    const isHour = i % 5 === 0
    if (!isHour && hourTicksOnly) continue

    const angle = i * 6
    const inner = polar(isHour ? TICK_HOUR_INNER_R : TICK_MINUTE_INNER_R, angle)
    const outer = polar(TICK_OUTER_R, angle)

    marks.push(
      <line
        key={i}
        x1={inner.x}
        y1={inner.y}
        x2={outer.x}
        y2={outer.y}
        stroke={isHour ? COLORS.mark : COLORS.markDim}
        strokeWidth={(isHour ? TICK_HOUR_W : TICK_MINUTE_W) * boost}
        strokeLinecap="butt"
      />
    )
  }

  return <g>{marks}</g>
}

/**
 * 12 / 3 / 6 / 9, the only numerals the OEM face carries.
 */
export function Numerals(): React.JSX.Element {
  const numerals = [
    { label: '12', angle: 0 },
    { label: '3', angle: 90 },
    { label: '6', angle: 180 },
    { label: '9', angle: 270 }
  ]

  return (
    <g
      fill={COLORS.mark}
      fontFamily={DIAL_FONT}
      fontSize={NUMERAL_SIZE}
      fontWeight={700}
      fontStretch="condensed"
      textAnchor="middle"
      dominantBaseline="central"
    >
      {numerals.map(({ label, angle }) => {
        const p = polar(NUMERAL_R, angle)
        return (
          <text key={label} x={p.x} y={p.y}>
            {label}
          </text>
        )
      })}
    </g>
  )
}

/**
 * "VDO" over "Quarz-Zeit" in the lower half of the dial.
 */
export function Branding(): React.JSX.Element {
  return (
    <g
      fill={COLORS.markDim}
      fontFamily={DIAL_FONT}
      textAnchor="middle"
      dominantBaseline="central"
      pointerEvents="none"
    >
      <text x={C} y={BRAND_Y} fontSize={BRAND_SIZE} fontWeight={700} letterSpacing="3.5">
        VDO
      </text>
      <text x={C} y={SUBBRAND_Y} fontSize={SUBBRAND_SIZE} fontWeight={400} letterSpacing="1.2">
        Quarz-Zeit
      </text>
    </g>
  )
}

/**
 * Hour and minute hands: red tapered batons, the minute one longer and
 * narrower. Each carries a darker inboard edge so the two stay distinguishable
 * when they overlap.
 */
export const HourHand = React.forwardRef<SVGGElement>(function HourHand(_props, ref) {
  return (
    <g ref={ref}>
      <polygon points={handPoints(HOUR_LEN, HOUR_TAIL, HOUR_W)} fill={COLORS.needle} />
      <polygon
        points={handPoints(HOUR_LEN, HOUR_TAIL, HOUR_W * 0.34)}
        fill={COLORS.needleShade}
        opacity={0.45}
      />
    </g>
  )
})

export const MinuteHand = React.forwardRef<SVGGElement>(function MinuteHand(_props, ref) {
  return (
    <g ref={ref}>
      <polygon points={handPoints(MINUTE_LEN, MINUTE_TAIL, MINUTE_W)} fill={COLORS.needle} />
      <polygon
        points={handPoints(MINUTE_LEN, MINUTE_TAIL, MINUTE_W * 0.34)}
        fill={COLORS.needleShade}
        opacity={0.45}
      />
    </g>
  )
})

/**
 * Thin white seconds hand with a counterweight tail — this is the part that
 * replaces the OEM's manually-set marker needle.
 */
export const SecondHand = React.forwardRef<SVGGElement>(function SecondHand(_props, ref) {
  return (
    <g ref={ref}>
      <line
        x1={C}
        y1={C + SECOND_TAIL}
        x2={C}
        y2={C - SECOND_LEN}
        stroke={COLORS.second}
        strokeWidth={SECOND_W}
        strokeLinecap="butt"
      />
      <line
        x1={C}
        y1={C + 8}
        x2={C}
        y2={C + SECOND_TAIL}
        stroke={COLORS.second}
        strokeWidth={SECOND_TAIL_W}
        strokeLinecap="round"
      />
    </g>
  )
})

/**
 * The black centre knob the hands pivot on.
 */
export function Hub(): React.JSX.Element {
  return (
    <g pointerEvents="none">
      <circle cx={C} cy={C} r={HUB_R} fill={COLORS.hub} stroke={COLORS.hubEdge} strokeWidth={3} />
      <circle cx={C - HUB_R * 0.3} cy={C - HUB_R * 0.34} r={HUB_R * 0.3} fill="#3c3e44" opacity={0.55} />
    </g>
  )
}
