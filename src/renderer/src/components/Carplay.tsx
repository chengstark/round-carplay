import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Typography } from '@mui/material'
import { useLocation, useNavigate } from 'react-router-dom'
import { CommandMapping } from '../../../main/carplay/messages/common'

import { ExtraConfig } from '../../../main/Globals'
import { useCarplayStore, useStatusStore } from '../store/store'
import { InitEvent, Renderer } from './worker/render/RenderEvents'
import { useCarplayTouch } from './useCarplayTouch'
import type { KeyCommand } from './worker/types'
import { BrowserVideoRenderer } from './BrowserVideoRenderer'

interface CarplayProps {
  receivingVideo: boolean
  setReceivingVideo: (v: boolean) => void
  settings: ExtraConfig
  command: KeyCommand
  commandCounter: number
}

const Carplay: React.FC<CarplayProps> = ({
  receivingVideo,
  setReceivingVideo,
  command,
  commandCounter
}) => {
  const navigate = useNavigate()
  const location = useLocation()
  const pathname = location.pathname

  // Zustand Store
  const isStreaming = useStatusStore((s) => s.isStreaming)
  const setStreaming = useStatusStore((s) => s.setStreaming)
  const setDongleConnected = useStatusStore((s) => s.setDongleConnected)
  const isDongleConnected = useStatusStore((s) => s.isDongleConnected)
  const resetInfo = useCarplayStore((s) => s.resetInfo)

  useEffect(() => {
    console.log('[UI] Dongle connected:', isDongleConnected)
  }, [isDongleConnected])

  // Refs
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const mainElem = useRef<HTMLDivElement>(null)
  const hasStartedRef = useRef(false)
  const [renderReady, setRenderReady] = useState(false)

  // RenderWorker + OffscreenCanvas per Ref
  const renderWorkerRef = useRef<Worker | null>(null)
  const offscreenCanvasRef = useRef<OffscreenCanvas | null>(null)
  const browserVideoRendererRef = useRef<BrowserVideoRenderer | null>(null)
  const isBrowserRuntime =
    window.location.protocol === 'http:' || window.location.protocol === 'https:'

  // Render settings
  const preferredRenderer = 'auto' //  'auto' | 'webgl2' | 'webgl' | 'webgpu'
  const reportFps = false
  const useHardware = true // true => prefere-hardware, false => no-preference hardware->software
  const useWebRTC = true

  // VIDEO CHANNEL
  const videoChannel = useMemo(() => new MessageChannel(), [])

  // Render Worker Setup
  useEffect(() => {
    if (canvasRef.current && !offscreenCanvasRef.current && !renderWorkerRef.current) {
      if (isBrowserRuntime) {
        browserVideoRendererRef.current = new BrowserVideoRenderer(canvasRef.current, () => {
          window.carplay.ipc.sendFrame().catch((error) => {
            console.warn('[CARPLAY] Browser decoder frame request failed', error)
          })
        })
        setRenderReady(true)
        return () => {
          browserVideoRendererRef.current?.close()
          browserVideoRendererRef.current = null
        }
      }

      offscreenCanvasRef.current = canvasRef.current.transferControlToOffscreen()
      const w = new Worker(new URL('./worker/render/Render.worker.ts', import.meta.url), {
        type: 'module'
      })
      renderWorkerRef.current = w
      w.postMessage(
        new InitEvent(
          offscreenCanvasRef.current,
          videoChannel.port2,
          preferredRenderer as Renderer,
          reportFps,
          useHardware,
          useWebRTC
        ),
        [offscreenCanvasRef.current, videoChannel.port2]
      )
    }
    // Cleanup when canvas is unmounted
    return () => {
      renderWorkerRef.current?.terminate()
      renderWorkerRef.current = null
      offscreenCanvasRef.current = null
    }
  }, [isBrowserRuntime, videoChannel])

  useEffect(() => {
    if (!renderWorkerRef.current) return
    const handler = (ev: MessageEvent<any>) => {
      if (ev.data?.type === 'render-ready') {
        console.log('[CARPLAY] Render worker ready message recived')
        setRenderReady(true)
      } else if (ev.data?.type === 'decoder-retry') {
        window.setTimeout(() => {
          window.carplay.ipc.sendFrame().catch((error) => {
            console.warn('[CARPLAY] Decoder retry frame request failed', error)
          })
        }, 100)
      }
    }
    renderWorkerRef.current.addEventListener('message', handler)
    return () => renderWorkerRef.current?.removeEventListener('message', handler)
  }, [])

  // Preload-Chunks fwd to Worker-Port
  useEffect(() => {
    // Keep the preload/browser adapter queue intact until the decoder worker is
    // ready. Registering a handler earlier drained and discarded the opening
    // SPS/keyframe, leaving the CarPlay surface black.
    if (!renderReady) return

    const handleVideo = (packet: any) => {
      if (browserVideoRendererRef.current) {
        browserVideoRendererRef.current.push(packet)
        return
      }

      const { chunk } = packet
      const transfer = chunk.buffer

      videoChannel.port1.postMessage(transfer, [transfer])
    }

    window.carplay.ipc.onVideoChunk(handleVideo)
    window.carplay.ipc.sendFrame().catch((error) => {
      console.warn('[CARPLAY] Initial frame request failed', error)
    })

    return () => {}
  }, [videoChannel, renderReady])

  // Start CarPlay-Service
  useEffect(() => {
    ;(async () => {
      try {
        await window.carplay.ipc.start()
      } catch (err) {
        console.error('CarPlay start failed:', err)
      }
    })()
  }, [])

  const sendTouchEvent = useCarplayTouch()

  // USB
  useEffect(() => {
    const onUsbConnect = async () => {
      if (!hasStartedRef.current) {
        resetInfo()
        setDongleConnected(true)
        hasStartedRef.current = true
        await window.carplay.ipc.start()
      }
    }
    const onUsbDisconnect = async () => {
      setReceivingVideo(false)
      setStreaming(false)
      setDongleConnected(false)
      hasStartedRef.current = false
      resetInfo()
      await window.carplay.ipc.stop()
      if (canvasRef.current) {
        canvasRef.current.style.width = '0'
        canvasRef.current.style.height = '0'
      }
    }
    const usbHandler = (_: any, data: { type: string }) => {
      if (data.type === 'plugged') onUsbConnect()
      else if (data.type === 'unplugged') onUsbDisconnect()
    }
    window.carplay.usb.listenForEvents(usbHandler)

    ;(async () => {
      const last = await window.carplay.usb.getLastEvent()
      if (last) usbHandler(null, last)
    })()

    return () => {
      window.electron?.ipcRenderer.removeListener('usb-event', usbHandler)
    }
  }, [setReceivingVideo, setDongleConnected, setStreaming, resetInfo])

  // Settings-Events
  useEffect(() => {
    const handler = (_: any, data: any) => {
      switch (data.type) {
        case 'resolution':
          useCarplayStore.setState({
            negotiatedWidth: data.payload.width,
            negotiatedHeight: data.payload.height
          })
          useStatusStore.setState({ isStreaming: true })
          setReceivingVideo(true)
          break
        case 'plugged':
          useStatusStore.setState({ isDongleConnected: true })
          break
        case 'unplugged':
          useStatusStore.setState({
            isDongleConnected: false,
            isStreaming: false
          })
          useCarplayStore.getState().resetInfo()
          break
        case 'command':
          if (data.message?.value === CommandMapping.requestHostUI) navigate('/settings')
          break
      }
    }
    window.carplay.ipc.onEvent(handler)
    return () => {
      window.electron?.ipcRenderer.removeListener('carplay-event', handler)
    }
  }, [navigate])

  // Resize Observer
  useEffect(() => {
    if (!mainElem.current) return
    const obs = new ResizeObserver(() => {
      window.carplay.ipc.sendFrame().catch((error) => {
        console.warn('[CARPLAY] Resize frame request failed', error)
      })
    })
    obs.observe(mainElem.current)
    return () => obs.disconnect()
  }, [])

  // KeyCommand
  useEffect(() => {
    if (commandCounter) {
      window.carplay.ipc.sendKeyCommand(command)
    }
  }, [command, commandCounter])

  // Cleanup
  useEffect(() => {
    return () => {
      renderWorkerRef.current?.terminate()
      renderWorkerRef.current = null
      browserVideoRendererRef.current?.close()
      browserVideoRendererRef.current = null
      offscreenCanvasRef.current = null
    }
  }, [])

  const isLoading = !isStreaming

  return (
    <div
      id="main"
      ref={mainElem}
      className="App"
      style={
        pathname === '/'
          ? { height: '100%', width: '100%', touchAction: 'none' }
          : { display: 'none' }
      }
    >
      {(!isDongleConnected || isLoading) && pathname === '/' && (
        <div
          style={{
            position: 'absolute',
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center'
          }}
        >
          <Typography>
            {!isDongleConnected ? 'Searching For Dongle' : 'Searching For Phone'}
          </Typography>
        </div>
      )}
      <div
        id="videoContainer"
        onPointerDown={sendTouchEvent}
        onPointerMove={sendTouchEvent}
        onPointerUp={sendTouchEvent}
        onPointerCancel={sendTouchEvent}
        onPointerOut={sendTouchEvent}
        style={{
          height: '100%',
          width: '100%',
          padding: 0,
          margin: 0,
          display: 'flex',
          visibility: receivingVideo ? 'visible' : 'hidden',
          zIndex: receivingVideo ? 1 : -1
        }}
      >
        <canvas
          ref={canvasRef}
          id="video"
          style={{
            width: receivingVideo ? '100%' : '0',
            height: receivingVideo ? '100%' : '0'
          }}
        />
      </div>
    </div>
  )
}

export default React.memo(Carplay)
