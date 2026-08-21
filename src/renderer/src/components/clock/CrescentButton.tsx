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

/** The wall is the face pushed DEPTH down, so the moulding as a whole spans from
 *  the top of the face to the bottom of the wall — its visual centre sits half a
 *  DEPTH below the display's axis even though the face is perfectly centred on
 *  it. Lifting everything by that half puts the composite back on the axis. This
 *  is why the number is DEPTH / 2 and not a hand-tuned nudge: change the
 *  extrusion depth and the correction follows it. */
const OPTICAL_LIFT = DEPTH / 2

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
  edgePct: number
  /** Which side of the round display owns the crescent. */
  side?: 'left' | 'right'
  /** First tap of the double-tap has landed and the second is expected. */
  armed: boolean
  onClick: () => void
  finish?: FinishName
  content?: 'clock' | 'camera'
}

/**
 * The lune, in viewBox units. Sweeps counter-clockwise from the top
 * intersection around the outside of the display to the bottom one; the caller
 * decides whether to close it.
 */
function lune(edge: number, radius: number, closed: boolean, side: 'left' | 'right'): string {
  const dx = Math.abs(R - edge)
  // A crescent this shallow has no interior to draw — bail rather than emit a
  // path with a NaN in it.
  if (dx >= radius) return ''
  const dy = Math.sqrt(radius * radius - dx * dx)
  const x = edge.toFixed(2)
  const sweep = side === 'left' ? 0 : 1
  return `M ${x} ${(R - dy).toFixed(2)} A ${radius.toFixed(2)} ${radius.toFixed(2)} 0 0 ${sweep} ${x} ${(R + dy).toFixed(2)}${closed ? ' Z' : ''}`
}

export default function CrescentButton({
  edgePct,
  side = 'left',
  armed,
  onClick,
  finish = 'graphite',
  content = 'clock'
}: CrescentButtonProps): React.JSX.Element {
  const edge = (edgePct / 100) * SIZE
  const buttonWidth = side === 'left' ? edge : SIZE - edge
  const paint = FINISHES[finish] ?? FINISHES.graphite
  const gradientId = `crescent-${useId().replace(/:/g, '')}`

  // The face is inset from the button's outer bound on both the arc side and
  // the straight side, so the wall shows as a consistent thickness all round.
  const faceRadius = R - ARC_INSET - FACE_INSET
  const faceEdge = edge + (side === 'left' ? -FACE_INSET : FACE_INSET)
  const facePath = lune(faceEdge, faceRadius, true, side)
  const specPath = lune(faceEdge, faceRadius, false, side)
  const outerFaceEdge = side === 'left' ? ARC_INSET + FACE_INSET : SIZE - ARC_INSET - FACE_INSET
  const contentCenter =
    side === 'left'
      ? ((outerFaceEdge + faceEdge) / 2 / buttonWidth) * 100
      : (((outerFaceEdge + faceEdge) / 2 - edge) / buttonWidth) * 100

  // Travel and lift are shares of the button's height — which is the display's
  // height — so both scale with the panel exactly as the shape does.
  const travelPct = (DEPTH / SIZE) * 100
  const liftPct = (OPTICAL_LIFT / SIZE) * 100

  return (
    <button
      type="button"
      aria-label={`${content === 'clock' ? 'Clock' : 'Wi-Fi camera'} — double tap to open`}
      onClick={onClick}
      style={{
        position: 'absolute',
        top: 0,
        left: side === 'left' ? 0 : `${edgePct}%`,
        width: `${side === 'left' ? edgePct : 100 - edgePct}%`,
        height: '100%',
        padding: 0,
        border: 'none',
        background: 'transparent',
        // Inherit, don't set. A <button>'s UA default would stop the cascade
        // here, and initCursorHider() only reaches body, #main and MUI roots —
        // so any cursor of our own would survive the auto-hide and leave a
        // pointer stuck over the button forever. Inheriting lets it follow body.
        cursor: 'inherit',
        touchAction: 'manipulation',
        WebkitTapHighlightColor: 'transparent',
        zIndex: 10
      }}
    >
      {/* The viewBox is the slice of the display this button occupies, so the
          paths can be written in the display's own coordinates. */}
      <svg
        viewBox={
          side === 'left' ? `0 0 ${buttonWidth} ${SIZE}` : `${edge} 0 ${buttonWidth} ${SIZE}`
        }
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

        {/* Everything the moulding is made of rides on this lift, so the face
            and the wall stay a rigid object and only their centre moves. */}
        <g transform={`translate(0 ${-OPTICAL_LIFT})`}>
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
        </g>
      </svg>

      {/* Dial rides on the top face, so it takes the same optical lift and
          travels with the press. Centred on the face rather than on the button's
          box — the face starts at ARC_INSET + FACE_INSET, so the two centres
          differ and the dial would otherwise sit visibly left of the moulding
          it's set into. */}
      <div
        style={{
          position: 'absolute',
          top: `${50 - liftPct + (armed ? travelPct : 0)}%`,
          left: `${contentCenter}%`,
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
        {content === 'clock' ? <PorscheClock variant="mini" /> : <CameraGlyph />}
      </div>
    </button>
  )
}

function CameraGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true">
      <circle cx="50" cy="50" r="49" fill="#111216" />
      <path
        d="M25 36h12l5-8h16l5 8h12c5 0 8 3 8 8v28c0 5-3 8-8 8H25c-5 0-8-3-8-8V44c0-5 3-8 8-8Z"
        fill="#e6e3db"
      />
      <circle cx="50" cy="56" r="15" fill="#25272c" />
      <circle cx="50" cy="56" r="9" fill="#70889a" />
      <circle cx="71" cy="45" r="3" fill="#d8261d" />
    </svg>
  )
}
