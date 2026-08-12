// The clock button: the whole empty crescent left of the CarPlay square, drawn
// as a moulded plastic key rather than a flat tinted region, so it reads as
// something you press.
//
// The shape is a lune — a circular arc on the outside, a straight edge against
// CarPlay on the inside. It is built from three stacked copies of that path:
//
//     wall   the same face pushed DEPTH down, in a darker shade. What shows
//            around the bottom edge is the button's thickness.
//     face   the top surface, filled with a vertical gradient so it looks lit
//            from above the way a dash key is.
//     spec   a bright stroke along the outer arc only — the highlight running
//            down the moulding's shoulder.
//
// Pressing moves the face down onto the wall instead of just recolouring it, so
// the first tap of the double-tap reads as travel, not as a state change.
//
// It has to be a path rather than a rectangle clipped by the display's
// overflow: a clipped rectangle can only be filled. The overflow would eat the
// arc side of any outline, highlight or bevel and leave them on the straight
// edge only.

import React, { useId } from 'react'
import PorscheClock from './PorscheClock'
import { SIZE } from './geometry'

const R = SIZE / 2

/** Keeps the button off the very edge of the display, where the round panel's
 *  own bezel and the circle's overflow would trim it. */
const ARC_INSET = 5

/** How far the top face sits inside the wall's footprint, and how far it
 *  travels when pressed. In viewBox units — about 6px on a 540px panel. */
const FACE_INSET = 3
const DEPTH = 6

/** Radius of the moulded corners, applied by stroking the path with round
 *  joins in its own colour: half the stroke width becomes the corner radius.
 *  Without it the lune's tips come to points, which reads as cut paper. */
const CORNER = 9

/** Diameter of the dial as a share of the crescent's width, leaving even margin
 *  on both sides so it never crowds the moulding. */
const DIAL_PCT = 66

export interface ButtonFinish {
  /** Top face, lit edge. */
  faceHigh: string
  /** Top face, shaded edge. */
  faceLow: string
  /** The extruded side wall below the face. */
  wall: string
  /** Specular highlight along the outer shoulder. */
  spec: string
  /** Hairline where the face meets the wall. */
  edge: string
}

/**
 * Finishes, all keyed to the car rather than to the app's UI. Swap with the
 * `finish` prop; add to this map rather than hard-coding colours below.
 */
export const FINISHES: Record<string, ButtonFinish> = {
  /** Matte black switchgear, the way the surrounding dash controls look. */
  graphite: {
    faceHigh: '#4a4e55',
    faceLow: '#23262b',
    wall: '#0e0f11',
    spec: '#aeb6c2',
    edge: 'rgba(0,0,0,0.55)'
  },
  /** Guards red, picked up from the clock's own needles. */
  guards: {
    faceHigh: '#e8443a',
    faceLow: '#9d1a12',
    wall: '#4d0b07',
    spec: '#ffd9d4',
    edge: 'rgba(0,0,0,0.5)'
  },
  /** Period ivory — the cream plastic of 70s Porsche switchgear and dial faces. */
  ivory: {
    faceHigh: '#f4ecd9',
    faceLow: '#cdbf9f',
    wall: '#7e735c',
    spec: '#ffffff',
    edge: 'rgba(0,0,0,0.32)'
  },
  /** Deep slate, a darker relative of the ring blue it sits on. */
  slate: {
    faceHigh: '#6d8ea6',
    faceLow: '#3a5468',
    wall: '#1d2c38',
    spec: '#d8e8f2',
    edge: 'rgba(0,0,0,0.45)'
  }
}

export type FinishName = keyof typeof FINISHES

interface CrescentButtonProps {
  /** Inner edge of the crescent, as a percentage of the display's width. */
  rightEdgePct: number
  /** First tap of the double-tap has landed and the second is expected. */
  armed: boolean
  onClick: () => void
  finish?: FinishName
}

/**
 * The lune, in viewBox units. Sweeps counter-clockwise from the top
 * intersection around the outside of the display to the bottom one; the caller
 * decides whether to close it.
 */
function lune(rightEdge: number, radius: number, closed: boolean): string {
  const dx = R - rightEdge
  // A crescent this shallow has no interior to draw — bail rather than emit a
  // path with a NaN in it.
  if (dx >= radius) return ''
  const dy = Math.sqrt(radius * radius - dx * dx)
  const x = rightEdge.toFixed(2)
  return `M ${x} ${(R - dy).toFixed(2)} A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 0 0 ${x} ${(R + dy).toFixed(2)}${closed ? ' Z' : ''}`
}

