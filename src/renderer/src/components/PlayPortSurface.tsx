import React, { useCallback, useEffect, useRef, useState } from 'react'
import { PlayPortAudio } from '../playport/audio'
import {
  parseWireMessage,
  type CarPlayApp,
  type ClientMessage,
  type NavigationViewState,
  type ServerMessage,
  type VehicleUiSnapshot
} from '../playport/protocol'
import { PlayPortVideo } from '../playport/video'
import NavigationTrip from './NavigationTrip'
import { SpeedReader } from '../playport/speedReader'
import { EMPTY_SPEED, type SpeedReading } from '../../../shared/speedOcr'
import './PlayPortSurface.css'

export type PlayPortView = 'map' | 'media' | 'phone'

type Props = {
  view: PlayPortView
  native?: boolean
  onSpeed?: (reading: SpeedReading) => void
}

const MAIN_SCREEN_STREAM = 110
const MAP_SCREEN_STREAM = 111
const APP_TRANSITION_MS = 900

function appForView(view: PlayPortView): CarPlayApp | null {
  return view === 'media' ? 'youtube-music' : view === 'phone' ? 'phone' : null
}

export default function PlayPortSurface({ view, native = false, onSpeed }: Props): React.JSX.Element {
  const mapCanvas = useRef<HTMLCanvasElement>(null)
  const mainCanvas = useRef<HTMLCanvasElement>(null)
  const socket = useRef<WebSocket | null>(null)
  const sessionActive = useRef(false)
  const currentView = useRef(view)
  currentView.current = view
  const activePointer = useRef<number | null>(null)
  const appLaunchTime = useRef<number | null>(null)
  const appLaunchTimer = useRef<number | null>(null)
  // Both apps share one native screen stream. Only its current app is ready
  // for immediate reveal; switching apps must request the new app first.
  const preparedApp = useRef<CarPlayApp | null>(null)
  const pendingApp = useRef<CarPlayApp | null>(null)
  const [readyApp, setReadyApp] = useState<CarPlayApp | null>(null)
  const reconnectTimer = useRef<number | null>(null)
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'live' | 'offline'>('connecting')
  const [error, setError] = useState('')
  const [vehicle, setVehicle] = useState<VehicleUiSnapshot | null>(null)
  const navigation = useRef<NavigationViewState | undefined>(undefined)
  const [speed, setSpeed] = useState<SpeedReading>({ ...EMPTY_SPEED })
  const speedOutput = useRef(onSpeed)
  speedOutput.current = onSpeed

  const resetApp = useCallback(() => {
    if (appLaunchTimer.current !== null) window.clearTimeout(appLaunchTimer.current)
    appLaunchTimer.current = null
    appLaunchTime.current = null
    preparedApp.current = null
    pendingApp.current = null
    setReadyApp(null)
  }, [])

  const launchApp = useCallback((app: CarPlayApp) => {
    const connection = socket.current
    // The main stream keeps decoding behind the map. A prepared panel can
    // simply be revealed; do not relaunch the app or repeat its transition.
    if (!sessionActive.current || connection?.readyState !== WebSocket.OPEN ||
        preparedApp.current === app || pendingApp.current === app) return
    preparedApp.current = null
    pendingApp.current = app
    setReadyApp(null)
    appLaunchTime.current = performance.now()
    connection.send(JSON.stringify({ type: 'launchApp', app } satisfies ClientMessage))
    if (appLaunchTimer.current !== null) window.clearTimeout(appLaunchTimer.current)
    // Keep the map on screen during the iPhone's app-switch animation. Ask for
    // a fresh frame afterwards rather than exposing the cached launcher frame.
    appLaunchTimer.current = window.setTimeout(() => {
      appLaunchTimer.current = null
      if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: 'keyframe' }))
    }, APP_TRANSITION_MS)
  }, [])

  useEffect(() => {
    if (!mapCanvas.current || !mainCanvas.current) return

    let stopped = false
    let retryDelay = 500
    const send = (message: ClientMessage) => {
      if (socket.current?.readyState === WebSocket.OPEN) {
        socket.current.send(JSON.stringify(message))
      }
    }
    const requestKeyframe = () => send({ type: 'keyframe' })
    const speedReader = new SpeedReader(() => !native && sessionActive.current && currentView.current === 'map' &&
      navigation.current?.active === true && /google.*maps/i.test(navigation.current.sourceName || ''), reading => {
        setSpeed(reading)
        speedOutput.current?.(reading)
      })
    const mapVideo = new PlayPortVideo(
      mapCanvas.current,
      () => setConnection('live'),
      setError,
      requestKeyframe
    )
    const mainVideo = new PlayPortVideo(
      mainCanvas.current,
      () => {
        if (native) setConnection('live')
        if (pendingApp.current !== null && appLaunchTime.current !== null &&
            performance.now() - appLaunchTime.current >= APP_TRANSITION_MS) {
          preparedApp.current = pendingApp.current
          pendingApp.current = null
          appLaunchTime.current = null
          setReadyApp(preparedApp.current)
        }
      },
      setError,
      requestKeyframe,
      frame => speedReader.frame(frame)
    )
    const audio = new PlayPortAudio(setError)

    const open = () => {
      if (stopped) return
      setConnection('connecting')
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
      const next = new WebSocket(`${scheme}://${location.host}/playport`)
      next.binaryType = 'arraybuffer'
      socket.current = next

      next.addEventListener('open', () => {
        retryDelay = 500
        setConnection('connected')
        requestKeyframe()
      })
      next.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => {
        if (typeof event.data === 'string') {
          try {
            const message = JSON.parse(event.data) as ServerMessage
            if (message.vehicle) { navigation.current = message.vehicle.navigation; setVehicle(message.vehicle) }
            if (message.type === 'hello' || message.type === 'session') {
              sessionActive.current = message.sessionActive === true
              if (!sessionActive.current) { resetApp(); speedReader.reset() }
              else {
                const app = appForView(currentView.current)
                if (app) launchApp(app)
              }
            }
            if (message.type === 'session') {
              setConnection(message.sessionActive ? 'connected' : 'offline')
            }
            if (message.type === 'bridge' && message.sessionActive === false) {
              sessionActive.current = false
              speedReader.reset()
              resetApp()
              setError(message.message || 'PlayPort is unavailable')
            }
          } catch {}
          return
        }

        const message = parseWireMessage(event.data)
        if (!message) return
        switch (message.kind) {
          case 'video-config':
            if (message.streamType === MAP_SCREEN_STREAM) mapVideo.configure(message)
            else if (message.streamType === MAIN_SCREEN_STREAM) mainVideo.configure(message)
            break
          case 'video-frame':
            if (message.streamType === MAP_SCREEN_STREAM) mapVideo.push(message)
            else if (message.streamType === MAIN_SCREEN_STREAM) mainVideo.push(message)
            break
          case 'audio-config':
            if (!native) audio.configure(message)
            break
          case 'audio-packet':
            if (!native) audio.push(message)
            break
          case 'audio-stopped':
            audio.stop(message.streamType)
            break
          default:
            break
        }
      })
      next.addEventListener('close', () => {
        if (socket.current === next) socket.current = null
        if (stopped) return
        sessionActive.current = false
        speedReader.reset()
        resetApp()
        setConnection('offline')
        reconnectTimer.current = window.setTimeout(open, retryDelay)
        retryDelay = Math.min(5_000, retryDelay * 2)
      })
      next.addEventListener('error', () => next.close())
    }

    const unlockAudio = () => void audio.unlock().catch(() => undefined)
    if (!native) window.addEventListener('pointerdown', unlockAudio, { once: true })
    open()

    return () => {
      stopped = true
      window.removeEventListener('pointerdown', unlockAudio)
      if (reconnectTimer.current !== null) window.clearTimeout(reconnectTimer.current)
      if (appLaunchTimer.current !== null) window.clearTimeout(appLaunchTimer.current)
      socket.current?.close()
      socket.current = null
      mapVideo.close()
      mainVideo.close()
      speedReader.close()
      audio.close()
    }
  }, [launchApp, resetApp, native])

  const send = (message: ClientMessage) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message))
  }

  const nativeKey = (key: 'home' | 'back') => {
    const knob = { select: false, home: false, back: false, x: 0, y: 0, wheel: 0 }
    send({ type: 'knob', knob: { ...knob, [key]: true } })
    send({ type: 'knob', knob })
  }

  useEffect(() => {
    const app = appForView(view)
    if (app) launchApp(app)
    return () => {
      // Keep the decoded panel and any first-launch work alive while hidden.
      if (activePointer.current !== null && socket.current?.readyState === WebSocket.OPEN) {
        socket.current.send(JSON.stringify({ type: 'touch', contacts: [] } satisfies ClientMessage))
      }
      activePointer.current = null
    }
  }, [view, launchApp])

  const sendTouch = (event: React.PointerEvent<HTMLCanvasElement>, down: boolean) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return
    send({ type: 'touch', contacts: [{
      id: 0,
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
      down
    }] })
  }

  const releaseTouch = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointer.current !== event.pointerId) return
    event.preventDefault()
    sendTouch(event, false)
    activePointer.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <main className="playport-surface" data-view={view}
      data-native={native} data-app-ready={readyApp !== null && readyApp === appForView(view)} aria-label={native ? 'Full native CarPlay' : 'CarPlay'}>
      <canvas ref={mapCanvas} className="playport-map" width={1024} height={1024} />
      <canvas ref={mainCanvas} className="playport-main" width={1024} height={1024}
        aria-label={native ? 'Interactive native CarPlay screen' : view === 'phone' ? 'Phone CarPlay browsing screen' : 'YouTube Music CarPlay browsing screen'}
        onPointerDown={event => {
          if ((!native && (readyApp === null || readyApp !== appForView(view))) ||
              !sessionActive.current || event.button !== 0 || activePointer.current !== null) return
          event.preventDefault()
          activePointer.current = event.pointerId
          event.currentTarget.setPointerCapture(event.pointerId)
          sendTouch(event, true)
        }}
        onPointerMove={event => {
          if (activePointer.current !== event.pointerId) return
          event.preventDefault()
          sendTouch(event, true)
        }}
        onPointerUp={releaseTouch} onPointerCancel={releaseTouch} onLostPointerCapture={releaseTouch}
      />
      <div className="playport-vignette" />

      {native && <nav className="native-controls" aria-label="Native CarPlay controls">
        <button type="button" onClick={() => nativeKey('home')}>CarPlay Home</button>
        <button type="button" onClick={() => nativeKey('back')}>Back</button>
      </nav>}
      {!native && view === 'map' && <Guidance navigation={vehicle?.navigation} />}
      {!native && view === 'map' && connection === 'live' && <NavigationTrip navigation={vehicle?.navigation} />}
      {!native && view === 'map' && connection === 'live' && (
        <aside className="playport-speed-box" data-source="carplay-ocr"
          aria-label={`CarPlay OCR speed: limit ${speed.limit ?? 'unavailable'}, current ${speed.current ?? 'unavailable'} ${speed.unit || 'mph'}`}>
          <span className="playport-speed-limit"><small>LIMIT</small><strong>{speed.limit ?? '--'}</strong></span>
          <span className="playport-speed-current"><strong>{speed.current ?? '--'}</strong><small>{speed.unit || 'mph'}</small></span>
        </aside>
      )}
      {connection !== 'live' && (
        <div className="playport-connection" role="status">
          <strong>{connection === 'connecting' ? 'Connecting to CarPlay' : 'Waiting for iPhone'}</strong>
          {error && <span>{error}</span>}
        </div>
      )}
    </main>
  )
}

