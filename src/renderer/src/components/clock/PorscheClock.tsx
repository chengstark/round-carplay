// The assembled clock. Two variants share one set of parts:
//
//   full - fills the round panel, has numerals, branding and a sweeping
//          seconds hand, and exits on tap.
//   mini - the live dial inside the button in the ring, stripped to ticks and
//          two hands and ticking lazily, because it is ~60px across and on
//          screen permanently.
//
// The hands are animated by writing transform attributes onto refs rather than
// by re-rendering. At 60fps on a CM4, re-rendering sixty tick marks and two
// text nodes every frame to move three needles is not a trade worth making.

import React, { useEffect, useId, useRef } from 'react'
import {
  Bezel,
  Branding,
  FaceDefs,
  HourHand,
  Hub,
  MinuteHand,
  Numerals,
  SecondHand,
  Sheen,
  TickRing
} from './faceParts'
import { C, HUB_HIT_R, SIZE } from './geometry'

/** How often the mini dial repositions its hands. It has no seconds hand, so
 *  anything under half a minute is invisible work. */
const MINI_UPDATE_MS = 15_000

type Variant = 'full' | 'mini'

interface PorscheClockProps {
  variant?: Variant
  /** Return to CarPlay. Bound to the centre knob, not to the whole face. */
  onExit?: () => void
}

function setAngle(el: SVGGElement | null, angle: number): void {
  el?.setAttribute('transform', `rotate(${angle.toFixed(3)} ${C} ${C})`)
}

/**
 * Drives the hands from the system clock. `sweep` picks continuous motion via
 * requestAnimationFrame over a coarse interval.
 */
function useClockHands(
  sweep: boolean,
  hour: React.RefObject<SVGGElement | null>,
  minute: React.RefObject<SVGGElement | null>,
  second: React.RefObject<SVGGElement | null>
): void {
  useEffect(() => {
    let frame = 0
    let timer: ReturnType<typeof setInterval> | undefined

    const apply = (): void => {
      const now = new Date()
      // Fractional units all the way down, so the minute hand creeps between
      // marks and the hour hand creeps between numerals like a real movement.
      const seconds = now.getSeconds() + now.getMilliseconds() / 1000
      const minutes = now.getMinutes() + seconds / 60
      const hours = (now.getHours() % 12) + minutes / 60

      setAngle(hour.current, hours * 30)
      setAngle(minute.current, minutes * 6)
      setAngle(second.current, seconds * 6)
    }

    apply()

    if (sweep) {
      const loop = (): void => {
        apply()
        frame = requestAnimationFrame(loop)
      }
      frame = requestAnimationFrame(loop)
    } else {
      timer = setInterval(apply, MINI_UPDATE_MS)
    }

    return () => {
      if (frame) cancelAnimationFrame(frame)
      if (timer) clearInterval(timer)
    }
  }, [sweep, hour, minute, second])
}

export default function PorscheClock({
  variant = 'full',
  onExit
}: PorscheClockProps): React.JSX.Element {
  const isFull = variant === 'full'

  const hourRef = useRef<SVGGElement>(null)
  const minuteRef = useRef<SVGGElement>(null)
  const secondRef = useRef<SVGGElement>(null)

  // useId keeps the two dials' gradient ids from colliding in one document.
  const idPrefix = `pc-${useId().replace(/:/g, '')}`

  useClockHands(isFull, hourRef, minuteRef, secondRef)

  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block' }}
    >
      <FaceDefs idPrefix={idPrefix} />
      <Bezel idPrefix={idPrefix} />

      {/* Printed layer */}
      <TickRing boost={isFull ? 1 : 2.1} hourTicksOnly={!isFull} />
      {isFull && <Numerals />}
      {isFull && <Branding />}

      <Sheen idPrefix={idPrefix} />

      {/* Moving layer */}
      <HourHand ref={hourRef} />
      <MinuteHand ref={minuteRef} />
      {isFull && <SecondHand ref={secondRef} />}
      <Hub />

      {/* The secret way out: an invisible disc over the centre knob. Only this
          region is interactive, so resting a hand on the dial or catching it
          with a sleeve leaves the clock up. */}
      {onExit && (
        <circle
          cx={C}
          cy={C}
          r={HUB_HIT_R}
          fill="transparent"
          onClick={onExit}
          style={{ cursor: 'pointer' }}
        />
      )}
    </svg>
  )
}
