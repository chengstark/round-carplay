import { io, type Socket } from 'socket.io-client'
import type { RuntimeKind } from '../../../main/runtime/RuntimeSwitchService'
import type { CarplayApi } from '../../../shared/carplayApiTypes'

type RpcReply = { ok: true; value: unknown } | { ok: false; error: string }
type Listener = (...args: any[]) => void

if (!window.carplay) installBrowserApi()

function installBrowserApi(): void {
  const socket = io(window.location.origin, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3_000
  })

  const usbHandlers = new Set<Listener>()
  const usbQueue: unknown[] = []
  let videoHandler: Listener | null = null
  let audioHandler: Listener | null = null
  const videoQueue: unknown[] = []
  const audioQueue: unknown[] = []
  const assembleVideo = createChunkAssembler(20 * 1024 * 1024)
  const assembleAudio = createChunkAssembler(2 * 1024 * 1024)

  socket.on('usb-event', (payload) => {
    if (usbHandlers.size) usbHandlers.forEach((handler) => handler(undefined, payload))
    else pushBounded(usbQueue, payload, 32)
  })
  socket.on('carplay-video-chunk', (payload) => {
    const normalized = assembleVideo(payload)
    if (!normalized) return
    if (videoHandler) videoHandler(normalized)
    else pushBounded(videoQueue, normalized, 64)
  })
  socket.on('carplay-audio-chunk', (payload) => {
    const normalized = assembleAudio(payload)
    if (!normalized) return
    if (audioHandler) audioHandler(normalized)
    else pushBounded(audioQueue, normalized, 128)
  })

  const api: CarplayApi = {
    quit: () => rpc(socket, 'quit'),
    onUSBResetStatus: (callback) => {
      socket.on('usb-reset-start', (value) => callback(undefined, value))
      socket.on('usb-reset-done', (value) => callback(undefined, value))
    },
    usb: {
      forceReset: () => rpc(socket, 'usb.forceReset'),
      detectDongle: () => rpc(socket, 'usb.detectDongle'),
      getDeviceInfo: () => rpc(socket, 'usb.getDeviceInfo'),
      getLastEvent: () => rpc(socket, 'usb.getLastEvent'),
      getSysdefaultPrettyName: () => rpc(socket, 'usb.getSysdefaultPrettyName'),
      listenForEvents: (callback) => {
        usbHandlers.add(callback)
        usbQueue.splice(0).forEach((payload) => callback(undefined, payload))
      },
      unlistenForEvents: (callback) => usbHandlers.delete(callback)
    },
    settings: {
      get: () => rpc(socket, 'settings.get'),
      save: (settings) => rpc(socket, 'settings.save', settings),
      onUpdate: (callback) =>
        addListener(socket, 'settings', (settings) => callback(undefined, settings))
    },
    wifiCamera: {
      start: (options) => rpc(socket, 'wifiCamera.start', options),
      configure: (options) => rpc(socket, 'wifiCamera.configure', options),
      stop: () => rpc(socket, 'wifiCamera.stop'),
      acknowledgeFrame: () => void rpc(socket, 'wifiCamera.acknowledgeFrame'),
      onFrame: (callback) =>
        addListener(socket, 'wifi-camera-frame', (frame) => callback(toUint8Array(frame))),
      onStatus: (callback) => addListener(socket, 'wifi-camera-status', callback),
      onDiagnostics: (callback) => addListener(socket, 'wifi-camera-diagnostics', callback)
    },
    gps: {
      getState: () => rpc(socket, 'gps.getState'),
      onState: (callback) => addListener(socket, 'gps-state', callback)
    },
    network: {
      scanWifi: () => rpc(socket, 'network.scanWifi'),
      connectWifi: (ssid, password) =>
        rpcWithTimeout(socket, 45_000, 'network.connectWifi', ssid, password),
      getIpAddresses: () => rpc(socket, 'network.getIpAddresses')
    },
    update: {
      getStatus: () => rpc(socket, 'update.getStatus'),
      start: () => rpcWithTimeout(socket, 15 * 60_000, 'update.start'),
      reboot: () => rpc(socket, 'update.reboot'),
      powerOff: () => rpc(socket, 'update.powerOff'),
      onStatus: (callback) => addListener(socket, 'system-update-status', callback)
    },
    runtime: {
      getStatus: () => rpc(socket, 'runtime.getStatus'),
      switchTo: (target: RuntimeKind) => rpc(socket, 'runtime.switchTo', target)
    },
    ipc: {
      start: () => rpc(socket, 'carplay.start'),
      stop: () => rpc(socket, 'carplay.stop'),
      sendFrame: () => rpc(socket, 'carplay.sendFrame'),
      sendTouch: (x, y, action) => void rpc(socket, 'carplay.sendTouch', x, y, action),
      sendKeyCommand: (key) => void rpc(socket, 'carplay.sendKeyCommand', key),
      onEvent: (callback) =>
        addListener(socket, 'carplay-event', (payload) => callback(undefined, payload)),
      onVideoChunk: (handler) => {
        videoHandler = handler
        videoQueue.splice(0).forEach(handler)
      },
      onAudioChunk: (handler) => {
        audioHandler = handler
        audioQueue.splice(0).forEach(handler)
      }
    }
  }

  window.carplay = api
}

