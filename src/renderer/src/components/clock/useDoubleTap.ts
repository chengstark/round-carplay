import { useCallback, useEffect, useRef, useState } from 'react'

/** How long after the first tap the second one still counts. */
const DOUBLE_TAP_MS = 400

interface DoubleTap {
  /** Wire to onClick. Fires the action only on the second tap in the window. */
  onClick: () => void
  /** True between the two taps — use it to show the control is waiting. */
  armed: boolean
}

/**
 * Two taps to act. The clock button sits in the ring where a hand resting on
 * the panel or a mis-aimed jab at CarPlay can find it, and swapping the whole
 * display out from under someone mid-drive on a stray touch is the one failure
 * mode worth designing out.
 *
 * The armed flag is deliberately surfaced rather than kept private: a
 * double-tap control that gives no sign it heard the first tap just reads as
 * broken.
 */
export function useDoubleTap(action: () => void): DoubleTap {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const disarm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setArmed(false)
  }, [])

  // A timer outliving the component would setState after unmount.
  useEffect(() => disarm, [disarm])

  const onClick = useCallback(() => {
    if (timer.current) {
      disarm()
      action()
      return
    }
    setArmed(true)
    timer.current = setTimeout(disarm, DOUBLE_TAP_MS)
  }, [action, disarm])

  return { onClick, armed }
}
