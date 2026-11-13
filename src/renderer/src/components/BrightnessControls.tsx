import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrightnessDirection, BrightnessStatus } from '../../../main/brightness/BrightnessService'

const initial: BrightnessStatus = {
  ok: false, configured: false, active: null, message: 'Checking brightness controller…'
}

export default function BrightnessControls(): React.JSX.Element {
  const [status, setStatus] = useState(initial)
  const holding = useRef(false)
  const releasing = useRef(false)
  const [isReleasing, setIsReleasing] = useState(false)
  const mounted = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const api = window.carplay.brightness
  const reportError = useCallback((error: unknown) => {
    if (mounted.current) setStatus(previous => ({
      ...previous, ok: false, active: null,
      message: error instanceof Error ? error.message : 'Brightness controller unavailable'
    }))
  }, [])
  const refresh = useCallback(() => {
    if (!api || holding.current || releasing.current) return
    void api.getStatus().then(value => {
      if (mounted.current && !holding.current && !releasing.current) setStatus(value)
    }).catch(reportError)
  }, [api, reportError])
  const stop = useCallback((immediate = false) => {
    if (!holding.current && (!releasing.current || !immediate)) return
    holding.current = false
    releasing.current = true
    if (mounted.current) setIsReleasing(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    if (mounted.current) setStatus(previous => ({ ...previous, message: 'Finishing adjustment…' }))
    void api?.stop(immediate).then(value => {
      if (mounted.current) setStatus(value)
    }).catch(reportError).finally(() => {
      releasing.current = false
      if (mounted.current) setIsReleasing(false)
    })
  }, [api, reportError])

  useEffect(() => {
    mounted.current = true
    if (!api) setStatus({ ...initial, message: 'Brightness unavailable in this runtime' })
    refresh()
    const poll = window.setInterval(refresh, 10_000)
    const cancel = () => stop(true)
    const hide = () => { if (document.hidden) cancel() }
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', hide)
    return () => {
      mounted.current = false
      window.clearInterval(poll)
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', hide)
      cancel()
    }
  }, [api, refresh, stop])

  const start = (direction: BrightnessDirection) => {
    if (!api || holding.current || releasing.current || !status.ok) return
    holding.current = true
    setStatus(previous => ({ ...previous, active: direction, message: direction === 'increase' ? 'Brightening…' : 'Dimming…' }))
    timer.current = setTimeout(() => stop(true), 11_000)
    void api.start(direction).then(value => {
      if (mounted.current && holding.current) setStatus(value)
      if (!value.ok) stop(true)
    }).catch(error => { stop(true); reportError(error) })
  }

  return (
    <section className="settings-brightness" aria-label="Screen brightness">
      <div className="brightness-heading">
        <h2>Brightness</h2>
        <span className="brightness-status" data-ready={status.ok} role="status" title={status.message}>
          {status.ok ? (status.active ? 'Adjusting' : 'Connected') : status.configured ? 'Offline' : 'Connecting'}
        </span>
      </div>
      <div className="brightness-buttons">
        {([
          { direction: 'decrease', label: 'Dim' },
          { direction: 'increase', label: 'Brighten' }
        ] as const).map(({ direction, label }) => (
          <button type="button" key={direction} disabled={!status.ok || isReleasing}
            className="settings-action settings-secondary"
            data-active={status.active === direction}
            aria-label={label + ' screen'}
            onPointerDown={event => {
              if (event.button !== 0 || holding.current) return
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              start(direction)
            }}
            onPointerUp={() => stop()} onPointerCancel={() => stop(true)}
            onLostPointerCapture={() => { if (holding.current) stop(true) }}
            onKeyDown={event => {
              if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
                event.preventDefault(); start(direction)
              }
            }}
            onKeyUp={event => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); stop() }
            }}
            onBlur={() => { if (holding.current) stop(true) }} onContextMenu={event => event.preventDefault()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {direction === 'decrease'
                ? <path d="M20 15.5A9 9 0 0 1 8.5 4 9 9 0 1 0 20 15.5Z" />
                : <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>}
            </svg>
            {label}
          </button>
        ))}
      </div>
      <p className="brightness-hint">Tap for a larger step · hold to adjust</p>
      {!status.ok && status.message !== initial.message && <>
        <p className="brightness-error">{status.message}</p>
        <button type="button" className="settings-action settings-secondary" onClick={refresh}>Retry connection</button>
      </>}
    </section>
  )
}