function rpc<T>(socket: Socket, method: string, ...args: unknown[]): Promise<T> {
  return rpcWithTimeout(socket, 30_000, method, ...args)
}

function rpcWithTimeout<T>(
  socket: Socket,
  timeout: number,
  method: string,
  ...args: unknown[]
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${method} timed out`)), timeout)
    socket.emit('rpc', { method, args }, (reply: RpcReply) => {
      window.clearTimeout(timer)
      if (reply?.ok) resolve(reply.value as T)
      else reject(new Error(reply?.error || `${method} failed`))
    })
  })
}

function addListener(socket: Socket, event: string, listener: Listener): () => void {
  socket.on(event, listener)
  return () => socket.off(event, listener)
}

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (value && typeof value === 'object' && 'data' in value && Array.isArray((value as any).data)) {
    return Uint8Array.from((value as any).data)
  }
  return new Uint8Array()
}

function createChunkAssembler(maximumBytes: number): (payload: any) => any | null {
  type Assembly = { buffer: Uint8Array; received: number; total: number }
  const pending = new Map<string, Assembly>()

  return (payload: any): any | null => {
    if (!payload || payload.chunk == null) return payload

    const chunk = toUint8Array(payload.chunk)
    const id = typeof payload.id === 'string' ? payload.id : ''
    const offset = Number(payload.offset)
    const total = Number(payload.total)

    if (
      !id ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(total) ||
      offset < 0 ||
      total <= 0 ||
      total > maximumBytes ||
      offset + chunk.byteLength > total
    ) {
      return { ...payload, chunk: new Uint8Array(chunk) }
    }

    if (offset === 0 && chunk.byteLength === total) {
      return { ...payload, chunk: new Uint8Array(chunk) }
    }

    let assembly = pending.get(id)
    if (offset === 0) {
      assembly = { buffer: new Uint8Array(total), received: 0, total }
      pending.set(id, assembly)
      while (pending.size > 4) pending.delete(pending.keys().next().value as string)
    }

    // WebSocket delivery is ordered. A missing volatile chunk makes the frame
    // unusable, so discard it rather than sending corrupt H.264/PCM downstream.
    if (!assembly || assembly.total !== total || offset !== assembly.received) {
      pending.delete(id)
      return null
    }

    assembly.buffer.set(chunk, offset)
    assembly.received += chunk.byteLength
    if (assembly.received !== total) return null

    pending.delete(id)
    return {
      ...payload,
      offset: 0,
      isLast: true,
      chunk: assembly.buffer
    }
  }
}

function pushBounded(queue: unknown[], value: unknown, maximum: number): void {
  if (queue.length >= maximum) queue.splice(0, queue.length - maximum + 1)
  queue.push(value)
}