export default function CrescentButton({
  rightEdgePct,
  armed,
  onClick,
  finish = 'graphite'
}: CrescentButtonProps): React.JSX.Element {
  const rightEdge = (rightEdgePct / 100) * SIZE
  const paint = FINISHES[finish] ?? FINISHES.graphite
  const gradientId = `crescent-${useId().replace(/:/g, '')}`

  // The face is inset from the button's outer bound on both the arc side and
  // the straight side, so the wall shows as a consistent thickness all round.
  const faceRadius = R - ARC_INSET - FACE_INSET
  const facePath = lune(rightEdge - FACE_INSET, faceRadius, true)
  const specPath = lune(rightEdge - FACE_INSET, faceRadius, false)

  // Travel is a share of the button's height — which is the display's height —
  // so the press scales with the panel exactly as the shape does.
  const travelPct = (DEPTH / SIZE) * 100

  return (
    <button
      type="button"
      aria-label="Clock — double tap to open"
      onClick={onClick}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: `${rightEdgePct}%`,
        height: '100%',
        padding: 0,
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        touchAction: 'manipulation',
        WebkitTapHighlightColor: 'transparent',
        zIndex: 10
      }}
    >
      {/* The viewBox is the slice of the display this button occupies, so the
          paths can be written in the display's own coordinates. */}
      <svg
        viewBox={`0 0 ${rightEdge} ${SIZE}`}
        width="100%"
        height="100%"
        preserveAspectRatio="xMidYMid meet"
        style={{ position: 'absolute', inset: 0, display: 'block' }}
      >
        <defs>
          <linearGradient id={`${gradientId}-face`} x1="0" y1="0" x2="0.35" y2="1">
            <stop offset="0%" stopColor={paint.faceHigh} />
            <stop offset="100%" stopColor={paint.faceLow} />
          </linearGradient>
          {/* Highlight strongest at the top of the shoulder, gone by halfway. */}
          <linearGradient id={`${gradientId}-spec`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={paint.spec} stopOpacity="0" />
            <stop offset="16%" stopColor={paint.spec} stopOpacity="0.9" />
            <stop offset="52%" stopColor={paint.spec} stopOpacity="0.18" />
            <stop offset="100%" stopColor={paint.spec} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Side wall. Sits DEPTH below the face at rest; when pressed the face
            comes down to meet it and the thickness disappears. */}
        <g transform={`translate(0 ${DEPTH})`}>
          <path
            d={facePath}
            fill={paint.wall}
            stroke={paint.wall}
            strokeWidth={CORNER}
            strokeLinejoin="round"
          />
        </g>

        {/* Top face */}
        <g
          transform={`translate(0 ${armed ? DEPTH : 0})`}
          style={{ transition: 'transform 90ms ease-out' }}
        >
          <path
            d={facePath}
            fill={`url(#${gradientId}-face)`}
            stroke={`url(#${gradientId}-face)`}
            strokeWidth={CORNER}
            strokeLinejoin="round"
          />
          {/* Hairline where the face rolls over into the wall. */}
          <path
            d={facePath}
            fill="none"
            stroke={paint.edge}
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
          {/* Specular shoulder along the outer arc. */}
          <path
            d={specPath}
            fill="none"
            stroke={`url(#${gradientId}-spec)`}
            strokeWidth={3.5}
            strokeLinecap="round"
          />
        </g>
      </svg>

      {/* Dial rides on the top face, so it travels with the press. Centred on
          the face rather than on the button's box — the face starts at
          ARC_INSET + FACE_INSET, so the two centres differ and the dial would
          otherwise sit visibly left of the moulding it's set into. */}
      <div
        style={{
          position: 'absolute',
          top: armed ? `${50 + travelPct}%` : '50%',
          left: `${((ARC_INSET + FACE_INSET + rightEdge - FACE_INSET) / 2 / rightEdge) * 100}%`,
          transform: 'translate(-50%, -50%)',
          width: `${DIAL_PCT}%`,
          aspectRatio: '1',
          borderRadius: '50%',
          // A light hairline round the dial so it separates from the face on
          // the dark finishes, where black-on-near-black would otherwise mush.
          boxShadow: '0 0 0 1.5px rgba(255,255,255,0.22), 0 1px 6px rgba(0,0,0,0.55)',
          transition: 'top 90ms ease-out'
        }}
      >
        <PorscheClock variant="mini" />
      </div>
    </button>
  )
}