function Guidance({ navigation }: { navigation?: NavigationViewState }): React.JSX.Element | null {
  if (!navigation?.active) return null
  const instruction = navigation.maneuver?.description || navigation.maneuver?.roadName || navigation.currentRoad
  const distance = formatDistance(
    navigation.distanceToManeuverText,
    navigation.distanceToManeuverUnit,
    navigation.distanceToManeuverMeters
  )
  if (!instruction && !distance) return null
  return (
    <aside className="playport-guidance">
      <span className="playport-maneuver" aria-hidden="true">{maneuverGlyph(navigation.maneuver?.type)}</span>
      <span>
        <strong>{distance}</strong>
        <span>{instruction}</span>
      </span>
    </aside>
  )
}

function formatDistance(textValue?: string, unit?: number, meters?: number): string {
  const text = textValue?.trim()
  if (text) {
    if (/[a-z]/i.test(text)) return text
    const suffix = ['km', 'mi', 'm', 'yd', 'ft'][unit ?? -1]
    return suffix ? `${text} ${suffix}` : text
  }
  if (meters == null) return ''
  return meters < 1_000 ? `${Math.round(meters)} m` : `${(meters / 1_000).toFixed(1)} km`
}

function maneuverGlyph(type?: number): string {
  if ([1, 13, 20, 22, 47, 49, 52].includes(type ?? -1)) return '↰'
  if ([2, 14, 21, 23, 48, 50, 53].includes(type ?? -1)) return '↱'
  if ([4, 18, 26].includes(type ?? -1)) return '↶'
  if ([6, 7, 19].includes(type ?? -1) || (type != null && type >= 28 && type <= 46)) return '⟳'
  return '↑'
}
